import { describe, expect, it } from "vitest";
import {
	assertGeneratedPatchProposalBoundary,
	createBeforeAfterEvaluation,
	createGeneratedPatchProposal,
} from "./patch-proposal.js";

function evaluation() {
	return createBeforeAfterEvaluation({
		baselineLabel: "Current behavior",
		candidateLabel: "Generated patch proposal",
		summary: "Static comparison for reviewer triage.",
		evidenceRefs: ["trajectory:1"],
		metrics: [
			{
				name: "reviewable proposal coverage",
				baselineValue: 0,
				candidateValue: 1,
				unit: "proposals",
				direction: "increase_is_better",
				evidenceRefs: ["trajectory:1"],
			},
		],
	});
}

function proposal(evaluationId = evaluation().evaluationId) {
	return createGeneratedPatchProposal({
		proposalKind: "scaffold_patch",
		title: "Review-only self-evolution patch",
		summary: "Synthetic diff for human review.",
		sourceRefs: ["trajectory:1"],
		beforeAfterEvaluationId: evaluationId,
		rollbackPlan:
			"No rollback is needed before a human applies a reviewed change.",
		fileChanges: [
			{
				path: "packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
				changeKind: "modify",
				summary: "Add a regression fixture before changing runtime behavior.",
				unifiedDiff: [
					"--- a/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
					"+++ b/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
					"@@ synthetic review proposal @@",
					"+// proposal only",
				].join("\n"),
			},
		],
	});
}

describe("patch proposal boundary", () => {
	it("creates proposal-only generated patch proposals linked to before/after evaluation", () => {
		const beforeAfterEvaluation = evaluation();
		const generatedPatchProposal = proposal(beforeAfterEvaluation.evaluationId);

		expect(beforeAfterEvaluation.requiresHumanReview).toBe(true);
		expect(beforeAfterEvaluation.metrics[0]?.candidateValue).toBe(1);
		expect(generatedPatchProposal.reviewState).toBe("pending_human_review");
		expect(generatedPatchProposal.safetyBoundary).toMatchObject({
			applicationMode: "proposal_only",
			autoApplyAllowed: false,
			requiresHumanReview: true,
		});
		expect(generatedPatchProposal.fileChanges[0]?.diffKind).toBe(
			"synthetic_unified_diff",
		);
		expect(() =>
			assertGeneratedPatchProposalBoundary(
				generatedPatchProposal,
				beforeAfterEvaluation,
			),
		).not.toThrow();
	});

	it("requires explicit metric evidence refs", () => {
		expect(() =>
			createBeforeAfterEvaluation({
				baselineLabel: "Current behavior",
				candidateLabel: "Generated patch proposal",
				summary: "Static comparison for reviewer triage.",
				evidenceRefs: ["trajectory:1"],
				metrics: [
					{
						name: "reviewable proposal coverage",
						baselineValue: 0,
						candidateValue: 1,
						unit: "proposals",
						direction: "increase_is_better",
					},
				],
			}),
		).toThrow(/metric evidence refs/u);
	});

	it("keeps rollback plans in stable proposal identity", () => {
		const beforeAfterEvaluation = evaluation();
		const first = proposal(beforeAfterEvaluation.evaluationId);
		const second = proposal(beforeAfterEvaluation.evaluationId);
		const changedRollbackPlan = createGeneratedPatchProposal({
			proposalKind: "scaffold_patch",
			title: "Review-only self-evolution patch",
			summary: "Synthetic diff for human review.",
			sourceRefs: ["trajectory:1"],
			beforeAfterEvaluationId: beforeAfterEvaluation.evaluationId,
			rollbackPlan:
				"Human reviewer must revert through the same reviewed change path.",
			fileChanges: first.fileChanges,
		});

		expect(second.patchProposalId).toBe(first.patchProposalId);
		expect(changedRollbackPlan.patchProposalId).not.toBe(first.patchProposalId);
	});

	it("rejects deserialized generated patch proposals with missing evidence, rollback, or file metadata", () => {
		const beforeAfterEvaluation = evaluation();
		const generatedPatchProposal = proposal(beforeAfterEvaluation.evaluationId);
		const [firstFileChange] = generatedPatchProposal.fileChanges;
		if (firstFileChange === undefined) {
			throw new Error("Test proposal must include a file change");
		}

		expect(() =>
			assertGeneratedPatchProposalBoundary(
				{
					...generatedPatchProposal,
					sourceRefs: [],
				},
				beforeAfterEvaluation,
			),
		).toThrow(/source refs/u);

		expect(() =>
			assertGeneratedPatchProposalBoundary(
				{
					...generatedPatchProposal,
					rollbackPlan: " ",
				},
				beforeAfterEvaluation,
			),
		).toThrow(/rollback plan/u);

		expect(() =>
			assertGeneratedPatchProposalBoundary(
				{
					...generatedPatchProposal,
					fileChanges: [
						{
							...firstFileChange,
							summary: " ",
						},
					],
				},
				beforeAfterEvaluation,
			),
		).toThrow(/change summary/u);
	});

	it("rejects generated patch proposal paths outside self-evolution", () => {
		const beforeAfterEvaluation = evaluation();

		expect(() =>
			createGeneratedPatchProposal({
				proposalKind: "scaffold_patch",
				title: "Unsafe patch",
				summary: "Attempts to edit a collaboration file.",
				sourceRefs: ["trajectory:1"],
				beforeAfterEvaluationId: beforeAfterEvaluation.evaluationId,
				rollbackPlan: "Reviewer must reject this proposal.",
				fileChanges: [
					{
						path: "agent-bridge.md",
						changeKind: "modify",
						summary: "Unsafe out-of-scope edit.",
						unifiedDiff: "--- a/agent-bridge.md\n+++ b/agent-bridge.md",
					},
				],
			}),
		).toThrow(/allowed prefixes/u);
	});

	it("rejects auto-apply and mismatched evaluation references", () => {
		const beforeAfterEvaluation = evaluation();
		const generatedPatchProposal = proposal(beforeAfterEvaluation.evaluationId);

		expect(() =>
			assertGeneratedPatchProposalBoundary(
				{
					...generatedPatchProposal,
					safetyBoundary: {
						...generatedPatchProposal.safetyBoundary,
						autoApplyAllowed: true as false,
					},
				},
				beforeAfterEvaluation,
			),
		).toThrow(/auto-apply/u);

		expect(() =>
			assertGeneratedPatchProposalBoundary(
				{
					...generatedPatchProposal,
					beforeAfterEvaluationId: "evaluation:mismatch",
				},
				beforeAfterEvaluation,
			),
		).toThrow(/before\/after evaluation/u);
	});
});
