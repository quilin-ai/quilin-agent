import { describe, expect, it } from "vitest";
import { analyzeTrajectoryFailures } from "./failure-analyzer.js";
import type { StoredTrajectoryRecord } from "./types.js";

function trajectory(
	steps: StoredTrajectoryRecord["steps"],
	failures: StoredTrajectoryRecord["failures"] = [],
): StoredTrajectoryRecord {
	return {
		schemaVersion: 1,
		runId: "run-abc",
		outcome: "failure",
		createdAt: "2026-05-01T00:00:00.000Z",
		trajectoryRef: "trajectory:abc",
		contentHash: "a".repeat(64),
		steps,
		failures,
	};
}

describe("analyzeTrajectoryFailures", () => {
	it("classifies tool errors, schema violations, budget exhaustion, and missing evidence", () => {
		const analysis = analyzeTrajectoryFailures(
			trajectory(
				[
					{
						index: 0,
						kind: "tool",
						label: "shell_exec",
						error: "command failed with exit code 2",
						evidenceRefs: ["tool-call:1"],
					},
					{
						index: 1,
						kind: "model",
						label: "structured_output",
						error: "Zod schema validation failed",
						evidenceRefs: ["model-output:1"],
					},
					{
						index: 2,
						kind: "model",
						label: "budget",
						error: "token budget exhausted",
					},
					{
						index: 3,
						kind: "observation",
						label: "evidence",
						error: "missing evidence for claim",
					},
				],
				[],
			),
		);

		expect(analysis.findings.map((finding) => finding.category)).toEqual([
			"tool_error",
			"schema_violation",
			"budget_exhaustion",
			"missing_evidence",
		]);
		expect(analysis.shouldPropose).toBe(true);
		expect(analysis.noProposalReasons.map((reason) => reason.code)).toEqual([
			"budget_policy_requires_human_review",
			"missing_evidence_requires_human_context",
		]);
	});

	it("returns a no-proposal reason when no failure signal exists", () => {
		const analysis = analyzeTrajectoryFailures(
			trajectory([
				{
					index: 0,
					kind: "observation",
					label: "done",
					output: "success",
				},
			]),
		);

		expect(analysis.findings).toEqual([]);
		expect(analysis.shouldPropose).toBe(false);
		expect(analysis.noProposalReasons[0]?.code).toBe("no_failure_detected");
	});

	it("does not treat successful tool output as a failure", () => {
		const analysis = analyzeTrajectoryFailures(
			trajectory([
				{
					index: 0,
					kind: "tool",
					label: "file_read",
					output: "README content",
				},
			]),
		);

		expect(analysis.findings).toEqual([]);
		expect(analysis.shouldPropose).toBe(false);
		expect(analysis.noProposalReasons[0]?.code).toBe("no_failure_detected");
	});

	it("does not allow proposals for actionable failures without explicit evidence refs", () => {
		const analysis = analyzeTrajectoryFailures(
			trajectory([
				{
					index: 0,
					kind: "tool",
					label: "shell_exec",
					error: "command failed with exit code 2",
				},
			]),
		);

		expect(analysis.findings[0]?.category).toBe("tool_error");
		expect(analysis.findings[0]?.proposalAllowed).toBe(false);
		expect(analysis.shouldPropose).toBe(false);
		expect(analysis.noProposalReasons[0]?.code).toBe(
			"missing_evidence_requires_human_context",
		);
	});

	it("filters whitespace-only evidence refs before proposal gating", () => {
		const analysis = analyzeTrajectoryFailures(
			trajectory([
				{
					index: 0,
					kind: "tool",
					label: "shell_exec",
					error: "command failed with exit code 2",
					evidenceRefs: ["   ", "\t"],
				},
			]),
		);

		expect(analysis.findings[0]?.evidenceRefs).toEqual([]);
		expect(analysis.findings[0]?.proposalAllowed).toBe(false);
		expect(analysis.shouldPropose).toBe(false);
		expect(analysis.noProposalReasons[0]?.code).toBe(
			"missing_evidence_requires_human_context",
		);
	});

	it("normalizes usable evidence refs", () => {
		const analysis = analyzeTrajectoryFailures(
			trajectory([
				{
					index: 0,
					kind: "tool",
					label: "shell_exec",
					error: "command failed with exit code 2",
					evidenceRefs: [" tool-call:1 ", "tool-call:1", "model-output:1"],
				},
			]),
		);

		expect(analysis.findings[0]?.evidenceRefs).toEqual([
			"tool-call:1",
			"model-output:1",
		]);
		expect(analysis.findings[0]?.proposalAllowed).toBe(true);
		expect(analysis.shouldPropose).toBe(true);
	});
});
