import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../wire/result.js";
import { gaiaJsonlAdapter } from "./gaia-jsonl.js";
import { SubmissionAdapterError } from "./types.js";

const baseResult = {
	run_id: "run-1",
	task_id: "gaia-validation-1",
	output: {
		model_answer: "New York City",
		reasoning_trace: "Looked up the referenced city.",
	},
	passed: true,
	score: 1,
	details: {},
	cost: {
		input_tokens: 10,
		output_tokens: 5,
		thinking_tokens: 0,
		total_usd: 0.001,
		per_model_usd: { "gpt-5": 0.001 },
	},
	latency_ms: 25,
} satisfies BenchmarkResult;

describe("gaiaJsonlAdapter", () => {
	it("serializes GAIA predictions as exact JSONL", () => {
		const secondResult = {
			...baseResult,
			task_id: "gaia-validation-2",
			output: {
				answer: "42",
			},
		} satisfies BenchmarkResult;

		expect(gaiaJsonlAdapter.serialize([baseResult, secondResult])).toBe(
			'{"task_id":"gaia-validation-1","model_answer":"New York City","reasoning_trace":"Looked up the referenced city."}\n{"task_id":"gaia-validation-2","model_answer":"42"}\n',
		);
	});

	it("returns an empty payload for empty result lists", () => {
		expect(gaiaJsonlAdapter.serialize([])).toBe("");
	});

	it("builds stable jsonl filenames from run ids", () => {
		expect(gaiaJsonlAdapter.filename("run-2026-04-26")).toBe(
			"gaia-run-2026-04-26.jsonl",
		);
	});

	it.each([
		["missing model_answer", { output: {} }],
		["blank model_answer", { output: { model_answer: "   " } }],
		["non-string model_answer", { output: { model_answer: 42 } }],
	])("throws adapter error for %s", (_caseName, override) => {
		expect(() =>
			gaiaJsonlAdapter.serialize([{ ...baseResult, ...override }]),
		).toThrow(SubmissionAdapterError);
	});

	it("throws adapter error for invalid task ids", () => {
		expect(() =>
			gaiaJsonlAdapter.serialize([{ ...baseResult, task_id: "  " }]),
		).toThrow("missing task_id");
	});

	it.each([
		"",
		"  ",
		"../run",
		"run\\nested",
	])("throws adapter error for unsafe run id %s", (runId) => {
		expect(() => gaiaJsonlAdapter.filename(runId)).toThrow(
			SubmissionAdapterError,
		);
	});
});
