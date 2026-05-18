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

	it("truncates and compacts unknown tool names in error results", async () => {
		const callToolMock = vi.fn(
			async (): Promise<CallToolResult> => ({
				content: [{ type: "text", text: "should-not-be-called" }],
			}),
		);
		const toolBridge: ToolBridge = { callTool: callToolMock };
		harness = await setupHarness({ toolBridge });
		const maliciousName = `danger\n${"x".repeat(1_000)}`;

		const result = (await harness.client.callTool({
			name: maliciousName,
			arguments: {},
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
		expect(text).toContain("danger ");
		expect(text).not.toContain("\n");
		expect(text).not.toContain("x".repeat(200));
		expect(text.length).toBeLessThan(170);
		expect(callToolMock).not.toHaveBeenCalled();
	});

	it("compacts C1 control characters in unknown tool names", async () => {
		const callToolMock = vi.fn(
			async (): Promise<CallToolResult> => ({
				content: [{ type: "text", text: "should-not-be-called" }],
			}),
		);
		const toolBridge: ToolBridge = { callTool: callToolMock };
		harness = await setupHarness({ toolBridge });
		const csi = String.fromCharCode(0x9b);
		const nel = String.fromCharCode(0x85);

		const result = (await harness.client.callTool({
			name: `danger${csi}31mred${nel}next`,
			arguments: {},
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
		expect(text).not.toContain(csi);
		expect(text).not.toContain(nel);
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

	it("tracks peer-initiated close and can reconnect with the same bridges", async () => {
		// The SDK clears its own transport when the peer closes, but our
		// wrapper must observe that onclose too. Otherwise `isConnected`
		// remains true and the public connect() guard rejects retries even
		// though the SDK is already disconnected.
		//
		// peer 主动关闭时，SDK 会清掉自己的 transport；外层 wrapper 也必须
		// 同步这个 onclose。否则 `isConnected` 会卡在 true，public connect()
		// guard 会拒绝重连，即便 SDK 已经断开。
		const calls: Array<Record<string, unknown>> = [];
		const toolBridge: ToolBridge = {
			callTool: async (_name, args) => {
				calls.push({ ...args });
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const server = new QuilinMcpServer({ toolBridge });
		const [firstClientTransport, firstServerTransport] =
			InMemoryTransport.createLinkedPair();
		const firstClient = new Client(
			{ name: "first-client", version: "0.0.1" },
			{ capabilities: {} },
		);

		await Promise.all([
			firstClient.connect(firstClientTransport),
			server.connect(firstServerTransport),
		]);
		expect(server.isConnected).toBe(true);

		await firstClient.close();
		expect(server.isConnected).toBe(false);

		const [secondClientTransport, secondServerTransport] =
			InMemoryTransport.createLinkedPair();
		const secondClient = new Client(
			{ name: "second-client", version: "0.0.1" },
			{ capabilities: {} },
		);
		await Promise.all([
			secondClient.connect(secondClientTransport),
			server.connect(secondServerTransport),
		]);

		const result = (await secondClient.callTool({
			name: "memory_recall",
			arguments: { query: "after peer close" },
		})) as CallToolResult;
		expect(result.isError ?? false).toBe(false);
		expect(calls).toEqual([{ query: "after peer close" }]);

		await secondClient.close();
	});

	it("does not mark connected when the transport closes during start()", async () => {
		// Some transports can observe an early peer close while start() is
		// still running, then resolve after cleanup. The SDK onclose callback
		// has already reset the wrapper by then, so connect() must not blindly
		// write `connected` after await returns.
		//
		// 有些 transport 会在 start() 还没返回时观察到 peer 提前断开，然后在
		// 清理后 resolve。此时 SDK onclose callback 已经重置外层 wrapper，
		// connect() 不能在 await 返回后无条件写回 `connected`。
		const earlyCloseTransport: Transport = {
			start: async () => {
				earlyCloseTransport.onclose?.();
			},
			send: async () => {},
			close: async () => {},
		};
		const server = new QuilinMcpServer();

		await expect(server.connect(earlyCloseTransport)).rejects.toThrow(
			/closed during connect/i,
		);
		expect(server.isConnected).toBe(false);

		const [, retryTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(retryTransport);
		expect(server.isConnected).toBe(true);

		await server.close();
	});

	it("close() cancels a pending connect attempt before start resolves", async () => {
		let resolveStart: (() => void) | undefined;
		const closeSpy = vi.fn(async () => {});
		const slowTransport: Transport = {
			start: async () => {
				await new Promise<void>((resolve) => {
					resolveStart = resolve;
				});
			},
			send: async () => {},
			close: closeSpy,
		};
		const server = new QuilinMcpServer();
		const connectPromise = server.connect(slowTransport);

		await server.close();
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(server.isConnected).toBe(false);

		resolveStart?.();
		await expect(connectPromise).rejects.toThrow(/closed during connect/i);
		expect(server.isConnected).toBe(false);

		const [, retryTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(retryTransport);
		expect(server.isConnected).toBe(true);

		await server.close();
	});

	it("old canceled connect resolving does not overwrite a successful retry", async () => {
		let resolveStart: (() => void) | undefined;
		const oldCloseSpy = vi.fn(async () => {});
		const oldTransport: Transport = {
			start: async () => {
				await new Promise<void>((resolve) => {
					resolveStart = resolve;
				});
			},
			send: async () => {},
			close: oldCloseSpy,
		};
		const server = new QuilinMcpServer();
		const oldConnectPromise = server.connect(oldTransport);

		await server.close();
		expect(oldCloseSpy).toHaveBeenCalledTimes(1);

		const [, retryTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(retryTransport);
		expect(server.isConnected).toBe(true);

		resolveStart?.();
		await expect(oldConnectPromise).rejects.toThrow(/closed during connect/i);
		expect(server.isConnected).toBe(true);

		await server.close();
		expect(server.isConnected).toBe(false);
	});

	it("old canceled connect rejecting does not overwrite a successful retry", async () => {
		let rejectStart: ((error: Error) => void) | undefined;
		const oldCloseSpy = vi.fn(async () => {});
		const oldTransport: Transport = {
			start: async () => {
				await new Promise<void>((_resolve, reject) => {
					rejectStart = reject;
				});
			},
			send: async () => {},
			close: oldCloseSpy,
		};
		const server = new QuilinMcpServer();
		const oldConnectPromise = server.connect(oldTransport);

		await server.close();
		expect(oldCloseSpy).toHaveBeenCalledTimes(1);

		const [, retryTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(retryTransport);
		expect(server.isConnected).toBe(true);

		rejectStart?.(new Error("old-boom"));
		await expect(oldConnectPromise).rejects.toThrow(/old-boom/);
		expect(server.isConnected).toBe(true);

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

	it("normalizes missing `arguments` to {} and lets inputSchema validation reject when fields are required", async () => {
		// Covers the `rawArgs == null` branch in the call_tool handler:
		// a peer that calls a whitelisted tool without `arguments` flows
		// through the null-normalization (rawArgs → {}) and then into
		// validateToolArgs, which rejects because `memory_recall` requires
		// `query`. Result: isError:true and bridge never called.
		//
		// 覆盖 call_tool handler 里的 `rawArgs == null` 分支:peer 不带
		// `arguments` 时,空值归一化到 {} 后进入 validateToolArgs;
		// `memory_recall` 必填 `query` 所以会被拒。结果:isError:true,
		// bridge 不会被调到。
		const calls: Array<Record<string, unknown>> = [];
		const toolBridge: ToolBridge = {
			callTool: async (_name, args) => {
				calls.push({ ...args });
				return { content: [{ type: "text", text: "should-not-run" }] };
			},
		};
		harness = await setupHarness({ toolBridge });

		const result = (await harness.client.callTool({
			name: "memory_recall",
		})) as CallToolResult;

		expect(result.isError).toBe(true);
		const text = result.content
			.filter(
				(block): block is { type: "text"; text: string } =>
					block.type === "text",
			)
			.map((block) => block.text)
			.join("\n");
		expect(text).toMatch(/invalid arguments/i);
		expect(text).toMatch(/query/i);
		expect(calls).toEqual([]);
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

	it("can retry connect() after the SDK connect rejects", async () => {
		// The MCP SDK stores the transport before calling transport.start().
		// If start() rejects, merely rolling our boolean flag back is not enough:
		// the underlying SDK Server would still reject the next connect() as
		// "already connected". We rebuild the SDK Server on failed connect so
		// the wrapper's public "disconnected" state is genuinely retryable.
		//
		// MCP SDK 会先保存 transport，再调用 transport.start()。如果 start()
		// reject，只回滚外层 boolean 不够：底层 SDK Server 仍会把下一次 connect()
		// 拒为 "already connected"。失败时重建 SDK Server，确保外层
		// "disconnected" 状态真的可重试。
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
		expect(server.isConnected).toBe(false);

		const [, retryTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(retryTransport);
		expect(server.isConnected).toBe(true);

		await server.close();
		expect(server.isConnected).toBe(false);
	});

	it("closes the failed transport when SDK connect rejects", async () => {
		// A transport may allocate listeners or sockets before start()
		// rejects. Since the SDK stores the transport before start(), our
		// wrapper must close it before replacing the SDK Server.
		//
		// transport 可能在 start() reject 前已经分配 listener 或 socket。
		// SDK 会先保存 transport 再 start，所以外层重建 SDK Server 前必须
		// 主动 close 这个失败 transport。
		const closeSpy = vi.fn(async () => {});
		const failingTransport: Transport = {
			start: async () => {
				throw new Error("boom-start");
			},
			send: async () => {},
			close: closeSpy,
		};
		const server = new QuilinMcpServer();

		await expect(server.connect(failingTransport)).rejects.toThrow(
			/boom-start/,
		);
		expect(closeSpy).toHaveBeenCalledTimes(1);
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

	it("does not restore connected when close rejects after onclose fired", async () => {
		const failingAfterOnCloseTransport: Transport = {
			start: async () => {},
			send: async () => {},
			close: async () => {
				failingAfterOnCloseTransport.onclose?.();
				throw new Error("boom-after-onclose");
			},
		};
		const server = new QuilinMcpServer();
		await server.connect(failingAfterOnCloseTransport);
		expect(server.isConnected).toBe(true);

		await expect(server.close()).rejects.toThrow(/boom-after-onclose/);
		expect(server.isConnected).toBe(false);

		const [, retryTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(retryTransport);
		expect(server.isConnected).toBe(true);

		await server.close();
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

	describe("inputSchema enforcement (REAL-2 fix)", () => {
		// These tests exercise validateToolArgs in the CallTool handler.
		// The MCP SDK only validates the JSON-RPC envelope; without our
		// gate, peer args that violate maxLength / required / enum would
		// reach the bridge unchecked. Each test asserts:
		//   (a) bridge is NOT called, and
		//   (b) result.isError === true with a descriptive message.
		//
		// 这些测试跑 CallTool handler 里的 validateToolArgs。MCP SDK 只校验
		// JSON-RPC envelope;没这道关,违反 maxLength / required / enum 的
		// peer args 会原样打到 bridge。每个测试断言:
		//   (a) bridge 不被调到;
		//   (b) result.isError === true 且消息可读。

		function makeCountingBridge(): {
			bridge: ToolBridge;
			callCount: () => number;
		} {
			let calls = 0;
			return {
				bridge: {
					callTool: async (_name, _args) => {
						calls += 1;
						return {
							content: [{ type: "text", text: "bridge-should-not-run" }],
						};
					},
				},
				callCount: () => calls,
			};
		}

		function extractText(result: CallToolResult): string {
			return result.content
				.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text",
				)
				.map((block) => block.text)
				.join("\n");
		}

		it("rejects memory_save when content exceeds maxLength: 4096", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const oversize = "x".repeat(4097);
			const result = (await harness.client.callTool({
				name: "memory_save",
				arguments: { kind: "note", content: oversize },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/content/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_save when required field is missing", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_save",
				// Missing `kind` field — required by the schema.
				// 缺 `kind` 字段 —— schema 要求必填。
				arguments: { content: "hello" },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/kind/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_save when kind is not in the enum", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_save",
				arguments: { kind: "secret", content: "exfil" },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/kind/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_save when content is empty (minLength: 1)", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_save",
				arguments: { kind: "note", content: "" },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_recall with non-integer limit", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_recall",
				arguments: { query: "anything", limit: 3.5 },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/limit/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_recall when limit exceeds maximum: 50", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_recall",
				arguments: { query: "anything", limit: 999 },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_recall when query exceeds maxLength: 4096", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_recall",
				arguments: { query: "q".repeat(4097) },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/query/i);
			expect(callCount()).toBe(0);
		});

		it("rejects skill_search when query exceeds maxLength: 4096", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "skill_search",
				arguments: { query: "s".repeat(4097) },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/query/i);
			expect(callCount()).toBe(0);
		});

		it("rejects web_fetch with non-URL string", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "web_fetch",
				arguments: { url: "not a url" },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/url/i);
			expect(callCount()).toBe(0);
		});

		it("rejects web_fetch with non-http protocols", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			for (const url of [
				"ftp://example.com/archive.tar",
				"file:///etc/passwd",
				"mailto:agent@example.com",
			]) {
				const result = (await harness.client.callTool({
					name: "web_fetch",
					arguments: { url },
				})) as CallToolResult;

				expect(result.isError).toBe(true);
				const text = extractText(result);
				expect(text).toMatch(/invalid arguments/i);
				expect(text).toMatch(/http and https/i);
			}
			expect(callCount()).toBe(0);
		});

		it("rejects web_fetch URLs with userinfo before bridge dispatch", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "web_fetch",
				arguments: { url: "https://user:pass@example.com/data" },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/userinfo/i);
			expect(callCount()).toBe(0);
		});

		it("rejects web_fetch when URL exceeds maxLength: 2048", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "web_fetch",
				arguments: { url: `https://example.com/${"u".repeat(2049)}` },
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/url/i);
			expect(callCount()).toBe(0);
		});

		it("rejects memory_save with extra (additionalProperties: false)", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });

			const result = (await harness.client.callTool({
				name: "memory_save",
				arguments: {
					kind: "note",
					content: "valid",
					unexpected: "should-be-rejected",
				},
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(callCount()).toBe(0);
		});

		it("truncates and compacts validation errors for malicious extra keys", async () => {
			const { bridge, callCount } = makeCountingBridge();
			harness = await setupHarness({ toolBridge: bridge });
			const maliciousKey = `extra\n${"x".repeat(1_000)}`;

			const result = (await harness.client.callTool({
				name: "memory_save",
				arguments: {
					kind: "note",
					content: "valid",
					[maliciousKey]: "payload",
				},
			})) as CallToolResult;

			expect(result.isError).toBe(true);
			const text = extractText(result);
			expect(text).toMatch(/invalid arguments/i);
			expect(text).toMatch(/unrecognized key/i);
			expect(text).not.toContain("\n");
			expect(text).not.toContain("x".repeat(300));
			expect(text.length).toBeLessThan(360);
			expect(callCount()).toBe(0);
		});

		it("accepts memory_save with a valid 4096-char content (boundary)", async () => {
			// Positive control: exactly at the upper bound must pass so we
			// don't ship an off-by-one rejection.
			//
			// 阳性对照:正好等于上限必须通过,避免 off-by-one 误拒。
			const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
			const toolBridge: ToolBridge = {
				callTool: async (name, args) => {
					calls.push({ name, args: { ...args } });
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			harness = await setupHarness({ toolBridge });

			const exactMax = "y".repeat(4096);
			const result = (await harness.client.callTool({
				name: "memory_save",
				arguments: { kind: "fact", content: exactMax },
			})) as CallToolResult;

			expect(result.isError ?? false).toBe(false);
			expect(calls).toHaveLength(1);
			expect(calls[0].name).toBe("memory_save");
			expect((calls[0].args as { kind: string }).kind).toBe("fact");
			expect((calls[0].args as { content: string }).content.length).toBe(4096);
		});

		it("accepts memory_recall with limit at the upper boundary 50", async () => {
			const calls: Array<Record<string, unknown>> = [];
			const toolBridge: ToolBridge = {
				callTool: async (_name, args) => {
					calls.push({ ...args });
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			harness = await setupHarness({ toolBridge });

			const result = (await harness.client.callTool({
				name: "memory_recall",
				arguments: { query: "boundary", limit: 50 },
			})) as CallToolResult;

			expect(result.isError ?? false).toBe(false);
			expect(calls).toEqual([{ query: "boundary", limit: 50 }]);
		});

		it("accepts http and https web_fetch URLs", async () => {
			const calls: Array<Record<string, unknown>> = [];
			const toolBridge: ToolBridge = {
				callTool: async (_name, args) => {
					calls.push({ ...args });
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
			harness = await setupHarness({ toolBridge });

			for (const url of [
				"http://example.com/page",
				"https://example.com/page",
			]) {
				const result = (await harness.client.callTool({
					name: "web_fetch",
					arguments: { url },
				})) as CallToolResult;
				expect(result.isError ?? false).toBe(false);
			}

			expect(calls).toEqual([
				{ url: "http://example.com/page" },
				{ url: "https://example.com/page" },
			]);
		});
	});

	it("truncates long URI in UnknownResourceError message (SUSPECT-1 fix)", async () => {
		// Hostile peer sends a 500-char URI. Our error message must echo
		// at most ~80 chars + an ellipsis, so the peer cannot stuff
		// arbitrary payload into the JSON-RPC error reply (log injection
		// / noise amplification surface).
		//
		// 恶意 peer 发 500 字符 URI。错误消息最多回显 ~80 字符 + 省略号,
		// 阻止 peer 把任意 payload 塞进 JSON-RPC error reply (日志注入 /
		// 噪音放大风险)。
		harness = await setupHarness();
		const longUri = `bogus://${"A".repeat(500)}`;

		const error = await harness.client.readResource({ uri: longUri }).then(
			() => {
				throw new Error("expected rejection");
			},
			(err: unknown) => err as Error,
		);

		const message = String(error);
		// Echoed prefix must be present but the full 500-char tail must NOT.
		expect(message).toMatch(/not exposed/i);
		expect(message).toContain("…");
		expect(message).not.toContain("A".repeat(200));
		// Conservative upper bound: message length stays well below the
		// raw input length. (80 prefix + framing < 500.)
		expect(message.length).toBeLessThan(longUri.length);
	});

	it("compacts control characters in UnknownResourceError message", async () => {
		harness = await setupHarness();
		const csi = String.fromCharCode(0x9b);
		const nel = String.fromCharCode(0x85);
		const evilUri = `bogus://line-one\nline-two\r${csi}red${nel}${"B".repeat(200)}`;

		const error = await harness.client.readResource({ uri: evilUri }).then(
			() => {
				throw new Error("expected rejection");
			},
			(err: unknown) => err as Error,
		);

		const message = String(error);
		expect(message).toMatch(/not exposed/i);
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\r");
		expect(message).not.toContain(csi);
		expect(message).not.toContain(nel);
		expect(message).not.toContain("B".repeat(120));
	});
});
