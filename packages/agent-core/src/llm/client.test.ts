import type { LanguageModel } from "ai";
import { generateText, tool as sdkTool, streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createMockLanguageModel,
	mockGenerateTextResult,
	mockStreamTextResult,
} from "../test/ai-fixtures.js";
import {
	__test__ as clientTestHelpers,
	ProviderControlPlaneLLMClient,
	StreamingLLMClient,
	VercelLLMClient,
} from "./client.js";
import type { LLMClient, LLMTierRoutingConfig } from "./types.js";

vi.mock("ai", () => ({
	generateText: vi.fn(),
	streamText: vi.fn(),
	tool: vi.fn((definition) => definition),
}));

describe("VercelLLMClient", () => {
	const model = createMockLanguageModel();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
	});

	it("maps messages and usage through generateText", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "hello from model",
				usage: {
					promptTokens: 12,
					completionTokens: 34,
				},
				finishReason: "stop",
			}),
		);

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
			allowSystemInMessages: true,
			tools: {
				memory_recall: {
					description: "Recall memory",
					inputSchema: memoryRecallTool.parameters,
				},
			},
			maxOutputTokens: 512,
			temperature: 0.7,
			topP: 0.9,
			maxRetries: 0,
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
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
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
			}),
		);

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
		const anthropicModel = createMockLanguageModel({
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "cached",
				usage: {
					promptTokens: 6,
					completionTokens: 2,
				},
				finishReason: "stop",
			}),
		);

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
			allowSystemInMessages: true,
			maxOutputTokens: 128,
			temperature: 0.1,
			topP: undefined,
			maxRetries: 0,
		});
	});

	it("switches DeepSeek to deepseek-reasoner when thinking is enabled", async () => {
		const deepseekChatModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});
		const deepseekReasonerModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-reasoner",
		});
		const resolveModel = vi.fn((modelId: string) =>
			modelId === "deepseek-reasoner"
				? deepseekReasonerModel
				: deepseekChatModel,
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "reasoned",
				usage: {
					promptTokens: 9,
					completionTokens: 3,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient({
			model: deepseekChatModel,
			resolveModel,
		});

		await client.chat([{ role: "user", content: "solve it" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "enabled",
		});

		expect(resolveModel).toHaveBeenCalledWith("deepseek-reasoner");
		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: deepseekReasonerModel,
			}),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("deepseek-reasoner"),
		);
	});

	it("keeps deepseek-v4-pro as the effective model when thinking is enabled", async () => {
		const deepseekV4ProModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
		});
		const resolveModel = vi.fn(() => deepseekV4ProModel);
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "reasoned",
				usage: {
					promptTokens: 9,
					completionTokens: 3,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient({
			model: deepseekV4ProModel,
			resolveModel,
		});

		await client.chat([{ role: "user", content: "solve it" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "enabled",
		});

		expect(resolveModel).not.toHaveBeenCalledWith("deepseek-reasoner");
		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: deepseekV4ProModel,
				providerOptions: {
					deepseek: {
						thinking: { type: "enabled" },
						reasoningEffort: "high",
					},
				},
			}),
		);
	});

	it("warns once when DeepSeek thinking upgrades the effective model", async () => {
		const deepseekChatModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});
		const deepseekReasonerModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-reasoner",
		});
		const resolveModel = vi.fn((modelId: string) =>
			modelId === "deepseek-reasoner"
				? deepseekReasonerModel
				: deepseekChatModel,
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "reasoned",
				usage: {
					promptTokens: 9,
					completionTokens: 3,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient({
			model: deepseekChatModel,
			resolveModel,
		});

		await client.chat([{ role: "user", content: "first" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "enabled",
		});
		await client.chat([{ role: "user", content: "second" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "enabled",
		});

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("deepseek-reasoner"),
		);
	});

	it("enables Anthropic thinking when thinking mode is enabled", async () => {
		const anthropicModel = createMockLanguageModel({
			provider: "anthropic",
			modelId: "claude-3-7-sonnet-latest",
		});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "thinking",
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(anthropicModel);

		await client.chat([{ role: "user", content: "analyze" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "enabled",
			thinkingBudget: 2048,
		});

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: anthropicModel,
				providerOptions: {
					anthropic: {
						thinking: {
							type: "enabled",
							budgetTokens: 2048,
						},
					},
				},
			}),
		);
	});

	it("extracts ordered reasoning parts from generateText for non-stream calls", async () => {
		const anthropicModel = createMockLanguageModel({
			provider: "anthropic",
			modelId: "claude-3-7-sonnet-latest",
		});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "final answer",
				reasoning: [
					{
						type: "reasoning",
						text: "step one",
						providerMetadata: {
							anthropic: {
								signature: "sig-1",
							},
						},
					},
					{
						type: "reasoning",
						text: "step two",
						providerMetadata: {
							anthropic: {
								signature: "sig-2",
							},
						},
					},
				],
				reasoningText: "step onestep two",
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(anthropicModel);

		const result = await client.chat(
			[{ role: "user", content: "analyze" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 256,
				thinkingMode: "enabled",
			},
		);

		expect(result).toEqual({
			content: "final answer",
			thinking: [
				{ provider: "anthropic", text: "step one", signature: "sig-1" },
				{ provider: "anthropic", text: "step two", signature: "sig-2" },
			],
			usage: {
				inputTokens: 7,
				outputTokens: 5,
			},
			finishReason: "stop",
		});
	});

	it("drops Anthropic reasoning blocks without signatures", async () => {
		const anthropicModel = createMockLanguageModel({
			provider: "anthropic",
			modelId: "claude-3-7-sonnet-latest",
		});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "final answer",
				reasoning: [
					{
						type: "reasoning",
						text: "unsigned block",
					},
				],
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(anthropicModel);

		const result = await client.chat(
			[{ role: "user", content: "analyze" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 256,
				thinkingMode: "enabled",
			},
		);

		expect(result).toEqual({
			content: "final answer",
			usage: {
				inputTokens: 7,
				outputTokens: 5,
			},
			finishReason: "stop",
		});
	});

	it("falls back to openai-chat reasoning when Responses metadata is incomplete", async () => {
		const openaiModel = createMockLanguageModel({
			provider: "openai",
			modelId: "o4-mini",
		});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "final answer",
				reasoning: [
					{
						type: "reasoning",
						text: "summary block",
						providerMetadata: {
							openai: {
								itemId: "item-1",
							},
						},
					},
				],
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(openaiModel);

		const result = await client.chat(
			[{ role: "user", content: "analyze" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 256,
				thinkingMode: "enabled",
			},
		);

		expect(result).toEqual({
			content: "final answer",
			thinking: [{ provider: "openai-chat", text: "summary block" }],
			usage: {
				inputTokens: 7,
				outputTokens: 5,
			},
			finishReason: "stop",
		});
	});

	it("maps OpenAI auto thinking mode to medium reasoning effort", async () => {
		const openaiModel = createMockLanguageModel({
			provider: "openai",
			modelId: "o4-mini",
		});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "reasoned",
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(openaiModel);

		await client.chat([{ role: "user", content: "analyze" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "auto",
		});

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: openaiModel,
				providerOptions: {
					openai: {
						reasoningEffort: "medium",
					},
				},
			}),
		);
	});

	it("warns when OpenAI thinkingBudget cannot be mapped precisely", async () => {
		const openaiModel = createMockLanguageModel({
			provider: "openai",
			modelId: "o4-mini",
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "reasoned",
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(openaiModel);

		await client.chat([{ role: "user", content: "analyze" }], [], {
			temperature: 0.1,
			maxTokens: 256,
			thinkingMode: "enabled",
			thinkingBudget: 2048,
		});

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("thinkingBudget"),
		);
	});

	it("maps non-stop finish reasons to length", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "truncated",
				usage: {
					promptTokens: 1,
					completionTokens: 2,
				},
				finishReason: "length",
			}),
		);

		const client = new VercelLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.7,
			maxTokens: 128,
			thinkingMode: "disabled",
		});

		expect(result.finishReason).toBe("length");
	});

	it("maps tool calls from generateText", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
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
			}),
		);

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

	it("sanitizes namespaced MCP tool names before generateText and restores returned calls", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "",
				usage: {
					promptTokens: 1,
					completionTokens: 2,
				},
				finishReason: "tool-calls",
				toolCalls: [
					{
						toolCallId: "call-1",
						toolName: "quilin-mem_memory_recall",
						input: { query: "我是谁" },
					},
				],
			}),
		);

		const client = new VercelLLMClient(model);
		const namespacedTool = {
			name: "quilin-mem/memory_recall",
			description: "Recall memory",
			parameters: z.object({ query: z.string() }),
			execute: vi.fn(),
		};

		const result = await client.chat(
			[{ role: "user", content: "我是谁" }],
			[namespacedTool],
			{
				temperature: 0.7,
				maxTokens: 128,
				thinkingMode: "disabled",
			},
		);

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: {
					"quilin-mem_memory_recall": {
						description: "Recall memory",
						inputSchema: namespacedTool.parameters,
					},
				},
			}),
		);
		expect(result.toolCalls).toEqual([
			{
				id: "call-1",
				name: "quilin-mem/memory_recall",
				arguments: { query: "我是谁" },
			},
		]);
	});

	it("maps assistant tool calls and tool results back into AI SDK messages", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "你叫小明。",
				usage: {
					promptTokens: 8,
					completionTokens: 9,
				},
				finishReason: "stop",
			}),
		);

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
						records: [{ id: "mem-1", content: "用户叫小明", tier: "working" }],
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
										{ id: "mem-1", content: "用户叫小明", tier: "working" },
									],
								},
							},
						},
					],
				},
			],
			allowSystemInMessages: true,
			tools: undefined,
			maxOutputTokens: 128,
			temperature: 0.7,
			topP: undefined,
			maxRetries: 0,
		});
	});

	it("sanitizes namespaced MCP tool names in assistant/tool history", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "我是麒麟。",
				usage: {
					promptTokens: 8,
					completionTokens: 9,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(model);
		const namespacedTool = {
			name: "quilin-mem/memory_recall",
			description: "Recall memory",
			parameters: z.object({ query: z.string() }),
			execute: vi.fn(),
		};

		await client.chat(
			[
				{ role: "user", content: "你是谁" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							name: "quilin-mem/memory_recall",
							arguments: { query: "identity" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					name: "quilin-mem/memory_recall",
					content: JSON.stringify({
						records: [{ id: "mem-1", content: "我是麒麟" }],
					}),
				},
			],
			[namespacedTool],
			{
				temperature: 0.7,
				maxTokens: 128,
				thinkingMode: "disabled",
			},
		);

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: "user", content: "你是谁" },
					{
						role: "assistant",
						content: [
							{
								type: "tool-call",
								toolCallId: "call-1",
								toolName: "quilin-mem_memory_recall",
								input: { query: "identity" },
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								type: "tool-result",
								toolCallId: "call-1",
								toolName: "quilin-mem_memory_recall",
								output: {
									type: "json",
									value: {
										records: [{ id: "mem-1", content: "我是麒麟" }],
									},
								},
							},
						],
					},
				],
				tools: {
					"quilin-mem_memory_recall": {
						description: "Recall memory",
						inputSchema: namespacedTool.parameters,
					},
				},
			}),
		);
	});

	it("sanitizes namespaced MCP tool history without requiring the current tools list", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "工具结果已读取。",
				usage: {
					promptTokens: 8,
					completionTokens: 9,
				},
				finishReason: "stop",
			}),
		);

		const client = new VercelLLMClient(model);

		await client.chat(
			[
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							name: "quilin-mem/memory_recall",
							arguments: { query: "identity" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					name: "quilin-mem/memory_recall",
					content: JSON.stringify({ records: [] }),
				},
				{ role: "user", content: "继续" },
			],
			[],
			{
				temperature: 0.7,
				maxTokens: 128,
				thinkingMode: "disabled",
			},
		);

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool-call",
								toolCallId: "call-1",
								toolName: "quilin-mem_memory_recall",
								input: { query: "identity" },
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								type: "tool-result",
								toolCallId: "call-1",
								toolName: "quilin-mem_memory_recall",
								output: { type: "json", value: { records: [] } },
							},
						],
					},
					{ role: "user", content: "继续" },
				],
			}),
		);
	});

	it("maps error finishes and non-object tool call inputs", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "",
				usage: {
					promptTokens: 1,
					completionTokens: 2,
				},
				finishReason: "error",
				toolCalls: [
					{
						toolCallId: "call-raw",
						toolName: "memory_recall",
						input: "raw-json",
					},
					{
						toolCallId: "call-null",
						toolName: "memory_store",
						input: null,
					},
				],
			}),
		);

		const client = new VercelLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.7,
			maxTokens: 128,
			thinkingMode: "disabled",
		});

		expect(result).toEqual({
			content: "",
			toolCalls: [
				{ id: "call-raw", name: "memory_recall", arguments: {} },
				{ id: "call-null", name: "memory_store", arguments: {} },
			],
			usage: {
				inputTokens: 1,
				outputTokens: 2,
			},
			finishReason: "error",
		});
	});

	it("maps OpenAI Responses reasoning and ignores unknown provider reasoning", async () => {
		const openaiModel = createMockLanguageModel({
			provider: "openai",
			modelId: "o4-mini",
		});
		vi.mocked(generateText).mockResolvedValueOnce(
			mockGenerateTextResult({
				text: "final answer",
				reasoning: [
					{
						type: "reasoning",
						text: "",
						providerMetadata: {
							openai: {
								itemId: "rs-1",
								reasoningEncryptedContent: "cipher-1",
							},
						},
					},
					{
						type: "reasoning",
						text: "visible summary",
						providerMetadata: {
							openai: {
								itemId: "rs-2",
								reasoningEncryptedContent: "cipher-2",
							},
						},
					},
				],
				usage: {
					promptTokens: 7,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);
		vi.mocked(generateText).mockResolvedValueOnce(
			mockGenerateTextResult({
				text: "plain answer",
				reasoning: [
					{
						type: "reasoning",
						text: "provider-specific private trace",
					},
				],
				usage: {
					promptTokens: 3,
					completionTokens: 4,
				},
				finishReason: "stop",
			}),
		);

		const openaiResult = await new VercelLLMClient(openaiModel).chat(
			[{ role: "user", content: "analyze" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 256,
				thinkingMode: "enabled",
			},
		);
		const unknownProviderResult = await new VercelLLMClient(model).chat(
			[{ role: "user", content: "analyze" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 256,
				thinkingMode: "enabled",
			},
		);

		expect(openaiResult.thinking).toEqual([
			{
				provider: "openai-responses",
				itemId: "rs-1",
				encryptedContent: "cipher-1",
			},
			{
				provider: "openai-responses",
				itemId: "rs-2",
				encryptedContent: "cipher-2",
				text: "visible summary",
			},
		]);
		expect(unknownProviderResult.thinking).toBeUndefined();
	});

	it("handles sparse model metadata and DeepSeek no-op upgrades", async () => {
		const sparseModel = createMockLanguageModel({
			provider: 42,
			modelId: null,
		});
		const callableModel = vi.fn() as unknown as LanguageModel;
		const deepseekChatModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});
		const resolveModel = vi.fn(() => deepseekChatModel);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "ok",
				usage: {
					promptTokens: 1,
					completionTokens: 1,
				},
				finishReason: "stop",
			}),
		);

		await new VercelLLMClient(sparseModel).chat(
			[{ role: "user", content: "sparse" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 64,
				thinkingMode: "enabled",
			},
		);
		await new VercelLLMClient(callableModel).chat(
			[{ role: "user", content: "callable" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 64,
				thinkingMode: "disabled",
			},
		);
		await new VercelLLMClient({
			model: deepseekChatModel,
			resolveModel,
		}).chat([{ role: "user", content: "same model" }], [], {
			temperature: 0.1,
			maxTokens: 64,
			thinkingMode: "enabled",
		});

		expect(generateText).toHaveBeenNthCalledWith(
			1,
			expect.not.objectContaining({ providerOptions: expect.anything() }),
		);
		expect(generateText).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ model: callableModel }),
		);
		expect(resolveModel).toHaveBeenCalledWith("deepseek-reasoner");
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe("ProviderControlPlaneLLMClient", () => {
	beforeEach(() => {
		vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
	});

	const config = {
		temperature: 0.1,
		maxTokens: 128,
		thinkingMode: "enabled" as const,
		thinkingBudget: 2048,
	};

	const tierRouting = {
		mode: "auto",
		defaultTier: "lite",
		allowEscalation: true,
		tiers: {
			flash: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
				thinkingMode: "disabled",
				temperature: 0.2,
				maxTokens: 64,
			},
			lite: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
				thinkingMode: "auto",
				maxTokens: 256,
			},
			pro: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
				thinkingMode: "enabled",
				maxTokens: 1024,
				thinkingBudget: 6000,
			},
		},
	} satisfies LLMTierRoutingConfig;

	it("records one successful provider attempt with selected provider, model, usage, and cache", async () => {
		const records: unknown[] = [];
		const response = {
			content: "ok",
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				cache: {
					readTokens: 3,
					writeTokens: 7,
					source: "native" as const,
				},
			},
			finishReason: "stop" as const,
			thinking: [{ provider: "deepseek" as const, text: "trace" }],
		};
		const routedDelegate = {
			chat: vi.fn().mockResolvedValue(response),
		} satisfies LLMClient;
		const delegate = {
			chat: vi.fn(),
			withModel: vi.fn().mockReturnValue(routedDelegate),
		} satisfies LLMClient & { withModel(modelId: string): LLMClient };
		const dates = [
			new Date("2026-05-01T00:00:00.000Z"),
			new Date("2026-05-01T00:00:01.000Z"),
		];
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-chat",
			},
			onRunRecord: (record) => records.push(record),
			now: () => dates.shift() ?? new Date("2026-05-01T00:00:02.000Z"),
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], config),
		).resolves.toBe(response);

		expect(delegate.withModel).toHaveBeenCalledWith("deepseek-reasoner");
		expect(delegate.chat).not.toHaveBeenCalled();
		expect(routedDelegate.chat).toHaveBeenCalledTimes(1);
		expect(client.runRecords).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(client.runRecords[0]).toEqual({
			route: {
				provider: "deepseek",
				configuredModel: "deepseek-chat",
				effectiveModel: "deepseek-reasoner",
				fallbackUsed: false,
				reasoningStateAdapter: "captured_replayed_for_tool_calls",
				budget: {
					maxTokens: 128,
					thinkingBudget: 2048,
				},
			},
			attempts: [
				{
					attemptNumber: 1,
					provider: "deepseek",
					model: "deepseek-reasoner",
					startedAt: "2026-05-01T00:00:00.000Z",
					completedAt: "2026-05-01T00:00:01.000Z",
					outcome: "success",
					usage: response.usage,
				},
			],
			outcome: "success",
			fallbackUsed: false,
		});
	});

	it("does not let provider run observers change successful or failed model outcomes", async () => {
		const successResponse = {
			content: "ok",
			usage: { inputTokens: 1, outputTokens: 2 },
			finishReason: "stop" as const,
		};
		const successRoutedDelegate = {
			chat: vi.fn().mockResolvedValue(successResponse),
		} satisfies LLMClient;
		const successDelegate = {
			chat: vi.fn(),
			withModel: vi.fn().mockReturnValue(successRoutedDelegate),
		} satisfies LLMClient & { withModel(modelId: string): LLMClient };
		const observer = vi.fn(() => {
			throw new Error("observer should not affect model result");
		});
		const successClient = new ProviderControlPlaneLLMClient(successDelegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-chat",
			},
			onRunRecord: observer,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		await expect(
			successClient.chat([{ role: "user", content: "hi" }], [], config),
		).resolves.toBe(successResponse);
		expect(observer).toHaveBeenCalledTimes(1);
		expect(successClient.runRecords).toHaveLength(1);

		const providerError = new Error("provider failed");
		const failedRoutedDelegate = {
			chat: vi.fn().mockRejectedValue(providerError),
		} satisfies LLMClient;
		const failedDelegate = {
			chat: vi.fn(),
			withModel: vi.fn().mockReturnValue(failedRoutedDelegate),
		} satisfies LLMClient & { withModel(modelId: string): LLMClient };
		const failedClient = new ProviderControlPlaneLLMClient(failedDelegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-chat",
			},
			onRunRecord: observer,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		await expect(
			failedClient.chat([{ role: "user", content: "hi" }], [], config),
		).rejects.toThrow("provider failed");
		expect(observer).toHaveBeenCalledTimes(2);
		expect(failedClient.runRecords).toHaveLength(1);
	});

	it("routes simple tiered requests to flash and applies the tier profile", async () => {
		const response = {
			content: "ok",
			usage: { inputTokens: 1, outputTokens: 1 },
			finishReason: "stop" as const,
		};
		const routedDelegate = {
			chat: vi.fn().mockResolvedValue(response),
		} satisfies LLMClient;
		const delegate = {
			chat: vi.fn(),
			withModel: vi.fn().mockReturnValue(routedDelegate),
		} satisfies LLMClient & { withModel(modelId: string): LLMClient };
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
			},
			tierRouting,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		await expect(
			client.chat([{ role: "user", content: "解释一下这个概念" }], [], config),
		).resolves.toBe(response);

		expect(delegate.withModel).toHaveBeenCalledWith("deepseek-v4-flash");
		expect(routedDelegate.chat).toHaveBeenCalledWith(
			[{ role: "user", content: "解释一下这个概念" }],
			[],
			{
				temperature: 0.2,
				maxTokens: 64,
				thinkingMode: "disabled",
			},
			undefined,
		);
		expect(client.runRecords[0]?.route).toMatchObject({
			provider: "deepseek",
			configuredModel: "deepseek-v4-flash",
			effectiveModel: "deepseek-v4-flash",
			selectedTier: "flash",
			routingMode: "auto",
			routeReason: "short_low_risk_no_tool",
			thinkingMode: "disabled",
			budget: {
				maxTokens: 64,
			},
		});
	});

	it("routes complex tiered requests to pro and applies thinking budget overrides", async () => {
		const response = {
			content: "ok",
			usage: { inputTokens: 5, outputTokens: 3 },
			finishReason: "stop" as const,
		};
		const routedDelegate = {
			chat: vi.fn().mockResolvedValue(response),
		} satisfies LLMClient;
		const delegate = {
			chat: vi.fn(),
			withModel: vi.fn().mockReturnValue(routedDelegate),
		} satisfies LLMClient & { withModel(modelId: string): LLMClient };
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
			},
			tierRouting,
		});

		await client.chat(
			[{ role: "user", content: "实现路由策略并运行测试" }],
			[],
			config,
		);

		expect(delegate.withModel).toHaveBeenCalledWith("deepseek-v4-pro");
		expect(routedDelegate.chat).toHaveBeenCalledWith(
			[{ role: "user", content: "实现路由策略并运行测试" }],
			[],
			{
				temperature: 0.1,
				maxTokens: 1024,
				thinkingMode: "enabled",
				thinkingBudget: 6000,
			},
			undefined,
		);
		expect(client.runRecords[0]?.route).toMatchObject({
			configuredModel: "deepseek-v4-pro",
			effectiveModel: "deepseek-v4-pro",
			selectedTier: "pro",
			routingMode: "auto",
			routeReason: "high_complexity_or_risk",
			thinkingMode: "enabled",
			budget: {
				maxTokens: 1024,
				thinkingBudget: 6000,
			},
		});
	});

	it("rejects tier provider switches when the delegate only routes models", async () => {
		const delegate = {
			chat: vi.fn(),
			withModel: vi.fn(),
		} satisfies LLMClient & { withModel(modelId: string): LLMClient };
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-v4-pro",
			},
			tierRouting: {
				...tierRouting,
				mode: "pro",
				tiers: {
					...tierRouting.tiers,
					pro: {
						provider: "openai",
						model: "gpt-4.1",
						thinkingMode: "enabled",
					},
				},
			},
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], config),
		).rejects.toThrow(/cannot switch runtime provider from deepseek to openai/);
		expect(delegate.withModel).not.toHaveBeenCalled();
		expect(delegate.chat).not.toHaveBeenCalled();
		expect(client.runRecords[0]).toMatchObject({
			route: {
				provider: "deepseek",
				configuredModel: "deepseek-v4-pro",
				selectedTier: "pro",
				routingMode: "pro",
			},
			attempts: [],
			outcome: "error",
		});
	});

	it("forces a Vercel delegate to use the effective DeepSeek reasoner model", async () => {
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "ok",
				usage: {
					promptTokens: 3,
					completionTokens: 4,
				},
				finishReason: "stop",
			}),
		);
		const chatModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});
		const reasonerModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-reasoner",
		});
		const resolveModel = vi.fn((modelId: string) =>
			modelId === "deepseek-reasoner" ? reasonerModel : chatModel,
		);
		const client = new ProviderControlPlaneLLMClient(
			new VercelLLMClient({
				model: chatModel,
				resolveModel,
			}),
			{
				routeRequest: {
					provider: "deepseek",
					model: "deepseek-chat",
				},
			},
		);

		await client.chat([{ role: "user", content: "hi" }], [], config);

		expect(resolveModel).toHaveBeenCalledWith("deepseek-reasoner");
		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: reasonerModel,
			}),
		);
	});

	it("records one normalized error attempt without leaking provider secrets", async () => {
		const secretMessage =
			"provider exploded token=secret Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 sk-abcdefghijklmnopqrstuvwxyz012345";
		const error = Object.assign(new Error(secretMessage), {
			name: "ProviderAuthError",
			code: "AUTH_FAILED",
			category: "auth",
		});
		error.stack = `ProviderAuthError: ${secretMessage}\n    at providerSecretFrame`;
		const records: unknown[] = [];
		const delegate = {
			chat: vi.fn().mockRejectedValue(error),
		} satisfies LLMClient;
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-chat",
			},
			onRunRecord: (record) => records.push(record),
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], {
				...config,
				thinkingMode: "disabled",
			}),
		).rejects.toBe(error);

		expect(delegate.chat).toHaveBeenCalledTimes(1);
		expect(records).toHaveLength(1);
		expect(client.runRecords).toEqual([
			{
				route: {
					provider: "deepseek",
					configuredModel: "deepseek-chat",
					effectiveModel: "deepseek-chat",
					fallbackUsed: false,
					reasoningStateAdapter: "none",
					budget: {
						maxTokens: 128,
						thinkingBudget: 2048,
					},
				},
				attempts: [
					{
						attemptNumber: 1,
						provider: "deepseek",
						model: "deepseek-chat",
						startedAt: "2026-05-01T00:00:00.000Z",
						completedAt: "2026-05-01T00:00:00.000Z",
						outcome: "error",
						error: {
							name: "ProviderAuthError",
							message: "Provider error details redacted.",
							code: "AUTH_FAILED",
							category: "auth",
						},
					},
				],
				outcome: "error",
				fallbackUsed: false,
			},
		]);
		const serializedRunRecords = JSON.stringify(client.runRecords);
		const serializedCallbackRecords = JSON.stringify(records);
		for (const serialized of [
			serializedRunRecords,
			serializedCallbackRecords,
		]) {
			expect(serialized).not.toContain("token=secret");
			expect(serialized).not.toContain(
				"Bearer abcdefghijklmnopqrstuvwxyz012345",
			);
			expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
			expect(serialized).not.toContain("providerSecretFrame");
			expect(serialized).not.toContain("stack");
		}
	});

	it("redacts unsafe provider error names", () => {
		expect(
			clientTestHelpers.normalizeProviderError({
				name: "sk-abcdefghijklmnopqrstuvwxyz012345",
				code: "AUTH_FAILED",
			}),
		).toEqual({
			name: "Error",
			message: "Provider error details redacted.",
			code: "AUTH_FAILED",
		});
	});

	it("preflights provider catalog env requirements before calling the delegate", async () => {
		const delegate = {
			chat: vi.fn(),
		} satisfies LLMClient;
		const client = new ProviderControlPlaneLLMClient(delegate, {
			env: {},
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-chat",
			},
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], config),
		).rejects.toThrow(/missing required env: DEEPSEEK_API_KEY/);

		expect(delegate.chat).not.toHaveBeenCalled();
		expect(client.runRecords[0]).toMatchObject({
			route: {
				provider: "deepseek",
				configuredModel: "deepseek-chat",
				effectiveModel: "deepseek-chat",
				fallbackUsed: false,
				reasoningStateAdapter: "captured_replayed_for_tool_calls",
				budget: {
					maxTokens: 128,
					thinkingBudget: 2048,
				},
			},
			attempts: [],
			outcome: "error",
			error: {
				name: "Error",
				message: "Provider error details redacted.",
			},
		});
	});

	it.each([
		{
			name: "blocked",
			provider: "openai" as const,
			model: "gpt-4.1",
			error: /Provider openai is blocked; no provider fallback is configured/,
		},
		{
			name: "candidate",
			provider: "gemini" as const,
			model: "gemini-2.5-pro",
			error: /Provider gemini is candidate; no provider fallback is configured/,
		},
		{
			name: "unknown",
			provider: "openai" as const,
			model: "gpt-4.1",
			catalog: {
				entries: [
					{
						provider: "deepseek" as const,
						status: "enabled" as const,
						transport: "direct" as const,
						defaultModel: "deepseek-chat",
						models: ["deepseek-chat", "deepseek-reasoner"],
						liveEvidence: "verified" as const,
					},
				],
			},
			error: /Provider openai is not in the provider catalog/,
		},
	])("records a no-attempt normalized error for $name route failures", async ({
		provider,
		model,
		catalog,
		error,
	}) => {
		const records: unknown[] = [];
		const delegate = {
			chat: vi.fn(),
		} satisfies LLMClient;
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider,
				model,
			},
			...(catalog == null ? {} : { catalog }),
			onRunRecord: (record) => records.push(record),
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], {
				...config,
				thinkingMode: "disabled",
			}),
		).rejects.toThrow(error);

		expect(delegate.chat).not.toHaveBeenCalled();
		expect(client.runRecords).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(client.runRecords[0]).toMatchObject({
			route: {
				provider,
				configuredModel: model,
				effectiveModel: model,
				fallbackUsed: false,
				reasoningStateAdapter: "none",
			},
			attempts: [],
			outcome: "error",
			fallbackUsed: false,
			error: {
				name: "Error",
				message: "Provider error details redacted.",
			},
		});
	});

	it("does not let unrelated enabled provider env checks mask route failures", async () => {
		const delegate = {
			chat: vi.fn(),
		} satisfies LLMClient;
		const client = new ProviderControlPlaneLLMClient(delegate, {
			env: {},
			routeRequest: {
				provider: "openai",
				model: "gpt-4.1",
			},
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], config),
		).rejects.toThrow(
			/Provider openai is blocked; no provider fallback is configured/,
		);
		expect(delegate.chat).not.toHaveBeenCalled();
	});

	it("records a no-attempt error instead of calling an unroutable delegate", async () => {
		const records: unknown[] = [];
		const delegate = {
			chat: vi.fn(),
		} satisfies LLMClient;
		const client = new ProviderControlPlaneLLMClient(delegate, {
			routeRequest: {
				provider: "deepseek",
				model: "deepseek-chat",
			},
			onRunRecord: (record) => records.push(record),
		});

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], config),
		).rejects.toThrow(/cannot route configured model deepseek-chat/);

		expect(delegate.chat).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
		expect(client.runRecords[0]).toMatchObject({
			route: {
				provider: "deepseek",
				configuredModel: "deepseek-chat",
				effectiveModel: "deepseek-reasoner",
				fallbackUsed: false,
				reasoningStateAdapter: "captured_replayed_for_tool_calls",
			},
			attempts: [],
			outcome: "error",
			fallbackUsed: false,
			error: {
				name: "Error",
				message: "Provider error details redacted.",
			},
		});
	});
});

