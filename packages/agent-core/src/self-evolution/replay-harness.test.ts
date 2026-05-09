import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createMockDspyClient,
	renderReport,
	runArmWithSeeds,
	runBaselineArm,
	runDspyArm,
	summarizeArm,
} from "./bench-runner.js";
import {
	type BenchmarkTrajectoryEntry,
	entryToTrajectoryRecord,
	harnessFromEntries,
	loadReplayHarness,
	parseTrajectoriesJsonl,
	relativeLift,
	replayTrajectories,
	wilsonInterval,
} from "./replay-harness.js";
import type { OptimizationProposalDraft } from "./types.js";

function entry(
	overrides: Partial<BenchmarkTrajectoryEntry> = {},
): BenchmarkTrajectoryEntry {
	return {
		id: overrides.id ?? "traj-001",
		category: overrides.category ?? "tool_error",
		task: overrides.task ?? "run failing shell command",
		trajectory: overrides.trajectory ?? [
			{
				index: 0,
				kind: "tool",
				label: "shell_exec",
				error: "command failed exit code 2",
				evidenceRefs: ["tool-call:1"],
			},
		],
		failure_signal:
			overrides.failure_signal ?? "shell_exec returned non-zero exit code",
		ground_truth_fix_direction:
			overrides.ground_truth_fix_direction ??
			"add preflight check before shell command invocation",
	};
}

function proposalWithText(text: string): OptimizationProposalDraft {
	return {
		title: "synthetic candidate",
		summary: text,
		artifacts: [
			{
				artifactId: "artifact:test",
				kind: "markdown",
				title: "synthetic guidance",
				content: text,
				contentHash: "deadbeef".repeat(8),
				sourceRefs: [],
			},
		],
		evidenceHashes: ["deadbeef".repeat(8)],
		riskPreview: {
			level: "low",
			reasons: [],
			touchesRuntime: false,
			requiresHumanReview: true,
		},
	};
}

