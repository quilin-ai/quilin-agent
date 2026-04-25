import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../loop.js";
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
});
