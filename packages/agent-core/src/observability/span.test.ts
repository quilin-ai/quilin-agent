import { describe, expect, it } from "vitest";
import { OTelSpanProvider, type SpanAttributes } from "./span.js";

const sessionAttributes = {
	"session.id": "session-1",
	"session.user_id": "user-1",
	"session.task_summary": "test task",
	"session.turn_count": 1,
	"session.total_cost_usd": 0,
	"session.total_tokens": 42,
} satisfies SpanAttributes;

const turnAttributes = {
	"turn.id": "turn-1",
	"turn.index": 1,
	"turn.user_input_redacted": "hello",
	"turn.replanning_count": 0,
	"turn.cost_usd": 0,
	"turn.success": true,
} satisfies SpanAttributes;

const llmAttributes = {
	"llm.model": "deepseek-chat",
	"llm.provider": "deepseek",
	"llm.tokens_input": 10,
	"llm.tokens_output": 20,
	"llm.tokens_thinking": 0,
	"llm.thinking_mode": "off",
	"llm.cost_usd": 0,
	"llm.time_to_first_token_ms": 0,
	"llm.total_latency_ms": 0,
} satisfies SpanAttributes;

describe("OTelSpanProvider", () => {
	it("creates nested five-layer spans with trace/span ids and parent-child links", () => {
		const provider = new OTelSpanProvider();
		const session = provider.startSpan("agent.session", sessionAttributes);
		const turn = provider.startSpan("agent.turn", turnAttributes, {
			parent: session,
		});
		const stateNode = provider.startSpan(
			"agent.state_node",
			{
				"state_node.name": "plan",
				"state_node.duration_ms": 0,
			},
			{ parent: turn },
		);
		const llm = provider.startSpan("llm.invoke", llmAttributes, {
			parent: stateNode,
		});

		llm.end("ok");
		stateNode.end("ok");
		turn.end("ok");
		session.end("ok");

		const spans = provider.snapshot();
		const llmSnapshot = spans.find((span) => span.name === "llm.invoke");
		const stateSnapshot = spans.find(
			(span) => span.name === "agent.state_node",
		);

		expect(session.traceId).toMatch(/^[a-f0-9]{32}$/);
		expect(session.spanId).toMatch(/^[a-f0-9]{16}$/);
		expect(new Set(spans.map((span) => span.traceId))).toHaveLength(1);
		expect(llmSnapshot?.parentSpanId).toBe(stateSnapshot?.spanId);
		expect(stateSnapshot?.parentSpanId).toBe(turn.spanId);
		expect(provider.readSpan(turn.spanId)?.children).toContain(
			stateSnapshot?.spanId,
		);
		expect(llmSnapshot?.durationMs).toEqual(expect.any(Number));
		expect(llmSnapshot?.status).toBe("ok");
	});

	it("validates required attributes, enum values, and numeric units", () => {
		const provider = new OTelSpanProvider();
		const missingRequired = provider.startSpan("agent.turn", {
			"turn.id": "turn-1",
			"turn.index": 1,
			"turn.user_input_redacted": "hello",
			"turn.replanning_count": 0,
			"turn.cost_usd": 0,
		});

		expect(() => missingRequired.end("ok")).toThrow(
			/Missing required agent\.turn attribute: turn\.success/,
		);
		expect(() =>
			provider.startSpan("agent.state_node", {
				"state_node.name": "node",
				"state_node.duration_ms": 0,
			}),
		).toThrow(/Invalid state_node\.name/);
		expect(() =>
			provider.startSpan("llm.invoke", {
				...llmAttributes,
				"llm.thinking_mode": "enabled",
			}),
		).toThrow(/Invalid llm\.thinking_mode/);
		expect(() =>
			provider.startSpan("llm.invoke", {
				...llmAttributes,
				"llm.total_latency": 12,
			}),
		).toThrow(/must carry a unit/);
	});

	it("requires tool.error_type for failed tool spans", () => {
		const provider = new OTelSpanProvider();
		const tool = provider.startSpan("tool.invoke", {
			"tool.name": "memory_recall",
			"tool.params_summary": '{"keys":[]}',
			"tool.duration_ms": 0,
			"tool.success": false,
			"tool.result_size_bytes": 2,
		});

		expect(() => tool.end("error")).toThrow(/tool\.error_type/);
	});

	it("records span events in snapshots", () => {
		const provider = new OTelSpanProvider();
		const llm = provider.startSpan("llm.invoke", llmAttributes);

		llm.addEvent("first_token", { "llm.tokens_output": 1 });
		llm.end("ok");

		expect(provider.readSpan(llm.spanId)?.events).toEqual([
			expect.objectContaining({
				name: "first_token",
				attributes: { "llm.tokens_output": 1 },
				timestampUnixMs: expect.any(Number),
			}),
		]);
	});
});
