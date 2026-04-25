import { describe, expect, it } from "vitest";
import { runWithObservabilityContext } from "./context.js";
import { StructuredLogger } from "./log.js";

describe("StructuredLogger", () => {
	it("writes ADR-008 JSON log schema to stdout-compatible writer", () => {
		const lines: string[] = [];
		const logger = new StructuredLogger({
			level: "DEBUG",
			now: () => new Date("2026-04-25T12:34:56.789Z"),
			write: (line) => lines.push(line),
		});

		logger.info(
			"agent-core.loop",
			"tool_execution",
			{ tool_name: "memory_recall" },
			{
				traceId: "a".repeat(32),
				spanId: "b".repeat(16),
				requestId: "request-1",
				sessionId: "session-1",
				turnId: "turn-1",
			},
		);

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			timestamp: "2026-04-25T12:34:56.789Z",
			level: "INFO",
			component: "agent-core.loop",
			event: "tool_execution",
			trace_id: "a".repeat(32),
			span_id: "b".repeat(16),
			request_id: "request-1",
			session_id: "session-1",
			turn_id: "turn-1",
			data: { tool_name: "memory_recall" },
		});
	});

	it("uses ambient observability context and default dash ids", () => {
		const lines: string[] = [];
		const logger = new StructuredLogger({ write: (line) => lines.push(line) });

		logger.info("agent-core.loop", "turn_started");
		runWithObservabilityContext(
			{
				traceId: "c".repeat(32),
				spanId: "d".repeat(16),
				requestId: "request-2",
			},
			() => logger.warn("agent-core.loop", "turn_failed"),
		);

		expect(JSON.parse(lines[0] ?? "{}")).toEqual(
			expect.objectContaining({
				trace_id: "-",
				span_id: "-",
				request_id: "-",
			}),
		);
		expect(JSON.parse(lines[1] ?? "{}")).toEqual(
			expect.objectContaining({
				trace_id: "c".repeat(32),
				span_id: "d".repeat(16),
				request_id: "request-2",
			}),
		);
	});

	it("honors level threshold", () => {
		const lines: string[] = [];
		const logger = new StructuredLogger({
			level: "WARN",
			write: (line) => lines.push(line),
		});

		logger.debug("agent-core.loop", "debug_event");
		logger.info("agent-core.loop", "info_event");
		logger.warn("agent-core.loop", "warn_event");

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual(
			expect.objectContaining({ level: "WARN", event: "warn_event" }),
		);
	});
});
