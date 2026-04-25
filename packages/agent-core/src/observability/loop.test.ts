import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../loop.js";
import { createAgentLoopTelemetry } from "./loop.js";
import { OTelSpanProvider } from "./span.js";

vi.mock("../logger.js", () => ({
	getLoggerRuntimeMode: vi.fn(() => "repl"),
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
	},
}));

describe("runAgentLoop observability", () => {
	it("creates session, turn, state_node, llm.invoke, and tool.invoke spans", async () => {
		const spans = new OTelSpanProvider();
		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "hello" },
					},
				],
				usage: { inputTokens: 10, outputTokens: 2 },
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "done",
				usage: { inputTokens: 3, outputTokens: 4 },
				finishReason: "stop",
			});
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "call-1",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});

		await runAgentLoop(
			{
				llm: { chat },
				modelId: "deepseek-chat",
				observability: {
					spans,
					sessionId: "session-1",
					userId: "user-1",
					taskSummary: "test task",
				},
				tools: [
					{
						name: "memory_recall",
						description: "Recall memory",
						parameters: {
							safeParse: vi.fn().mockImplementation((input) => ({
								success: true,
								data: input,
							})),
						} as never,
						execute,
					},
				],
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "hello token=secret" }],
		);

		const snapshots = spans.snapshot();
		const session = snapshots.find((span) => span.name === "agent.session");
		const turns = snapshots.filter((span) => span.name === "agent.turn");
		const stateNodes = snapshots.filter(
			(span) => span.name === "agent.state_node",
		);
		const llmSpans = snapshots.filter((span) => span.name === "llm.invoke");
		const llmSpan = llmSpans[0];
		const toolSpan = snapshots.find((span) => span.name === "tool.invoke");
		const toolParent = snapshots.find(
			(span) => span.spanId === toolSpan?.parentSpanId,
		);

		expect(snapshots.map((span) => span.name)).toEqual(
			expect.arrayContaining([
				"agent.session",
				"agent.turn",
				"agent.state_node",
				"llm.invoke",
				"tool.invoke",
			]),
		);
		expect(session?.parentSpanId).toBeUndefined();
		expect(turns).toHaveLength(1);
		expect(turns[0]?.parentSpanId).toBe(session?.spanId);
		expect(llmSpans).toHaveLength(2);
		expect(
			stateNodes.every((span) => span.parentSpanId === turns[0]?.spanId),
		).toBe(true);
		expect(llmSpan?.parentSpanId).toBe(stateNodes[0]?.spanId);
		expect(toolParent?.name).toBe("agent.state_node");
		expect(toolParent?.attributes["state_node.name"]).toBe("execute");
		expect(toolSpan?.attributes).toEqual(
			expect.objectContaining({
				"tool.name": "memory_recall",
				"tool.success": true,
				"tool.result_size_bytes": expect.any(Number),
			}),
		);
		expect(session?.attributes).toEqual(
			expect.objectContaining({
				"session.turn_count": 1,
				"session.total_tokens": 19,
			}),
		);
	});

	it("records error and fallback observability paths without leaking secrets", async () => {
		const spans = new OTelSpanProvider();
		const telemetry = createAgentLoopTelemetry(
			{
				spans,
			},
			[],
		);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [
				{
					role: "assistant",
					content: "previous assistant message",
				},
				{
					role: "user",
					content: "contact me at user@example.com token=secret "
						.repeat(8)
						.trim(),
				},
			],
		});

		await expect(
			turn.invokeLLM(
				{
					modelId: undefined,
					inferenceConfig: {
						temperature: 0.1,
						maxTokens: 128,
						thinkingMode: "auto",
					},
				},
				async () => {
					throw "llm-string-failure";
				},
			),
		).rejects.toBe("llm-string-failure");
		const toolFailure = await turn.invokeTool(
			{
				id: "call-1",
				name: "memory_recall",
				arguments: { ids: ["a", "b"], include: true },
			},
			async () => ({
				toolCallId: "call-1",
				content: JSON.stringify({ error: "LOOKUP_FAILED" }),
				isError: true,
			}),
		);
		const malformedToolFailure = await turn.invokeTool(
			{
				id: "call-2",
				name: "memory_store",
				arguments: { note: "bad-json" },
			},
			async () => ({
				toolCallId: "call-2",
				content: "not-json",
				isError: true,
			}),
		);
		turn.end(false);
		telemetry.endSession({ turnCount: 0, totalTokens: 0, success: false });

		const snapshots = spans.snapshot();
		const session = snapshots.find((span) => span.name === "agent.session");
		const turnSpan = snapshots.find((span) => span.name === "agent.turn");
		const llmSpan = snapshots.find((span) => span.name === "llm.invoke");
		const toolSpans = snapshots.filter((span) => span.name === "tool.invoke");

		expect(toolFailure.isError).toBe(true);
		expect(malformedToolFailure.isError).toBe(true);
		expect(session?.attributes).toEqual(
			expect.objectContaining({
				"session.user_id": "unknown",
				"session.task_summary": "unknown",
				"session.turn_count": 0,
			}),
		);
		expect(session?.status).toBe("error");
		expect(turnSpan?.attributes["turn.user_input_redacted"]).toEqual(
			expect.stringContaining("[redacted_email]"),
		);
		expect(turnSpan?.attributes["turn.user_input_redacted"]).toEqual(
			expect.stringContaining("token=[redacted]"),
		);
		expect(
			String(turnSpan?.attributes["turn.user_input_redacted"]).length,
		).toBe(163);
		expect(turnSpan?.status).toBe("error");
		expect(llmSpan?.attributes["llm.model"]).toBe("unknown");
		expect(llmSpan?.attributes["llm.thinking_mode"]).toBe("standard");
		expect(llmSpan?.events).toEqual([
			expect.objectContaining({
				name: "llm_error",
				attributes: { "error.type": "UNKNOWN_ERROR" },
			}),
		]);
		expect(toolSpans.map((span) => span.status)).toEqual(["error", "error"]);
		expect(toolSpans.map((span) => span.attributes["tool.error_type"])).toEqual(
			["LOOKUP_FAILED", "TOOL_ERROR"],
		);
		expect(toolSpans[0]?.attributes["tool.params_summary"]).toBe(
			JSON.stringify({
				keys: [
					["ids", "array"],
					["include", "boolean"],
				],
			}),
		);
	});

	it("runs without an active span provider", async () => {
		const telemetry = createAgentLoopTelemetry(undefined, [
			{ role: "assistant", content: "no user message" },
		]);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [{ role: "assistant", content: "no user message" }],
		});

		const llmResult = await turn.invokeLLM(
			{
				modelId: "mock-model",
				inferenceConfig: {
					temperature: 0.1,
					maxTokens: 128,
					thinkingMode: "disabled",
				},
			},
			async () => ({
				content: "ok",
				usage: {
					inputTokens: 1,
					outputTokens: 2,
				},
				finishReason: "error",
			}),
		);

		expect(llmResult.finishReason).toBe("error");
		expect(() =>
			telemetry.endSession({ turnCount: 2, totalTokens: 3, success: true }),
		).not.toThrow();
	});

	it("records typed errors, no-user turns, error finish reasons, and structured tool errors", async () => {
		const spans = new OTelSpanProvider();
		const telemetry = createAgentLoopTelemetry(
			{
				spans,
				sessionId: "session-2",
			},
			[{ role: "assistant", content: "assistant only" }],
		);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [{ role: "assistant", content: "assistant only" }],
		});

		await expect(
			turn.invokeLLM(
				{
					modelId: "mock-model",
					inferenceConfig: {
						temperature: 0.1,
						maxTokens: 128,
						thinkingMode: "disabled",
					},
				},
				async () => {
					throw new TypeError("bad model output");
				},
			),
		).rejects.toThrow("bad model output");
		const errorFinish = await turn.invokeLLM(
			{
				modelId: "mock-model",
				inferenceConfig: {
					temperature: 0.1,
					maxTokens: 128,
					thinkingMode: "auto",
				},
			},
			async () => ({
				content: "failed",
				usage: { inputTokens: 1, outputTokens: 0 },
				finishReason: "error",
			}),
		);
		const toolResult = await turn.invokeTool(
			{
				id: "call-1",
				name: "memory_store",
				arguments: {},
			},
			async () => ({
				toolCallId: "call-1",
				content: JSON.stringify({ error: { code: "E_STRUCTURED" } }),
				isError: true,
			}),
		);

		turn.end(false);
		telemetry.endSession({ turnCount: 1, totalTokens: 1, success: false });

		const snapshots = spans.snapshot();
		const turnSpan = snapshots.find((span) => span.name === "agent.turn");
		const llmSpans = snapshots.filter((span) => span.name === "llm.invoke");
		const toolSpan = snapshots.find((span) => span.name === "tool.invoke");

		expect(errorFinish.finishReason).toBe("error");
		expect(toolResult.isError).toBe(true);
		expect(turnSpan?.attributes["turn.user_input_redacted"]).toBe("");
		expect(llmSpans.map((span) => span.status)).toEqual(["error", "error"]);
		expect(llmSpans[0]?.events).toEqual([
			expect.objectContaining({
				name: "llm_error",
				attributes: { "error.type": "TypeError" },
			}),
		]);
		expect(toolSpan?.attributes["tool.params_summary"]).toBe(
			JSON.stringify({ keys: [] }),
		);
		expect(toolSpan?.attributes["tool.error_type"]).toBe("TOOL_ERROR");
	});
});
