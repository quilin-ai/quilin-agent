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
 * URL schemes the URL-mode elicitation handler will hand to the resolver.
 * Anything else (javascript:, data:, file:, vbscript:, custom schemes, …) is
 * rejected before the resolver is called.
 *
 * Exposed as a `Object.freeze`d readonly tuple so callers cannot cast the
 * value and mutate the underlying collection (e.g.
 * `(SET as Set<string>).add("javascript:")`). A `Set` instance is mutable at
 * runtime even when typed `ReadonlySet`, so we do not expose one. Containment
 * is checked with `Array.prototype.includes` against the frozen list (O(2),
 * negligible cost for two entries).
 *
 * URL 模式 elicitation handler 允许透出给 resolver 的协议白名单。其他协议
 * （javascript:, data:, file:, vbscript:, 自定义 scheme 等）在调用 resolver
 * 之前就会被拒绝。
 *
 * 这里导出的是 `Object.freeze` 的只读元组，调用方无法通过类型 cast 反向篡改
 * 底层集合（例如 `(SET as Set<string>).add("javascript:")`）。`Set` 实例即使
 * 标了 `ReadonlySet` 在运行时依然可变，所以我们不暴露 `Set`，而是用数组的
 * `includes` 做查表（两项 O(2)，开销可忽略）。
 */
export const ELICITATION_URL_ALLOWED_SCHEMES = Object.freeze([
	"https:",
	"http:",
] as const);

/**
 * Maximum nesting depth allowed inside `requestedSchema`. Anything deeper is
 * treated as a malformed / hostile schema and the request is cancelled.
 *
 * `requestedSchema` 允许的最大嵌套深度。超过则视为畸形 / 恶意 schema，请求
 * 直接 cancel。
 */
export const ELICITATION_SCHEMA_MAX_DEPTH = 8;

/**
 * Maximum total key count across the entire `requestedSchema` tree (own
 * enumerable keys at every level summed). Caps the field explosion a hostile
 * server can force the resolver UI to render.
 *
 * 整棵 `requestedSchema` 树上允许的累计 key 数量（每层自有可枚举 key 相加）。
 * 用于上限恶意服务端能强制 resolver UI 渲染的字段数量。
 */
export const ELICITATION_SCHEMA_MAX_KEYS = 100;

/**
 * Maximum length of any single string value embedded in the schema (e.g.
 * description, default value). Strings beyond this are treated as abuse.
 *
 * Schema 中任一字符串字段（如 description、默认值）允许的最大长度。超过则视
 * 为滥用。
 */
export const ELICITATION_SCHEMA_MAX_STRING_LEN = 4_000;

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
		const normalizationResult = normalizeRequest(request.params);
		if (!normalizationResult.ok) {
			// Reject hostile / malformed requests before invoking the resolver
			// so a misbehaving server can never reach the resolver UI.
			// 在调用 resolver 之前先拒绝恶意 / 畸形请求，避免恶意服务端到达
			// resolver UI 层。
			return { action: "cancel" } as ElicitResult;
		}
		const normalized = normalizationResult.request;
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

/** Internal result of {@link normalizeRequest}. */
/** {@link normalizeRequest} 的内部返回值。 */
type NormalizationResult =
	| { readonly ok: true; readonly request: ElicitationRequest }
	| { readonly ok: false; readonly reason: string };

function normalizeRequest(params: unknown): NormalizationResult {
	if (typeof params !== "object" || params === null) {
		return { ok: false, reason: "params is not an object" };
	}
	const obj = params as Record<string, unknown>;
	if (obj.mode === "url") {
		const rawUrl = String(obj.url ?? "");
		if (!isAllowedElicitationUrl(rawUrl)) {
			return { ok: false, reason: "url scheme not allowed" };
		}
		return {
			ok: true,
			request: {
				mode: "url",
				message: String(obj.message ?? ""),
				elicitationId: String(obj.elicitationId ?? ""),
				url: rawUrl,
			},
		};
	}
	const rawSchema = obj.requestedSchema ?? {
		type: "object",
		properties: {},
	};
	const boundsCheck = validateSchemaBounds(rawSchema, {
		maxDepth: ELICITATION_SCHEMA_MAX_DEPTH,
		maxKeys: ELICITATION_SCHEMA_MAX_KEYS,
		maxStringLen: ELICITATION_SCHEMA_MAX_STRING_LEN,
	});
	if (!boundsCheck.ok) {
		return { ok: false, reason: boundsCheck.reason };
	}
	const schema = rawSchema as ElicitationSchema;
	return {
		ok: true,
		request: {
			mode: "form",
			message: String(obj.message ?? ""),
			requestedSchema: schema,
		},
	};
}

/**
 * Returns true when `rawUrl` parses as a URL whose scheme is in the
 * elicitation allow-list. Rejects javascript: / data: / file: / vbscript: /
 * arbitrary custom schemes plus anything that fails URL parsing entirely.
 *
 * 当 `rawUrl` 能解析为 URL 且 scheme 在 elicitation 白名单内时返回 true。
 * 拒绝 javascript: / data: / file: / vbscript: / 任意自定义 scheme，以及任何
 * 解析失败的字符串。
 */
function isAllowedElicitationUrl(rawUrl: string): boolean {
	if (rawUrl === "") {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}
	return (ELICITATION_URL_ALLOWED_SCHEMES as readonly string[]).includes(
		parsed.protocol,
	);
}

interface SchemaBoundsOptions {
	readonly maxDepth: number;
	readonly maxKeys: number;
	readonly maxStringLen: number;
}

type BoundsResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/**
 * Walk `schema` and reject if it exceeds depth, total-key, or string-length
 * caps. Pure, non-throwing — returns a discriminated result the caller can
 * convert into a `cancel` outcome. Counts every own enumerable key in every
 * nested object (including arrays) toward the cap.
 *
 * 遍历 `schema`，若超出深度、总 key 数、或字符串长度上限则拒绝。纯函数、不
 * 抛错 —— 返回判别结果，调用方可转为 `cancel`。把每一层嵌套对象（含数组）
 * 上的自有可枚举 key 都计入累计上限。
 */
export function validateSchemaBounds(
	schema: unknown,
	options: SchemaBoundsOptions,
): BoundsResult {
	let keyCount = 0;
	function visit(node: unknown, depth: number): BoundsResult {
		if (depth > options.maxDepth) {
			return { ok: false, reason: "schema exceeds maxDepth" };
		}
		if (typeof node === "string") {
			if (node.length > options.maxStringLen) {
				return { ok: false, reason: "schema string exceeds maxStringLen" };
			}
			return { ok: true };
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				const r = visit(item, depth + 1);
				if (!r.ok) return r;
			}
			return { ok: true };
		}
		if (typeof node === "object" && node !== null) {
			for (const [key, value] of Object.entries(node)) {
				keyCount += 1;
				if (keyCount > options.maxKeys) {
					return { ok: false, reason: "schema exceeds maxKeys" };
				}
				if (key.length > options.maxStringLen) {
					return { ok: false, reason: "schema key exceeds maxStringLen" };
				}
				const r = visit(value, depth + 1);
				if (!r.ok) return r;
			}
			return { ok: true };
		}
		// number / boolean / null / undefined — nothing to bound.
		// number / boolean / null / undefined —— 无需校验上限。
		return { ok: true };
	}
	return visit(schema, 1);
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
