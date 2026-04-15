import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../loop.js";
import { MCPClientManager } from "./mcp-client.js";

function getMemoryServerCwd() {
	return fileURLToPath(
		new URL("../../../../providers/memory/", import.meta.url),
	);
}

function createMemoryServerConfig() {
	return {
		command: "uv",
		args: ["run", "python", "-m", "omnimem"],
		cwd: getMemoryServerCwd(),
	};
}

describe.sequential("MCPClientManager", () => {
	it("connects to OmniMem and maps MCP tools into local Tool definitions", async () => {
		const manager = new MCPClientManager();

		try {
			const tools = await manager.connect(createMemoryServerConfig());
			const toolNames = tools.map((tool) => tool.name).sort();
			const memoryRecall = tools.find((tool) => tool.name === "memory_recall");
			const memoryStore = tools.find((tool) => tool.name === "memory_store");

			expect(toolNames).toEqual(["memory_recall", "memory_store"]);
			expect(
				memoryRecall?.parameters.safeParse({ query: "hello" }).success,
			).toBe(true);
			expect(memoryRecall?.parameters.safeParse({}).success).toBe(false);
			expect(
				memoryStore?.parameters.safeParse({ content: "hello", tier: "short" })
					.success,
			).toBe(true);
			expect(memoryStore?.parameters.safeParse({ tier: "short" }).success).toBe(
				false,
			);

			const storeResult = await memoryStore?.execute({
				content: "my name is 小明",
				tier: "short",
			});
			const recallResult = await memoryRecall?.execute({ query: "小明" });

			expect(storeResult?.isError).toBe(false);
			expect(JSON.parse(storeResult?.content ?? "{}")).toEqual({
				id: expect.any(String),
			});
			expect(recallResult?.isError).toBe(false);
			expect(JSON.parse(recallResult?.content ?? "{}")).toEqual({
				records: [
					expect.objectContaining({
						content: "my name is 小明",
						tier: "short",
					}),
				],
			});
		} finally {
			await manager.disconnect();
		}
	});

	it("returns error json after disconnect instead of throwing", async () => {
		const manager = new MCPClientManager();

		await manager.connect(createMemoryServerConfig());
		await manager.disconnect();

		const result = await manager.callTool("memory_recall", { query: "hello" });

		expect(JSON.parse(result)).toEqual({
			error: expect.stringContaining("disconnected"),
		});
	});

	it("runs a thin e2e loop with fake LLM and real OmniMem bridge", async () => {
		const manager = new MCPClientManager();

		try {
			const tools = await manager.connect(createMemoryServerConfig());
			const chatCalls: unknown[][] = [];
			const chat = async (...args: unknown[]) => {
				chatCalls.push(args);

				switch (chatCalls.length) {
					case 1:
						return {
							content: "",
							toolCalls: [
								{
									id: "call-1",
									name: "memory_store",
									arguments: { content: "用户叫小明", tier: "short" },
								},
							],
							usage: { inputTokens: 1, outputTokens: 1 },
							finishReason: "tool_calls" as const,
						};
					case 2:
						return {
							content: "",
							toolCalls: [
								{
									id: "call-2",
									name: "memory_recall",
									arguments: { query: "小明" },
								},
							],
							usage: { inputTokens: 1, outputTokens: 1 },
							finishReason: "tool_calls" as const,
						};
					default:
						return {
							content: "你叫小明。",
							usage: { inputTokens: 1, outputTokens: 1 },
							finishReason: "stop" as const,
						};
				}
			};

			const result = await runAgentLoop(
				{
					llm: { chat },
					tools,
					maxTurns: 4,
					inferenceConfig: {
						temperature: 0.7,
						maxTokens: 1024,
						thinkingMode: "disabled",
					},
				},
				[{ role: "user", content: "记住我叫小明，然后告诉我我叫什么" }],
			);

			expect(result).toBe("你叫小明。");
			expect(chatCalls).toHaveLength(3);

			const finalTurnMessages = chatCalls[2]?.[0] as
				| {
						role: string;
						content: string;
						toolCallId?: string;
						name?: string;
						toolCalls?: readonly {
							id: string;
							name: string;
							arguments: Record<string, unknown>;
						}[];
				  }[]
				| undefined;

			expect(finalTurnMessages).toEqual([
				{ role: "user", content: "记住我叫小明，然后告诉我我叫什么" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							name: "memory_store",
							arguments: { content: "用户叫小明", tier: "short" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					name: "memory_store",
					content: expect.any(String),
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-2",
							name: "memory_recall",
							arguments: { query: "小明" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-2",
					name: "memory_recall",
					content: expect.any(String),
				},
			]);

			const recallToolMessage = finalTurnMessages?.[4];
			expect(JSON.parse(recallToolMessage?.content ?? "{}")).toEqual({
				records: [
					expect.objectContaining({
						content: "用户叫小明",
						tier: "short",
					}),
				],
			});
		} finally {
			await manager.disconnect();
		}
	});
});
