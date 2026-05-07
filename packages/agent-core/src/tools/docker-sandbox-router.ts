import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import {
	createSandboxAuditRef,
	createSandboxFailure,
	normalizeSandboxFailure,
	type SandboxArtifactRef,
	type SandboxCommandInput,
	type SandboxCommandResult,
	type SandboxCreateRequest,
	type SandboxDestroyReason,
	type SandboxFailure,
	type SandboxInstallInput,
	type SandboxInstallResult,
	type SandboxMountSpec,
	type SandboxNetworkPolicy,
	type SandboxOutputPolicy,
	type SandboxPhase,
	type SandboxProviderKind,
	type SandboxResourcePolicy,
	type SandboxResumeRequest,
	type SandboxRouter,
	type SandboxSession,
	type SandboxSessionState,
	type SandboxSnapshotInput,
	type SandboxSnapshotRef,
	type SandboxSuspendReason,
	selectSandboxProvider,
} from "./sandbox-router.js";

export interface DockerSandboxCliRunOptions {
	readonly signal?: AbortSignal;
	readonly dockerBinary?: string;
	readonly maxOutputBytes?: number;
}

export interface DockerSandboxCliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly outputTruncated?: boolean;
}

export type DockerSandboxCliRunner = (
	args: readonly string[],
	options?: DockerSandboxCliRunOptions,
) => Promise<DockerSandboxCliResult>;

export interface DockerSandboxRouterOptions {
	readonly runner?: DockerSandboxCliRunner;
	readonly dockerBinary?: string;
	readonly containerNamePrefix?: string;
	readonly cleanupTimeoutMs?: number;
	readonly now?: () => Date;
	readonly createSessionId?: () => string;
	readonly allowDebugBridgeNetwork?: boolean;
}

export class DockerSandboxRuntimeError extends Error {
	readonly failure: SandboxFailure;

	constructor(failure: SandboxFailure) {
		super(failure.message);
		this.name = "DockerSandboxRuntimeError";
		this.failure = failure;
	}
}

const DEFAULT_CONTAINER_NAME_PREFIX = "quilin-sandbox";
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_PROCESS_COUNT = 512;

export function createDockerSandboxRouter(
	options: DockerSandboxRouterOptions = {},
): SandboxRouter {
	return new DockerSandboxRouter(options);
}

/**
 * Docker provider adapter for explicit SandboxRouter sessions.
 *
 * This router is not a shell_exec interceptor and does not allocate a durable
 * container during createSession. It tracks session policy/state in memory and
 * runs each execute/install call as a fresh `docker run --rm` process with the
 * requested mounts, network mode, and resource limits. inspectSession therefore
 * reports only the in-memory session state, resume/snapshot/suspend fail closed
 * until durable snapshot/replay exists, and destroySession only drops tracked
 * state because normal command containers are already removed by Docker.
 */
export class DockerSandboxRouter implements SandboxRouter {
	private readonly runner: DockerSandboxCliRunner;
	private readonly dockerBinary: string | undefined;
	private readonly containerNamePrefix: string;
	private readonly cleanupTimeoutMs: number;
	private readonly now: () => Date;
	private readonly createSessionId: () => string;
	private readonly allowDebugBridgeNetwork: boolean;
	private readonly sessions = new Map<string, DockerSandboxSession>();

