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
import { basename } from "node:path";
import type {
	CapabilitiesHotReloadController,
	CapabilitiesReloadResult,
} from "./hot-reload.js";

export const RELOAD_WEBHOOK_SECRET_ENV =
	"QUILIN_RELOAD_WEBHOOK_SECRET" as const;
export const RELOAD_WEBHOOK_SIGNATURE_HEADER = "x-reload-signature" as const;

/**
 * Maximum size of the request body the webhook is willing to buffer
 * before responding with 413. Reload payloads are tiny (callers
 * typically POST `{}` or a few hundred bytes of metadata), so 64 KiB
 * is generous while still preventing DoS via unbounded body buffering
 * (HMAC verification cannot start until the body is fully read, so
 * an attacker on loopback could otherwise OOM the process).
 *
 * webhook 在响应 413 之前愿意缓冲的请求体上限。reload payload 极小
 * （调用方一般 POST `{}` 或几百字节元数据），64 KiB 足够宽裕；同时
 * 防止通过无限缓冲请求体发起 DoS（HMAC 校验必须等 body 完整读完才
 * 能开始，环回攻击者否则可耗尽内存）。
 */
export const MAX_RELOAD_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Socket idle timeout for the webhook HTTP server. 5 seconds is far
 * more than enough for a loopback HMAC reload, while still ensuring a
 * slow-stream attacker cannot pin a socket open indefinitely.
 *
 * webhook HTTP server 的 socket 空闲超时。5 秒对于环回 HMAC reload
 * 远远足够，同时确保慢速流式攻击者无法长期占用连接。
 */
export const RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS = 5_000;

/**
 * Sentinel error class thrown by `readRequestBody` when the request
 * body exceeds `MAX_RELOAD_REQUEST_BODY_BYTES`. Used so the handler
 * can map to a 413 response.
 *
 * `readRequestBody` 在请求体超过 `MAX_RELOAD_REQUEST_BODY_BYTES` 时
 * 抛出的哨兵异常类，用于让 handler 映射为 413 响应。
 */
class RequestBodyTooLargeError extends Error {
	readonly code = "REQUEST_BODY_TOO_LARGE" as const;
	constructor(message: string) {
		super(message);
		this.name = "RequestBodyTooLargeError";
	}
}

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
		// `Buffer.from(str, "hex")` truncates at the first invalid nibble,
		// so a fully non-hex input decodes to an empty Buffer. The length
		// guard below catches both that case and any partial truncation
		// (decoded length < expected) before reaching `timingSafeEqual`,
		// which itself requires equal-length operands.
		// `Buffer.from(str, "hex")` 会在第一个非 hex nibble 处截断，
		// 因此完全非 hex 的输入会解出空 Buffer。下面的长度守卫同时拦
		// 截这种情况和任何部分截断（解出的字节数 < expected），保证
		// 进入 `timingSafeEqual` 的两个 buffer 长度一致。
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

/**
 * Parses an HTTP `Content-Length` header value defensively. Returns a
 * non-negative integer when the header is a clean integer string, or
 * `null` when the header is missing / malformed (including duplicates,
 * decimals, negatives, NaN). Does not trust `Number(...)` because it
 * silently coerces empty strings, hex prefixes, etc.
 *
 * 防御式解析 `Content-Length` 头。仅当头部是干净的整数字符串时返回
 * 非负整数；缺失或非法（重复、含小数、负数、NaN）时返回 `null`。
 * 不使用 `Number(...)`，避免空串、hex 前缀等场景被静默转换。
 */
function parseContentLengthHeader(
	headerValue: string | string[] | undefined,
): number | null {
	if (headerValue == null) {
		return null;
	}
	if (Array.isArray(headerValue)) {
		// Multiple Content-Length headers are a smuggling smell — refuse.
		// 多个 Content-Length 头是走私风险 — 拒绝。
		return null;
	}
	const trimmed = headerValue.trim();
	if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return null;
	}
	return parsed;
}

/**
 * Reads the full request body into a `Buffer`, enforcing
 * `MAX_RELOAD_REQUEST_BODY_BYTES` against both the declared
 * `Content-Length` header (pre-check) and the actually-streamed bytes
 * (mid-stream guard). On overflow rejects with `RequestBodyTooLargeError`
 * so the handler can respond with 413; the underlying socket is
 * destroyed by the caller to free the resource.
 *
 * 把请求体完整读入 `Buffer`，同时通过 `Content-Length` 头预检查与
 * 流式累积守卫两层防护强制 `MAX_RELOAD_REQUEST_BODY_BYTES` 上限。
 * 超限时以 `RequestBodyTooLargeError` 拒绝，由 handler 映射为 413；
 * caller 负责销毁底层 socket 释放资源。
 */
