import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BasicContextManager } from "./context/manager.js";
import {
	createMockLanguageModel,
	createMockProvider,
} from "./test/ai-fixtures.js";
import type { ToolWithMetadata } from "./tools/tool-metadata.js";

const mockQuestion = vi.fn();
const mockClose = vi.fn();
const mockPrompt = vi.fn();
type MockReadlineListener = (...args: readonly unknown[]) => void;
const mockReadlineListeners = new Map<string, Set<MockReadlineListener>>();
type MockReadlineInterface = {
	readonly question: typeof mockQuestion;
	readonly close: typeof mockClose;
	readonly prompt: typeof mockPrompt;
	readonly on?: (event: string, listener: MockReadlineListener) => unknown;
	readonly off?: (event: string, listener: MockReadlineListener) => unknown;
	readonly line?: string;
	readonly getCursorPos?: () => unknown;
};
let mockReadlineInterface: MockReadlineInterface;
const mockReadlineOn = vi.fn(
	(event: string, listener: MockReadlineListener) => {
		const listeners = mockReadlineListeners.get(event) ?? new Set();
		listeners.add(listener);
		mockReadlineListeners.set(event, listeners);
		return mockReadlineInterface;
	},
);
const mockReadlineOff = vi.fn(
	(event: string, listener: MockReadlineListener) => {
		mockReadlineListeners.get(event)?.delete(listener);
		return mockReadlineInterface;
	},
);
const mockCreateInterface = vi.fn((): MockReadlineInterface => {
	mockReadlineInterface = {
		question: mockQuestion,
		close: mockClose,
		prompt: mockPrompt,
		on: mockReadlineOn,
		off: mockReadlineOff,
	};
	return mockReadlineInterface;
});
const mockRunAgentLoop = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockStreamingClient = vi.fn();
const mockProviderControlPlaneClient = vi.fn();
const mockCheckpointLoad = vi.fn();
const mockCheckpointSave = vi.fn();
const mockCheckpointListSessions = vi.fn();
const mockCheckpointConstructor = vi.fn();
const mockCreateBuiltinTools = vi.fn();
const mockRegistryRegisterBuiltin = vi.fn();
const mockRegistryClearBuiltinTools = vi.fn();
const mockRegistryRegisterImplementation = vi.fn();
const mockRegistryRegister = vi.fn();
const mockRegistryUnregister = vi.fn();
const mockRegistryGetAllTools = vi.fn();
const mockRegistryGetToolDescriptors = vi.fn();
const mockRegistryDisconnectAll = vi.fn();
const mockRegistryOnChange = vi.fn((_listener: () => void) => () => undefined);
const mockRegistryConstructor = vi.fn();
let capturedStreamCallback:
	| ((event: Record<string, unknown>) => void)
	| undefined;
let capturedProviderControlPlaneInstance:
	| MockProviderControlPlaneLLMClient
	| undefined;

const registryBuiltinTools: ToolWithMetadata[] = [];
const registryServerToolsById = new Map<string, ToolWithMetadata[]>();
const registryChangeListeners: Array<() => void> = [];

function setProcessTty(
	stream: typeof process.stdin | typeof process.stderr,
	value: boolean,
): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
	Object.defineProperty(stream, "isTTY", {
		configurable: true,
		value,
	});

	return () => {
		if (descriptor == null) {
			Reflect.deleteProperty(stream, "isTTY");
			return;
		}
		Object.defineProperty(stream, "isTTY", descriptor);
	};
}

function emitMockReadlineEvent(
	event: string,
	...args: readonly unknown[]
): void {
	for (const listener of [...(mockReadlineListeners.get(event) ?? [])]) {
		listener(...args);
	}
}

function createToolWithMetadata(
	name: string,
	description: string,
	riskLevel: ToolWithMetadata["riskLevel"] = "read",
): ToolWithMetadata {
	return {
		name,
		description,
		parameters: z.object({}),
		execute: vi.fn(),
		category: "programmatic",
		riskLevel,
	};
}

function createSecretProviderError(messagePrefix = "provider failed"): Error {
	const secretMessage = `${messagePrefix} token=secret Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 sk-abcdefghijklmnopqrstuvwxyz012345`;
	const error = Object.assign(new Error(secretMessage), {
		name: "ProviderAuthError",
		code: "AUTH_FAILED",
		category: "auth",
	});
	error.stack = `ProviderAuthError: ${secretMessage}\n    at providerSecretFrame`;
	return error;
}

function createSupervisorSnapshot(
	records: readonly Record<string, unknown>[],
	options: {
		readonly snapshot?: Record<string, unknown>;
		readonly events?: readonly Record<string, unknown>[];
	} = {},
) {
	const counts = {
		queued: 0,
		assigned: 0,
		active: 0,
		blocked: 0,
		waiting_for_review: 0,
		aggregating: 0,
		cancel_requested: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		deferred: 0,
	};
	for (const record of records) {
		const status = record.status as keyof typeof counts;
		counts[status] += 1;
	}
	const nonTerminalRecords = records.filter(
		(record) =>
			!["completed", "failed", "cancelled", "deferred"].includes(
				String(record.status),
			),
	);
	const activeRunIds = nonTerminalRecords
		.filter((record) =>
			[
				"active",
				"blocked",
				"waiting_for_review",
				"aggregating",
				"cancel_requested",
			].includes(String(record.status)),
		)
		.map((record) => String(record.runId));
	const queuedRunIds = nonTerminalRecords
		.filter((record) => ["queued", "assigned"].includes(String(record.status)))
		.map((record) => String(record.runId));
	const blockedRunIds = nonTerminalRecords
		.filter((record) => record.status === "blocked" || record.blocker != null)
		.map((record) => String(record.runId));
	const terminalRunIds = records
		.filter((record) =>
			["completed", "failed", "cancelled", "deferred"].includes(
				String(record.status),
			),
		)
		.map((record) => String(record.runId));

	return {
		records,
		projection: {
			snapshot: {
				generatedAt: "2026-05-06T00:00:03.000Z",
				totalRuns: records.length,
				counts,
				activeRunIds,
				queuedRunIds,
				blockedRunIds,
				staleRunIds: [],
				terminalRunIds,
				oldestHeartbeatAgeMs: null,
				nextCheckpointAt: null,
				band:
					records.length === 0
						? "idle"
						: nonTerminalRecords.length === 0
							? "done"
							: blockedRunIds.length > 0
								? "blocked"
								: activeRunIds.length > 0
									? "making_progress"
									: "starting",
				boundedPercent: null,
				currentSteps: nonTerminalRecords
					.map((record) => record.currentStep)
					.filter((step): step is string => typeof step === "string"),
				blockers: nonTerminalRecords
					.map((record) => record.blocker)
					.filter((blocker): blocker is string => typeof blocker === "string"),
				reviewedArtifactCount: records.reduce(
					(total, record) =>
						total +
						(typeof record.reviewedArtifactCount === "number"
							? record.reviewedArtifactCount
							: 0),
					0,
				),
				confidence: "unknown",
				...options.snapshot,
			},
			events: options.events ?? [],
		},
	};
}

class MockStreamingLLMClient {
	chat = vi.fn();

	constructor(...args: unknown[]) {
		mockStreamingClient(...args);
		capturedStreamCallback = args.find(
			(arg): arg is (event: Record<string, unknown>) => void =>
				typeof arg === "function",
		);
	}
}

class MockProviderControlPlaneLLMClient {
	chat = vi.fn();

	constructor(
		readonly delegate: unknown,
		readonly options: unknown,
	) {
		mockProviderControlPlaneClient(delegate, options);
		capturedProviderControlPlaneInstance = this;
		this.chat.mockImplementation(async (_messages, _tools, config) => {
			const routeRequest = (
				options as {
					routeRequest?: { provider?: string; model?: string };
					tierRouting?: {
						mode?: "auto" | "flash" | "lite" | "pro";
						defaultTier?: "flash" | "lite" | "pro";
						tiers?: Record<
							"flash" | "lite" | "pro",
							{
								provider: string;
								model: string;
								thinkingMode: string;
							}
						>;
					};
					onRunRecord?: (record: unknown) => void;
				}
			).routeRequest;
			const tierRouting = (
				options as {
					tierRouting?: {
						mode?: "auto" | "flash" | "lite" | "pro";
						defaultTier?: "flash" | "lite" | "pro";
						tiers?: Record<
							"flash" | "lite" | "pro",
							{
								provider: string;
								model: string;
								thinkingMode: string;
							}
						>;
					};
				}
			).tierRouting;
			const selectedTier =
				tierRouting?.mode == null || tierRouting.mode === "auto"
					? tierRouting?.defaultTier
					: tierRouting.mode;
			const selectedProfile =
				selectedTier == null ? undefined : tierRouting?.tiers?.[selectedTier];
			const provider =
				selectedProfile?.provider ?? routeRequest?.provider ?? "deepseek";
			const configuredModel =
				selectedProfile?.model ?? routeRequest?.model ?? "deepseek-chat";
			const thinkingMode =
				selectedProfile?.thinkingMode ??
				(config as { thinkingMode?: string }).thinkingMode;
			const effectiveModel =
				provider === "deepseek" &&
				configuredModel === "deepseek-chat" &&
				thinkingMode !== "disabled"
					? "deepseek-reasoner"
					: configuredModel;
			const record = {
				route: {
					provider,
					configuredModel,
					effectiveModel,
					fallbackUsed: false,
					...(selectedTier == null ? {} : { selectedTier }),
					...(tierRouting?.mode == null
						? {}
						: { routingMode: tierRouting.mode }),
					...(selectedTier == null
						? {}
						: { routeReason: `forced_${selectedTier}` }),
					...(selectedTier == null ? {} : { thinkingMode }),
					reasoningStateAdapter:
						thinkingMode === "disabled"
							? "none"
							: provider === "deepseek"
								? "captured_replayed_for_tool_calls"
								: "captured_not_replayed",
				},
				attempts: [
					{
						attemptNumber: 1,
						provider,
						model: effectiveModel,
						startedAt: "2026-05-02T00:00:00.000Z",
						completedAt: "2026-05-02T00:00:01.000Z",
						outcome: "success",
						usage: { inputTokens: 3, outputTokens: 5 },
					},
				],
				outcome: "success",
				fallbackUsed: false,
			};
			(
				options as {
					onRunRecord?: (record: unknown) => void;
				}
			).onRunRecord?.(record);

			return {
				content: "ok",
				usage: { inputTokens: 3, outputTokens: 5 },
				finishReason: "stop",
			};
		});
	}
}

class MockSQLiteCheckpoint {
	load = mockCheckpointLoad;
	save = mockCheckpointSave;
	list = vi.fn();
	listSessions = mockCheckpointListSessions;

