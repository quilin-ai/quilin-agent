/**
 * Obsidian vault detector
 *
 * 探测层（detection layer）：扫描常见路径 + 用户指定路径，列出可能的
 * Obsidian vault（用 `.obsidian/` 标记目录识别），返回 vault 路径 + 大小
 * + 最近修改时间。**不读取笔记内容、不写记忆**。
 *
 * Detection layer: scan common paths plus user-specified paths and list
 * candidate Obsidian vaults (identified by the marker `.obsidian/` directory),
 * returning vault path, size, and last-modified timestamp. Does not read
 * note content, does not write to memory.
 */

export interface VaultProbe {
	readonly path: string;
	readonly sizeBytes: number;
	readonly lastModified: Date;
	readonly noteCount: number;
}

export interface VaultFileEntry {
	readonly path: string;
	readonly sizeBytes: number;
	readonly modifiedAt: Date;
	readonly isMarkdown: boolean;
}

export interface VaultEvidence {
	readonly hasObsidianConfigDir: boolean;
	readonly files: readonly VaultFileEntry[];
}

export interface DetectObsidianVaultsOptions {
	/** Home directory (used to build default candidate paths). */
	readonly homeDir: string;
	/** Extra candidate vault paths supplied by the user / config. */
	readonly extraPaths?: readonly string[];
	/**
	 * Probe a single candidate path. Should return null if the path is not a
	 * directory or cannot be read.
	 */
	readonly probeCandidate: (
		candidatePath: string,
	) => Promise<VaultEvidence | null>;
}

/**
 * Build the default candidate path list. Common locations on macOS / Linux
 * where users keep their Obsidian vaults.
 */
export function defaultCandidatePaths(homeDir: string): readonly string[] {
	const trimmed = stripTrailingSlash(homeDir);
	return Object.freeze([
		`${trimmed}/Documents/Obsidian`,
		`${trimmed}/Documents/Obsidian Vault`,
		`${trimmed}/Obsidian`,
		`${trimmed}/Notes`,
		`${trimmed}/iCloud/Obsidian`,
		`${trimmed}/.config/obsidian`,
	]);
}

/**
 * Scan candidate paths and return the subset that appears to be Obsidian
 * vaults. Per-path probing is injected so tests can use an in-memory map.
 */
export async function detectObsidianVaults(
	options: DetectObsidianVaultsOptions,
): Promise<readonly VaultProbe[]> {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const path of defaultCandidatePaths(options.homeDir)) {
		seen.add(path);
		candidates.push(path);
	}
	for (const path of options.extraPaths ?? []) {
		const normalised = stripTrailingSlash(path);
		if (normalised.length > 0 && !seen.has(normalised)) {
			seen.add(normalised);
			candidates.push(normalised);
		}
	}

	const probes: VaultProbe[] = [];
	for (const candidate of candidates) {
		const evidence = await options.probeCandidate(candidate);
		if (!evidence?.hasObsidianConfigDir) {
			continue;
		}
		probes.push(summariseVault(candidate, evidence));
	}
	return Object.freeze(probes);
}

function summariseVault(path: string, evidence: VaultEvidence): VaultProbe {
	let totalBytes = 0;
	let latest = 0;
	let noteCount = 0;
	for (const file of evidence.files) {
		totalBytes += Math.max(0, file.sizeBytes);
		const stamp = file.modifiedAt.getTime();
		if (Number.isFinite(stamp) && stamp > latest) {
			latest = stamp;
		}
		if (file.isMarkdown) {
			noteCount += 1;
		}
	}
	return {
		path,
		sizeBytes: totalBytes,
		lastModified: new Date(latest),
		noteCount,
	};
}

function stripTrailingSlash(path: string): string {
	if (path.length > 1 && path.endsWith("/")) {
		return path.replace(/\/+$/, "");
	}
	return path;
}
