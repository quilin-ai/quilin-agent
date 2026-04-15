import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolResult } from "../types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 10_240;
const execAsync = promisify(exec);

interface ShellRunnerResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

export interface ShellRunnerOptions {
	readonly cwd?: string;
	readonly timeoutMs: number;
}

export type ShellRunner = (
	command: string,
	options: ShellRunnerOptions,
) => Promise<ShellRunnerResult>;

function createSuccessResult(
	toolCallId: string,
	payload: Record<string, unknown>,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify(payload),
		isError: false,
	};
}

function createErrorResult(
	toolCallId: string,
	payload: Record<string, unknown>,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify(payload),
		isError: true,
	};
}

function truncateText(
	text: string,
	maxChars: number,
): { readonly value: string; readonly truncated: boolean } {
	if (text.length <= maxChars) {
		return { value: text, truncated: false };
	}

	if (maxChars <= 3) {
		return {
			value: ".".repeat(Math.max(maxChars, 0)),
			truncated: true,
		};
	}

	return {
		value: `${text.slice(0, maxChars - 3)}...`,
		truncated: true,
	};
}

async function defaultShellRunner(
	command: string,
	options: ShellRunnerOptions,
): Promise<ShellRunnerResult> {
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			shell: process.env.SHELL ?? "/bin/sh",
			maxBuffer: 1024 * 1024,
		});

		return {
			stdout,
			stderr,
			exitCode: 0,
			timedOut: false,
		};
	} catch (error) {
		if (error instanceof Error) {
			const shellError = error as Error & {
				code?: number | string;
				stdout?: string;
				stderr?: string;
				killed?: boolean;
				signal?: string;
			};

			return {
				stdout: shellError.stdout ?? "",
				stderr: shellError.stderr || shellError.message,
				exitCode:
					typeof shellError.code === "number" ? shellError.code : null,
				timedOut:
					shellError.killed === true && shellError.signal === "SIGTERM",
			};
		}

		return {
			stdout: "",
			stderr: "Shell execution failed",
			exitCode: null,
			timedOut: false,
		};
	}
}

export interface ShellExecToolOptions {
	readonly runner?: ShellRunner;
	readonly defaultTimeoutMs?: number;
	readonly maxOutputChars?: number;
}

export function createShellExecTool(
	options: ShellExecToolOptions = {},
): ToolWithMetadata {
	return {
		name: "shell_exec",
		description: "Execute a shell command with timeout and output capture.",
		parameters: z.object({
			command: z.string(),
			cwd: z.string().optional(),
			timeoutMs: z.number().int().min(1).optional(),
		}),
		category: "programmatic",
		riskLevel: "exec",
		timeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
		execute: async (args) => {
			const { command, cwd, timeoutMs } = args as {
				command: string;
				cwd?: string;
				timeoutMs?: number;
			};
			const runner = options.runner ?? defaultShellRunner;
			const result = await runner(command, {
				cwd,
				timeoutMs: timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
			});
			const stdout = truncateText(
				result.stdout,
				options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
			);
			const stderr = truncateText(
				result.stderr,
				options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
			);
			const truncated = stdout.truncated || stderr.truncated;

			if (result.timedOut) {
				return createErrorResult("builtin-shell-exec", {
					error: `Command timed out: ${command}`,
				});
			}

			if ((result.exitCode ?? 0) !== 0) {
				return createErrorResult("builtin-shell-exec", {
					error: stderr.value || `Command failed: ${command}`,
					exitCode: result.exitCode,
				});
			}

			return createSuccessResult("builtin-shell-exec", {
				command,
				exitCode: result.exitCode ?? 0,
				stdout: stdout.value,
				stderr: stderr.value,
				truncated,
			});
		},
	};
}
