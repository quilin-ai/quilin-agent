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

import { execSync } from "node:child_process";
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

function parseArgs(argv: readonly string[]): CliOptions {
	let trajectoriesPath = DEFAULT_TRAJ;
	let reportPath = DEFAULT_REPORT;
	let seeds = 3;
	let dryRun = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--trajectories" && argv[i + 1] != null) {
			trajectoriesPath = argv[i + 1] ?? DEFAULT_TRAJ;
			i += 1;
		} else if (arg === "--report" && argv[i + 1] != null) {
			reportPath = argv[i + 1] ?? DEFAULT_REPORT;
			i += 1;
		} else if (arg === "--seeds" && argv[i + 1] != null) {
			const parsed = Number.parseInt(argv[i + 1] ?? "3", 10);
			seeds = Number.isNaN(parsed) ? 3 : parsed;
			i += 1;
		} else if (arg === "--dry-run") {
			dryRun = true;
		}
	}
	return { trajectoriesPath, reportPath, seeds, dryRun };
}

function getCommitHash(): string {
	try {
		return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
}

async function getDatasetHash(path: string): Promise<string> {
	const contents = await readFile(path, "utf-8");
	return createHash("sha256").update(contents).digest("hex");
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
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

	const commitHash = getCommitHash();
	const datasetHash = await getDatasetHash(trajectoriesAbsPath);
	const report = renderReport({
		baseline,
		mipro,
		gepa,
		trajectoryCount: harness.entries.length,
		seeds: options.seeds,
		commitHash,
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
