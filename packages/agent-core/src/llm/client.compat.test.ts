import type { LanguageModelV1 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { VercelLLMClient } from "./client.js";

describe("VercelLLMClient compatibility", () => {
	it("adapts LanguageModelV1 providers for ai generateText", async () => {
		const model: LanguageModelV1 = {
			specificationVersion: "v1",
			provider: "test-provider",
			modelId: "test-model",
			defaultObjectGenerationMode: undefined,
			async doGenerate() {
				return {
					text: "compat ok",
					finishReason: "stop",
					usage: {
						promptTokens: 3,
						completionTokens: 2,
					},
					rawCall: {
						rawPrompt: null,
						rawSettings: {},
					},
				};
			},
			async doStream() {
				throw new Error("not used");
			},
		};

		const client = new VercelLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hello" }], [], {
			temperature: 0.7,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(result).toEqual({
			content: "compat ok",
			usage: {
				inputTokens: 3,
				outputTokens: 2,
			},
			finishReason: "stop",
		});
	});
});
