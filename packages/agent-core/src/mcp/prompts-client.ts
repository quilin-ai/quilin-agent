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

import type { Client } from "@modelcontextprotocol/sdk/client";
import type {
	GetPromptResult,
	Prompt,
	PromptMessage,
} from "@modelcontextprotocol/sdk/types.js";

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

	constructor(client: PromptsClientLike, options: PromptsClientOptions = {}) {
		this.client = client;
		this.timeoutMs = options.timeoutMs ?? PROMPTS_DEFAULT_TIMEOUT_MS;
		this.isConnectedFn = options.isConnected ?? (() => true);
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
				value: normalizeRenderedPrompt(result),
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

function normalizeRenderedPrompt(result: GetPromptResult): RenderedPrompt {
	const messages = result.messages
		.map(toRenderedMessage)
		.filter((m): m is RenderedPromptMessage => m !== null);
	if (result.description) {
		return { description: result.description, messages };
	}
	return { messages };
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
