import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import { createShellExecTool, type ShellRunner } from "./builtin/shell-exec.js";
import {
	createDockerSandboxRouter,
	type DockerSandboxCliRunner,
	DockerSandboxRouter,
	DockerSandboxRuntimeError,
	runDockerSandboxCli,
} from "./docker-sandbox-router.js";
import {
	createSandboxAuditRef,
	createSandboxPolicyDigest,
	type SandboxCreateRequest,
	type SandboxSnapshotRef,
} from "./sandbox-router.js";

function testDirs(label: string): {
	readonly base: string;
	readonly task: string;
	readonly artifacts: string;
	readonly cache: string;
} {
	const root = join(tmpdir(), "quilin-agent-core-docker-sandbox", label);
	return {
		base: join(root, "base"),
		task: join(root, "task"),
		artifacts: join(root, "artifacts"),
		cache: join(root, "cache"),
	};
}

function createRequest(
	label: string,
	overrides: Partial<SandboxCreateRequest> = {},
): SandboxCreateRequest {
	const dirs = testDirs(label);
	const request: SandboxCreateRequest = {
		owner: {
			userId: "user-1",
			agentId: "agent-1",
			runId: `run-${label}`,
			taskId: `task-${label}`,
		},
		purpose: "tool-worker",
		image: {
			reference: "python:3.14-slim",
			allowlisted: true,
		},
		mounts: [
			{
				kind: "base",
				hostPath: dirs.base,
				sandboxPath: "/workspace/base",
				access: "readonly",
				required: true,
			},
			{
				kind: "task",
				hostPath: dirs.task,
				sandboxPath: "/workspace/task",
				access: "readwrite",
				required: true,
			},
			{
				kind: "artifacts",
				hostPath: dirs.artifacts,
				sandboxPath: "/workspace/artifacts",
				access: "readwrite",
				required: true,
			},
			{
				kind: "cache",
				hostPath: dirs.cache,
				sandboxPath: "/workspace/cache",
				access: "readonly",
				required: false,
			},
		],
		networkPolicy: { mode: "none" },
		resourcePolicy: {
			cpuCount: 2,
			memoryMb: 512,
			memorySwapMb: 512,
			processCount: 64,
			stdoutBytes: 4096,
			stderrBytes: 4096,
			wallClockTimeoutMs: 30_000,
			concurrency: 1,
		},
		outputPolicy: {
			artifactsPath: "/workspace/artifacts",
			maxArtifactBytes: 1_000_000,
			includeHiddenFiles: false,
			promotePatterns: ["*.json"],
			exposePartialOutputOnFailure: true,
		},
		permissionManifest: {
			identity: { user: "quilin-worker", role: "worker" },
			filesystem: {
				readonly: ["/workspace/base"],
				readwrite: ["/workspace/task", "/workspace/artifacts"],
				execute: ["/workspace/task"],
			},
			sessionSharing: "isolated",
			allowSecretMounts: false,
		},
		ttlMs: 300_000,
	};
	return { ...request, ...overrides };
}

const fixedNow = () => new Date("2026-05-05T08:45:00.000Z");

