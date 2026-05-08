import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	estimatePromptRewriteFailureReduction,
	PromptRewriteOptimizer,
} from "./prompt-rewrite-optimizer.js";
import { JsonlProposalStore } from "./proposal-store.js";
import {
	type FailureFinding,
	PROMPT_REWRITE_OPTIMIZER_ID,
	type StoredTrajectoryRecord,
} from "./types.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(path.join(tmpdir(), "quilin-prompt-rewrite-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

const FIXED_NOW = () => new Date("2026-05-09T00:00:00.000Z");

function trajectory(
	overrides: Partial<StoredTrajectoryRecord> = {},
): StoredTrajectoryRecord {
	return {
		schemaVersion: 1,
		runId: "run-001",
		taskRef: "QUI-118",
		outcome: "failure",
		createdAt: "2026-05-09T00:00:00.000Z",
		trajectoryRef: "trajectory:run-001",
		contentHash: "a".repeat(64),
		steps: [
			{
				index: 0,
				kind: "tool",
				label: "shell_exec",
				error: "command failed with exit code 2",
				evidenceRefs: ["tool-call:1"],
			},
		],
		failures: [],
		...overrides,
	};
}

describe("PromptRewriteOptimizer", () => {
	it("returns no proposals and a no-failure-detected reason for empty trajectories", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		const result = await optimizer.optimize({ trajectories: [] });

		expect(result.optimizerId).toBe(PROMPT_REWRITE_OPTIMIZER_ID);
		expect(result.mode).toBe("prompt_rewrite");
		expect(result.proposals).toHaveLength(0);
		expect(result.noProposalReasons).toHaveLength(1);
		expect(result.noProposalReasons[0]?.code).toBe("no_failure_detected");
		expect(result.createdAt).toBe("2026-05-09T00:00:00.000Z");
	});

	it("emits a single prompt-rewrite candidate for one tool-error trajectory", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		const result = await optimizer.optimize({
			trajectories: [trajectory()],
		});

		expect(result.proposals).toHaveLength(1);
		const proposal = result.proposals[0];
		expect(proposal).toBeDefined();
		if (!proposal) {
			return;
		}
		expect(proposal.title).toContain("tool_error");
		expect(proposal.metadata?.optimizer_id).toBe(PROMPT_REWRITE_OPTIMIZER_ID);
		expect(proposal.metadata?.failure_category).toBe("tool_error");
		expect(proposal.metadata?.application_mode).toBe("proposal_only");
		expect(proposal.riskPreview.requiresHumanReview).toBe(true);
		expect(proposal.riskPreview.touchesRuntime).toBe(false);
		expect(proposal.evidenceHashes.length).toBeGreaterThanOrEqual(1);
		// Two artifacts: markdown + json.
		expect(proposal.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
			"json",
			"markdown",
		]);
	});

	it("clusters multiple findings of the same category into one candidate, keeping cluster size", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		const trajectories: StoredTrajectoryRecord[] = [
			trajectory({
				runId: "run-001",
				trajectoryRef: "trajectory:run-001",
				steps: [
					{
						index: 0,
						kind: "tool",
						label: "shell_exec",
						error: "command failed with exit code 2",
						evidenceRefs: ["tool-call:1"],
					},
				],
			}),
			trajectory({
				runId: "run-002",
				trajectoryRef: "trajectory:run-002",
				steps: [
					{
						index: 0,
						kind: "tool",
						label: "shell_exec",
						error: "tool error: ENOENT bin/missing",
						evidenceRefs: ["tool-call:2"],
					},
				],
			}),
			trajectory({
				runId: "run-003",
				trajectoryRef: "trajectory:run-003",
				steps: [
					{
						index: 0,
						kind: "model",
						label: "structured_output",
						error: "Zod schema validation failed",
						evidenceRefs: ["model-output:1"],
					},
				],
			}),
		];

		const result = await optimizer.optimize({ trajectories });
		expect(result.proposals).toHaveLength(2);
		const categories = result.proposals.map(
			(proposal) => proposal.metadata?.failure_category,
		);
		expect(categories).toContain("tool_error");
		expect(categories).toContain("schema_violation");

		const toolErrorProposal = result.proposals.find(
			(proposal) => proposal.metadata?.failure_category === "tool_error",
		);
		expect(toolErrorProposal).toBeDefined();
		expect(toolErrorProposal?.metadata?.cluster_size).toBe(2);
		expect(toolErrorProposal?.metadata?.trajectory_refs).toEqual(
			expect.arrayContaining(["trajectory:run-001", "trajectory:run-002"]),
		);
	});

	it("produces a proposal that the JsonlProposalStore can persist as pending_review", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		const result = await optimizer.optimize({
			trajectories: [trajectory()],
		});
		expect(result.proposals).toHaveLength(1);
		const proposal = result.proposals[0];
		expect(proposal).toBeDefined();
		if (!proposal) {
			return;
		}
		const store = new JsonlProposalStore({
			filePath: path.join(tmpDir, "proposals.jsonl"),
			now: FIXED_NOW,
		});
		const stored = await store.append(proposal);
		expect(stored.status).toBe("pending_review");
		expect(stored.proposalId).toMatch(/^proposal:/);
		expect(stored.metadata?.application_mode).toBe("proposal_only");
	});

	it("rejects malformed input — trajectories must be an array, dryRun must be boolean", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		await expect(
			optimizer.optimize({
				// @ts-expect-error — intentionally malformed
				trajectories: "not an array",
			}),
		).rejects.toThrow(/trajectories must be an array/iu);
		await expect(
			optimizer.optimize({
				trajectories: [],
				// @ts-expect-error — intentionally malformed
				dryRun: "yes",
			}),
		).rejects.toThrow(/dryRun must be a boolean/iu);
		await expect(
			optimizer.optimize({
				trajectories: [],
				// @ts-expect-error — intentionally malformed
				now: "not a function",
			}),
		).rejects.toThrow(/now must be a function/iu);
	});

	it("falls back to a no-proposal reason for unknown / non-actionable failure categories", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		const result = await optimizer.optimize({
			trajectories: [
				trajectory({
					trajectoryRef: "trajectory:unknown",
					runId: "run-unknown",
					steps: [
						{
							index: 0,
							kind: "observation",
							label: "weird",
							error: "unrecognised failure shape with no keyword",
							evidenceRefs: [],
						},
					],
				}),
			],
		});

		expect(result.proposals).toHaveLength(0);
		const codes = result.noProposalReasons.map((reason) => reason.code);
		expect(codes).toContain("unknown_failure_not_actionable");
	});

	it("supports dryRun=true without throwing and still emits proposals deterministically", async () => {
		const optimizer = new PromptRewriteOptimizer({ now: FIXED_NOW });
		const a = await optimizer.optimize({
			trajectories: [trajectory()],
			dryRun: true,
		});
		const b = await optimizer.optimize({
			trajectories: [trajectory()],
			dryRun: true,
		});
		expect(a.proposals).toHaveLength(1);
		expect(b.proposals).toHaveLength(1);
		expect(a.proposals[0]?.evidenceHashes).toEqual(
			b.proposals[0]?.evidenceHashes,
		);
	});

	it("estimates failure reduction monotonically with cluster confidence (capped at 0.9)", () => {
		const high: FailureFinding = {
			category: "tool_error",
			confidence: "high",
			message: "tool error",
			evidenceRefs: ["tool-call:1"],
			proposalAllowed: true,
		};
		const medium: FailureFinding = {
			category: "tool_error",
			confidence: "medium",
			message: "tool error",
			evidenceRefs: ["tool-call:2"],
			proposalAllowed: true,
		};
		const low: FailureFinding = {
			category: "tool_error",
			confidence: "low",
			message: "tool error",
			evidenceRefs: ["tool-call:3"],
			proposalAllowed: true,
		};

		expect(estimatePromptRewriteFailureReduction([])).toBe(0);
		expect(estimatePromptRewriteFailureReduction([low])).toBeCloseTo(0.1, 5);
		expect(estimatePromptRewriteFailureReduction([medium])).toBeCloseTo(0.2, 5);
		expect(estimatePromptRewriteFailureReduction([high])).toBeCloseTo(0.4, 5);
		// Saturation cap.
		expect(
			estimatePromptRewriteFailureReduction([high, high, high]),
		).toBeCloseTo(0.9, 5);
		expect(
			estimatePromptRewriteFailureReduction([
				high,
				high,
				high,
				high,
				high,
				high,
			]),
		).toBe(0.9);
	});

	it("respects maxCandidates by capping fan-out across many failure categories", async () => {
		const optimizer = new PromptRewriteOptimizer({
			now: FIXED_NOW,
			maxCandidates: 1,
		});
		const result = await optimizer.optimize({
			trajectories: [
				trajectory({
					runId: "run-001",
					trajectoryRef: "trajectory:run-001",
					steps: [
						{
							index: 0,
							kind: "tool",
							label: "shell_exec",
							error: "command failed with exit code 2",
							evidenceRefs: ["tool-call:1"],
						},
					],
				}),
				trajectory({
					runId: "run-002",
					trajectoryRef: "trajectory:run-002",
					steps: [
						{
							index: 0,
							kind: "model",
							label: "structured_output",
							error: "Zod schema validation failed",
							evidenceRefs: ["model-output:1"],
						},
					],
				}),
			],
		});

		expect(result.proposals).toHaveLength(1);
	});
});
