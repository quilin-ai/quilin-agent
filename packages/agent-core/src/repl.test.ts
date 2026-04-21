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
const mockRegistryOnChange = vi.fn(() => () => undefined);
const mockRegistryConstructor = vi.fn();
let capturedStreamCallback:
	| ((event: Record<string, unknown>) => void)
	| undefined;

const registryBuiltinTools: ToolWithMetadata[] = [];
const registryServerTools: ToolWithMetadata[] = [];

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
		capturedMessages.length = 0;
		registryBuiltinTools.length = 0;
		registryServerTools.length = 0;
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

			throw new Error("boom");
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
		expect(mockLoggerError).toHaveBeenCalled();
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
			"Status: model=deepseek-chat | effective=deepseek-reasoner | thinking=enabled | reasoning=verbose\n",
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
});
