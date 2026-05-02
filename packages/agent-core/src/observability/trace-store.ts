import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { redactJsonLikeValue } from "../safety/redaction.js";
import type { SerializedSpan } from "./exporters/json-file.js";
import type { SpanSnapshot } from "./span.js";

export interface TraceStoreOptions {
	readonly logsDir?: string;
}

export interface TraceQuery {
	readonly traceId?: string;
	readonly fromUnixMs?: number;
	readonly toUnixMs?: number;
	readonly date?: string;
	readonly limit?: number;
}

export interface TraceQueryResult {
	readonly spans: readonly SerializedSpan[];
	readonly skippedLines: number;
	readonly files: readonly string[];
}

const TRACE_FILE_PATTERN = /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/;
const SPAN_NAMES = new Set([
	"agent.session",
	"agent.turn",
	"agent.state_node",
	"llm.invoke",
	"tool.invoke",
]);
const SPAN_STATUSES = new Set(["unset", "ok", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

function isAttributeValue(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		typeof value === "boolean"
	);
}

function isAttributes(
	value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
	return (
		isRecord(value) &&
		Object.values(value).every((item) => isAttributeValue(item))
	);
}

function isSerializedSpan(value: unknown): value is SerializedSpan {
	if (!isRecord(value)) {
		return false;
	}

	const events = value.events;
	return (
		typeof value.name === "string" &&
		SPAN_NAMES.has(value.name) &&
		typeof value.trace_id === "string" &&
		typeof value.span_id === "string" &&
		(value.parent_span_id == null ||
			typeof value.parent_span_id === "string") &&
		typeof value.start_time_unix_ms === "number" &&
		Number.isFinite(value.start_time_unix_ms) &&
		(value.end_time_unix_ms == null ||
			(typeof value.end_time_unix_ms === "number" &&
				Number.isFinite(value.end_time_unix_ms))) &&
		(value.duration_ms == null ||
			(typeof value.duration_ms === "number" &&
				Number.isFinite(value.duration_ms))) &&
		typeof value.status === "string" &&
		SPAN_STATUSES.has(value.status) &&
		isAttributes(value.attributes) &&
		Array.isArray(events) &&
		events.every(
			(event) =>
				isRecord(event) &&
				typeof event.name === "string" &&
				typeof event.timestamp_unix_ms === "number" &&
				Number.isFinite(event.timestamp_unix_ms) &&
				isAttributes(event.attributes),
		) &&
		Array.isArray(value.children) &&
		value.children.every((child) => typeof child === "string")
	);
}

function normalizeLimit(limit: number | undefined): number | undefined {
	if (limit == null) {
		return undefined;
	}
	if (!Number.isFinite(limit) || limit < 0) {
		throw new RangeError("trace query limit must be a non-negative number");
	}

	return Math.floor(limit);
}

function matchesTraceQuery(span: SerializedSpan, query: TraceQuery): boolean {
	if (query.traceId != null && span.trace_id !== query.traceId) {
		return false;
	}
	if (query.fromUnixMs != null && span.start_time_unix_ms < query.fromUnixMs) {
		return false;
	}
	if (query.toUnixMs != null && span.start_time_unix_ms > query.toUnixMs) {
		return false;
	}

	return true;
}

function dateFileName(date: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`Invalid trace date: ${date}`);
	}

	return `traces-${date}.jsonl`;
}

function parseLine(line: string): SerializedSpan | undefined {
	if (line.trim().length === 0) {
		return undefined;
	}

	const parsed = JSON.parse(line) as unknown;
	return isSerializedSpan(parsed) ? parsed : undefined;
}

function sanitizeAttributes(
	attributes: SerializedSpan["attributes"],
): SerializedSpan["attributes"] {
	return redactJsonLikeValue(attributes) as SerializedSpan["attributes"];
}

function sanitizeSpan(span: SerializedSpan): SerializedSpan {
	return {
		...span,
		attributes: sanitizeAttributes(span.attributes),
		events: span.events.map((event) => ({
			...event,
			attributes: sanitizeAttributes(event.attributes),
		})),
	};
}

async function readTraceFile(filePath: string): Promise<{
	readonly spans: readonly SerializedSpan[];
	readonly skippedLines: number;
}> {
	const content = await readFile(filePath, "utf8");
	const spans: SerializedSpan[] = [];
	let skippedLines = 0;

	for (const line of content.split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}

		try {
			const span = parseLine(line);
			if (span == null) {
				skippedLines += 1;
				continue;
			}
			spans.push(span);
		} catch {
			skippedLines += 1;
		}
	}

	return { spans, skippedLines };
}

export function deserializeSpan(span: SerializedSpan): SpanSnapshot {
	return {
		name: span.name as SpanSnapshot["name"],
		traceId: span.trace_id,
		spanId: span.span_id,
		...(span.parent_span_id == null
			? {}
			: { parentSpanId: span.parent_span_id }),
		startTimeUnixMs: span.start_time_unix_ms,
		...(span.end_time_unix_ms == null
			? {}
			: { endTimeUnixMs: span.end_time_unix_ms }),
		...(span.duration_ms == null ? {} : { durationMs: span.duration_ms }),
		status: span.status as SpanSnapshot["status"],
		attributes: span.attributes,
		events: span.events.map((event) => ({
			name: event.name,
			timestampUnixMs: event.timestamp_unix_ms,
			attributes: event.attributes,
		})),
		children: span.children,
	};
}

export class TraceStore {
	private readonly logsDir: string;

	constructor(options: TraceStoreOptions = {}) {
		this.logsDir = options.logsDir ?? ".logs";
	}

	async querySpans(query: TraceQuery = {}): Promise<TraceQueryResult> {
		const limit = normalizeLimit(query.limit);
		if (limit === 0) {
			return { spans: [], skippedLines: 0, files: [] };
		}

		const fileNames =
			query.date == null
				? await this.listTraceFiles()
				: [dateFileName(query.date)];
		const spans: SerializedSpan[] = [];
		const files: string[] = [];
		let skippedLines = 0;

		for (const fileName of fileNames) {
			const filePath = join(this.logsDir, fileName);
			try {
				const result = await readTraceFile(filePath);
				files.push(fileName);
				skippedLines += result.skippedLines;
				for (const span of result.spans) {
					if (!matchesTraceQuery(span, query)) {
						continue;
					}
					spans.push(sanitizeSpan(span));
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					continue;
				}
				throw error;
			}
		}

		const sortedSpans = [...spans].sort(
			(left, right) => right.start_time_unix_ms - left.start_time_unix_ms,
		);

		return {
			spans: limit == null ? sortedSpans : sortedSpans.slice(0, limit),
			skippedLines,
			files,
		};
	}

	async querySpanSnapshots(query: TraceQuery = {}): Promise<{
		readonly spans: readonly SpanSnapshot[];
		readonly skippedLines: number;
		readonly files: readonly string[];
	}> {
		const result = await this.querySpans(query);
		return {
			spans: result.spans.map(deserializeSpan),
			skippedLines: result.skippedLines,
			files: result.files,
		};
	}

	async readTrace(traceId: string): Promise<readonly SerializedSpan[]> {
		const result = await this.querySpans({ traceId });
		return result.spans;
	}

	private async listTraceFiles(): Promise<readonly string[]> {
		try {
			const entries = await readdir(this.logsDir);
			return entries
				.filter((entry) => TRACE_FILE_PATTERN.test(entry))
				.sort()
				.reverse();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}
}
