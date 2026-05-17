/**
 * Composite MCP client surface / 复合 MCP 客户端入口
 *
 * Composes {@link PromptsClient} and {@link registerElicitationHandler} into a
 * single façade so callers can wire up MCP spec ≥ 2025-12 features (Prompts +
 * Elicitation) in one line. This module is intentionally thin — it does not
 * own connection lifecycle (that stays with `tools/mcp-client.ts`'s
 * `MCPClientManager`); it only annotates an already-connected `Client`.
 *
 * 把 {@link PromptsClient} 与 {@link registerElicitationHandler} 组合成单一门
 * 面，调用方一行代码即可接入 MCP spec ≥ 2025-12 的 Prompts + Elicitation
 * 能力。本模块刻意做薄 —— 不接管连接生命周期（连接仍由 `tools/mcp-client.ts`
 * 的 `MCPClientManager` 负责），仅在已连接的 `Client` 上挂能力。
 */

import type { Client } from "@modelcontextprotocol/sdk/client";
import {
	type ElicitationHandlerOptions,
	registerElicitationHandler,
} from "./elicitation-handler.js";
import {
	createPromptsClient,
	type PromptSummary,
	type PromptsClient,
	type PromptsClientOptions,
	type PromptsResult,
	type RenderedPrompt,
} from "./prompts-client.js";

/** Options for {@link createMCPCapabilities}. */
/** {@link createMCPCapabilities} 的可选参数。 */
export interface MCPCapabilitiesOptions {
	/** Forwarded to {@link createPromptsClient}. */
	/** 透传给 {@link createPromptsClient}。 */
	readonly prompts?: PromptsClientOptions;
	/**
	 * Optional elicitation resolver — when present, registers the handler on
	 * the client so server-issued `elicitation/create` requests are answered.
	 * When omitted, no handler is registered (server-issued elicitations will
	 * fall through to SDK default behavior, which rejects them).
	 *
	 * 可选的 elicitation resolver —— 提供时会在 client 上注册 handler，回应
	 * 服务端发起的 `elicitation/create`。不提供时不注册（服务端 elicitation
	 * 会落到 SDK 默认行为，会被拒绝）。
	 */
	readonly elicitation?: ElicitationHandlerOptions;
}

/** Façade returned by {@link createMCPCapabilities}. */
/** {@link createMCPCapabilities} 返回的门面对象。 */
export interface MCPCapabilities {
	readonly prompts: PromptsClient;
	/** Convenience pass-through to `prompts.listPrompts()`. */
	/** 透传到 `prompts.listPrompts()` 的便捷方法。 */
	listPrompts(params?: { cursor?: string }): Promise<
		PromptsResult<{
			prompts: readonly PromptSummary[];
			nextCursor?: string;
		}>
	>;
	/** Convenience pass-through to `prompts.getPrompt(name, args)`. */
	/** 透传到 `prompts.getPrompt(name, args)` 的便捷方法。 */
	getPrompt(
		name: string,
		args?: Readonly<Record<string, string>>,
	): Promise<PromptsResult<RenderedPrompt>>;
	/**
	 * `true` if an elicitation handler was registered on the underlying
	 * client. Useful for diagnostics and tests.
	 *
	 * 若底层 client 已注册 elicitation handler 则为 `true`。便于诊断与测试。
	 */
	readonly elicitationHandlerRegistered: boolean;
}

/**
 * Attach Prompts + Elicitation capabilities to an already-connected MCP
 * `Client`. The returned façade is immutable and safe to share across
 * concurrent callers.
 *
 * 在已连接的 MCP `Client` 上挂载 Prompts + Elicitation 能力。返回的门面对象
 * 不可变，可安全在并发调用方间共享。
 */
export function createMCPCapabilities(
	client: Client,
	options: MCPCapabilitiesOptions = {},
): MCPCapabilities {
	const prompts = createPromptsClient(client, options.prompts);
	let registered = false;
	if (options.elicitation != null) {
		registerElicitationHandler(client, options.elicitation);
		registered = true;
	}

	return {
		prompts,
		listPrompts: (params) => prompts.listPrompts(params ?? {}),
		getPrompt: (name, args) => prompts.getPrompt(name, args ?? {}),
		elicitationHandlerRegistered: registered,
	};
}
