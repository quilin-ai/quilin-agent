import { readFile } from "node:fs/promises";
import type {
	FailureCategory,
	OptimizationProposalDraft,
	StoredTrajectoryRecord,
	TrajectoryStep,
} from "./types.js";

/**
 * Trajectory replay harness for Stage D (QUI-147) DSPy benchmark validation.
 *
 * The harness loads labeled failure trajectories from a JSONL file, replays
 * each one with deterministic mocked tool/LLM responses, and reports whether
 * the agent — under a given proposal-applied configuration — would still
 * fail. The "fail" signal is heuristic: a trajectory is considered "passing"
 * when the proposal text addresses the recorded `ground_truth_fix_direction`
 * keywords, and "failing" otherwise. This gives a reproducible, no-network
 * lift comparison between optimizer outputs without spinning up a real LLM.
 *
 * Stage D（QUI-147）的轨迹回放 harness。harness 从 JSONL 加载带标注的失败轨迹，
 * 用确定性的 mock 工具 / LLM 响应重放每条轨迹，统计在给定的"已应用提案"配置下
 * 还会不会失败。"通过"信号是启发式的：当提案文本覆盖到记录中的
 * `ground_truth_fix_direction` 关键字，则视为通过；否则视为失败。这样无需
 * 网络也能在不同 optimizer 输出之间得到可复现的 lift 对比。
 *
 * Hard constraints / 硬约束：
 * - No network calls, no real LLM, no real tool execution.
 * - All randomness is deterministic — the harness exposes a `seed` option but
 *   the default replay path is fully deterministic.
 * - Outputs are immutable; we never mutate caller-supplied arrays or records.
 */

export type ReplayMode = "replay" | "live";

export interface BenchmarkTrajectoryEntry {
	readonly id: string;
	readonly category: FailureCategory;
	readonly task: string;
	readonly trajectory: readonly TrajectoryStep[];
	readonly failure_signal: string;
	readonly ground_truth_fix_direction: string;
}

export interface TrajectoryResult {
	readonly id: string;
	readonly category: FailureCategory;
	readonly passed: boolean;
	readonly reason: string;
	readonly matchedKeywords: readonly string[];
	readonly missedKeywords: readonly string[];
}

export interface PerCategoryCount {
	readonly pass: number;
	readonly fail: number;
}

export interface BenchmarkResult {
	readonly passed: number;
	readonly failed: number;
	readonly perCategory: Readonly<Record<FailureCategory, PerCategoryCount>>;
	readonly raw: readonly TrajectoryResult[];
}

export interface ReplayHarness {
	readonly entries: readonly BenchmarkTrajectoryEntry[];
}

export interface ReplayHarnessLoadOptions {
	readonly path: string;
}

export interface ReplayOptions {
	readonly mode?: ReplayMode;
	readonly proposals?: readonly OptimizationProposalDraft[];
	/**
	 * Optional explicit guidance text — used when the caller has not produced
	 * `OptimizationProposalDraft` objects but wants to score arbitrary text
	 * (e.g. baseline runs, ablation experiments).
	 *
	 * 可选的显式 guidance 文本 —— 当调用方没有 `OptimizationProposalDraft`
	 * 但想对任意文本打分（baseline 跑、ablation 实验）时使用。
	 */
	readonly guidanceText?: string;
	/**
	 * In `live` mode the caller must supply a stub LLM response generator.
	 * Returns the synthetic agent answer for the given prompt. The harness
	 * scoring is identical to replay mode — the difference is the prompt
	 * text fed in.
	 *
	 * `live` 模式下调用方必须提供 stub LLM 响应函数。给定 prompt 返回
	 * 合成的 agent 答案。harness 评分逻辑与 replay 模式一致，区别只在
	 * 输入 prompt。
	 */
	readonly liveStub?: (prompt: string) => string;
	readonly seed?: number;
}

const REQUIRED_KEYS = [
	"id",
	"category",
	"task",
	"trajectory",
	"failure_signal",
	"ground_truth_fix_direction",
] as const;

