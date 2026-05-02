import { describe, expect, it } from "vitest";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import type { StoredTrajectoryRecord } from "./types.js";

function trajectory(error: string): StoredTrajectoryRecord {
	return {
		schemaVersion: 1,
		runId: "run-tool",
		outcome: "failure",
		createdAt: "2026-05-01T00:00:00.000Z",
		trajectoryRef: "trajectory:tool",
		contentHash: "b".repeat(64),
		steps: [
			{
				index: 0,
				kind: "tool",
				label: "shell_exec",
				error,
				evidenceRefs: ["tool-call:1"],
			},
		],
	};
}

describe("LocalNoopOfflineOptimizer", () => {
	it("uses an injected deterministic clock when optimize omits now", () => {
		const optimizer = new LocalNoopOfflineOptimizer({
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});

		const result = optimizer.optimize({
			trajectories: [trajectory("tool error: timeout")],
		});

		expect(result.createdAt).toBe("2026-05-02T00:00:00.000Z");
	});

	it("emits review-only candidate artifacts for actionable failures", () => {
		const optimizer = new LocalNoopOfflineOptimizer();

		const result = optimizer.optimize({
			trajectories: [trajectory("tool error: timeout")],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		expect(result.optimizerId).toBe("local-noop");
		expect(result.mode).toBe("artifact_only");
		expect(result.proposals).toHaveLength(1);
		expect(
			result.proposals[0]?.artifacts.map((artifact) => artifact.kind),
		).toEqual(["markdown", "json", "patch"]);
		expect(result.proposals[0]?.riskPreview).toMatchObject({
			touchesRuntime: true,
			requiresHumanReview: true,
		});
		expect(result.proposals[0]?.generatedPatchProposal).toMatchObject({
			proposalKind: "scaffold_patch",
			reviewState: "pending_human_review",
			safetyBoundary: {
				applicationMode: "proposal_only",
				autoApplyAllowed: false,
				requiresHumanReview: true,
			},
		});
		expect(result.proposals[0]?.beforeAfterEvaluation).toMatchObject({
			mode: "static_estimate",
			requiresHumanReview: true,
			regressionRisk: "critical",
		});
		expect(
			result.proposals[0]?.generatedPatchProposal?.beforeAfterEvaluationId,
		).toBe(result.proposals[0]?.beforeAfterEvaluation?.evaluationId);
		expect(result.proposals[0]?.evidenceHashes).toContain("b".repeat(64));
		expect(result.proposals[0]?.artifacts[0]?.content).toContain(
			"does not write source files",
		);
		expect(result.proposals[0]?.artifacts[2]?.content).toContain(
			"pending_review proposal",
		);
	});

	it("sanitizes secrets before writing candidate artifacts", () => {
		const optimizer = new LocalNoopOfflineOptimizer();

		const result = optimizer.optimize({
			trajectories: [
				{
					...trajectory("tool error: leaked sk-secret1234567890"),
					steps: [
						{
							index: 0,
							kind: "tool" as const,
							label: "shell_exec",
							error: "tool error: leaked sk-secret1234567890",
							evidenceRefs: ["Bearer secret-source-ref-123456"],
						},
					],
				},
			],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		const artifacts = result.proposals.flatMap(
			(proposal) => proposal.artifacts,
		);
		const artifactText = artifacts
			.map((artifact) => artifact.content)
			.join("\n");
		const sourceRefs = artifacts
			.flatMap((artifact) => artifact.sourceRefs)
			.join("\n");

		expect(artifactText).not.toContain("sk-secret1234567890");
		expect(artifactText).toContain("[REDACTED]");
		expect(sourceRefs).not.toContain("secret-source-ref-123456");
		expect(sourceRefs).toContain("[REDACTED]");
	});

	it("does not propose when actionable findings lack explicit evidence refs", () => {
		const optimizer = new LocalNoopOfflineOptimizer();
		const withoutEvidence = {
			...trajectory("tool error: timeout"),
			steps: [
				{
					index: 0,
					kind: "tool" as const,
					label: "shell_exec",
					error: "tool error: timeout",
				},
			],
		};

		const result = optimizer.optimize({
			trajectories: [withoutEvidence],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons[0]?.code).toBe(
			"missing_evidence_requires_human_context",
		);
	});

	it("does not propose from provided analyses with only whitespace evidence refs", () => {
		const optimizer = new LocalNoopOfflineOptimizer({
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});
		const inputTrajectory = trajectory("tool error: timeout");

		const result = optimizer.optimize({
			trajectories: [inputTrajectory],
			analyses: [
				{
					schemaVersion: 1,
					runId: inputTrajectory.runId,
					trajectoryRef: inputTrajectory.trajectoryRef,
					shouldPropose: true,
					noProposalReasons: [],
					findings: [
						{
							category: "tool_error",
							confidence: "high",
							message: "tool error: timeout",
							evidenceRefs: [" ", "\n"],
							proposalAllowed: true,
						},
					],
				},
			],
		});

		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons[0]?.code).toBe(
			"missing_evidence_requires_human_context",
		);
	});

	it("does not propose when only human-context failures are present", () => {
		const optimizer = new LocalNoopOfflineOptimizer();

		const result = optimizer.optimize({
			trajectories: [trajectory("missing evidence for final answer")],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons[0]?.code).toBe(
			"missing_evidence_requires_human_context",
		);
	});
});
