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
const mockCreateInterface = vi.fn(() => ({
	question: mockQuestion,
	close: mockClose,
}));
const mockRunAgentLoop = vi.fn();
const mockLoggerError = vi.fn();
const mockStreamingClient = vi.fn();
const mockProviderControlPlaneClient = vi.fn();
const mockCheckpointLoad = vi.fn();
const mockCheckpointSave = vi.fn();
const mockCheckpointConstructor = vi.fn();
const mockCreateBuiltinTools = vi.fn();
const mockRegistryRegisterBuiltin = vi.fn();
const mockRegistryRegisterImplementation = vi.fn();
const mockRegistryRegister = vi.fn();
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
const registryServerTools: ToolWithMetadata[] = [];
const registryChangeListeners: Array<() => void> = [];

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

	constructor(...args: unknown[]) {
		mockCheckpointConstructor(...args);
	}
}

class MockMCPRegistry {
	registerBuiltin = mockRegistryRegisterBuiltin;
	register = mockRegistryRegister;
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
		registryServerTools.length = 0;
		registryChangeListeners.length = 0;
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
		mockRegistryRegister.mockImplementation(async (entry: unknown) => {
			const tools = await mockRegistryRegisterImplementation(entry);
			registryServerTools.push(...tools);
			return tools;
		});
		mockRegistryRegisterImplementation.mockResolvedValue([]);
		mockRegistryGetAllTools.mockImplementation(() => [
			...registryBuiltinTools,
			...registryServerTools,
		]);
		mockRegistryGetToolDescriptors.mockImplementation(() =>
			[...registryBuiltinTools, ...registryServerTools]
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
			"Type your message, or /exit to quit.\n\n",
		);
		expect(stderrWriteSpy).toHaveBeenCalledWith("\nBye! 🐉\n");
		expect(stdoutWriteSpy).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalled();
		expect(mockCheckpointConstructor).toHaveBeenCalledWith({
			sessionId: "00000000-0000-0000-0000-000000000000",
		});
		expect(mockCreateBuiltinTools).toHaveBeenCalledTimes(1);
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
				"omnimem/memory_store",
				"Store memory in the MCP server.",
			),
		]);

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "omnimem",
					namespace: "omnimem",
					config: {
						command: "uv",
						args: ["run", "python", "-m", "omnimem"],
					},
				},
			],
		});

		expect(mockRegistryRegister).toHaveBeenCalledWith({
			id: "omnimem",
			namespace: "omnimem",
			config: {
				command: "uv",
				args: ["run", "python", "-m", "omnimem"],
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
			createToolWithMetadata("omnimem/memory_recall", "Recall memory"),
			createToolWithMetadata("omnimem/memory_store", "Store memory"),
		]);

		const { startRepl } = await import("./repl.js");

		await startRepl({
			provider: createMockProvider(() => createMockLanguageModel()),
			modelId: "deepseek-chat",
			mcpServers: [
				{
					id: "omnimem",
					namespace: "omnimem",
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
					expect.objectContaining({ name: "omnimem/memory_recall" }),
				],
			}),
			expect.any(Array),
		);
		expect(mockRunAgentLoop.mock.calls[0]?.[0]?.tools).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "omnimem/memory_store" }),
				expect.objectContaining({ name: "shell_exec" }),
			]),
		);
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

		expect(capturedMessages[0]).toContain("a_tool");
		expect(capturedMessages[0]).toContain("z_tool");
		expect(capturedMessages[0]).not.toContain("nameless");
		expect(capturedMessages[1]).toEqual(expect.any(String));
	});
});
