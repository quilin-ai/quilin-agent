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
import { type ZodType, z } from "zod";

const TEXT_FIELD_MAX_LENGTH = 4096;
const URL_FIELD_MAX_LENGTH = 2048;
const TOOL_NAME_ECHO_MAX_LENGTH = 80;
const VALIDATION_ERROR_MAX_LENGTH = 240;

function isAllowedWebFetchUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

function compactValidationMessage(message: string): string {
	return compactForErrorEcho(message, VALIDATION_ERROR_MAX_LENGTH, "...");
}

function compactForErrorEcho(
	value: string,
	maxLength: number,
	ellipsis: string,
): string {
	let output = "";
	for (const char of value) {
		if (output.length + char.length > maxLength) {
			return `${output}${ellipsis}`;
		}
		const code = char.codePointAt(0) ?? 0;
		output += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : char;
	}
	return output;
}

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
					query: {
						type: "string",
						maxLength: TEXT_FIELD_MAX_LENGTH,
						description: "Natural language query.",
					},
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
						maxLength: TEXT_FIELD_MAX_LENGTH,
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
					query: {
						type: "string",
						maxLength: TEXT_FIELD_MAX_LENGTH,
						description: "Free-text search query.",
					},
				},
				required: ["query"],
				additionalProperties: false,
			},
		},
		web_fetch: {
			// TODO(Stage-4): once we add the HTTP transport, enforce a
			// token-bucket rate limiter per peer client so this tool stops
			// being a free egress channel. Stage 3 stdio-only relies on the
			// peer trust boundary (parent process spawned us) and does NOT
			// rate-limit — see docs/research/2026-05-18-quilin-as-server.
			//
			// TODO(Stage-4)：HTTP transport 上线后，按 peer client 加 token-bucket
			// 限流，避免这工具变成免费出口。Stage 3 只走 stdio，信任 parent process
			// 的进程边界，不做限流；详见 docs/research/2026-05-18-quilin-as-server。
			name: "web_fetch",
			description:
				"Fetch a single URL and convert the page to markdown (Turndown).",
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						format: "uri",
						pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
						maxLength: URL_FIELD_MAX_LENGTH,
						description: "Absolute http(s) URL to fetch.",
					},
				},
				required: ["url"],
				additionalProperties: false,
			},
		},
	});

/**
 * Per-tool runtime validators. The MCP SDK Zod schema only validates the
 * JSON-RPC envelope (`CallToolRequestSchema`); it does NOT enforce a tool's
 * own `inputSchema`. Without this gate a peer could ship args that violate
 * `maxLength`, `enum`, or `required` constraints and the bridge would be
 * called with garbage. We co-locate a Zod schema next to each JSON Schema
 * descriptor and run it in the CallTool handler before dispatch.
 *
 * 每个工具的运行时校验器。MCP SDK 的 Zod schema 只校验 JSON-RPC envelope
 * (`CallToolRequestSchema`)；**不**对工具自身的 `inputSchema` 做校验。少了
 * 这道关，peer 发的 args 可以违反 `maxLength` / `enum` / `required`，bridge
 * 就会被垃圾输入打到。这里把 Zod schema 跟 JSON Schema 描述符并列放，在
 * CallTool handler dispatch 前跑一遍。
 *
 * The Zod shapes must stay in lock-step with the JSON Schema in
 * `EXPOSED_TOOL_DESCRIPTORS` above — if you change one, change the other.
 *
 * Zod 形状必须跟上面 `EXPOSED_TOOL_DESCRIPTORS` 里的 JSON Schema 完全对齐；
 * 改一个就要同步改另一个。
 */
export const EXPOSED_TOOL_INPUT_VALIDATORS: Readonly<
	Record<ExposedToolName, ZodType>
> = Object.freeze({
	memory_recall: z
		.object({
			query: z.string().max(TEXT_FIELD_MAX_LENGTH),
			limit: z.number().int().min(1).max(50).optional(),
		})
		.strict(),
	memory_save: z
		.object({
			kind: z.enum(["note", "fact", "preference"]),
			content: z.string().min(1).max(TEXT_FIELD_MAX_LENGTH),
		})
		.strict(),
	skill_search: z
		.object({
			query: z.string().max(TEXT_FIELD_MAX_LENGTH),
		})
		.strict(),
	web_fetch: z
		.object({
			url: z
				.string()
				.max(URL_FIELD_MAX_LENGTH)
				.url()
				.refine(
					isAllowedWebFetchUrl,
					"Only http and https URLs without userinfo are allowed.",
				),
		})
		.strict(),
});

/**
 * Validate `args` against the tool's input schema. Returns `{ ok: true }`
 * with the parsed args on success, or `{ ok: false, error }` with a
 * human-readable error string suitable for embedding in a `CallToolResult`.
 * Never throws — callers convert the failure into `isError: true`.
 *
 * 校验 `args` 是否符合工具 input schema。成功返回 `{ ok: true }` 带 parsed
 * args；失败返回 `{ ok: false, error }`，error 是给人看的字符串，可以直接塞进
 * `CallToolResult`。**永不抛**，调用方把失败转成 `isError: true`。
 */
export type ValidateToolArgsResult =
	| { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
	| { readonly ok: false; readonly error: string };

export function validateToolArgs(
	name: ExposedToolName,
	args: Readonly<Record<string, unknown>>,
): ValidateToolArgsResult {
	const validator = EXPOSED_TOOL_INPUT_VALIDATORS[name];
	const result = validator.safeParse(args);
	if (result.success) {
		return {
			ok: true,
			args: result.data as Readonly<Record<string, unknown>>,
		};
	}
	// Build a compact one-line error: "field.path: message; field.path: message"
	// so the peer can fix their call without us leaking internal state.
	//
	// 拼成一行紧凑错误："field.path: message; ..." 让 peer 能改请求，又不泄漏
	// 内部状态。
	const lines = result.error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return compactValidationMessage(`${path}: ${issue.message}`);
	});
	return {
		ok: false,
		error: lines.join("; "),
	};
}

/**
 * Build the standard "invalid arguments" CallToolResult. Returned to the
 * peer when `validateToolArgs` rejects the input. We return a result with
 * `isError: true` instead of throwing so the transport stays alive (MCP
 * convention; matches `createUnknownToolResult`).
 *
 * 构造标准的"参数非法" CallToolResult。`validateToolArgs` 拒掉时回给 peer。
 * 返回 `isError: true` 而不是抛异常，让 transport 不见异常（MCP 约定；跟
 * `createUnknownToolResult` 一致）。
 */
export function createInvalidArgsResult(
	name: string,
	error: string,
): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `Invalid arguments for tool "${name}": ${error}`,
			},
		],
		isError: true,
	};
}

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
	const echoedName = compactForErrorEcho(
		name,
		TOOL_NAME_ECHO_MAX_LENGTH,
		"...",
	);
	return {
		content: [
			{
				type: "text",
				text: `Tool "${echoedName}" is not exposed by this Quilin MCP server.`,
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
