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
	readonly dockerBinary?: string;
	readonly containerNamePrefix?: string;
	readonly runner?: DockerCliRunner;
}

export interface DockerCliRunOptions {
	readonly signal?: AbortSignal;
	readonly dockerBinary?: string;
}

export interface DockerCliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
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
	const containerNamePrefix = options.containerNamePrefix ?? "quilin-benchmark";

	return {
		runShellCommand: async (input) => {
			const scratchDir = resolve(input.workspaceDir);
			await mkdir(scratchDir, { recursive: true });
			await mkdir(artifactsDir, { recursive: true });

			const containerName = `${containerNamePrefix}-${basename(scratchDir)}-${Date.now()}`;
			const controller = new AbortController();
			let timedOut = false;
			let killPromise: Promise<DockerCliResult> | undefined;
			const effectiveTimeoutMs = input.timeoutMs ?? timeoutMs;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				killPromise = runner(["kill", containerName], { dockerBinary }).catch(
					(error) => ({
						stdout: "",
						stderr: error instanceof Error ? error.message : String(error),
						exitCode: 1,
					}),
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
					}),
					{ dockerBinary, signal: controller.signal },
				);
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
				await killPromise;
			}
		},
	};
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
		let settled = false;

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
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
				resolvePromise({ exitCode: code, stderr, stdout });
			}
		});
	});
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
}): string[] {
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
		"--pids-limit",
		String(input.pidsLimit),
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
		input.command,
	];
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
	return {
		content: JSON.stringify({
			artifactsDir,
			containerName,
			exitCode,
			stderr: result.stderr,
			stdout: result.stdout,
			timedOut,
		}),
		isError: timedOut || exitCode !== 0,
	};
}

function requiredString(value: string, fieldName: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`DockerSandbox requires ${fieldName}`);
	}
	return value;
}
