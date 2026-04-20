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
			maxOutputTokens: 512,
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

	it("maps provider metadata cache usage when generic usage omits cache breakdown", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "hello from cache",
			usage: {
				promptTokens: 12,
				completionTokens: 34,
			},
			providerMetadata: {
				deepseek: {
					cacheReadTokens: 21,
					cacheWriteTokens: 8,
					cacheSource: "native",
				},
			},
			finishReason: "stop",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.7,
			maxTokens: 128,
			thinkingMode: "disabled",
		});

		expect(result.usage).toEqual({
			inputTokens: 12,
			outputTokens: 34,
			cache: {
				readTokens: 21,
				writeTokens: 8,
				source: "native",
			},
		});
	});

	it("adapts prompt breakpoints for Anthropic before calling generateText", async () => {
		const anthropicModel = {
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		} as LanguageModel;
		vi.mocked(generateText).mockResolvedValue({
			text: "cached",
			usage: {
				promptTokens: 6,
				completionTokens: 2,
			},
			finishReason: "stop",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(anthropicModel);

		await client.chat(
			[
				{ role: "system", content: "legacy combined system" },
				{ role: "user", content: "hi" },
			],
			[],
			{
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "disabled",
			},
			{
				segments: [
					{
						id: "identity",
						role: "system",
						text: "<!-- identity -->\nidentity",
						stability: "static",
						source: "prompt-section",
						cacheEligible: true,
					},
					{
						id: "tool-guidance",
						role: "system",
						text: "<!-- tool-guidance -->\ntools",
						stability: "per_session",
						source: "prompt-section",
						cacheEligible: true,
					},
				],
				recommendedBreakpoints: [{ segmentIndex: 1, reason: "system-tail" }],
				staticPrefix:
					"<!-- identity -->\nidentity\n\n<!-- tool-guidance -->\ntools",
				dynamicSuffix: "",
				sectionTokens: { identity: 4, "tool-guidance": 5 },
				totalTokens: 9,
			},
		);

		expect(generateText).toHaveBeenCalledWith({
			model: anthropicModel,
			messages: [
				{ role: "system", content: "<!-- identity -->\nidentity" },
				{
					role: "system",
					content: "<!-- tool-guidance -->\ntools",
					providerOptions: {
						anthropic: {
							cacheControl: { type: "ephemeral" },
						},
					},
				},
				{ role: "user", content: "hi" },
			],
			maxOutputTokens: 128,
			temperature: 0.1,
			topP: undefined,
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
			maxOutputTokens: 128,
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
			maxOutputTokens: 64,
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

	it("maps streamed provider metadata cache usage", async () => {
		vi.mocked(streamText).mockReturnValue({
			textStream: (async function* () {
				yield "hi";
			})(),
			usage: Promise.resolve({
				promptTokens: 5,
				completionTokens: 7,
			}),
			providerMetadata: Promise.resolve({
				deepseek: {
					cacheReadTokens: 11,
					cacheWriteTokens: 4,
					cacheSource: "native",
				},
			}),
			finishReason: Promise.resolve("stop"),
		} as ReturnType<typeof streamText>);

		const client = new StreamingLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(result.usage).toEqual({
			inputTokens: 5,
			outputTokens: 7,
			cache: {
				readTokens: 11,
				writeTokens: 4,
				source: "native",
			},
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