const KNOWN_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>(
	[
		"tool_error",
		"schema_violation",
		"budget_exhaustion",
		"missing_evidence",
		"unknown",
	],
);

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((item): item is string => typeof item === "string")
	);
}

function asTrajectoryStep(raw: unknown, index: number): TrajectoryStep {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError(`trajectory[${index}] must be an object`);
	}
	const record = raw as Record<string, unknown>;
	const stepIndexValue = record.index;
	const stepIndex =
		typeof stepIndexValue === "number" && Number.isInteger(stepIndexValue)
			? stepIndexValue
			: index;
	const kindValue = record.kind;
	const kind =
		kindValue === "model" ||
		kindValue === "tool" ||
		kindValue === "checkpoint" ||
		kindValue === "observation"
			? kindValue
			: "observation";
	const labelValue = record.label;
	const label = typeof labelValue === "string" ? labelValue : "step";
	const evidenceRefsRaw = record.evidenceRefs;
	const evidenceRefs = isStringArray(evidenceRefsRaw)
		? evidenceRefsRaw
		: undefined;
	return {
		index: stepIndex,
		kind,
		label,
		...(record.error === undefined ? {} : { error: record.error as never }),
		...(record.input === undefined ? {} : { input: record.input as never }),
		...(record.output === undefined ? {} : { output: record.output as never }),
		...(evidenceRefs === undefined ? {} : { evidenceRefs }),
	};
}

