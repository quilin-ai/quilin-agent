import { describe, expect, it } from "vitest";
import {
	assertBenchmarkRun,
	type BenchmarkRun,
	benchmarkRunSchema,
	parseBenchmarkRun,
} from "./run.js";

const validRun = {
	run_id: "018f2d35-6d86-73bb-9f21-2d8107c90f8d",
	task_id: "swe-1",
	agent_session_id: "session-1",
	started_at: "2026-04-25T12:00:00Z",
	finished_at: "2026-04-25T12:05:30.250Z",
};

describe("benchmarkRunSchema", () => {
	it("parses a valid benchmark run", () => {
		expect(parseBenchmarkRun(validRun)).toEqual(validRun);
	});

	it("accepts ISO8601 datetimes with numeric offsets", () => {
		expect(
			benchmarkRunSchema.safeParse({
				...validRun,
				started_at: "2026-04-25T20:00:00+08:00",
			}).success,
		).toBe(true);
	});

	it("asserts the input type", () => {
		const input: unknown = validRun;
		assertBenchmarkRun(input);

		const run: BenchmarkRun = input;
		expect(run.agent_session_id).toBe("session-1");
	});

	it.each([
		["missing run_id", { ...validRun, run_id: undefined }],
		["empty task_id", { ...validRun, task_id: "" }],
		["empty agent_session_id", { ...validRun, agent_session_id: "" }],
		["date only started_at", { ...validRun, started_at: "2026-04-25" }],
		["local finished_at", { ...validRun, finished_at: "2026-04-25T12:05:30" }],
		["extra top-level field", { ...validRun, phase: "score" }],
	])("rejects invalid run: %s", (_caseName, invalidRun) => {
		expect(benchmarkRunSchema.safeParse(invalidRun).success).toBe(false);
	});
});
