/**
 * Stage 3 Quilin MCP server skeleton tests.
 *
 * Uses `InMemoryTransport.createLinkedPair()` so we never spawn a
 * subprocess. A real `Client` from `@modelcontextprotocol/sdk` is
 * paired with our `QuilinMcpServer`, exercising the full JSON-RPC
 * handshake (initialize → list/call) without touching stdin/stdout.
 *
 * Stage 3 Quilin MCP server 骨架测试。
 *
 * 用 `InMemoryTransport.createLinkedPair()`，不拉子进程。把
 * `@modelcontextprotocol/sdk` 的真实 `Client` 配上我们的
 * `QuilinMcpServer`，完整跑通 JSON-RPC 握手（initialize → list/call），
 * 完全不碰 stdin/stdout。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockResourceBridge,
	EXPOSED_RESOURCE_URIS,
	type ResourceBridge,
} from "./exposed-resources.js";
import {
	createMockToolBridge,
	createUnknownToolResult,
	EXPOSED_TOOL_NAMES,
	type ToolBridge,
} from "./exposed-tools.js";
import {
	QuilinMcpServer,
	runQuilinMcpServerOnStdio,
} from "./quilin-mcp-server.js";

interface Harness {
	readonly client: Client;
	readonly server: QuilinMcpServer;
	readonly toolBridge: ToolBridge;
	readonly resourceBridge: ResourceBridge;
	close: () => Promise<void>;
}

async function setupHarness(
	overrides: { toolBridge?: ToolBridge; resourceBridge?: ResourceBridge } = {},
): Promise<Harness> {
	const toolBridge = overrides.toolBridge ?? createMockToolBridge();
	const resourceBridge = overrides.resourceBridge ?? createMockResourceBridge();
	const server = new QuilinMcpServer({ toolBridge, resourceBridge });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client(
		{ name: "test-client", version: "0.0.1" },
		{ capabilities: {} },
	);

	await Promise.all([
		client.connect(clientTransport),
		server.connect(serverTransport),
	]);

	return {
		client,
		server,
		toolBridge,
		resourceBridge,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe("QuilinMcpServer — Stage 3 skeleton", () => {
	let harness: Harness | undefined;

	beforeEach(() => {
		harness = undefined;
	});

	afterEach(async () => {
		if (harness != null) {
			await harness.close();
			harness = undefined;
		}
		vi.restoreAllMocks();
	});

	it("advertises exactly the whitelisted tools via list_tools", async () => {
		harness = await setupHarness();
		const result = await harness.client.listTools();
		const names = result.tools.map((tool) => tool.name).sort();
		expect(names).toEqual([...EXPOSED_TOOL_NAMES].sort());
		// Every whitelisted tool must have a non-empty description and an
		// inputSchema — protects against shipping bare names that confuse
		// peer clients.
		for (const tool of result.tools) {
			expect(tool.description).toBeTruthy();
			expect(tool.inputSchema).toBeDefined();
		}
	});

	it("routes whitelisted call_tool to the injected ToolBridge", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const toolBridge: ToolBridge = {
			callTool: async (name, args) => {
				calls.push({ name, args: { ...args } });
				return {
					content: [{ type: "text", text: `bridged:${name}` }],
				};
			},
		};
		harness = await setupHarness({ toolBridge });

		const result = (await harness.client.callTool({
			name: "memory_recall",
			arguments: { query: "what did the user say about coffee?" },
		})) as CallToolResult;

		expect(calls).toEqual([
			{
				name: "memory_recall",
				args: { query: "what did the user say about coffee?" },
			},
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "bridged:memory_recall" },
		]);
		expect(result.isError ?? false).toBe(false);
	});

	it("rejects call_tool for a tool that is not on the whitelist", async () => {
		const callToolMock = vi.fn(
			async (): Promise<CallToolResult> => ({
				content: [{ type: "text", text: "should-not-be-called" }],
			}),
		);
		const toolBridge: ToolBridge = { callTool: callToolMock };
		harness = await setupHarness({ toolBridge });

		const result = (await harness.client.callTool({
			name: "shell_exec",
			arguments: { cmd: "rm -rf /" },
		})) as CallToolResult;

		expect(result.isError).toBe(true);
		const text = result.content
			.filter(
				(block): block is { type: "text"; text: string } =>
					block.type === "text",
			)
			.map((block) => block.text)
			.join("\n");
		expect(text).toMatch(/not exposed/i);
		expect(text).toMatch(/shell_exec/);
		expect(callToolMock).not.toHaveBeenCalled();
	});

	it("advertises exactly the whitelisted resources via list_resources", async () => {
		harness = await setupHarness();
		const result = await harness.client.listResources();
		const uris = result.resources.map((resource) => resource.uri).sort();
		expect(uris).toEqual(
			[
				"quilin://profile",
				"quilin://recent-sessions",
				"quilin://skills",
			].sort(),
		);
		for (const resource of result.resources) {
			expect(resource.name).toBeTruthy();
			expect(resource.description).toBeTruthy();
		}
	});

	it("routes whitelisted read_resource to the injected ResourceBridge", async () => {
		const reads: string[] = [];
		const resourceBridge: ResourceBridge = {
			readResource: async (uri) => {
				reads.push(uri);
				return {
					contents: [
						{
							uri,
							mimeType: "text/markdown",
							text: `bridged-content:${uri}`,
						},
					],
				};
			},
		};
		harness = await setupHarness({ resourceBridge });

		const result = await harness.client.readResource({
			uri: "quilin://profile",
		});

		expect(reads).toEqual(["quilin://profile"]);
		expect(result.contents).toHaveLength(1);
		const [content] = result.contents;
		expect(content.uri).toBe("quilin://profile");
		// `content` is a union of text/blob variants. We only assert on the
		// text branch we know we sent.
		expect("text" in content && content.text).toBe(
			"bridged-content:quilin://profile",
		);
	});

	it("rejects read_resource for a URI that is not on the whitelist", async () => {
		const readResourceMock = vi.fn(async () => ({
			contents: [
				{
					uri: "should-not-be-called",
					mimeType: "text/plain",
					text: "leak",
				},
			],
		}));
		const resourceBridge: ResourceBridge = {
			readResource: readResourceMock,
		};
		harness = await setupHarness({ resourceBridge });

		await expect(
			harness.client.readResource({ uri: "file:///etc/passwd" }),
		).rejects.toThrow(/not exposed/i);
		expect(readResourceMock).not.toHaveBeenCalled();
	});

	it("refuses to connect twice on the same instance", async () => {
		const server = new QuilinMcpServer();
		const [, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const [, otherServerTransport] = InMemoryTransport.createLinkedPair();
		await expect(server.connect(otherServerTransport)).rejects.toThrow(
			/already connected/i,
		);
		expect(server.isConnected).toBe(true);
		await server.close();
		expect(server.isConnected).toBe(false);
		// Closing again is a safe no-op.
		await server.close();
		expect(server.isConnected).toBe(false);
	});

	it("end-to-end uses the default mock bridges when none are injected", async () => {
		// Exercises the default factories (createMockToolBridge /
		// createMockResourceBridge) end-to-end through the SDK, so the
		// skeleton stays runnable for ad-hoc dev (`quilin mcp-serve`)
		// without wiring real bridges.
		harness = await setupHarness();

		const toolResult = (await harness.client.callTool({
			name: "skill_search",
			arguments: { query: "rust" },
		})) as CallToolResult;
		const toolText = toolResult.content
			.filter(
				(block): block is { type: "text"; text: string } =>
					block.type === "text",
			)
			.map((block) => block.text)
			.join("\n");
		const parsed = JSON.parse(toolText) as {
			mock: boolean;
			name: string;
			args: Record<string, unknown>;
		};
		expect(parsed).toEqual({
			mock: true,
			name: "skill_search",
			args: { query: "rust" },
		});

		const resourceResult = await harness.client.readResource({
			uri: EXPOSED_RESOURCE_URIS[0],
		});
		expect(resourceResult.contents).toHaveLength(1);
		const [content] = resourceResult.contents;
		expect("text" in content && content.text).toMatch(/mock resource/);
	});

	it("createUnknownToolResult shape: text content + isError true", () => {
		// Direct unit test on the error-result helper so the helper is
		// covered even when the integration test reaches it indirectly.
		const result = createUnknownToolResult("danger_tool");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Tool "danger_tool" is not exposed by this Quilin MCP server.',
			},
		]);
	});

	it("passes an empty args object when the peer omits arguments entirely", async () => {
		// Covers the `rawArgs == null` branch in the call_tool handler:
		// a peer that calls a whitelisted tool without `arguments` should
		// still reach the bridge with `args === {}`.
		const calls: Array<Record<string, unknown>> = [];
		const toolBridge: ToolBridge = {
			callTool: async (_name, args) => {
				calls.push({ ...args });
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		harness = await setupHarness({ toolBridge });

		await harness.client.callTool({ name: "memory_recall" });

		expect(calls).toEqual([{}]);
	});

	it("serializes concurrent connect() calls via TOCTOU-safe flag flip", async () => {
		// Two concurrent connect() calls race the `if (this.connected)` guard.
		// With a sync flag flip before the await, only one passes the guard;
		// the other rejects with "already connected" before touching the SDK.
		//
		// 两个并发 connect() 抢 `if (this.connected)` guard。同步翻转 flag 后，
		// 只有一个能过 guard，另一个直接被 "already connected" 拒绝，不会进 SDK。
		const startSpy = vi.fn(async () => {
			// Give the second call a chance to interleave before start resolves.
			// 让第二个 call 有机会在 start resolve 之前插进来。
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		const slowTransport: Transport = {
			start: startSpy,
			send: async () => {},
			close: async () => {},
		};
		const server = new QuilinMcpServer();

		const [first, second] = await Promise.allSettled([
			server.connect(slowTransport),
			server.connect(slowTransport),
		]);

		// Exactly one should fulfil, exactly one should reject.
		// 必须正好一个成功、一个失败。
		const fulfilledCount = [first, second].filter(
			(r) => r.status === "fulfilled",
		).length;
		const rejectedCount = [first, second].filter(
			(r) => r.status === "rejected",
		).length;
		expect(fulfilledCount).toBe(1);
		expect(rejectedCount).toBe(1);
		const rejection = [first, second].find((r) => r.status === "rejected") as
			| PromiseRejectedResult
			| undefined;
		expect(String(rejection?.reason)).toMatch(/already connected/i);
		// SDK transport.start must only run once — proves we did not let two
		// connect calls both reach the SDK.
		// SDK transport.start 必须只跑一次，证明两个 connect 没有都打到 SDK。
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(server.isConnected).toBe(true);

		await server.close();
	});

	it("rolls connected back to false when the SDK connect rejects", async () => {
		// If the transport.start throws, SDK server.connect rejects. Our
		// connect() catch block must restore `connected = false` so subsequent
		// observers (and `isConnected` callers) see the truthful "not
		// connected" state rather than a zombie `true`.
		//
		// transport.start 抛错 → SDK server.connect reject。connect() 的 catch
		// 必须把 `connected` 还原为 false，避免 `isConnected` 读到僵尸 `true`。
		const failingTransport: Transport = {
			start: async () => {
				throw new Error("boom-start");
			},
			send: async () => {},
			close: async () => {},
		};
		const server = new QuilinMcpServer();

		await expect(server.connect(failingTransport)).rejects.toThrow(
			/boom-start/,
		);
		// Critical assertion: with the bug, connected would remain true and
		// future `isConnected` reads would be wrong; the rollback restores it.
		// 关键断言：bug 存在时 connected 会留在 true，回滚后状态恢复正确。
		expect(server.isConnected).toBe(false);
	});

	it("restores connected=true when the SDK close rejects", async () => {
		// If SDK close throws, the underlying connection state is ambiguous.
		// We surface the error and keep `connected = true` so the caller knows
		// the close did not actually complete and can retry.
		//
		// SDK close 抛错时连接状态未知。把错误抛出去，并保持 `connected = true`，
		// 让调用方知道 close 没真正完成，可以重试。
		const failingTransport: Transport = {
			start: async () => {},
			send: async () => {},
			close: async () => {
				throw new Error("boom-close");
			},
		};
		const server = new QuilinMcpServer();
		await server.connect(failingTransport);
		expect(server.isConnected).toBe(true);

		await expect(server.close()).rejects.toThrow(/boom-close/);
		// connected stays true because close did not succeed; otherwise the
		// caller would mistakenly believe the transport was released.
		// connected 保持 true，因为 close 没成功；否则调用方会误以为已释放。
		expect(server.isConnected).toBe(true);
	});

	it("SDK rejects array arguments upstream — defensive Array.isArray guard documented in code", async () => {
		// Belt-and-suspenders documentation: the production CallTool handler
		// adds `&& !Array.isArray(rawArgs)` to its type guard, but the SDK's
		// CallToolRequestSchema (Zod `record`) already rejects array
		// arguments at the JSON-RPC layer with an "expected record, received
		// array" error before the handler ever runs. This test pins that
		// upstream behavior so a future SDK loosening is caught by CI rather
		// than silently bypassing our defensive guard.
		//
		// 双重防护的实证：CallTool handler 加了 `!Array.isArray(rawArgs)` 防御，
		// 而 SDK 的 CallToolRequestSchema（Zod `record`）已经在 JSON-RPC 层
		// 把数组 arguments 拦下，handler 根本不会被调到。这里把上游行为钉死，
		// 万一未来 SDK 放宽校验，CI 会立刻发现，而不是悄悄绕过我们的防御。
		const calls: Array<Record<string, unknown>> = [];
		const toolBridge: ToolBridge = {
			callTool: async (_name, args) => {
				calls.push({ ...args });
				return { content: [{ type: "text", text: "should-not-run" }] };
			},
		};
		harness = await setupHarness({ toolBridge });

		// Deliberately feeding an array where the schema requires a record so
		// we can lock in the upstream rejection behavior. Cast through
		// `unknown` keeps biome happy without `any`.
		// 故意传一个数组,目的是把上游"必须是 record"的拒绝行为钉死。
		// 通过 `unknown` 中转可以避开 biome 的 no-any 规则。
		const arrayArgs = [1, 2, 3] as unknown as Record<string, unknown>;
		await expect(
			harness.client.callTool({
				name: "memory_recall",
				arguments: arrayArgs,
			}),
		).rejects.toThrow(/expected record, received array/i);

		// The defensive guard plus upstream Zod means our bridge is never
		// invoked with a non-Record args object.
		// 防御性 guard + 上游 Zod 双保险，bridge 永远不会拿到非 Record 的 args。
		expect(calls).toEqual([]);
	});

	it("runQuilinMcpServerOnStdio constructs a connected server, closeable in tests", async () => {
		// The CLI entrypoint binds StdioServerTransport to the current
		// process. We immediately close it to release the stdin listener
		// so the test process exits cleanly. This proves the entrypoint
		// at least round-trips construction → connect → close.
		const server = await runQuilinMcpServerOnStdio();
		expect(server.isConnected).toBe(true);
		await server.close();
		expect(server.isConnected).toBe(false);
	});
});
