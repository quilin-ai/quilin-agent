import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider, getDefaultModel } from "./llm/provider.js";
import { configureLogger, logger } from "./logger.js";
import { startRepl } from "./repl.js";
import {
	createMockLanguageModel,
	createMockProvider,
	mockGenerateTextResult,
} from "./test/ai-fixtures.js";

vi.mock("ai", () => ({
	generateText: vi.fn(),
}));

vi.mock("./logger.js", () => ({
	configureLogger: vi.fn(),
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
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

const { mockCheckpointList } = vi.hoisted(() => ({
	mockCheckpointList: vi.fn(),
}));

vi.mock("./state/checkpoint.js", () => ({
	SQLiteCheckpoint: class MockSQLiteCheckpoint {
		list = mockCheckpointList;
	},
}));

const { mockValidateMcpServerConfig } = vi.hoisted(() => ({
	mockValidateMcpServerConfig: vi.fn(),
}));

vi.mock("./tools/mcp-client.js", () => ({
	validateMCPServerConfig: mockValidateMcpServerConfig,
}));

function expectedBuiltinMcpServers() {
	return [
		{
			id: "omnimem",
			namespace: "omnimem",
			config: {
				command: "uv",
				args: ["run", "python", "-m", "omnimem"],
				cwd: expect.stringMatching(/providers\/memory$/u),
			},
		},
	];
}

function stubIsTTY(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	value: boolean,
): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
	Object.defineProperty(stream, "isTTY", {
		configurable: true,
		value,
	});
	return () => {
		if (descriptor == null) {
			delete (stream as { isTTY?: boolean }).isTTY;
			return;
		}
		Object.defineProperty(stream, "isTTY", descriptor);
	};
}

describe("main", () => {
	const exitSpy = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);

	beforeEach(() => {
		vi.clearAllMocks();
		mockCheckpointList.mockReset();
		mockValidateMcpServerConfig.mockReset();
		delete process.env.QUILIN_RUNTIME_MODE;
		process.argv = ["bun", "packages/agent-core/src/index.ts"];
	});

	it("starts the repl only in repl mode", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					promptTokens: 18,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);
		const { main } = await import("./index.js");

		await main({ runtimeMode: "repl" });

		expect(configureLogger).toHaveBeenCalledWith("repl");
		expect(logger.info).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				version: "0.0.1",
				user_config: expect.objectContaining({
					default_model: expect.any(String),
					log_level: expect.any(String),
					safety_trust: expect.any(String),
				}),
			}),
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
			maxOutputTokens: 20,
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
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				provider,
				modelId: "deepseek-chat",
				observability: expect.objectContaining({
					spans: expect.any(Object),
				}),
				spanExporter: expect.any(Object),
				mcpServers: expectedBuiltinMcpServers(),
			}),
		);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("stays in service mode without entering the repl", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		const serviceRunner = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					inputTokens: 21,
					outputTokens: 6,
				},
				finishReason: "stop",
			}),
		);

		const { main } = await import("./index.js");

		await main({ runtimeMode: "service", serviceRunner });

		expect(configureLogger).toHaveBeenCalledWith("service");
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

	it("uses QUILIN_RUNTIME_MODE when runtimeMode is not explicitly passed", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					inputTokens: 1,
					outputTokens: 1,
				},
				finishReason: "stop",
			}),
		);
		process.env.QUILIN_RUNTIME_MODE = "repl";

		const { main } = await import("./index.js");

		await main();

		expect(configureLogger).toHaveBeenCalledWith("repl");
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: "deepseek-chat" }),
		);
	});

	it("uses QUILIN_RUNTIME_MODE=service without entering the repl", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		const serviceRunner = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					inputTokens: 1,
					outputTokens: 1,
				},
				finishReason: "stop",
			}),
		);
		process.env.QUILIN_RUNTIME_MODE = "service";

		const { main } = await import("./index.js");

		await main({ serviceRunner });

		expect(configureLogger).toHaveBeenCalledWith("service");
		expect(serviceRunner).toHaveBeenCalledOnce();
		expect(startRepl).not.toHaveBeenCalled();
	});

	it("falls back to terminal detection when QUILIN_RUNTIME_MODE is invalid", async () => {
		const restoreStdin = stubIsTTY(process.stdin, true);
		const restoreStderr = stubIsTTY(process.stderr, true);
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					inputTokens: 1,
					outputTokens: 1,
				},
				finishReason: "stop",
			}),
		);
		process.env.QUILIN_RUNTIME_MODE = "invalid";

		try {
			const { main } = await import("./index.js");

			await main();
		} finally {
			restoreStdin();
			restoreStderr();
		}

		expect(configureLogger).toHaveBeenCalledWith("repl");
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: "deepseek-chat" }),
		);
	});

	it("falls back to service mode when stdio is not fully interactive", async () => {
		const restoreStdin = stubIsTTY(process.stdin, true);
		const restoreStderr = stubIsTTY(process.stderr, false);
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		const serviceRunner = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					inputTokens: 1,
					outputTokens: 1,
				},
				finishReason: "stop",
			}),
		);

		try {
			const { main } = await import("./index.js");

			await main({ serviceRunner });
		} finally {
			restoreStdin();
			restoreStderr();
		}

		expect(configureLogger).toHaveBeenCalledWith("service");
		expect(serviceRunner).toHaveBeenCalledOnce();
		expect(startRepl).not.toHaveBeenCalled();
	});

	it("logs fatal and exits when LLM verification fails", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		const serviceRunner = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockRejectedValue(new Error("unauthorized"));
		exitSpy.mockImplementationOnce((() => {
			throw new Error("exit");
		}) as never);

		const { main } = await import("./index.js");

		await expect(
			main({ runtimeMode: "service", serviceRunner }),
		).rejects.toThrow("exit");
		expect(logger.fatal).toHaveBeenCalledWith(
			{ err: expect.any(Error) },
			"LLM connection failed",
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(serviceRunner).not.toHaveBeenCalled();
	});

	it("passes the explicit sessionId to the repl when --resume is provided", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					promptTokens: 18,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);
		process.argv = [
			"bun",
			"packages/agent-core/src/index.ts",
			"--resume",
			"session-123",
		];

		const { main } = await import("./index.js");

		await main({ runtimeMode: "repl" });

		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				provider,
				modelId: "deepseek-chat",
				sessionId: "session-123",
				observability: expect.objectContaining({
					sessionId: "session-123",
					spans: expect.any(Object),
				}),
				spanExporter: expect.any(Object),
				mcpServers: expectedBuiltinMcpServers(),
			}),
		);
		expect(mockCheckpointList).not.toHaveBeenCalled();
	});

	it("rejects --resume without a session id after verification", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					promptTokens: 18,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);
		process.argv = ["bun", "packages/agent-core/src/index.ts", "--resume"];

		const { main } = await import("./index.js");

		await expect(main({ runtimeMode: "repl" })).rejects.toThrow(
			"--resume requires a sessionId",
		);
		expect(startRepl).not.toHaveBeenCalled();
	});

	it("loads the newest session when --resume-latest is provided", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					promptTokens: 18,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);
		mockCheckpointList.mockResolvedValue(["latest-session", "older-session"]);
		process.argv = [
			"bun",
			"packages/agent-core/src/index.ts",
			"--resume-latest",
		];

		const { main } = await import("./index.js");

		await main({ runtimeMode: "repl" });

		expect(mockCheckpointList).toHaveBeenCalledTimes(1);
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				provider,
				modelId: "deepseek-chat",
				sessionId: "latest-session",
				observability: expect.objectContaining({
					sessionId: "latest-session",
					spans: expect.any(Object),
				}),
				spanExporter: expect.any(Object),
				mcpServers: expectedBuiltinMcpServers(),
			}),
		);
	});

	it("starts a new session when --resume-latest has no saved sessions", async () => {
		const model = createMockLanguageModel();
		const provider = createMockProvider(() => model);
		vi.mocked(createProvider).mockReturnValue(provider);
		vi.mocked(getDefaultModel).mockReturnValue("deepseek-chat");
		vi.mocked(generateText).mockResolvedValue(
			mockGenerateTextResult({
				text: "Quilin Agent online.",
				usage: {
					promptTokens: 18,
					completionTokens: 5,
				},
				finishReason: "stop",
			}),
		);
		mockCheckpointList.mockResolvedValue([]);
		process.argv = [
			"bun",
			"packages/agent-core/src/index.ts",
			"--resume-latest",
		];

		const { main } = await import("./index.js");

		await main({ runtimeMode: "repl" });

		expect(logger.warn).toHaveBeenCalledWith(
			"No saved sessions found — starting a new session",
		);
		expect(startRepl).toHaveBeenCalledWith(
			expect.not.objectContaining({ sessionId: expect.any(String) }),
		);
	});
});
