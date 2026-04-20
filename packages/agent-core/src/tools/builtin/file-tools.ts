import {
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { z } from "zod";
import {
	WriteAuthority,
	type WriteOrigin,
} from "../../safety/write-authority.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_CHARS = 32_768;
const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;
const ACCESS_DENIED_MESSAGE = "Path not accessible";
const BASENAME_SENSITIVE_FILE_PATTERNS = [
	/^\.env(\..+)?$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/\.pem$/i,
	/\.key$/i,
];
const SYSTEM_SENSITIVE_EXACT_PATHS = ["/etc/shadow", "/etc/passwd", "/etc/sudoers"];
const SYSTEM_SENSITIVE_PREFIXES = ["/root"];

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

function normalizePath(filePath: string): string {
	return resolve(filePath).replaceAll("\\", "/");
}

function isSystemSensitivePath(filePath: string): boolean {
	const normalizedPath = normalizePath(filePath);
	return (
		SYSTEM_SENSITIVE_EXACT_PATHS.some(
			(sensitivePath) => normalizedPath === normalizePath(sensitivePath),
		) ||
		SYSTEM_SENSITIVE_PREFIXES.some((prefix) => {
			const normalizedPrefix = normalizePath(prefix);
			return (
				normalizedPath === normalizedPrefix ||
				normalizedPath.startsWith(`${normalizedPrefix}/`)
			);
		})
	);
}

function getHomePath(): string {
	return process.env.HOME ?? homedir();
}

async function resolvePathIfPossible(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch {
		return filePath;
	}
}

async function isSensitivePath(filePath: string): Promise<boolean> {
	const normalizedPath = normalizePath(filePath);
	const homePath = normalizePath(await resolvePathIfPossible(getHomePath()));
	const fileName = basename(normalizedPath);

	if (BASENAME_SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
		return true;
	}

	const exactSensitivePaths = [
		join(homePath, ".aws", "credentials"),
		join(homePath, ".aws", "config"),
		join(homePath, ".kube", "config"),
		join(homePath, ".npmrc"),
		join(homePath, ".pypirc"),
		join(homePath, ".netrc"),
		join(homePath, ".gitconfig"),
	].map(normalizePath);

	if (exactSensitivePaths.includes(normalizedPath)) {
		return true;
	}

	const sensitiveDirectoryPrefixes = [
		join(homePath, ".gcloud"),
		join(homePath, ".azure"),
	].map(normalizePath);
	if (
		sensitiveDirectoryPrefixes.some(
			(prefix) =>
				normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
		)
	) {
		return true;
	}

	const sshDirectory = normalizePath(join(homePath, ".ssh"));
	if (
		normalizedPath.startsWith(`${sshDirectory}/`) &&
		(fileName === "authorized_keys" ||
			/^id_.+/i.test(fileName) ||
			/.+_key(?:\.pub)?$/i.test(fileName))
	) {
		return true;
	}

	return false;
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
	let renderedBudget = 0;
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const formattedLine = lines[index];
		const renderedLength = formattedLine.length + (kept.length === 0 ? 0 : 1);

		if (renderedBudget + renderedLength > maxChars) {
			const nextLineNumber = offset + index + 1;
			const ellipsisLine = `${nextLineNumber}: ...`;
			const content =
				kept.length === 0 ? ellipsisLine : `${kept.join("\n")}\n${ellipsisLine}`;
			return {
				content: content.slice(0, maxChars),
				truncated: true,
			};
		}

		kept.push(formattedLine);
		renderedBudget += renderedLength;
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

async function resolveAllowedRoots(
	allowedRoots: readonly string[] | undefined,
): Promise<readonly string[]> {
	const roots = allowedRoots == null || allowedRoots.length === 0
		? [process.cwd()]
		: [...allowedRoots];

	return Promise.all(
		roots.map(async (root) => {
			const absoluteRoot = resolve(root);
			return await realpath(absoluteRoot);
		}),
	);
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
	const pathRelative = relative(rootPath, targetPath);
	return (
		pathRelative === "" ||
		(!pathRelative.startsWith("..") && !isAbsolute(pathRelative))
	);
}

async function resolveSandboxedPath(
	filePath: string,
	allowedRoots: readonly string[] | undefined,
	mode: "read" | "write" | "list",
): Promise<{ readonly absolutePath: string; readonly resolvedPath: string }> {
	const absolutePath = toAbsolutePath(filePath);
	if (isSystemSensitivePath(absolutePath)) {
		throw new Error(ACCESS_DENIED_MESSAGE);
	}
	let resolvedPath: string;

	try {
		resolvedPath = await realpath(absolutePath);
	} catch (error) {
		const fsError = error as NodeJS.ErrnoException;
		if (mode !== "write" || fsError.code !== "ENOENT") {
			throw new Error(ACCESS_DENIED_MESSAGE);
		}

		let resolvedParent: string;
		try {
			resolvedParent = await realpath(dirname(absolutePath));
		} catch {
			throw new Error(ACCESS_DENIED_MESSAGE);
		}
		resolvedPath = join(resolvedParent, basename(absolutePath));
	}

	const resolvedRoots = await resolveAllowedRoots(allowedRoots);
	if (!resolvedRoots.some((rootPath) => isWithinRoot(resolvedPath, rootPath))) {
		throw new Error(ACCESS_DENIED_MESSAGE);
	}

	return { absolutePath, resolvedPath };
}

export interface FileReadToolOptions {
	readonly maxChars?: number;
	readonly allowedRoots?: readonly string[];
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

			try {
				const { absolutePath, resolvedPath } = await resolveSandboxedPath(
					path,
					options.allowedRoots,
					"read",
				);

				if (await isSensitivePath(resolvedPath)) {
					return createErrorResult(
						"builtin-file-read",
						`Reading sensitive file is not allowed: ${basename(resolvedPath)}`,
					);
				}

				const fileContent = await readFile(resolvedPath, "utf8");
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

export interface FileWriteToolOptions {
	readonly allowedRoots?: readonly string[];
	readonly maxBytes?: number;
	readonly authority?: WriteAuthority;
	readonly origin?: WriteOrigin;
}

export function createFileWriteTool(
	options: FileWriteToolOptions = {},
): ToolWithMetadata {
	const authority = options.authority ?? new WriteAuthority();

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

			try {
				const { absolutePath, resolvedPath } = await resolveSandboxedPath(
					path,
					options.allowedRoots,
					"write",
				);
				const pathIsSensitive = await isSensitivePath(resolvedPath);
				if (pathIsSensitive) {
					return createErrorResult(
						"builtin-file-write",
						`Writing sensitive file is not allowed: ${basename(resolvedPath)}`,
					);
				}
				const writeDecision = await authority.authorize({
					tool: "file_write",
					riskLevel: "medium",
					summary: `Write ${absolutePath}`,
					detail: resolvedPath,
					origin: options.origin ?? "agent",
				});
				if (writeDecision.kind !== "allow") {
					return createErrorResult("builtin-file-write", writeDecision.reason);
				}
				const bytesWritten = Buffer.byteLength(content, "utf8");

				const maxBytes = options.maxBytes ?? DEFAULT_MAX_WRITE_BYTES;
				if (bytesWritten > maxBytes) {
					return createErrorResult(
						"builtin-file-write",
						`Content exceeds maxBytes limit: ${bytesWritten} > ${maxBytes}`,
					);
				}

				await mkdir(dirname(resolvedPath), { recursive: true });
				const tempPath = `${resolvedPath}.tmp-${crypto.randomUUID()}`;
				try {
					await writeFile(tempPath, content, "utf8");
					await rename(tempPath, resolvedPath);
				} catch (error) {
					await rm(tempPath, { force: true });
					throw error;
				}
				return createSuccessResult("builtin-file-write", {
					path: absolutePath,
					bytesWritten,
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

export interface FileListToolOptions {
	readonly allowedRoots?: readonly string[];
}

export function createFileListTool(
	options: FileListToolOptions = {},
): ToolWithMetadata {
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
			const matcher = pattern == null ? null : globToRegExp(pattern);

			try {
				const { absolutePath, resolvedPath } = await resolveSandboxedPath(
					path,
					options.allowedRoots,
					"list",
				);

				if (await isSensitivePath(resolvedPath)) {
					return createErrorResult(
						"builtin-file-list",
						`Listing sensitive path is not allowed: ${basename(resolvedPath)}`,
					);
				}

				const entries = await readdir(resolvedPath, { withFileTypes: true });
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
