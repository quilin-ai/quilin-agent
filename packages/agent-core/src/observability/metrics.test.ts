import { describe, expect, it } from "vitest";
import { aggregateSpanMetrics } from "./metrics.js";
import type { SpanSnapshot } from "./span.js";

function span(overrides: Partial<SpanSnapshot>): SpanSnapshot {
	return {
		name: "agent.turn",
		traceId: "a".repeat(32),
		spanId: "b".repeat(16),
		startTimeUnixMs: 10,
		endTimeUnixMs: 20,
		durationMs: 10,
		status: "ok",
		attributes: {},
		events: [],
		children: [],
		...overrides,
	};
}

describe("aggregateSpanMetrics", () => {
	it("aggregates span, trace, llm, and tool counters deterministically", () => {
		const metrics = aggregateSpanMetrics([
			span({
				name: "llm.invoke",
				durationMs: 20,
				attributes: {
					"llm.provider": "openai",
					"llm.model": "gpt-test",
					"llm.tokens_input": 3,
					"llm.tokens_output": 5,
					"llm.tokens_thinking": 7,
					"llm.cost_usd": 0.25,
					"llm.total_latency_ms": 30,
				},
			}),
			span({
				name: "tool.invoke",
				traceId: "c".repeat(32),
				status: "error",
				durationMs: 9,
				attributes: {
					"tool.name": "memory_recall",
					"tool.success": false,
					"tool.duration_ms": 9,
				},
			}),
		]);

		expect(metrics.counters).toEqual([
			{
				name: "quilin_llm_cost_usd_total",
				labels: { model: "gpt-test", provider: "openai" },
				value: 0.25,
			},
			{
				name: "quilin_llm_invocations_total",
				labels: { model: "gpt-test", provider: "openai", status: "ok" },
				value: 1,
			},
			{
				name: "quilin_llm_tokens_total",
				labels: {
					model: "gpt-test",
					provider: "openai",
					token_type: "input",
				},
				value: 3,
			},
			{
				name: "quilin_llm_tokens_total",
				labels: {
					model: "gpt-test",
					provider: "openai",
					token_type: "output",
				},
				value: 5,
			},
			{
				name: "quilin_llm_tokens_total",
				labels: {
					model: "gpt-test",
					provider: "openai",
					token_type: "thinking",
				},
				value: 7,
			},
			{
				name: "quilin_span_errors_total",
				labels: { span_name: "tool.invoke" },
				value: 1,
			},
			{
				name: "quilin_spans_total",
				labels: { span_name: "llm.invoke", status: "ok" },
				value: 1,
			},
			{
				name: "quilin_spans_total",
				labels: { span_name: "tool.invoke", status: "error" },
				value: 1,
			},
			{
				name: "quilin_tool_invocations_total",
				labels: {
					status: "error",
					success: "false",
					tool_name: "memory_recall",
				},
				value: 1,
			},
			{ name: "quilin_traces_total", labels: {}, value: 2 },
		]);
	});

	it("builds cumulative duration histograms and skips open spans", () => {
		const metrics = aggregateSpanMetrics(
			[
				span({ name: "agent.turn", durationMs: 10 }),
				span({ name: "agent.turn", spanId: "c".repeat(16), durationMs: 50 }),
				span({
					name: "agent.session",
					spanId: "d".repeat(16),
					endTimeUnixMs: undefined,
					durationMs: undefined,
					status: "unset",
				}),
			],
			{ durationBucketsMs: [10, 100] },
		);

		expect(
			metrics.histograms.find(
				(metric) =>
					metric.name === "quilin_span_duration_ms" &&
					metric.labels.span_name === "agent.turn",
			),
		).toEqual({
			name: "quilin_span_duration_ms",
			labels: { span_name: "agent.turn", status: "ok" },
			buckets: [
				{ le: 10, count: 1 },
				{ le: 100, count: 2 },
			],
			count: 2,
			sum: 60,
		});
	});

	it("keeps metric labels distinct when values contain key delimiters", () => {
		const metrics = aggregateSpanMetrics([
			span({
				name: "llm.invoke",
				spanId: "c".repeat(16),
				attributes: {
					"llm.provider": "openai,model=foo",
					"llm.model": "bar",
				},
			}),
			span({
				name: "llm.invoke",
				spanId: "d".repeat(16),
				attributes: {
					"llm.provider": "openai",
					"llm.model": "foo,model=bar",
				},
			}),
		]);

		expect(
			metrics.counters.filter(
				(metric) => metric.name === "quilin_llm_invocations_total",
			),
		).toEqual([
			{
				name: "quilin_llm_invocations_total",
				labels: { model: "bar", provider: "openai,model=foo", status: "ok" },
				value: 1,
			},
			{
				name: "quilin_llm_invocations_total",
				labels: { model: "foo,model=bar", provider: "openai", status: "ok" },
				value: 1,
			},
		]);
	});
});
