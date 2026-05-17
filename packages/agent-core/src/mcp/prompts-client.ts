/**
 * MCP Prompts client wrapper / MCP 提示模板客户端封装
 *
 * Wraps the SDK `Client.listPrompts()` and `Client.getPrompt()` calls with the
 * same defensive shell as `tools/mcp-client.ts` — bounded timeout, safe-error
 * surfacing, and a connection guard. Server-exposed prompt templates are
 * surfaced as plain TypeScript records so the agent loop can paste them into
 * the LLM context without depending on SDK types at call sites.
 *
 * 用与 `tools/mcp-client.ts` 一致的防御外壳封装 SDK 的 `Client.listPrompts()`
 * 和 `Client.getPrompt()`：有界超时、错误安全外推、连接守卫。服务端暴露的提示
 * 模板会被规范成普通 TypeScript 记录，调用方无需直接依赖 SDK 类型。
 */

import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client";
import type {
	GetPromptResult,
	Prompt,
	PromptMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
	scanExternalContext,
	type ThreatMatch,
} from "../context/injection-scanner.js";

/** Default per-call timeout in milliseconds (mirrors `tools/mcp-client.ts`). */
/** 单次调用默认超时（与 `tools/mcp-client.ts` 保持一致）。 */
export const PROMPTS_DEFAULT_TIMEOUT_MS = 30_000;

/** Failure raised when a prompts/* request exceeds its bounded timeout. */
/** prompts/* 请求超出有界超时时抛出的错误。 */
export class PromptsTimeoutError extends Error {
	readonly operation: string;
	readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`MCP ${operation} timed out after ${timeoutMs}ms`);
		this.name = "PromptsTimeoutError";
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}

/** Lightweight prompt summary returned by `listPrompts`. */
/** `listPrompts` 返回的轻量提示摘要。 */
export interface PromptSummary {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly arguments: readonly PromptArgumentSummary[];
}

/** Lightweight prompt argument summary surfaced alongside `PromptSummary`. */
/** 与 `PromptSummary` 一同暴露的轻量参数摘要。 */
export interface PromptArgumentSummary {
	readonly name: string;
	readonly description?: string;
	readonly required: boolean;
}

/** Rendered prompt body returned by `getPrompt`. */
/** `getPrompt` 返回的渲染后提示主体。 */
export interface RenderedPrompt {
	readonly description?: string;
	readonly messages: readonly RenderedPromptMessage[];
	/**
	 * Threats detected by the injection scanner across the rendered message
	 * text. Empty array means the server response is clean. Message text is NOT
	 * sanitized here — the upstream ContextAssembler decides whether to keep,
	 * sanitize, or reject based on its own policy.
	 *
	 * The `matchedText` field on each entry is **fingerprinted by default**
	 * (`[redacted-<sha256-16>]`) so the raw attacker-controlled snippet never
	 * leaks into structured logs that downstream callers may emit (e.g.
	 * `logger.warn({ threats })`). The `pattern` / `location` / `severity`
	 * metadata is preserved verbatim. Opt back into raw text via
	 * {@link PromptsClientOptions.includeMatchedText} when debugging.
	 *
	 * 注入扫描器在渲染消息文本中检测到的威胁。空数组表示服务端返回内容是干净
	 * 的。这里**不**对消息文本做净化处理 —— 由上层 ContextAssembler 根据自己
	 * 的策略决定保留 / 净化 / 拒绝。
	 *
	 * 每条威胁的 `matchedText` 字段**默认会被替换为指纹**
	 * （`[redacted-<sha256-16>]`），避免攻击者控制的原始片段被下游 logger
	 * （如 `logger.warn({ threats })`）写入结构化日志。`pattern` / `location` /
	 * `severity` 等元数据原样保留。需要调试原文时，请通过
	 * {@link PromptsClientOptions.includeMatchedText} 显式打开。
	 */
	readonly threats: readonly ThreatMatch[];
}

/** Single message in a rendered prompt (text-only — non-text content is dropped). */
/** 渲染后提示中的单条消息（仅文本，非文本内容会被丢弃）。 */
export interface RenderedPromptMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** Discriminated union for `listPrompts` / `getPrompt` outcomes. */
/** `listPrompts` / `getPrompt` 结果的判别联合。 */
export type PromptsResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

/** Minimal slice of `Client` we depend on — keeps tests trivial to mock. */
/** 我们依赖的 `Client` 最小切片 —— 让测试 mock 变得简单。 */
export interface PromptsClientLike {
	listPrompts(
		params?: { cursor?: string },
		options?: { timeout?: number },
	): Promise<{ prompts: readonly Prompt[]; nextCursor?: string }>;
	getPrompt(
		params: { name: string; arguments?: Record<string, string> },
		options?: { timeout?: number },
	): Promise<GetPromptResult>;
}

