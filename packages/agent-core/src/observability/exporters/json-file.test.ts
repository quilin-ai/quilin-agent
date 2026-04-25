import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../loop.js";
import { OTelSpanProvider } from "../span.js";
import { JsonFileSpanExporter } from "./json-file.js";

describe("JsonFileSpanExporter", () => {
	it("writes concurrent span batches to traces-YYYY-MM-DD.jsonl", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-traces-"));
		const exporter = new JsonFileSpanExporter({
			logsDir,
			now: () => new Date("2026-04-25T12:00:00.000Z"),
		});
		const spans = new OTelSpanProvider();
		const session = spans.startSpan("agent.session", {
			"session.id": "session-1",
			"session.user_id": "user-1",
			"session.task_summary": "export",
			"session.turn_count": 1,
			"session.total_cost_usd": 0,
			"session.total_tokens": 0,
		});
		const turn = spans.startSpan(
			"agent.turn",
			{
				"turn.id": "turn-1",
				"turn.index": 1,
				"turn.user_input_redacted": "hello",
				"turn.replanning_count": 0,
				"turn.cost_usd": 0,
				"turn.success": true,
			},
			{ parent: session },
		);
		turn.end("ok");
		session.end("ok");

		await Promise.all(
			spans.snapshot().map((span) => exporter.exportSpan(span)),
		);

		const content = await readFile(
			join(logsDir, "traces-2026-04-25.jsonl"),
			"utf8",
		);
		const lines = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.name)).toEqual(
			expect.arrayContaining(["agent.session", "agent.turn"]),
		);
		expect(lines[0]).toEqual(
			expect.objectContaining({
				trace_id: expect.stringMatching(/^[a-f0-9]{32}$/),
				span_id: expect.stringMatching(/^[a-f0-9]{16}$/),
			}),
		);
	});

	it("exports a full loop span chain to a trace file", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-traces-loop-"));
		const spans = new OTelSpanProvider();
		const exporter = new JsonFileSpanExporter({
			logsDir,
			now: () => new Date("2026-04-25T12:00:00.000Z"),
		});
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
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "done",
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			});

		await runAgentLoop(
			{
				llm: { chat },
				tools: [
					{
						name: "memory_recall",
						description: "Recall memory",
						parameters: {
							safeParse: vi.fn().mockReturnValue({
								success: true,
								data: { query: "hello" },
							}),
						} as never,
						execute: async () => ({
							toolCallId: "call-1",
							content: JSON.stringify({ records: [] }),
							isError: false,
						}),
					},
				],
				observability: { spans, sessionId: "session-1", userId: "user-1" },
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "hello" }],
		);

		await exporter.exportSpans(spans.snapshot());
		const content = await readFile(
			join(logsDir, "traces-2026-04-25.jsonl"),
			"utf8",
		);
		const names = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).name);

		expect(names).toEqual(
			expect.arrayContaining([
				"agent.session",
				"agent.turn",
				"agent.state_node",
				"llm.invoke",
				"tool.invoke",
			]),
		);
	});
});
