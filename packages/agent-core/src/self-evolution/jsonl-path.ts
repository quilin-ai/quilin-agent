import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface JsonlPersistencePathOptions {
	readonly dataRoot?: string;
	readonly filePath: string;
}

export interface SafeJsonlPersistencePath {
	readonly dataRoot: string;
	readonly filePath: string;
}

function assertNonEmptyPath(value: string | undefined, field: string): string {
	const trimmed = value?.trim() ?? "";
	if (trimmed.length === 0) {
		throw new TypeError(`${field} must be a non-empty path`);
	}
	return trimmed;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
	const pathRelative = relative(rootPath, targetPath);
	return (
		pathRelative === "" ||
		(!pathRelative.startsWith("..") && !isAbsolute(pathRelative))
	);
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertJsonlFilePath(filePath: string): void {
	if (!/\.jsonl$/iu.test(filePath)) {
		throw new TypeError("JSONL persistence filePath must end with .jsonl");
	}
}

async function ensureParentDirWithinRoot(
	safePath: SafeJsonlPersistencePath,
): Promise<string> {
	await mkdir(safePath.dataRoot, { recursive: true });
	const resolvedRoot = await realpath(safePath.dataRoot);
	const parentDir = dirname(safePath.filePath);
	const relativeParentDir = relative(safePath.dataRoot, parentDir);
	const segments =
		relativeParentDir === ""
			? []
			: relativeParentDir.split(/[\\/]+/u).filter((segment) => segment !== "");
	let currentPath = safePath.dataRoot;

	for (const segment of segments) {
		currentPath = join(currentPath, segment);
		try {
			const stats = await lstat(currentPath);
			if (stats.isSymbolicLink()) {
				throw new Error("JSONL persistence parent path cannot be a symlink");
			}
			if (!stats.isDirectory()) {
				throw new Error("JSONL persistence parent path must be a directory");
			}
		} catch (error) {
			if (!isNotFound(error)) {
				throw error;
			}
			await mkdir(currentPath);
		}

		const resolvedCurrentPath = await realpath(currentPath);
		if (!isWithinRoot(resolvedCurrentPath, resolvedRoot)) {
			throw new Error("JSONL persistence path resolves outside dataRoot");
		}
	}

	return resolvedRoot;
}

export function resolveJsonlPersistencePath(
	options: JsonlPersistencePathOptions,
): SafeJsonlPersistencePath {
	const requestedFilePath = assertNonEmptyPath(
		options.filePath,
		"JSONL persistence filePath",
	);
	if (options.dataRoot == null && !isAbsolute(requestedFilePath)) {
		throw new TypeError(
			"JSONL persistence dataRoot is required when filePath is relative",
		);
	}

	const dataRoot = resolve(
		assertNonEmptyPath(
			options.dataRoot ?? dirname(requestedFilePath),
			"JSONL persistence dataRoot",
		),
	);
	const filePath = isAbsolute(requestedFilePath)
		? resolve(requestedFilePath)
		: resolve(join(dataRoot, requestedFilePath));

	assertJsonlFilePath(filePath);
	if (!isWithinRoot(filePath, dataRoot)) {
		throw new TypeError(
			"JSONL persistence filePath must resolve within dataRoot",
		);
	}

	return {
		dataRoot,
		filePath,
	};
}

export async function ensureJsonlPersistencePath(
	safePath: SafeJsonlPersistencePath,
	mode: "read" | "write",
): Promise<boolean> {
	if (mode === "write") {
		const resolvedRoot = await ensureParentDirWithinRoot(safePath);

		try {
			const stats = await lstat(safePath.filePath);
			if (stats.isSymbolicLink()) {
				throw new Error("JSONL persistence filePath cannot be a symlink");
			}
			const resolvedFilePath = await realpath(safePath.filePath);
			if (!isWithinRoot(resolvedFilePath, resolvedRoot)) {
				throw new Error("JSONL persistence filePath resolves outside dataRoot");
			}
		} catch (error) {
			if (!isNotFound(error)) {
				throw error;
			}
		}

		return true;
	}

	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(safePath.dataRoot);
	} catch (error) {
		if (isNotFound(error)) {
			return false;
		}
		throw error;
	}

	try {
		const stats = await lstat(safePath.filePath);
		if (stats.isSymbolicLink()) {
			throw new Error("JSONL persistence filePath cannot be a symlink");
		}
		const resolvedFilePath = await realpath(safePath.filePath);
		if (!isWithinRoot(resolvedFilePath, resolvedRoot)) {
			throw new Error("JSONL persistence filePath resolves outside dataRoot");
		}
		return true;
	} catch (error) {
		if (isNotFound(error)) {
			return false;
		}
		throw error;
	}
}