describe("DockerSandboxRouter", () => {
	it("can allocate a typed session with default constructor options", async () => {
		const router = new DockerSandboxRouter();

		const session = await router.createSession(createRequest("defaults"));

		expect(session).toMatchObject({
			provider: "docker",
			state: {
				provider: "docker",
				state: "ready",
				traceId: "run-defaults",
			},
		});
		expect(session.id).toMatch(/^[a-z0-9-]+$/u);
	});

	it("keeps Docker routing separate from host shell_exec execution", async () => {
		const dockerRunner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "docker\n",
			stderr: "",
			exitCode: 0,
		}));
		const shellRunner = vi.fn<ShellRunner>(async () => ({
			stdout: "host\n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		}));
		const router = createDockerSandboxRouter({
			runner: dockerRunner,
			now: fixedNow,
			createSessionId: () => "session-shell-boundary",
		});
		await router.createSession(createRequest("shell-boundary"));
		const shellExec = createShellExecTool({
			sandbox: "off",
			runner: shellRunner,
			authority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
		});

		const result = await shellExec.execute({ command: "echo host" });

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toMatchObject({
			command: "echo host",
			exitCode: 0,
			stdout: "host\n",
		});
		expect(shellRunner).toHaveBeenCalledWith(
			"echo",
			["host"],
			expect.objectContaining({
				timeoutMs: 30_000,
			}),
		);
		expect(dockerRunner).not.toHaveBeenCalled();
	});

	it("derives trace ids from task id or generated session id when run id is absent", async () => {
		const taskRouter = createDockerSandboxRouter({
			runner: vi.fn<DockerSandboxCliRunner>(),
			now: fixedNow,
			createSessionId: () => "session-task-trace",
		});
		const fallbackRouter = createDockerSandboxRouter({
			runner: vi.fn<DockerSandboxCliRunner>(),
			now: fixedNow,
			createSessionId: () => "session-generated-trace",
		});

		await expect(
			taskRouter.createSession(
				createRequest("task-trace", {
					owner: { taskId: "task-only" },
				}),
			),
		).resolves.toMatchObject({
			state: {
				traceId: "task-only",
			},
		});
		await expect(
			fallbackRouter.createSession(
				createRequest("generated-trace", {
					owner: {},
				}),
			),
		).resolves.toMatchObject({
			state: {
				traceId: "sandbox-session:session-generated-trace",
			},
		});
	});

	it("creates docker sessions and executes commands with mounted policies", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
		}));
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-1",
			containerNamePrefix: "quilin-test",
		});
		const request = createRequest("execute-success");
		const session = await router.createSession(request);

		await expect(router.inspectSession("session-1")).resolves.toMatchObject({
			id: "session-1",
			provider: "docker",
			state: "ready",
			traceId: "run-execute-success",
			auditRef: "sandbox:run-execute-success:create:session-1",
		});

		const result = await session.execute({
			argv: ["node", "--version"],
			env: { NODE_ENV: "test" },
		});

		expect(result).toMatchObject({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			outputTruncated: false,
			output_truncated: false,
			artifactsDir: testDirs("execute-success").artifacts,
			provider: "docker",
			sessionId: "session-1",
			traceId: "run-execute-success",
			auditRef: "sandbox:run-execute-success:execute:session-1",
			isIsolationBoundary: true,
			risk: "production",
		});
		expect(result.failure).toBeUndefined();

		const args = runner.mock.calls[0]?.[0] ?? [];
		expect(args).toEqual(
			expect.arrayContaining([
				"run",
				"--rm",
				"--name",
				"quilin-test-session-1-execute-1777970700000",
				"--network",
				"none",
				"--memory",
				"512m",
				"--memory-swap",
				"512m",
				"--pids-limit",
				"64",
				"--cpus",
				"2",
				"--read-only",
				"-w",
				"/workspace/task",
				"--env",
				"NODE_ENV=test",
				"python:3.14-slim",
				"node",
				"--version",
			]),
		);
		expect(args).toContain(
			`type=bind,src=${testDirs("execute-success").base},dst=/workspace/base,readonly`,
		);
		expect(args).toContain(
			`type=bind,src=${testDirs("execute-success").task},dst=/workspace/task`,
		);
		expect(args).toContain(
			`type=bind,src=${testDirs("execute-success").artifacts},dst=/workspace/artifacts`,
		);
	});

	it("fails closed for unsupported network allowlists before running Docker", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-network",
		});
		const session = await router.createSession(
			createRequest("network-denied", {
				networkPolicy: {
					mode: "allowlist",
					allowlist: [{ host: "api.example.com", purpose: "package index" }],
				},
			}),
		);

		const result = await session.execute({ argv: ["python", "-V"] });

		expect(runner).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			exitCode: null,
			timedOut: false,
			failure: {
				kind: "network_denied",
				code: "docker_network_allowlist_unsupported",
				provider: "docker",
				phase: "execute",
				retryable: false,
			},
		});
	});

	it("allows debug bridge networking only with explicit router opt-in", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "ok",
			stderr: "",
			exitCode: 0,
		}));
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-debug-network",
			allowDebugBridgeNetwork: true,
		});
		const session = await router.createSession(
			createRequest("debug-network", {
				networkPolicy: { mode: "debug-bridge" },
			}),
		);

		await expect(
			session.execute({ argv: ["python", "-V"] }),
		).resolves.toMatchObject({
			exitCode: 0,
		});
		expect(runner.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining(["--network", "bridge"]),
		);
	});

	it("denies debug bridge networking without explicit router opt-in", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-debug-denied",
		});
		const session = await router.createSession(
			createRequest("debug-denied", {
				networkPolicy: { mode: "debug-bridge" },
			}),
		);

		await expect(
			session.execute({ argv: ["python", "-V"] }),
		).resolves.toMatchObject({
			failure: {
				kind: "network_denied",
				code: "docker_debug_bridge_requires_explicit_opt_in",
			},
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("fails closed when a required mount has no host path", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-mount",
		});
		const session = await router.createSession(
			createRequest("mount-missing", {
				mounts: [
					{
						kind: "task",
						sandboxPath: "/workspace/task",
						access: "readwrite",
						required: true,
					},
				],
			}),
		);

		await expect(
			session.execute({ argv: ["python", "-V"] }),
		).resolves.toMatchObject({
			exitCode: null,
			failure: {
				kind: "mount_failed",
				code: "sandbox_mount_host_path_required",
				retryable: false,
			},
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("skips optional mounts without host paths and supports missing artifact mount", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "ok",
			stderr: "",
			exitCode: 0,
		}));
		const dirs = testDirs("optional-mount");
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-optional-mount",
		});
		const session = await router.createSession(
			createRequest("optional-mount", {
				mounts: [
					{
						kind: "task",
						hostPath: dirs.task,
						sandboxPath: "/workspace/task",
						access: "readwrite",
						required: true,
					},
					{
						kind: "cache",
						sandboxPath: "/workspace/cache",
						access: "readonly",
						required: false,
					},
				],
				outputPolicy: {
					artifactsPath: "/workspace/artifacts",
					maxArtifactBytes: 1_000_000,
					includeHiddenFiles: false,
					promotePatterns: [],
					exposePartialOutputOnFailure: true,
				},
			}),
		);

		const result = await session.execute({ argv: ["python", "-V"] });

		expect(result.artifacts).toEqual([]);
		expect(runner.mock.calls[0]?.[0].join(" ")).not.toContain(
			"/workspace/cache",
		);
	});

	it("returns structured command failures for non-zero exits and truncation", async () => {
		const runner = vi
			.fn<DockerSandboxCliRunner>()
			.mockResolvedValueOnce({
				stdout: "",
				stderr: "boom",
				exitCode: 2,
			})
			.mockResolvedValueOnce({
				stdout: "x".repeat(10),
				stderr: "",
				exitCode: null,
				outputTruncated: true,
			});
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-failures",
		});
		const session = await router.createSession(createRequest("failures"));

		await expect(session.execute({ argv: ["false"] })).resolves.toMatchObject({
			exitCode: 2,
			failure: {
				kind: "command_failed",
				code: "sandbox_command_failed",
				commandExitCode: 2,
				stderrPreview: "boom",
				retryable: false,
			},
		});
		await expect(
			session.execute({ argv: ["cat", "large"] }),
		).resolves.toMatchObject({
			exitCode: null,
			outputTruncated: true,
			failure: {
				kind: "output_truncated",
				code: "sandbox_output_truncated",
				retryable: false,
			},
		});
	});

	it("normalizes runner exceptions and uses default Docker resource args", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => {
			throw new Error("docker unavailable");
		});
		const dirs = testDirs("runner-exception");
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-runner-exception",
		});
		const session = await router.createSession(
			createRequest("runner-exception", {
				owner: {},
				mounts: [
					{
						kind: "base",
						hostPath: dirs.base,
						sandboxPath: "/workspace/base",
						access: "readonly",
						required: true,
					},
				],
				resourcePolicy: {},
			}),
		);

		await expect(
			session.execute({ argv: ["python", "-V"] }),
		).resolves.toMatchObject({
			stderr: "docker unavailable",
			failure: {
				kind: "provider_unavailable",
				code: "sandbox_operation_failed",
				retryable: true,
			},
		});
		const args = runner.mock.calls[0]?.[0] ?? [];
		expect(args).toEqual(
			expect.arrayContaining([
				"--memory",
				"2048m",
				"--memory-swap",
				"2048m",
				"--pids-limit",
				"512",
				"-w",
				"/workspace",
			]),
		);
		expect(args).not.toContain("--cpus");
	});

	it("aborts timed out commands and force-removes the container", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>((args, options) => {
			if (args[0] === "rm") {
				return Promise.reject(new Error("rm failed"));
			}
			return new Promise((_, reject) => {
				options?.signal?.addEventListener("abort", () => {
					reject("aborted");
				});
			});
		});
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-timeout",
			containerNamePrefix: "quilin-timeout",
		});
		const session = await router.createSession(createRequest("timeout"));

		await expect(
			session.execute({ argv: ["sleep", "10"], timeoutMs: 1 }),
		).resolves.toMatchObject({
			exitCode: null,
			timedOut: true,
			failure: {
				kind: "timeout",
				code: "sandbox_command_timeout",
				commandExitCode: null,
				retryable: false,
			},
		});
		expect(runner).toHaveBeenCalledTimes(2);
		expect(runner.mock.calls[1]?.[0]).toEqual([
			"rm",
			"-f",
			"quilin-timeout-session-timeout-execute-1777970700000",
		]);
	});

	it("returns a timeout even when the runner ignores abort signals", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>((args) => {
			if (args[0] === "rm") {
				return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
			}
			return new Promise(() => undefined);
		});
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-timeout-race",
		});
		const session = await router.createSession(createRequest("timeout-race"));

		await expect(
			session.execute({ argv: ["sleep", "10"], timeoutMs: 1 }),
		).resolves.toMatchObject({
			exitCode: null,
			timedOut: true,
			failure: {
				kind: "timeout",
				code: "sandbox_command_timeout",
				stderrPreview: "Docker sandbox command timed out.",
			},
		});
		expect(runner).toHaveBeenCalledTimes(2);
	});

	it("uses cleanup timeout when force removal hangs", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>((args, options) => {
			if (args[0] === "rm") {
				return new Promise(() => undefined);
			}
			return new Promise((_, reject) => {
				options?.signal?.addEventListener("abort", () => {
					reject(new Error("aborted"));
				});
			});
		});
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-cleanup-timeout",
			cleanupTimeoutMs: 1,
		});
		const session = await router.createSession(
			createRequest("cleanup-timeout"),
		);

		await expect(
			session.execute({ argv: ["sleep", "10"], timeoutMs: 1 }),
		).resolves.toMatchObject({
			timedOut: true,
			failure: {
				kind: "timeout",
			},
		});
		expect(runner).toHaveBeenCalledTimes(2);
	});

	it("installs packages through the same docker execution path", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "installed",
			stderr: "",
			exitCode: 0,
		}));
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-install",
		});
		const session = await router.createSession(createRequest("install"));

		await expect(
			session.install({
				manager: "pip",
				packages: ["pytest"],
				timeoutMs: 10_000,
			}),
		).resolves.toMatchObject({
			ok: true,
			packages: ["pytest"],
			traceId: "run-install",
			auditRef: "sandbox:run-install:install:session-install",
		});

		const args = runner.mock.calls[0]?.[0] ?? [];
		expect(args.slice(-4)).toEqual([
			"python:3.14-slim",
			"pip",
			"install",
			"pytest",
		]);
	});

	it("maps supported install managers to stable command argv", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "installed",
			stderr: "",
			exitCode: 0,
		}));
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-install-managers",
		});
		const session = await router.createSession(
			createRequest("install-managers"),
		);

		await session.install({ manager: "npm", packages: ["vitest"] });
		await session.install({ manager: "pnpm", packages: ["typescript"] });
		await session.install({ manager: "uv", packages: ["pytest"] });
		await session.install({ manager: "apt", packages: ["lib'ssl"] });
		await session.install({ manager: "pip", packages: [] });

		expect(runner.mock.calls[0]?.[0].slice(-4)).toEqual([
			"python:3.14-slim",
			"npm",
			"install",
			"vitest",
		]);
		expect(runner.mock.calls[1]?.[0].slice(-4)).toEqual([
			"python:3.14-slim",
			"pnpm",
			"add",
			"typescript",
		]);
		expect(runner.mock.calls[2]?.[0].slice(-5)).toEqual([
			"python:3.14-slim",
			"uv",
			"pip",
			"install",
			"pytest",
		]);
		expect(runner.mock.calls[3]?.[0].slice(-4)).toEqual([
			"python:3.14-slim",
			"/bin/sh",
			"-lc",
			"apt-get update && apt-get install -y 'lib'\"'\"'ssl'",
		]);
		expect(runner.mock.calls[4]?.[0].slice(-2)).toEqual([
			"python:3.14-slim",
			"true",
		]);
	});

	it("rejects unsupported install managers with structured failures", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-install-denied",
		});
		const session = await router.createSession(createRequest("install-denied"));

		await expect(
			session.install({
				manager: "gem",
				packages: ["rspec"],
			}),
		).resolves.toMatchObject({
			ok: false,
			failure: {
				kind: "policy_rejected",
				code: "sandbox_install_manager_unknown",
				retryable: false,
			},
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("returns install failures when the package command fails", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>(async () => ({
			stdout: "",
			stderr: "install failed",
			exitCode: 1,
		}));
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-install-fails",
		});
		const session = await router.createSession(createRequest("install-fails"));

		await expect(
			session.install({ manager: "pip", packages: ["missing-package"] }),
		).resolves.toMatchObject({
			ok: false,
			failure: {
				kind: "command_failed",
				code: "sandbox_command_failed",
				commandExitCode: 1,
				stderrPreview: "install failed",
			},
		});
	});

	it("keeps snapshot and resume fail-closed until durable semantics exist", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-snapshot",
		});
		const request = createRequest("snapshot");
		const session = await router.createSession(request);

		await expect(
			session.snapshot({
				reason: "checkpoint",
				includeArtifacts: true,
				includeCacheMetadata: true,
			}),
		).rejects.toMatchObject({
			failure: {
				kind: "snapshot_failed",
				code: "docker_snapshot_not_implemented",
				retryable: false,
			},
		});

		const snapshot: SandboxSnapshotRef = {
			id: "snapshot-1",
			provider: "docker",
			sessionId: "session-snapshot",
			createdAt: "2026-05-05T08:45:00.000Z",
			image: request.image,
			policyDigest: createSandboxPolicyDigest(request),
			state: "ready",
			files: [],
			environmentManifest: {},
		};
		await expect(
			router.resumeSession({
				owner: request.owner,
				snapshot,
				traceId: "trace-resume",
				auditRef: createSandboxAuditRef({
					traceId: "trace-resume",
					phase: "resume",
					sessionId: "session-snapshot",
				}),
			}),
		).rejects.toMatchObject({
			failure: {
				kind: "resume_mismatch",
				code: "docker_resume_not_implemented",
				retryable: false,
			},
		});

		await expect(session.suspend("user_pause")).rejects.toMatchObject({
			failure: {
				kind: "snapshot_failed",
				code: "docker_snapshot_not_implemented",
			},
		});
	});

	it("throws the documented fail-closed resume error directly from the router", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-direct-resume",
		});
		const request = createRequest("direct-resume");
		const snapshot: SandboxSnapshotRef = {
			id: "snapshot-direct",
			provider: "docker",
			sessionId: "session-direct-resume",
			createdAt: "2026-05-05T08:45:00.000Z",
			image: request.image,
			policyDigest: createSandboxPolicyDigest(request),
			state: "ready",
			files: [],
			environmentManifest: {},
		};

		let caught: unknown;
		try {
			await router.resumeSession({
				owner: request.owner,
				snapshot,
				traceId: "trace-direct-resume",
				auditRef: createSandboxAuditRef({
					traceId: "trace-direct-resume",
					phase: "resume",
					sessionId: "session-direct-resume",
				}),
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(DockerSandboxRuntimeError);
		expect(caught).toMatchObject({
			failure: {
				kind: "resume_mismatch",
				code: "docker_resume_not_implemented",
				retryable: false,
			},
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("does not allow local-dev sessions through the docker adapter", async () => {
		const router = createDockerSandboxRouter({
			runner: vi.fn<DockerSandboxCliRunner>(),
			now: fixedNow,
			createSessionId: () => "session-local",
		});

		await expect(
			router.createSession(
				createRequest("local-dev", {
					purpose: "dev-shell",
					providerPreference: ["local-dev"],
				}),
			),
		).rejects.toBeInstanceOf(DockerSandboxRuntimeError);
		await expect(
			router.createSession(
				createRequest("local-dev", {
					purpose: "dev-shell",
					providerPreference: ["local-dev"],
				}),
			),
		).rejects.toMatchObject({
			failure: {
				kind: "provider_unavailable",
				code: "sandbox_provider_unavailable",
				provider: "local-dev",
			},
		});
	});

	it("keeps create/inspect/destroy in memory without running Docker", async () => {
		const runner = vi.fn<DockerSandboxCliRunner>();
		const router = createDockerSandboxRouter({
			runner,
			now: fixedNow,
			createSessionId: () => "session-destroy",
		});
		const session = await router.createSession(createRequest("destroy"));

		await expect(router.inspectSession(session.id)).resolves.toMatchObject({
			id: "session-destroy",
			state: "ready",
		});
		await router.destroySession(session.id, "completed");
		await router.destroySession("missing-session", "cleanup");

		await expect(router.inspectSession(session.id)).rejects.toMatchObject({
			failure: {
				kind: "provider_unavailable",
				code: "sandbox_session_not_found",
				retryable: false,
			},
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("limits raw CLI output before resolving process results", async () => {
		const result = await runDockerSandboxCli(
			["-e", "process.stdout.write('abcdef')"],
			{
				dockerBinary: process.execPath,
				maxOutputBytes: 3,
			},
		);

		expect(result).toMatchObject({
			stdout: "abc",
			outputTruncated: true,
		});

		await expect(
			runDockerSandboxCli(["-e", "process.stdout.write('abcdef')"], {
				dockerBinary: process.execPath,
				maxOutputBytes: 0,
			}),
		).resolves.toMatchObject({
			stdout: "",
			outputTruncated: true,
		});

		await expect(
			runDockerSandboxCli(["-e", "process.stderr.write('err')"], {
				dockerBinary: process.execPath,
				maxOutputBytes: 10,
			}),
		).resolves.toMatchObject({
			stderr: "err",
			outputTruncated: false,
		});
		await expect(
			runDockerSandboxCli(
				["-e", "process.stderr.write('abcdef'); setTimeout(() => {}, 1000)"],
				{
					dockerBinary: process.execPath,
					maxOutputBytes: 3,
				},
			),
		).resolves.toMatchObject({
			stderr: "abc",
			outputTruncated: true,
		});
		await expect(
			runDockerSandboxCli(["-e", "process.stdout.write('ok')"], {
				dockerBinary: process.execPath,
			}),
		).resolves.toMatchObject({
			stdout: "ok",
			outputTruncated: false,
		});
		await expect(
			runDockerSandboxCli([], {
				dockerBinary: "/definitely/missing/docker-binary",
			}),
		).rejects.toThrow();
	});
	it("executeAuto returns null when Docker is unavailable", async () => {
		vi.spyOn(DockerSandboxRouter, "isDockerAvailable").mockResolvedValue(false);
		try {
			const runner = vi.fn<DockerSandboxCliRunner>();
			const router = createDockerSandboxRouter({ runner, now: fixedNow }) as unknown as DockerSandboxRouter;
			const result = await router.executeAuto({ argv: ["echo", "hello"] });
			expect(result).toBeNull();
			expect(runner).not.toHaveBeenCalled();
		} finally { vi.restoreAllMocks(); }
	});

	it("executeAuto creates session and executes when Docker is available", async () => {
		vi.spyOn(DockerSandboxRouter, "isDockerAvailable").mockResolvedValue(true);
		try {
			const runner = vi.fn<DockerSandboxCliRunner>(async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 }));
			const router = createDockerSandboxRouter({ runner, now: fixedNow, createSessionId: () => "session-exec-auto-test" }) as unknown as DockerSandboxRouter;
			const result = await router.executeAuto({ argv: ["echo", "hello"], cwd: "/tmp", timeoutMs: 10_000 });
			expect(result).not.toBeNull();
			expect(result?.exitCode).toBe(0);
			expect(result?.stdout).toBe("ok\n");
			expect(runner).toHaveBeenCalled();
		} finally { vi.restoreAllMocks(); }
	});

});
