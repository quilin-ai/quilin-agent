import { describe, expect, it } from "vitest";
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
});
