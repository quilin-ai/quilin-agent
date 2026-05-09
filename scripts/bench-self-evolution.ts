#!/usr/bin/env bun
/**
 * Stage D — DSPy benchmark validation script (QUI-147).
 *
 * Thin CLI wrapper. The actual bench logic lives in
 * `packages/agent-core/src/self-evolution/bench-runner.ts` so the package
 * tsconfig (rootDir = `src/`) can type-check it alongside its unit and
 * integration tests.
 *
 * Usage:
 *   bun run scripts/bench-self-evolution.ts \
 *       [--trajectories docs/10-self-evolution/benchmark/trajectories.jsonl] \
 *       [--report docs/10-self-evolution/dspy-validation-report.md] \
 *       [--seeds 3] [--dry-run]
 *
 * Stage D（QUI-147）DSPy benchmark 验证脚本 —— 薄 CLI 包装。真正的 bench
 * 逻辑放在 `packages/agent-core/src/self-evolution/bench-runner.ts`，让
 * package tsconfig（rootDir = `src/`）可以一起 type-check 单元 + 集成测试。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	fmtPercent,
	renderReport,
	runArmWithSeeds,
	runBaselineArm,
	runDspyArm,
} from "../packages/agent-core/src/self-evolution/bench-runner.js";
import { loadReplayHarness } from "../packages/agent-core/src/self-evolution/replay-harness.js";

interface CliOptions {
	readonly trajectoriesPath: string;
	readonly reportPath: string;
	readonly seeds: number;
	readonly dryRun: boolean;
}

const DEFAULT_TRAJ = "docs/10-self-evolution/benchmark/trajectories.jsonl";
const DEFAULT_REPORT = "docs/10-self-evolution/dspy-validation-report.md";

const USAGE = `Usage: bun run scripts/bench-self-evolution.ts [options]

Stage D — DSPy benchmark validation script (QUI-147). Runs the 3-arm
benchmark (PromptRewrite baseline + DSPy MIPROv2 mock + DSPy GEPA mock)
on the labeled trajectories corpus and writes a markdown report.

Stage D（QUI-147）DSPy 验证脚本，跑 3-arm benchmark（PromptRewrite
baseline + DSPy MIPROv2 mock + DSPy GEPA mock），输出 markdown 报告。

Options:
  --trajectories <path>   JSONL trajectories file (default: ${DEFAULT_TRAJ})
                          带标注的轨迹 JSONL 文件。
  --report <path>         Markdown report output path (default: ${DEFAULT_REPORT})
                          markdown 报告输出路径。
  --seeds <int>           Positive integer — number of seeds per arm (default: 3)
                          每个 arm 跑的 seed 数，必须是正整数。
  --dry-run               Load trajectories then exit without running the bench
                          只加载轨迹然后退出，不跑 bench。
  -h, --help              Print this usage message and exit
                          打印此帮助信息并退出。

Manual reproduction / 手动复现：
  bun run scripts/bench-self-evolution.ts --help
  bun run scripts/bench-self-evolution.ts --dry-run
  bun run scripts/bench-self-evolution.ts --seeds 3
`;

class CliArgError extends Error {}

function parseArgs(argv: readonly string[]): CliOptions {
	let trajectoriesPath = DEFAULT_TRAJ;
	let reportPath = DEFAULT_REPORT;
	let seeds = 3;
	let dryRun = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--trajectories") {
			const next = argv[i + 1];
			if (next == null) {
				throw new CliArgError("--trajectories requires a path argument");
			}
			trajectoriesPath = next;
			i += 1;
		} else if (arg === "--report") {
			const next = argv[i + 1];
			if (next == null) {
				throw new CliArgError("--report requires a path argument");
			}
			reportPath = next;
			i += 1;
		} else if (arg === "--seeds") {
			const next = argv[i + 1];
			if (next == null) {
				throw new CliArgError("--seeds requires an integer argument");
			}
			const parsed = Number.parseInt(next, 10);
			if (
				!Number.isFinite(parsed) ||
				!Number.isInteger(parsed) ||
				parsed <= 0 ||
				String(parsed) !== next.trim()
			) {
				throw new CliArgError(
					`--seeds must be a positive integer, got "${next}"`,
				);
			}
			seeds = parsed;
			i += 1;
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else {
			throw new CliArgError(
				`unknown flag: ${String(arg)} — run with --help to see valid options`,
			);
		}
	}
	return { trajectoriesPath, reportPath, seeds, dryRun };
}

function isHelpFlag(argv: readonly string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

async function getDatasetHash(path: string): Promise<string> {
	const contents = await readFile(path, "utf-8");
	return createHash("sha256").update(contents).digest("hex");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (isHelpFlag(argv)) {
		process.stdout.write(USAGE);
		return;
	}
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (err) {
		if (err instanceof CliArgError) {
			process.stderr.write(`bench-self-evolution: ${err.message}\n`);
			process.stderr.write(USAGE);
			process.exit(2);
		}
		throw err;
	}
	const trajectoriesAbsPath = resolve(options.trajectoriesPath);
	const reportAbsPath = resolve(options.reportPath);
	console.log(`bench-self-evolution: loading ${trajectoriesAbsPath}`);
	const harness = await loadReplayHarness({ path: trajectoriesAbsPath });
	console.log(
		`bench-self-evolution: loaded ${harness.entries.length} trajectories`,
	);
	if (options.dryRun) {
		console.log("bench-self-evolution: --dry-run set, exiting");
		return;
	}

	const baseline = await runArmWithSeeds(
		"PromptRewrite (baseline)",
		(seed) => runBaselineArm(harness.entries, seed),
		options.seeds,
	);
	const mipro = await runArmWithSeeds(
		"DSPy + MIPROv2 (mocked)",
		(seed) => runDspyArm(harness.entries, "mipro", seed),
		options.seeds,
	);
	const gepa = await runArmWithSeeds(
		"DSPy + GEPA (mocked)",
		(seed) => runDspyArm(harness.entries, "gepa", seed),
		options.seeds,
	);

	const datasetHash = await getDatasetHash(trajectoriesAbsPath);
	const report = renderReport({
		baseline,
		mipro,
		gepa,
		trajectoryCount: harness.entries.length,
		seeds: options.seeds,
		datasetHash,
		trajectoriesPath: options.trajectoriesPath,
	});

	await mkdir(dirname(reportAbsPath), { recursive: true });
	await writeFile(reportAbsPath, report, "utf-8");
	console.log(`bench-self-evolution: report written to ${reportAbsPath}`);
	console.log(
		`bench-self-evolution: baseline=${fmtPercent(baseline.meanFailureRate)} mipro=${fmtPercent(
			mipro.meanFailureRate,
		)} gepa=${fmtPercent(gepa.meanFailureRate)}`,
	);
}

await main().catch((err) => {
	console.error("bench-self-evolution failed:", err);
	process.exit(1);
});
