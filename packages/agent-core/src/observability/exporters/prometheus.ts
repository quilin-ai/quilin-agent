import type {
	CounterMetric,
	HistogramMetric,
	MetricLabels,
	MetricsSnapshot,
} from "../metrics.js";

const PROMETHEUS_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const PROMETHEUS_LABEL_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const HISTOGRAM_RESERVED_LABEL_RENAMES = new Map([["le", "label_le"]]);

function canonicalizeMetricName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		throw new Error("Prometheus metric name cannot be empty");
	}

	const canonical = trimmed.replaceAll(/[^a-zA-Z0-9_:]/g, "_");
	const prefixed = /^[a-zA-Z_:]/.test(canonical) ? canonical : `_${canonical}`;
	if (!PROMETHEUS_METRIC_NAME.test(prefixed)) {
		throw new Error(`Invalid Prometheus metric name: ${name}`);
	}

	return prefixed;
}

function canonicalizeLabelKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed.length === 0) {
		throw new Error("Prometheus label key cannot be empty");
	}

	const canonical = trimmed
		.replaceAll(/[^a-zA-Z0-9_]/g, "_")
		.replace(/^__+/, "_");
	const prefixed = /^[a-zA-Z_]/.test(canonical) ? canonical : `_${canonical}`;
	if (!PROMETHEUS_LABEL_KEY.test(prefixed) || prefixed.startsWith("__")) {
		throw new Error(`Invalid Prometheus label key: ${key}`);
	}

	return prefixed;
}

function normalizeLabels(
	labels: MetricLabels,
	reservedLabelRenames = new Map<string, string>(),
): MetricLabels {
	const normalized: Record<string, string> = {};
	for (const [rawKey, value] of Object.entries(labels)) {
		const canonicalKey = canonicalizeLabelKey(rawKey);
		const key = reservedLabelRenames.get(canonicalKey) ?? canonicalKey;
		if (key in normalized) {
			throw new Error(
				`Prometheus label key collision after canonicalization: ${rawKey} -> ${key}`,
			);
		}
		normalized[key] = value;
	}

	return normalized;
}

function normalizeCounter(counter: CounterMetric): CounterMetric {
	return {
		...counter,
		name: canonicalizeMetricName(counter.name),
		labels: normalizeLabels(counter.labels),
	};
}

function normalizeHistogram(histogram: HistogramMetric): HistogramMetric {
	return {
		...histogram,
		name: canonicalizeMetricName(histogram.name),
		labels: normalizeLabels(histogram.labels, HISTOGRAM_RESERVED_LABEL_RENAMES),
	};
}

function escapeLabelValue(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll('"', '\\"');
}

function formatLabels(labels: MetricLabels): string {
	const entries = Object.entries(labels).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	if (entries.length === 0) {
		return "";
	}

	const payload = entries
		.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
		.join(",");
	return `{${payload}}`;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}

	return Number.isInteger(value) ? value.toString() : value.toString();
}

function metricSortKey(metric: {
	readonly name: string;
	readonly labels: MetricLabels;
}): string {
	return `${metric.name}${formatLabels(metric.labels)}`;
}

function renderCounter(counter: CounterMetric): readonly string[] {
	return [
		`${counter.name}${formatLabels(counter.labels)} ${formatNumber(counter.value)}`,
	];
}

function renderHistogram(histogram: HistogramMetric): readonly string[] {
	const labels = histogram.labels;
	const lines = histogram.buckets.map(
		(bucket) =>
			`${histogram.name}_bucket${formatLabels({
				...labels,
				le: formatNumber(bucket.le),
			})} ${formatNumber(bucket.count)}`,
	);
	lines.push(
		`${histogram.name}_bucket${formatLabels({
			...labels,
			le: "+Inf",
		})} ${formatNumber(histogram.count)}`,
	);
	lines.push(
		`${histogram.name}_sum${formatLabels(labels)} ${formatNumber(histogram.sum)}`,
	);
	lines.push(
		`${histogram.name}_count${formatLabels(labels)} ${formatNumber(histogram.count)}`,
	);

	return lines;
}

function uniqueSortedNames(
	metrics: readonly { readonly name: string }[],
): string[] {
	return [...new Set(metrics.map((metric) => metric.name))].sort();
}

export function renderPrometheusMetrics(metrics: MetricsSnapshot): string {
	const lines: string[] = [];
	const counters = metrics.counters
		.map(normalizeCounter)
		.sort((left, right) =>
			metricSortKey(left).localeCompare(metricSortKey(right)),
		);
	const histograms = metrics.histograms
		.map(normalizeHistogram)
		.sort((left, right) =>
			metricSortKey(left).localeCompare(metricSortKey(right)),
		);

	for (const name of uniqueSortedNames(counters)) {
		lines.push(`# TYPE ${name} counter`);
		for (const counter of counters.filter((metric) => metric.name === name)) {
			lines.push(...renderCounter(counter));
		}
	}

	for (const name of uniqueSortedNames(histograms)) {
		lines.push(`# TYPE ${name} histogram`);
		for (const histogram of histograms.filter(
			(metric) => metric.name === name,
		)) {
			lines.push(...renderHistogram(histogram));
		}
	}

	return `${lines.join("\n")}\n`;
}