describe("StreamingLLMClient", () => {
	const model = createMockLanguageModel();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("maps fullStream events and returns accumulated text plus reasoning", async () => {
		const events: unknown[] = [];
		const streamingModel = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-reasoner",
		});

		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield { type: "reasoning-start", id: "r-1" };
					yield { type: "reasoning-delta", id: "r-1", delta: "step " };
					yield { type: "reasoning-delta", id: "r-1", delta: "one" };
					yield { type: "tool-input-start", id: "call-1", toolName: "search" };
					yield { type: "tool-input-delta", id: "call-1", delta: '{"q":' };
					yield { type: "tool-input-delta", id: "call-1", delta: '"hi"}' };
					yield { type: "tool-input-end", id: "call-1" };
					yield {
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "search",
						input: { q: "hi" },
					};
					yield {
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "search",
						output: { answer: "ok" },
					};
					yield { type: "text-start", id: "t-1" };
					yield { type: "text-delta", id: "t-1", delta: "hel" };
					yield { type: "text-delta", id: "t-1", delta: "lo" };
					yield { type: "text-end", id: "t-1" };
				})(),
				usage: Promise.resolve({
					promptTokens: 5,
					completionTokens: 7,
				}),
				finishReason: Promise.resolve("stop"),
			}),
		);

		const client = new StreamingLLMClient(streamingModel, (event) => {
			events.push(event);
		});

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(streamText).toHaveBeenCalledWith({
			model: streamingModel,
			messages: [{ role: "user", content: "hi" }],
			allowSystemInMessages: true,
			tools: undefined,
			maxOutputTokens: 64,
			temperature: 0.2,
			topP: undefined,
			maxRetries: 0,
		});
		expect(events).toEqual([
			{ type: "reasoning", delta: "step " },
			{ type: "reasoning", delta: "one" },
			{ type: "tool-call-start", toolCallId: "call-1", toolName: "search" },
			{
				type: "tool-call-args-delta",
				toolCallId: "call-1",
				toolName: "search",
				delta: '{"q":',
			},
			{
				type: "tool-call-args-delta",
				toolCallId: "call-1",
				toolName: "search",
				delta: '"hi"}',
			},
			{
				type: "tool-call-end",
				toolCallId: "call-1",
				toolName: "search",
				inputText: '{"q":"hi"}',
				input: { q: "hi" },
			},
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "search",
				output: { answer: "ok" },
			},
			{ type: "text", delta: "hel" },
			{ type: "text", delta: "lo" },
		]);
		expect(result).toEqual({
			content: "hello",
			thinking: [{ provider: "deepseek", text: "step one" }],
			usage: {
				inputTokens: 5,
				outputTokens: 7,
			},
			finishReason: "stop",
		});
	});

	it("restores namespaced MCP tool names from streamText events and returned calls", async () => {
		const events: unknown[] = [];
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield {
						type: "tool-input-start",
						id: "call-1",
						toolName: "quilin-mem_memory_recall",
					};
					yield {
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "quilin-mem_memory_recall",
						input: { query: "我是谁" },
					};
					yield {
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "quilin-mem_memory_recall",
						output: { records: [] },
					};
				})(),
				usage: Promise.resolve({
					promptTokens: 3,
					completionTokens: 4,
				}),
				finishReason: Promise.resolve("tool-calls"),
				toolCalls: Promise.resolve([
					{
						toolCallId: "call-1",
						toolName: "quilin-mem_memory_recall",
						input: { query: "我是谁" },
					},
				]),
			}),
		);

		const namespacedTool = {
			name: "quilin-mem/memory_recall",
			description: "Recall memory",
			parameters: z.object({ query: z.string() }),
			execute: vi.fn(),
		};
		const client = new StreamingLLMClient(model, (event) => {
			events.push(event);
		});

		const result = await client.chat(
			[{ role: "user", content: "我是谁" }],
			[namespacedTool],
			{
				temperature: 0.2,
				maxTokens: 64,
				thinkingMode: "disabled",
			},
		);

		expect(streamText).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: {
					"quilin-mem_memory_recall": {
						description: "Recall memory",
						inputSchema: namespacedTool.parameters,
					},
				},
			}),
		);
		expect(events).toEqual([
			{
				type: "tool-call-start",
				toolCallId: "call-1",
				toolName: "quilin-mem/memory_recall",
			},
			{
				type: "tool-call-end",
				toolCallId: "call-1",
				toolName: "quilin-mem/memory_recall",
				inputText: '{"query":"我是谁"}',
				input: { query: "我是谁" },
			},
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "quilin-mem/memory_recall",
				output: { records: [] },
			},
		]);
		expect(result.toolCalls).toEqual([
			{
				id: "call-1",
				name: "quilin-mem/memory_recall",
				arguments: { query: "我是谁" },
			},
		]);
	});

	it("buffers tool-input deltas until the tool name is known", async () => {
		const events: unknown[] = [];
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield { type: "tool-input-delta", id: "call-1", delta: '{"q":' };
					yield {
						type: "tool-input-start",
						id: "call-1",
						toolName: "search",
					};
					yield { type: "tool-input-delta", id: "call-1", delta: '"hi"}' };
					yield {
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "search",
						input: { q: "hi" },
					};
				})(),
				usage: Promise.resolve({
					promptTokens: 5,
					completionTokens: 7,
				}),
				finishReason: Promise.resolve("tool-calls"),
				toolCalls: Promise.resolve([
					{
						toolCallId: "call-1",
						toolName: "search",
						input: { q: "hi" },
					},
				]),
			}),
		);

		const client = new StreamingLLMClient(model, (event) => {
			events.push(event);
		});

		await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(events).toEqual([
			{ type: "tool-call-start", toolCallId: "call-1", toolName: "search" },
			{
				type: "tool-call-args-delta",
				toolCallId: "call-1",
				toolName: "search",
				delta: '{"q":',
			},
			{
				type: "tool-call-args-delta",
				toolCallId: "call-1",
				toolName: "search",
				delta: '"hi"}',
			},
			{
				type: "tool-call-end",
				toolCallId: "call-1",
				toolName: "search",
				inputText: '{"q":"hi"}',
				input: { q: "hi" },
			},
		]);
	});

	it("preserves multiple reasoning blocks in order from fullStream", async () => {
		const anthropicModel = createMockLanguageModel({
			provider: "anthropic",
			modelId: "claude-3-7-sonnet-latest",
		});

		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield { type: "reasoning-start", id: "r-1" };
					yield { type: "reasoning-delta", id: "r-1", delta: "step one" };
					yield {
						type: "reasoning-delta",
						id: "r-1",
						delta: "",
						providerMetadata: {
							anthropic: {
								signature: "sig-1",
							},
						},
					};
					yield { type: "reasoning-end", id: "r-1" };
					yield { type: "text-delta", id: "t-1", delta: "partial " };
					yield { type: "reasoning-start", id: "r-2" };
					yield { type: "reasoning-delta", id: "r-2", delta: "step two" };
					yield {
						type: "reasoning-delta",
						id: "r-2",
						delta: "",
						providerMetadata: {
							anthropic: {
								signature: "sig-2",
							},
						},
					};
					yield { type: "reasoning-end", id: "r-2" };
					yield { type: "text-delta", id: "t-1", delta: "answer" };
				})(),
				usage: Promise.resolve({
					promptTokens: 5,
					completionTokens: 7,
				}),
				finishReason: Promise.resolve("stop"),
			}),
		);

		const client = new StreamingLLMClient(anthropicModel);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "enabled",
		});

		expect(result).toEqual({
			content: "partial answer",
			thinking: [
				{ provider: "anthropic", text: "step one", signature: "sig-1" },
				{ provider: "anthropic", text: "step two", signature: "sig-2" },
			],
			usage: {
				inputTokens: 5,
				outputTokens: 7,
			},
			finishReason: "stop",
		});
	});

	it("maps streamed provider metadata cache usage", async () => {
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield { type: "text-delta", id: "t-1", delta: "hi" };
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
			}),
		);

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

	it("throws when fullStream emits an error chunk", async () => {
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield {
						type: "error",
						error: new Error("stream exploded"),
					};
				})(),
				usage: Promise.resolve({
					promptTokens: 3,
					completionTokens: 4,
				}),
				finishReason: Promise.resolve("stop"),
			}),
		);

		const client = new StreamingLLMClient(model);

		await expect(
			client.chat([{ role: "user", content: "hi" }], [], {
				temperature: 0.2,
				maxTokens: 64,
				thinkingMode: "disabled",
			}),
		).rejects.toThrow("stream exploded");
	});

	it("maps tool calls from streamText", async () => {
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {})(),
				usage: Promise.resolve({
					promptTokens: 3,
					completionTokens: 4,
				}),
				finishReason: Promise.resolve("tool-calls"),
				toolCalls: Promise.resolve([
					{
						toolCallId: "call-2",
						toolName: "memory_store",
						input: { content: "我叫小明", tier: "working" },
					},
				]),
			}),
		);

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
					arguments: { content: "我叫小明", tier: "working" },
				},
			],
			usage: {
				inputTokens: 3,
				outputTokens: 4,
			},
			finishReason: "tool_calls",
		});
	});

	it("merges streamed reasoning metadata and accepts text fallback chunks", async () => {
		const openaiModel = createMockLanguageModel({
			provider: "openai",
			modelId: "o4-mini",
		});
		const events: unknown[] = [];
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield { type: "reasoning-start", id: "r-1" };
					yield {
						type: "reasoning-delta",
						id: "r-1",
						text: "hidden ",
						providerMetadata: {
							openai: {
								itemId: "rs-1",
							},
						},
					};
					yield {
						type: "reasoning-end",
						id: "r-1",
						providerMetadata: {
							openai: {
								reasoningEncryptedContent: "cipher",
							},
						},
					};
					yield { type: "text-delta", id: "t-1", text: "done" };
				})(),
				usage: Promise.resolve({
					promptTokens: 5,
					completionTokens: 7,
				}),
				finishReason: Promise.resolve("stop"),
			}),
		);

		const result = await new StreamingLLMClient(openaiModel, (event) => {
			events.push(event);
		}).chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "enabled",
		});

		expect(events).toEqual([
			{ type: "reasoning", delta: "hidden " },
			{ type: "text", delta: "done" },
		]);
		expect(result).toEqual({
			content: "done",
			thinking: [
				{
					provider: "openai-responses",
					itemId: "rs-1",
					encryptedContent: "cipher",
					text: "hidden ",
				},
			],
			usage: {
				inputTokens: 5,
				outputTokens: 7,
			},
			finishReason: "stop",
		});
	});

	it("emits tool errors, ignores preliminary tool results, and stringifies missing inputs", async () => {
		const events: unknown[] = [];
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield {
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "search",
						input: undefined,
					};
					yield {
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "search",
						output: { preliminary: true },
						preliminary: true,
					};
					yield {
						type: "tool-error",
						toolCallId: "call-1",
						toolName: "search",
						error: "boom",
					};
					yield {
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "search",
						input: undefined,
					};
				})(),
				usage: Promise.resolve({
					promptTokens: 3,
					completionTokens: 4,
				}),
				finishReason: Promise.resolve("stop"),
			}),
		);

		const result = await new StreamingLLMClient(model, (event) => {
			events.push(event);
		}).chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(events).toEqual([
			{ type: "tool-call-start", toolCallId: "call-1", toolName: "search" },
			{
				type: "tool-call-end",
				toolCallId: "call-1",
				toolName: "search",
				inputText: "undefined",
			},
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "search",
				output: "boom",
				isError: true,
			},
		]);
		expect(result.finishReason).toBe("stop");
	});

	it("wraps non-Error stream error chunks", async () => {
		vi.mocked(streamText).mockReturnValue(
			mockStreamTextResult({
				fullStream: (async function* () {
					yield {
						type: "error",
						error: "stream exploded",
					};
				})(),
				usage: Promise.resolve({
					promptTokens: 3,
					completionTokens: 4,
				}),
				finishReason: Promise.resolve("stop"),
			}),
		);

		await expect(
			new StreamingLLMClient(model).chat(
				[{ role: "user", content: "hi" }],
				[],
				{
					temperature: 0.2,
					maxTokens: 64,
					thinkingMode: "disabled",
				},
			),
		).rejects.toThrow("stream exploded");
	});
});