function parseEntry(
	line: string,
	lineNumber: number,
): BenchmarkTrajectoryEntry {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		throw new TypeError(`empty line at trajectories.jsonl:${lineNumber}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "unknown parse error";
		throw new TypeError(
			`failed to parse trajectories.jsonl:${lineNumber} — ${message}`,
		);
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} entry must be an object`,
		);
	}
	const record = parsed as Record<string, unknown>;
	for (const key of REQUIRED_KEYS) {
		if (!(key in record)) {
			throw new TypeError(
				`trajectories.jsonl:${lineNumber} missing required field "${key}"`,
			);
		}
	}
	const id = record.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} field "id" must be a non-empty string`,
		);
	}
	const categoryValue = record.category;
	if (
		typeof categoryValue !== "string" ||
		!KNOWN_CATEGORIES.has(categoryValue as FailureCategory)
	) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} field "category" must be a known FailureCategory`,
		);
	}
	const taskValue = record.task;
	if (typeof taskValue !== "string" || taskValue.length === 0) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} field "task" must be a non-empty string`,
		);
	}
	const trajectoryRaw = record.trajectory;
	if (!Array.isArray(trajectoryRaw)) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} field "trajectory" must be an array`,
		);
	}
	const trajectory = trajectoryRaw.map((step, index) =>
		asTrajectoryStep(step, index),
	);
	const failureSignalValue = record.failure_signal;
	if (
		typeof failureSignalValue !== "string" ||
		failureSignalValue.length === 0
	) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} field "failure_signal" must be a non-empty string`,
		);
	}
	const fixDirectionValue = record.ground_truth_fix_direction;
	if (typeof fixDirectionValue !== "string" || fixDirectionValue.length === 0) {
		throw new TypeError(
			`trajectories.jsonl:${lineNumber} field "ground_truth_fix_direction" must be a non-empty string`,
		);
	}
	return {
		id,
		category: categoryValue as FailureCategory,
		task: taskValue,
		trajectory,
		failure_signal: failureSignalValue,
		ground_truth_fix_direction: fixDirectionValue,
	};
}

/**
 * Parse a JSONL string into immutable benchmark entries.
 *
 * 将 JSONL 字符串解析为不可变 benchmark 条目。
 */
export function parseTrajectoriesJsonl(
	contents: string,
): readonly BenchmarkTrajectoryEntry[] {
	const lines = contents.split(/\r?\n/u);
	const entries: BenchmarkTrajectoryEntry[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) {
			continue;
		}
		entries.push(parseEntry(line, index + 1));
	}
	return entries;
}

/**
 * Load a `ReplayHarness` from a JSONL file on disk.
 *
 * 从磁盘 JSONL 文件加载 `ReplayHarness`。
 */
export async function loadReplayHarness(
	options: ReplayHarnessLoadOptions,
): Promise<ReplayHarness> {
	const { path } = options;
	if (typeof path !== "string" || path.length === 0) {
		throw new TypeError("loadReplayHarness requires a non-empty path");
	}
	const contents = await readFile(path, "utf-8");
	const entries = parseTrajectoriesJsonl(contents);
	return { entries };
}

/**
 * Build a `ReplayHarness` from in-memory entries — used by tests so we don't
 * need to touch disk.
 *
 * 从内存条目构建 `ReplayHarness` —— 测试时使用，避免触盘。
 */
export function harnessFromEntries(
	entries: readonly BenchmarkTrajectoryEntry[],
): ReplayHarness {
	return { entries: [...entries] };
}

/**
 * Convert a benchmark entry into a `StoredTrajectoryRecord` so it can be fed
 * to the existing `OfflineOptimizer` pipeline (`PromptRewriteOptimizer`,
 * `DspyOfflineOptimizer`, etc.) without reshaping the optimizer interface.
 *
 * 把 benchmark 条目转换成 `StoredTrajectoryRecord`，方便复用现有
 * optimizer 管线（`PromptRewriteOptimizer`、`DspyOfflineOptimizer` 等）。
 */
export function entryToTrajectoryRecord(
	entry: BenchmarkTrajectoryEntry,
	options: { readonly createdAt?: string } = {},
): StoredTrajectoryRecord {
	const createdAt = options.createdAt ?? "2026-05-10T00:00:00.000Z";
	const trajectoryRef = `trajectory:${entry.id}`;
	const failureMessage = entry.failure_signal;
	return {
		schemaVersion: 1,
		runId: entry.id,
		taskRef: entry.task,
		outcome: "failure",
		createdAt,
		trajectoryRef,
		contentHash: "0".repeat(64),
		steps: entry.trajectory,
		failures: [
			{
				message: failureMessage,
				category: entry.category,
				evidenceRefs: [trajectoryRef],
			},
		],
	};
}

function tokenize(value: string): readonly string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((token) => token.length >= 4);
}

function uniqueTokens(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}

function gatherProposalText(
	proposals: readonly OptimizationProposalDraft[] | undefined,
	guidanceText: string | undefined,
): string {
	const buckets: string[] = [];
	if (typeof guidanceText === "string" && guidanceText.length > 0) {
		buckets.push(guidanceText);
	}
	for (const proposal of proposals ?? []) {
		buckets.push(proposal.title);
		buckets.push(proposal.summary);
		for (const artifact of proposal.artifacts) {
			buckets.push(artifact.title);
			buckets.push(artifact.content);
		}
	}
	return buckets.join("\n");
}

const PASS_THRESHOLD = 0.5;

function score(
	entry: BenchmarkTrajectoryEntry,
	prompt: string,
): TrajectoryResult {
	const groundTruthTokens = uniqueTokens(
		tokenize(entry.ground_truth_fix_direction),
	);
	const promptTokens = new Set(tokenize(prompt));
	const matched: string[] = [];
	const missed: string[] = [];
	for (const token of groundTruthTokens) {
		if (promptTokens.has(token)) {
			matched.push(token);
		} else {
			missed.push(token);
		}
	}
	const ratio =
		groundTruthTokens.length === 0
			? 0
			: matched.length / groundTruthTokens.length;
	const passed = ratio >= PASS_THRESHOLD;
	return {
		id: entry.id,
		category: entry.category,
		passed,
		reason: passed
			? `proposal covers ${matched.length}/${groundTruthTokens.length} fix-direction keywords`
			: `proposal covers only ${matched.length}/${groundTruthTokens.length} fix-direction keywords`,
		matchedKeywords: matched,
		missedKeywords: missed,
	};
}

function emptyPerCategory(): Record<FailureCategory, PerCategoryCount> {
	return {
		tool_error: { pass: 0, fail: 0 },
		schema_violation: { pass: 0, fail: 0 },
		budget_exhaustion: { pass: 0, fail: 0 },
		missing_evidence: { pass: 0, fail: 0 },
		unknown: { pass: 0, fail: 0 },
	};
}

function aggregate(
	results: readonly TrajectoryResult[],
): Pick<BenchmarkResult, "passed" | "failed" | "perCategory"> {
	const perCategory = emptyPerCategory();
	let passed = 0;
	let failed = 0;
	for (const result of results) {
		const bucket = perCategory[result.category];
		if (result.passed) {
			passed += 1;
			perCategory[result.category] = {
				pass: bucket.pass + 1,
				fail: bucket.fail,
			};
		} else {
			failed += 1;
			perCategory[result.category] = {
				pass: bucket.pass,
				fail: bucket.fail + 1,
			};
		}
	}
	return { passed, failed, perCategory };
}

/**
 * Replay every trajectory in the harness and return aggregate pass/fail
 * counts along with per-trajectory raw results.
 *
 * 回放 harness 中的所有轨迹，返回总体 pass/fail 计数与每条轨迹的原始结果。
 */
export async function replayTrajectories(
	harness: ReplayHarness,
	options: ReplayOptions = {},
): Promise<BenchmarkResult> {
	if (harness == null || typeof harness !== "object") {
		throw new TypeError("replayTrajectories requires a ReplayHarness");
	}
	if (!Array.isArray(harness.entries)) {
		throw new TypeError("ReplayHarness.entries must be an array");
	}
	const mode: ReplayMode = options.mode ?? "replay";
	if (mode !== "replay" && mode !== "live") {
		throw new TypeError(`unknown replay mode: ${String(mode)}`);
	}
	if (mode === "live" && typeof options.liveStub !== "function") {
		throw new TypeError(
			"replayTrajectories(live mode) requires a liveStub function",
		);
	}
	const baselinePrompt = gatherProposalText(
		options.proposals,
		options.guidanceText,
	);
	const results: TrajectoryResult[] = [];
	for (const entry of harness.entries) {
		const prompt =
			mode === "live" && options.liveStub != null
				? `${baselinePrompt}\n${options.liveStub(
						`${entry.task}\n${entry.failure_signal}`,
					)}`
				: baselinePrompt;
		results.push(score(entry, prompt));
	}
	const aggregated = aggregate(results);
	return {
		...aggregated,
		raw: results,
	};
}

/**
 * Wilson score interval (95% confidence) — pure-TS implementation; no scipy.
 * `success` is the count of pass cases, `n` is the total trial count. Returns
 * `[lower, upper]` bounds in `[0, 1]`. Reference:
 * https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
 *
 * Wilson score interval（95% 置信）—— 纯 TS 实现，不依赖 scipy。
 */
export function wilsonInterval(
	success: number,
	n: number,
	z = 1.96,
): { readonly lower: number; readonly upper: number } {
	if (!Number.isFinite(success) || !Number.isFinite(n)) {
		throw new TypeError("wilsonInterval requires finite numeric inputs");
	}
	if (n <= 0) {
		return { lower: 0, upper: 0 };
	}
	const phat = success / n;
	const denom = 1 + (z * z) / n;
	const center = phat + (z * z) / (2 * n);
	const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
	const lower = Math.max(0, (center - margin) / denom);
	const upper = Math.min(1, (center + margin) / denom);
	return { lower, upper };
}

/**
 * Compute the relative failure-rate lift from baseline → candidate. Positive
 * values mean the candidate failed less often (i.e., better). Returns 0 when
 * the baseline did not fail (no headroom).
 *
 * 相对失败率 lift（baseline → candidate）。正值代表 candidate 失败率更低（更好）。
 * 当 baseline 失败率为 0 时返回 0（无可改进空间）。
 */
export function relativeLift(
	baselineFailureRate: number,
	candidateFailureRate: number,
): number {
	if (!Number.isFinite(baselineFailureRate)) {
		throw new TypeError("baselineFailureRate must be finite");
	}
	if (!Number.isFinite(candidateFailureRate)) {
		throw new TypeError("candidateFailureRate must be finite");
	}
	if (baselineFailureRate <= 0) {
		return 0;
	}
	return (baselineFailureRate - candidateFailureRate) / baselineFailureRate;
}
