import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	renderReport,
	runArmWithSeeds,
	runBaselineArm,
	runDspyArm,
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
		expect(baseline.aggregate.passed + baseline.aggregate.failed).toBe(5);

		const report = renderReport({
			baseline,
			mipro,
			gepa,
			trajectoryCount: miniCorpus.length,
			seeds: 2,
			commitHash: "test-commit",
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
			commitHash: "abc",
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
});

describe("replay-harness — relativeLift", () => {
	it("returns positive lift when candidate has lower failure rate", () => {
		expect(relativeLift(0.5, 0.25)).toBeCloseTo(0.5, 4);
	});

	it("returns 0 when baseline did not fail", () => {
		expect(relativeLift(0, 0.1)).toBe(0);
	});

	it("returns negative lift when candidate is worse than baseline", () => {
		expect(relativeLift(0.3, 0.6)).toBeCloseTo(-1, 4);
	});

	it("rejects non-finite inputs", () => {
		expect(() => relativeLift(Number.NaN, 0)).toThrow();
		expect(() => relativeLift(0, Number.POSITIVE_INFINITY)).toThrow();
	});
});
