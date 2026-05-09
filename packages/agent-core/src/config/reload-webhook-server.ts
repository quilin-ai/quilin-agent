// Reload webhook server (QUI-148).
//
// 提供 `POST /reload` HTTP 入口，用于触发 capabilities 热更新。强约束：
//   1. 必须绑定环回地址（127.0.0.1 / ::1 / localhost），公网 IP 启动即拒绝。
//   2. 必须设置 `QUILIN_RELOAD_WEBHOOK_SECRET` 环境变量；缺失时拒绝启动，
//      不提供任何不安全 fallback。
//   3. 请求必须携带 `X-Reload-Signature: <hex(hmac-sha256(secret, body))>`，
//      签名错误返回 401，缺失签名返回 401，非 POST 请求返回 405。
//   4. 默认关闭，opt-in via `runtime.hot_reload.webhook.enabled = true`。
//   5. 启动 info 级日志记录 host:port，但严禁记录 secret 内容。
//
// HTTP server exposing `POST /reload` to trigger capabilities hot reload.
// Hard constraints:
//   1. MUST bind a loopback address (127.0.0.1 / ::1 / localhost). Public
//      IPs are rejected at startup.
//   2. The `QUILIN_RELOAD_WEBHOOK_SECRET` env var MUST be set. Missing
//      secret => refuse to start. No insecure fallback path is provided.
//   3. Requests MUST carry `X-Reload-Signature: <hex(hmac-sha256(secret,
//      body))>`. Invalid signature => 401. Missing signature => 401.
//      Non-POST methods => 405.
//   4. Default disabled. Opt-in via `runtime.hot_reload.webhook.enabled = true`.
//   5. Startup logs the bound host:port at info level — NEVER the secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import type {
	CapabilitiesHotReloadController,
	CapabilitiesReloadResult,
} from "./hot-reload.js";

export const RELOAD_WEBHOOK_SECRET_ENV =
	"QUILIN_RELOAD_WEBHOOK_SECRET" as const;
export const RELOAD_WEBHOOK_SIGNATURE_HEADER = "x-reload-signature" as const;

/**
 * Hosts considered safe to bind. Anything else (in particular `0.0.0.0`,
 * `::`, public IPs) triggers a startup refusal.
 *
 * 允许绑定的环回 host。其余值（特别是 `0.0.0.0`、`::`、公网 IP）触发启动
 * 拒绝。
 */
const LOOPBACK_HOST_ALIASES: readonly string[] = [
	"127.0.0.1",
	"::1",
	"localhost",
];

export class ReloadWebhookConfigurationError extends Error {
	readonly code = "RELOAD_WEBHOOK_CONFIGURATION" as const;

	constructor(message: string) {
		super(message);
		this.name = "ReloadWebhookConfigurationError";
	}
}

export interface ReloadWebhookServerOptions {
	readonly controller: CapabilitiesHotReloadController;
	readonly host?: string;
	readonly port?: number;
	/**
	 * Override the env lookup. Tests may pass a frozen env to avoid
	 * mutating `process.env`.
	 *
	 * 测试可注入冻结 env，避免污染 `process.env`。
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Optional info-level logger. Receives the bound `host:port`. The
	 * secret is intentionally never passed.
	 *
	 * 可选 info 级日志器，回调 host:port；secret 故意不传。
	 */
	readonly onListen?: (info: {
		readonly host: string;
		readonly port: number;
	}) => void;
	/**
	 * Optional error logger for handler failures.
	 *
	 * 处理器失败时的错误日志器（可选）。
	 */
	readonly onError?: (error: unknown, context: string) => void;
}

export interface ReloadWebhookServerHandle {
	readonly host: string;
	readonly port: number;
	close(): Promise<void>;
}

/**
 * Validates that `host` is a loopback address. Refuses `0.0.0.0`, `::`,
 * and any non-loopback IP. `localhost` is accepted because Node resolves
 * it to a loopback interface.
 *
 * 校验 host 是环回地址。拒绝 `0.0.0.0`、`::` 以及一切非环回 IP。
 * `localhost` 被 Node 解析为环回接口，故予以放行。
 */
export function assertLoopbackHost(host: string): void {
	const normalized = host.trim().toLowerCase();
	if (normalized.length === 0) {
		throw new ReloadWebhookConfigurationError(
			"reload webhook host must be a non-empty loopback address",
		);
	}
	if (LOOPBACK_HOST_ALIASES.includes(normalized)) {
		return;
	}
	if (isIPv4(normalized)) {
		// IPv4 loopback range is 127.0.0.0/8.
		if (normalized.startsWith("127.")) {
			return;
		}
		throw new ReloadWebhookConfigurationError(
			`reload webhook refuses to bind public IPv4 ${host}; only 127.0.0.0/8 is allowed`,
		);
	}
	if (isIPv6(normalized)) {
		if (normalized === "::1") {
			return;
		}
		throw new ReloadWebhookConfigurationError(
			`reload webhook refuses to bind public IPv6 ${host}; only ::1 is allowed`,
		);
	}
	throw new ReloadWebhookConfigurationError(
		`reload webhook host ${host} is not a recognised loopback address`,
	);
}

