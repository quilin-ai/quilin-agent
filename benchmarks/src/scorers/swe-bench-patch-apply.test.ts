import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BenchmarkTask } from "../wire/task.js";
import {
	createShellExecGitApplyCheckExecutor,
	createSweBenchPatchApplyScorer,
	type GitApplyCheckExecutor,
	type ShellExecTool,
	SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
} from "./swe-bench-patch-apply.js";

const fixturePatch = [
	"--- a/hello.txt",
	"+++ b/hello.txt",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"",
].join("\n");

const task = {
	task_id: "swe-1",
	dataset: "swe-bench-verified",
	inputs: { repo_workdir: "/workspace/repo" },
	expected: {},
	scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
} satisfies BenchmarkTask;

describe("swe-bench-patch-apply scorer", () => {
	it("passes when the fixture patch applies cleanly", async () => {
		const executor = vi.fn<GitApplyCheckExecutor>(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const scorer = createSweBenchPatchApplyScorer({ executor });

		await expect(scorer(task, { patch: fixturePatch })).resolves.toEqual({
			passed: true,
			score: 1,
			details: {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				repo_workdir: "/workspace/repo",
				exit_code: 0,
			},
		});
		expect(executor).toHaveBeenCalledWith({
			cwd: "/workspace/repo",
			patch: fixturePatch,
		});
	});

	it("uses output.diff when output.patch is absent", async () => {
		const executor = vi.fn<GitApplyCheckExecutor>(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
		}));
		const scorer = createSweBenchPatchApplyScorer({ executor });

		await expect(scorer(task, { diff: fixturePatch })).resolves.toMatchObject({
			passed: true,
			score: 1,
		});
		expect(executor).toHaveBeenCalledWith({
			cwd: "/workspace/repo",
			patch: fixturePatch,
		});
	});

	it("fails when git apply --check rejects the patch", async () => {
		const executor = vi.fn<GitApplyCheckExecutor>(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "patch does not apply",
		}));
		const scorer = createSweBenchPatchApplyScorer({ executor });

		await expect(scorer(task, { patch: "not a patch" })).resolves.toEqual({
			passed: false,
			score: 0,
			details: {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				repo_workdir: "/workspace/repo",
				exit_code: 1,
				stdout: "",
				stderr: "patch does not apply",
				reason: "git_apply_check_failed",
			},
		});
	});

	it("fails without invoking the executor when no patch is present", async () => {
		const executor = vi.fn<GitApplyCheckExecutor>();
		const scorer = createSweBenchPatchApplyScorer({ executor });

		await expect(scorer(task, { patch: " " })).resolves.toEqual({
			passed: false,
			score: 0,
			details: {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				reason: "missing_candidate_patch",
			},
		});
		expect(executor).not.toHaveBeenCalled();
	});

	it("fails when the task does not expose a repo working directory", async () => {
		const executor = vi.fn<GitApplyCheckExecutor>();
		const scorer = createSweBenchPatchApplyScorer({ executor });

		await expect(
			scorer(
				{ ...task, inputs: { repo: "owner/project" } },
				{ patch: fixturePatch },
			),
		).resolves.toEqual({
			passed: false,
			score: 0,
			details: {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				reason: "missing_repo_workdir",
			},
		});
		expect(executor).not.toHaveBeenCalled();
	});

	it("fails when the injected executor throws", async () => {
		const executor = vi.fn<GitApplyCheckExecutor>(async () => {
			throw new Error("boom");
		});
		const scorer = createSweBenchPatchApplyScorer({ executor });

		await expect(scorer(task, { patch: fixturePatch })).resolves.toEqual({
			passed: false,
			score: 0,
			details: {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				repo_workdir: "/workspace/repo",
				error: "boom",
				reason: "executor_error",
			},
		});
	});

	it("fails explicitly when no git apply executor is injected", async () => {
		const scorer = createSweBenchPatchApplyScorer();

		await expect(scorer(task, { patch: fixturePatch })).resolves.toEqual({
			passed: false,
			score: 0,
			details: {
				scorer_type: SWE_BENCH_PATCH_APPLY_SCORER_TYPE,
				repo_workdir: "/workspace/repo",
				error:
					"SWE-bench patch scorer requires an injected GitApplyCheckExecutor",
				reason: "executor_error",
			},
		});
	});
});

describe("createShellExecGitApplyCheckExecutor", () => {
	it("runs git apply --check through the Iter B shell_exec tool", async () => {
		const dir = await mkdtemp(join(tmpdir(), "quilin-scorer-"));
		const commands: string[] = [];
		const tool: ShellExecTool = {
			execute: vi.fn(async ({ command, cwd, timeoutMs }) => {
				commands.push(command);
				expect(cwd).toBe(dir);
				expect(timeoutMs).toBe(30_000);
				expect(command).toMatch(/^git apply --check "/);
				expect(command).not.toContain(" - ");
				return {
					content: JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }),
					isError: false,
				};
			}),
		};

		try {
			await writeFile(join(dir, "hello.txt"), "old\n");

			await expect(
				createShellExecGitApplyCheckExecutor(tool)({
					cwd: dir,
					patch: fixturePatch,
				}),
			).resolves.toMatchObject({ exitCode: 0 });
			expect(commands).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("maps shell_exec errors into git apply check results", async () => {
		const tool: ShellExecTool = {
			execute: async () => ({
				content: JSON.stringify({
					exitCode: 1,
					error: "patch does not apply",
				}),
				isError: true,
			}),
		};

		await expect(
			createShellExecGitApplyCheckExecutor(tool)({
				cwd: "/workspace/repo",
				patch: fixturePatch,
			}),
		).resolves.toEqual({
			exitCode: 1,
			stdout: "",
			stderr: "patch does not apply",
		});
	});

	it("treats malformed shell_exec payloads as stderr text", async () => {
		const tool: ShellExecTool = {
			execute: async () => ({
				content: "not json",
				isError: true,
			}),
		};

		await expect(
			createShellExecGitApplyCheckExecutor(tool)({
				cwd: "/workspace/repo",
				patch: fixturePatch,
			}),
		).resolves.toMatchObject({
			exitCode: 1,
			stderr: "not json",
		});
	});

	it("defaults successful shell_exec payloads without exitCode to zero", async () => {
		const tool: ShellExecTool = {
			execute: async () => ({
				content: "null",
				isError: false,
			}),
		};

		await expect(
			createShellExecGitApplyCheckExecutor(tool)({
				cwd: "/workspace/repo",
				patch: fixturePatch,
			}),
		).resolves.toEqual({
			exitCode: 0,
			stdout: "",
			stderr: "",
		});
	});
});
