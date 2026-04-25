import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type {
	BenchmarkSandbox,
	BenchmarkSandboxCommandInput,
} from "../runner/index.js";

export interface DockerSandboxOptions {
	readonly image: string;
	readonly baseDir: string;
	readonly cacheDir: string;
	readonly artifactsDir: string;
	readonly cpus?: number;
	readonly memory?: string;
	readonly pidsLimit?: number;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly dockerBinary?: string;
	readonly containerNamePrefix?: string;
	readonly runner?: DockerCliRunner;
}

export interface DockerCliRunOptions {
	readonly signal?: AbortSignal;
	readonly dockerBinary?: string;
	readonly maxOutputBytes?: number;
}

export interface DockerCliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly outputTruncated?: boolean;
}

export type DockerCliRunner = (
	args: readonly string[],
	options?: DockerCliRunOptions,
) => Promise<DockerCliResult>;

export interface DockerSandboxCommandResult {
	readonly content: string;
	readonly isError: boolean;
}

export interface DockerSandbox extends BenchmarkSandbox {
	readonly runShellCommand: (
		input: BenchmarkSandboxCommandInput,
	) => Promise<DockerSandboxCommandResult>;
}

const defaultCpus = 1;
const defaultMemory = "2g";
const defaultPidsLimit = 512;
const defaultTimeoutMs = 60_000;
const defaultMaxOutputBytes = 16 * 1024 * 1024;
const cleanupTimeoutMs = 1_000;
const workspaceTaskPath = "/workspace/task";
const workspaceBasePath = "/workspace/base";
const workspaceArtifactsPath = "/workspace/artifacts";
const workspaceCachePath = "/workspace/cache";

export function createDockerSandbox(
	options: DockerSandboxOptions,
): DockerSandbox {
	const image = requiredString(options.image, "image");
	const baseDir = resolve(requiredString(options.baseDir, "baseDir"));
	const cacheDir = resolve(requiredString(options.cacheDir, "cacheDir"));
	const artifactsDir = resolve(
		requiredString(options.artifactsDir, "artifactsDir"),
	);
	const runner = options.runner ?? runDockerCli;
	const dockerBinary = options.dockerBinary;
	const cpus = options.cpus ?? defaultCpus;
	const memory = options.memory ?? defaultMemory;
	const pidsLimit = options.pidsLimit ?? defaultPidsLimit;
	const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
	const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
	const containerNamePrefix = options.containerNamePrefix ?? "quilin-benchmark";

	return {
		runShellCommand: async (input) => {
			const scratchDir = resolve(input.workspaceDir);
			await mkdir(scratchDir, { recursive: true });
			await mkdir(artifactsDir, { recursive: true });

			const containerName = `${containerNamePrefix}-${basename(scratchDir)}-${Date.now()}`;
			const controller = new AbortController();
			let timedOut = false;
			let cleanupPromise: Promise<DockerCliResult> | undefined;
			const effectiveTimeoutMs = input.timeoutMs ?? timeoutMs;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				cleanupPromise = forceRemoveContainer(
					runner,
					containerName,
					dockerBinary,
				);
			}, effectiveTimeoutMs);

			try {
				const result = await runner(
					dockerRunArgs({
						artifactsDir,
						baseDir,
						cacheDir,
						command: input.command,
						containerName,
						cpus,
						cwd: input.cwd,
						image,
						memory,
						pidsLimit,
						scratchDir,
						stopTimeoutSeconds: stopTimeoutSeconds(effectiveTimeoutMs),
					}),
					{ dockerBinary, maxOutputBytes, signal: controller.signal },
				);
				if (result.outputTruncated === true) {
					cleanupPromise = forceRemoveContainer(
						runner,
						containerName,
						dockerBinary,
					);
				}
				return shellExecResult(result, false, containerName, artifactsDir);
			} catch (error) {
				if (!timedOut) {
					throw error;
				}
				return shellExecResult(
					{
						stdout: "",
						stderr: error instanceof Error ? error.message : String(error),
						exitCode: null,
					},
					true,
					containerName,
					artifactsDir,
				);
			} finally {
				clearTimeout(timer);
				await cleanupPromise;
			}
		},
	};
}

