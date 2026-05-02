import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SerializedSpan } from "./exporters/json-file.js";
import { deserializeSpan, TraceStore } from "./trace-store.js";

const traceId = "a".repeat(32);
const tempDirs: string[] = [];

async function tempLogsDir(): Promise<string> {
	const logsDir = await mkdtemp(join(tmpdir(), "quilin-trace-store-"));
	tempDirs.push(logsDir);
	return logsDir;
}

function serializedSpan(
	overrides: Partial<SerializedSpan> = {},
): SerializedSpan {
	return {
		name: "agent.turn",
		trace_id: traceId,
		span_id: "b".repeat(16),
		start_time_unix_ms: 100,
		end_time_unix_ms: 110,
		duration_ms: 10,
		status: "ok",
		attributes: { "turn.index": 1 },
		events: [],
		children: [],
		...overrides,
	};
}

async function writeTraceFile(
	logsDir: string,
	date: string,
	lines: readonly string[],
): Promise<void> {
	await mkdir(logsDir, { recursive: true });
	await writeFile(
		join(logsDir, `traces-${date}.jsonl`),
		`${lines.join("\n")}\n`,
	);
}

describe("TraceStore", () => {
	afterEach(async () => {
		await Promise.all(
			tempDirs
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it("reads trace JSONL files, skips bad lines, and filters by trace id and time", async () => {
		const logsDir = await tempLogsDir();
		const matchingSpan = serializedSpan();
		const otherTrace = serializedSpan({
			trace_id: "c".repeat(32),
			span_id: "d".repeat(16),
			start_time_unix_ms: 90,
		});
		const laterSpan = serializedSpan({
			span_id: "e".repeat(16),
			start_time_unix_ms: 200,
		});
		await writeTraceFile(logsDir, "2026-04-25", [
			JSON.stringify(otherTrace),
			"not-json",
			JSON.stringify({ trace_id: traceId }),
			JSON.stringify(matchingSpan),
			JSON.stringify(laterSpan),
		]);

		const result = await new TraceStore({ logsDir }).querySpans({
			traceId,
			fromUnixMs: 100,
			toUnixMs: 150,
		});

		expect(result).toEqual({
			spans: [matchingSpan],
			skippedLines: 2,
			files: ["traces-2026-04-25.jsonl"],
		});
	});

	it("supports date and limit filters and returns empty results for missing dirs", async () => {
		const logsDir = await tempLogsDir();
		await writeTraceFile(logsDir, "2026-04-25", [
			JSON.stringify(serializedSpan({ span_id: "1".repeat(16) })),
		]);
		await writeTraceFile(logsDir, "2026-04-26", [
			JSON.stringify(serializedSpan({ span_id: "2".repeat(16) })),
			JSON.stringify(serializedSpan({ span_id: "3".repeat(16) })),
		]);

		const dated = await new TraceStore({ logsDir }).querySpans({
			date: "2026-04-26",
			limit: 1,
		});
		const missing = await new TraceStore({
			logsDir: join(logsDir, "missing"),
		}).querySpans();

		expect(dated.spans.map((span) => span.span_id)).toEqual(["2".repeat(16)]);
		expect(dated.files).toEqual(["traces-2026-04-26.jsonl"]);
		expect(missing).toEqual({ spans: [], skippedLines: 0, files: [] });
	});

	it("skips lines with non-finite JSON numbers", async () => {
		const logsDir = await tempLogsDir();
		const validSpan = serializedSpan({ span_id: "c".repeat(16) });
		await writeTraceFile(logsDir, "2026-04-25", [
			JSON.stringify(validSpan),
			JSON.stringify(serializedSpan()).replace(
				'"start_time_unix_ms":100',
				'"start_time_unix_ms":1e999',
			),
			JSON.stringify(serializedSpan()).replace(
				'"duration_ms":10',
				'"duration_ms":1e999',
			),
			JSON.stringify(serializedSpan()).replace(
				'"turn.index":1',
				'"turn.index":1e999',
			),
			JSON.stringify(
				serializedSpan({
					events: [
						{
							name: "event",
							timestamp_unix_ms: 105,
							attributes: { count: 1 },
						},
					],
				}),
			).replace('"timestamp_unix_ms":105', '"timestamp_unix_ms":1e999'),
		]);

		const result = await new TraceStore({ logsDir }).querySpans({
			date: "2026-04-25",
		});

		expect(result).toEqual({
			spans: [validSpan],
			skippedLines: 4,
			files: ["traces-2026-04-25.jsonl"],
		});
	});

	it("applies zero and positive record limits to latest spans first", async () => {
		const logsDir = await tempLogsDir();
		await writeTraceFile(logsDir, "2026-04-25", [
			JSON.stringify(
				serializedSpan({ span_id: "1".repeat(16), start_time_unix_ms: 100 }),
			),
			JSON.stringify(
				serializedSpan({ span_id: "2".repeat(16), start_time_unix_ms: 200 }),
			),
		]);
		await writeTraceFile(logsDir, "2026-04-26", [
			JSON.stringify(
				serializedSpan({ span_id: "3".repeat(16), start_time_unix_ms: 300 }),
			),
		]);

		const zeroLimit = await new TraceStore({ logsDir }).querySpans({
			limit: 0,
		});
		const twoSpans = await new TraceStore({ logsDir }).querySpans({ limit: 2 });

		expect(zeroLimit).toEqual({ spans: [], skippedLines: 0, files: [] });
		expect(twoSpans.spans.map((span) => span.span_id)).toEqual([
			"3".repeat(16),
			"2".repeat(16),
		]);
		expect(twoSpans.files).toEqual([
			"traces-2026-04-26.jsonl",
			"traces-2026-04-25.jsonl",
		]);
	});

	it("redacts string attributes and event attributes when reading traces", async () => {
		const logsDir = await tempLogsDir();
		await writeTraceFile(logsDir, "2026-04-25", [
			JSON.stringify(
				serializedSpan({
					span_id: "1".repeat(16),
					attributes: {
						"turn.index": 1,
						"turn.user_input_redacted":
							"email alpha@example.com token AKIAIOSFODNN7EXAMPLE path /Users/alice/.config/gcloud/application_default_credentials.json",
					},
					events: [
						{
							name: "heartbeat",
							timestamp_unix_ms: 105,
							attributes: {
								"event.summary":
									"JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
							},
						},
					],
				}),
			),
		]);

		const result = await new TraceStore({ logsDir }).querySpans({
			date: "2026-04-25",
		});
		const serialized = JSON.stringify(result.spans);

		expect(serialized).toContain("[REDACTED:email]");
		expect(serialized).toContain("[REDACTED:aws_access_key]");
		expect(serialized).toContain("[REDACTED:sensitive_path]");
		expect(serialized).toContain("[REDACTED:jwt]");
		expect(serialized).not.toContain("alpha@example.com");
		expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(serialized).not.toContain("application_default_credentials");
	});

	it("only reads the requested trace date", async () => {
		const logsDir = await tempLogsDir();
		const datedSpan = serializedSpan({ span_id: "2".repeat(16) });
		await writeTraceFile(logsDir, "2026-04-24", [
			JSON.stringify(serializedSpan({ span_id: "1".repeat(16) })),
		]);
		await writeTraceFile(logsDir, "2026-04-25", [JSON.stringify(datedSpan)]);
		await writeFile(join(logsDir, "not-a-trace.jsonl"), "not-json\n");

		const result = await new TraceStore({ logsDir }).querySpans({
			date: "2026-04-25",
		});

		expect(result).toEqual({
			spans: [datedSpan],
			skippedLines: 0,
			files: ["traces-2026-04-25.jsonl"],
		});
	});

	it("rejects invalid query parameters before scanning trace files", async () => {
		const logsDir = await tempLogsDir();
		const store = new TraceStore({ logsDir });

		await expect(store.querySpans({ date: "20260425" })).rejects.toThrow(
			"Invalid trace date: 20260425",
		);
		await expect(store.querySpans({ limit: -1 })).rejects.toThrow(
			"trace query limit must be a non-negative number",
		);
		await expect(
			store.querySpans({ limit: Number.POSITIVE_INFINITY }),
		).rejects.toThrow("trace query limit must be a non-negative number");
	});

	it("rethrows trace file read errors other than missing files", async () => {
		const logsDir = await tempLogsDir();
		await mkdir(join(logsDir, "traces-2026-04-25.jsonl"));

		await expect(
			new TraceStore({ logsDir }).querySpans({ date: "2026-04-25" }),
		).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("deserializes stored spans into in-memory snapshots", () => {
		expect(
			deserializeSpan(
				serializedSpan({
					parent_span_id: "p".repeat(16),
					events: [
						{
							name: "event",
							timestamp_unix_ms: 105,
							attributes: { "event.count": 1 },
						},
					],
					children: ["child"],
				}),
			),
		).toEqual({
			name: "agent.turn",
			traceId,
			spanId: "b".repeat(16),
			parentSpanId: "p".repeat(16),
			startTimeUnixMs: 100,
			endTimeUnixMs: 110,
			durationMs: 10,
			status: "ok",
			attributes: { "turn.index": 1 },
			events: [
				{
					name: "event",
					timestampUnixMs: 105,
					attributes: { "event.count": 1 },
				},
			],
			children: ["child"],
		});
	});
});
