import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		request.on("error", reject);
	});
}
import { renderControlPlaneDashboardHtml } from "../observability/dashboard-page.js";
import {
	type BuildControlPlaneSnapshotOptions,
	buildControlPlaneSnapshot,
} from "./snapshot.js";

export interface ControlPlaneHandlerOptions
	extends BuildControlPlaneSnapshotOptions {
	readonly onChat?: (message: string) => Promise<string>;
}

export interface StartControlPlaneServerOptions
	extends ControlPlaneHandlerOptions {
	readonly host?: string;
	readonly port?: number;
}

class ControlPlaneBadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlPlaneBadRequestError";
	}
}

function send(
	response: ServerResponse,
	statusCode: number,
	contentType: string,
	body: string,
): void {
	response.writeHead(statusCode, {
		"content-type": contentType,
		"cache-control": "no-store",
	});
	response.end(body);
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	payload: Record<string, unknown>,
): void {
	send(
		response,
		statusCode,
		"application/json; charset=utf-8",
		`${JSON.stringify(payload)}\n`,
	);
}

function parseSessionLimit(value: string | null): number | undefined {
	if (value == null || value.length === 0) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new ControlPlaneBadRequestError(
			"session_limit must be a non-negative integer",
		);
	}
	return parsed;
}

function routeMatches(pathname: string): boolean {
	return (
		pathname === "/" ||
		pathname === "/control-plane" ||
		pathname === "/control-plane/snapshot" ||
			pathname === "/dashboard"
	);
}

export function createControlPlaneHandler(
	options: ControlPlaneHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");

			// POST /api/chat — simple one-shot chat
			if (request.method === "POST" && url.pathname === "/api/chat") {
				if (options.onChat == null) {
					sendJson(response, 501, { error: "chat not available" });
					return;
				}
				try {
					const body = await readRequestBody(request);
					const data = JSON.parse(body) as { message?: string };
					if (data.message == null || data.message.trim().length === 0) {
						sendJson(response, 400, { error: "message is required" });
						return;
					}
					const reply = await options.onChat(data.message);
					sendJson(response, 200, { reply });
				} catch (err) {
					sendJson(response, 500, {
						error: "chat_failed",
						message: String(err),
					});
				}
				return;
			}

			if (request.method !== "GET" && request.method !== "HEAD") {
				sendJson(response, 405, { error: "method_not_allowed" });
				return;
			}

			if (!routeMatches(url.pathname)) {
				sendJson(response, 404, { error: "not_found" });
				return;
			}

			const sessionLimit = parseSessionLimit(
				url.searchParams.get("session_limit"),
			);
			const snapshot = await buildControlPlaneSnapshot({
				...options,
				...(sessionLimit == null ? {} : { sessionLimit }),
			});
			if (url.pathname === "/dashboard") {
				send(
					response,
					200,
					"text/html; charset=utf-8",
					renderControlPlaneDashboardHtml(snapshot),
				);
				return;
			}

			const body = `${JSON.stringify(snapshot)}\n`;
			send(
				response,
				200,
				"application/json; charset=utf-8",
				request.method === "HEAD" ? "" : body,
			);
		})().catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : undefined);
				return;
			}

			if (error instanceof ControlPlaneBadRequestError) {
				sendJson(response, 400, {
					error: "bad_request",
					message: error.message,
				});
				return;
			}

			sendJson(response, 500, {
				error: "internal_error",
				message: "Control plane snapshot failed: " + String(error),
			});
		});
	};
}

export async function startControlPlaneServer(
	options: StartControlPlaneServerOptions = {},
): Promise<{
	readonly server: ReturnType<typeof createServer>;
	readonly url: string;
}> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const server = createServer(createControlPlaneHandler(options));

	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			server.off("error", onError);
			server.off("listening", onListening);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});

	const address = server.address() as AddressInfo;
	return {
		server,
		url: `http://${host}:${address.port}`,
	};
}
