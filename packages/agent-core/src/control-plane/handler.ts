import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
	type BuildControlPlaneSnapshotOptions,
	buildControlPlaneSnapshot,
} from "./snapshot.js";

export interface ControlPlaneHandlerOptions
	extends BuildControlPlaneSnapshotOptions {}

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
		pathname === "/control-plane/snapshot"
	);
}

export function createControlPlaneHandler(
	options: ControlPlaneHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		void (async () => {
			if (request.method !== "GET" && request.method !== "HEAD") {
				sendJson(response, 405, { error: "method_not_allowed" });
				return;
			}

			const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
				message: "Control plane snapshot failed to read data",
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