async function forceRemoveContainer(
	runner: DockerCliRunner,
	containerName: string,
	dockerBinary: string | undefined,
): Promise<DockerCliResult> {
	return Promise.race([
		runner(["rm", "-f", containerName], { dockerBinary }).catch((error) => ({
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: 1,
		})),
		delay(cleanupTimeoutMs).then(() => ({
			stdout: "",
			stderr: "docker rm -f cleanup timed out",
			exitCode: 124,
		})),
	]);
}

export async function hasDocker(
	options: {
		readonly dockerBinary?: string;
		readonly runner?: DockerCliRunner;
		readonly timeoutMs?: number;
	} = {},
): Promise<boolean> {
	const runner = options.runner ?? runDockerCli;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 2_000,
	);
	try {
		const result = await runner(
			["version", "--format", "{{.Server.Version}}"],
			{
				dockerBinary: options.dockerBinary,
				signal: controller.signal,
			},
		);
		return result.exitCode === 0 && result.stdout.trim().length > 0;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function runDockerCli(
	args: readonly string[],
	options: DockerCliRunOptions = {},
): Promise<DockerCliResult> {
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

function dockerRunArgs(input: {
	readonly artifactsDir: string;
	readonly baseDir: string;
	readonly cacheDir: string;
	readonly command: string;
	readonly containerName: string;
	readonly cpus: number;
	readonly cwd: string;
	readonly image: string;
	readonly memory: string;
	readonly pidsLimit: number;
	readonly scratchDir: string;
	readonly stopTimeoutSeconds: number;
}): string[] {
	const commandTimeoutSeconds = input.stopTimeoutSeconds;
	return [
		"run",
		"--rm",
		"--name",
		input.containerName,
		"--network",
		"none",
		"--cpus",
		String(input.cpus),
		"--memory",
		input.memory,
		"--memory-swap",
		input.memory,
		"--pids-limit",
		String(input.pidsLimit),
		"--stop-timeout",
		String(input.stopTimeoutSeconds),
		"--read-only",
		"--mount",
		bindMount(input.baseDir, workspaceBasePath, true),
		"--mount",
		bindMount(input.scratchDir, workspaceTaskPath, false),
		"--mount",
		bindMount(input.artifactsDir, workspaceArtifactsPath, false),
		"--mount",
		bindMount(input.cacheDir, workspaceCachePath, true),
		"-w",
		containerCwd(input.cwd, input.scratchDir),
		input.image,
		"/bin/sh",
		"-lc",
		wrapShellCommandWithTimeout(input.command, commandTimeoutSeconds),
	];
}

function stopTimeoutSeconds(timeoutMs: number): number {
	return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapShellCommandWithTimeout(
	command: string,
	timeoutSeconds: number,
): string {
	const quotedCommand = shellQuote(command);
	return `if command -v timeout >/dev/null 2>&1; then timeout -s KILL ${timeoutSeconds}s /bin/sh -lc ${quotedCommand}; else /bin/sh -lc ${quotedCommand}; fi`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function bindMount(source: string, target: string, readonly: boolean): string {
	return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

function containerCwd(cwd: string, scratchDir: string): string {
	const resolvedCwd = resolve(cwd);
	const resolvedScratchDir = resolve(scratchDir);
	const pathFromScratch = relative(resolvedScratchDir, resolvedCwd);
	if (pathFromScratch === "") {
		return workspaceTaskPath;
	}
	if (pathFromScratch.startsWith("..") || pathFromScratch.startsWith(sep)) {
		return workspaceTaskPath;
	}
	return `${workspaceTaskPath}/${pathFromScratch.split(sep).join("/")}`;
}

function shellExecResult(
	result: DockerCliResult,
	timedOut: boolean,
	containerName: string,
	artifactsDir: string,
): DockerSandboxCommandResult {
	const exitCode = timedOut ? null : result.exitCode;
	const outputTruncated = result.outputTruncated === true;
	return {
		content: JSON.stringify({
			artifactsDir,
			containerName,
			exitCode,
			output_truncated: outputTruncated,
			stderr: result.stderr,
			stdout: result.stdout,
			timedOut,
		}),
		isError: timedOut || outputTruncated || exitCode !== 0,
	};
}

function requiredString(value: string, fieldName: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`DockerSandbox requires ${fieldName}`);
	}
	return value;
}
