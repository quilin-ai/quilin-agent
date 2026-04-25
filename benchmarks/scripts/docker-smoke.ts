import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchmarkTool, runBenchmarkTask } from "../src/runner/index.js";
import { createDockerSandbox, hasDocker } from "../src/sandbox/index.js";
import type { BenchmarkTask } from "../src/wire/index.js";

const smokeImage = process.env.QUILIN_DOCKER_SMOKE_IMAGE ?? "alpine:3.20";

const task: BenchmarkTask = {
	task_id: "docker-smoke-1",
	dataset: "swe-bench-lite",
	inputs: {
		problem_statement: "Write a smoke artifact from inside DockerSandbox.",
		repo: "local/smoke",
		base_commit: "none",
	},
	expected: {
		golden_patch: "",
		test_patch: "",
	},
	scorer_type: "docker-smoke",
};

if (process.platform !== "linux") {
	console.log(
		JSON.stringify({
			event: "docker_smoke_skipped",
			reason:
				process.platform === "darwin"
					? "macos-no-docker"
					: "non-linux-no-docker",
			platform: process.platform,
			status: "skipped",
		}),
	);
	process.exit(0);
}

if (!(await hasDocker())) {
	throw new Error("Docker daemon is unavailable on Linux CI runner");
}

const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-smoke-"));
try {
	const baseDir = join(tmpRoot, "base");
	const cacheDir = join(tmpRoot, "cache");
	const artifactsDir = join(tmpRoot, "artifacts");
	await mkdir(baseDir, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	await mkdir(artifactsDir, { recursive: true });
	await writeFile(join(baseDir, "input.txt"), "smoke-ok", "utf8");

	const sandbox = createDockerSandbox({
		artifactsDir,
		baseDir,
		cacheDir,
		cpus: 1,
		image: smokeImage,
		memory: "256m",
		pidsLimit: 64,
		timeoutMs: 30_000,
	});
	const shellExec: BenchmarkTool = {
		name: "shell_exec",
		execute: async () => {
			throw new Error("shell_exec should be routed through DockerSandbox");
		},
	};

	const execution = await runBenchmarkTask({
		task,
		options: {
			agentLoopConfig: {
				llm: {},
				tools: [shellExec],
			},
			runAgent: async (config) => {
				await config.tools?.[0]?.execute({
					command: [
						"set -eu",
						"cat /workspace/base/input.txt > /workspace/artifacts/output.txt",
						"echo task-ok > /workspace/task/task-write.txt",
						"echo artifact-ok > /workspace/artifacts/artifact-write.txt",
						"if sh -c 'echo bad > /workspace/base/forbidden' >/workspace/task/base.out 2>/workspace/task/base.err; then echo base-write-allowed >&2; exit 10; fi",
						"if sh -c 'echo bad > /workspace/cache/forbidden' >/workspace/task/cache.out 2>/workspace/task/cache.err; then echo cache-write-allowed >&2; exit 11; fi",
						"command -v wget >/dev/null 2>&1",
						"if wget -qO- --timeout=2 https://example.com >/workspace/task/net.out 2>/workspace/task/net.err; then echo network-allowed >&2; exit 12; fi",
					].join("; "),
				});
				return "diff --git a/smoke b/smoke";
			},
			sandbox,
			scorer: async (_task, output) => ({
				passed: typeof output.patch === "string",
				score: 1,
				details: { smoke: true },
			}),
			tmpRoot,
		},
	});
	const artifact = await readFile(join(artifactsDir, "output.txt"), "utf8");
	if (artifact !== "smoke-ok") {
		throw new Error(`Unexpected DockerSandbox artifact: ${artifact}`);
	}
	if (execution.phases.join(",") !== "setup,agent_loop,collect,score,cleanup") {
		throw new Error(
			`Unexpected benchmark phases: ${execution.phases.join(",")}`,
		);
	}
	const timeoutResult = await sandbox.runShellCommand({
		command: "sleep 60",
		cwd: join(tmpRoot, "timeout-scratch"),
		timeoutMs: 100,
		workspaceDir: join(tmpRoot, "timeout-scratch"),
	});
	const timeoutPayload = JSON.parse(timeoutResult.content) as {
		readonly timedOut?: boolean;
	};
	if (timeoutPayload.timedOut !== true) {
		throw new Error("DockerSandbox timeout smoke did not time out");
	}

	console.log(
		JSON.stringify({
			artifact,
			egress: "denied",
			event: "docker_smoke_passed",
			image: smokeImage,
			phases: execution.phases,
			timeout: "enforced",
		}),
	);
} finally {
	await rm(tmpRoot, { force: true, recursive: true });
}
