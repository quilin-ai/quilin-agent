import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkTask } from "../wire/task.js";
import type { Scorer, ScorerResult } from "./types.js";

export const SWE_BENCH_PATCH_APPLY_SCORER_TYPE = "swe-bench-patch-apply";

export type GitApplyCheckRequest = {
	readonly cwd: string;
	readonly patch: string;
};

export type GitApplyCheckResult = {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

export type GitApplyCheckExecutor = (
	request: GitApplyCheckRequest,
) => Promise<GitApplyCheckResult>;

export type ShellExecTool = {
	readonly execute: (args: {
		readonly command: string;
		readonly cwd?: string;
		readonly timeoutMs?: number;
	}) => Promise<{
		readonly content: string;
		readonly isError?: boolean;
	}>;
};

export type SweBenchPatchApplyScorerOptions = {
	readonly executor: GitApplyCheckExecutor;
};

export function createSweBenchPatchApplyScorer(
	options: SweBenchPatchApplyScorerOptions,
): Scorer {
	const executor = options?.executor;
	if (typeof executor !== "function") {
		throw new TypeError(
			"createSweBenchPatchApplyScorer requires an injected GitApplyCheckExecutor",
		);
	}

	return async (task, output) => {
		const patch = candidatePatch(output);

		if (!patch) {
			return failedResult("missing_candidate_patch", {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
			});
		}

		const repoWorkdir = taskRepoWorkdir(task);

		if (!repoWorkdir) {
			return failedResult("missing_repo_workdir", {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
			});
		}

		try {
			const result = await executor({ cwd: repoWorkdir, patch });

			if (result.exitCode === 0) {
				return {
					passed: true,
					score: 1,
					details: {
						scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
						repo_workdir: repoWorkdir,
						exit_code: result.exitCode,
					},
				};
			}

			return failedResult("git_apply_check_failed", {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				repo_workdir: repoWorkdir,
				exit_code: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			});
		} catch (error) {
			return failedResult("executor_error", {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				repo_workdir: repoWorkdir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}

export function createShellExecGitApplyCheckExecutor(
	tool: ShellExecTool,
): GitApplyCheckExecutor {
	return async ({ cwd, patch }) => {
		const tempDir = await mkdtemp(join(tmpdir(), "quilin-patch-check-"));
		const patchPath = join(tempDir, "candidate.patch");
		try {
			await writeFile(patchPath, patch, "utf8");
			const result = await tool.execute({
				command: `git apply --check ${quoteCommandArg(patchPath)}`,
				cwd,
				timeoutMs: 30_000,
			});
			const payload = parseShellExecPayload(result.content);
			return {
				exitCode: shellExitCode(result.isError === true, payload),
				stdout: stringPayload(payload.stdout),
				stderr: stringPayload(payload.stderr ?? payload.error),
			};
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	};
}

function candidatePatch(output: Record<string, unknown>): string | undefined {
	for (const key of ["patch", "diff"] as const) {
		const value = output[key];

		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}

	return undefined;
}

function taskRepoWorkdir(task: BenchmarkTask): string | undefined {
	for (const key of [
		"repo_workdir",
		"repo_dir",
		"repo_path",
		"workdir",
		"working_directory",
	] as const) {
		const value = task.inputs[key];

		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}

	return undefined;
}

function quoteCommandArg(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseShellExecPayload(content: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(content);
		return parsed != null && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return { error: content };
	}
}

function shellExitCode(
	isError: boolean,
	payload: Record<string, unknown>,
): number {
	const exitCode = payload.exitCode;
	if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
		return exitCode;
	}
	return isError ? 1 : 0;
}

function stringPayload(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function failedResult(
	reason: string,
	details: Record<string, unknown>,
): ScorerResult {
	return {
		passed: false,
		score: 0,
		details: { ...details, reason },
	};
}
