/**
 * Server-initiated elicitation handler / 服务端发起的 elicitation 处理器
 *
 * In the MCP spec ≥ 2025-12, an MCP server can call `elicitation/create` to
 * ask the client for additional structured information while a tool is
 * running. This module exposes a single entry point — {@link
 * registerElicitationHandler} — that wires a resolver function onto an SDK
 * `Client` instance so the client can answer those requests cleanly.
 *
 * MCP spec ≥ 2025-12 中，MCP 服务端可以在工具执行过程中调用
 * `elicitation/create` 向客户端反向索取结构化补充信息。本模块只暴露一个入口
 * —— {@link registerElicitationHandler} —— 把 resolver 函数挂到 SDK `Client`
 * 实例上，让客户端能干净地回应这些请求。
 *
 * Two elicitation modes are supported per the spec:
 * - `form`: server provides a `requestedSchema` (restricted JSON Schema) and a
 *   prompt message; resolver returns user-provided values or declines.
 * - `url`: server requests that the user visit a URL out-of-band; resolver
 *   confirms acknowledgement and may return null content.
 *
 * spec 定义了两种 elicitation 模式，本模块都支持：
 * - `form`：服务端提供 `requestedSchema`（受限 JSON Schema）与提示消息；resolver
 *   返回用户输入或拒绝。
 * - `url`：服务端请求用户带外访问一个 URL；resolver 仅回执确认，content 可为
 *   null。
 */

import type { Client } from "@modelcontextprotocol/sdk/client";
import {
	ElicitRequestSchema,
	type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

/** Subset of {@link ElicitResult.action} the resolver may return. */
/** resolver 可返回的 {@link ElicitResult.action} 子集。 */
export type ElicitationAction = "accept" | "decline" | "cancel";

/** Primitive value types allowed in `ElicitResult.content`. */
/** `ElicitResult.content` 中允许的原语类型。 */
export type ElicitationContentValue =
	| string
	| number
	| boolean
	| readonly string[];

/** Form-mode elicitation request (`mode === "form"` or omitted). */
/** 表单模式的 elicitation 请求（`mode === "form"` 或省略）。 */
export interface FormElicitationRequest {
	readonly mode: "form";
	readonly message: string;
	readonly requestedSchema: ElicitationSchema;
}

/** URL-mode elicitation request (`mode === "url"`). */
/** URL 模式的 elicitation 请求（`mode === "url"`）。 */
export interface UrlElicitationRequest {
	readonly mode: "url";
	readonly message: string;
	readonly elicitationId: string;
	readonly url: string;
}

/** Resolver receives this discriminated union. */
/** Resolver 接收的判别联合。 */
export type ElicitationRequest = FormElicitationRequest | UrlElicitationRequest;

/** Restricted JSON Schema the server may send (object with primitive properties). */
/** 服务端可能发送的受限 JSON Schema（属性为原语类型的 object）。 */
export interface ElicitationSchema {
	readonly type: "object";
	readonly properties: Readonly<Record<string, unknown>>;
	readonly required?: readonly string[];
}

/** Outcome returned by a {@link ElicitationResolver}. */
/** {@link ElicitationResolver} 返回的结果。 */
export interface ElicitationResponse {
	readonly action: ElicitationAction;
	/**
	 * Required when `action === "accept"` and the request is form-mode.
	 * Ignored for `decline` / `cancel` and for URL-mode requests.
	 *
	 * 当 `action === "accept"` 且为 form 模式时必填；`decline` / `cancel` 与
	 * URL 模式下会被忽略。
	 */
	readonly content?: Readonly<Record<string, ElicitationContentValue>>;
}

/** Async resolver supplied by the caller to answer elicitation requests. */
/** 由调用方提供的异步 resolver，用来回答 elicitation 请求。 */
export type ElicitationResolver = (
	request: ElicitationRequest,
) => Promise<ElicitationResponse> | ElicitationResponse;

/** Configuration for {@link registerElicitationHandler}. */
/** {@link registerElicitationHandler} 的配置。 */
export interface ElicitationHandlerOptions {
	readonly resolver: ElicitationResolver;
	/**
	 * Resolver guard timeout — if the resolver takes longer than this the
	 * handler returns `{action: "cancel"}` so the server is never left waiting
	 * indefinitely. Default 60s.
	 *
	 * resolver 保护超时 —— 超过此时间未返回则自动返回 `{action: "cancel"}`，
	 * 避免服务端无限期等待。默认 60 秒。
	 */
	readonly timeoutMs?: number;
}

/** Minimal `Client` surface we depend on — keeps tests mock-friendly. */
/** 我们依赖的 `Client` 最小接口 —— 让测试 mock 更友好。 */
export interface ElicitationCapableClient {
	setRequestHandler: Client["setRequestHandler"];
}

/** Default resolver guard timeout in ms. */
/** Resolver 守卫默认超时（毫秒）。 */
export const ELICITATION_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Wire a resolver onto a `Client` so server-issued `elicitation/create`
 * requests are answered. Returns the `ElicitResult` shape the SDK expects.
 *
 * 把 resolver 接到 `Client` 上，回应服务端发起的 `elicitation/create` 请求。
 * 返回 SDK 期望的 `ElicitResult` 形态。
 *
 * Safety guarantees / 安全保证:
 * - Resolver errors are caught and converted to `{action: "cancel"}` — the
 *   handler never throws into the SDK transport layer.
 * - Resolver timeouts also yield `{action: "cancel"}`.
 * - URL-mode requests always pass through without expecting content; if the
 *   resolver returns `accept`, content defaults to undefined.
 *
 * - resolver 抛错会被吞掉并转为 `{action: "cancel"}` —— handler 不会向 SDK
 *   传输层抛错。
 * - resolver 超时同样返回 `{action: "cancel"}`。
 * - URL 模式不要求 content；resolver 返回 `accept` 时 content 默认 undefined。
 */
export function registerElicitationHandler(
	client: ElicitationCapableClient,
	options: ElicitationHandlerOptions,
): void {
	const timeoutMs = options.timeoutMs ?? ELICITATION_DEFAULT_TIMEOUT_MS;
	const resolver = options.resolver;

	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		const normalized = normalizeRequest(request.params);
		let response: ElicitationResponse;
		try {
			response = await withResolverTimeout(
				Promise.resolve(resolver(normalized)),
				timeoutMs,
			);
		} catch {
			// Resolver threw or timed out — never propagate; cancel cleanly.
			// resolver 抛错或超时 —— 不向外传播，直接安全 cancel。
			return { action: "cancel" } as ElicitResult;
		}
		return toSdkResult(response, normalized);
	});
}

