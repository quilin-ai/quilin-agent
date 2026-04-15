import type { LanguageModel } from "ai";
import { generateText, tool as sdkTool, streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { StreamingLLMClient, VercelLLMClient } from "./client.js";

vi.mock("ai", () => ({
	generateText: vi.fn(),
	streamText: vi.fn(),
	tool: vi.fn((definition) => definition),
}));

describe("VercelLLMClient", () => {
	const model = {} as LanguageModel;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("maps messages and usage through generateText", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "hello from model",
			usage: {
				promptTokens: 12,
				completionTokens: 34,
			},
			finishReason: "stop",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		const memoryRecallTool = {
			name: "memory_recall",
			description: "Recall memory",
			parameters: z.object({ query: z.string() }),
			execute: vi.fn(),
		};

		const result = await client.chat(
			[
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[memoryRecallTool],
			{
				temperature: 0.7,
				maxTokens: 512,
				thinkingMode: "disabled",
				topP: 0.9,
			},
		);

		expect(generateText).toHaveBeenCalledWith({
			model,
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			tools: {
				memory_recall: {
					description: "Recall memory",
					inputSchema: memoryRecallTool.parameters,
				},
			},
			maxTokens: 512,
			temperature: 0.7,
			topP: 0.9,
		});
		expect(sdkTool).toHaveBeenCalledWith({
			description: "Recall memory",
			inputSchema: memoryRecallTool.parameters,
		});
		expect(result).toEqual({
			content: "hello from model",
			usage: {
				inputTokens: 12,
				outputTokens: 34,
			},
			finishReason: "stop",
		});
	});

	it("maps non-stop finish reasons to length", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "truncated",
			usage: {
				promptTokens: 1,
				completionTokens: 2,
			},
			finishReason: "length",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.7,
			maxTokens: 128,
			thinkingMode: "disabled",
		});

		expect(result.finishReason).toBe("length");
	});

	it("maps tool calls from generateText", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "",
			usage: {
				promptTokens: 1,
				completionTokens: 2,
			},
			finishReason: "tool-calls",
			toolCalls: [
				{
					toolCallId: "call-1",
					toolName: "memory_recall",
					input: { query: "小明" },
				},
			],
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		const result = await client.chat(
			[{ role: "user", content: "我叫什么" }],
			[],
			{
				temperature: 0.7,
				maxTokens: 128,
				thinkingMode: "disabled",
			},
		);

		expect(result).toEqual({
			content: "",
			toolCalls: [
				{
					id: "call-1",
					name: "memory_recall",
					arguments: { query: "小明" },
				},
			],
			usage: {
				inputTokens: 1,
				outputTokens: 2,
			},
			finishReason: "tool_calls",
		});
	});

	it("maps assistant tool calls and tool results back into AI SDK messages", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "你叫小明。",
			usage: {
				promptTokens: 8,
				completionTokens: 9,
			},
			finishReason: "stop",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		await client.chat(
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
			[],
			{
				temperature: 0.7,
				maxTokens: 128,
				thinkingMode: "disabled",
			},
		);

		expect(generateText).toHaveBeenCalledWith({
			model,
			messages: [
				{ role: "user", content: "我叫什么" },
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName: "memory_recall",
							input: { query: "我叫什么" },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call-1",
							toolName: "memory_recall",
							output: {
								type: "json",
								value: {
									records: [
										{ id: "mem-1", content: "用户叫小明", tier: "short" },
									],
								},
							},
						},
					],
				},
			],
			maxTokens: 128,
			temperature: 0.7,
			topP: undefined,
		});
	});
});

describe("StreamingLLMClient", () => {
	const model = {} as LanguageModel;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("streams chunks and returns the accumulated response", async () => {
		const chunks = ["hel", "lo"];
		const onChunk = vi.fn();

		vi.mocked(streamText).mockReturnValue({
			textStream: (async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			})(),
			usage: Promise.resolve({
				promptTokens: 5,
				completionTokens: 7,
			}),
			finishReason: Promise.resolve("stop"),
		} as ReturnType<typeof streamText>);

		const client = new StreamingLLMClient(model, onChunk);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(streamText).toHaveBeenCalledWith({
			model,
			messages: [{ role: "user", content: "hi" }],
			maxTokens: 64,
			temperature: 0.2,
			topP: undefined,
		});
		expect(onChunk).toHaveBeenCalledTimes(2);
		expect(onChunk).toHaveBeenNthCalledWith(1, "hel");
		expect(onChunk).toHaveBeenNthCalledWith(2, "lo");
		expect(result).toEqual({
			content: "hello",
			usage: {
				inputTokens: 5,
				outputTokens: 7,
			},
			finishReason: "stop",
		});
	});

	it("maps tool calls from streamText", async () => {
		vi.mocked(streamText).mockReturnValue({
			textStream: (async function* () {})(),
			usage: Promise.resolve({
				promptTokens: 3,
				completionTokens: 4,
			}),
			finishReason: Promise.resolve("tool-calls"),
			toolCalls: Promise.resolve([
				{
					toolCallId: "call-2",
					toolName: "memory_store",
					input: { content: "我叫小明", tier: "short" },
				},
			]),
		} as ReturnType<typeof streamText>);

		const client = new StreamingLLMClient(model);

		const result = await client.chat(
			[{ role: "user", content: "记住我叫小明" }],
			[],
			{
				temperature: 0.2,
				maxTokens: 64,
				thinkingMode: "disabled",
			},
		);

		expect(result).toEqual({
			content: "",
			toolCalls: [
				{
					id: "call-2",
					name: "memory_store",
					arguments: { content: "我叫小明", tier: "short" },
				},
			],
			usage: {
				inputTokens: 3,
				outputTokens: 4,
			},
			finishReason: "tool_calls",
		});
	});
});
