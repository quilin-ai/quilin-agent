import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SpanEventSnapshot, SpanSnapshot } from "../span.js";

export interface JsonFileSpanExporterOptions {
	readonly logsDir?: string;
	readonly now?: () => Date;
}

export interface SerializedSpanEvent {
	readonly name: string;
	readonly timestamp_unix_ms: number;
	readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface SerializedSpan {
	readonly name: string;
	readonly trace_id: string;
	readonly span_id: string;
	readonly parent_span_id?: string;
	readonly start_time_unix_ms: number;
	readonly end_time_unix_ms?: number;
	readonly duration_ms?: number;
	readonly status: string;
	readonly attributes: Readonly<Record<string, string | number | boolean>>;
	readonly events: readonly SerializedSpanEvent[];
	readonly children: readonly string[];
}

function datePart(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function serializeSpan(span: SpanSnapshot): SerializedSpan {
	return {
		name: span.name,
		trace_id: span.traceId,
		span_id: span.spanId,
		...(span.parentSpanId == null ? {} : { parent_span_id: span.parentSpanId }),
		start_time_unix_ms: span.startTimeUnixMs,
		...(span.endTimeUnixMs == null
			? {}
			: { end_time_unix_ms: span.endTimeUnixMs }),
		...(span.durationMs == null ? {} : { duration_ms: span.durationMs }),
		status: span.status,
		attributes: span.attributes,
		events: span.events.map(serializeSpanEvent),
		children: span.children,
	};
}

function serializeSpanEvent(event: SpanEventSnapshot): SerializedSpanEvent {
	return {
		name: event.name,
		timestamp_unix_ms: event.timestampUnixMs,
		attributes: event.attributes,
	};
}

export class JsonFileSpanExporter {
	private readonly logsDir: string;
	private readonly now: () => Date;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: JsonFileSpanExporterOptions = {}) {
		this.logsDir = options.logsDir ?? ".logs";
		this.now = options.now ?? (() => new Date());
	}

	async exportSpan(span: SpanSnapshot): Promise<void> {
		await this.exportSpans([span]);
	}

	async exportSpans(spans: readonly SpanSnapshot[]): Promise<void> {
		if (spans.length === 0) {
			return;
		}

		const filePath = join(this.logsDir, `traces-${datePart(this.now())}.jsonl`);
		const payload = spans
			.map((span) => JSON.stringify(serializeSpan(span)))
			.join("\n");
		const line = `${payload}\n`;
		const previousWrite = this.writeQueue.catch(() => undefined);
		this.writeQueue = previousWrite.then(async () => {
			await mkdir(this.logsDir, { recursive: true });
			await appendFile(filePath, line, "utf8");
		});

		await this.writeQueue;
	}
}
