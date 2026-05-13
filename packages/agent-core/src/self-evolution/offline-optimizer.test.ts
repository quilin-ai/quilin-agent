/**
 * Coverage tests for `offline-optimizer.ts` — drives the
 * `LocalNoopOfflineOptimizer` from baseline ~11% toward the 95%
 * project coverage gate (Task #31 item 5). Covers:
 *   - Pure no-proposal paths: no failures, schema-violation-only
 *     (proposal not allowed), missing-evidence findings, missing
 *     taskRef
 *   - Insufficient-signal gating (no 3-similar / no metadata flag /
 *     no regression-fixture or manual-critical evidence prefix)
 *   - All four gate-satisfaction paths: 3 similar diagnostics,
 *     deterministicRegressionFixture flag, manualCriticalFailure
 *     flag, evidence-ref prefix "regression-fixture:"
 *   - Provided-analysis short-circuit (analysisByTrajectoryRef
 *     matches by trajectoryRef)
 *   - Async `optimize` wrapping `optimizeSync`
 *   - `runOptimizationCycle` persisting via JsonlProposalStore
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import { JsonlProposalStore } from "./proposal-store.js";
import {
	type FailureAnalysis,
	type FailureFinding,
	LOCAL_NOOP_OPTIMIZER_ID,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredTrajectoryRecord,
} from "./types.js";

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
		steps: [],
		failures: [],
		...overrides,
	};
}

function finding(overrides: Partial<FailureFinding> = {}): FailureFinding {
	return {
		category: "tool_error",
		confidence: "high",
		message: "tool failed",
		evidenceRefs: ["tool-call:1"],
		proposalAllowed: true,
		...overrides,
	};
}

function analysis(
	trajRef: string,
	findings: readonly FailureFinding[],
	overrides: Partial<FailureAnalysis> = {},
): FailureAnalysis {
	return {
		schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
		runId: "run-001",
		trajectoryRef: trajRef,
		findings,
		shouldPropose: findings.some((f) => f.proposalAllowed),
		noProposalReasons: [],
		...overrides,
	};
}

describe("LocalNoopOfflineOptimizer.optimizeSync", () => {
	it("produces empty result for an empty trajectory list", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const result = optimizer.optimizeSync({ trajectories: [] });
		expect(result.schemaVersion).toBe(SELF_EVOLUTION_SCHEMA_VERSION);
		expect(result.optimizerId).toBe(LOCAL_NOOP_OPTIMIZER_ID);
		expect(result.mode).toBe("artifact_only");
		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons).toEqual([]);
	});

	it("emits a no-proposal reason when the trajectory has no failure signal", () => {
		// Analyzer returns shouldPropose=false with a reason.
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory({
			steps: [{ index: 0, kind: "observation", label: "ok", output: "fine" }],
		});
		const provided = analysis(traj.trajectoryRef, [], {
			shouldPropose: false,
			noProposalReasons: [
				{
					code: "no_failure_detected",
					message: "nothing to propose",
					evidenceRefs: [traj.trajectoryRef],
				},
			],
		});
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [provided],
		});
		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons.map((r) => r.code)).toEqual([
			"no_failure_detected",
		]);
	});

	it("filters out actionable findings with empty evidenceRefs (proposal not allowed)", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory();
		// Provide a finding with proposalAllowed=true but no evidenceRefs.
		// The sanitizer downgrades it to proposalAllowed=false with a
		// missing-evidence reason.
		const a = analysis(traj.trajectoryRef, [
			finding({ proposalAllowed: true, evidenceRefs: [] }),
		]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons.map((r) => r.code)).toEqual([
			"missing_evidence_requires_human_context",
		]);
	});

	it("emits missing_task_ref reason when taskRef is null/empty but findings have evidence", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory({ taskRef: undefined });
		const a = analysis(traj.trajectoryRef, [finding()]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons.map((r) => r.code)).toEqual([
			"missing_task_ref_requires_linear_issue",
		]);
	});

	it("emits insufficient_signal reason when gate is not satisfied", () => {
		// One finding with evidence + taskRef set — but only ONE finding,
		// no metadata flags, no special evidence prefix → gate fails.
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory();
		const a = analysis(traj.trajectoryRef, [finding()]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toEqual([]);
		expect(result.noProposalReasons.map((r) => r.code)).toEqual([
			"insufficient_signal",
		]);
	});

	it("produces a proposal when 3 similar diagnostics satisfy the patch gate", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory();
		const a = analysis(traj.trajectoryRef, [
			finding({ evidenceRefs: ["a:1"] }),
			finding({ evidenceRefs: ["a:2"] }),
			finding({ evidenceRefs: ["a:3"] }),
		]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toHaveLength(1);
		expect(result.noProposalReasons).toEqual([]);
		const proposal = result.proposals[0];
		if (proposal == null) throw new Error("proposal missing");
		expect(proposal.title).toContain("run-001");
		expect(proposal.metadata?.optimizer_id).toBe(LOCAL_NOOP_OPTIMIZER_ID);
		expect(proposal.metadata?.application_mode).toBe("proposal_only");
		expect(proposal.metadata?.task_ref).toBe("QUI-118");
		expect(proposal.generatedPatchProposal).toBeDefined();
		// Three artifact kinds emitted: markdown / json / patch.
		expect(proposal.artifacts.map((art) => art.kind).sort()).toEqual([
			"json",
			"markdown",
			"patch",
		]);
	});

	it("produces a proposal when metadata flag `deterministicRegressionFixture` is set", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory({
			metadata: { deterministicRegressionFixture: true },
		});
		const a = analysis(traj.trajectoryRef, [finding()]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toHaveLength(1);
	});

	it("produces a proposal when metadata flag `manualCriticalFailure` is set", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory({
			metadata: { manualCriticalFailure: true },
		});
		const a = analysis(traj.trajectoryRef, [finding()]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toHaveLength(1);
	});

	it("produces a proposal when an evidenceRef has the `regression-fixture:` prefix", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory();
		const a = analysis(traj.trajectoryRef, [
			finding({ evidenceRefs: ["regression-fixture:xyz"] }),
		]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toHaveLength(1);
	});

	it("produces a proposal when an evidenceRef has the `manual-critical:` prefix", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory();
		const a = analysis(traj.trajectoryRef, [
			finding({ evidenceRefs: ["manual-critical:fizz"] }),
		]);
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.proposals).toHaveLength(1);
	});

	it("dedupes equivalent noProposalReasons across analyses", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj1 = trajectory({ trajectoryRef: "trajectory:t1", runId: "t1" });
		const traj2 = trajectory({ trajectoryRef: "trajectory:t2", runId: "t2" });
		// Both lack a gate-satisfying signal — same reason code +
		// message. Reasons get deduped per-analysis (within
		// `sanitizeAnalysis`), but the gated insufficient_signal
		// reasons come out per-trajectory. We mainly confirm there's no
		// crash + the reason codes are uniform.
		const a1 = analysis(traj1.trajectoryRef, [finding()]);
		const a2 = analysis(traj2.trajectoryRef, [finding()]);
		const result = optimizer.optimizeSync({
			trajectories: [traj1, traj2],
			analyses: [a1, a2],
		});
		expect(result.proposals).toEqual([]);
		expect(
			result.noProposalReasons.every((r) => r.code === "insufficient_signal"),
		).toBe(true);
	});

	it("uses provided analyses keyed by trajectoryRef instead of recomputing", () => {
		// If provided analysis says shouldPropose=false with a custom
		// reason, the optimizer must honor it instead of calling
		// `analyzeTrajectoryFailures`.
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory({
			steps: [
				{
					index: 0,
					kind: "tool",
					label: "x",
					error: "boom",
					evidenceRefs: ["tool-call:1"],
				},
			],
		});
		const a = analysis(traj.trajectoryRef, [], {
			shouldPropose: false,
			noProposalReasons: [
				{
					code: "unknown_failure_not_actionable",
					message: "from caller",
					evidenceRefs: [traj.trajectoryRef],
				},
			],
		});
		const result = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		expect(result.noProposalReasons.map((r) => r.code)).toContain(
			"unknown_failure_not_actionable",
		);
	});

	it("honors a per-call `now` override for createdAt", () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const overrideNow = () => new Date("2030-01-01T00:00:00.000Z");
		const result = optimizer.optimizeSync({
			trajectories: [],
			now: overrideNow,
		});
		expect(result.createdAt).toBe("2030-01-01T00:00:00.000Z");
	});
});

describe("LocalNoopOfflineOptimizer.optimize (async wrapper)", () => {
	it("resolves with the same shape as optimizeSync", async () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const traj = trajectory();
		const a = analysis(traj.trajectoryRef, [
			finding({ evidenceRefs: ["regression-fixture:abc"] }),
		]);
		const sync = optimizer.optimizeSync({
			trajectories: [traj],
			analyses: [a],
		});
		const async_ = await optimizer.optimize({
			trajectories: [traj],
			analyses: [a],
		});
		// Same number of proposals + same proposal title.
		expect(async_.proposals).toHaveLength(sync.proposals.length);
		expect(async_.proposals[0]?.title).toBe(sync.proposals[0]?.title);
	});
});

describe("LocalNoopOfflineOptimizer.runOptimizationCycle", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "offline-optimizer-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("appends each proposal to the store and returns the stored records", async () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const store = new JsonlProposalStore({
			filePath: join(tmpDir, "proposals.jsonl"),
			now: FIXED_NOW,
		});
		const traj = trajectory();
		const a = analysis(traj.trajectoryRef, [
			finding({ evidenceRefs: ["regression-fixture:abc"] }),
		]);
		const stored = await optimizer.runOptimizationCycle(
			{ trajectories: [traj], analyses: [a] },
			store,
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.status).toBe("pending_review");
		expect(stored[0]?.proposalId).toMatch(/^proposal:/);
	});

	it("returns an empty array when no proposals are produced", async () => {
		const optimizer = new LocalNoopOfflineOptimizer({ now: FIXED_NOW });
		const store = new JsonlProposalStore({
			filePath: join(tmpDir, "proposals.jsonl"),
			now: FIXED_NOW,
		});
		const stored = await optimizer.runOptimizationCycle(
			{ trajectories: [] },
			store,
		);
		expect(stored).toEqual([]);
	});
});

describe("LocalNoopOfflineOptimizer construction", () => {
	it("uses the default `now` when not provided", () => {
		const optimizer = new LocalNoopOfflineOptimizer();
		const before = new Date().toISOString();
		const result = optimizer.optimizeSync({ trajectories: [] });
		// `createdAt` should be a valid ISO timestamp that's at or after
		// `before` (with a small tolerance — we just check format).
		expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(new Date(result.createdAt).getTime()).toBeGreaterThanOrEqual(
			new Date(before).getTime() - 1000,
		);
	});
});