describe("replay-harness — replayTrajectories", () => {
	it("returns zero counts on empty input", async () => {
		const harness = harnessFromEntries([]);
		const result = await replayTrajectories(harness);
		expect(result.passed).toBe(0);
		expect(result.failed).toBe(0);
		expect(result.raw).toEqual([]);
		expect(result.perCategory.tool_error).toEqual({ pass: 0, fail: 0 });
	});

	it("passes a single trajectory when guidance covers the fix direction", async () => {
		const harness = harnessFromEntries([entry()]);
		const result = await replayTrajectories(harness, {
			guidanceText:
				"add preflight check before shell command invocation to prevent tool errors",
		});
		expect(result.passed).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.raw[0]?.passed).toBe(true);
		expect(result.raw[0]?.matchedKeywords.length).toBeGreaterThan(0);
		expect(result.perCategory.tool_error).toEqual({ pass: 1, fail: 0 });
	});

	it("fails a trajectory when guidance is unrelated", async () => {
		const harness = harnessFromEntries([entry()]);
		const result = await replayTrajectories(harness, {
			guidanceText: "increase logging verbosity for downstream observability",
		});
		expect(result.passed).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.raw[0]?.passed).toBe(false);
		expect(result.raw[0]?.missedKeywords.length).toBeGreaterThan(0);
	});

	it("aggregates a mixed-category corpus correctly", async () => {
		const harness = harnessFromEntries([
			entry({ id: "t-1", category: "tool_error" }),
			entry({
				id: "t-2",
				category: "schema_violation",
				ground_truth_fix_direction:
					"restate schema and refuse to invent fields",
			}),
			entry({
				id: "t-3",
				category: "budget_exhaustion",
				ground_truth_fix_direction:
					"summarize prior context before exceeding budget",
			}),
			entry({
				id: "t-4",
				category: "missing_evidence",
				ground_truth_fix_direction:
					"require explicit citations for every assertion",
			}),
		]);
		const result = await replayTrajectories(harness, {
			guidanceText:
				"restate schema and refuse to invent fields; summarize prior context before exceeding budget",
		});
		expect(result.perCategory.schema_violation.pass).toBe(1);
		expect(result.perCategory.budget_exhaustion.pass).toBe(1);
		expect(result.perCategory.tool_error.fail).toBe(1);
		expect(result.perCategory.missing_evidence.fail).toBe(1);
		expect(result.passed).toBe(2);
		expect(result.failed).toBe(2);
	});

	it("uses proposal text when guidanceText is omitted", async () => {
		const harness = harnessFromEntries([entry()]);
		const result = await replayTrajectories(harness, {
			proposals: [
				proposalWithText(
					"add preflight check before shell command invocation handles tool errors",
				),
			],
		});
		expect(result.passed).toBe(1);
	});

	it("supports live mode by appending a stub LLM response to the prompt", async () => {
		const harness = harnessFromEntries([entry()]);
		const result = await replayTrajectories(harness, {
			mode: "live",
			liveStub: () =>
				"add preflight check before shell command invocation prevents tool errors",
		});
		expect(result.passed).toBe(1);
		expect(result.raw[0]?.matchedKeywords).toContain("preflight");
	});

	it("rejects live mode without a liveStub function", async () => {
		const harness = harnessFromEntries([entry()]);
		await expect(replayTrajectories(harness, { mode: "live" })).rejects.toThrow(
			/liveStub/u,
		);
	});

	it("rejects unknown mode strings", async () => {
		const harness = harnessFromEntries([entry()]);
		await expect(
			replayTrajectories(harness, { mode: "ghost" as never }),
		).rejects.toThrow(/unknown replay mode/u);
	});

	it("scores each entry against ONLY proposals targeting it via sourceRefs (round-2 fix)", async () => {
		// Round-2 fix: when a proposal's artifacts.sourceRefs includes
		// `trajectory:<entry.id>`, the entry is scored against that
		// proposal alone (not the union of all proposals). This isolates
		// per-proposal coverage so seed variance in the mock client
		// surfaces in per-seed pass/fail rates.
		const e1 = entry({ id: "t-target-1", category: "tool_error" });
		const e2 = entry({
			id: "t-target-2",
			category: "schema_violation",
			ground_truth_fix_direction: "restate schema and refuse free-form output",
		});
		const harness = harnessFromEntries([e1, e2]);
		const targetedProposal: OptimizationProposalDraft = {
			title: "for e1 only",
			summary:
				"add preflight check before shell command invocation handles tool errors",
			artifacts: [
				{
					artifactId: "a1",
					kind: "markdown",
					title: "shell guidance",
					content:
						"add preflight check before shell command invocation handles tool errors",
					contentHash: "0".repeat(64),
					sourceRefs: ["trajectory:t-target-1"],
				},
			],
			evidenceHashes: [],
			riskPreview: {
				level: "low",
				reasons: [],
				touchesRuntime: false,
				requiresHumanReview: true,
			},
		};
		// e2 has no targeted proposal → falls back to union (which here is
		// just the e1-targeted proposal — does NOT cover schema keywords).
		const result = await replayTrajectories(harness, {
			proposals: [targetedProposal],
		});
		expect(result.raw[0]?.id).toBe("t-target-1");
		expect(result.raw[0]?.passed).toBe(true);
		expect(result.raw[1]?.id).toBe("t-target-2");
		expect(result.raw[1]?.passed).toBe(false);
	});

	it("throws when harness is not an object", async () => {
		await expect(replayTrajectories(null as unknown as never)).rejects.toThrow(
			/ReplayHarness/u,
		);
	});

	it("throws when entries is not an array", async () => {
		await expect(
			replayTrajectories({ entries: "bad" as unknown as never }),
		).rejects.toThrow(/entries must be an array/u);
	});
});

