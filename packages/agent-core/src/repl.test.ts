import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuestion = vi.fn();
const mockClose = vi.fn();
const mockCreateInterface = vi.fn(() => ({
	question: mockQuestion,
	close: mockClose,
}));
const mockRunAgentLoop = vi.fn();
const mockLoggerError = vi.fn();
const mockStreamingClient = vi.fn();

vi.mock("node:readline/promises", () => ({
	createInterface: mockCreateInterface,
}));

vi.mock("./loop.js", () => ({
	runAgentLoop: mockRunAgentLoop,
}));

vi.mock("./logger.js", () => ({
	logger: {
		error: mockLoggerError,
	},
}));

vi.mock("./llm/client.js", () => ({
	StreamingLLMClient: vi.fn().mockImplementation((...args) => {
		mockStreamingClient(...args);
		return { chat: vi.fn() };
	}),
}));

describe("startRepl", () => {
	const writeSpy = vi.spyOn(process.stdout, "write");
	const capturedMessages: unknown[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		capturedMessages.length = 0;
		writeSpy.mockImplementation(() => true);
	});

	afterEach(() => {
		writeSpy.mockReset();
	});

	it("shows welcome text and exits on /exit", async () => {
		mockQuestion.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: vi.fn().mockReturnValue("model-instance"),
			modelId: "deepseek-chat",
		});

		expect(mockCreateInterface).toHaveBeenCalled();
		expect(mockStreamingClient).toHaveBeenCalledWith(
			"model-instance",
			expect.any(Function),
		);
		expect(writeSpy).toHaveBeenCalledWith("\n🐉 Quilin Agent v0.0.1 (DeepSeek)\n");
		expect(writeSpy).toHaveBeenCalledWith("Type your message, or /exit to quit.\n\n");
		expect(writeSpy).toHaveBeenCalledWith("\nBye! 🐉\n");
		expect(mockClose).toHaveBeenCalled();
	});

	it("clears history and sends only the fresh conversation", async () => {
		mockQuestion
			.mockResolvedValueOnce("hello")
			.mockResolvedValueOnce("/clear")
			.mockResolvedValueOnce("after clear")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async (_config, messages) => {
			capturedMessages.push(structuredClone(messages));
			return capturedMessages.length === 1 ? "first reply" : "second reply";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: vi.fn().mockReturnValue("model-instance"),
			modelId: "deepseek-chat",
		});

		expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
		expect(capturedMessages[0]).toEqual([
			expect.objectContaining({ role: "system" }),
			{ role: "user", content: "hello" },
		]);
		expect(capturedMessages[1]).toEqual([
			expect.objectContaining({ role: "system" }),
			{ role: "user", content: "after clear" },
		]);
		expect(writeSpy).toHaveBeenCalledWith("Conversation cleared.\n\n");
	});

	it("rolls back the failed user message", async () => {
		mockQuestion
			.mockResolvedValueOnce("first")
			.mockResolvedValueOnce("second")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async (_config, messages) => {
			capturedMessages.push(structuredClone(messages));
			if (capturedMessages.length === 1) {
				return "ok";
			}

			throw new Error("boom");
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: vi.fn().mockReturnValue("model-instance"),
			modelId: "deepseek-chat",
		});

		expect(capturedMessages[1]).toEqual([
			expect.objectContaining({ role: "system" }),
			{ role: "user", content: "first" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "second" },
		]);
		expect(mockLoggerError).toHaveBeenCalled();
		expect(writeSpy).toHaveBeenCalledWith(
			"\n[Error: LLM call failed. Check logs for details.]\n\n",
		);
	});
});
