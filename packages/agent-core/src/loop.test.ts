import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLoggerRuntimeMode, logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";

vi.mock("./logger.js", () => ({
	getLoggerRuntimeMode: vi.fn(() => "service"),
	logger: {
		debug: vi.fn(),
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
});
