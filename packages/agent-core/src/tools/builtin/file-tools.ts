import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ToolResult } from "../types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

const DEFAULT_MAX_CHARS = 32_768;
const SENSITIVE_FILE_PATTERNS = [
	/^\.env(\..+)?$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/\.pem$/i,
	/\.key$/i,
];

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

function createErrorResult(toolCallId: string, message: string): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify({ error: message }),
		isError: true,
	};
}

function isSensitivePath(filePath: string): boolean {
	const name = basename(filePath);
	return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function toAbsolutePath(filePath: string): string {
	return resolve(filePath);
}

function formatNumberedLines(content: string, offset = 0, limit?: number): string[] {
	const rawLines = content.replace(/\r\n/g, "\n").split("\n");
	const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines;
	const sliced = lines.slice(offset, limit == null ? undefined : offset + limit);

	return sliced.map((line, index) => `${offset + index + 1}: ${line}`);
}

function truncateFormattedLines(
	lines: readonly string[],
	maxChars: number,
	offset = 0,
): { readonly content: string; readonly truncated: boolean } {
	let rawBudget = 0;
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const colonIndex = lines[index].indexOf(": ");
		const rawLine =
			colonIndex === -1 ? lines[index] : lines[index].slice(colonIndex + 2);
		const rawLength = rawLine.length + 1;

		if (rawBudget + rawLength > maxChars) {
			const nextLineNumber = offset + index + 1;
			const ellipsisLine = `${nextLineNumber}: ...`;
			return {
				content:
					kept.length === 0 ? ellipsisLine : `${kept.join("\n")}\n${ellipsisLine}`,
				truncated: true,
			};
		}

		kept.push(lines[index]);
		rawBudget += rawLength;
	}

	return {
		content: kept.join("\n"),
		truncated: false,
	};
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regex = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${regex}$`);
}

export interface FileReadToolOptions {
	readonly maxChars?: number;
}

export function createFileReadTool(
	options: FileReadToolOptions = {},
): ToolWithMetadata {
	return {
		name: "file_read",
		description: "Read a file with numbered lines.",
		parameters: z.object({
			path: z.string(),
			offset: z.number().int().min(0).optional(),
			limit: z.number().int().min(1).optional(),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args) => {
			const { path, offset = 0, limit } = args as {
				path: string;
				offset?: number;
				limit?: number;
			};
			const absolutePath = toAbsolutePath(path);

			if (isSensitivePath(absolutePath)) {
				return createErrorResult(
					"builtin-file-read",
					`Reading sensitive file is not allowed: ${basename(absolutePath)}`,
				);
			}

			try {
				const fileContent = await readFile(absolutePath, "utf8");
				const numberedLines = formatNumberedLines(fileContent, offset, limit);
				const { content, truncated } = truncateFormattedLines(
					numberedLines,
					options.maxChars ?? DEFAULT_MAX_CHARS,
					offset,
				);

				return createSuccessResult("builtin-file-read", {
					path: absolutePath,
					content,
					truncated,
				});
			} catch (error) {
				return createErrorResult(
					"builtin-file-read",
					error instanceof Error ? error.message : "Failed to read file",
				);
			}
		},
	};
}

export function createFileWriteTool(): ToolWithMetadata {
	return {
		name: "file_write",
		description: "Write utf-8 content to a file.",
		parameters: z.object({
			path: z.string(),
			content: z.string(),
		}),
		category: "programmatic",
		riskLevel: "write",
		execute: async (args) => {
			const { path, content } = args as {
				path: string;
				content: string;
			};
			const absolutePath = toAbsolutePath(path);

			try {
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, content, "utf8");
				return createSuccessResult("builtin-file-write", {
					path: absolutePath,
					bytesWritten: Buffer.byteLength(content, "utf8"),
				});
			} catch (error) {
				return createErrorResult(
					"builtin-file-write",
					error instanceof Error ? error.message : "Failed to write file",
				);
			}
		},
	};
}

export function createFileListTool(): ToolWithMetadata {
	return {
		name: "file_list",
		description: "List directory entries with optional glob filtering.",
		parameters: z.object({
			path: z.string(),
			pattern: z.string().optional(),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args) => {
			const { path, pattern } = args as {
				path: string;
				pattern?: string;
			};
			const absolutePath = toAbsolutePath(path);
			const matcher = pattern == null ? null : globToRegExp(pattern);

			try {
				const entries = await readdir(absolutePath, { withFileTypes: true });
				const filtered = entries
					.filter((entry) => matcher == null || matcher.test(entry.name))
					.map((entry) => ({
						name: entry.name,
						path: join(absolutePath, entry.name),
						type: entry.isDirectory() ? "directory" : "file",
					}))
					.sort((left, right) => left.name.localeCompare(right.name));

				return createSuccessResult("builtin-file-list", {
					path: absolutePath,
					entries: filtered,
				});
			} catch (error) {
				return createErrorResult(
					"builtin-file-list",
					error instanceof Error ? error.message : "Failed to list directory",
				);
			}
		},
	};
}