/**
 * Reads and validates the HMAC secret from the env. Throws an actionable
 * error when missing — the webhook MUST NOT fall back to an insecure
 * default.
 *
 * 从 env 读取并校验 HMAC secret。缺失时抛出可执行错误；webhook 不允许任何
 * 不安全的回退路径。
 */
export function loadReloadWebhookSecret(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const secret = env[RELOAD_WEBHOOK_SECRET_ENV];
	if (secret == null || secret.length === 0) {
		throw new ReloadWebhookConfigurationError(
			`${RELOAD_WEBHOOK_SECRET_ENV} env var must be set to enable the reload webhook`,
		);
	}
	return secret;
}

/**
 * Computes the canonical hex HMAC-SHA256 signature used by the webhook.
 *
 * 计算 webhook 使用的 hex HMAC-SHA256 签名。
 */
export function computeReloadWebhookSignature(
	secret: string,
	body: string | Buffer,
): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

function timingSafeEqualHex(expected: string, actual: string): boolean {
	if (expected.length !== actual.length) {
		return false;
	}
	try {
		const expectedBuf = Buffer.from(expected, "hex");
		const actualBuf = Buffer.from(actual, "hex");
		if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) {
			return false;
		}
		return timingSafeEqual(expectedBuf, actualBuf);
	} catch {
		return false;
	}
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks));
		});
		req.on("error", (err) => {
			reject(err);
		});
	});
}

function writeJson(
	res: ServerResponse,
	statusCode: number,
	body: Record<string, unknown>,
): void {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload).toString(10),
	});
	res.end(payload);
}

function reloadResultToJson(
	result: CapabilitiesReloadResult,
): Record<string, unknown> {
	if (result.status === "success") {
		return {
			status: "success",
			generation: result.snapshot.generation,
			operation: result.snapshot.operation,
			trigger: result.snapshot.trigger,
			completedAtEpochMs: result.snapshot.completedAtEpochMs,
			configPath: result.snapshot.configPath,
			change: result.snapshot.change,
		};
	}
	return {
		status: "failure",
		generation: result.snapshot.generation,
		trigger: result.snapshot.trigger,
		completedAtEpochMs: result.snapshot.completedAtEpochMs,
		errorName: result.snapshot.errorName,
		errorMessage: result.snapshot.errorMessage,
	};
}

/**
 * Starts the reload webhook HTTP server. Returns a handle exposing the
 * actually-bound `host:port` and a `close()` method for graceful shutdown.
 *
 * 启动 reload webhook HTTP server。返回 handle 暴露真实绑定的 host:port
 * 与 graceful shutdown 的 `close()` 方法。
 */
export async function startReloadWebhookServer(
	options: ReloadWebhookServerOptions,
): Promise<ReloadWebhookServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const env = options.env ?? process.env;

	assertLoopbackHost(host);
	const secret = loadReloadWebhookSecret(env);

	const server = createServer((req, res) => {
		void handleRequest(req, res, {
			controller: options.controller,
			secret,
			onError: options.onError,
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onListening = () => {
			server.removeListener("error", onError);
			resolve();
		};
		const onError = (err: Error) => {
			server.removeListener("listening", onListening);
			reject(err);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		server.listen(port, host);
	});

	const address = server.address();
	const boundHost =
		typeof address === "object" && address != null ? address.address : host;
	const boundPort =
		typeof address === "object" && address != null ? address.port : port;

	options.onListen?.({ host: boundHost, port: boundPort });

	return {
		host: boundHost,
		port: boundPort,
		close: () => closeServer(server),
	};
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((err) => {
			if (err != null) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

interface HandleRequestContext {
	readonly controller: CapabilitiesHotReloadController;
	readonly secret: string;
	readonly onError?: (error: unknown, context: string) => void;
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	context: HandleRequestContext,
): Promise<void> {
	try {
		const url = req.url ?? "";
		const path = url.split("?", 1)[0];
		if (path !== "/reload") {
			writeJson(res, 404, {
				status: "error",
				error: "not_found",
				message: "Only POST /reload is supported.",
			});
			return;
		}
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			writeJson(res, 405, {
				status: "error",
				error: "method_not_allowed",
				message: "POST /reload only.",
			});
			return;
		}

		const signatureHeader = req.headers[RELOAD_WEBHOOK_SIGNATURE_HEADER];
		const signature = Array.isArray(signatureHeader)
			? signatureHeader[0]
			: signatureHeader;
		if (signature == null || signature.length === 0) {
			writeJson(res, 401, {
				status: "error",
				error: "missing_signature",
				message: `Missing ${RELOAD_WEBHOOK_SIGNATURE_HEADER} header.`,
			});
			return;
		}

		const body = await readRequestBody(req);
		const expected = computeReloadWebhookSignature(context.secret, body);
		if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
			writeJson(res, 401, {
				status: "error",
				error: "invalid_signature",
				message: "HMAC signature mismatch.",
			});
			return;
		}

		const result = await context.controller.reload("webhook");
		const statusCode = result.status === "success" ? 200 : 500;
		writeJson(res, statusCode, reloadResultToJson(result));
	} catch (error) {
		context.onError?.(error, "reload_webhook_handler");
		try {
			writeJson(res, 500, {
				status: "error",
				error: "internal_error",
				message:
					error instanceof Error ? error.message : "unknown webhook error",
			});
		} catch {
			// If even writing the error response fails the connection is
			// already gone — nothing more we can do.
		}
	}
}
