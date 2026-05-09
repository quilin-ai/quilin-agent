import { createHash } from "node:crypto";
import {
	DspyOfflineOptimizer,
	type DspyOptimizerChoice,
	type DspyOptimizerMCPClient,
} from "./dspy-offline-optimizer.js";
import { analyzeTrajectoryFailures } from "./failure-analyzer.js";
import { PromptRewriteOptimizer } from "./prompt-rewrite-optimizer.js";
import {
	type BenchmarkResult,
	type BenchmarkTrajectoryEntry,
	entryToTrajectoryRecord,
	relativeLift,
	replayTrajectories,
	wilsonInterval,
} from "./replay-harness.js";
import type { FailureCategory, OptimizationProposalDraft } from "./types.js";

/**
 * Stage D bench-runner internals — moved out of `scripts/` so that the package
 * `tsconfig` (rootDir = `src/`) can type-check the integration tests that
 * import these helpers. The thin CLI wrapper at
 * `scripts/bench-self-evolution.ts` imports from this module.
 *
 * Stage D bench-runner 内部实现 —— 从 `scripts/` 搬到 `src/`，让
 * package tsconfig（rootDir = `src/`）可以 type-check 那些 import 这些
 * helper 的集成测试。`scripts/bench-self-evolution.ts` 是薄 CLI 包装。
 */

export interface ArmResult {
	readonly label: string;
	readonly perSeedFailureRate: readonly number[];
	readonly meanFailureRate: number;
	readonly wilsonLower: number;
	readonly wilsonUpper: number;
	readonly perCategory: Readonly<Record<FailureCategory, number>>;
	readonly aggregate: BenchmarkResult;
}

export interface ReportInput {
	readonly baseline: ArmResult;
	readonly mipro: ArmResult;
	readonly gepa: ArmResult;
	readonly trajectoryCount: number;
	readonly seeds: number;
	readonly commitHash: string;
	readonly datasetHash: string;
	readonly trajectoriesPath: string;
}

const FIX_DIRECTION_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
	tool_error: [
		"add preflight check before shell command invocation",
		"verify tool environment availability with preflight check",
		"add timeout retry with backoff before failing tool invocation",
		"validate path is within project root before file operations",
		"verify endpoint reachability before tool invocation",
	],
	schema_violation: [
		"restate schema and refuse to invent fields not in declared schema",
		"restate schema shape and emit fallback values matching schema",
		"restate schema required fields before emitting response",
		"restate schema type and emit fallback matching schema",
		"restate schema and refuse free-form non-json output",
	],
	budget_exhaustion: [
		"summarize prior context before exceeding budget cap",
		"prefer smaller intermediate plan and summarize before exceeding budget",
		"escalate to human when budget cap approaching exceeding",
		"summarize prior context chunk before exceeding budget",
	],
	missing_evidence: [
		"require explicit citations and refuse uncited assertions",
		"require evidence references for every numeric claim",
		"require explicit citations from log evidence for diagnosis assertion",
		"require evidence references and forbid uncited historical claims",
	],
	unknown: [
		"capture failure context for human triage and gather more evidence",
	],
};

/**
 * Mock DSPy MCP client. Returns proposals that simulate `MIPROv2` (~80%
 * full coverage) or `GEPA` (~70% full coverage) of the ground-truth fix
 * direction. Deterministic per (seed, choice). Used by the bench script
 * and the integration tests.
 *
 * Mock DSPy MCP client：模拟 `MIPROv2`（~80% 完全覆盖）/`GEPA`（~70% 完全
 * 覆盖）的地面真相修复方向输出。给定 (seed, choice) 完全确定。bench script
 * 与集成测试都使用它。
 */