describe("client test helpers", () => {
	it("exposes provider and model helper behavior for unit coverage", () => {
		const baseModel = {
			provider: "openai.compatible",
			modelId: "o4-mini",
		} as LanguageModel;
		const handle = {
			model: baseModel,
			resolveModel: vi.fn(),
		};

		expect(clientTestHelpers.isResolvableModelHandle(handle)).toBe(true);
		expect(clientTestHelpers.isResolvableModelHandle(baseModel)).toBe(false);
		expect(clientTestHelpers.getBaseModel(handle)).toBe(baseModel);
		expect(clientTestHelpers.normalizeProviderName("anthropic.beta")).toBe(
			"anthropic",
		);
		expect(clientTestHelpers.normalizeProviderName("deepseek")).toBe(
			"deepseek",
		);
		expect(clientTestHelpers.normalizeProviderName("openai.chat")).toBe(
			"openai",
		);
		expect(clientTestHelpers.normalizeProviderName("unknown.vendor")).toBe(
			"unknown",
		);
		expect(clientTestHelpers.mapOpenAIReasoningEffort("enabled")).toBe("high");
		expect(clientTestHelpers.mapOpenAIReasoningEffort("auto")).toBe("medium");
		expect(
			clientTestHelpers.mapOpenAIReasoningEffort("disabled"),
		).toBeUndefined();
	});

	it("returns typed provider options plus warnings", () => {
		expect(
			clientTestHelpers.buildProviderOptions("anthropic", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "enabled",
				thinkingBudget: 2048,
			}),
		).toEqual({
			providerOptions: {
				anthropic: {
					thinking: {
						type: "enabled",
						budgetTokens: 2048,
					},
				},
			},
			warnings: [],
		});

		expect(
			clientTestHelpers.buildProviderOptions("openai", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "enabled",
				thinkingBudget: 1024,
			}),
		).toEqual({
			providerOptions: {
				openai: {
					reasoningEffort: "high",
				},
			},
			warnings: ["openai-thinking-budget-ignored"],
		});
		expect(
			clientTestHelpers.buildProviderOptions("anthropic", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "enabled",
			}),
		).toEqual({
			providerOptions: {
				anthropic: {
					thinking: {
						type: "enabled",
						budgetTokens: 1024,
					},
				},
			},
			warnings: [],
		});
		expect(
			clientTestHelpers.buildProviderOptions("anthropic", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "disabled",
			}),
		).toEqual({ warnings: [] });
		expect(
			clientTestHelpers.buildProviderOptions("openai", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "disabled",
				thinkingBudget: 1024,
			}),
		).toEqual({ warnings: ["openai-thinking-budget-ignored"] });
		expect(
			clientTestHelpers.buildProviderOptions("deepseek", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "enabled",
			}),
		).toEqual({
			providerOptions: {
				deepseek: {
					thinking: { type: "enabled" },
					reasoningEffort: "high",
				},
			},
			warnings: [],
		});
		expect(
			clientTestHelpers.buildProviderOptions("deepseek", {
				temperature: 0.1,
				maxTokens: 128,
				thinkingMode: "disabled",
			}),
		).toEqual({ warnings: [] });
	});
});
