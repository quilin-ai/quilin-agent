import { describe, expect, it, vi } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import { IdleEvolutionRunner } from "./idle-runner.js";
import type {
	FailureAnalysis,
	OfflineOptimizer,
	OfflineOptimizerInput,
	OfflineOptimizerResult,
	OptimizationProposalDraft,
	StoredTrajectoryRecord,
} from "./types.js";
import { SELF_EVOLUTION_SCHEMA_VERSION } from "./types.js";

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

function emptyAnalysis(record: StoredTrajectoryRecord): FailureAnalysis {
	return {
		schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
		runId: record.runId,
		trajectoryRef: record.trajectoryRef,
		findings: [],
		noProposalReasons: [],
		shouldPropose: false,
	};
}

function fakeProposal(title: string): OptimizationProposalDraft {
	return {
		title,
		summary: `summary for ${title}`,
		artifacts: [],
		evidenceHashes: [],
		riskPreview: {
			level: "medium",
			reasons: ["test"],
			touchesRuntime: false,
			requiresHumanReview: true,
		},
	};
}

interface OptimizerCall {
	readonly dryRun: boolean | undefined;
}

function fakeOptimizer(
	proposals: readonly OptimizationProposalDraft[],
	calls: OptimizerCall[],
): OfflineOptimizer {
	return {
		optimizerId: "test-optimizer",
		async optimize(input: OfflineOptimizerInput): Promise<OfflineOptimizerResult> {
			calls.push({ dryRun: input.dryRun });
			return {
				schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
				optimizerId: "test-optimizer",
				mode: "prompt_rewrite",
				createdAt: "2026-05-09T00:00:00.000Z",
				proposals,
				noProposalReasons: [],
			};
		},
	};
}

describe("IdleEvolutionRunner — WriteAuthority gating", () => {
	it("appends the proposal when WriteAuthority approves", async () => {
		const proposals = [fakeProposal("approved-1"), fakeProposal("approved-2")];
		const calls: OptimizerCall[] = [];
		const optimizer = fakeOptimizer(proposals, calls);
		const append = vi.fn().mockResolvedValue({});
		const authority = new WriteAuthority({
			mode: "auto-medium",
			actor: "test",
		});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 1_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			writeAuthority: authority,
			now: FIXED_NOW,
		});

		await runner.tryRun();

		expect(append).toHaveBeenCalledTimes(2);
		expect(append.mock.calls[0]?.[0]?.title).toBe("approved-1");
		expect(append.mock.calls[1]?.[0]?.title).toBe("approved-2");
	});

	it("denies the proposal append when WriteAuthority refuses (origin=idle in ask mode)", async () => {
		const proposals = [fakeProposal("denied")];
		const calls: OptimizerCall[] = [];
		const optimizer = fakeOptimizer(proposals, calls);
		const append = vi.fn().mockResolvedValue({});
		const authority = new WriteAuthority({
			mode: "ask", // ask + origin=idle => deny per §2.6.4 invariant 3
			actor: "test",
		});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 1_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			writeAuthority: authority,
			now: FIXED_NOW,
		});

		await runner.tryRun();

		expect(append).not.toHaveBeenCalled();
	});

	it("defaults to deny + skip when no WriteAuthority is configured", async () => {
		const proposals = [fakeProposal("ungated")];
		const calls: OptimizerCall[] = [];
		const optimizer = fakeOptimizer(proposals, calls);
		const append = vi.fn().mockResolvedValue({});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 1_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			now: FIXED_NOW,
		});

		await runner.tryRun();

		expect(append).not.toHaveBeenCalled();
	});

	it("late-binding setWriteAuthority enables subsequent appends", async () => {
		const proposals = [fakeProposal("late-bound")];
		const calls: OptimizerCall[] = [];
		const optimizer = fakeOptimizer(proposals, calls);
		const append = vi.fn().mockResolvedValue({});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 10_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			now: FIXED_NOW,
		});

		await runner.tryRun();
		expect(append).not.toHaveBeenCalled();

		runner.setWriteAuthority(
			new WriteAuthority({ mode: "auto-medium", actor: "test" }),
		);
		await runner.tryRun();
		expect(append).toHaveBeenCalledTimes(1);
		expect(append.mock.calls[0]?.[0]?.title).toBe("late-bound");
	});
});

describe("IdleEvolutionRunner — error handling", () => {
	it("does not throw when proposalStore.append rejects", async () => {
		const proposals = [fakeProposal("disk-full"), fakeProposal("recoverable")];
		const calls: OptimizerCall[] = [];
		const optimizer = fakeOptimizer(proposals, calls);
		const append = vi
			.fn()
			.mockRejectedValueOnce(new Error("ENOSPC: no space left"))
			.mockResolvedValueOnce({});
		const authority = new WriteAuthority({
			mode: "auto-medium",
			actor: "test",
		});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 1_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			writeAuthority: authority,
			now: FIXED_NOW,
		});

		// Must not throw — disk failures must not crash the idle tick / main loop.
		await expect(runner.tryRun()).resolves.toBeUndefined();
		expect(append).toHaveBeenCalledTimes(2);
	});
});

describe("IdleEvolutionRunner — dryRun semantics", () => {
	it("forwards dryRun to optimizer and skips persistence when dryRun=true", async () => {
		const proposals = [fakeProposal("inspect-only")];
		const calls: OptimizerCall[] = [];
		const optimizer = fakeOptimizer(proposals, calls);
		const append = vi.fn().mockResolvedValue({});
		const authority = new WriteAuthority({
			mode: "auto-medium",
			actor: "test",
		});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 1_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			writeAuthority: authority,
			dryRun: true,
			now: FIXED_NOW,
		});

		await runner.tryRun();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.dryRun).toBe(true);
		expect(append).not.toHaveBeenCalled();
	});
});
