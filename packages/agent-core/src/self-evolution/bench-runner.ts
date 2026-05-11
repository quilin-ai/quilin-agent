import { createHash } from "node:crypto";
import {
	DspyOfflineOptimizer,
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
	readonly gepa: ArmResult;
	readonly trajectoryCount: number;
	readonly seeds: number;
	/**
	 * Optional commit hash. Round-2 fix: this is no longer rendered in the
	 * Reproducibility section because the commit-hash-at-render-time will
	 * lag the commit-that-actually-lands-the-fix; the dataset SHA-256 +
	 * trajectories file path are sufficient reproducibility keys. Kept on
	 * the interface for callers that want to log it elsewhere.
	 *
	 * round-2 修复：commit hash 不再渲染到 Reproducibility 段，因为渲染时
	 * 抓到的 hash 永远落后于真正落库的 commit。dataset SHA-256 + 轨迹
	 * 文件路径已是充分的复现 key。接口上保留字段，便于调用方在别处记录。
	 */
	readonly commitHash?: string;
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
 * Mock DSPy MCP client. Returns proposals simulating `GEPA` (~70%
 * full coverage of the ground-truth fix direction). Deterministic per
 * seed. Used by the bench script and the integration tests.
 *
 * Mock DSPy MCP client：模拟 `GEPA`（~70% 完全覆盖 ground-truth 修复方向）。
 * 给定 seed 完全确定。bench script 与集成测试都使用它。
 */
export function createMockDspyClient(
	entries: readonly BenchmarkTrajectoryEntry[],
	seed: number,
): DspyOptimizerMCPClient {
	const fullCoverageRate = 0.7;
	return {
		async callTool(
			name: string,
			args: Record<string, unknown>,
		): Promise<string> {
			const trajectoriesArg = Array.isArray(args.trajectories)
				? (args.trajectories as readonly { trajectoryRef?: string }[])
				: [];
			const proposals: OptimizationProposalDraft[] = [];
			// NOTE (round-2 fix): no per-category dedupe — we want every entry
			// to participate so the seed multiplier exercises the full sample.
			// The (seed * 991 + i * 71) mod 1000 hash uses two primes coprime
			// to 1000 to give meaningful variance across seeds; the previous
			// (seed * 17 + i * 31) mod 100 hash combined with category dedupe
			// only fed ~5 trajectories per call AND repeated thresholds across
			// seeds, so 3 seeds produced identical numbers.
			//
			// 注意（round-2 修复）：去掉了按类别去重 —— 我们希望每条 entry 都参与，
			// 让 seed 乘子能够覆盖到完整样本。`(seed * 991 + i * 71) mod 1000`
			// 使用两个与 1000 互质的质数，跨 seed 给出可观察的方差；之前的
			// `(seed * 17 + i * 31) mod 100` 加上类别去重，每次只喂 ~5 条
			// trajectory，且阈值上映射重复值，最终 3 个 seed 输出完全相同。
			// Build a list of "wrong-category" template strings so the
			// `!fullCoverage` branch picks guidance that does NOT cover the
			// entry's ground-truth keywords. Without this, the same-category
			// fallback template was nearly word-for-word the ground truth
			// (e.g., tool_error fallback === tool_error ground truth), so
			// per-seed pass/fail rates collapsed even when the seed multiplier
			// produced different proposal mixes.
			//
			// 构造"跨类别"的 fallback 模板池，让 `!fullCoverage` 分支挑到的
			// guidance 不覆盖 entry 的 ground-truth 关键字。修复前同类别
			// fallback 与 ground truth 几乎一字不差（tool_error fallback ===
			// tool_error ground truth），即便 seed 乘子产出不同 proposal 混合，
			// 单 seed 的 pass/fail 仍然完全一致。
			const wrongCategoryFor = (cat: FailureCategory): readonly string[] => {
				const others: readonly string[] = (
					Object.keys(FIX_DIRECTION_TEMPLATES) as FailureCategory[]
				)
					.filter((c) => c !== cat && c !== "unknown")
					.flatMap((c) => FIX_DIRECTION_TEMPLATES[c] ?? []);
				return others;
			};
			for (let i = 0; i < trajectoriesArg.length; i += 1) {
				const ref = trajectoriesArg[i]?.trajectoryRef ?? "";
				const id = ref.replace(/^trajectory:/, "");
				const entry = entries.find((e) => e.id === id);
				if (entry == null) {
					continue;
				}
				const seedHash = (i * 71 + seed * 991) % 1000;
				const fullCoverage = seedHash < fullCoverageRate * 1000;
				let guidance: string;
				if (fullCoverage) {
					guidance = entry.ground_truth_fix_direction;
				} else {
					const others = wrongCategoryFor(entry.category);
					guidance =
						others.length === 0
							? ((FIX_DIRECTION_TEMPLATES[entry.category] ?? [])[0] ?? "")
							: (others[seedHash % others.length] ?? "");
				}
				const summary = `${name}/gepa guidance for ${entry.category}: ${guidance}`;
				proposals.push({
					title: `GEPA candidate for ${entry.category}`,
					summary,
					artifacts: [
						{
							artifactId: `artifact:${entry.category}-${i}`,
							kind: "markdown",
							title: `gepa guidance — ${entry.category}`,
							content: `# guidance\n\n${guidance}\n\nfailure: ${entry.failure_signal}`,
							contentHash: createHash("sha256")
								.update(`${entry.category}-${i}-${seed}-gepa`)
								.digest("hex"),
							sourceRefs: [ref],
						},
					],
					evidenceHashes: [],
					riskPreview: {
						level: "low",
						reasons: ["mock gepa run"],
						touchesRuntime: false,
						requiresHumanReview: true,
					},
				});
			}
			return JSON.stringify({
				schema_version: 1,
				optimizer_id: "dspy-gepa-mock",
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
		now: () =>
			new Date(
				// Round-2 fix: use padStart so the hours field is two digits, and
				// wrap with modulo 24 so seeds >= 24 don't produce invalid dates
				// like `2026-05-10T24:00:00.000Z`. This `now` is a deterministic
				// per-seed timestamp injection — exact wall-clock value doesn't
				// matter, only that distinct seeds produce distinct timestamps
				// (mod 24 collisions for seeds >= 24 are acceptable for a bench).
				//
				// round-2 修复：用 padStart 让 hour 域是两位，并用模 24 包装，
				// 避免 seed >= 24 时拼出非法时间戳。这里的 `now` 是确定性的
				// per-seed 时间戳注入，具体 wall-clock 值不重要，只要不同
				// seed 给出不同时间戳即可（seed >= 24 时模 24 冲突在 bench
				// 场景可接受）。
				`2026-05-10T${String(seed % 24).padStart(2, "0")}:00:00.000Z`,
			),
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
	seed: number,
): Promise<BenchmarkResult> {
	const client = createMockDspyClient(entries, seed);
	const optimizer = new DspyOfflineOptimizer({
		client,
		now: () =>
			new Date(
				// Round-2 fix: use padStart so the hours field is two digits, and
				// wrap with modulo 24 so seeds >= 24 don't produce invalid dates
				// like `2026-05-10T24:00:00.000Z`. This `now` is a deterministic
				// per-seed timestamp injection — exact wall-clock value doesn't
				// matter, only that distinct seeds produce distinct timestamps
				// (mod 24 collisions for seeds >= 24 are acceptable for a bench).
				//
				// round-2 修复：用 padStart 让 hour 域是两位，并用模 24 包装，
				// 避免 seed >= 24 时拼出非法时间戳。这里的 `now` 是确定性的
				// per-seed 时间戳注入，具体 wall-clock 值不重要，只要不同
				// seed 给出不同时间戳即可（seed >= 24 时模 24 冲突在 bench
				// 场景可接受）。
				`2026-05-10T${String(seed % 24).padStart(2, "0")}:00:00.000Z`,
			),
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

/**
 * Pool BenchmarkResult counts across every seed so the Wilson CI runs on
 * the full sample size (`n_per_seed * seeds`). Pre-fix the harness only
 * looked at `perSeedResults[0]` which dropped 2 of 3 seeds and silently
 * collapsed the CI to single-seed precision.
 *
 * 把每个 seed 的 BenchmarkResult 计数池化，让 Wilson CI 跑在完整样本量
 * （`每 seed 样本数 * seeds`）上。修复前只读 `perSeedResults[0]`，丢掉
 * 了 3 个 seed 中的 2 个，CI 隐式塌缩到单 seed 精度。
 */
function poolAggregate(
	perSeedResults: readonly BenchmarkResult[],
): BenchmarkResult {
	const pooled = emptyAggregate();
	let pooledPassed = 0;
	let pooledFailed = 0;
	const pooledRaw: BenchmarkResult["raw"][number][] = [];
	const perCategory = pooled.perCategory as Record<
		FailureCategory,
		{ pass: number; fail: number }
	>;
	for (const r of perSeedResults) {
		pooledPassed += r.passed;
		pooledFailed += r.failed;
		for (const cat of Object.keys(perCategory) as FailureCategory[]) {
			const bucket = r.perCategory[cat];
			perCategory[cat] = {
				pass: perCategory[cat].pass + bucket.pass,
				fail: perCategory[cat].fail + bucket.fail,
			};
		}
		for (const item of r.raw) {
			pooledRaw.push(item);
		}
	}
	return {
		passed: pooledPassed,
		failed: pooledFailed,
		perCategory,
		raw: pooledRaw,
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
	const aggregate =
		perSeedResults.length === 0
			? emptyAggregate()
			: poolAggregate(perSeedResults);
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
	// Decision-ladder strings are kept as informational signals only.
	// Post 2026-05-12 GEPA-only refactor the *picking* decision is closed
	// (GEPA is the singular optimizer per
	// docs/10-self-evolution/README.md §2.4); this bench now measures the
	// *size* of GEPA's contribution rather than choosing among
	// alternatives.
	if (lift >= 0.3) {
		return {
			bucket: "lift ≥ 30%",
			recommendation:
				"GEPA lift exceeds 30% — strong contribution on this dataset. GEPA 贡献显著（lift ≥ 30%）。",
		};
	}
	if (lift >= 0.1) {
		return {
			bucket: "10% ≤ lift < 30%",
			recommendation:
				"GEPA lift in the moderate 10–30% band. GEPA 贡献中等（10% ≤ lift < 30%）。",
		};
	}
	return {
		bucket: "lift < 10%",
		recommendation:
			"GEPA lift below 10% — investigate whether the scoring metric or dataset is masking signal (see §2.4 historical bench-judge-sensitivity context). GEPA lift 低于 10% —— 检查评分指标或数据集是否压制了信号（参见 §2.4 历史 bench 评委敏感性背景）。",
	};
}

export function renderReport(input: ReportInput): string {
	const liftGepa = relativeLift(
		input.baseline.meanFailureRate,
		input.gepa.meanFailureRate,
	);
	const decision = decisionFor(liftGepa);
	const lines: string[] = [];

	lines.push("# Stage D — DSPy GEPA Validation Report (QUI-147)");
	lines.push("");
	lines.push(
		"> ⚠️ **MOCKED BENCHMARK DISCLOSURE** — This report is generated from a fully mocked benchmark run. No real LLM was invoked; the DSPy GEPA arm uses a deterministic mock MCP client that simulates ~70% ground-truth keyword coverage. Replay scoring uses keyword-overlap heuristics, not full agent re-execution. Numbers below are illustrative of the harness wiring, not production validation. Real-LLM benchmarking lives in `scripts/bench-real-dspy.py`.",
	);
	lines.push("");
	lines.push(
		"> ⚠️ **MOCK 数据声明** —— 本报告基于完全 mock 的 benchmark 运行。没有调用真实 LLM；DSPy GEPA 通路使用确定性 mock MCP client（模拟 ~70% 地面真相关键字覆盖率）。Replay 评分用关键字重叠启发式，没有完整重跑 agent。下方数字仅展示 harness 接线是否正确，不能代表生产级验证。真实 LLM benchmark 在 `scripts/bench-real-dspy.py`。",
	);
	lines.push("");
	lines.push("## Reproducibility / 可复现性");
	lines.push("");
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
	for (const arm of [input.baseline, input.gepa]) {
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
	for (const arm of [input.baseline, input.gepa]) {
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
		`- Lift (GEPA vs baseline): ${fmtPercent(liftGepa)} relative failure-rate reduction`,
	);
	lines.push("");
	lines.push(
		`Lift（GEPA vs baseline）：${fmtPercent(liftGepa)} 相对失败率降幅。`,
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
	lines.push("| Category | baseline | GEPA |");
	lines.push("|---|---|---|");
	for (const category of categories) {
		lines.push(
			`| ${category} | ${fmtPercent(input.baseline.perCategory[category])} | ${fmtPercent(input.gepa.perCategory[category])} |`,
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
		"- The mock GEPA arm is deterministic and intentionally skewed in favor of GEPA to verify the harness math; real DSPy lift may be lower or higher.",
	);
	lines.push(
		"- Replay scoring is keyword-overlap based; it does not re-execute the agent loop end-to-end.",
	);
	lines.push(
		"- Dataset is synthetic (50 entries) — production validation needs real prod traces.",
	);
	lines.push("");
	lines.push(
		"- Mock GEPA arm 是确定性的并刻意偏向 GEPA，仅用于验证 harness 数学；真实 DSPy lift 会更低或更高。",
	);
	lines.push("- Replay 评分基于关键字重叠，不会端到端重跑 agent loop。");
	lines.push("- 数据集是合成的（50 条）—— 生产级验证需要真实 prod trace。");
	lines.push("");
	return `${lines.join("\n")}\n`;
}
