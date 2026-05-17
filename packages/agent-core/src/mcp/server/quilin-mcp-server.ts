/**
 * Quilin-as-server — Stage 3 skeleton (stdio only).
 *
 * Exposes a narrow whitelist of Quilin tools and resources to peer MCP
 * clients (Claude Desktop / Cursor / Goose) over stdio. The skeleton
 * intentionally uses the low-level `Server` class so we own the
 * request handlers and the whitelist enforcement is explicit and
 * testable without spawning a subprocess (tests use
 * `InMemoryTransport.createLinkedPair`).
 *
 * Quilin-as-server —— Stage 3 骨架（仅 stdio）。
 *
 * 通过 stdio 把 Quilin 的窄白名单工具和资源暴露给 peer MCP client
 * （Claude Desktop / Cursor / Goose）。骨架特意用低级 `Server` 类，
 * 这样请求 handler 在我们手里，白名单强制可显式控制，并且测试时
 * 不用拉子进程就能跑（用 `InMemoryTransport.createLinkedPair`）。
 *
 * See `docs/research/2026-05-18-quilin-as-server/README.md`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	createMockResourceBridge,
	EXPOSED_RESOURCE_DESCRIPTORS,
	EXPOSED_RESOURCE_URIS,
	isExposedResourceUri,
	type ResourceBridge,
} from "./exposed-resources.js";
import {
	createMockToolBridge,
	createUnknownToolResult,
	EXPOSED_TOOL_DESCRIPTORS,
	EXPOSED_TOOL_NAMES,
	isExposedToolName,
	type ToolBridge,
} from "./exposed-tools.js";

const SERVER_INFO = {
	name: "quilin-mcp-server",
	version: "0.0.1",
} as const;

/**
 * Build the "unknown resource" error result. We throw it as a normal
 * Error from inside the request handler because MCP's `ReadResource`
 * does not define an `isError` field on the result; the SDK turns
 * thrown errors into JSON-RPC error responses.
 *
 * 构造"未知资源"错误。`ReadResource` 的 result 没有 `isError` 字段，
 * 所以从 handler 里抛普通 Error，SDK 会转成 JSON-RPC error response。
 */
class UnknownResourceError extends Error {
	constructor(uri: string) {
		super(`Resource "${uri}" is not exposed by this Quilin MCP server.`);
		this.name = "UnknownResourceError";
	}
}

/**
 * Optional dependency injection for tests. Both bridges default to
 * the mock implementations defined in `exposed-*.ts`. Stage 3.1 will
 * pass real implementations.
 *
 * 测试用的可选依赖注入。两个 bridge 默认走 `exposed-*.ts` 里的 mock
 * 实现。Stage 3.1 时换成真实实现传进来。
 */
export interface QuilinMcpServerOptions {
	readonly toolBridge?: ToolBridge;
	readonly resourceBridge?: ResourceBridge;
}

/**
 * The Quilin MCP server. Construct it, wire request handlers, then
 * call `connect(transport)`. `transport` is normally
 * `StdioServerTransport`, but tests pass an `InMemoryTransport`.
 *
 * Quilin MCP server。构造、装好 handler、调 `connect(transport)`。
 * `transport` 通常是 `StdioServerTransport`，测试时传
 * `InMemoryTransport`。
 */
export class QuilinMcpServer {
	private readonly server: Server;
	private readonly toolBridge: ToolBridge;
	private readonly resourceBridge: ResourceBridge;
	private connected = false;

	constructor(options: QuilinMcpServerOptions = {}) {
		this.toolBridge = options.toolBridge ?? createMockToolBridge();
		this.resourceBridge = options.resourceBridge ?? createMockResourceBridge();
		this.server = new Server(SERVER_INFO, {
			capabilities: {
				tools: {},
				resources: {},
			},
		});
		this.registerHandlers();
	}

	/** Attach a transport and start serving requests. Idempotent — calling twice on the same instance throws. */
	/** 接上 transport 并开始服务请求。同一实例重复 connect 会抛异常。 */
	async connect(transport: Transport): Promise<void> {
		if (this.connected) {
			throw new Error("QuilinMcpServer is already connected to a transport.");
		}
		await this.server.connect(transport);
		this.connected = true;
	}

	/** Close the transport. Safe to call multiple times. */
	/** 关闭 transport。可以多次调用。 */
	async close(): Promise<void> {
		if (!this.connected) {
			return;
		}
		await this.server.close();
		this.connected = false;
	}

	/** Read-only public view of connection state — useful for diagnostics. */
	/** 连接状态的只读视图，便于诊断。 */
	get isConnected(): boolean {
		return this.connected;
	}

	private registerHandlers(): void {
		this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: EXPOSED_TOOL_NAMES.map((name) => EXPOSED_TOOL_DESCRIPTORS[name]),
		}));

		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const name = request.params.name;
			if (!isExposedToolName(name)) {
				return createUnknownToolResult(name);
			}
			const rawArgs = request.params.arguments;
			const args: Readonly<Record<string, unknown>> =
				rawArgs != null && typeof rawArgs === "object"
					? (rawArgs as Readonly<Record<string, unknown>>)
					: {};
			return this.toolBridge.callTool(name, args);
		});

		this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
			resources: EXPOSED_RESOURCE_URIS.map(
				(uri) => EXPOSED_RESOURCE_DESCRIPTORS[uri],
			),
		}));

		this.server.setRequestHandler(
			ReadResourceRequestSchema,
			async (request) => {
				const uri = request.params.uri;
				if (!isExposedResourceUri(uri)) {
					throw new UnknownResourceError(uri);
				}
				return this.resourceBridge.readResource(uri);
			},
		);
	}
}

/**
 * Entry point used by the future `quilin mcp-serve` CLI command (Stage 3.1).
 * Wires a `StdioServerTransport` and blocks until the transport closes.
 *
 * 未来 `quilin mcp-serve` CLI 命令（Stage 3.1）的入口。装上
 * `StdioServerTransport` 并阻塞直到 transport 关闭。
 */
export async function runQuilinMcpServerOnStdio(
	options: QuilinMcpServerOptions = {},
): Promise<QuilinMcpServer> {
	const server = new QuilinMcpServer(options);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	return server;
}