function normalizeRequest(params: unknown): ElicitationRequest {
	const obj = params as Record<string, unknown>;
	if (obj.mode === "url") {
		return {
			mode: "url",
			message: String(obj.message ?? ""),
			elicitationId: String(obj.elicitationId ?? ""),
			url: String(obj.url ?? ""),
		};
	}
	const schema = (obj.requestedSchema ?? {
		type: "object",
		properties: {},
	}) as ElicitationSchema;
	return {
		mode: "form",
		message: String(obj.message ?? ""),
		requestedSchema: schema,
	};
}

function toSdkResult(
	response: ElicitationResponse,
	request: ElicitationRequest,
): ElicitResult {
	if (response.action !== "accept") {
		return { action: response.action } as ElicitResult;
	}
	if (request.mode === "url") {
		// URL-mode accept carries no content per the spec.
		// URL 模式的 accept 按 spec 不携带 content。
		return { action: "accept" } as ElicitResult;
	}
	if (response.content == null) {
		// Form-mode accept without content is a contract violation by the
		// resolver — fall back to decline rather than send malformed payload.
		// Form 模式 accept 却未提供 content 属于 resolver 违约 —— 退化为
		// decline 以避免发送畸形数据。
		return { action: "decline" } as ElicitResult;
	}
	return {
		action: "accept",
		content: sanitizeContent(response.content),
	} as ElicitResult;
}

function sanitizeContent(
	content: Readonly<Record<string, ElicitationContentValue>>,
): Record<string, ElicitationContentValue> {
	const out: Record<string, ElicitationContentValue> = {};
	for (const [key, value] of Object.entries(content)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			out[key] = value;
			continue;
		}
		if (Array.isArray(value)) {
			out[key] = value.filter((v): v is string => typeof v === "string");
		}
		// Drop unsupported types silently — spec restricts content values to
		// primitives, so anything else would fail server-side validation.
		// 丢掉不支持的类型 —— spec 限制 content 值必须是原语，否则会被服务端
		// 校验拒绝。
	}
	return out;
}

function withResolverTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const handle = setTimeout(() => {
			rejectPromise(
				new Error(`elicitation resolver timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(handle);
				resolvePromise(value);
			},
			(error) => {
				clearTimeout(handle);
				rejectPromise(error);
			},
		);
	});
}
