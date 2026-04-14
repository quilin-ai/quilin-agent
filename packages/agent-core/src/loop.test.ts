import { describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";

vi.mock("./logger.js", () => ({
	logger: {
		debug: vi.fn(),
	},
}));

describe("runAgentLoop", () => {
	it("calls the llm with optional tools and returns content", async () => {
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
});
