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

import {
	createObservabilityDashboardHandler,
	type DashboardDataProviders,
	type ObservabilityDashboardOptions,
} from "../observability/dashboard.js";
import { renderControlPlaneDashboardHtml } from "../observability/dashboard-page.js";
import {
	type BuildControlPlaneSnapshotOptions,
	buildControlPlaneSnapshot,
} from "./snapshot.js";
import { handleV2 } from "./v2/router.js";
import type { SseHandleOptions } from "./v2/routes/events-sse.js";
import type { V2Runtime } from "./v2/runtime.js";

export interface ControlPlaneHandlerOptions
	extends BuildControlPlaneSnapshotOptions {
	readonly onChat?: (message: string) => Promise<string>;
	readonly dataProviders?: DashboardDataProviders;
	readonly observability?: Omit<ObservabilityDashboardOptions, "dataProviders">;
	/**
	 * Phase 1 v2 control-plane API runtime adapter. When provided, requests
	 * under `/api/v2/*` are delegated to the typed v2 router; when absent,
	 * those requests return 503 so the legacy dashboard surface keeps
	 * working unchanged.
	 *
	 * Phase 1 v2 控制面 API 运行时适配器：提供则把 /api/v2/* 委派给 v2
	 * 路由；未提供则该路径返回 503，旧 dashboard 表面继续保持原行为。
	 */
	readonly v2Runtime?: V2Runtime;
	readonly v2SseOptions?: SseHandleOptions;
}

const OBSERVABILITY_PATH_PREFIXES = [
	"/ui",
	"/api/dashboard/",
	"/traces",
	"/metrics",
] as const;

function isObservabilityRoute(pathname: string): boolean {
	if (pathname === "/metrics" || pathname === "/traces") {
		return true;
	}
	if (pathname === "/ui" || pathname === "/ui/") {
		return true;
	}
	for (const prefix of OBSERVABILITY_PATH_PREFIXES) {
		if (prefix.endsWith("/") && pathname.startsWith(prefix)) {
			return true;
		}
		if (!prefix.endsWith("/") && pathname.startsWith(`${prefix}/`)) {
			return true;
		}
	}
	return false;
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

async function pipeFetchResponseToNode(
	fetchResponse: Response,
	nodeResponse: ServerResponse,
	bodyless: boolean,
): Promise<void> {
	const headers: Record<string, string> = {};
	fetchResponse.headers.forEach((value, key) => {
		headers[key] = value;
	});
	nodeResponse.writeHead(fetchResponse.status, headers);
	if (bodyless) {
		nodeResponse.end();
		return;
	}

	const body = fetchResponse.body;
	if (body == null) {
		nodeResponse.end();
		return;
	}

	const reader = body.getReader();
	const onClose = () => {
		void reader.cancel().catch(() => undefined);
	};
	nodeResponse.on("close", onClose);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value != null && value.byteLength > 0) {
				const ok = nodeResponse.write(Buffer.from(value));
				if (!ok) {
					await new Promise<void>((resolve) =>
						nodeResponse.once("drain", () => resolve()),
					);
				}
			}
		}
	} finally {
		nodeResponse.off("close", onClose);
		nodeResponse.end();
	}
}

function toFetchRequest(
	request: IncomingMessage,
	url: URL,
	bodyText: string | null,
): { readonly request: Request; readonly abort: () => void } {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (value == null) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}
	const controller = new AbortController();
	const method = request.method ?? "GET";
	const init: RequestInit = {
		method,
		headers,
		signal: controller.signal,
	};
	if (bodyText != null && method !== "GET" && method !== "HEAD") {
		(init as RequestInit & { body: string }).body = bodyText;
	}
	const fetchRequest = new Request(url.toString(), init);
	const abort = () => controller.abort();
	// Abort the fetch-style signal when the underlying Node IncomingMessage
	// closes, regardless of whether all body bytes were received — this
	// matches the SSE handler's expectation that `request.signal` fires on
	// any client disconnect.
	request.on("close", abort);
	return { request: fetchRequest, abort };
}

export function createControlPlaneHandler(
	options: ControlPlaneHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
	const observabilityHandler = createObservabilityDashboardHandler({
		...(options.observability ?? {}),
		...(options.dataProviders == null
			? {}
			: { dataProviders: options.dataProviders }),
	});

	return (request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");

			// Delegate /api/v2/* to the typed v2 router (QUI-154 Phase 1).
			// We intentionally check this BEFORE the observability route check
			// so the v2 surface stays isolated from the legacy /api/dashboard
			// path. Callers omitting `v2Runtime` get a 503 so the rest of the
			// server keeps serving unchanged.
			if (url.pathname === "/api/v2" || url.pathname.startsWith("/api/v2/")) {
				if (options.v2Runtime == null) {
					sendJson(response, 503, {
						ok: false,
						error: {
							code: "v2_runtime_not_configured",
							message:
								"v2 API runtime adapter is not wired (pass `v2Runtime` to createControlPlaneHandler)",
						},
					});
					return;
				}
				const bodyText =
					request.method === "GET" || request.method === "HEAD"
						? null
						: await readRequestBody(request);
				const { request: fetchRequest } = toFetchRequest(
					request,
					url,
					bodyText,
				);
				const v2Response = await handleV2(fetchRequest, {
					runtime: options.v2Runtime,
					...(options.v2SseOptions == null
						? {}
						: { sseOptions: options.v2SseOptions }),
				});
				if (v2Response == null) {
					sendJson(response, 404, {
						ok: false,
						error: { code: "not_found", message: "v2 route not found" },
					});
					return;
				}
				await pipeFetchResponseToNode(
					v2Response,
					response,
					request.method === "HEAD",
				);
				return;
			}

			// Delegate observability dashboard / API / static asset routes to the
			// observability handler so /ui/, /api/dashboard/*, /metrics, /traces
			// share the same port as the control plane.
			if (isObservabilityRoute(url.pathname)) {
				observabilityHandler(request, response);
				return;
			}

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