/** Optional wrapper config. */
/** 可选封装配置。 */
export interface PromptsClientOptions {
	/** Per-call timeout in ms; defaults to {@link PROMPTS_DEFAULT_TIMEOUT_MS}. */
	/** 单次调用超时（毫秒），默认 {@link PROMPTS_DEFAULT_TIMEOUT_MS}。 */
	readonly timeoutMs?: number;
	/** Treated as "not connected" if false — short-circuits without touching the client. */
	/** 为 false 时视作"未连接"，立即短路不调用客户端。 */
	readonly isConnected?: () => boolean;
	/**
	 * When `true`, the raw attacker-controlled `matchedText` is returned on
	 * each {@link ThreatMatch} in {@link RenderedPrompt.threats}. Default
	 * `false` — `matchedText` is replaced with a deterministic sha256
	 * fingerprint (`[redacted-<16hex>]`) so the original snippet never reaches
	 * structured loggers. Only enable for local debugging where the caller
	 * fully controls log sinks.
	 *
	 * 为 `true` 时，{@link RenderedPrompt.threats} 中每条 {@link ThreatMatch}
	 * 的 `matchedText` 会原样返回（来自服务端的攻击者可控片段）。默认 `false`
	 * —— `matchedText` 会被替换为确定性的 sha256 指纹
	 * （`[redacted-<16 位 16 进制>]`），避免原始片段被结构化 logger 吃进去。
	 * 只在本地调试且调用方完全掌控 log sink 时再打开。
	 */
	readonly includeMatchedText?: boolean;
}

/**
 * Stable, immutable wrapper around a connected MCP `Client` for the
 * `prompts/list` and `prompts/get` requests defined in MCP spec ≥ 2025-12.
 *
 * 对已连接 MCP `Client` 的稳定、不可变封装，覆盖 MCP spec ≥ 2025-12 中定义的
 * `prompts/list` 与 `prompts/get` 请求。
 */
export class PromptsClient {
	private readonly client: PromptsClientLike;
	private readonly timeoutMs: number;
	private readonly isConnectedFn: () => boolean;
	private readonly includeMatchedText: boolean;

	constructor(client: PromptsClientLike, options: PromptsClientOptions = {}) {
		this.client = client;
		this.timeoutMs = options.timeoutMs ?? PROMPTS_DEFAULT_TIMEOUT_MS;
		this.isConnectedFn = options.isConnected ?? (() => true);
		this.includeMatchedText = options.includeMatchedText === true;
	}

	/**
	 * List prompts the server exposes. Returns a `PromptsResult` so callers can
	 * branch on success without try/catch noise.
	 *
	 * 列出服务端暴露的提示模板。返回 `PromptsResult`，调用方可在不写 try/catch 的
	 * 情况下根据 `ok` 字段分支。
	 */
	async listPrompts(params: { cursor?: string } = {}): Promise<
		PromptsResult<{
			prompts: readonly PromptSummary[];
			nextCursor?: string;
		}>
	> {
		if (!this.isConnectedFn()) {
			return { ok: false, error: "MCP client is not connected" };
		}
		try {
			const result = await withTimeout(
				this.client.listPrompts(params, { timeout: this.timeoutMs }),
				"prompts/list",
				this.timeoutMs,
			);
			const prompts = result.prompts.map(normalizePromptSummary);
			return {
				ok: true,
				value: result.nextCursor
					? { prompts, nextCursor: result.nextCursor }
					: { prompts },
			};
		} catch (error) {
			return { ok: false, error: extractErrorMessage(error) };
		}
	}

	/**
	 * Fetch a rendered prompt by name. `args` keys/values must be strings — the
	 * MCP spec only allows string-valued prompt arguments.
	 *
	 * 按名称获取渲染后的提示模板。`args` 的键值必须是字符串 —— MCP spec 仅允许
	 * 字符串类型的提示参数。
	 */
	async getPrompt(
		name: string,
		args: Readonly<Record<string, string>> = {},
	): Promise<PromptsResult<RenderedPrompt>> {
		const trimmedName = name.trim();
		if (trimmedName === "") {
			return { ok: false, error: "Prompt name must not be empty" };
		}
		if (!this.isConnectedFn()) {
			return { ok: false, error: "MCP client is not connected" };
		}
		try {
			const params: { name: string; arguments?: Record<string, string> } = {
				name: trimmedName,
			};
			if (Object.keys(args).length > 0) {
				params.arguments = { ...args };
			}
			const result = await withTimeout(
				this.client.getPrompt(params, { timeout: this.timeoutMs }),
				"prompts/get",
				this.timeoutMs,
			);
			return {
				ok: true,
				value: normalizeRenderedPrompt(result, trimmedName, {
					includeMatchedText: this.includeMatchedText,
				}),
			};
		} catch (error) {
			return { ok: false, error: extractErrorMessage(error) };
		}
	}
}

