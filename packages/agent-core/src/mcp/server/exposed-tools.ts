/**
 * Stage 3 (Quilin-as-server) tool whitelist.
 *
 * Anything NOT in `EXPOSED_TOOL_NAMES` is invisible to peer MCP clients
 * (Claude Desktop, Cursor, Goose, etc.). `list_tools` won't show it, and
 * `call_tool` on an unlisted name returns an `unknown_tool` error result
 * — never an exception, so transport stays alive.
 *
 * Stage 3（Quilin-as-server）的工具白名单。
 *
 * 凡是不在 `EXPOSED_TOOL_NAMES` 里的工具，对 peer MCP client
 * （Claude Desktop / Cursor / Goose 等）完全不可见：`list_tools`
 * 不会列出来，`call_tool` 调用未列名也只返回 `unknown_tool` 错误结果
 * （不是抛异常），保证 transport 不挂。
 *
 * See `docs/research/2026-05-18-quilin-as-server/README.md` § 2 for
 * rationale on which tools made the MVP cut.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Names of tools exposed to peer MCP clients in Stage 3.
 *
 * Stage 3 暴露给 peer MCP client 的工具名。
 */
export const EXPOSED_TOOL_NAMES = [
	"memory_recall",
	"memory_save",
	"skill_search",
	"web_fetch",
] as const;

export type ExposedToolName = (typeof EXPOSED_TOOL_NAMES)[number];

/**
 * Tool descriptors advertised via `list_tools`. Schemas are intentionally
 * small JSON Schema objects (not Zod) because MCP's wire schema is JSON
 * Schema and the SDK passes them through unchanged.
 *
 * 通过 `list_tools` 对外公布的工具描述。schema 故意写成小的 JSON Schema
 * 对象（不用 Zod），因为 MCP 协议本身用 JSON Schema，SDK 透传。
 */
export const EXPOSED_TOOL_DESCRIPTORS: Readonly<Record<ExposedToolName, Tool>> =
	Object.freeze({
		memory_recall: {
			name: "memory_recall",
			description:
				"Read-only semantic / KG recall over Quilin's 4-tier memory store.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Natural language query." },
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 50,
						description: "Max number of items to return (default 10).",
					},
				},
				required: ["query"],
				additionalProperties: false,
			},
		},
		memory_save: {
			name: "memory_save",
			description:
				"Append a single typed observation to Quilin's working memory.",
			inputSchema: {
				type: "object",
				properties: {
					kind: {
						type: "string",
						enum: ["note", "fact", "preference"],
						description: "Observation kind.",
					},
					content: {
						type: "string",
						minLength: 1,
						maxLength: 4096,
						description: "Observation text (max 4096 chars).",
					},
				},
				required: ["kind", "content"],
				additionalProperties: false,
			},
		},
		skill_search: {
			name: "skill_search",
			description:
				"Search the local SKILL.md catalog (Quilin skills, domain 13).",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Free-text search query." },
				},
				required: ["query"],
				additionalProperties: false,
			},
		},
		web_fetch: {
			name: "web_fetch",
			description:
				"Fetch a single URL and convert the page to markdown (Turndown).",
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						format: "uri",
						description: "Absolute http(s) URL to fetch.",
					},
				},
				required: ["url"],
				additionalProperties: false,
			},
		},
	});

/**
 * Pluggable bridge to real Quilin subsystems. The skeleton ships a mock
 * implementation (`createMockToolBridge`) so tests can run without booting
 * `quilin-mem`. Stage 3.1 will replace the mocks with real wiring.
 *
 * 可注入的桥接到真实 Quilin 子系统。骨架自带 mock 实现
 * （`createMockToolBridge`），让测试不依赖 `quilin-mem` 启动。Stage 3.1
 * 会把 mock 换成真实接线。
 */
export interface ToolBridge {
	readonly callTool: (
		name: ExposedToolName,
		args: Readonly<Record<string, unknown>>,
	) => Promise<CallToolResult>;
}

/**
 * Build a deterministic mock `ToolBridge` for tests and local dev.
 * Each tool returns a fixed text payload that includes the args, so
 * tests can assert "the right tool got called with the right args".
 *
 * 构造确定性 mock `ToolBridge`，给测试和本地开发用。每个工具回固定的
 * text payload 并把 args 嵌进去，方便测试断言"对的工具收到了对的 args"。
 */
export function createMockToolBridge(): ToolBridge {
	return {
		callTool: async (name, args) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({ mock: true, name, args }),
				},
			],
		}),
	};
}

/**
 * Build the standard "unknown tool" CallToolResult. Used by the server
 * when a peer asks for a tool not on the whitelist. We return a result
 * with `isError: true` instead of throwing so the transport doesn't
 * see an exception (MCP convention).
 *
 * 构造标准的"未知工具" CallToolResult。peer 请求非白名单工具时使用。
 * 返回 `isError: true` 而不是抛异常，让 transport 不见异常（MCP 约定）。
 */
export function createUnknownToolResult(name: string): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `Tool "${name}" is not exposed by this Quilin MCP server.`,
			},
		],
		isError: true,
	};
}

/**
 * Type guard: is `name` on the exposed tool whitelist?
 *
 * 类型守卫：`name` 是否在工具白名单上？
 */
export function isExposedToolName(name: string): name is ExposedToolName {
	return (EXPOSED_TOOL_NAMES as readonly string[]).includes(name);
}