	constructor(...args: unknown[]) {
		mockCheckpointConstructor(...args);
	}
}

class MockMCPRegistry {
	registerBuiltin = mockRegistryRegisterBuiltin;
	clearBuiltinTools = mockRegistryClearBuiltinTools;
	register = mockRegistryRegister;
	unregister = mockRegistryUnregister;
	getAllTools = mockRegistryGetAllTools;
	getToolDescriptors = mockRegistryGetToolDescriptors;
	disconnectAll = mockRegistryDisconnectAll;
	onChange = mockRegistryOnChange;

	constructor(...args: unknown[]) {
		mockRegistryConstructor(...args);
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
		warn: mockLoggerWarn,
	},
}));

vi.mock("./llm/client.js", () => ({
	normalizeProviderError: (error: unknown) => {
		if (typeof error !== "object" || error == null) {
			return { name: "Error", message: "Provider error details redacted." };
		}
		const record = error as Record<string, unknown>;

		return {
			name: typeof record.name === "string" ? record.name : "Error",
			message: "Provider error details redacted.",
			...(typeof record.code === "string" ? { code: record.code } : {}),
			...(typeof record.category === "string"
				? { category: record.category }
				: {}),
		};
	},
	ProviderControlPlaneLLMClient: MockProviderControlPlaneLLMClient,
	StreamingLLMClient: MockStreamingLLMClient,
}));

vi.mock("./state/checkpoint.js", () => ({
	SQLiteCheckpoint: MockSQLiteCheckpoint,
}));

vi.mock("./tools/builtin/index.js", () => ({
	createBuiltinTools: mockCreateBuiltinTools,
}));

vi.mock("./tools/registry.js", () => ({
	MCPRegistry: MockMCPRegistry,
}));