describe("replay-harness — parseTrajectoriesJsonl", () => {
	it("parses multiple JSONL lines into immutable entries", () => {
		const lines = [
			JSON.stringify({
				id: "a",
				category: "tool_error",
				task: "task A",
				trajectory: [{ index: 0, kind: "tool", label: "x" }],
				failure_signal: "exit code 2",
				ground_truth_fix_direction: "add preflight check",
			}),
			JSON.stringify({
				id: "b",
				category: "schema_violation",
				task: "task B",
				trajectory: [{ index: 0, kind: "model", label: "respond" }],
				failure_signal: "invalid json",
				ground_truth_fix_direction: "restate schema",
			}),
		].join("\n");
		const entries = parseTrajectoriesJsonl(lines);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.id).toBe("a");
		expect(entries[1]?.category).toBe("schema_violation");
	});

	it("skips blank lines between entries", () => {
		const lines = [
			"",
			JSON.stringify({
				id: "a",
				category: "tool_error",
				task: "task A",
				trajectory: [{ index: 0, kind: "tool", label: "x" }],
				failure_signal: "exit code 2",
				ground_truth_fix_direction: "add preflight check",
			}),
			"",
		].join("\n");
		const entries = parseTrajectoriesJsonl(lines);
		expect(entries).toHaveLength(1);
	});

	it("rejects entries missing required fields", () => {
		const broken = JSON.stringify({
			id: "missing",
			category: "tool_error",
			task: "task",
			trajectory: [],
			// missing failure_signal + ground_truth_fix_direction
		});
		expect(() => parseTrajectoriesJsonl(broken)).toThrow(
			/missing required field/u,
		);
	});

	it("rejects unknown failure categories", () => {
		const broken = JSON.stringify({
			id: "a",
			category: "alien",
			task: "task",
			trajectory: [],
			failure_signal: "x",
			ground_truth_fix_direction: "y",
		});
		expect(() => parseTrajectoriesJsonl(broken)).toThrow(/FailureCategory/u);
	});

	it("rejects empty id strings", () => {
		const broken = JSON.stringify({
			id: "",
			category: "tool_error",
			task: "t",
			trajectory: [],
			failure_signal: "x",
			ground_truth_fix_direction: "y",
		});
		expect(() => parseTrajectoriesJsonl(broken)).toThrow(/non-empty string/u);
	});

	it("rejects non-array trajectory fields", () => {
		const broken = JSON.stringify({
			id: "a",
			category: "tool_error",
			task: "t",
			trajectory: "not-an-array",
			failure_signal: "x",
			ground_truth_fix_direction: "y",
		});
		expect(() => parseTrajectoriesJsonl(broken)).toThrow(/must be an array/u);
	});

	it("rejects malformed JSON lines", () => {
		expect(() => parseTrajectoriesJsonl("{not-json")).toThrow(
			/failed to parse/u,
		);
	});

	it("rejects entries that aren't objects", () => {
		expect(() => parseTrajectoriesJsonl(JSON.stringify([1, 2, 3]))).toThrow(
			/must be an object/u,
		);
	});

	it("normalizes step kind/index when entries omit them", () => {
		const line = JSON.stringify({
			id: "a",
			category: "tool_error",
			task: "task",
			trajectory: [{ label: "implicit" }],
			failure_signal: "x",
			ground_truth_fix_direction: "y",
		});
		const [parsedEntry] = parseTrajectoriesJsonl(line);
		expect(parsedEntry?.trajectory[0]?.kind).toBe("observation");
		expect(parsedEntry?.trajectory[0]?.index).toBe(0);
	});

	it("rejects empty failure_signal and ground_truth_fix_direction", () => {
		const brokenSignal = JSON.stringify({
			id: "a",
			category: "tool_error",
			task: "t",
			trajectory: [],
			failure_signal: "",
			ground_truth_fix_direction: "x",
		});
		expect(() => parseTrajectoriesJsonl(brokenSignal)).toThrow(
			/failure_signal/u,
		);
		const brokenFix = JSON.stringify({
			id: "a",
			category: "tool_error",
			task: "t",
			trajectory: [],
			failure_signal: "x",
			ground_truth_fix_direction: "",
		});
		expect(() => parseTrajectoriesJsonl(brokenFix)).toThrow(
			/ground_truth_fix_direction/u,
		);
	});

	it("rejects empty task strings", () => {
		const broken = JSON.stringify({
			id: "a",
			category: "tool_error",
			task: "",
			trajectory: [],
			failure_signal: "x",
			ground_truth_fix_direction: "y",
		});
		expect(() => parseTrajectoriesJsonl(broken)).toThrow(/task/u);
	});

	it("rejects non-object trajectory step entries", () => {
		const broken = JSON.stringify({
			id: "a",
			category: "tool_error",
			task: "t",
			trajectory: ["bad"],
			failure_signal: "x",
			ground_truth_fix_direction: "y",
		});
		expect(() => parseTrajectoriesJsonl(broken)).toThrow(/must be an object/u);
	});
});

