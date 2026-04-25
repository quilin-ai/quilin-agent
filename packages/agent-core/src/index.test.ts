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

describe("main", () => {
	const exitSpy = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);

	beforeEach(() => {
		vi.clearAllMocks();
		mockCheckpointList.mockReset();
		mockValidateMcpServerConfig.mockReset();
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
		expect(startRepl).toHaveBeenCalledWith({
			provider,
			modelId: "deepseek-chat",
			mcpServers: expectedBuiltinMcpServers(),
		});
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

		expect(startRepl).toHaveBeenCalledWith({
			provider,
			modelId: "deepseek-chat",
			sessionId: "session-123",
			mcpServers: expectedBuiltinMcpServers(),
		});
		expect(mockCheckpointList).not.toHaveBeenCalled();
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
		expect(startRepl).toHaveBeenCalledWith({
			provider,
			modelId: "deepseek-chat",
			sessionId: "latest-session",
			mcpServers: expectedBuiltinMcpServers(),
		});
	});
});
