import type { LanguageModel } from "ai";
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

	it("starts the repl only in repl mode", async () => {
		const model = {} as LanguageModel;
		const provider = vi.fn().mockReturnValue(model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue({
			text: "Quilin Agent online.",
			usage: {
				promptTokens: 18,
				completionTokens: 5,
			},
		} as Awaited<ReturnType<typeof generateText>>);

		const { main } = await import("./index.js");

		await main({ runtimeMode: "repl" });

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
			model,
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
		expect(logger.info).toHaveBeenNthCalledWith(
			5,
			{ mode: "repl" },
			"Starting CLI REPL...",
		);
		expect(startRepl).toHaveBeenCalledWith({
			provider,
			modelId: "deepseek-chat",
		});
	});

	it("stays in service mode without entering the repl", async () => {
		const model = {} as LanguageModel;
		const provider = vi.fn().mockReturnValue(model);
		const serviceRunner = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue({
			text: "Quilin Agent online.",
			usage: {
				inputTokens: 21,
				outputTokens: 6,
			},
		} as Awaited<ReturnType<typeof generateText>>);

		const { main } = await import("./index.js");

		await main({ runtimeMode: "service", serviceRunner });

		expect(logger.info).toHaveBeenNthCalledWith(
			4,
			{
				response: "Quilin Agent online.",
				inputTokens: 21,
				outputTokens: 6,
			},
			"LLM connection verified",
		);
		expect(logger.info).toHaveBeenNthCalledWith(
			5,
			{ mode: "service" },
			"Starting agent-core service loop...",
		);
		expect(serviceRunner).toHaveBeenCalledOnce();
		expect(startRepl).not.toHaveBeenCalled();
	});
});
