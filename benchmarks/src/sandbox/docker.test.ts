import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
	createDockerSandbox,
	type DockerCliRunner,
	hasDocker,
	runDockerCli,
} from "./docker.js";

const dockerAvailable = await hasDocker();

describe("createDockerSandbox", () => {
	it("builds a Linux-only docker run command with isolated mounts", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-test-"));
		const calls: string[][] = [];
		const runner: DockerCliRunner = async (args) => {
			calls.push([...args]);
			return { exitCode: 0, stderr: "", stdout: "ok" };
		};

		try {
			const sandbox = createDockerSandbox({
				artifactsDir: join(tmpRoot, "artifacts"),
				baseDir: join(tmpRoot, "base"),
				cacheDir: join(tmpRoot, "cache"),
				cpus: 2,
				image: "alpine:3.20",
				memory: "512m",
				pidsLimit: 64,
				runner,
			});

			const result = await sandbox.runShellCommand({
				command: "echo ok",
				cwd: join(tmpRoot, "scratch", "subdir"),
				workspaceDir: join(tmpRoot, "scratch"),
			});

			const payload = JSON.parse(result.content) as {
				exitCode: number;
				stdout: string;
			};
			expect(result.isError).toBe(false);
			expect(payload).toMatchObject({ exitCode: 0, stdout: "ok" });
			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual(
				expect.arrayContaining([
					"run",
					"--rm",
					"--network",
					"none",
					"--cpus",
					"2",
					"--memory",
					"512m",
					"--memory-swap",
					"512m",
					"--pids-limit",
					"64",
					"--stop-timeout",
					"60",
					"--read-only",
					"-w",
					"/workspace/task/subdir",
					"alpine:3.20",
					"/bin/sh",
					"-lc",
					expect.stringContaining("timeout -s KILL 60s"),
				]),
			);
			expect(calls[0]?.at(-1)).toContain("echo ok");
			expect(calls[0]?.filter((arg) => arg === "--mount")).toHaveLength(4);
			expect(
				calls[0]?.some((arg) => /dst=\/workspace\/base,readonly$/.test(arg)),
			).toBe(true);
			expect(calls[0]?.some((arg) => /dst=\/workspace\/task$/.test(arg))).toBe(
				true,
			);
			expect(
				calls[0]?.some((arg) => /dst=\/workspace\/artifacts$/.test(arg)),
			).toBe(true);
			expect(
				calls[0]?.some((arg) => /dst=\/workspace\/cache,readonly$/.test(arg)),
			).toBe(true);
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("uses safe defaults and falls back to the task cwd for outside cwd", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-defaults-"));
		const calls: string[][] = [];
		const runner: DockerCliRunner = async (args) => {
			calls.push([...args]);
			return { exitCode: 2, stderr: "failed", stdout: "" };
		};

		try {
			const sandbox = createDockerSandbox({
				artifactsDir: join(tmpRoot, "artifacts"),
				baseDir: join(tmpRoot, "base"),
				cacheDir: join(tmpRoot, "cache"),
				image: "alpine:3.20",
				runner,
			});

			const result = await sandbox.runShellCommand({
				command: "false",
				cwd: tmpRoot,
				workspaceDir: join(tmpRoot, "scratch"),
			});
			const payload = JSON.parse(result.content) as {
				exitCode: number;
				stderr: string;
			};

			expect(result.isError).toBe(true);
			expect(payload).toMatchObject({ exitCode: 2, stderr: "failed" });
			expect(calls[0]).toEqual(
				expect.arrayContaining([
					"--cpus",
					"1",
					"--memory",
					"2g",
					"--memory-swap",
					"2g",
					"--pids-limit",
					"512",
					"--stop-timeout",
					"60",
					"-w",
					"/workspace/task",
				]),
			);
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("uses the default CLI runner when no runner is injected", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-cli-runner-"));
		try {
			const sandbox = createDockerSandbox({
				artifactsDir: join(tmpRoot, "artifacts"),
				baseDir: join(tmpRoot, "base"),
				cacheDir: join(tmpRoot, "cache"),
				dockerBinary: process.execPath,
				image: "alpine:3.20",
			});

			const result = await sandbox.runShellCommand({
				command: "echo ok",
				cwd: join(tmpRoot, "scratch"),
				workspaceDir: join(tmpRoot, "scratch"),
			});
			const payload = JSON.parse(result.content) as {
				exitCode: number | null;
				stderr: string;
			};

			expect(result.isError).toBe(true);
			expect(payload.exitCode).not.toBe(0);
			expect(payload.stderr.length).toBeGreaterThan(0);
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("requires non-empty mount and image options", () => {
		expect(() =>
			createDockerSandbox({
				artifactsDir: "/tmp/artifacts",
				baseDir: "/tmp/base",
				cacheDir: "/tmp/cache",
				image: " ",
			}),
		).toThrow("DockerSandbox requires image");
	});

	it("rethrows docker runner failures that are not timeouts", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-error-"));
		const sandbox = createDockerSandbox({
			artifactsDir: join(tmpRoot, "artifacts"),
			baseDir: join(tmpRoot, "base"),
			cacheDir: join(tmpRoot, "cache"),
			image: "alpine:3.20",
			runner: async () => {
				throw new Error("docker failed");
			},
		});

		try {
			await expect(
				sandbox.runShellCommand({
					command: "echo ok",
					cwd: join(tmpRoot, "scratch"),
					workspaceDir: join(tmpRoot, "scratch"),
				}),
			).rejects.toThrow("docker failed");
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("force removes the container when the host-side timeout expires", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-timeout-"));
		const calls: string[][] = [];
		const runner: DockerCliRunner = async (args, options) => {
			calls.push([...args]);
			if (args[0] === "rm") {
				throw "rm failed";
			}
			return new Promise((_, reject) => {
				options?.signal?.addEventListener("abort", () => {
					reject(new Error("aborted"));
				});
			});
		};

		try {
			const sandbox = createDockerSandbox({
				artifactsDir: join(tmpRoot, "artifacts"),
				baseDir: join(tmpRoot, "base"),
				cacheDir: join(tmpRoot, "cache"),
				image: "alpine:3.20",
				runner,
				timeoutMs: 1,
			});

			const result = await sandbox.runShellCommand({
				command: "sleep 60",
				cwd: join(tmpRoot, "scratch"),
				workspaceDir: join(tmpRoot, "scratch"),
			});
			const payload = JSON.parse(result.content) as {
				exitCode: number | null;
				timedOut: boolean;
			};

			expect(result.isError).toBe(true);
			expect(payload).toMatchObject({ exitCode: null, timedOut: true });
			expect(calls[0]?.[0]).toBe("run");
			expect(calls[1]).toEqual(["rm", "-f", expect.stringMatching(/^quilin-/)]);
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("reports non-Error timeout abort reasons from the Docker CLI runner", async () => {
		const tmpRoot = await mkdtemp(
			join(tmpdir(), "quilin-docker-timeout-text-"),
		);
		const runner: DockerCliRunner = async (args, options) => {
			if (args[0] === "rm") {
				throw new Error("rm failed");
			}
			return new Promise((_, reject) => {
				options?.signal?.addEventListener("abort", () => {
					reject("aborted as text");
				});
			});
		};

		try {
			const sandbox = createDockerSandbox({
				artifactsDir: join(tmpRoot, "artifacts"),
				baseDir: join(tmpRoot, "base"),
				cacheDir: join(tmpRoot, "cache"),
				image: "alpine:3.20",
				runner,
				timeoutMs: 1,
			});

			const result = await sandbox.runShellCommand({
				command: "sleep 60",
				cwd: join(tmpRoot, "scratch"),
				workspaceDir: join(tmpRoot, "scratch"),
			});
			const payload = JSON.parse(result.content) as {
				stderr: string;
				timedOut: boolean;
			};

			expect(result.isError).toBe(true);
			expect(payload).toMatchObject({
				stderr: "aborted as text",
				timedOut: true,
			});
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("reports docker daemon availability from the CLI", async () => {
		const runner: DockerCliRunner = async () => ({
			exitCode: 0,
			stderr: "",
			stdout: "28.5.2\n",
		});

		await expect(hasDocker({ runner })).resolves.toBe(true);
		await expect(
			hasDocker({
				runner: async () => ({ exitCode: 0, stderr: "", stdout: "  " }),
			}),
		).resolves.toBe(false);
		await expect(
			hasDocker({
				runner: async () => ({ exitCode: 1, stderr: "down", stdout: "" }),
			}),
		).resolves.toBe(false);
		await expect(
			hasDocker({
				runner: async () => {
					throw new Error("daemon unavailable");
				},
			}),
		).resolves.toBe(false);
		await expect(
			hasDocker({
				runner: async (_args, options) =>
					new Promise((_, reject) => {
						options?.signal?.addEventListener("abort", () => {
							reject("aborted");
						});
					}),
				timeoutMs: 1,
			}),
		).resolves.toBe(false);
	});

	it("can run a generic CLI process for stdout and stderr collection", async () => {
		const result = await runDockerCli(
			["-e", "process.stdout.write('out'); process.stderr.write('err')"],
			{ dockerBinary: process.execPath },
		);

		expect(result).toEqual({
			exitCode: 0,
			outputTruncated: false,
			stderr: "err",
			stdout: "out",
		});
	});

	it("bounds combined stdout and stderr collection by bytes", async () => {
		const result = await runDockerCli(
			[
				"-e",
				"process.stdout.write('a'.repeat(512)); process.stderr.write('b'.repeat(512));",
			],
			{ dockerBinary: process.execPath, maxOutputBytes: 64 },
		);

		expect(result.outputTruncated).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBeLessThanOrEqual(64);
	});

	it("marks truncated docker output as an error and force removes the container", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-truncated-"));
		const calls: string[][] = [];
		const runner: DockerCliRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "rm") {
				return { exitCode: 0, stderr: "", stdout: "" };
			}
			return {
				exitCode: null,
				outputTruncated: true,
				stderr: "",
				stdout: "x".repeat(8),
			};
		};

		try {
			const sandbox = createDockerSandbox({
				artifactsDir: join(tmpRoot, "artifacts"),
				baseDir: join(tmpRoot, "base"),
				cacheDir: join(tmpRoot, "cache"),
				image: "alpine:3.20",
				maxOutputBytes: 8,
				runner,
			});

			const result = await sandbox.runShellCommand({
				command: "yes",
				cwd: join(tmpRoot, "scratch"),
				workspaceDir: join(tmpRoot, "scratch"),
			});
			const payload = JSON.parse(result.content) as {
				output_truncated: boolean;
			};

			expect(result.isError).toBe(true);
			expect(payload.output_truncated).toBe(true);
			expect(calls.at(-1)).toEqual([
				"rm",
				"-f",
				expect.stringMatching(/^quilin-/),
			]);
		} finally {
			await rm(tmpRoot, { force: true, recursive: true });
		}
	});

	it("surfaces spawn failures from the generic CLI runner", async () => {
		await expect(
			runDockerCli([], { dockerBinary: "/definitely/missing/docker" }),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(!dockerAvailable)(
		"runs a real container with read-only base and writable artifacts",
		async () => {
			const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-docker-real-"));
			const baseDir = join(tmpRoot, "base");
			const cacheDir = join(tmpRoot, "cache");
			const artifactsDir = join(tmpRoot, "artifacts");
			const scratchDir = join(tmpRoot, "scratch");
			try {
				await mkdir(baseDir, { recursive: true });
				await mkdir(cacheDir, { recursive: true });
				await mkdir(scratchDir, { recursive: true });
				await writeFile(join(baseDir, "input.txt"), "hello", "utf8");

				const sandbox = createDockerSandbox({
					artifactsDir,
					baseDir,
					cacheDir,
					image: "alpine:3.20",
					timeoutMs: 30_000,
				});
				const result = await sandbox.runShellCommand({
					command:
						"cat /workspace/base/input.txt > /workspace/artifacts/output.txt",
					cwd: scratchDir,
					workspaceDir: scratchDir,
				});

				expect(result.isError).toBe(false);
				await expect(
					readFile(join(artifactsDir, "output.txt"), "utf8"),
				).resolves.toBe("hello");
			} finally {
				await rm(tmpRoot, { force: true, recursive: true });
			}
		},
	);
});
