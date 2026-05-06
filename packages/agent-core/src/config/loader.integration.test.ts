import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const createdDirs: string[] = [];

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

async function createTempWorkspace(): Promise<string> {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "quilin-loader-"));
	createdDirs.push(workspaceRoot);
	return workspaceRoot;
}

async function writeCapabilitiesFile(
	workspaceRoot: string,
	fileName: string,
	content: string,
): Promise<string> {
	const directory = join(workspaceRoot, ".quilin");
	await mkdir(directory, { recursive: true });
	const filePath = join(directory, fileName);
	await writeFile(filePath, content, "utf8");
	return filePath;
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

	afterEach(async () => {
		await Promise.all(
			createdDirs
				.splice(0)
				.map((directory) => rm(directory, { recursive: true, force: true })),
		);
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
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: expect.any(Function),
				modelId: "deepseek-chat",
				capabilitiesRuntime: expect.any(Function),
				observability: expect.objectContaining({
					spans: expect.any(Object),
				}),
				spanExporter: expect.any(Object),
			}),
		);
		const runtime = vi
			.mocked(startRepl)
			.mock.calls[0]?.[0]?.capabilitiesRuntime?.();
		expect(runtime?.mcpServers).toEqual([
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
		]);
		expect(runtime?.skillsManager).toEqual(
			expect.objectContaining(mockSkillsManagerInstance),
		);
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
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: expect.any(Function),
				modelId: "deepseek-chat",
				capabilitiesRuntime: expect.any(Function),
				observability: expect.objectContaining({
					spans: expect.any(Object),
				}),
				spanExporter: expect.any(Object),
			}),
		);
		const runtime = vi
			.mocked(startRepl)
			.mock.calls[0]?.[0]?.capabilitiesRuntime?.();
		expect(runtime?.mcpServers).toEqual([
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
		]);
		expect(runtime?.skillsManager).toEqual(
			expect.objectContaining(mockSkillsManagerInstance),
		);
		expect(mockValidateMcpServerConfig).toHaveBeenCalledWith({
			command: "node",
			args: ["stub-server.js"],
			cwd: fixtureDir,
		});
		expect(mockConnect).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("lets explicit watcherEnabled override reloadStrategy", async () => {
		const workspaceRoot = await createTempWorkspace();
		const fixturePath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			JSON.stringify(
				{
					schema_version: 1,
					mcpServers: {
						stub: {
							command: "node",
							args: ["stub-server.js"],
							cwd: ".",
							namespace: "stub",
						},
					},
					skills: {
						enabled: true,
						bundledRoots: ["./bundled-skills"],
						userRoots: ["./user-skills"],
						projectRoots: ["./project-skills"],
						pluginRoots: ["./plugin-skills"],
						reloadStrategy: "manual",
						watcherEnabled: true,
						debounceMs: 75,
					},
				},
				null,
				2,
			),
		);
		const fixtureDir = join(workspaceRoot, ".quilin");
		const { generateText } = await import("ai");
		const { createProvider, getDefaultModel } = await import(
			"../llm/provider.js"
		);
		const { startRepl } = await import("../repl.js");
		const model = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});

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
			bundledRoots: [join(fixtureDir, "bundled-skills")],
			userRoots: [join(fixtureDir, "user-skills")],
			projectRoots: [join(fixtureDir, "project-skills")],
			pluginRoots: [join(fixtureDir, "plugin-skills")],
			watcherEnabled: true,
			debounceMs: 75,
		});
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilitiesRuntime: expect.any(Function),
			}),
		);
		const runtime = vi
			.mocked(startRepl)
			.mock.calls[0]?.[0]?.capabilitiesRuntime?.();
		expect(runtime?.skillsManager).toEqual(
			expect.objectContaining(mockSkillsManagerInstance),
		);
		expect(runtime?.mcpServers).toEqual([
			{
				id: "stub",
				namespace: "stub",
				config: {
					command: "node",
					args: ["stub-server.js"],
					cwd: fixtureDir,
				},
			},
		]);
	});

	it("lets explicit watcherEnabled disable watch mode even when reloadStrategy requests it", async () => {
		const workspaceRoot = await createTempWorkspace();
		const fixtureDir = join(workspaceRoot, ".quilin");
		const fixturePath = await writeCapabilitiesFile(
			workspaceRoot,
			"capabilities.json",
			JSON.stringify(
				{
					schema_version: 1,
					mcpServers: {
						stub: {
							command: "node",
							args: ["stub-server.js"],
							cwd: ".",
							namespace: "stub",
						},
					},
					skills: {
						enabled: true,
						bundledRoots: ["./bundled-skills"],
						userRoots: ["./user-skills"],
						projectRoots: ["./project-skills"],
						pluginRoots: ["./plugin-skills"],
						reloadStrategy: "watch",
						watcherEnabled: false,
						debounceMs: 90,
					},
				},
				null,
				2,
			),
		);
		const { generateText } = await import("ai");
		const { createProvider, getDefaultModel } = await import(
			"../llm/provider.js"
		);
		const { startRepl } = await import("../repl.js");
		const model = createMockLanguageModel({
			provider: "deepseek",
			modelId: "deepseek-chat",
		});

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
			bundledRoots: [join(fixtureDir, "bundled-skills")],
			userRoots: [join(fixtureDir, "user-skills")],
			projectRoots: [join(fixtureDir, "project-skills")],
			pluginRoots: [join(fixtureDir, "plugin-skills")],
			watcherEnabled: false,
			debounceMs: 90,
		});
		expect(startRepl).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilitiesRuntime: expect.any(Function),
			}),
		);
		const runtime = vi
			.mocked(startRepl)
			.mock.calls[0]?.[0]?.capabilitiesRuntime?.();
		expect(runtime?.skillsManager).toEqual(
			expect.objectContaining(mockSkillsManagerInstance),
		);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});
});