describe("replay-harness — loadReplayHarness", () => {
	it("loads a JSONL file from disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-harness-"));
		const path = join(dir, "trajectories.jsonl");
		const line = JSON.stringify({
			id: "disk-1",
			category: "schema_violation",
			task: "schema test",
			trajectory: [{ index: 0, kind: "model", label: "respond" }],
			failure_signal: "invalid json",
			ground_truth_fix_direction: "restate schema",
		});
		await writeFile(path, line, "utf-8");
		const harness = await loadReplayHarness({ path });
		expect(harness.entries).toHaveLength(1);
		expect(harness.entries[0]?.id).toBe("disk-1");
	});

	it("rejects empty paths", async () => {
		await expect(loadReplayHarness({ path: "" })).rejects.toThrow(
			/non-empty path/u,
		);
	});
});

describe("replay-harness — entryToTrajectoryRecord", () => {
	it("converts an entry into a StoredTrajectoryRecord", () => {
		const record = entryToTrajectoryRecord(entry());
		expect(record.outcome).toBe("failure");
		expect(record.taskRef).toBe("run failing shell command");
		expect(record.failures?.[0]?.category).toBe("tool_error");
		expect(record.trajectoryRef).toBe("trajectory:traj-001");
	});

	it("respects an injected createdAt timestamp", () => {
		const record = entryToTrajectoryRecord(entry(), {
			createdAt: "2026-06-01T00:00:00.000Z",
		});
		expect(record.createdAt).toBe("2026-06-01T00:00:00.000Z");
	});
});

describe("replay-harness — wilsonInterval", () => {
	it("returns [0, 0] when n is zero", () => {
		expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 0 });
	});

	it("clamps the interval to [0, 1]", () => {
		const high = wilsonInterval(10, 10);
		expect(high.lower).toBeGreaterThan(0);
		expect(high.upper).toBeLessThanOrEqual(1);
		const low = wilsonInterval(0, 10);
		expect(low.lower).toBeGreaterThanOrEqual(0);
		expect(low.upper).toBeLessThan(1);
	});

	it("produces a sensible interval for a balanced sample", () => {
		const interval = wilsonInterval(5, 10);
		expect(interval.lower).toBeLessThan(0.5);
		expect(interval.upper).toBeGreaterThan(0.5);
	});

	it("rejects non-finite inputs", () => {
		expect(() => wilsonInterval(Number.NaN, 10)).toThrow();
		expect(() => wilsonInterval(1, Number.POSITIVE_INFINITY)).toThrow();
	});

	it("matches exact Wilson formula values for n=50, success=13", () => {
		// Round-2 fix: lock the exact numerical values so refactors of the
		// Wilson formula don't drift silently. Reference values computed
		// from the Wilson score interval formula
		// (https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval)
		// for k=13, n=50, z=1.96 → [0.1587, 0.3955].
		const interval = wilsonInterval(13, 50);
		expect(interval.lower).toBeCloseTo(0.159, 2);
		expect(interval.upper).toBeCloseTo(0.396, 2);
	});

	it("matches exact Wilson formula values for n=150, success=39 (pooled 3-seed)", () => {
		// Round-2 fix: 3-seed pooling yields n=150 (50 entries × 3 seeds);
		// CI should be tighter than the n=50 single-seed case at the same
		// proportion (39/150 = 0.26 ≈ 13/50 = 0.26). Reference [0.1964, 0.3356].
		const single = wilsonInterval(13, 50);
		const pooled = wilsonInterval(39, 150);
		expect(pooled.upper - pooled.lower).toBeLessThan(
			single.upper - single.lower,
		);
		expect(pooled.lower).toBeCloseTo(0.196, 2);
		expect(pooled.upper).toBeCloseTo(0.336, 2);
	});
});

