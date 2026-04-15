import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasicContextManager } from "./context/manager.js";

const mockQuestion = vi.fn();
const mockClose = vi.fn();
const mockCreateInterface = vi.fn(() => ({
	question: mockQuestion,
	close: mockClose,
}));
const mockRunAgentLoop = vi.fn();
const mockLoggerError = vi.fn();
const mockStreamingClient = vi.fn();
const mockCheckpointLoad = vi.fn();
const mockCheckpointSave = vi.fn();
const mockCheckpointConstructor = vi.fn();

class MockStreamingLLMClient {
	chat = vi.fn();

	constructor(...args: unknown[]) {
		mockStreamingClient(...args);
	}
}

class MockSQLiteCheckpoint {
	load = mockCheckpointLoad;
	save = mockCheckpointSave;
	list = vi.fn();

	constructor(...args: unknown[]) {
		mockCheckpointConstructor(...args);
	}
}

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
	StreamingLLMClient: MockStreamingLLMClient,
}));

vi.mock("./state/checkpoint.js", () => ({
	SQLiteCheckpoint: MockSQLiteCheckpoint,
}));

describe("startRepl", () => {
	const stdoutWriteSpy = vi.spyOn(process.stdout, "write");
	const stderrWriteSpy = vi.spyOn(process.stderr, "write");
	const capturedMessages: unknown[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		capturedMessages.length = 0;
		mockCheckpointLoad.mockResolvedValue(null);
		mockCheckpointSave.mockResolvedValue(undefined);
		stdoutWriteSpy.mockImplementation(() => true);
		stderrWriteSpy.mockImplementation(() => true);
	});

	afterEach(() => {
		stdoutWriteSpy.mockReset();
		stderrWriteSpy.mockReset();
	});

	it("shows welcome text and exits on /exit", async () => {
		mockQuestion.mockResolvedValueOnce("/exit");
		const tools = [{ name: "memory_recall" }];

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: vi.fn().mockReturnValue("model-instance"),
			modelId: "deepseek-chat",
			tools: tools as never,
		});

		expect(mockCreateInterface).toHaveBeenCalledWith({
			input: process.stdin,
			output: process.stderr,
		});
		expect(mockStreamingClient).toHaveBeenCalledWith(
			"model-instance",
			expect.any(Function),
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"\n🐉 Quilin Agent v0.0.1 (DeepSeek)\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Type your message, or /exit to quit.\n\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("\nBye! 🐉\n");
		expect(stdoutWriteSpy).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalled();
		expect(mockCheckpointSave).toHaveBeenCalledWith({
			messages: [
				expect.objectContaining({
					role: "system",
					content: expect.stringContaining("You are Quilin Agent"),
				}),
			],
			isTerminal: true,
			turnCount: 0,
			createdAt: expect.any(String),
			lastActiveAt: expect.any(String),
		});
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
			tools: [{ name: "memory_recall" }] as never,
		});

		expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				context: expect.any(BasicContextManager),
				tools: [{ name: "memory_recall" }],
			}),
			expect.any(Array),
		);
		expect(capturedMessages[0]).toEqual([
			expect.objectContaining({
				role: "system",
				content: expect.stringContaining("You are Quilin Agent"),
			}),
			{ role: "user", content: "hello" },
		]);
		expect(capturedMessages[1]).toEqual([
			expect.objectContaining({
				role: "system",
				content: expect.stringContaining("You are Quilin Agent"),
			}),
			{ role: "user", content: "after clear" },
		]);
		expect(stderrWriteSpy).toHaveBeenCalledWith("Conversation cleared.\n\n");
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
			tools: [{ name: "memory_recall" }] as never,
		});

		expect(capturedMessages[1]).toEqual([
			expect.objectContaining({
				role: "system",
				content: expect.stringContaining("You are Quilin Agent"),
			}),
			{ role: "user", content: "first" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "second" },
		]);
		expect(mockLoggerError).toHaveBeenCalled();
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"\n[Error: LLM call failed. Check logs for details.]\n\n",
		);
	});

	it("restores a saved session when sessionId is provided", async () => {
		mockQuestion.mockResolvedValueOnce("next").mockResolvedValueOnce("/exit");
		mockCheckpointLoad.mockResolvedValue({
			messages: [
				{ role: "system", content: "restored system prompt" },
				{ role: "user", content: "before" },
				{ role: "assistant", content: "after" },
			],
			isTerminal: false,
			turnCount: 2,
			createdAt: "2026-04-15T00:00:00.000Z",
			lastActiveAt: "2026-04-15T00:01:00.000Z",
		});
		mockRunAgentLoop.mockImplementation(async (_config, messages) => {
			capturedMessages.push(structuredClone(messages));
			return "continued";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: vi.fn().mockReturnValue("model-instance"),
			modelId: "deepseek-chat",
			sessionId: "resume-session",
			tools: [{ name: "memory_recall" }] as never,
		});

		expect(mockCheckpointConstructor).toHaveBeenCalledWith({
			sessionId: "resume-session",
		});
		expect(mockCheckpointLoad).toHaveBeenCalledWith("resume-session");
		expect(capturedMessages[0]).toEqual([
			{ role: "system", content: "restored system prompt" },
			{ role: "user", content: "before" },
			{ role: "assistant", content: "after" },
			{ role: "user", content: "next" },
		]);
	});
});