	/**
	 * Detect whether the Docker daemon is reachable by calling `docker info`.
	 *
	 * Docker daemon 可达性检测：调用 `docker info` 判断 Docker 守护进程是否正常运行。
	 */
	static async isDockerAvailable(options?: {
		readonly dockerBinary?: string;
		readonly probeTimeoutMs?: number;
	}): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(),
				options?.probeTimeoutMs ?? 5_000,
			);
			try {
				const result = await runDockerSandboxCli(["info"], {
					dockerBinary: options?.dockerBinary,
					signal: controller.signal,
				});
				return result.exitCode === 0;
			} finally {
				clearTimeout(timeout);
			}
		} catch {
			return false;
		}
	}

	/**
	 * Auto-detection execution: probes Docker availability, and if reachable
	 * creates a disposable sandbox session, runs the command, and cleans up.
	 * Returns `null` when Docker is unavailable so the caller can fall back
	 * to the host runner.
	 *
	 * 自动检测执行：先探测 Docker 是否可用，可用则创建一次性沙箱会话执行命令后清理；
	 * Docker 不可用时返回 `null`，由调用方回退到宿主机执行。
	 */
	async executeAuto(input: {
		readonly argv: readonly string[];
		readonly cwd?: string;
		readonly env?: Readonly<Record<string, string>>;
		readonly timeoutMs?: number;
	}): Promise<DockerSandboxCliResult | null> {
		const available = await DockerSandboxRouter.isDockerAvailable({
			dockerBinary: this.dockerBinary,
		});
		if (!available) {
			return null;
		}

		const workDir = input.cwd ?? process.cwd();
		const cmdTimeoutMs = input.timeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS;

		const session = await this.createSession({
			owner: { agentId: "shell-exec-auto" },
			purpose: "tool-worker",
			image: { reference: "alpine:latest", allowlisted: true },
			mounts: [
				{
					kind: "task",
					hostPath: workDir,
					sandboxPath: "/workspace",
					access: "readwrite",
					required: true,
				},
			],
			networkPolicy: { mode: "none" },
			resourcePolicy: { wallClockTimeoutMs: cmdTimeoutMs },
			outputPolicy: {
				artifactsPath: "/workspace/.quilin-artifacts",
				maxArtifactBytes: 0,
				includeHiddenFiles: false,
				promotePatterns: [],
				exposePartialOutputOnFailure: false,
			},
			permissionManifest: {
				identity: { user: "quilin-worker", role: "worker" },
				filesystem: {
					readonly: [],
					readwrite: ["/workspace"],
					execute: ["/workspace"],
				},
				sessionSharing: "isolated",
				allowSecretMounts: false,
			},
			ttlMs: Math.max(cmdTimeoutMs * 2, 60_000),
		});

		try {
			const result = await session.execute({
				argv: input.argv,
				cwd: "/workspace",
				env: input.env,
				timeoutMs: cmdTimeoutMs,
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
			};
		} finally {
			await this.destroySession(session.id, "completed");
		}
	}

	constructor(options: DockerSandboxRouterOptions = {}) {
		this.runner = options.runner ?? runDockerSandboxCli;
		this.dockerBinary = options.dockerBinary;
		this.containerNamePrefix =
			options.containerNamePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX;
		this.cleanupTimeoutMs =
			options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
		this.now = options.now ?? (() => new Date());
		this.createSessionId =
			options.createSessionId ??
			(() =>
				`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
		this.allowDebugBridgeNetwork = options.allowDebugBridgeNetwork === true;
	}

	async createSession(request: SandboxCreateRequest): Promise<SandboxSession> {
		const sessionId = this.createSessionId();
		const traceId = traceIdForCreateRequest(request, sessionId);
		const auditRef = createSandboxAuditRef({
			traceId,
			phase: "create",
			sessionId,
		});
		const selection = selectSandboxProvider(request, {
			availableProviders: ["docker"],
			traceId,
			auditRef,
			runtimeContext: "production",
		});

		if (selection.kind === "rejected") {
			throw new DockerSandboxRuntimeError(selection.failure);
		}

		const createdAt = this.now().toISOString();
		const session = new DockerSandboxSession({
			auditRef,
			containerNamePrefix: this.containerNamePrefix,
			dockerBinary: this.dockerBinary,
			now: this.now,
			request,
			runner: this.runner,
			sessionId,
			traceId,
			cleanupTimeoutMs: this.cleanupTimeoutMs,
			allowDebugBridgeNetwork: this.allowDebugBridgeNetwork,
			initialState: {
				id: sessionId,
				provider: "docker",
				state: "ready",
				owner: request.owner,
				purpose: request.purpose,
				createdAt,
				updatedAt: createdAt,
				expiresAt: new Date(this.now().getTime() + request.ttlMs).toISOString(),
				traceId,
				auditRef,
			},
		});
		this.sessions.set(sessionId, session);
		return session;
	}

	async resumeSession(request: SandboxResumeRequest): Promise<SandboxSession> {
		const failure = createSandboxFailure({
			kind: "resume_mismatch",
			code: "docker_resume_not_implemented",
			message: "DockerSandboxRouter does not support durable resume yet.",
			provider: request.snapshot.provider,
			phase: "resume",
			traceId: request.traceId,
			auditRef: request.auditRef,
			retryable: false,
		});
		throw new DockerSandboxRuntimeError(failure);
	}

	async inspectSession(id: string): Promise<SandboxSessionState> {
		const session = this.sessions.get(id);
		if (session == null) {
			throw new DockerSandboxRuntimeError(
				createSandboxFailure({
					kind: "provider_unavailable",
					code: "sandbox_session_not_found",
					message: "Sandbox session was not found.",
					provider: "docker",
					phase: "inspect",
					traceId: `sandbox-session:${id}`,
					auditRef: createSandboxAuditRef({
						traceId: `sandbox-session:${id}`,
						phase: "inspect",
						sessionId: id,
					}),
					retryable: false,
				}),
			);
		}
		return session.state;
	}

	async destroySession(
		id: string,
		reason: SandboxDestroyReason,
	): Promise<void> {
		const session = this.sessions.get(id);
		if (session == null) {
			return;
		}
		await session.destroy(reason);
		this.sessions.delete(id);
	}
}

interface DockerSandboxSessionOptions {
	readonly runner: DockerSandboxCliRunner;
	readonly dockerBinary?: string;
	readonly containerNamePrefix: string;
	readonly cleanupTimeoutMs: number;
	readonly now: () => Date;
	readonly sessionId: string;
	readonly traceId: string;
	readonly auditRef: string;
	readonly request: SandboxCreateRequest;
	readonly initialState: SandboxSessionState;
	readonly allowDebugBridgeNetwork: boolean;
}

class DockerSandboxSession implements SandboxSession {
	readonly id: string;
	readonly provider: SandboxProviderKind = "docker";
	readonly policy: SandboxCreateRequest;

	private readonly runner: DockerSandboxCliRunner;
	private readonly dockerBinary: string | undefined;
	private readonly containerNamePrefix: string;
	private readonly cleanupTimeoutMs: number;
	private readonly now: () => Date;
	private readonly traceId: string;
	private readonly allowDebugBridgeNetwork: boolean;
	private mutableState: SandboxSessionState;

	constructor(options: DockerSandboxSessionOptions) {
		this.id = options.sessionId;
		this.runner = options.runner;
		this.dockerBinary = options.dockerBinary;
		this.containerNamePrefix = options.containerNamePrefix;
		this.cleanupTimeoutMs = options.cleanupTimeoutMs;
		this.now = options.now;
		this.traceId = options.traceId;
		this.policy = options.request;
		this.mutableState = options.initialState;
		this.allowDebugBridgeNetwork = options.allowDebugBridgeNetwork;
	}

	get state(): SandboxSessionState {
		return this.mutableState;
	}

	async execute(input: SandboxCommandInput): Promise<SandboxCommandResult> {
		const phase = "execute";
		const auditRef = createSandboxAuditRef({
			traceId: this.traceId,
			phase,
			sessionId: this.id,
		});
		const startedAt = this.now();
		this.updateState("executing");

		const preflightFailure = await this.prepareForExecution(phase, auditRef);
		if (preflightFailure != null) {
			this.updateState("failed", preflightFailure);
			return this.commandResultFromFailure({
				auditRef,
				failure: preflightFailure,
				input,
				startedAt,
				stdout: "",
				stderr: "",
				exitCode: null,
				timedOut: false,
				outputTruncated: false,
			});
		}

		const containerName = this.containerName("execute");
		const timeoutMs =
			input.timeoutMs ??
			this.policy.resourcePolicy.wallClockTimeoutMs ??
			DEFAULT_WALL_CLOCK_TIMEOUT_MS;
		const controller = new AbortController();
		let timedOut = false;
		let cleanupPromise: Promise<DockerSandboxCliResult> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				cleanupPromise = this.forceRemoveContainer(containerName);
				reject(new Error("Docker sandbox command timed out."));
			}, timeoutMs);
		});

		try {
			const result = await Promise.race([
				this.runner(
					this.dockerRunArgs({
						argv: input.argv,
						auditRef,
						containerName,
						cwd: input.cwd,
						env: input.env,
					}),
					{
						dockerBinary: this.dockerBinary,
						maxOutputBytes: maxOutputBytes(this.policy.resourcePolicy),
						signal: controller.signal,
					},
				),
				timeoutPromise,
			]);
			const outputTruncated = result.outputTruncated === true;
			const failure = commandFailureForResult({
				auditRef,
				exitCode: result.exitCode,
				outputTruncated,
				provider: "docker",
				stderr: result.stderr,
				traceId: this.traceId,
			});
			this.updateState(failure == null ? "ready" : "failed", failure);
			return this.commandResultFromFailure({
				auditRef,
				failure,
				input,
				startedAt,
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				timedOut: false,
				outputTruncated,
				containerName,
			});
		} catch (error) {
			const failure = timedOut
				? createSandboxFailure({
						kind: "timeout",
						code: "sandbox_command_timeout",
						message: "Docker sandbox command timed out.",
						provider: "docker",
						phase,
						traceId: this.traceId,
						auditRef,
						commandExitCode: null,
						stderrPreview:
							error instanceof Error ? error.message : String(error),
					})
				: normalizeSandboxFailure(error, {
						provider: "docker",
						phase,
						traceId: this.traceId,
						auditRef,
					});
			this.updateState("failed", failure);
			return this.commandResultFromFailure({
				auditRef,
				failure,
				input,
				startedAt,
				stdout: "",
				stderr: failure.stderrPreview ?? failure.message,
				exitCode: failure.commandExitCode ?? null,
				timedOut,
				outputTruncated: false,
				containerName,
			});
		} finally {
			if (timer != null) {
				clearTimeout(timer);
			}
			await cleanupPromise;
		}
	}

	async install(input: SandboxInstallInput): Promise<SandboxInstallResult> {
		const startedAt = this.now();
		const auditRef = createSandboxAuditRef({
			traceId: this.traceId,
			phase: "install",
			sessionId: this.id,
		});
		const command = installCommand(input);
		if (command == null) {
			const failure = createSandboxFailure({
				kind: "policy_rejected",
				code: "sandbox_install_manager_unknown",
				message: "Unsupported sandbox install manager.",
				provider: "docker",
				phase: "install",
				traceId: this.traceId,
				auditRef,
				retryable: false,
			});
			this.updateState("failed", failure);
			return {
				ok: false,
				packages: input.packages,
				failure,
				metrics: metricsSince(startedAt, this.now()),
				traceId: this.traceId,
				auditRef,
			};
		}

		const result = await this.execute({
			argv: command,
			timeoutMs: input.timeoutMs,
		});
		return {
			ok: result.failure == null,
			packages: input.packages,
			...(result.failure == null ? {} : { failure: result.failure }),
			metrics: result.metrics,
			traceId: this.traceId,
			auditRef,
		};
	}

	async snapshot(input: SandboxSnapshotInput): Promise<SandboxSnapshotRef> {
		const auditRef = createSandboxAuditRef({
			traceId: this.traceId,
			phase: "snapshot",
			sessionId: this.id,
		});
		const failure = createSandboxFailure({
			kind: "snapshot_failed",
			code: "docker_snapshot_not_implemented",
			message: `DockerSandboxRouter cannot snapshot sessions yet: ${input.reason}`,
			provider: "docker",
			phase: "snapshot",
			traceId: this.traceId,
			auditRef,
			retryable: false,
		});
		this.updateState("failed", failure);
		throw new DockerSandboxRuntimeError(failure);
	}

	async suspend(reason: SandboxSuspendReason): Promise<SandboxSnapshotRef> {
		this.updateState("suspending");
		return this.snapshot({
			reason,
			includeArtifacts: true,
			includeCacheMetadata: true,
		});
	}

	async destroy(_reason: SandboxDestroyReason): Promise<void> {
		this.updateState("destroyed");
	}

	private async prepareForExecution(
		phase: SandboxPhase,
		auditRef: string,
	): Promise<SandboxFailure | undefined> {
		const networkFailure = failureForNetworkPolicy(
			this.policy.networkPolicy,
			this.traceId,
			auditRef,
			this.allowDebugBridgeNetwork,
		);
		if (networkFailure != null) {
			return networkFailure;
		}

		for (const mount of this.policy.mounts) {
			if (mount.hostPath == null) {
				if (mount.required) {
					return createSandboxFailure({
						kind: "mount_failed",
						code: "sandbox_mount_host_path_required",
						message: "Required sandbox mount is missing a hostPath.",
						provider: "docker",
						phase,
						traceId: this.traceId,
						auditRef,
						retryable: false,
					});
				}
				continue;
			}
			if (mount.access === "readwrite") {
				await mkdir(mount.hostPath, { recursive: true });
			}
		}
		const artifactsMount = outputArtifactsMount(
			this.policy.mounts,
			this.policy.outputPolicy,
		);
		if (artifactsMount?.hostPath != null) {
			await mkdir(artifactsMount.hostPath, { recursive: true });
		}
		return undefined;
	}

	private dockerRunArgs(input: {
		readonly argv: readonly string[];
		readonly auditRef: string;
		readonly containerName: string;
		readonly cwd?: string;
		readonly env?: Readonly<Record<string, string>>;
	}): string[] {
		return [
			"run",
			"--rm",
			"--name",
			input.containerName,
			...networkArgs(this.policy.networkPolicy, this.allowDebugBridgeNetwork),
			...resourceArgs(this.policy.resourcePolicy),
			"--read-only",
			...this.policy.mounts.flatMap((mount) => mountArgs(mount)),
			"-w",
			input.cwd ?? defaultSandboxCwd(this.policy.mounts),
			...envArgs(input.env),
			this.policy.image.reference,
			...input.argv,
		];
	}

	private commandResultFromFailure(input: {
		readonly auditRef: string;
		readonly failure?: SandboxFailure;
		readonly input: SandboxCommandInput;
		readonly startedAt: Date;
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number | null;
		readonly timedOut: boolean;
		readonly outputTruncated: boolean;
		readonly containerName?: string;
	}): SandboxCommandResult {
		return {
			stdout: input.stdout,
			stderr: input.stderr,
			exitCode: input.exitCode,
			timedOut: input.timedOut,
			outputTruncated: input.outputTruncated,
			output_truncated: input.outputTruncated,
			artifactsDir: outputArtifactsDir(this.policy),
			...(input.containerName == null
				? {}
				: { containerName: input.containerName }),
			artifacts: artifactsForPolicy(this.policy),
			metrics: metricsSince(input.startedAt, this.now()),
			...(input.failure == null ? {} : { failure: input.failure }),
			provider: "docker",
			sessionId: this.id,
			traceId: this.traceId,
			auditRef: input.auditRef,
			isIsolationBoundary: true,
			risk: "production",
		};
	}

	private async forceRemoveContainer(
		containerName: string,
	): Promise<DockerSandboxCliResult> {
		return Promise.race([
			this.runner(["rm", "-f", containerName], {
				dockerBinary: this.dockerBinary,
			}).catch((error) => ({
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				exitCode: 1,
			})),
			delay(this.cleanupTimeoutMs).then(() => ({
				stdout: "",
				stderr: "docker rm -f cleanup timed out",
				exitCode: 124,
			})),
		]);
	}

	private containerName(phase: SandboxPhase): string {
		const raw = `${this.containerNamePrefix}-${this.id}-${phase}-${this.now().getTime()}`;
		return raw.replaceAll(/[^a-zA-Z0-9_.-]/gu, "-").slice(0, 120);
	}

	private updateState(
		state: SandboxSessionState["state"],
		failure?: SandboxFailure,
	): void {
		this.mutableState = {
			...this.mutableState,
			state,
			updatedAt: this.now().toISOString(),
			...(failure == null ? {} : { lastFailure: failure }),
		};
	}
}

export async function runDockerSandboxCli(
	args: readonly string[],
	options: DockerSandboxCliRunOptions = {},
): Promise<DockerSandboxCliResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(options.dockerBinary ?? "docker", [...args], {
			signal: options.signal,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let outputTruncated = false;
		let settled = false;

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			const appended = appendLimitedOutput(
				stdout,
				chunk,
				outputBytes,
				options.maxOutputBytes,
			);
			stdout = appended.output;
			outputBytes = appended.bytes;
			if (appended.truncated) {
				outputTruncated = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr?.on("data", (chunk) => {
			const appended = appendLimitedOutput(
				stderr,
				chunk,
				outputBytes,
				options.maxOutputBytes,
			);
			stderr = appended.output;
			outputBytes = appended.bytes;
			if (appended.truncated) {
				outputTruncated = true;
				child.kill("SIGKILL");
			}
		});
		child.on("error", (error) => {
			if (!settled) {
				settled = true;
				rejectPromise(error);
			}
		});
		child.on("close", (code) => {
			if (!settled) {
				settled = true;
				resolvePromise({ exitCode: code, outputTruncated, stderr, stdout });
			}
		});
	});
}

function appendLimitedOutput(
	currentOutput: string,
	chunk: unknown,
	currentBytes: number,
	maxOutputBytes: number | undefined,
): {
	readonly bytes: number;
	readonly output: string;
	readonly truncated: boolean;
} {
	const limit = maxOutputBytes ?? Number.POSITIVE_INFINITY;
	if (currentBytes >= limit) {
		return { bytes: currentBytes, output: currentOutput, truncated: true };
	}

	const buffer = Buffer.from(String(chunk));
	const remaining = limit - currentBytes;
	if (buffer.byteLength <= remaining) {
		return {
			bytes: currentBytes + buffer.byteLength,
			output: `${currentOutput}${String(chunk)}`,
			truncated: false,
		};
	}

	const sliceLength = Math.max(0, Math.floor(remaining));
	return {
		bytes: limit,
		output: `${currentOutput}${buffer.subarray(0, sliceLength).toString("utf8")}`,
		truncated: true,
	};
}

function traceIdForCreateRequest(
	request: SandboxCreateRequest,
	sessionId: string,
): string {
	return (
		request.owner.runId ??
		request.owner.taskId ??
		`sandbox-session:${sessionId}`
	);
}

function maxOutputBytes(policy: SandboxResourcePolicy): number {
	return Math.max(
		policy.stdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		policy.stderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
	);
}

function resourceArgs(policy: SandboxResourcePolicy): string[] {
	const args: string[] = [
		"--memory",
		`${policy.memoryMb ?? DEFAULT_MEMORY_MB}m`,
		"--memory-swap",
		`${policy.memorySwapMb ?? policy.memoryMb ?? DEFAULT_MEMORY_MB}m`,
		"--pids-limit",
		String(policy.processCount ?? DEFAULT_PROCESS_COUNT),
	];
	if (policy.cpuCount != null) {
		args.push("--cpus", String(policy.cpuCount));
	}
	return args;
}

function networkArgs(
	policy: SandboxNetworkPolicy,
	allowDebugBridgeNetwork: boolean,
): string[] {
	if (policy.mode === "none") {
		return ["--network", "none"];
	}
	if (policy.mode === "debug-bridge" && allowDebugBridgeNetwork) {
		return ["--network", "bridge"];
	}
	/* v8 ignore next 2 -- prepareForExecution denies unsupported policies before Docker args are built. */
	throw new TypeError("Unsupported Docker sandbox network policy.");
}

function failureForNetworkPolicy(
	policy: SandboxNetworkPolicy,
	traceId: string,
	auditRef: string,
	allowDebugBridgeNetwork: boolean,
): SandboxFailure | undefined {
	if (policy.mode === "none") {
		return undefined;
	}
	if (policy.mode === "debug-bridge" && allowDebugBridgeNetwork) {
		return undefined;
	}
	return createSandboxFailure({
		kind: "network_denied",
		code:
			policy.mode === "allowlist"
				? "docker_network_allowlist_unsupported"
				: "docker_debug_bridge_requires_explicit_opt_in",
		message:
			"DockerSandboxRouter failed closed for unsupported network policy.",
		provider: "docker",
		phase: "execute",
		traceId,
		auditRef,
		retryable: false,
	});
}

function mountArgs(mount: SandboxMountSpec): string[] {
	if (mount.hostPath == null) {
		return [];
	}
	return [
		"--mount",
		[
			"type=bind",
			`src=${mount.hostPath}`,
			`dst=${mount.sandboxPath}`,
			...(mount.access === "readonly" ? ["readonly"] : []),
		].join(","),
	];
}

function defaultSandboxCwd(mounts: readonly SandboxMountSpec[]): string {
	return (
		mounts.find((mount) => mount.kind === "task")?.sandboxPath ??
		mounts.find((mount) => mount.access === "readwrite")?.sandboxPath ??
		"/workspace"
	);
}

function envArgs(env: Readonly<Record<string, string>> | undefined): string[] {
	if (env == null) {
		return [];
	}
	return Object.entries(env).flatMap(([name, value]) => [
		"--env",
		`${name}=${value}`,
	]);
}

function outputArtifactsMount(
	mounts: readonly SandboxMountSpec[],
	policy: SandboxOutputPolicy,
): SandboxMountSpec | undefined {
	return mounts.find((mount) => mount.sandboxPath === policy.artifactsPath);
}

function outputArtifactsDir(policy: SandboxCreateRequest): string | undefined {
	return outputArtifactsMount(policy.mounts, policy.outputPolicy)?.hostPath;
}

function artifactsForPolicy(
	policy: SandboxCreateRequest,
): readonly SandboxArtifactRef[] {
	const artifactsDir = outputArtifactsDir(policy);
	if (artifactsDir == null) {
		return [];
	}
	return [
		{
			path: artifactsDir,
			promoted: true,
		},
	];
}

function commandFailureForResult(input: {
	readonly provider: SandboxProviderKind;
	readonly exitCode: number | null;
	readonly outputTruncated: boolean;
	readonly stderr: string;
	readonly traceId: string;
	readonly auditRef: string;
}): SandboxFailure | undefined {
	if (input.outputTruncated) {
		return createSandboxFailure({
			kind: "output_truncated",
			code: "sandbox_output_truncated",
			message: "Docker sandbox command output exceeded configured limits.",
			provider: input.provider,
			phase: "execute",
			traceId: input.traceId,
			auditRef: input.auditRef,
			commandExitCode: input.exitCode,
			stderrPreview: preview(input.stderr),
		});
	}
	if (input.exitCode !== 0) {
		return createSandboxFailure({
			kind: "command_failed",
			code: "sandbox_command_failed",
			message: "Docker sandbox command failed.",
			provider: input.provider,
			phase: "execute",
			traceId: input.traceId,
			auditRef: input.auditRef,
			commandExitCode: input.exitCode,
			stderrPreview: preview(input.stderr),
		});
	}
	return undefined;
}

function installCommand(
	input: SandboxInstallInput,
): readonly string[] | undefined {
	if (input.packages.length === 0) {
		return ["true"];
	}
	switch (input.manager) {
		case "npm":
			return ["npm", "install", ...input.packages];
		case "pnpm":
			return ["pnpm", "add", ...input.packages];
		case "pip":
			return ["pip", "install", ...input.packages];
		case "uv":
			return ["uv", "pip", "install", ...input.packages];
		case "apt":
			return [
				"/bin/sh",
				"-lc",
				`apt-get update && apt-get install -y ${input.packages.map(shellQuote).join(" ")}`,
			];
		default:
			return undefined;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function preview(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed.slice(0, 2048);
}

function metricsSince(startedAt: Date, completedAt: Date) {
	return {
		startedAt: startedAt.toISOString(),
		completedAt: completedAt.toISOString(),
		durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