/**
 * Factory that builds a {@link PromptsClient} from a connected SDK `Client`.
 * Kept separate from the class so callers wiring the real SDK don't need to
 * cast types — `Client` already satisfies {@link PromptsClientLike}.
 *
 * 工厂函数，从已连接的 SDK `Client` 构建 {@link PromptsClient}。和类本身分开，
 * 让真正接入 SDK 的调用方无需做类型断言 —— `Client` 已天然满足
 * {@link PromptsClientLike}。
 */
export function createPromptsClient(
	client: Client,
	options: PromptsClientOptions = {},
): PromptsClient {
	return new PromptsClient(client as unknown as PromptsClientLike, options);
}

function normalizePromptSummary(prompt: Prompt): PromptSummary {
	const args = (prompt.arguments ?? []).map((arg) => {
		const summary: PromptArgumentSummary = arg.description
			? {
					name: arg.name,
					description: arg.description,
					required: arg.required === true,
				}
			: {
					name: arg.name,
					required: arg.required === true,
				};
		return summary;
	});

	const summary: { -readonly [K in keyof PromptSummary]: PromptSummary[K] } = {
		name: prompt.name,
		arguments: args,
	};
	if (prompt.title) {
		summary.title = prompt.title;
	}
	if (prompt.description) {
		summary.description = prompt.description;
	}
	return summary;
}

interface NormalizeRenderedPromptOptions {
	readonly includeMatchedText: boolean;
}

function normalizeRenderedPrompt(
	result: GetPromptResult,
	promptName: string,
	options: NormalizeRenderedPromptOptions,
): RenderedPrompt {
	const messages = result.messages
		.map(toRenderedMessage)
		.filter((m): m is RenderedPromptMessage => m !== null);

	// Run rendered text through the injection scanner. Server-supplied prompt
	// content is external input and must be screened the same way other
	// external context sources are. We surface threats but do not mutate the
	// message text — ContextAssembler decides the policy.
	// 把渲染后的文本送进注入扫描器。服务端提供的 prompt 内容属于外部输入，必须
	// 与其他外部上下文来源一样过同一道扫描。这里把威胁透出，但不改动消息文本
	// —— 由 ContextAssembler 决策。
	//
	// IMPORTANT: `matchedText` is the raw, attacker-controlled snippet. By
	// default we replace it with a deterministic sha256 fingerprint so it
	// never reaches downstream structured loggers (e.g. `logger.warn({
	// threats })`). The `pattern` / `location` / `severity` metadata is
	// preserved as-is. Opt-in to raw text via `includeMatchedText`.
	//
	// 注意：`matchedText` 是攻击者可控的原文片段。默认会被替换为确定性 sha256
	// 指纹，避免被下游结构化 logger（如 `logger.warn({ threats })`）写盘。
	// `pattern` / `location` / `severity` 等元数据原样保留。如需原文请通过
	// `includeMatchedText` 显式打开。
	const threats: ThreatMatch[] = [];
	for (const message of messages) {
		const scan = scanExternalContext(message.text, `mcp:prompts:${promptName}`);
		for (const threat of scan.threats) {
			threats.push(redactThreatMatch(threat, options.includeMatchedText));
		}
	}

	if (result.description) {
		return { description: result.description, messages, threats };
	}
	return { messages, threats };
}

/**
 * Replace `matchedText` with a sha256 fingerprint unless the caller explicitly
 * opts in to the raw value. The fingerprint is deterministic so duplicate
 * matches still collapse / dedupe usefully downstream.
 *
 * 默认把 `matchedText` 替换为 sha256 指纹；只有显式 opt-in 才返回原文。指纹
 * 是确定性的，下游做去重 / 聚合时依然可用。
 */
function redactThreatMatch(
	threat: ThreatMatch,
	includeMatchedText: boolean,
): ThreatMatch {
	if (includeMatchedText) {
		return threat;
	}
	return {
		pattern: threat.pattern,
		location: threat.location,
		severity: threat.severity,
		matchedText: fingerprintMatchedText(threat.matchedText),
	};
}

function fingerprintMatchedText(text: string): string {
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	return `[redacted-${hash}]`;
}

function toRenderedMessage(
	message: PromptMessage,
): RenderedPromptMessage | null {
	if (message.content.type === "text") {
		return {
			role: message.role,
			text: message.content.text,
		};
	}
	// Non-text content (image / audio / resource) is dropped — the agent loop
	// only consumes text, so silently skipping is safer than throwing.
	// 非文本内容（图像 / 音频 / 资源）会被丢弃 —— agent loop 只消费文本，安静跳过
	// 比抛错更安全。
	return null;
}

function extractErrorMessage(error: unknown): string {
	if (error instanceof PromptsTimeoutError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "Unknown MCP prompts error";
}

function withTimeout<T>(
	promise: Promise<T>,
	operation: string,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const handle = setTimeout(() => {
			rejectPromise(new PromptsTimeoutError(operation, timeoutMs));
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