describe("startRepl", () => {
	const stdoutWriteSpy = vi.spyOn(process.stdout, "write");
	const stderrWriteSpy = vi.spyOn(process.stderr, "write");
	const randomUUIDSpy = vi.spyOn(crypto, "randomUUID");
	const capturedMessages: unknown[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		capturedStreamCallback = undefined;
		capturedProviderControlPlaneInstance = undefined;
		capturedMessages.length = 0;
		registryBuiltinTools.length = 0;
		registryServerToolsById.clear();
		registryChangeListeners.length = 0;
		mockReadlineListeners.clear();
		randomUUIDSpy.mockReturnValue("00000000-0000-0000-0000-000000000000");
		mockCheckpointLoad.mockResolvedValue(null);
		mockCheckpointSave.mockResolvedValue(undefined);
		stdoutWriteSpy.mockImplementation(() => true);
		stderrWriteSpy.mockImplementation(() => true);
		mockCreateBuiltinTools.mockReturnValue([
			createToolWithMetadata("file_read", "Read a file with numbered lines."),
			createToolWithMetadata("shell_exec", "Execute a shell command.", "exec"),
		]);
		mockRegistryRegisterBuiltin.mockImplementation(
			(tools: readonly ToolWithMetadata[]) => {
				registryBuiltinTools.push(...tools);
			},
		);
		mockRegistryClearBuiltinTools.mockImplementation(() => {
			registryBuiltinTools.length = 0;
		});
		mockRegistryRegister.mockImplementation(async (entry: unknown) => {
			const tools = await mockRegistryRegisterImplementation(entry);
			registryServerToolsById.set((entry as { id?: string }).id ?? "unknown", [
				...tools,
			]);
			return tools;
		});
		mockRegistryUnregister.mockImplementation(async (serverId: string) => {
			registryServerToolsById.delete(serverId);
		});
		mockRegistryRegisterImplementation.mockResolvedValue([]);
		mockRegistryGetAllTools.mockImplementation(() => [
			...registryBuiltinTools,
			...[...registryServerToolsById.values()].flat(),
		]);
		mockRegistryGetToolDescriptors.mockImplementation(() =>
			[...registryBuiltinTools, ...[...registryServerToolsById.values()].flat()]
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					category: tool.category,
					riskLevel: tool.riskLevel,
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
		);
		mockRegistryOnChange.mockImplementation((listener: () => void) => {
			registryChangeListeners.push(listener);
			return () => undefined;
		});
		mockRegistryDisconnectAll.mockResolvedValue(undefined);
	});

	afterEach(() => {
		randomUUIDSpy.mockReset();
		stdoutWriteSpy.mockReset();
		stderrWriteSpy.mockReset();
	});

	it("shows welcome text and exits on /exit", async () => {
		mockQuestion.mockResolvedValueOnce("/exit");
		const tools = [{ name: "memory_recall", description: "Recall memory" }];

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			tools: tools as never,
		});

		expect(mockCreateInterface).toHaveBeenCalledWith({
			input: process.stdin,
			output: process.stderr,
		});
		expect(mockStreamingClient).toHaveBeenCalledWith(
			{
				model: expect.objectContaining({
					specificationVersion: "v3",
					provider: "mock-provider",
					modelId: "mock-model",
				}),
				resolveModel: expect.any(Function),
			},
			expect.any(Function),
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"\n🐉 Quilin Agent v0.0.3 (DeepSeek)\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Session: 00000000-0000-0000-0000-000000000000 (new)\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Type your message, or / to list commands. /exit to quit.\n\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("\nBye! 🐉\n");
		expect(stdoutWriteSpy).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalled();
		expect(mockCheckpointConstructor).toHaveBeenCalledWith({
			sessionId: "00000000-0000-0000-0000-000000000000",
		});
		expect(mockCreateBuiltinTools).toHaveBeenCalledTimes(1);
		// Regression guard: repl.ts must wire both toolSearch + subagentSpawn
		// options into createBuiltinTools, otherwise tool_search and
		// subagent_spawn never reach the registry (see git history around
		// commits a6925d3 / ffcbc6a).
		const builtinOptions = mockCreateBuiltinTools.mock.calls[0]?.[0] as
			| {
					toolSearch?: { getTools?: () => unknown };
					subagentSpawn?: { getLoopConfig?: () => unknown };
					configView?: { getRuntimeState?: () => unknown };
					sessionList?: { checkpoint?: unknown };
			  }
			| undefined;
		expect(typeof builtinOptions?.toolSearch?.getTools).toBe("function");
		expect(typeof builtinOptions?.subagentSpawn?.getLoopConfig).toBe(
			"function",
		);
		expect(typeof builtinOptions?.configView?.getRuntimeState).toBe(
			"function",
		);
		expect(builtinOptions?.sessionList?.checkpoint).toBeDefined();
		expect(mockRegistryRegisterBuiltin).toHaveBeenNthCalledWith(
			1,
			expect.arrayContaining([
				expect.objectContaining({ name: "file_read" }),
				expect.objectContaining({ name: "shell_exec", riskLevel: "exec" }),
			]),
		);
		expect(mockRegistryRegisterBuiltin).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining([
				expect.objectContaining({
					name: "memory_recall",
					category: "programmatic",
					riskLevel: "read",
				}),
			]),
		);
		expect(mockRegistryDisconnectAll).toHaveBeenCalledTimes(1);
		expect(mockCheckpointSave).toHaveBeenCalledWith({
			messages: [],
			isTerminal: true,
			turnCount: 0,
			createdAt: expect.any(String),
			lastActiveAt: expect.any(String),
		});
	});

	it("emits provider run records through the DeepSeek runtime control plane", async () => {
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async (config) => {
			await config.llm.chat([], [], {
				temperature: 0.7,
				maxTokens: 4096,
				thinkingMode: "enabled",
			});
			return "ok";
		});
		const records: unknown[] = [];

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
			onProviderRunRecord: (record) => records.push(record),
		});

		const [delegate, controlPlaneOptions] =
			mockProviderControlPlaneClient.mock.calls[0] ?? [];
		expect(delegate).toBeInstanceOf(MockStreamingLLMClient);
		expect(controlPlaneOptions).toEqual(
			expect.objectContaining({
				routeRequest: {
					provider: "deepseek",
					model: "deepseek-chat",
				},
				onRunRecord: expect.any(Function),
			}),
		);
		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				llm: capturedProviderControlPlaneInstance,
			}),
			expect.any(Array),
		);

		expect(records).toEqual([
			expect.objectContaining({
				route: {
					provider: "deepseek",
					configuredModel: "deepseek-chat",
					effectiveModel: "deepseek-reasoner",
					fallbackUsed: false,
					reasoningStateAdapter: "captured_replayed_for_tool_calls",
				},
				attempts: [
					expect.objectContaining({
						provider: "deepseek",
						model: "deepseek-reasoner",
						outcome: "success",
						usage: { inputTokens: 3, outputTokens: 5 },
					}),
				],
				outcome: "success",
				fallbackUsed: false,
			}),
		]);
	});

	it("does not fail a successful turn when the provider run observer throws", async () => {
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async (config) => {
			await config.llm.chat([], [], {
				temperature: 0.7,
				maxTokens: 4096,
				thinkingMode: "enabled",
			});
			return "ok";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
			onProviderRunRecord: () => {
				throw createSecretProviderError("observer failed");
			},
		});

		expect(mockLoggerError).not.toHaveBeenCalledWith(
			expect.anything(),
			"REPL: LLM call failed",
		);
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			{
				error: {
					name: "ProviderAuthError",
					code: "AUTH_FAILED",
					category: "auth",
				},
			},
			"REPL: provider run callback failed",
		);
		expect(stderrWriteSpy).not.toHaveBeenCalledWith(
			"\n[Error: LLM call failed. Check logs for details.]\n\n",
		);
	});

	it("records REPL input, provider run, source provenance, and flushes run logs", async () => {
		const runLogRecords: Array<{
			phase: string;
			payload?: Record<string, unknown>;
		}> = [];
		const agentRunLogger = {
			record: vi.fn(async (input) => {
				runLogRecords.push(input);
			}),
			flush: vi.fn(async () => undefined),
		};
		mockQuestion
			.mockResolvedValueOnce("search codex")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async (config, messages) => {
			await config.llm.chat([], [], {
				temperature: 0.7,
				maxTokens: 4096,
				thinkingMode: "enabled",
			});
			const toolCall = {
				id: "call-web",
				name: "web_fetch",
				arguments: { url: "https://example.com/search?q=codex" },
			};
			const toolResult = {
				toolCallId: "call-web",
				isError: false,
				content: JSON.stringify({
					url: "https://example.com/search?q=codex",
					status: 200,
					contentType: "text/html",
					body: "Codex",
				}),
			};
			await config.hooks?.onToolResult?.({
				toolCall,
				toolResult,
				actionVerification: {
					layer: 2,
					decision: "allow",
					code: "allowed",
					reason: "test",
				},
				scanResult: {
					safe: true,
					threats: [],
					sanitizedContent: toolResult.content,
				},
				sanitizedContent: toolResult.content,
				trustedToolOutput: false,
				hasBlockedThreat: false,
			});
			await config.hooks?.onMessagesUpdated?.(
				[...messages, { role: "assistant", content: "done" }],
				{ phase: "assistant_response", turnCount: 1 },
			);
			return "done";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			agentRunLogger,
		});

		expect(runLogRecords.map((record) => record.phase)).toEqual(
			expect.arrayContaining([
				"repl.session_started",
				"turn.input_received",
				"llm.provider_run",
				"tool.provenance_recorded",
			]),
		);
		const inputRecord = runLogRecords.find(
			(record) => record.phase === "turn.input_received",
		);
		expect(inputRecord?.payload?.input).toMatchObject({
			chars: 12,
			previewRedacted: true,
		});
		const provenanceRecord = runLogRecords.find(
			(record) => record.phase === "tool.provenance_recorded",
		);
		expect(provenanceRecord?.payload?.provenance).toMatchObject({
			sourceType: "url",
			url: "https://example.com/[path-redacted]?[redacted]",
			status: 200,
			auditOutcome: "usable_evidence",
			usableEvidence: true,
		});
		expect(agentRunLogger.flush).toHaveBeenCalledTimes(1);
	});

	it("queues live input entered during an active turn as the next user turn", async () => {
		const runLogRecords: Array<{
			phase: string;
			payload?: Record<string, unknown>;
			context?: { turnId?: string };
		}> = [];
		const agentRunLogger = {
			record: vi.fn(async (input) => {
				runLogRecords.push(input);
			}),
			flush: vi.fn(async () => undefined),
		};
		let secondTurnMessages: unknown;
		mockQuestion
			.mockResolvedValueOnce("start work")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop
			.mockImplementationOnce(async () => {
				emitMockReadlineEvent("line", "follow up while running");
				return "first reply";
			})
			.mockImplementationOnce(async (_config, messages) => {
				secondTurnMessages = [...messages];
				return "second reply";
			});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			agentRunLogger,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Live input queued for current turn: 23 chars.\n",
		);
		expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
		expect(secondTurnMessages).toEqual([
			{ role: "user", content: "start work" },
			{ role: "assistant", content: "first reply" },
			{ role: "user", content: "follow up while running" },
		]);
		expect(runLogRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phase: "turn.live_input_received",
					turnId: "00000000-0000-0000-0000-000000000000",
					payload: expect.objectContaining({
						kind: "message",
						queuedFor: "next_turn",
						input: {
							chars: 23,
							previewRedacted: true,
						},
					}),
				}),
			]),
		);
		expect(agentRunLogger.flush).toHaveBeenCalledTimes(1);
	});

	it("queues /agents entered during an active turn and renders it before the next prompt", async () => {
		mockQuestion
			.mockResolvedValueOnce("start work")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementationOnce(async () => {
			emitMockReadlineEvent("line", "/agents");
			return "first reply";
		});
		const supervisorRuntime = {
			snapshot: vi.fn(() =>
				createSupervisorSnapshot(
					[
						{
							runId: "run-live",
							taskId: "task-live",
							status: "active",
							summary: "Still running",
							currentStep: "heartbeat",
							confidence: "medium",
							reviewedArtifactCount: 0,
							lastHeartbeatAt: "2026-05-06T00:01:00.000Z",
							updatedAt: "2026-05-06T00:01:00.000Z",
						},
					],
					{
						snapshot: {
							band: "making_progress",
							oldestHeartbeatAgeMs: 5_000,
						},
						events: [
							{
								schemaVersion: 1,
								id: "child_heartbeat:run-live:task-live:2026-05-06T00:01:00.000Z",
								type: "child_heartbeat",
								severity: "info",
								occurredAt: "2026-05-06T00:01:00.000Z",
								runId: "run-live",
								taskId: "task-live",
								payload: {
									status: "active",
									summary: "Still running",
									currentStep: "heartbeat",
									confidence: "medium",
									reviewedArtifactCount: 0,
									lastHeartbeatAt: "2026-05-06T00:01:00.000Z",
									heartbeatAgeMs: 5_000,
								},
							},
						],
					},
				),
			),
		};

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			supervisorRuntime: supervisorRuntime as never,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Command queued for current turn: /agents\n",
		);
		expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
		expect(supervisorRuntime.snapshot).toHaveBeenCalledTimes(1);
		const writes = stderrWriteSpy.mock.calls
			.map((call) => String(call[0]))
			.join("");
		expect(writes).toContain("Agents: active=1");
		expect(writes).toContain("Recent events:");
		expect(writes).toContain("info child_heartbeat run=run-live");
	});

	it("starts and stops the skills watcher and prints catalog hints", async () => {
		let catalogListener:
			| ((change: {
					added: readonly string[];
					removed: readonly string[];
					changed: readonly string[];
			  }) => void)
			| undefined;
		const skillsManager = {
			discover: vi.fn(async () => []),
			startWatching: vi.fn(),
			stopWatching: vi.fn(),
			list: vi.fn(() => []),
			postCompactRestore: vi.fn(() => ({ entries: [], totalTokens: 0 })),
			getRecentSkillNames: vi.fn(() => []),
			onCatalogChange: vi.fn((listener) => {
				catalogListener = listener;
				return () => undefined;
			}),
		};
		mockQuestion.mockImplementationOnce(async () => {
			catalogListener?.({
				added: ["new-skill"],
				removed: [],
				changed: [],
			});
			return "/exit";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			skillsManager: skillsManager as never,
		});

		expect(skillsManager.startWatching).toHaveBeenCalledTimes(1);
		expect(skillsManager.stopWatching).toHaveBeenCalledTimes(1);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"📥 New skill discovered: new-skill\n",
		);
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
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			tools: [{ name: "memory_recall", description: "Recall memory" }] as never,
		});

		expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				context: expect.any(BasicContextManager),
				sessionAssembler: expect.any(Object),
				modelId: "deepseek-chat",
				tools: expect.arrayContaining([
					expect.objectContaining({ name: "file_read" }),
					expect.objectContaining({ name: "shell_exec" }),
					expect.objectContaining({
						name: "memory_recall",
						category: "programmatic",
						riskLevel: "read",
					}),
				]),
			}),
			expect.any(Array),
		);
		expect(capturedMessages[0]).toEqual([{ role: "user", content: "hello" }]);
		expect(capturedMessages[1]).toEqual([
			{ role: "user", content: "after clear" },
		]);
		expect(stderrWriteSpy).toHaveBeenCalledWith("Conversation cleared.\n\n");
	});

	it("keeps tool-call and tool-result transcript messages for follow-up turns", async () => {
		mockQuestion
			.mockResolvedValueOnce("search codex")
			.mockResolvedValueOnce("which sites?")
			.mockResolvedValueOnce("/exit");
		const firstToolCall = {
			id: "call-web",
			name: "web_fetch",
			arguments: { url: "https://example.com/codex" },
		};
		const firstToolResult = {
			toolCallId: "call-web",
			isError: false,
			content: JSON.stringify({
				url: "https://example.com/codex",
				status: 200,
				contentType: "text/html",
				body: "Codex news",
			}),
		};
		mockRunAgentLoop.mockImplementation(async (config, messages) => {
			capturedMessages.push(structuredClone(messages));
			if (capturedMessages.length === 1) {
				const fullTranscript = [
					...messages,
					{
						role: "assistant",
						content: "",
						toolCalls: [firstToolCall],
					},
					{
						role: "tool",
						toolCallId: "call-web",
						name: "web_fetch",
						content: firstToolResult.content,
					},
					{ role: "assistant", content: "I checked example.com." },
				];
				await config.hooks?.onToolResult?.({
					toolCall: firstToolCall,
					toolResult: firstToolResult,
					actionVerification: {
						layer: 2,
						decision: "allow",
						code: "allowed",
						reason: "test",
					},
					scanResult: {
						safe: true,
						threats: [],
						sanitizedContent: firstToolResult.content,
					},
					sanitizedContent: firstToolResult.content,
					trustedToolOutput: false,
					hasBlockedThreat: false,
				});
				await config.hooks?.onMessagesUpdated?.(fullTranscript, {
					phase: "assistant_response",
					turnCount: 1,
				});
				return "I checked example.com.";
			}

			const outbound = config.sessionAssembler?.buildOutboundRequest({
				transcript: messages,
				turnKind: "user-turn",
			});
			expect(outbound?.messages[0]?.content).toContain(
				"https://example.com/codex",
			);
			return "I used example.com.";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(capturedMessages[1]).toEqual([
			{ role: "user", content: "search codex" },
			{
				role: "assistant",
				content: "",
				toolCalls: [firstToolCall],
			},
			{
				role: "tool",
				toolCallId: "call-web",
				name: "web_fetch",
				content: firstToolResult.content,
			},
			{ role: "assistant", content: "I checked example.com." },
			{ role: "user", content: "which sites?" },
		]);
	});

	it("passes observability into runAgentLoop and flushes spans after a turn", async () => {
		const spanSnapshot = {
			name: "agent.session",
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			startTimeUnixMs: 1,
			status: "ok",
			attributes: {
				"session.id": "session-1",
				"session.user_id": "user-1",
				"session.task_summary": "test",
				"session.turn_count": 1,
				"session.total_cost_usd": 0,
				"session.total_tokens": 0,
			},
			events: [],
			children: [],
		};
		const spans = {
			snapshot: vi.fn(() => [spanSnapshot]),
			clear: vi.fn(),
		};
		const spanExporter = {
			exportSpans: vi.fn(async () => undefined),
		};
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("reply");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			observability: { spans: spans as never, sessionId: "session-1" },
			spanExporter,
		});

		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				observability: expect.objectContaining({
					spans,
					sessionId: "session-1",
					llmProviderId: "deepseek",
				}),
			}),
			expect.any(Array),
		);
		expect(spanExporter.exportSpans).toHaveBeenCalledWith([spanSnapshot]);
		expect(spans.clear).toHaveBeenCalledTimes(1);
	});

	// QUI-140 / QUI-90: REPL must wire user config context.budget into
	// runAgentLoop so user-tuned budgets actually flow to BasicContextManager.
	it("forwards getUserConfig().context.budget to runAgentLoop as contextBudget", async () => {
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("reply");

		const customBudget = {
			total: 12_000,
			system: 3000,
			memory: 3000,
			tools: 1500,
			conversation: 3000,
			reserved: 1500,
		} as const;
		const userConfigStub = {
			schema_version: 1,
			context: { budget: customBudget },
		} as never;

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			getUserConfig: () => userConfigStub,
		});

		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({ contextBudget: customBudget }),
			expect.any(Array),
		);
	});

	// QUI-140 / QUI-90: REPL without a getUserConfig wiring must NOT
	// inject contextBudget — runAgentLoop falls back to DEFAULT_CONTEXT_BUDGET.
	it("omits contextBudget from runAgentLoop when getUserConfig is absent", async () => {
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("reply");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.not.objectContaining({ contextBudget: expect.anything() }),
			expect.any(Array),
		);
	});

	it("resets stream render state on /clear", async () => {
		mockQuestion
			.mockResolvedValueOnce("hello")
			.mockResolvedValueOnce("/clear")
			.mockResolvedValueOnce("after clear")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop
			.mockImplementationOnce(async () => {
				capturedStreamCallback?.({
					type: "tool-call-start",
					toolCallId: "call-1",
					toolName: "search",
				});
				capturedStreamCallback?.({
					type: "tool-call-args-delta",
					toolCallId: "call-1",
					toolName: "search",
					delta: '{"q":"stale"}',
				});
				return "first reply";
			})
			.mockImplementationOnce(async () => {
				capturedStreamCallback?.({
					type: "tool-call-end",
					toolCallId: "call-1",
					toolName: "search",
					inputText: "",
				});
				return "second reply";
			});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith("\n🔧 calling search()\n");
		expect(stderrWriteSpy).not.toHaveBeenCalledWith(
			'\n🔧 calling search({"q":"stale"})\n',
		);
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

			throw createSecretProviderError("boom");
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			tools: [{ name: "memory_recall", description: "Recall memory" }] as never,
		});

		expect(capturedMessages[1]).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "second" },
		]);
		expect(mockLoggerError).toHaveBeenCalledWith(
			{
				error: {
					name: "ProviderAuthError",
					code: "AUTH_FAILED",
					category: "auth",
				},
			},
			"REPL: LLM call failed",
		);
		const serializedErrorLogs = JSON.stringify(mockLoggerError.mock.calls);
		expect(serializedErrorLogs).not.toContain("token=secret");
		expect(serializedErrorLogs).not.toContain(
			"Bearer abcdefghijklmnopqrstuvwxyz012345",
		);
		expect(serializedErrorLogs).not.toContain(
			"sk-abcdefghijklmnopqrstuvwxyz012345",
		);
		expect(serializedErrorLogs).not.toContain("providerSecretFrame");
		expect(serializedErrorLogs).not.toContain("stack");
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"\n[Error: LLM call failed. Check logs for details.]\n\n",
		);
		expect(mockRegistryDisconnectAll).toHaveBeenCalledTimes(1);
	});

	it("resets stream render state after a failed turn", async () => {
		mockQuestion
			.mockResolvedValueOnce("first")
			.mockResolvedValueOnce("second")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop
			.mockImplementationOnce(async () => {
				capturedStreamCallback?.({
					type: "tool-call-start",
					toolCallId: "call-1",
					toolName: "search",
				});
				capturedStreamCallback?.({
					type: "tool-call-args-delta",
					toolCallId: "call-1",
					toolName: "search",
					delta: '{"q":"stale"}',
				});
				throw new Error("boom");
			})
			.mockImplementationOnce(async () => {
				capturedStreamCallback?.({
					type: "tool-call-end",
					toolCallId: "call-1",
					toolName: "search",
					inputText: "",
				});
				return "ok";
			});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith("\n🔧 calling search()\n");
		expect(stderrWriteSpy).not.toHaveBeenCalledWith(
			'\n🔧 calling search({"q":"stale"})\n',
		);
	});

	it("restores a saved session when sessionId is provided", async () => {
		mockQuestion.mockResolvedValueOnce("next").mockResolvedValueOnce("/exit");
		mockCheckpointLoad.mockResolvedValue({
			messages: [
				{
					role: "system",
					content: "restored system prompt with obsolete_tool",
				},
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
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			sessionId: "resume-session",
			tools: [{ name: "memory_recall", description: "Recall memory" }] as never,
		});

		expect(mockCheckpointConstructor).toHaveBeenCalledWith({
			sessionId: "resume-session",
		});
		expect(mockCheckpointLoad).toHaveBeenCalledWith("resume-session");
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Session: resume-session (restored)\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Messages: 2 | Last active: 2026-04-15T00:01:00.000Z\n",
		);
		expect(capturedMessages[0]).toEqual([
			{ role: "user", content: "before" },
			{ role: "assistant", content: "after" },
			{ role: "user", content: "next" },
		]);
		expect(mockRegistryDisconnectAll).toHaveBeenCalledTimes(1);
	});

	it("registers configured MCP servers before starting the REPL", async () => {
		mockQuestion.mockResolvedValueOnce("/exit");
		mockRegistryRegisterImplementation.mockResolvedValueOnce([
			createToolWithMetadata(
				"quilin-mem/memory_store",
				"Store memory in the MCP server.",
			),
		]);

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "quilin-mem",
					namespace: "quilin-mem",
					config: {
						command: "uv",
						args: ["run", "python", "-m", "quilin_mem"],
					},
				},
			],
		});

		expect(mockRegistryRegister).toHaveBeenCalledWith({
			id: "quilin-mem",
			namespace: "quilin-mem",
			config: {
				command: "uv",
				args: ["run", "python", "-m", "quilin_mem"],
			},
		});
		expect(mockCheckpointSave).toHaveBeenCalledWith({
			messages: [],
			isTerminal: true,
			turnCount: 0,
			createdAt: expect.any(String),
			lastActiveAt: expect.any(String),
		});
	});

	it("shows slash command help on /", async () => {
		mockQuestion.mockResolvedValueOnce("/").mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("Slash commands:"),
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("/status"),
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("/help"),
		);
		expect(mockRunAgentLoop).not.toHaveBeenCalled();
	});

	it("filters submitted unknown slash command help by the typed prefix", async () => {
		mockQuestion.mockResolvedValueOnce("/he").mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		const writes = stderrWriteSpy.mock.calls
			.map(([value]) => String(value))
			.join("\n");
		expect(writes).toContain("Unknown command: /he");
		expect(writes).toContain("Slash commands:");
		expect(writes).toContain("/help");
		expect(writes).not.toContain("/status");
		expect(writes).not.toContain("/think on|off|auto");
		expect(mockRunAgentLoop).not.toHaveBeenCalled();
	});

	it("shows slash command help while / is typed without submitting input", async () => {
		const restoreStdinTty = setProcessTty(process.stdin, true);
		const restoreStderrTty = setProcessTty(process.stderr, true);
		const readlineLineAccess = vi.fn(() => {
			throw new Error("slash command help must not read readline.line");
		});
		const getCursorPos = vi.fn(() => {
			throw new Error("slash command help must not read readline cursor state");
		});
		const mockInteractiveInterface = {
			question: mockQuestion,
			close: mockClose,
			prompt: vi.fn(),
			on: mockReadlineOn,
			off: mockReadlineOff,
			get line() {
				return readlineLineAccess();
			},
			getCursorPos,
		};
		let resolvePrompt: (input: string) => void = () => undefined;
		const pendingPrompt = new Promise<string>((resolve) => {
			resolvePrompt = resolve;
		});
		mockCreateInterface.mockReturnValueOnce(mockInteractiveInterface);
		mockQuestion
			.mockReturnValueOnce(pendingPrompt)
			.mockResolvedValueOnce("/exit");

		try {
			const { startRepl } = await import("./repl.js");

			const replPromise = startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			process.stdin.emit("keypress", "/", { sequence: "/" });
			await new Promise((resolve) => setImmediate(resolve));

			expect(mockQuestion).toHaveBeenCalledTimes(1);
			expect(readlineLineAccess).not.toHaveBeenCalled();
			expect(getCursorPos).not.toHaveBeenCalled();
			expect(stderrWriteSpy).toHaveBeenCalledWith(
				expect.stringContaining("Slash commands:"),
			);
			expect(stderrWriteSpy).toHaveBeenCalledWith(
				expect.stringContaining("quilin> /"),
			);
			expect(mockInteractiveInterface.prompt).not.toHaveBeenCalled();
			expect(mockRunAgentLoop).not.toHaveBeenCalled();

			resolvePrompt("/");
			await replPromise;
		} finally {
			restoreStderrTty();
			restoreStdinTty();
		}
	});

	it("filters slash command help by the typed prefix", async () => {
		const restoreStdinTty = setProcessTty(process.stdin, true);
		const restoreStderrTty = setProcessTty(process.stderr, true);
		const readlineLineAccess = vi.fn(() => {
			throw new Error("slash command help must not read readline.line");
		});
		const getCursorPos = vi.fn(() => {
			throw new Error("slash command help must not read readline cursor state");
		});
		const mockInteractiveInterface = {
			question: mockQuestion,
			close: mockClose,
			prompt: vi.fn(),
			on: mockReadlineOn,
			off: mockReadlineOff,
			get line() {
				return readlineLineAccess();
			},
			getCursorPos,
		};
		let resolvePrompt: (input: string) => void = () => undefined;
		const pendingPrompt = new Promise<string>((resolve) => {
			resolvePrompt = resolve;
		});
		mockCreateInterface.mockReturnValueOnce(mockInteractiveInterface);
		mockQuestion
			.mockReturnValueOnce(pendingPrompt)
			.mockResolvedValueOnce("/exit");

		try {
			const { startRepl } = await import("./repl.js");

			const replPromise = startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			process.stdin.emit("keypress", "/", { sequence: "/" });
			process.stdin.emit("keypress", "h", { sequence: "h" });
			process.stdin.emit("keypress", "e", { sequence: "e" });
			await new Promise((resolve) => setImmediate(resolve));

			expect(readlineLineAccess).not.toHaveBeenCalled();
			expect(getCursorPos).not.toHaveBeenCalled();
			const writes = stderrWriteSpy.mock.calls
				.map(([value]) => String(value))
				.join("\n");
			expect(writes).toContain("Slash commands:");
			expect(writes).toContain("/help");
			expect(writes).not.toContain("/status");
			expect(writes).not.toContain("/think on|off|auto");

			resolvePrompt("/");
			await replPromise;
		} finally {
			restoreStderrTty();
			restoreStdinTty();
		}
	});

	it("applies /think on off auto to the per-session inference config", async () => {
		mockQuestion
			.mockResolvedValueOnce("/think on")
			.mockResolvedValueOnce("first")
			.mockResolvedValueOnce("/think off")
			.mockResolvedValueOnce("second")
			.mockResolvedValueOnce("/think auto")
			.mockResolvedValueOnce("third")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("ok");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				inferenceConfig: expect.objectContaining({
					thinkingMode: "enabled",
				}),
			}),
			expect.any(Array),
		);
		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				inferenceConfig: expect.objectContaining({
					thinkingMode: "disabled",
				}),
			}),
			expect.any(Array),
		);
		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				inferenceConfig: expect.objectContaining({
					thinkingMode: "auto",
				}),
			}),
			expect.any(Array),
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("Thinking mode: enabled.\n");
		expect(stderrWriteSpy).toHaveBeenCalledWith("Thinking mode: disabled.\n");
		expect(stderrWriteSpy).toHaveBeenCalledWith("Thinking mode: auto.\n");
	});

	it("seeds inference config from runtime config before slash command overrides", async () => {
		mockQuestion
			.mockResolvedValueOnce("runtime turn")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("ok");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			inferenceConfig: {
				temperature: 0.2,
				maxTokens: 1234,
				thinkingMode: "enabled",
				thinkingBudget: 4321,
			},
		});

		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				inferenceConfig: {
					temperature: 0.2,
					maxTokens: 1234,
					thinkingMode: "enabled",
					thinkingBudget: 4321,
				},
			}),
			expect.any(Array),
		);
	});

	it("initializes WriteAuthority from runtime trust mode", async () => {
		mockQuestion
			.mockResolvedValueOnce("trigger write")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementationOnce(async () => {
			const writeAuthority = mockCreateBuiltinTools.mock.calls[0]?.[0]
				?.writeAuthority as
				| {
						getMode: () => string;
						authorize: (request: {
							tool: string;
							riskLevel: "medium";
							summary: string;
							origin: "agent";
						}) => Promise<unknown>;
				  }
				| undefined;
			expect(writeAuthority?.getMode()).toBe("auto-medium");
			await expect(
				writeAuthority?.authorize({
					tool: "file_write",
					riskLevel: "medium",
					summary: "write file",
					origin: "agent",
				}),
			).resolves.toEqual({ kind: "allow" });
			return "ok";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			writeAuthorityMode: "auto-medium",
		});

		expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
	});

	it("filters builtin and injected tools by runtime tool config", async () => {
		mockQuestion
			.mockResolvedValueOnce("use allowed tools")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("ok");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			tools: [
				{ name: "memory_recall", description: "Recall memory" },
				{ name: "memory_store", description: "Store memory" },
			] as never,
			toolFilter: {
				enabled: ["file_read", "memory_recall"],
				disabled: ["shell_exec"],
			},
		});

		expect(mockRegistryRegisterBuiltin).toHaveBeenNthCalledWith(1, [
			expect.objectContaining({ name: "file_read" }),
		]);
		expect(mockRegistryRegisterBuiltin).toHaveBeenNthCalledWith(2, [
			expect.objectContaining({
				name: "memory_recall",
				category: "programmatic",
				riskLevel: "read",
			}),
		]);
		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: [
					expect.objectContaining({ name: "file_read" }),
					expect.objectContaining({ name: "memory_recall" }),
				],
			}),
			expect.any(Array),
		);
	});

	it("filters MCP tools by runtime tool config before exposing them to the loop", async () => {
		mockQuestion
			.mockResolvedValueOnce("use mcp tools")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("ok");
		mockRegistryRegisterImplementation.mockResolvedValueOnce([
			createToolWithMetadata("quilin-mem/memory_recall", "Recall memory"),
			createToolWithMetadata("quilin-mem/memory_store", "Store memory"),
		]);

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "quilin-mem",
					namespace: "quilin-mem",
					config: { command: "memory", args: [] },
				},
			],
			toolFilter: {
				enabled: ["file_read", "memory_recall"],
				disabled: ["shell_exec", "memory_store"],
			},
		});

		expect(mockRegistryRegister).toHaveBeenCalledTimes(1);
		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: [
					expect.objectContaining({ name: "file_read" }),
					expect.objectContaining({ name: "quilin-mem/memory_recall" }),
				],
			}),
			expect.any(Array),
		);
		expect(mockRunAgentLoop.mock.calls[0]?.[0]?.tools).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "quilin-mem/memory_store" }),
				expect.objectContaining({ name: "shell_exec" }),
			]),
		);
	});

	it("applies refreshed MCP tools from capabilities runtime on the next turn", async () => {
		mockQuestion
			.mockResolvedValueOnce("first turn")
			.mockResolvedValueOnce("second turn")
			.mockResolvedValueOnce("/exit");
		const oldMcpServer = {
			id: "old-memory",
			namespace: "old-memory",
			config: { command: "old-memory", args: [] },
		};
		const newMcpServer = {
			id: "new-browser",
			namespace: "new-browser",
			config: { command: "new-browser", args: [] },
		};
		const firstRuntime = {
			config: {},
			source: { kind: "builtin" },
			mcpServers: [oldMcpServer],
		};
		const secondRuntime = {
			config: {},
			source: { kind: "project", path: "/tmp/quilin/capabilities.json" },
			mcpServers: [newMcpServer],
		};
		let currentRuntime = firstRuntime;
		let generation = 1;
		mockRegistryRegisterImplementation.mockImplementation(async (entry) => {
			const id = (entry as { id: string }).id;
			return id === "old-memory"
				? [createToolWithMetadata("old-memory/recall", "Old recall")]
				: [createToolWithMetadata("new-browser/search", "New search")];
		});
		mockRunAgentLoop
			.mockImplementationOnce(async (config) => {
				expect(config.tools).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "old-memory/recall" }),
					]),
				);
				expect(config.tools).not.toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "new-browser/search" }),
					]),
				);
				currentRuntime = secondRuntime;
				generation = 2;
				return "first";
			})
			.mockImplementationOnce(async (config) => {
				expect(config.tools).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "new-browser/search" }),
					]),
				);
				expect(config.tools).not.toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "old-memory/recall" }),
					]),
				);
				return "second";
			});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			capabilitiesRuntime: () => currentRuntime as never,
			capabilitiesStatus: () => ({ generation }) as never,
		});

		expect(mockRegistryRegister).toHaveBeenCalledTimes(2);
		expect(mockRegistryUnregister).toHaveBeenCalledWith("old-memory");
		expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
	});

	it("shows base and effective model in /status", async () => {
		mockQuestion
			.mockResolvedValueOnce("/think on")
			.mockResolvedValueOnce("/verbose")
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Status: model=deepseek-chat | effective=deepseek-reasoner | thinking=enabled | routing=fixed | reasoning=verbose\n",
		);
	});

	it("keeps the base model as effective for non-DeepSeek providers", async () => {
		mockQuestion
			.mockResolvedValueOnce("/think on")
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "mock-openai",
					modelId: requestedModelId,
				}),
			),
			modelId: "gpt-test",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Status: model=gpt-test | effective=gpt-test | thinking=enabled | routing=fixed | reasoning=collapsed\n",
		);
	});

	it("shows capabilities hot reload state in /status when available", async () => {
		mockQuestion
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
			capabilitiesStatus: () =>
				({
					generation: 3,
					booted: true,
					watching: true,
					watchedPaths: ["/tmp/quilin/capabilities.json"],
					inFlight: false,
					inFlightGenerations: [],
					lastSuccess: {
						generation: 3,
						operation: "reload",
						trigger: "watch",
						completedAtEpochMs: 1_234,
						source: { kind: "project", path: "/tmp/quilin/capabilities.json" },
						configPath: "/tmp/quilin/capabilities.json",
						mcpReconnect: {
							status: "pending_repl_apply",
							reason: "applied_at_repl_turn_boundary",
							activeServerIds: ["browser"],
							change: {
								added: ["browser"],
								removed: [],
								changed: [],
							},
						},
					},
					lastFailure: null,
					lastSkillsChange: null,
					skillsStatus: {
						generation: 2,
						watching: true,
						inFlight: false,
						inFlightGenerations: [],
						lastSuccess: {
							generation: 2,
							completedAtEpochMs: 1_200,
							catalogSize: 7,
							change: {
								added: ["research-helper"],
								removed: [],
								changed: [],
							},
						},
						lastFailure: null,
					},
					mcpReconnect: {
						status: "pending_repl_apply",
						reason: "applied_at_repl_turn_boundary",
						activeServerIds: ["browser"],
						change: {
							added: ["browser"],
							removed: [],
							changed: [],
						},
					},
				}) as never,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Capabilities: generation=3 | booted=yes | watching=on | in_flight=no | last_reload=reload/watch | last_failure=none | mcp=pending_repl_apply(active=browser added=browser removed=none changed=none) | skills=catalog=7,watching=on\n",
		);
	});

	it("shows local subagent runtime summary in /status and details in /agents", async () => {
		mockQuestion
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/agents")
			.mockResolvedValueOnce("/exit");
		const getNotificationStatus = vi.fn(() => ({
			status: "watching",
			enabled: true,
			pendingCount: 1,
			deliveredCount: 2,
			failedCount: 0,
			channels: ["repl", "tui"],
			lastNotifiedAt: "2026-05-06T00:00:02.500Z",
			heartbeatCount: 3,
			staleCount: 1,
			recoveryCount: 1,
			recentEvents: [{ type: "child_stale" }],
		}));
		const supervisorRuntime = {
			snapshot: vi.fn(() =>
				createSupervisorSnapshot(
					[
						{
							runId: "run-active",
							taskId: "task-build",
							workerId: "builder",
							status: "active",
							summary: "Implementing runtime hooks",
							currentStep: "coding",
							progress: {
								completedSteps: 2,
								totalSteps: 5,
								label: "control plane",
							},
							confidence: "medium",
							reviewedArtifactCount: 0,
							lastHeartbeatAt: "2026-05-06T00:00:01.000Z",
							nextCheckpointAt: "2026-05-06T00:05:00.000Z",
							updatedAt: "2026-05-06T00:00:01.000Z",
						},
						{
							runId: "run-decision",
							taskId: "task-plan",
							workerId: "planner",
							status: "blocked",
							summary: "Need user choice",
							currentStep: "needs_decision",
							blocker: "Choose provider strategy",
							confidence: "low",
							reviewedArtifactCount: 1,
							lastHeartbeatAt: "2026-05-05T23:57:00.000Z",
							updatedAt: "2026-05-06T00:00:02.000Z",
						},
						{
							runId: "run-done",
							taskId: "task-review",
							workerId: "reviewer",
							status: "completed",
							summary: "Review complete",
							confidence: "high",
							reviewedArtifactCount: 2,
							lastHeartbeatAt: "2026-05-06T00:00:00.000Z",
							updatedAt: "2026-05-06T00:00:00.000Z",
						},
					],
					{
						snapshot: {
							band: "blocked",
							boundedPercent: 40,
							staleRunIds: ["run-decision"],
							oldestHeartbeatAgeMs: 180_000,
							nextCheckpointAt: "2026-05-06T00:05:00.000Z",
						},
						events: [
							{
								schemaVersion: 1,
								id: "progress_snapshot:2026-05-06T00:00:03.000Z",
								type: "progress_snapshot",
								severity: "warning",
								occurredAt: "2026-05-06T00:00:03.000Z",
								payload: {
									generatedAt: "2026-05-06T00:00:03.000Z",
									band: "blocked",
									totalRuns: 3,
									counts: {},
									activeRunIds: ["run-active", "run-decision"],
									queuedRunIds: [],
									blockedRunIds: ["run-decision"],
									staleRunIds: ["run-decision"],
									terminalRunIds: ["run-done"],
									boundedPercent: 40,
									confidence: "low",
									reviewedArtifactCount: 3,
									nextCheckpointAt: "2026-05-06T00:05:00.000Z",
								},
							},
							{
								schemaVersion: 1,
								id: "child_stale:run-decision:task-plan:2026-05-06T00:00:03.000Z",
								type: "child_stale",
								severity: "warning",
								occurredAt: "2026-05-06T00:00:03.000Z",
								runId: "run-decision",
								taskId: "task-plan",
								payload: {
									workerId: "planner",
									status: "blocked",
									summary: "Need user choice",
									lastHeartbeatAt: "2026-05-05T23:57:00.000Z",
									heartbeatAgeMs: 180_000,
									staleAfterMs: 120_000,
								},
							},
							{
								schemaVersion: 1,
								id: "child_recovery:run-active:task-build:2026-05-06T00:00:04.000Z",
								type: "child_recovery",
								severity: "info",
								occurredAt: "2026-05-06T00:00:04.000Z",
								runId: "run-active",
								taskId: "task-build",
								payload: {
									summary: "Worker recovered after stale heartbeat",
								},
							},
							{
								schemaVersion: 1,
								id: "child_heartbeat:run-active:task-build:2026-05-06T00:00:01.000Z",
								type: "child_heartbeat",
								severity: "info",
								occurredAt: "2026-05-06T00:00:01.000Z",
								runId: "run-active",
								taskId: "task-build",
								payload: {
									workerId: "builder",
									status: "active",
									summary: "Implementing runtime hooks",
									currentStep: "coding",
									progress: { completedSteps: 2, totalSteps: 5 },
									confidence: "medium",
									reviewedArtifactCount: 0,
									lastHeartbeatAt: "2026-05-06T00:00:01.000Z",
									heartbeatAgeMs: 2_000,
								},
							},
						],
					},
				),
			),
			getNotificationStatus,
		};

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			supervisorRuntime: supervisorRuntime as never,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Agents: active=1 | blocked=0 | needs_decision=1 | completed=1 | failed=0 | queued=0\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Agent notifications: status=watching | enabled=yes | source=getNotificationStatus | pending=1 | delivered=2 | failed=0 | channels=repl,tui | last=2026-05-06T00:00:02.500Z | heartbeat=3 | stale=1 | recovery=1 | recent=1 | projection=needs_attention | projection_key_events=3 | projection_heartbeat=1 | projection_stale=1 | projection_recovery=1\n",
		);
		const writes = stderrWriteSpy.mock.calls
			.map((call) => String(call[0]))
			.join("");
		expect(writes).toContain("needs_decision");
		expect(writes).toContain("run=run-decision");
		expect(writes).toContain('blocker="Choose provider strategy"');
		expect(writes).toContain(
			"Progress: band=blocked | percent=40% | heartbeat=1 | stale=1 | recovery=1 | oldest_heartbeat_ms=180000 | checkpoint_due=0 | next_checkpoint=2026-05-06T00:05:00.000Z",
		);
		expect(writes).toContain("Recent events:");
		expect(writes).toContain(
			'info child_recovery run=run-active task=task-build summary="Worker recovered after stale heartbeat"',
		);
		expect(writes).toContain(
			'warning child_stale run=run-decision task=task-plan status=blocked age_ms=180000 threshold_ms=120000 summary="Need user choice"',
		);
		expect(writes).toContain('progress=2/5 label="control plane"');
		expect(writes).toContain("completed");
		expect(getNotificationStatus).toHaveBeenCalledTimes(1);
	});

	it("shows an empty local subagent runtime in /agents", async () => {
		mockQuestion
			.mockResolvedValueOnce("/agents")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			supervisorRuntime: {
				snapshot: vi.fn(() => createSupervisorSnapshot([])),
			} as never,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			`${[
				"Agents: none",
				"Progress: band=idle | percent=unbounded | heartbeat=0 | stale=0 | recovery=0 | oldest_heartbeat_ms=none | checkpoint_due=0 | next_checkpoint=none",
				"Recent events:",
				"  none",
				"No local subagent runs yet.",
			].join("\n")}\n`,
		);
	});

	it("does not block /status on async notification probes", async () => {
		mockQuestion
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");
		const notificationStatus = vi.fn(() => new Promise(() => undefined));

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			supervisorRuntime: {
				snapshot: vi.fn(() => createSupervisorSnapshot([])),
				notificationStatus,
			} as never,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Agent notifications: status=async_unavailable | source=notificationStatus | pending=0 | delivered=0 | failed=0 | last=none | heartbeat=0 | stale=0 | recovery=0 | recent=0 | projection=empty | projection_key_events=0 | projection_heartbeat=0 | projection_stale=0 | projection_recovery=0\n",
		);
		expect(notificationStatus).toHaveBeenCalledTimes(1);
	});

	it("shows configured tiers and the last routed tier in /status", async () => {
		mockQuestion
			.mockResolvedValueOnce("hello")
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async (config) => {
			await config.llm.chat([], [], {
				temperature: 0.7,
				maxTokens: 4096,
				thinkingMode: "enabled",
			});
			return "ok";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-v4-pro",
			tierRouting: {
				mode: "pro",
				defaultTier: "lite",
				allowEscalation: true,
				tiers: {
					flash: {
						provider: "deepseek",
						model: "deepseek-v4-flash",
						thinkingMode: "disabled",
					},
					lite: {
						provider: "deepseek",
						model: "deepseek-v4-flash",
						thinkingMode: "auto",
					},
					pro: {
						provider: "deepseek",
						model: "deepseek-v4-pro",
						thinkingMode: "enabled",
					},
				},
			},
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Status: base_model=deepseek-v4-pro | base_effective=deepseek-v4-pro | base_thinking=disabled | routing=pro | reasoning=collapsed\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Tiers: flash=deepseek/deepseek-v4-flash thinking=disabled | lite=deepseek/deepseek-v4-flash thinking=auto | pro=deepseek/deepseek-v4-pro thinking=enabled\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Last route: tier=pro | provider=deepseek | configured=deepseek-v4-pro | effective=deepseek-v4-pro | thinking=enabled | reason=forced_pro\n",
		);
	});

	it("queues slash commands entered during WriteAuthority confirmation", async () => {
		mockQuestion
			.mockResolvedValueOnce("trigger write")
			.mockResolvedValueOnce("/think on")
			.mockResolvedValueOnce("y")
			.mockResolvedValueOnce("follow up")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop
			.mockImplementationOnce(async () => {
				const writeAuthority = mockCreateBuiltinTools.mock.calls[0]?.[0]
					?.writeAuthority as
					| {
							authorize: (request: {
								tool: string;
								riskLevel: "low" | "medium" | "high" | "critical";
								summary: string;
								origin: "user" | "agent" | "idle";
							}) => Promise<unknown>;
					  }
					| undefined;
				expect(writeAuthority).toBeDefined();
				await writeAuthority?.authorize({
					tool: "shell_exec",
					riskLevel: "high",
					summary: "write file",
					origin: "agent",
				});
				return "first reply";
			})
			.mockImplementationOnce(async () => "second reply");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Command queued for next turn: /think on\n",
		);
		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				inferenceConfig: expect.objectContaining({
					thinkingMode: "enabled",
				}),
			}),
			expect.any(Array),
		);
	});

	it("prompts for sandbox approvals inside the REPL and resumes the same tool call", async () => {
		mockQuestion
			.mockResolvedValueOnce("trigger sandbox")
			.mockResolvedValueOnce("y")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementationOnce(
			async (config: {
				toolRouterOptions?: {
					sandboxApproval?: (request: {
						decision: {
							kind: "ask";
							reasonCodes: readonly string[];
							requiredApprovals: readonly string[];
						};
						summary: {
							tool: string;
							call: string;
							origin: string;
							kind: "ask";
							requiredApprovals: readonly string[];
							reasonCodes: readonly string[];
							summary: string;
							detail: string;
						};
						context: Record<string, unknown>;
					}) => Promise<boolean>;
				};
			}) => {
				const approved = await config.toolRouterOptions?.sandboxApproval?.({
					decision: {
						kind: "ask",
						reasonCodes: ["network_credentials_require_approval"],
						requiredApprovals: ["network_access", "user_confirmation"],
					},
					context: {
						toolCallId: "call-web-fetch-auth",
						requestedToolName: "web_fetch",
						resolvedToolName: "web_fetch",
						parsedArguments: {},
					},
					summary: {
						tool: "web_fetch",
						call: "call-web-fetch-auth",
						origin: "agent",
						kind: "ask",
						requiredApprovals: ["network_access", "user_confirmation"],
						reasonCodes: ["network_credentials_require_approval"],
						summary: "Sandbox approval required for web_fetch.",
						detail:
							"call=call-web-fetch-auth; origin=agent; kind=ask; requiredApprovals=network_access,user_confirmation; reasonCodes=network_credentials_require_approval",
					},
				});
				expect(approved).toBe(true);
				return "ok";
			},
		);

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(mockRunAgentLoop).toHaveBeenCalledWith(
			expect.objectContaining({
				toolRouterOptions: expect.objectContaining({
					sandboxOrigin: "agent",
					sandboxApproval: expect.any(Function),
				}),
			}),
			expect.any(Array),
		);
		expect(mockQuestion).toHaveBeenNthCalledWith(
			2,
			"[Sandbox] web_fetch: Sandbox approval required for web_fetch.\nReasons: network_credentials_require_approval | Required: network_access,user_confirmation\nAllow once? [y/N]: ",
		);
	});

	it("queues slash commands entered during sandbox approval", async () => {
		mockQuestion
			.mockResolvedValueOnce("trigger sandbox")
			.mockResolvedValueOnce("/think on")
			.mockResolvedValueOnce("y")
			.mockResolvedValueOnce("follow up")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop
			.mockImplementationOnce(
				async (config: {
					toolRouterOptions?: {
						sandboxApproval?: (request: {
							decision: {
								kind: "ask";
								reasonCodes: readonly string[];
								requiredApprovals: readonly string[];
							};
							summary: {
								tool: string;
								call: string;
								origin: string;
								kind: "ask";
								requiredApprovals: readonly string[];
								reasonCodes: readonly string[];
								summary: string;
								detail: string;
							};
							context: Record<string, unknown>;
						}) => Promise<boolean>;
					};
				}) => {
					const approved = await config.toolRouterOptions?.sandboxApproval?.({
						decision: {
							kind: "ask",
							reasonCodes: ["network_credentials_require_approval"],
							requiredApprovals: ["network_access", "user_confirmation"],
						},
						context: {
							toolCallId: "call-web-fetch-auth",
							requestedToolName: "web_fetch",
							resolvedToolName: "web_fetch",
							parsedArguments: {},
						},
						summary: {
							tool: "web_fetch",
							call: "call-web-fetch-auth",
							origin: "agent",
							kind: "ask",
							requiredApprovals: ["network_access", "user_confirmation"],
							reasonCodes: ["network_credentials_require_approval"],
							summary: "Sandbox approval required for web_fetch.",
							detail:
								"call=call-web-fetch-auth; origin=agent; kind=ask; requiredApprovals=network_access,user_confirmation; reasonCodes=network_credentials_require_approval",
						},
					});
					expect(approved).toBe(true);
					return "first reply";
				},
			)
			.mockImplementationOnce(async () => "second reply");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Command queued for next turn: /think on\n",
		);
		expect(mockRunAgentLoop).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				inferenceConfig: expect.objectContaining({
					thinkingMode: "enabled",
				}),
			}),
			expect.any(Array),
		);
	});

	it("handles early write confirmation failures and persistent allow answers", async () => {
		mockCreateBuiltinTools.mockImplementationOnce((options) => {
			void (
				options as {
					writeAuthority: {
						authorize: (request: {
							tool: string;
							riskLevel: "high";
							summary: string;
							origin: "agent";
						}) => Promise<unknown>;
					};
				}
			).writeAuthority.authorize({
				tool: "shell_exec",
				riskLevel: "high",
				summary: "before repl",
				origin: "agent",
			});
			return [];
		});
		mockQuestion.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		mockCreateBuiltinTools.mockReset();
		mockCreateBuiltinTools.mockReturnValue([
			createToolWithMetadata("file_read", "Read a file with numbered lines."),
		]);
		mockQuestion
			.mockResolvedValueOnce("trigger write")
			.mockResolvedValueOnce("always-low")
			.mockResolvedValueOnce("trigger write again")
			.mockResolvedValueOnce("always-medium")
			.mockResolvedValueOnce("trigger yes")
			.mockResolvedValueOnce("yes")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async () => {
			const writeAuthority = (
				mockCreateBuiltinTools.mock.calls.at(-1)?.[0] as
					| {
							writeAuthority: {
								authorize: (request: {
									tool: string;
									riskLevel: "high";
									summary: string;
									origin: "agent";
								}) => Promise<unknown>;
							};
					  }
					| undefined
			)?.writeAuthority;
			await writeAuthority?.authorize({
				tool: "shell_exec",
				riskLevel: "high",
				summary: "write file",
				origin: "agent",
			});
			return "ok";
		});

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "plain-model",
		});

		expect(mockRunAgentLoop).toHaveBeenCalledTimes(3);
	});

	it("toggles reasoning display between verbose and collapsed", async () => {
		mockQuestion
			.mockResolvedValueOnce("/verbose")
			.mockResolvedValueOnce("show work")
			.mockResolvedValueOnce("/collapse")
			.mockResolvedValueOnce("show work again")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop
			.mockImplementationOnce(async () => {
				capturedStreamCallback?.({ type: "reasoning", delta: "step 1" });
				return "done";
			})
			.mockImplementationOnce(async () => {
				capturedStreamCallback?.({ type: "reasoning", delta: "step 2" });
				capturedStreamCallback?.({ type: "reasoning", delta: "step 3" });
				return "done";
			});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Reasoning display: verbose.\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"Reasoning display: collapsed.\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("step 1");
		expect(stderrWriteSpy).toHaveBeenCalledWith("💭 [thinking...]\n");
		expect(
			stderrWriteSpy.mock.calls.filter(
				(call) => call[0] === "💭 [thinking...]\n",
			),
		).toHaveLength(1);
	});

	it("renders tool progress lines from streaming events", async () => {
		mockQuestion
			.mockResolvedValueOnce("use tools")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async () => {
			capturedStreamCallback?.({
				type: "tool-call-start",
				toolCallId: "call-1",
				toolName: "search",
			});
			capturedStreamCallback?.({
				type: "tool-call-args-delta",
				toolCallId: "call-1",
				toolName: "search",
				delta: '{"q":"cache"}',
			});
			capturedStreamCallback?.({
				type: "tool-call-end",
				toolCallId: "call-1",
				toolName: "search",
				inputText: '{"q":"cache"}',
				input: { q: "cache" },
			});
			capturedStreamCallback?.({
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "search",
				output: { result: "ok" },
			});
			return "done";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			'\n🔧 calling search({"q":"cache"})\n',
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("\n✅ search → ok\n");
	});

	it("renders text, fallback tool inputs, error results, and scalar output summaries", async () => {
		mockQuestion
			.mockResolvedValueOnce("stream variants")
			.mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockImplementation(async () => {
			capturedStreamCallback?.({ type: "text", delta: "hello" });
			capturedStreamCallback?.({
				type: "tool-call-end",
				toolCallId: "call-json",
				toolName: "lookup",
				inputText: "",
				input: { q: "cache" },
			});
			capturedStreamCallback?.({
				type: "tool-result",
				toolCallId: "call-error",
				toolName: "lookup",
				output: { content: "first line\nsecond line" },
				isError: true,
			});
			capturedStreamCallback?.({
				type: "tool-result",
				toolCallId: "call-raw",
				toolName: "echo",
				output: "raw\nignored",
			});
			capturedStreamCallback?.({
				type: "tool-call-args-delta",
				toolCallId: "call-orphan",
				toolName: "lookup",
				delta: '{"q":"orphan"}',
			});
			capturedStreamCallback?.({
				type: "tool-call-end",
				toolCallId: "call-orphan",
				toolName: "lookup",
				inputText: "",
			});
			capturedStreamCallback?.({
				type: "tool-result",
				toolCallId: "call-content-object",
				toolName: "lookup",
				output: { content: { nested: true } },
			});
			capturedStreamCallback?.({
				type: "tool-result",
				toolCallId: "call-long",
				toolName: "lookup",
				output: { result: "x".repeat(140) },
			});
			capturedStreamCallback?.({
				type: "tool-result",
				toolCallId: "call-nullish",
				toolName: "empty",
				output: undefined,
			});
			return "done";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith("hello");
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			'\n🔧 calling lookup({"q":"cache"})\n',
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("\n⚠️ lookup → first line\n");
		expect(stderrWriteSpy).toHaveBeenCalledWith("\n✅ echo → raw\n");
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			'\n🔧 calling lookup({"q":"orphan"})\n',
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			'\n✅ lookup → {"content":{"nested":true}}\n',
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			`\n✅ lookup → ${"x".repeat(117)}...\n`,
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith('\n✅ empty → "undefined"\n');
	});

	it("flushes spans through per-span exporters and logs export failures without clearing", async () => {
		const spanSnapshot = {
			name: "agent.session",
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			startTimeUnixMs: 1,
			status: "ok",
			attributes: {
				"session.id": "session-1",
				"session.user_id": "user-1",
				"session.task_summary": "test",
				"session.turn_count": 1,
				"session.total_cost_usd": 0,
				"session.total_tokens": 0,
			},
			events: [],
			children: [],
		};
		const spans = {
			snapshot: vi.fn(() => [spanSnapshot]),
			clear: vi.fn(),
		};
		const exportSpan = vi.fn(async () => undefined);
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("reply");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			observability: { spans: spans as never, sessionId: "session-1" },
			spanExporter: { exportSpan },
		});

		expect(exportSpan).toHaveBeenCalledWith(spanSnapshot);
		expect(spans.clear).toHaveBeenCalledTimes(1);

		spans.clear.mockClear();
		exportSpan.mockRejectedValueOnce(createSecretProviderError("disk full"));
		mockQuestion
			.mockResolvedValueOnce("hello again")
			.mockResolvedValueOnce("/exit");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			observability: { spans: spans as never, sessionId: "session-1" },
			spanExporter: { exportSpan },
		});

		expect(mockLoggerError).toHaveBeenCalledWith(
			{
				error: {
					name: "ProviderAuthError",
					code: "AUTH_FAILED",
					category: "auth",
				},
			},
			"REPL: span export failed",
		);
		const serializedErrorLogs = JSON.stringify(mockLoggerError.mock.calls);
		expect(serializedErrorLogs).not.toContain("token=secret");
		expect(serializedErrorLogs).not.toContain(
			"Bearer abcdefghijklmnopqrstuvwxyz012345",
		);
		expect(serializedErrorLogs).not.toContain(
			"sk-abcdefghijklmnopqrstuvwxyz012345",
		);
		expect(serializedErrorLogs).not.toContain("providerSecretFrame");
		expect(serializedErrorLogs).not.toContain("stack");
		expect(spans.clear).not.toHaveBeenCalled();
	});

	it("skips span flushing when snapshots are empty or exporter has no methods", async () => {
		const spans = {
			snapshot: vi.fn(() => []),
			clear: vi.fn(),
		};
		mockQuestion.mockResolvedValueOnce("hello").mockResolvedValueOnce("/exit");
		mockRunAgentLoop.mockResolvedValue("reply");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			observability: { spans: spans as never, sessionId: "session-1" },
			spanExporter: {},
		});

		expect(spans.snapshot).toHaveBeenCalled();
		expect(spans.clear).not.toHaveBeenCalled();
	});

	it("handles blank prompts, /quit, and invalid /think usage", async () => {
		mockQuestion
			.mockResolvedValueOnce("   ")
			.mockResolvedValueOnce("/think sideways")
			.mockResolvedValueOnce("/quit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith("Usage: /think on|off|auto\n");
		expect(mockRunAgentLoop).not.toHaveBeenCalled();
		expect(mockCheckpointSave).toHaveBeenCalledWith(
			expect.objectContaining({ isTerminal: true }),
		);
	});

	it("prints removed and generic skills catalog hints while ignoring empty changes", async () => {
		const catalogListeners: Array<
			(change: {
				added: readonly string[];
				removed: readonly string[];
				changed: readonly string[];
			}) => void
		> = [];
		const skillsManager = {
			discover: vi.fn(async () => []),
			startWatching: vi.fn(),
			stopWatching: vi.fn(),
			list: vi.fn(() => []),
			postCompactRestore: vi.fn(() => ({ entries: [], totalTokens: 0 })),
			getRecentSkillNames: vi.fn(() => ["recent"]),
			onCatalogChange: vi.fn((listener) => {
				catalogListeners.push(listener);
				return () => undefined;
			}),
		};
		mockQuestion.mockImplementationOnce(async () => {
			for (const listener of catalogListeners) {
				listener({ added: [], removed: ["old-skill"], changed: [] });
				listener({ added: [], removed: [], changed: [] });
				listener({ added: ["a"], removed: [], changed: ["b"] });
			}
			return "/exit";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			skillsManager: skillsManager as never,
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith("🗑 Skill removed: old-skill\n");
		expect(stderrWriteSpy).toHaveBeenCalledWith("🎯 Skills catalog updated\n");
	});

	it("builds prompt context from registry tools and invalidates on registry change", async () => {
		mockQuestion
			.mockResolvedValueOnce("inspect context")
			.mockResolvedValueOnce("/exit");
		mockRegistryGetAllTools.mockImplementation(() => [
			createToolWithMetadata("z_tool", "Z tool"),
			{ ...createToolWithMetadata("nameless", "No name"), name: undefined },
			createToolWithMetadata("a_tool", "A tool"),
		]);
		mockRegistryGetToolDescriptors.mockImplementation(() => [
			{
				name: "a_tool",
				description: "A tool",
				category: "programmatic",
				riskLevel: "read",
			},
			{
				name: "z_tool",
				description: "Z tool",
				category: "programmatic",
				riskLevel: "read",
			},
		]);
		mockRunAgentLoop.mockImplementation(async (config) => {
			const assembler = config.sessionAssembler as {
				buildOutboundPrompt: (input: {
					transcript: Array<{ role: "user"; content: string }>;
					turnKind: "user-turn";
				}) => { prompt: { dynamicSuffix: string; staticPrefix: string } };
			};
			const before = assembler.buildOutboundPrompt({
				transcript: [{ role: "user", content: "inspect context" }],
				turnKind: "user-turn",
			});
			for (const listener of registryChangeListeners) {
				listener();
			}
			const after = assembler.buildOutboundPrompt({
				transcript: [{ role: "user", content: "inspect context" }],
				turnKind: "user-turn",
			});
			capturedMessages.push(
				before.prompt.staticPrefix,
				after.prompt.staticPrefix,
			);
			return "done";
		});

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(capturedMessages[0]).toContain("tool_search");
		expect(capturedMessages[1]).toEqual(expect.any(String));
	});

		it("/resume lists sessions in a table", async () => {
			mockCheckpointListSessions.mockResolvedValue([
				{
					sessionId: "session-u1",
					lastMessage: "帮我查一下关于 AIHOT 的最新...",
					messageCount: 5,
					lastActiveAt: "2026-04-15T15:30:00.000Z",
				},
				{
					sessionId: "session-u2",
					lastMessage: "怎么优化 SQLite 查询性能？",
					messageCount: 3,
					lastActiveAt: "2026-04-15T10:15:00.000Z",
				},
			]);
			mockQuestion
				.mockResolvedValueOnce("/resume")
				.mockResolvedValueOnce("/exit");

			const { startRepl } = await import("./repl.js");

			await startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});

			expect(mockCheckpointListSessions).toHaveBeenCalledTimes(1);
			const writes = stderrWriteSpy.mock.calls
				.map(([value]) => String(value))
				.join("");
			expect(writes).toContain("04-15 15:30");
			expect(writes).toContain("04-15 10:15");
			expect(writes).toContain("帮我查一下关于 AIHOT 的最新...");
			expect(writes).toContain("怎么优化 SQLite 查询性能？");
			expect(writes).toContain("输入 /resume <编号> 恢复会话");
		});

		it("/resume shows empty message when no sessions exist", async () => {
			mockCheckpointListSessions.mockResolvedValue([]);
			mockQuestion
				.mockResolvedValueOnce("/resume")
				.mockResolvedValueOnce("/exit");

			const { startRepl } = await import("./repl.js");

			await startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});

			expect(stderrWriteSpy).toHaveBeenCalledWith("No saved sessions found.\n");
		});

		it("/resume <number> restores a session and replaces current messages", async () => {
			mockCheckpointListSessions.mockResolvedValue([
				{
					sessionId: "target-session",
					lastMessage: "target message",
					messageCount: 4,
					lastActiveAt: "2026-04-15T15:30:00.000Z",
				},
			]);
			mockCheckpointLoad.mockResolvedValue({
				messages: [
					{ role: "system", content: "other system prompt" },
					{ role: "user", content: "restored question" },
					{ role: "assistant", content: "restored answer" },
				],
				isTerminal: false,
				turnCount: 2,
				createdAt: "2026-04-15T15:00:00.000Z",
				lastActiveAt: "2026-04-15T15:30:00.000Z",
			});
			mockQuestion
				.mockResolvedValueOnce("/resume 1")
				.mockResolvedValueOnce("follow-up")
				.mockResolvedValueOnce("/exit");
			mockRunAgentLoop.mockImplementation(async (_config, messages) => {
				capturedMessages.push(structuredClone(messages));
				return "ok";
			});

			const { startRepl } = await import("./repl.js");

			await startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});

			expect(mockCheckpointSave).toHaveBeenCalledWith(
				expect.objectContaining({ isTerminal: true }),
			);
			expect(mockCheckpointLoad).toHaveBeenCalledWith("target-session");
			expect(stderrWriteSpy).toHaveBeenCalledWith(
				"Resumed session target-session (2 messages).\n\n",
			);
			expect(capturedMessages[0]).toEqual([
				{ role: "user", content: "restored question" },
				{ role: "assistant", content: "restored answer" },
				{ role: "user", content: "follow-up" },
			]);
		});

		it("/resume <number> shows error for out-of-range index", async () => {
			mockCheckpointListSessions.mockResolvedValue([
				{
					sessionId: "session-u1",
					lastMessage: "hello",
					messageCount: 2,
					lastActiveAt: "2026-04-15T15:30:00.000Z",
				},
			]);
			mockQuestion
				.mockResolvedValueOnce("/resume 5")
				.mockResolvedValueOnce("/exit");

			const { startRepl } = await import("./repl.js");

			await startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});

			expect(stderrWriteSpy).toHaveBeenCalledWith(
				"Session number 5 out of range (1-1).\n",
			);
		});

		it("/resume <number> shows error for invalid number format", async () => {
			mockCheckpointListSessions.mockResolvedValue([]);
			mockQuestion
				.mockResolvedValueOnce("/resume abc")
				.mockResolvedValueOnce("/exit");

			const { startRepl } = await import("./repl.js");

			await startRepl({
				provider: createMockProvider(() => createMockLanguageModel()),
				modelId: "deepseek-chat",
			});

			expect(stderrWriteSpy).toHaveBeenCalledWith(
				"Invalid session number: abc\n",
			);
		});


	it("/status shows MCP server details when capabilitiesStatus is available", async () => {
		mockQuestion
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider((requestedModelId: string) =>
				createMockLanguageModel({
					provider: "deepseek",
					modelId: requestedModelId,
				}),
			),
			modelId: "deepseek-chat",
			capabilitiesStatus: () =>
				({
					generation: 3,
					booted: true,
					watching: true,
					watchedPaths: [],
					inFlight: false,
					inFlightGenerations: [],
					lastSuccess: null,
					lastFailure: null,
					lastSkillsChange: null,
					skillsStatus: null,
					mcpReconnect: {
						status: "pending_repl_apply",
						reason: "applied_at_repl_turn_boundary",
						applyState: "pending",
						appliesAt: "repl_turn_boundary",
						pendingReason: "waiting_for_repl_turn_boundary",
						generation: 3,
						requestedAtEpochMs: 1_700_000_000_000,
						activeServerIds: ["browser"],
						change: {
							added: ["browser"],
							removed: [],
							changed: [],
						},
					},
					management: {
						config: {
							domain: "config",
							generation: 3,
							inFlight: false,
							applyState: "applied",
							added: [],
							removed: [],
							changed: [],
							error: null,
							lastApplied: null,
						},
						mcp: {
							domain: "mcp",
							generation: 3,
							inFlight: false,
							applyState: "pending_repl_turn_boundary",
							added: ["browser"],
							removed: [],
							changed: [],
							error: null,
							lastApplied: null,
						},
						skills: {
							domain: "skills",
							generation: 2,
							inFlight: false,
							applyState: "unchanged",
							added: [],
							removed: [],
							changed: [],
							error: null,
							lastApplied: null,
						},
					},
				}) as never,
		});

		const writes = stderrWriteSpy.mock.calls
			.map((call) => String(call[0]))
			.join("");
		expect(writes).toContain("MCP Servers (1):");
		expect(writes).toContain("browser");
		expect(writes).toContain("Token Budget:");
		expect(writes).toContain("system=0/1024(0%)");
	});

	it("/status shows token budget without capabilitiesStatus", async () => {
		mockQuestion
			.mockResolvedValueOnce("/status")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		const writes = stderrWriteSpy.mock.calls
			.map((call) => String(call[0]))
			.join("");
		expect(writes).toContain("Token Budget: used=0/4096");
		expect(writes).not.toContain("MCP Servers");
	});

	it("/mcp lists registered MCP servers with tool counts", async () => {
		mockRegistryRegisterImplementation.mockResolvedValueOnce([
			createToolWithMetadata(
				"quilin-mem/memory_store",
				"Store memory in the MCP server.",
			),
			createToolWithMetadata(
				"quilin-mem/memory_recall",
				"Recall memory from the MCP server.",
			),
		]);
		mockQuestion
			.mockResolvedValueOnce("/mcp")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "quilin-mem",
					namespace: "quilin-mem",
					config: {
						command: "uv",
						args: ["run", "python", "-m", "quilin_mem"],
					},
				},
			],
		});

		const writes = stderrWriteSpy.mock.calls
			.map((call) => String(call[0]))
			.join("");
		expect(writes).toContain("MCP Servers (1):");
		expect(writes).toContain("quilin-mem");
		expect(writes).toContain("tools=2");
	});

	it("/mcp shows empty message when no servers registered", async () => {
		mockQuestion
			.mockResolvedValueOnce("/mcp")
			.mockResolvedValueOnce("/exit");

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
		});

		expect(stderrWriteSpy).toHaveBeenCalledWith(
			"No MCP servers registered.\n",
		);
	});
	});