export function createMockDspyClient(
	choice: DspyOptimizerChoice,
	entries: readonly BenchmarkTrajectoryEntry[],
	seed: number,
): DspyOptimizerMCPClient {
	const fullCoverageRate = choice === "mipro" ? 0.8 : 0.7;
	return {
		async callTool(
			name: string,
			args: Record<string, unknown>,
		): Promise<string> {
			const trajectoriesArg = Array.isArray(args.trajectories)
				? (args.trajectories as readonly { trajectoryRef?: string }[])
				: [];
			const proposals: OptimizationProposalDraft[] = [];
			const seenCategories = new Set<FailureCategory>();
			for (let i = 0; i < trajectoriesArg.length; i += 1) {
				const ref = trajectoriesArg[i]?.trajectoryRef ?? "";
				const id = ref.replace(/^trajectory:/, "");
				const entry = entries.find((e) => e.id === id);
				if (entry == null) {
					continue;
				}
				if (seenCategories.has(entry.category)) {
					continue;
				}
				seenCategories.add(entry.category);
				const seedHash = (i * 31 + seed * 17) % 100;
				const fullCoverage = seedHash < fullCoverageRate * 100;
				const guidance = fullCoverage
					? entry.ground_truth_fix_direction
					: ((FIX_DIRECTION_TEMPLATES[entry.category] ?? [])[0] ?? "");
				const summary = `${name}/${choice} guidance for ${entry.category}: ${guidance}`;
				proposals.push({
					title: `${choice.toUpperCase()} candidate for ${entry.category}`,
					summary,
					artifacts: [
						{
							artifactId: `artifact:${entry.category}-${i}`,
							kind: "markdown",
							title: `${choice} guidance — ${entry.category}`,
							content: `# guidance\n\n${guidance}\n\nfailure: ${entry.failure_signal}`,
							contentHash: createHash("sha256")
								.update(`${entry.category}-${i}-${seed}-${choice}`)
								.digest("hex"),
							sourceRefs: [ref],
						},
					],
					evidenceHashes: [],
					riskPreview: {
						level: "low",
						reasons: [`mock ${choice} run`],
						touchesRuntime: false,
						requiresHumanReview: true,
					},
				});
			}
			return JSON.stringify({
				schema_version: 1,
				optimizer_id: `dspy-${choice}-mock`,
				mode: "prompt_rewrite",
				created_at: new Date().toISOString(),
				proposals: proposals.map((p) => ({
					title: p.title,
					summary: p.summary,
					artifacts: p.artifacts,
					evidenceHashes: p.evidenceHashes,
					riskPreview: p.riskPreview,
				})),
				no_proposal_reasons: [],
			});
		},
	};
}

export async function runBaselineArm(
	entries: readonly BenchmarkTrajectoryEntry[],
	seed: number,
): Promise<BenchmarkResult> {
	const optimizer = new PromptRewriteOptimizer({
		now: () => new Date(`2026-05-10T0${seed}:00:00.000Z`),
	});
	const trajectories = entries.map((e) => entryToTrajectoryRecord(e));
	const analyses = trajectories.map(analyzeTrajectoryFailures);
	const result = await optimizer.optimize({ trajectories, analyses });
	return await replayTrajectories(
		{ entries: [...entries] },
		{ proposals: result.proposals },
	);
}

export async function runDspyArm(
	entries: readonly BenchmarkTrajectoryEntry[],
	choice: DspyOptimizerChoice,
	seed: number,
): Promise<BenchmarkResult> {
	const client = createMockDspyClient(choice, entries, seed);
	const optimizer = new DspyOfflineOptimizer({
		client,
		optimizerChoice: choice,
		now: () => new Date(`2026-05-10T0${seed}:00:00.000Z`),
	});
	const trajectories = entries.map((e) => entryToTrajectoryRecord(e));
	const analyses = trajectories.map(analyzeTrajectoryFailures);
	const result = await optimizer.optimize({ trajectories, analyses });
	return await replayTrajectories(
		{ entries: [...entries] },
		{ proposals: result.proposals },
	);
}

function emptyPerCategoryRate(): Record<FailureCategory, number> {
	return {
		tool_error: 0,
		schema_violation: 0,
		budget_exhaustion: 0,
		missing_evidence: 0,
		unknown: 0,
	};
}

function emptyAggregate(): BenchmarkResult {
	return {
		passed: 0,
		failed: 0,
		perCategory: {
			tool_error: { pass: 0, fail: 0 },
			schema_violation: { pass: 0, fail: 0 },
			budget_exhaustion: { pass: 0, fail: 0 },
			missing_evidence: { pass: 0, fail: 0 },
			unknown: { pass: 0, fail: 0 },
		},
		raw: [],
	};
}

