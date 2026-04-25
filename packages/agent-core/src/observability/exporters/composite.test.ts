import { describe, expect, it, vi } from "vitest";
import type { SpanSnapshot } from "../span.js";
import { CompositeSpanExporter } from "./composite.js";

const span = {
	name: "agent.session",
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	startTimeUnixMs: 1,
	status: "ok",
	attributes: {
		"session.id": "session-1",
		"session.user_id": "user-1",
		"session.task_summary": "test",
		"session.turn_count": 1,
		"session.total_cost_usd": 0,
		"session.total_tokens": 0,
	},
	events: [],
	children: [],
} satisfies SpanSnapshot;

describe("CompositeSpanExporter", () => {
	it("does not block healthy exporters when one exporter fails", async () => {
		const healthy = { exportSpans: vi.fn(async () => undefined) };
		const failing = {
			exportSpans: vi.fn(async () => {
				throw new Error("disk full");
			}),
		};
		const exporter = new CompositeSpanExporter([failing, healthy]);

		await expect(exporter.exportSpans([span])).resolves.toBeUndefined();

		expect(healthy.exportSpans).toHaveBeenCalledWith([span]);
		expect(exporter.lastFailures).toHaveLength(1);
		expect(exporter.lastFailures[0]?.exporterIndex).toBe(0);
	});

	it("falls back to per-span exportSpan and records failures by exporter index", async () => {
		const first = { exportSpan: vi.fn(async () => undefined) };
		const failing = {
			exportSpan: vi.fn(async () => {
				throw new Error("network down");
			}),
		};
		const noMethods = {};
		const exporter = new CompositeSpanExporter([first, noMethods, failing]);

		await exporter.exportSpan(span);

		expect(first.exportSpan).toHaveBeenCalledWith(span);
		expect(failing.exportSpan).toHaveBeenCalledWith(span);
		expect(exporter.lastFailures).toEqual([
			{
				exporterIndex: 2,
				error: expect.any(Error),
			},
		]);
	});
});
