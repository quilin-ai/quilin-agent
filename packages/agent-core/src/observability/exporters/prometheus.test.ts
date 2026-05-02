import { describe, expect, it } from "vitest";
import { renderPrometheusMetrics } from "./prometheus.js";

describe("renderPrometheusMetrics", () => {
	it("renders counters with sorted escaped labels", () => {
		const output = renderPrometheusMetrics({
			counters: [
				{
					name: "quilin_spans_total",
					labels: {
						status: "ok",
						span_name: 'llm.invoke"quoted',
					},
					value: 2,
				},
			],
			histograms: [],
		});

		expect(output).toBe(
			'# TYPE quilin_spans_total counter\nquilin_spans_total{span_name="llm.invoke\\"quoted",status="ok"} 2\n',
		);
	});

	it("canonicalizes metric names and label keys", () => {
		const output = renderPrometheusMetrics({
			counters: [
				{
					name: "quilin.spans-total",
					labels: {
						"span.name": "agent.turn",
						"9status": "ok",
						__internal: "normalized",
					},
					value: 1,
				},
			],
			histograms: [],
		});

		expect(output).toBe(
			'# TYPE quilin_spans_total counter\nquilin_spans_total{_9status="ok",_internal="normalized",span_name="agent.turn"} 1\n',
		);
	});

	it("rejects label key collisions after canonicalization", () => {
		expect(() =>
			renderPrometheusMetrics({
				counters: [
					{
						name: "quilin_spans_total",
						labels: {
							"span.name": "agent.turn",
							span_name: "llm.invoke",
						},
						value: 1,
					},
				],
				histograms: [],
			}),
		).toThrow(/Prometheus label key collision/);
	});

	it("renders histogram buckets, sum, and count", () => {
		const output = renderPrometheusMetrics({
			counters: [],
			histograms: [
				{
					name: "quilin_span_duration_ms",
					labels: { span_name: "agent.turn", status: "ok" },
					buckets: [
						{ le: 10, count: 1 },
						{ le: 100, count: 2 },
					],
					count: 3,
					sum: 120.5,
				},
			],
		});

		expect(output).toBe(
			[
				"# TYPE quilin_span_duration_ms histogram",
				'quilin_span_duration_ms_bucket{le="10",span_name="agent.turn",status="ok"} 1',
				'quilin_span_duration_ms_bucket{le="100",span_name="agent.turn",status="ok"} 2',
				'quilin_span_duration_ms_bucket{le="+Inf",span_name="agent.turn",status="ok"} 3',
				'quilin_span_duration_ms_sum{span_name="agent.turn",status="ok"} 120.5',
				'quilin_span_duration_ms_count{span_name="agent.turn",status="ok"} 3',
				"",
			].join("\n"),
		);
	});

	it("canonicalizes histogram labels that collide with reserved le buckets", () => {
		const output = renderPrometheusMetrics({
			counters: [],
			histograms: [
				{
					name: "quilin_span_duration_ms",
					labels: { le: "caller-label", status: "ok" },
					buckets: [{ le: 10, count: 1 }],
					count: 1,
					sum: 10,
				},
			],
		});

		expect(output).toBe(
			[
				"# TYPE quilin_span_duration_ms histogram",
				'quilin_span_duration_ms_bucket{label_le="caller-label",le="10",status="ok"} 1',
				'quilin_span_duration_ms_bucket{label_le="caller-label",le="+Inf",status="ok"} 1',
				'quilin_span_duration_ms_sum{label_le="caller-label",status="ok"} 10',
				'quilin_span_duration_ms_count{label_le="caller-label",status="ok"} 1',
				"",
			].join("\n"),
		);
	});
});
