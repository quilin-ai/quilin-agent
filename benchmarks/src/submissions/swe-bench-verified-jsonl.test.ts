import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../wire/result.js";
import {
	createSweBenchVerifiedJsonlAdapter,
	sweBenchVerifiedJsonlAdapter,
} from "./swe-bench-verified-jsonl.js";
import { SubmissionAdapterError } from "./types.js";

const baseResult = {
	run_id: "run-1",
	task_id: "django__django-11049",
	output: {
		patch:
			"diff --git a/django/core/handlers/base.py b/django/core/handlers/base.py\n--- a/django/core/handlers/base.py\n+++ b/django/core/handlers/base.py\n",
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

describe("sweBenchVerifiedJsonlAdapter", () => {
	it("serializes SWE-bench predictions as exact JSONL", () => {
		const secondResult = {
			...baseResult,
			task_id: "sympy__sympy-20590",
			output: {
				diff: "diff --git a/sympy/core/basic.py b/sympy/core/basic.py\n",
			},
		} satisfies BenchmarkResult;

		expect(
			sweBenchVerifiedJsonlAdapter.serialize([baseResult, secondResult]),
		).toBe(
			'{"instance_id":"django__django-11049","model_name_or_path":"quilin-agent","model_patch":"diff --git a/django/core/handlers/base.py b/django/core/handlers/base.py\\n--- a/django/core/handlers/base.py\\n+++ b/django/core/handlers/base.py\\n"}\n{"instance_id":"sympy__sympy-20590","model_name_or_path":"quilin-agent","model_patch":"diff --git a/sympy/core/basic.py b/sympy/core/basic.py\\n"}\n',
		);
	});

	it("allows the official model_name_or_path field to be configured", () => {
		const adapter = createSweBenchVerifiedJsonlAdapter({
			modelNameOrPath: "quilin-agent-e1",
		});

		expect(adapter.serialize([baseResult])).toContain(
			'"model_name_or_path":"quilin-agent-e1"',
		);
	});

	it("returns an empty payload for empty result lists", () => {
		expect(sweBenchVerifiedJsonlAdapter.serialize([])).toBe("");
	});

	it("builds stable jsonl filenames from run ids", () => {
		expect(sweBenchVerifiedJsonlAdapter.filename("run-2026-04-25")).toBe(
			"swe-bench-verified-run-2026-04-25.jsonl",
		);
	});

	it.each([
		["missing patch", { output: {} }],
		["blank patch", { output: { patch: "   " } }],
		["non-string patch", { output: { patch: 42 } }],
	])("throws adapter error for %s", (_caseName, override) => {
		expect(() =>
			sweBenchVerifiedJsonlAdapter.serialize([{ ...baseResult, ...override }]),
		).toThrow(SubmissionAdapterError);
	});

	it("throws adapter error for invalid instance ids", () => {
		expect(() =>
			sweBenchVerifiedJsonlAdapter.serialize([
				{ ...baseResult, task_id: "  " },
			]),
		).toThrow("missing instance_id");
	});

	it.each([
		"",
		"  ",
		"../run",
		"run\\nested",
	])("throws adapter error for unsafe run id %s", (runId) => {
		expect(() => sweBenchVerifiedJsonlAdapter.filename(runId)).toThrow(
			SubmissionAdapterError,
		);
	});
});
