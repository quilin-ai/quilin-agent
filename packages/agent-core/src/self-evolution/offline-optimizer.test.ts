import { describe, expect, it } from "vitest";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import type { StoredTrajectoryRecord } from "./types.js";

function trajectory(
	error: string,
	overrides: Partial<StoredTrajectoryRecord> = {},
): StoredTrajectoryRecord {
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
		...overrides,
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
			trajectories: [
				trajectory("tool error: timeout", {
					taskRef: "QUI-45",
					metadata: {
						deterministicRegressionFixture: true,
					},
				}),
			],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		expect(result.optimizerId).toBe("local-noop");
		expect(result.mode).toBe("artifact_only");
		expect(result.proposals).toHaveLength(1);
		const [proposal] = result.proposals;
		expect(proposal?.artifacts.map((artifact) => artifact.kind)).toEqual([
			"markdown",
			"json",
			"patch",
		]);
		expect(proposal?.riskPreview).toMatchObject({
			level: "critical",
			touchesRuntime: true,
			requiresHumanReview: true,
		});
		expect(proposal?.generatedPatchProposal).toMatchObject({
			proposalKind: "scaffold_patch",
			reviewState: "pending_human_review",
			writeAuthorityPreview: {
				tool: "scaffold_patch",
				riskLevel: "critical",
				origin: "agent",
				requiresConfirmation: true,
				auditRequired: true,
			},
			safetyBoundary: {
				applicationMode: "proposal_only",
				autoApplyAllowed: false,
				requiresHumanReview: true,
			},
		});
		expect(proposal?.beforeAfterEvaluation).toMatchObject({
			mode: "static_estimate",
			requiresHumanReview: true,
			regressionRisk: "critical",
		});
		expect(proposal?.generatedPatchProposal?.beforeAfterEvaluationId).toBe(
			proposal?.beforeAfterEvaluation?.evaluationId,
		);
		expect(proposal?.evidenceHashes).toContain("b".repeat(64));
		expect(proposal?.metadata).toMatchObject({
			task_ref: "QUI-45",
		});
		expect(proposal?.generatedPatchProposal?.sourceRefs).toContain("QUI-45");
		expect(proposal?.beforeAfterEvaluation?.evidenceRefs).toContain("QUI-45");
		expect(proposal?.artifacts[0]?.sourceRefs).toContain("QUI-45");
		expect(proposal?.artifacts[0]?.content).toContain(
			"does not write source files",
		);
		expect(proposal?.artifacts[0]?.content).toContain("Task reference: QUI-45");
		expect(proposal?.artifacts[1]?.content).toContain('"taskRef": "QUI-45"');
		expect(proposal?.artifacts[2]?.content).toContain(
			"pending_review proposal",
		);
	});

	it("does not propose scaffold patches without a task reference audit anchor", () => {
		const optimizer = new LocalNoopOfflineOptimizer();

		const result = optimizer.optimize({
			trajectories: [
				trajectory("tool error: timeout", {
					metadata: {
						deterministicRegressionFixture: true,
					},
				}),
			],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons[0]?.code).toBe(
			"missing_task_ref_requires_linear_issue",
		);
	});

	it("does not propose scaffold patches from a single uncorroborated tool error", () => {
		const optimizer = new LocalNoopOfflineOptimizer();

		const result = optimizer.optimize({
			trajectories: [
				trajectory("tool error: timeout", {
					taskRef: "QUI-45",
				}),
			],
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons[0]?.code).toBe("insufficient_signal");
	});

	it("sanitizes secrets before writing candidate artifacts", () => {
		const optimizer = new LocalNoopOfflineOptimizer();

		const result = optimizer.optimize({
			trajectories: [
				{
					...trajectory("tool error: leaked sk-secret1234567890", {
						taskRef: "QUI-45",
						metadata: {
							deterministicRegressionFixture: true,
						},
					}),
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
