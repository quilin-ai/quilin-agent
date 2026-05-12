/**
 * Adapter: convert an `@quilin/agent-core` `Tool` into a Vercel AI SDK
 * `tool()` map entry, so `streamText({ tools: { ... } })` can dispatch
 * tool calls to the real agent-core implementations (file_read,
 * shell_exec, web_fetch, etc.) instead of the hard-coded inline tools
 * that previously shipped in this route.
 *
 * Why an adapter and not direct use of `runAgentLoop`?
 *   - Slice 2 keeps the existing `streamText` UIMessage SSE wire format
 *     so the browser `useChat` hook keeps working without client
 *     changes.
 *   - Slice 3+ will eventually replace `streamText` with a direct
 *     `runAgentLoop` driver, at which point this adapter file is
 *     deleted in favor of the AgentService event stream.
 *
 * 适配器：把 agent-core 的 `Tool` 包成 Vercel AI SDK 的 `tool()`,
 * `streamText` 即可直接调度到 agent-core 的真实工具实现。slice 3+ 把
 * `streamText` 换成直接走 runAgentLoop 后,这个适配层就可以删掉。
 */

import { type Tool as AiSdkTool, tool as aiSdkTool } from "ai";

interface AgentCoreToolResult {
	readonly toolCallId?: string;
	readonly content: string;
	readonly isError: boolean;
	readonly error?: { readonly message: string; readonly code?: string };
}

interface AgentCoreTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown; // ZodSchema; loose-typed so we don't pin a zod major
	readonly execute: (args: unknown) => Promise<AgentCoreToolResult>;
}

/**
 * Try to parse a tool's `content` string as JSON. agent-core tools often
 * return structured JSON in `content`; surfacing it as a parsed object lets
 * the LLM reason over fields directly. Falls back to the raw string when
 * `content` isn't valid JSON.
 *
 * 工具结果先尝试 JSON 解析,LLM 直接拿到结构化字段会更好用;不是 JSON 就
 * 原样返回字符串。
 */
function parseToolContent(content: string): unknown {
	const trimmed = content.trim();
	if (trimmed.length === 0) return "";
	if (trimmed[0] !== "{" && trimmed[0] !== "[") return content;
	try {
		return JSON.parse(trimmed);
	} catch {
		return content;
	}
}

/**
 * Adapt one agent-core tool. The returned object is the value side of an
 * AI SDK tools map: `tools: { [name]: adaptToolForAiSdk(t) }`.
 */
export function adaptToolForAiSdk(t: AgentCoreTool): AiSdkTool {
	return aiSdkTool({
		description: t.description,
		// AI SDK expects a Zod schema (or JSON Schema). agent-core ships
		// Zod schemas, so this is a direct pass-through.
		inputSchema: t.parameters as never,
		execute: async (args: unknown) => {
			const result = await t.execute(args);
			if (result.isError) {
				// Surface as a tool error to the LLM rather than throwing —
				// the model handles `{ error }` results gracefully and can
				// retry or pivot, while a thrown error aborts the whole step.
				return {
					error: result.error?.message ?? result.content,
					errorCode: result.error?.code,
				};
			}
			return parseToolContent(result.content);
		},
	});
}

/**
 * agent-core namespaces MCP tools as `namespace/tool` (e.g.,
 * `exa/web_search`), but DeepSeek's OpenAI-compatible API only accepts
 * tool names matching `^[a-zA-Z0-9_-]+$`. Replace `/` with `__` so names
 * round-trip cleanly through DeepSeek without changing semantics.
 *
 * agent-core 用 `namespace/tool` 命名 MCP 工具,但 OpenAI 兼容 API 只接
 * `^[a-zA-Z0-9_-]+$`。把 `/` 换成 `__` 即可。
 */
export function sanitizeToolNameForOpenAI(name: string): string {
	return name.replace(/\//g, "__");
}

/**
 * Bulk-adapt: turn an array of agent-core tools into the AI SDK tools map.
 *
 * 批量适配:把 agent-core 工具数组转成 AI SDK 的 tools 字典。
 */
export function adaptToolsForAiSdk(tools: readonly AgentCoreTool[]): Record<string, AiSdkTool> {
	const out: Record<string, AiSdkTool> = {};
	for (const t of tools) {
		out[sanitizeToolNameForOpenAI(t.name)] = adaptToolForAiSdk(t);
	}
	return out;
}
