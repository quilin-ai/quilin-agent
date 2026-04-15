import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLoggerRuntimeMode, logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";

vi.mock("./logger.js", () => ({
	getLoggerRuntimeMode: vi.fn(() => "service"),
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
	},
}));

describe("runAgentLoop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("在 service 模式下记录 loop debug 日志", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("service");

		const chat = vi.fn().mockResolvedValue({
			content: "assistant reply",
			usage: {
				inputTokens: 10,
				outputTokens: 20,
			},
			finishReason: "stop",
		});

		const result = await runAgentLoop(
			{
				llm: { chat },
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "hello" }],
		);

		expect(chat).toHaveBeenCalledWith(
			[{ role: "user", content: "hello" }],
			[],
			{
				temperature: 0.7,
				maxTokens: 1024,
				thinkingMode: "disabled",
			},
		);
		expect(result).toBe("assistant reply");
		expect(logger.debug).toHaveBeenCalledTimes(2);
	});

	it("在 repl 模式下不输出 loop debug 日志", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("repl");

		const chat = vi.fn().mockResolvedValue({
			content: "assistant reply",
			usage: {
				inputTokens: 10,
				outputTokens: 20,
			},
			finishReason: "stop",
		});

		const result = await runAgentLoop(
			{
				llm: { chat },
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "hello" }],
		);

		expect(result).toBe("assistant reply");
		expect(logger.debug).not.toHaveBeenCalled();
	});

	it("在提供 context manager 但没有 system message 时记录 warning", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("repl");

		const buildContext = vi.fn();
		const chat = vi.fn().mockResolvedValue({
			content: "assistant reply",
			usage: {
				inputTokens: 10,
				outputTokens: 20,
			},
			finishReason: "stop",
		});

		const result = await runAgentLoop(
			{
				llm: { chat },
				context: { buildContext },
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "hello" }],
		);

		expect(result).toBe("assistant reply");
		expect(buildContext).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			"ContextManager provided but no system message found — skipping context rebuild",
		);
	});

	it("在 tool_calls 场景下执行工具并把结果回灌给下一轮 LLM", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("service");

		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "我叫什么" },
					},
				],
				usage: {
					inputTokens: 10,
					outputTokens: 20,
				},
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "你叫小明。",
				usage: {
					inputTokens: 30,
					outputTokens: 40,
				},
				finishReason: "stop",
			});

		const execute = vi.fn().mockResolvedValue({
			toolCallId: "ignored-by-router",
			content: JSON.stringify({
				records: [{ id: "mem-1", content: "用户叫小明", tier: "short" }],
			}),
			isError: false,
		});

		const result = await runAgentLoop(
			{
				llm: { chat },
				tools: [
					{
						name: "memory_recall",
						description: "Recall memory",
						parameters: {
							safeParse: vi.fn().mockReturnValue({
								success: true,
								data: { query: "我叫什么" },
							}),
						} as never,
						execute,
					},
				],
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "我叫什么" }],
		);

		expect(result).toBe("你叫小明。");
		expect(chat).toHaveBeenCalledTimes(2);
		expect(chat).toHaveBeenNthCalledWith(
			2,
			[
				{ role: "user", content: "我叫什么" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							name: "memory_recall",
							arguments: { query: "我叫什么" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					name: "memory_recall",
					content: JSON.stringify({
						records: [{ id: "mem-1", content: "用户叫小明", tier: "short" }],
					}),
				},
			],
			[
				expect.objectContaining({
					name: "memory_recall",
				}),
			],
			{
				temperature: 0.7,
				maxTokens: 1024,
				thinkingMode: "disabled",
			},
		);
		expect(execute).toHaveBeenCalledWith({ query: "我叫什么" });
		expect(logger.debug).toHaveBeenCalledTimes(4);
	});

	it("在提供 context manager 时每轮调用前重建 system prompt", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("repl");

		const buildContext = vi
			.fn()
			.mockResolvedValueOnce("assembled system prompt v1")
			.mockResolvedValueOnce("assembled system prompt v2");
		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "我叫什么" },
					},
				],
				usage: {
					inputTokens: 10,
					outputTokens: 20,
				},
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "你叫小明。",
				usage: {
					inputTokens: 30,
					outputTokens: 40,
				},
				finishReason: "stop",
			});

		const execute = vi.fn().mockResolvedValue({
			toolCallId: "ignored-by-router",
			content: JSON.stringify({
				records: [{ id: "mem-1", content: "用户叫小明", tier: "short" }],
			}),
			isError: false,
		});

		await expect(
			runAgentLoop(
				{
					llm: { chat },
					context: { buildContext },
					tools: [
						{
							name: "memory_recall",
							description: "Recall memory",
							parameters: {
								safeParse: vi.fn().mockReturnValue({
									success: true,
									data: { query: "我叫什么" },
								}),
							} as never,
							execute,
						},
					],
					inferenceConfig: {
						temperature: 0.7,
						maxTokens: 1024,
						thinkingMode: "disabled",
					},
				},
				[
					{ role: "system", content: "base system prompt" },
					{ role: "user", content: "我叫什么" },
				],
			),
		).resolves.toBe("你叫小明。");

		expect(buildContext).toHaveBeenCalledTimes(2);
		expect(buildContext).toHaveBeenNthCalledWith(
			1,
			[
				expect.objectContaining({
					type: "system",
					content: "base system prompt",
					priority: 100,
				}),
			],
			expect.objectContaining({
				total: expect.any(Number),
			}),
		);
		expect(chat).toHaveBeenNthCalledWith(
			1,
			[
				{ role: "system", content: "assembled system prompt v1" },
				{ role: "user", content: "我叫什么" },
			],
			expect.any(Array),
			expect.any(Object),
		);
		expect(chat).toHaveBeenNthCalledWith(
			2,
			[
				{ role: "system", content: "assembled system prompt v2" },
				{ role: "user", content: "我叫什么" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							name: "memory_recall",
							arguments: { query: "我叫什么" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					name: "memory_recall",
					content: JSON.stringify({
						records: [{ id: "mem-1", content: "用户叫小明", tier: "short" }],
					}),
				},
			],
			expect.any(Array),
			expect.any(Object),
		);
	});

	it("在达到 maxTurns 上限后终止 tool loop", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("repl");

		const chat = vi.fn().mockResolvedValue({
			content: "",
			toolCalls: [
				{
					id: "call-1",
					name: "memory_recall",
					arguments: { query: "我叫什么" },
				},
			],
			usage: {
				inputTokens: 10,
				outputTokens: 20,
			},
			finishReason: "tool_calls",
		});

		const execute = vi.fn();

		await expect(
			runAgentLoop(
				{
					llm: { chat },
					tools: [
						{
							name: "memory_recall",
							description: "Recall memory",
							parameters: {
								safeParse: vi.fn().mockReturnValue({
									success: true,
									data: { query: "我叫什么" },
								}),
							} as never,
							execute,
						},
					],
					maxTurns: 1,
					inferenceConfig: {
						temperature: 0.7,
						maxTokens: 1024,
						thinkingMode: "disabled",
					},
				},
				[{ role: "user", content: "我叫什么" }],
			),
		).rejects.toThrow(/maxTurns/i);

		expect(chat).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
	});

	it("在工具返回错误内容时仍按 tool message 回灌给下一轮 LLM", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("repl");

		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "我叫什么" },
					},
				],
				usage: {
					inputTokens: 10,
					outputTokens: 20,
				},
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "我没找到相关记忆。",
				usage: {
					inputTokens: 30,
					outputTokens: 40,
				},
				finishReason: "stop",
			});

		const execute = vi.fn().mockResolvedValue({
			toolCallId: "ignored-by-router",
			content: JSON.stringify({ error: "memory not found" }),
			isError: true,
		});

		const result = await runAgentLoop(
			{
				llm: { chat },
				tools: [
					{
						name: "memory_recall",
						description: "Recall memory",
						parameters: {
							safeParse: vi.fn().mockReturnValue({
								success: true,
								data: { query: "我叫什么" },
							}),
						} as never,
						execute,
					},
				],
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "我叫什么" }],
		);

		expect(result).toBe("我没找到相关记忆。");
		expect(chat).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([
				expect.objectContaining({
					role: "tool",
					toolCallId: "call-1",
					name: "memory_recall",
					content: JSON.stringify({ error: "memory not found" }),
				}),
			]),
			expect.any(Array),
			expect.any(Object),
		);
	});

	it("支持多轮连续 tool_calls 直到拿到最终回复", async () => {
		vi.mocked(getLoggerRuntimeMode).mockReturnValue("repl");

		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "我叫什么" },
					},
				],
				usage: {
					inputTokens: 10,
					outputTokens: 20,
				},
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-2",
						name: "memory_store",
						arguments: { content: "用户叫小明", tier: "short" },
					},
				],
				usage: {
					inputTokens: 30,
					outputTokens: 40,
				},
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "我已经记住你叫小明。",
				usage: {
					inputTokens: 50,
					outputTokens: 60,
				},
				finishReason: "stop",
			});

		const recallExecute = vi.fn().mockResolvedValue({
			toolCallId: "ignored-1",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});
		const storeExecute = vi.fn().mockResolvedValue({
			toolCallId: "ignored-2",
			content: JSON.stringify({ id: "mem-1" }),
			isError: false,
		});

		const result = await runAgentLoop(
			{
				llm: { chat },
				tools: [
					{
						name: "memory_recall",
						description: "Recall memory",
						parameters: {
							safeParse: vi.fn().mockReturnValue({
								success: true,
								data: { query: "我叫什么" },
							}),
						} as never,
						execute: recallExecute,
					},
					{
						name: "memory_store",
						description: "Store memory",
						parameters: {
							safeParse: vi.fn().mockReturnValue({
								success: true,
								data: { content: "用户叫小明", tier: "short" },
							}),
						} as never,
						execute: storeExecute,
					},
				],
				maxTurns: 3,
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "记住我叫小明，然后告诉我你记住了" }],
		);

		expect(result).toBe("我已经记住你叫小明。");
		expect(chat).toHaveBeenCalledTimes(3);
		expect(recallExecute).toHaveBeenCalledTimes(1);
		expect(storeExecute).toHaveBeenCalledTimes(1);
		expect(chat.mock.calls[2]?.[0]).toEqual([
			{ role: "user", content: "记住我叫小明，然后告诉我你记住了" },
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "我叫什么" },
					},
				],
			},
			{
				role: "tool",
				toolCallId: "call-1",
				name: "memory_recall",
				content: JSON.stringify({ records: [] }),
			},
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{
						id: "call-2",
						name: "memory_store",
						arguments: { content: "用户叫小明", tier: "short" },
					},
				],
			},
			{
				role: "tool",
				toolCallId: "call-2",
				name: "memory_store",
				content: JSON.stringify({ id: "mem-1" }),
			},
		]);
	});
});
