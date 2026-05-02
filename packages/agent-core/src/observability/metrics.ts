import type { SpanSnapshot } from "./span.js";

export type MetricLabels = Readonly<Record<string, string>>;

export interface CounterMetric {
	readonly name: string;
	readonly labels: MetricLabels;
	readonly value: number;
}

export interface HistogramBucket {
	readonly le: number;
	readonly count: number;
}

export interface HistogramMetric {
	readonly name: string;
	readonly labels: MetricLabels;
	readonly buckets: readonly HistogramBucket[];
	readonly count: number;
	readonly sum: number;
}

export interface MetricsSnapshot {
	readonly counters: readonly CounterMetric[];
	readonly histograms: readonly HistogramMetric[];
}

export interface AggregateSpanMetricsOptions {
	readonly durationBucketsMs?: readonly number[];
}

const DEFAULT_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];

interface CounterAccumulator {
	readonly name: string;
	readonly labels: MetricLabels;
	value: number;
}

interface HistogramAccumulator {
	readonly name: string;
	readonly labels: MetricLabels;
	readonly bucketBounds: readonly number[];
	readonly bucketCounts: number[];
	count: number;
	sum: number;
}

function labelsKey(labels: MetricLabels): string {
	return JSON.stringify(
		Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function metricKey(name: string, labels: MetricLabels): string {
	return `${name}{${labelsKey(labels)}}`;
}

function compareByMetricKey(
	left: { readonly name: string; readonly labels: MetricLabels },
	right: { readonly name: string; readonly labels: MetricLabels },
): number {
	return metricKey(left.name, left.labels).localeCompare(
		metricKey(right.name, right.labels),
	);
}

function normalizeBuckets(
	buckets: readonly number[] | undefined,
): readonly number[] {
	const uniqueBuckets = [
		...new Set(
			(buckets ?? DEFAULT_DURATION_BUCKETS_MS).filter(Number.isFinite),
		),
	].filter((bucket) => bucket >= 0);

	return uniqueBuckets.sort((left, right) => left - right);
}

function numberAttribute(span: SpanSnapshot, key: string): number | undefined {
	const value = span.attributes[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function stringAttribute(
	span: SpanSnapshot,
	key: string,
	fallback: string,
): string {
	const value = span.attributes[key];
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanLabel(value: boolean | undefined): string {
	if (value == null) {
		return "unknown";
	}

	return value ? "true" : "false";
}

function booleanAttribute(
	span: SpanSnapshot,
	key: string,
): boolean | undefined {
	const value = span.attributes[key];
	return typeof value === "boolean" ? value : undefined;
}

function incrementCounter(
	counters: Map<string, CounterAccumulator>,
	name: string,
	labels: MetricLabels,
	value = 1,
): void {
	const key = metricKey(name, labels);
	const counter = counters.get(key);
	if (counter == null) {
		counters.set(key, { name, labels, value });
		return;
	}

	counter.value += value;
}

function observeHistogram(
	histograms: Map<string, HistogramAccumulator>,
	name: string,
	labels: MetricLabels,
	value: number | undefined,
	bucketBounds: readonly number[],
): void {
	if (value == null || !Number.isFinite(value) || value < 0) {
		return;
	}

	const key = metricKey(name, labels);
	let histogram = histograms.get(key);
	if (histogram == null) {
		histogram = {
			name,
			labels,
			bucketBounds,
			bucketCounts: bucketBounds.map(() => 0),
			count: 0,
			sum: 0,
		};
		histograms.set(key, histogram);
	}

	histogram.count += 1;
	histogram.sum += value;
	for (const [index, upperBound] of bucketBounds.entries()) {
		if (value <= upperBound) {
			histogram.bucketCounts[index] += 1;
		}
	}
}

export function aggregateSpanMetrics(
	spans: readonly SpanSnapshot[],
	options: AggregateSpanMetricsOptions = {},
): MetricsSnapshot {
	const counters = new Map<string, CounterAccumulator>();
	const histograms = new Map<string, HistogramAccumulator>();
	const durationBucketsMs = normalizeBuckets(options.durationBucketsMs);
	const traceIds = new Set<string>();

	for (const span of spans) {
		traceIds.add(span.traceId);
		incrementCounter(counters, "quilin_spans_total", {
			span_name: span.name,
			status: span.status,
		});
		if (span.status === "error") {
			incrementCounter(counters, "quilin_span_errors_total", {
				span_name: span.name,
			});
		}
		observeHistogram(
			histograms,
			"quilin_span_duration_ms",
			{ span_name: span.name, status: span.status },
			span.durationMs,
			durationBucketsMs,
		);

		if (span.name === "llm.invoke") {
			const provider = stringAttribute(span, "llm.provider", "unknown");
			const model = stringAttribute(span, "llm.model", "unknown");
			const labels = { provider, model, status: span.status };
			incrementCounter(counters, "quilin_llm_invocations_total", labels);
			incrementCounter(
				counters,
				"quilin_llm_tokens_total",
				{ provider, model, token_type: "input" },
				numberAttribute(span, "llm.tokens_input") ?? 0,
			);
			incrementCounter(
				counters,
				"quilin_llm_tokens_total",
				{ provider, model, token_type: "output" },
				numberAttribute(span, "llm.tokens_output") ?? 0,
			);
			incrementCounter(
				counters,
				"quilin_llm_tokens_total",
				{ provider, model, token_type: "thinking" },
				numberAttribute(span, "llm.tokens_thinking") ?? 0,
			);
			incrementCounter(
				counters,
				"quilin_llm_cost_usd_total",
				{ provider, model },
				numberAttribute(span, "llm.cost_usd") ?? 0,
			);
			observeHistogram(
				histograms,
				"quilin_llm_latency_ms",
				{ provider, model, status: span.status },
				numberAttribute(span, "llm.total_latency_ms") ?? span.durationMs,
				durationBucketsMs,
			);
		}

		if (span.name === "tool.invoke") {
			const toolName = stringAttribute(span, "tool.name", "unknown");
			incrementCounter(counters, "quilin_tool_invocations_total", {
				tool_name: toolName,
				status: span.status,
				success: booleanLabel(booleanAttribute(span, "tool.success")),
			});
			observeHistogram(
				histograms,
				"quilin_tool_duration_ms",
				{ tool_name: toolName, status: span.status },
				numberAttribute(span, "tool.duration_ms") ?? span.durationMs,
				durationBucketsMs,
			);
		}
	}

	incrementCounter(counters, "quilin_traces_total", {}, traceIds.size);

	return {
		counters: [...counters.values()]
			.map((counter) => ({ ...counter }))
			.sort(compareByMetricKey),
		histograms: [...histograms.values()]
			.map((histogram) => ({
				name: histogram.name,
				labels: histogram.labels,
				buckets: histogram.bucketBounds.map((le, index) => ({
					le,
					count: histogram.bucketCounts[index] ?? 0,
				})),
				count: histogram.count,
				sum: histogram.sum,
			}))
			.sort(compareByMetricKey),
	};
}
