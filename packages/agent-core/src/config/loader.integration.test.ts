import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockProvider,
	mockGenerateTextResult,
} from "../test/ai-fixtures.js";

vi.mock("ai", () => ({
	generateText: vi.fn(),
}));

vi.mock("../logger.js", () => ({
	configureLogger: vi.fn(),
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		fatal: vi.fn(),
	},
}));

vi.mock("../llm/provider.js", () => ({
	createProvider: vi.fn(),
	getDefaultModel: vi.fn(),
}));

vi.mock("../repl.js", () => ({
	startRepl: vi.fn(),
}));

const {
	mockCheckpointList,
	mockSkillsManagerConstructor,
	mockValidateMcpServerConfig,
	mockConnect,
	mockDisconnect,
} = vi.hoisted(() => ({
	mockCheckpointList: vi.fn(),
	mockSkillsManagerConstructor: vi.fn(),
	mockValidateMcpServerConfig: vi.fn(),
	mockConnect: vi.fn(),
	mockDisconnect: vi.fn(),
}));

const mockSkillsManagerInstance = {
	discover: vi.fn(),
	startWatching: vi.fn(),
	stopWatching: vi.fn(),
	onCatalogChange: vi.fn(),
	list: vi.fn(() => []),
	postCompactRestore: vi.fn(() => ({ entries: [], totalTokens: 0 })),
	getRecentSkillNames: vi.fn(() => []),
};

vi.mock("../skills/manager.js", () => ({
	SkillsManager: class MockSkillsManager {
		discover = mockSkillsManagerInstance.discover;
		startWatching = mockSkillsManagerInstance.startWatching;
		stopWatching = mockSkillsManagerInstance.stopWatching;
		onCatalogChange = mockSkillsManagerInstance.onCatalogChange;
		list = mockSkillsManagerInstance.list;
		postCompactRestore = mockSkillsManagerInstance.postCompactRestore;
		getRecentSkillNames = mockSkillsManagerInstance.getRecentSkillNames;

		constructor(options: unknown) {
			mockSkillsManagerConstructor(options);
		}
	},
}));

vi.mock("../state/checkpoint.js", () => ({
	SQLiteCheckpoint: class MockSQLiteCheckpoint {
		list = mockCheckpointList;
	},
}));

vi.mock("../tools/mcp-client.js", () => ({
	validateMCPServerConfig: mockValidateMcpServerConfig,
	MCPClientManager: class MockMCPClientManager {
		connect = mockConnect;
		disconnect = mockDisconnect;
	},
}));

function createMockLanguageModel(
	overrides: Partial<Record<string, unknown>> = {},
): LanguageModel {
	return {
		specificationVersion: "v3",
		provider: "mock-provider",
		modelId: "mock-model",
		supportedUrls: {},
		doGenerate: vi.fn(),
		doStream: vi.fn(),
		...overrides,
	} as unknown as LanguageModel;
}

describe("config loader integration", () => {
	const exitSpy = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		process.argv = ["bun", "packages/agent-core/src/index.ts"];
	});

	it("loads JSON fixture into main() and wires SkillsManager plus stub MCP without spawning a process", async () => {
		const model = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});
		const fixturePath = fileURLToPath(
			new URL("../test/fixtures/capabilities.json", import.meta.url),
		);
		const fixtureDir = fileURLToPath(
			new URL("../test/fixtures", import.meta.url),
		);
		const { generateText } = await import("ai");
		const { createProvider, getDefaultModel } = await import(
			"../llm/provider.js"
		);
		const { startRepl } = await import("../repl.js");

		vi.mocked(createProvider).mockReturnValue(createMockProvider(() => model));
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
			"--config",
			fixturePath,
		];

		const { main } = await import("../index.js");

		await main({ runtimeMode: "repl" });

		expect(mockSkillsManagerConstructor).toHaveBeenCalledWith({
			bundledRoots: [
				fileURLToPath(
					new URL("../test/fixtures/bundled-skills", import.meta.url),
				),
			],
			userRoots: [
				fileURLToPath(new URL("../test/fixtures/user-skills", import.meta.url)),
			],
			projectRoots: [
				fileURLToPath(
					new URL("../test/fixtures/project-skills", import.meta.url),
				),
			],
			pluginRoots: [
				fileURLToPath(
					new URL("../test/fixtures/plugin-skills", import.meta.url),
				),
			],
			watcherEnabled: false,
			debounceMs: 125,
		});
		expect(startRepl).toHaveBeenCalledWith({
			provider: expect.any(Function),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "stub-json",
					namespace: "stub-json",
					defaultRiskLevel: "read",
					config: {
						command: "node",
						args: ["stub-server.js"],
						cwd: fixtureDir,
					},
				},
			],
			skillsManager: expect.objectContaining(mockSkillsManagerInstance),
		});
		expect(mockValidateMcpServerConfig).toHaveBeenCalledWith({
			command: "node",
			args: ["stub-server.js"],
			cwd: fixtureDir,
		});
		expect(mockConnect).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("loads YAML fixture into main() and preserves parsed debounce/namespace fields", async () => {
		const model = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});
		const fixturePath = fileURLToPath(
			new URL("../test/fixtures/capabilities.yaml", import.meta.url),
		);
		const fixtureDir = fileURLToPath(
			new URL("../test/fixtures", import.meta.url),
		);
		const { generateText } = await import("ai");
		const { createProvider, getDefaultModel } = await import(
			"../llm/provider.js"
		);
		const { startRepl } = await import("../repl.js");

		vi.mocked(createProvider).mockReturnValue(createMockProvider(() => model));
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
			"--config",
			fixturePath,
		];

		const { main } = await import("../index.js");

		await main({ runtimeMode: "repl" });

		expect(mockSkillsManagerConstructor).toHaveBeenCalledWith({
			bundledRoots: [
				fileURLToPath(
					new URL("../test/fixtures/bundled-skills", import.meta.url),
				),
			],
			userRoots: [
				fileURLToPath(new URL("../test/fixtures/user-skills", import.meta.url)),
			],
			projectRoots: [
				fileURLToPath(
					new URL("../test/fixtures/project-skills", import.meta.url),
				),
			],
			pluginRoots: [
				fileURLToPath(
					new URL("../test/fixtures/plugin-skills", import.meta.url),
				),
			],
			watcherEnabled: false,
			debounceMs: 250,
		});
		expect(startRepl).toHaveBeenCalledWith({
			provider: expect.any(Function),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "stub-yaml",
					namespace: "stub-yaml",
					defaultRiskLevel: "exec",
					config: {
						command: "node",
						args: ["stub-server.js"],
						cwd: fixtureDir,
					},
				},
			],
			skillsManager: expect.objectContaining(mockSkillsManagerInstance),
		});
		expect(mockValidateMcpServerConfig).toHaveBeenCalledWith({
			command: "node",
			args: ["stub-server.js"],
			cwd: fixtureDir,
		});
		expect(mockConnect).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(0);
	});
});