function readRequestBody(
	req: IncomingMessage,
	maxBytes: number = MAX_RELOAD_REQUEST_BODY_BYTES,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const declaredLength = parseContentLengthHeader(
			req.headers["content-length"],
		);
		if (declaredLength != null && declaredLength > maxBytes) {
			reject(
				new RequestBodyTooLargeError(
					`Content-Length ${declaredLength} exceeds cap ${maxBytes}`,
				),
			);
			return;
		}

		const chunks: Buffer[] = [];
		let received = 0;
		let aborted = false;

		const onData = (chunk: Buffer | string) => {
			if (aborted) {
				return;
			}
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			received += buf.length;
			if (received > maxBytes) {
				aborted = true;
				cleanup();
				reject(
					new RequestBodyTooLargeError(
						`Streamed body exceeded cap ${maxBytes} bytes`,
					),
				);
				return;
			}
			chunks.push(buf);
		};

		const onEnd = () => {
			if (aborted) {
				return;
			}
			cleanup();
			resolve(Buffer.concat(chunks));
		};

		const onError = (err: Error) => {
			if (aborted) {
				return;
			}
			aborted = true;
			cleanup();
			reject(err);
		};

		const cleanup = () => {
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
		};

		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
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
		// Redact the absolute path to its basename — exposing the full path
		// over a (loopback-only but locally multi-tenant) HTTP response is
		// unnecessary info-leak surface. Callers only need to know which
		// file was reloaded, not where on disk it lives.
		// 把绝对路径裁剪为 basename — 通过 HTTP 响应（仅环回但本地可能
		// 多用户）暴露完整路径是不必要的信息泄漏面。调用方只需要知道
		// reload 的是哪个文件，不需要它在磁盘上的位置。
		const configPath = result.snapshot.configPath;
		return {
			status: "success",
			generation: result.snapshot.generation,
			operation: result.snapshot.operation,
			trigger: result.snapshot.trigger,
			completedAtEpochMs: result.snapshot.completedAtEpochMs,
			configPath:
				typeof configPath === "string" ? basename(configPath) : configPath,
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
	// Socket-level idle timeout: a slow-streaming attacker on loopback
	// could otherwise hold a request open indefinitely without the
	// `data`/`end` events firing. After the timeout elapses Node
	// destroys the socket, which surfaces as a request-level error
	// caught by readRequestBody / handleRequest.
	// socket 级空闲超时：慢速流式攻击者在环回上可能长期占用连接而不
	// 触发 `data`/`end` 事件。超时后 Node 销毁 socket，会以请求级
	// error 形式被 readRequestBody / handleRequest 捕获。
	server.setTimeout(RELOAD_WEBHOOK_SOCKET_TIMEOUT_MS);

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
		const rawSignature = Array.isArray(signatureHeader)
			? signatureHeader[0]
			: signatureHeader;
		// Be forgiving of accidental whitespace / CRLF picked up while
		// shell-piping the header value; HMAC compare still timing-safe.
		// 容忍 shell 管道复制时混入的空白 / CRLF；HMAC 比较仍是定时安全。
		const signature = rawSignature?.trim();
		if (signature == null || signature.length === 0) {
			writeJson(res, 401, {
				status: "error",
				error: "missing_signature",
				message: `Missing ${RELOAD_WEBHOOK_SIGNATURE_HEADER} header.`,
			});
			return;
		}

		let body: Buffer;
		try {
			body = await readRequestBody(req);
		} catch (readErr) {
			if (readErr instanceof RequestBodyTooLargeError) {
				writeJson(res, 413, {
					status: "error",
					error: "payload_too_large",
					message: `Request body exceeds ${MAX_RELOAD_REQUEST_BODY_BYTES} byte cap.`,
				});
				// Tear the socket down so a slow / hostile sender cannot
				// keep streaming after we have already responded.
				// 拆掉 socket，避免响应后慢速 / 恶意发送方继续灌入数据。
				req.destroy();
				return;
			}
			throw readErr;
		}

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