export function summarizeArm(
	label: string,
	perSeedResults: readonly BenchmarkResult[],
): ArmResult {
	const perSeedFailureRate = perSeedResults.map((r) => {
		const total = r.passed + r.failed;
		return total === 0 ? 0 : r.failed / total;
	});
	const meanFailureRate =
		perSeedFailureRate.length === 0
			? 0
			: perSeedFailureRate.reduce((a, b) => a + b, 0) /
				perSeedFailureRate.length;
	const aggregate = perSeedResults[0] ?? emptyAggregate();
	const total = aggregate.passed + aggregate.failed;
	const interval = wilsonInterval(aggregate.failed, total);
	const perCategoryRate = emptyPerCategoryRate();
	for (const cat of Object.keys(perCategoryRate) as FailureCategory[]) {
		const bucket = aggregate.perCategory[cat];
		const t = bucket.pass + bucket.fail;
		perCategoryRate[cat] = t === 0 ? 0 : bucket.fail / t;
	}
	return {
		label,
		perSeedFailureRate,
		meanFailureRate,
		wilsonLower: interval.lower,
		wilsonUpper: interval.upper,
		perCategory: perCategoryRate,
		aggregate,
	};
}

export async function runArmWithSeeds(
	label: string,
	runSeed: (seed: number) => Promise<BenchmarkResult>,
	seeds: number,
): Promise<ArmResult> {
	const results: BenchmarkResult[] = [];
	for (let seed = 0; seed < seeds; seed += 1) {
		results.push(await runSeed(seed));
	}
	return summarizeArm(label, results);
}

function asciiBar(value: number, scale = 40): string {
	const clamped = Math.max(0, Math.min(1, value));
	const filled = Math.round(clamped * scale);
	return "█".repeat(filled) + "░".repeat(scale - filled);
}

export function fmtPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function decisionFor(lift: number): {
	readonly bucket: string;
	readonly recommendation: string;
} {
	if (lift >= 0.3) {
		return {
			bucket: "lift ≥ 30%",
			recommendation:
				"Make DSPy the default optimizer; PromptRewrite stays as fallback. 把 DSPy 设为默认 optimizer，PromptRewrite 作为 fallback 保留。",
		};
	}
	if (lift >= 0.1) {
		return {
			bucket: "10% ≤ lift < 30%",
			recommendation:
				"DSPy stays opt-in; default remains PromptRewrite. DSPy 仍保持 opt-in，默认仍是 PromptRewrite。",
		};
	}
	return {
		bucket: "lift < 10%",
		recommendation:
			"Trigger Stage E follow-up — evaluate Trace optimizer / OPRO / PromptBreeder alternatives. 触发 Stage E follow-up，评估 Trace optimizer / OPRO / PromptBreeder 等替代算法。",
	};
}

