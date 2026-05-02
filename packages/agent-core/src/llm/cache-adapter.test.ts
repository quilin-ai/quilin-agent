import { describe, expect, it } from "vitest";
import type { Message } from "../state/types.js";
import { adaptMessagesForModel } from "./cache-adapter.js";

describe("adaptMessagesForModel", () => {
	it("keeps the existing byte-stable message layout for DeepSeek", () => {
		const result = adaptMessagesForModel({
			provider: "deepseek.chat",
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "hello" },
			],
			prompt: {
				segments: [
					{
						id: "identity",
						role: "system",
						text: "<!-- identity -->\nidentity",
						stability: "static",
						source: "prompt-section",
						cacheEligible: true,
					},
				],
				recommendedBreakpoints: [{ segmentIndex: 0, reason: "system-tail" }],
				staticPrefix: "<!-- identity -->\nidentity",
				dynamicSuffix: "",
				sectionTokens: { identity: 4 },
				totalTokens: 4,
			},
		});

		expect(result.messages).toEqual([
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "hello" },
		]);
		expect(result.appliedBreakpoints).toEqual([]);
	});

	it("translates recommended system breakpoints into Anthropic cacheControl", () => {
		const result = adaptMessagesForModel({
			provider: "anthropic",
			messages: [
				{ role: "system", content: "legacy combined system" },
				{ role: "user", content: "[时间上下文]\n当前时间: ...\n\nhello" },
			],
			prompt: {
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
		});

		expect(result.messages).toEqual([
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
			{ role: "user", content: "[时间上下文]\n当前时间: ...\n\nhello" },
		]);
		expect(result.appliedBreakpoints).toEqual([
			{ segmentIndex: 1, reason: "system-tail" },
		]);
		expect(
			result.messages.filter(
				(message) =>
					"providerOptions" in message && message.providerOptions != null,
			),
		).toHaveLength(1);
	});

	it("serializes DeepSeek tool-call reasoning for required reasoning_content replay", () => {
		const result = adaptMessagesForModel({
			provider: "deepseek.chat",
			messages: [
				{ role: "system", content: "system prompt" },
				{
					role: "assistant",
					content: "",
					reasoning: [{ provider: "deepseek", text: "SECRET_REASONING" }],
					toolCalls: [
						{
							id: "call-1",
							name: "memory_recall",
							arguments: { query: "hello" },
						},
					],
				},
			],
		});

		expect(result.messages).toEqual([
			{ role: "system", content: "system prompt" },
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "SECRET_REASONING",
					},
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "memory_recall",
						input: { query: "hello" },
					},
				],
			},
		]);
	});

	it("keeps assistant reasoning out of non-DeepSeek outbound model messages", () => {
		const result = adaptMessagesForModel({
			provider: "openai.responses",
			messages: [
				{
					role: "assistant",
					content: "",
					reasoning: [{ provider: "deepseek", text: "SECRET_REASONING" }],
					toolCalls: [
						{
							id: "call-1",
							name: "memory_recall",
							arguments: { query: "hello" },
						},
					],
				},
			],
		});

		expect(JSON.stringify(result.messages)).not.toContain("SECRET_REASONING");
		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "memory_recall",
						input: { query: "hello" },
					},
				],
			},
		]);
	});

	it("serializes assistant tool calls and tool results without dropping text content", () => {
		const result = adaptMessagesForModel({
			provider: "openai.responses",
			messages: [
				{
					role: "assistant",
					content: "I will call a tool",
					toolCalls: [
						{
							id: "call-1",
							name: "memory_recall",
							arguments: { query: "context" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call-1",
					name: "memory_recall",
					content: '{"matches":["one"]}',
				},
				{
					role: "tool",
					toolCallId: "call-2",
					name: "shell_exec",
					content: "plain output",
				},
			],
		});

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will call a tool" },
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "memory_recall",
						input: { query: "context" },
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
						output: { type: "json", value: { matches: ["one"] } },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-2",
						toolName: "shell_exec",
						output: { type: "text", value: "plain output" },
					},
				],
			},
		]);
	});

	it("drops malformed tool messages and unknown transcript roles", () => {
		const messages = [
			{ role: "tool", name: "missing_id", content: "{}" },
			{
				role: "developer",
				content: "unsupported role",
			},
			{ role: "user", content: "kept" },
		] as unknown as Message[];

		const result = adaptMessagesForModel({
			provider: "xai.grok",
			messages,
		});

		expect(result.messages).toEqual([{ role: "user", content: "kept" }]);
		expect(result.appliedBreakpoints).toEqual([]);
	});

	it("falls back to byte-stable serialization when Anthropic has no segment prompt", () => {
		for (const prompt of [undefined, { segments: [] }]) {
			const result = adaptMessagesForModel({
				provider: "anthropic.claude",
				messages: [
					{ role: "system", content: "legacy system" },
					{ role: "user", content: "hello" },
				],
				prompt: prompt as never,
			});

			expect(result).toEqual({
				messages: [
					{ role: "system", content: "legacy system" },
					{ role: "user", content: "hello" },
				],
				appliedBreakpoints: [],
			});
		}
	});

	it("only applies Anthropic breakpoints to system segments and caps them at four", () => {
		const result = adaptMessagesForModel({
			provider: "anthropic",
			messages: [{ role: "user", content: "hello" }],
			prompt: {
				segments: [
					{
						id: "s1",
						role: "system",
						text: "one",
						stability: "static",
						source: "prompt-section",
						cacheEligible: true,
					},
					{
						id: "u1",
						role: "user",
						text: "user segment",
						stability: "per_turn",
						source: "transcript",
						cacheEligible: false,
					},
					{
						id: "s2",
						role: "system",
						text: "two",
						stability: "per_session",
						source: "prompt-section",
						cacheEligible: true,
					},
					{
						id: "s3",
						role: "system",
						text: "three",
						stability: "per_session",
						source: "prompt-section",
						cacheEligible: true,
					},
					{
						id: "s4",
						role: "system",
						text: "four",
						stability: "per_session",
						source: "prompt-section",
						cacheEligible: true,
					},
					{
						id: "s5",
						role: "system",
						text: "five",
						stability: "per_session",
						source: "prompt-section",
						cacheEligible: true,
					},
				],
				recommendedBreakpoints: [
					{ segmentIndex: 0, reason: "system-tail" },
					{ segmentIndex: 1, reason: "system-tail" },
					{ segmentIndex: 2, reason: "system-tail" },
					{ segmentIndex: 3, reason: "system-tail" },
					{ segmentIndex: 4, reason: "system-tail" },
					{ segmentIndex: 5, reason: "system-tail" },
				],
				staticPrefix: "",
				dynamicSuffix: "",
				sectionTokens: {},
				totalTokens: 0,
			},
		});

		expect(result.messages).toHaveLength(6);
		expect(
			result.messages.filter(
				(message) =>
					"providerOptions" in message && message.providerOptions != null,
			),
		).toHaveLength(3);
		expect(result.appliedBreakpoints).toEqual([
			{ segmentIndex: 0, reason: "system-tail" },
			{ segmentIndex: 2, reason: "system-tail" },
			{ segmentIndex: 3, reason: "system-tail" },
		]);
	});

	it("recognizes provider aliases that do not support explicit cache control", () => {
		for (const provider of [
			"google.gemini-2.5-pro",
			"gemini.flash",
			"xai.grok",
			"unknown-provider",
			undefined,
		]) {
			const result = adaptMessagesForModel({
				provider,
				messages: [{ role: "user", content: "hello" }],
			});

			expect(result).toEqual({
				messages: [{ role: "user", content: "hello" }],
				appliedBreakpoints: [],
			});
		}
	});
});