describe("bench-self-evolution — integration", () => {
	const miniCorpus: BenchmarkTrajectoryEntry[] = [
		{
			id: "i-1",
			category: "tool_error",
			task: "shell exec failure",
			trajectory: [
				{
					index: 0,
					kind: "tool",
					label: "shell_exec",
					error: "command failed exit code 1",
					evidenceRefs: ["tool-call:1"],
				},
			],
			failure_signal: "shell_exec returned non-zero exit code",
			ground_truth_fix_direction:
				"add preflight check before shell command invocation",
		},
		{
			id: "i-2",
			category: "schema_violation",
			task: "schema violation",
			trajectory: [
				{
					index: 0,
					kind: "model",
					label: "respond",
					error: "zod validation parse error",
					evidenceRefs: ["model:1"],
				},
			],
			failure_signal: "zod validation failed",
			ground_truth_fix_direction: "restate schema and refuse free-form output",
		},
		{
			id: "i-3",
			category: "budget_exhaustion",
			task: "budget exceeded",
			trajectory: [
				{
					index: 0,
					kind: "model",
					label: "respond",
					error: "max tokens budget exceeded",
					evidenceRefs: ["model:2"],
				},
			],
			failure_signal: "budget exhausted",
			ground_truth_fix_direction:
				"summarize prior context before exceeding budget cap",
		},
		{
			id: "i-4",
			category: "missing_evidence",
			task: "uncited claim",
			trajectory: [
				{
					index: 0,
					kind: "model",
					label: "respond",
					error: "missing evidence citation required",
					evidenceRefs: ["model:3"],
				},
			],
			failure_signal: "uncited claim",
			ground_truth_fix_direction:
				"require explicit citations and refuse uncited assertions",
		},
		{
			id: "i-5",
			category: "tool_error",
			task: "another tool error",
			trajectory: [
				{
					index: 0,
					kind: "tool",
					label: "shell_exec",
					error: "command failed permission denied",
					evidenceRefs: ["tool-call:2"],
				},
			],
			failure_signal: "permission denied tool call",
			ground_truth_fix_direction:
				"add preflight check before shell command invocation",
		},
	];

	it("runs the 3-arm bench loop on a 5-trajectory mini-corpus and writes a report", async () => {
		const baseline = await runArmWithSeeds(
			"PromptRewrite (baseline)",
			(seed) => runBaselineArm(miniCorpus, seed),
			2,
		);
		const mipro = await runArmWithSeeds(
			"DSPy + MIPROv2 (mocked)",
			(seed) => runDspyArm(miniCorpus, "mipro", seed),
			2,
		);
		const gepa = await runArmWithSeeds(
			"DSPy + GEPA (mocked)",
			(seed) => runDspyArm(miniCorpus, "gepa", seed),
			2,
		);
		expect(baseline.perSeedFailureRate).toHaveLength(2);
		expect(mipro.perSeedFailureRate).toHaveLength(2);
		expect(gepa.perSeedFailureRate).toHaveLength(2);
		// Round-2 fix: aggregate now pools across all seeds (5 × 2 = 10).
		expect(baseline.aggregate.passed + baseline.aggregate.failed).toBe(10);

		const report = renderReport({
			baseline,
			mipro,
			gepa,
			trajectoryCount: miniCorpus.length,
			seeds: 2,
			datasetHash: "test-dataset-hash",
			trajectoriesPath: "test/path.jsonl",
		});

		expect(report).toContain("Stage D — DSPy Validation Report");
		expect(report).toContain("MOCKED BENCHMARK DISCLOSURE");
		expect(report).toContain("Aggregate failure-rate table");
		expect(report).toContain("Per-FailureCategory breakdown");
		expect(report).toContain("Decision recommendation");
		expect(report).toContain("PromptRewrite (baseline)");
		expect(report).toContain("DSPy + MIPROv2 (mocked)");
		expect(report).toContain("DSPy + GEPA (mocked)");
		// Round-2 fix: report no longer renders commit hash to avoid the
		// "report hash points to pre-fix commit" reproducibility gap.
		expect(report).not.toContain("Commit hash");
	});

	it("persists the rendered report to a tmp file with required sections", async () => {
		const baseline = await runArmWithSeeds(
			"PromptRewrite (baseline)",
			(seed) => runBaselineArm(miniCorpus, seed),
			1,
		);
		const mipro = await runArmWithSeeds(
			"DSPy + MIPROv2 (mocked)",
			(seed) => runDspyArm(miniCorpus, "mipro", seed),
			1,
		);
		const gepa = await runArmWithSeeds(
			"DSPy + GEPA (mocked)",
			(seed) => runDspyArm(miniCorpus, "gepa", seed),
			1,
		);
		const report = renderReport({
			baseline,
			mipro,
			gepa,
			trajectoryCount: miniCorpus.length,
			seeds: 1,
			datasetHash: "def",
			trajectoriesPath: "tmp.jsonl",
		});
		const dir = await mkdtemp(join(tmpdir(), "bench-integration-"));
		const reportPath = join(dir, "report.md");
		await writeFile(reportPath, report, "utf-8");
		const persisted = await readFile(reportPath, "utf-8");
		expect(persisted).toContain("# Stage D");
		expect(persisted).toContain("Reproducibility");
		expect(persisted).toContain("Lift summary");
		expect(persisted).toContain("MOCK 数据声明");
	});

	it("DSPy mipro arm produces non-identical per-seed failure rates on a 50-entry corpus (round-2 fix)", async () => {
		// Round-2 fix: lock the property that 3 mipro seeds DO NOT produce
		// identical failure rates anymore. Pre-fix the seed multiplier
		// collapsed to identical thresholds + same-category fallbacks
		// nearly equal to ground truth, so all seeds reported the exact
		// same number.
		const corpus: BenchmarkTrajectoryEntry[] = Array.from(
			{ length: 50 },
			(_, idx) => {
				const cats = [
					"tool_error",
					"schema_violation",
					"budget_exhaustion",
					"missing_evidence",
				] as const;
				const cat = cats[idx % 4] as BenchmarkTrajectoryEntry["category"];
				const gt = {
					tool_error: "add preflight check before shell command invocation",
					schema_violation: "restate schema and refuse free-form output",
					budget_exhaustion:
						"summarize prior context before exceeding budget cap",
					missing_evidence:
						"require explicit citations and refuse uncited assertions",
				} as const;
				return {
					id: `e-${idx}`,
					category: cat,
					task: `task ${idx}`,
					trajectory: [{ index: 0, kind: "observation", label: "step" }],
					failure_signal: `signal ${idx}`,
					ground_truth_fix_direction: gt[cat as keyof typeof gt],
				};
			},
		);
		const arm = await runArmWithSeeds(
			"mipro test",
			(seed) => runDspyArm(corpus, "mipro", seed),
			3,
		);
		expect(arm.perSeedFailureRate).toHaveLength(3);
		const unique = new Set(arm.perSeedFailureRate.map((r) => r.toFixed(4)));
		// At least 2 distinct values across 3 seeds — round-2 acceptance.
		expect(unique.size).toBeGreaterThanOrEqual(2);
	});

	it("pools BenchmarkResult counts across all seeds before computing Wilson CI (round-2 fix)", () => {
		// Round-2 fix: summarizeArm previously used only perSeedResults[0]
		// to derive the aggregate; with seeds=3 this collapsed n from
		// 5*3=15 to just 5, widening the Wilson CI artificially. Lock the
		// pooling behavior here.
		const seedResult = (passed: number, failed: number) => ({
			passed,
			failed,
			perCategory: {
				tool_error: { pass: passed, fail: failed },
				schema_violation: { pass: 0, fail: 0 },
				budget_exhaustion: { pass: 0, fail: 0 },
				missing_evidence: { pass: 0, fail: 0 },
				unknown: { pass: 0, fail: 0 },
			},
			raw: [],
		});
		const arm = summarizeArm("test", [
			seedResult(40, 10),
			seedResult(40, 10),
			seedResult(40, 10),
		]);
		expect(arm.aggregate.passed).toBe(120);
		expect(arm.aggregate.failed).toBe(30);
		expect(arm.aggregate.perCategory.tool_error).toEqual({
			pass: 120,
			fail: 30,
		});
		// CI on n=150 should be tighter than on n=50 at the same proportion.
		const single = summarizeArm("single", [seedResult(40, 10)]);
		expect(arm.wilsonUpper - arm.wilsonLower).toBeLessThan(
			single.wilsonUpper - single.wilsonLower,
		);
	});

	it("createMockDspyClient produces seed-dependent variance with per-entry sourceRefs (round-2 fix)", async () => {
		// Round-2 fix: the prior (seed * 17 + i * 31) mod 100 hash combined
		// with category dedupe made 3 mipro seeds produce identical output.
		// New (seed * 991 + i * 71) mod 1000 with no category dedupe and
		// cross-category fallback templates must give meaningfully different
		// proposals across seeds AND per-entry scoring must surface that
		// variance into per-seed failure rates.
		const corpus: BenchmarkTrajectoryEntry[] = Array.from(
			{ length: 50 },
			(_, idx) => ({
				id: `e-${idx}`,
				category: (
					[
						"tool_error",
						"schema_violation",
						"budget_exhaustion",
						"missing_evidence",
					] as const
				)[idx % 4] as BenchmarkTrajectoryEntry["category"],
				task: `task ${idx}`,
				trajectory: [{ index: 0, kind: "observation", label: "step" }],
				failure_signal: `signal ${idx}`,
				ground_truth_fix_direction: (
					{
						tool_error: "add preflight check before shell command invocation",
						schema_violation: "restate schema and refuse free-form output",
						budget_exhaustion:
							"summarize prior context before exceeding budget cap",
						missing_evidence:
							"require explicit citations and refuse uncited assertions",
					} as const
				)[
					(
						[
							"tool_error",
							"schema_violation",
							"budget_exhaustion",
							"missing_evidence",
						] as const
					)[idx % 4]
				],
			}),
		);
		const trajectoriesArg = corpus.map((e) => ({
			trajectoryRef: `trajectory:${e.id}`,
		}));
		const callOnce = async (seed: number) => {
			const client = createMockDspyClient("mipro", corpus, seed);
			const raw = await client.callTool("mipro_optimize", {
				trajectories: trajectoriesArg,
			});
			return JSON.parse(raw) as {
				readonly proposals: readonly {
					readonly artifacts: readonly { readonly content: string }[];
				}[];
			};
		};
		const out0 = await callOnce(0);
		const out1 = await callOnce(1);
		const out2 = await callOnce(2);
		// All 50 entries should produce a proposal — no per-category dedupe.
		expect(out0.proposals.length).toBe(50);
		expect(out1.proposals.length).toBe(50);
		expect(out2.proposals.length).toBe(50);
		// Cross-seed JSON should not be identical (the bug round-1 had).
		expect(JSON.stringify(out0.proposals)).not.toBe(
			JSON.stringify(out1.proposals),
		);
		expect(JSON.stringify(out1.proposals)).not.toBe(
			JSON.stringify(out2.proposals),
		);
	});
});

describe("replay-harness — relativeLift", () => {
	it("returns positive lift when candidate has lower failure rate", () => {
		expect(relativeLift(0.5, 0.25)).toBeCloseTo(0.5, 4);
	});

	it("returns 0 when baseline did not fail and candidate also did not fail", () => {
		expect(relativeLift(0, 0)).toBe(0);
	});

	it("returns -Infinity when baseline is perfect but candidate regresses", () => {
		// Round-2 fix: previously returned 0 here, silently masking
		// regressions from a perfect baseline. -Infinity makes the
		// regression visible to Math.max(...)-style decision logic.
		expect(relativeLift(0, 0.1)).toBe(Number.NEGATIVE_INFINITY);
		expect(relativeLift(0, 0.5)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("returns negative lift when candidate is worse than baseline", () => {
		expect(relativeLift(0.3, 0.6)).toBeCloseTo(-1, 4);
	});

	it("rejects non-finite inputs", () => {
		expect(() => relativeLift(Number.NaN, 0)).toThrow();
		expect(() => relativeLift(0, Number.POSITIVE_INFINITY)).toThrow();
	});
});
