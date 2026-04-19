import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 10_240;
const execFileAsync = promisify(execFile);
const ALLOWED_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TERM",
	"USER",
	"SHELL",
	"PWD",
]);

const BLOCKED_COMMAND_PATTERNS: ReadonlyArray<{
	readonly pattern: RegExp;
	readonly reason: string;
}> = [
	{
		pattern: /\brm\s+-rf\s+\/(?:\s|$)/i,
		reason: "destructive filesystem wipe patterns are not allowed",
	},
	{
		pattern: /\bcurl\b[\s\S]*\|\s*(?:sh|bash|zsh|fish|dash)\b/i,
		reason: "shell pipelines into interpreters are not allowed",
	},
	{
		pattern: /\beval\b/i,
		reason: "eval execution is not allowed",
	},
	{
		pattern: /`[^`]*`/,
		reason: "backtick command substitution is not allowed",
	},
	{
		pattern: /\$\([^)]*\)/,
		reason: "command substitution is not allowed",
	},
	{
		pattern: /:\s*\(\)\s*\{\s*:\|\:&\s*;\s*}\s*;/,
		reason: "fork bomb patterns are not allowed",
	},
	{
		pattern: /(?:^|[^\w./-])(?:\|\||&&|;|[|<>])/,
		reason: "shell control operators are not allowed",
	},
];

interface ShellRunnerResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

export interface ShellRunnerOptions {
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly env?: NodeJS.ProcessEnv;
}

export type ShellRunner = (
	executable: string,
	args: readonly string[],
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

function clampTimeoutMs(timeoutMs: number): number {
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
}

function findBlockedCommandReason(command: string): string | undefined {
	return BLOCKED_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))
		?.reason;
}

function tokenizeCommand(command: string): string[] {
	const trimmed = command.trim();
	if (trimmed === "") {
		throw new Error("Command cannot be empty");
	}

	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const character of trimmed) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}

		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}

		if (quote != null) {
			if (character === quote) {
				quote = null;
			} else {
				current += character;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}

		if (/\s/.test(character)) {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += character;
	}

	if (escaped) {
		throw new Error("Command cannot end with an escape character");
	}

	if (quote != null) {
		throw new Error("Command contains an unterminated quoted string");
	}

	if (current !== "") {
		tokens.push(current);
	}

	if (tokens.length === 0) {
		throw new Error("Command cannot be empty");
	}

	return tokens;
}

async function defaultShellRunner(
	executable: string,
	args: readonly string[],
	options: ShellRunnerOptions,
): Promise<ShellRunnerResult> {
	try {
		const { stdout, stderr } = await execFileAsync(executable, [...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 1024 * 1024,
			env: options.env,
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
	readonly env?: NodeJS.ProcessEnv;
}

function buildShellExecEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const baseEntries = Object.entries(process.env).filter(([key, value]) => {
		return value != null && ALLOWED_ENV_KEYS.has(key);
	});

	return {
		...Object.fromEntries(baseEntries),
		...overrides,
	};
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
			const blockedReason = findBlockedCommandReason(command);
			if (blockedReason != null) {
				return createErrorResult("builtin-shell-exec", {
					error: `Command blocked: ${blockedReason}`,
				});
			}

			let executable: string;
			let argv: string[];
			try {
				[executable, ...argv] = tokenizeCommand(command);
			} catch (error) {
				return createErrorResult("builtin-shell-exec", {
					error:
						error instanceof Error ? error.message : "Command parsing failed",
				});
			}

			const runner = options.runner ?? defaultShellRunner;
			const result = await runner(executable, argv, {
				cwd,
				env: buildShellExecEnv(options.env),
				timeoutMs: clampTimeoutMs(
					timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
				),
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