export function renderReport(input: ReportInput): string {
	const liftMipro = relativeLift(
		input.baseline.meanFailureRate,
		input.mipro.meanFailureRate,
	);
	const liftGepa = relativeLift(
		input.baseline.meanFailureRate,
		input.gepa.meanFailureRate,
	);
	const bestLift = Math.max(liftMipro, liftGepa);
	const decision = decisionFor(bestLift);
	const lines: string[] = [];

	lines.push("# Stage D — DSPy Validation Report (QUI-147)");
	lines.push("");
	lines.push(
		"> ⚠️ **MOCKED BENCHMARK DISCLOSURE** — This report is generated from a fully mocked benchmark run. No real LLM was invoked; DSPy MIPROv2 / GEPA arms use a deterministic mock MCP client that simulates ~80% (MIPRO) / ~70% (GEPA) ground-truth keyword coverage. Replay scoring uses keyword-overlap heuristics, not full agent re-execution. Numbers below are illustrative of the harness wiring, not production validation. Real-LLM benchmarking is deferred to a follow-up task.",
	);
	lines.push("");
	lines.push(
		"> ⚠️ **MOCK 数据声明** —— 本报告基于完全 mock 的 benchmark 运行。没有调用真实 LLM；DSPy MIPROv2 / GEPA 通路使用确定性 mock MCP client（MIPRO 模拟 ~80%，GEPA ~70% 地面真相关键字覆盖率）。Replay 评分用关键字重叠启发式，没有完整重跑 agent。下方数字仅展示 harness 接线是否正确，不能代表生产级验证。真实 LLM benchmarking 推后到 follow-up 任务。",
	);
	lines.push("");
	lines.push("## Reproducibility / 可复现性");
	lines.push("");
	lines.push(`- Commit hash: \`${input.commitHash}\``);
	lines.push(`- Trajectories path: \`${input.trajectoriesPath}\``);
	lines.push(`- Dataset SHA-256: \`${input.datasetHash}\``);
	lines.push(`- Trajectories count: ${input.trajectoryCount}`);
	lines.push(`- Seeds per arm: ${input.seeds}`);
	lines.push("");
	lines.push("## Aggregate failure-rate table / 失败率聚合表");
	lines.push("");
	lines.push(
		"| Arm | Mean failure rate | 95% CI (Wilson) | Per-seed failure rates |",
	);
	lines.push("|---|---|---|---|");
	for (const arm of [input.baseline, input.mipro, input.gepa]) {
		const ci = `[${fmtPercent(arm.wilsonLower)}, ${fmtPercent(
			arm.wilsonUpper,
		)}]`;
		const perSeed = arm.perSeedFailureRate.map((r) => fmtPercent(r)).join(", ");
		lines.push(
			`| ${arm.label} | ${fmtPercent(arm.meanFailureRate)} | ${ci} | ${perSeed} |`,
		);
	}
	lines.push("");

	lines.push(
		"## ASCII bar chart — failure rate (lower is better) / ASCII 条形图 —— 失败率（越低越好）",
	);
	lines.push("");
	lines.push("```");
	for (const arm of [input.baseline, input.mipro, input.gepa]) {
		lines.push(
			`${arm.label.padEnd(28)} | ${asciiBar(arm.meanFailureRate)} ${fmtPercent(
				arm.meanFailureRate,
			)}`,
		);
	}
	lines.push("```");
	lines.push("");

	lines.push("## Lift summary / Lift 总结");
	lines.push("");
	lines.push(
		`- Lift (MIPROv2 vs baseline): ${fmtPercent(liftMipro)} relative failure-rate reduction`,
	);
	lines.push(
		`- Lift (GEPA vs baseline): ${fmtPercent(liftGepa)} relative failure-rate reduction`,
	);
	lines.push(`- Best arm lift: ${fmtPercent(bestLift)}`);
	lines.push("");
	lines.push(
		`Lift（MIPROv2 vs baseline）：${fmtPercent(liftMipro)} 相对失败率降幅；Lift（GEPA vs baseline）：${fmtPercent(liftGepa)} 相对失败率降幅。最优 arm lift = ${fmtPercent(bestLift)}。`,
	);
	lines.push("");

	lines.push("## Per-FailureCategory breakdown / 按失败类型拆分");
	lines.push("");
	const categories: FailureCategory[] = [
		"tool_error",
		"schema_violation",
		"budget_exhaustion",
		"missing_evidence",
		"unknown",
	];
	lines.push("| Category | baseline | MIPROv2 | GEPA |");
	lines.push("|---|---|---|---|");
	for (const category of categories) {
		lines.push(
			`| ${category} | ${fmtPercent(input.baseline.perCategory[category])} | ${fmtPercent(input.mipro.perCategory[category])} | ${fmtPercent(input.gepa.perCategory[category])} |`,
		);
	}
	lines.push("");

	lines.push("## Decision recommendation / 决策建议");
	lines.push("");
	lines.push(`- Bucket: **${decision.bucket}**`);
	lines.push(`- Recommendation: ${decision.recommendation}`);
	lines.push("");
	lines.push(
		"Decision branches per docs/10-self-evolution/README.md §2.4.0.1: lift ≥ 30% → DSPy default; 10–30% → DSPy opt-in; < 10% → trigger Stage E.",
	);
	lines.push("");
	lines.push(
		"决策分支依据 docs/10-self-evolution/README.md §2.4.0.1：lift ≥ 30% → DSPy 转默认；10–30% → DSPy 仍 opt-in；< 10% → 触发 Stage E follow-up。",
	);
	lines.push("");
	lines.push("## Caveats / 限制说明");
	lines.push("");
	lines.push(
		"- Mock arms are deterministic and intentionally skewed in favor of MIPROv2 / GEPA to verify the harness math; real DSPy lift may be lower or higher.",
	);
	lines.push(
		"- Replay scoring is keyword-overlap based; it does not re-execute the agent loop end-to-end.",
	);
	lines.push(
		"- Dataset is synthetic (50 entries) — production validation needs real prod traces.",
	);
	lines.push("");
	lines.push(
		"- Mock arm 是确定性的并刻意偏向 MIPROv2 / GEPA，仅用于验证 harness 数学；真实 DSPy lift 会更低或更高。",
	);
	lines.push("- Replay 评分基于关键字重叠，不会端到端重跑 agent loop。");
	lines.push("- 数据集是合成的（50 条）—— 生产级验证需要真实 prod trace。");
	lines.push("");
	return `${lines.join("\n")}\n`;
}
