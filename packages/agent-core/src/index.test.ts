import type { LanguageModelV1 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider, getDefaultModel } from "./llm/provider.js";
import { logger } from "./logger.js";
import { startRepl } from "./repl.js";

vi.mock("dotenv/config", () => ({}));

vi.mock("ai", () => ({
	generateText: vi.fn(),
}));

vi.mock("./logger.js", () => ({
	logger: {
		info: vi.fn(),
		fatal: vi.fn(),
	},
}));

vi.mock("./llm/provider.js", () => ({
	createProvider: vi.fn(),
	getDefaultModel: vi.fn(),
}));

vi.mock("./repl.js", () => ({
	startRepl: vi.fn(),
}));

describe("main", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("verifies the llm connection before starting the repl", async () => {
		const model: LanguageModelV1 = {
			specificationVersion: "v1",
			provider: "deepseek",
			modelId: "deepseek-chat",
			defaultObjectGenerationMode: undefined,
			async doGenerate() {
				return {
					text: "Quilin Agent online.",
					finishReason: "stop",
					usage: {
						promptTokens: 18,
						completionTokens: 5,
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
		const provider = vi.fn().mockReturnValue(model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue({
			text: "Quilin Agent online.",
			usage: {
				inputTokens: 18,
				outputTokens: 5,
			},
		} as Awaited<ReturnType<typeof generateText>>);

		const { main } = await import("./index.js");

		await main();

		expect(logger.info).toHaveBeenNthCalledWith(
			1,
			{ version: "0.0.1" },
			"Quilin Agent starting",
		);
		expect(logger.info).toHaveBeenNthCalledWith(
			2,
			{ provider: "deepseek", model: "deepseek-chat" },
			"LLM provider initialized",
		);
		expect(logger.info).toHaveBeenNthCalledWith(
			3,
			"Verifying LLM connection...",
		);
		expect(generateText).toHaveBeenCalledWith({
			model: expect.objectContaining({
				specificationVersion: "v2",
				provider: "deepseek",
				modelId: "deepseek-chat",
				doGenerate: expect.any(Function),
				doStream: expect.any(Function),
			}),
			prompt: 'Reply with exactly: "Quilin Agent online." Nothing else.',
			maxTokens: 20,
		});
		expect(logger.info).toHaveBeenNthCalledWith(
			4,
			{
				response: "Quilin Agent online.",
				inputTokens: 18,
				outputTokens: 5,
			},
			"LLM connection verified",
		);
		expect(logger.info).toHaveBeenNthCalledWith(5, "Starting CLI REPL...");
		expect(startRepl).toHaveBeenCalledWith({
			provider,
			modelId: "deepseek-chat",
		});
	});
});
