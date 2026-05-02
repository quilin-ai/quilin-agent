import { describe, expect, it } from "vitest";
import {
	OTelSpanProvider,
	type SpanAttributes,
	validateAttributeKey,
	validateSpanAttributes,
} from "./span.js";

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

const toolAttributes = {
	"tool.name": "memory_recall",
	"tool.params_summary": '{"keys":[]}',
	"tool.duration_ms": 0,
	"tool.success": true,
	"tool.result_size_bytes": 2,
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

		llm.addEvent("first_token", {
			"llm.tokens_output": 1,
			"memory.rank.index": 1,
			"memory.score_ratio": 0.75,
		});
		llm.end("ok");

		expect(provider.readSpan(llm.spanId)?.events).toEqual([
			expect.objectContaining({
				name: "first_token",
				attributes: {
					"llm.tokens_output": 1,
					"memory.rank.index": 1,
					"memory.score_ratio": 0.75,
				},
				timestampUnixMs: expect.any(Number),
			}),
		]);
	});

	it("validates attribute keys, value types, and numeric unit suffixes", () => {
		expect(() => validateAttributeKey("llm.model")).not.toThrow();
		expect(() => validateAttributeKey("LLM.model")).toThrow(
			/Invalid observability attribute key/,
		);
		expect(() =>
			validateSpanAttributes({
				"tool.result_size_bytes": 10,
				"session.total_cost_usd": 0.01,
				"session.total_tokens": 20,
				"turn.replanning_count": 2,
				"retrieval.hit_ratio": 0.5,
				"memory.rank.index": 1,
				"memory.score.ratio": 0.9,
			}),
		).not.toThrow();
		expect(() =>
			validateSpanAttributes({ "llm.model": null as never }),
		).toThrow(/Invalid observability attribute value/);
		expect(() =>
			validateSpanAttributes({ "llm.total_latency_ms": Number.NaN }),
		).toThrow(/Non-finite observability attribute value/);
		expect(() =>
			validateSpanAttributes({
				"llm.total_latency_ms": Number.POSITIVE_INFINITY,
			}),
		).toThrow(/Non-finite observability attribute value/);
	});

	it("clones snapshots and supports setters, idempotent end, unknown reads, and clear", () => {
		const provider = new OTelSpanProvider();
		const parent = provider.startSpan("agent.session", sessionAttributes);
		const child = provider.startSpan("tool.invoke", toolAttributes, {
			parent: parent.snapshot(),
		});

		child.setAttribute("tool.result_size_bytes", 4);
		child.setAttributes({ "tool.success": true });
		child.addEvent("tool_output");
		child.end("ok");
		const firstSnapshot = child.snapshot();
		child.end("error");
		const secondSnapshot = child.snapshot();
		(firstSnapshot.children as string[]).push("mutated");
		if (firstSnapshot.events[0]?.attributes != null) {
			(firstSnapshot.events[0].attributes as Record<string, unknown>).mutated =
				true;
		}

		expect(child.name).toBe("tool.invoke");
		expect(child.parentSpanId).toBe(parent.spanId);
		expect(secondSnapshot.status).toBe("ok");
		expect(secondSnapshot.durationMs).toEqual(expect.any(Number));
		expect(provider.readSpan("missing")).toBeUndefined();
		expect(provider.readSpan(child.spanId)?.children).toEqual([]);
		expect(provider.readSpan(child.spanId)?.events[0]?.attributes).toEqual({});

		provider.clear();
		expect(provider.snapshot()).toEqual([]);
	});

	it("rejects unknown span names and permits failed tool spans with error_type", () => {
		const provider = new OTelSpanProvider();

		expect(() => provider.startSpan("unknown.span" as never, {})).toThrow(
			/Invalid observability span name/,
		);

		const failedTool = provider.startSpan("tool.invoke", {
			...toolAttributes,
			"tool.success": false,
			"tool.error_type": "ToolError",
		});
		failedTool.end("error");

		expect(failedTool.snapshot()).toEqual(
			expect.objectContaining({
				status: "error",
				attributes: expect.objectContaining({
					"tool.error_type": "ToolError",
				}),
			}),
		);
	});
});
