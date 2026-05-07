import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { estimateTokens } from "../context/tokens.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import type {
	LoadedSkill,
	MergeCandidate,
	PostCompactRestoreEntry,
	PostCompactRestoreResult,
	SkillDescriptor,
	SkillFrontmatter,
	SkillSource,
	SkillTrustLevel,
} from "./types.js";

export interface SkillsManagerOptions {
	readonly bundledRoots?: readonly string[];
	readonly userRoots?: readonly string[];
	readonly projectRoots?: readonly string[];
	readonly pluginRoots?: readonly string[];
	readonly watcherEnabled?: boolean;
	readonly debounceMs?: number;
	readonly watchFactory?: typeof watch;
}

interface RootEntry {
	readonly source: SkillSource;
	readonly path: string;
}

export interface SkillsCatalogChange {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

export interface SkillsReloadSuccessSnapshot {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly catalogSize: number;
	readonly change: SkillsCatalogChange;
}

export interface SkillsReloadFailureSnapshot {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly errorName: string;
	readonly errorMessage: string;
}

export interface SkillsReloadStatus {
	readonly generation: number;
	readonly watching: boolean;
	readonly inFlight: boolean;
	readonly inFlightGenerations: readonly number[];
	readonly lastSuccess: SkillsReloadSuccessSnapshot | null;
	readonly lastFailure: SkillsReloadFailureSnapshot | null;
}

interface LoadSkillOptions {
	readonly maxBodyChars?: number;
	readonly maxBodyBytes?: number;
}

export interface PostCompactRestoreOptions {
	readonly recentSkillNames: readonly string[];
	readonly maxSkills?: number;
	readonly maxSkillTokens?: number;
	readonly maxTotalTokens?: number;
	readonly estimateTokens?: (text: string) => number;
}

export const DEFAULT_MAX_BODY_CHARS = 100_000;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RECENT_SKILL_NAMES = 10;
export const DEFAULT_POST_COMPACT_MAX_SKILLS = 5;
export const DEFAULT_POST_COMPACT_MAX_SKILL_TOKENS = 5_000;
export const DEFAULT_POST_COMPACT_MAX_TOTAL_TOKENS = 25_000;

export class SkillsManager {
	private readonly roots: readonly RootEntry[];
	private descriptorByName: Map<string, SkillDescriptor> = new Map();
	private discoveryOrder: readonly string[] = [];
	private readonly changeListeners = new Set<
		(change: SkillsCatalogChange) => void
	>();
	private recentSkillNames: readonly string[] = [];
	private loadedSkillByName = new Map<string, LoadedSkill>();
	private readonly watcherEnabled: boolean;
	private readonly debounceMs: number;
	private readonly watchFactory: typeof watch;
	private activeWatchers: FSWatcher[] = [];
	private pendingRescanTimer: ReturnType<typeof setTimeout> | null = null;
	private watching = false;
	private reloadGeneration = 0;
	private inFlightReloadGenerations = new Set<number>();
	private lastSuccess: SkillsReloadSuccessSnapshot | null = null;
	private lastFailure: SkillsReloadFailureSnapshot | null = null;

	constructor(options: SkillsManagerOptions) {
		const roots: RootEntry[] = [];
		for (const path of options.projectRoots ?? []) {
			roots.push({ source: "project", path });
		}
		for (const path of options.userRoots ?? []) {
			roots.push({ source: "user", path });
		}
		for (const path of options.pluginRoots ?? []) {
			roots.push({ source: "plugin", path });
		}
		for (const path of options.bundledRoots ?? []) {
			roots.push({ source: "bundled", path });
		}
		this.roots = roots;
		this.watcherEnabled = options.watcherEnabled ?? true;
		this.debounceMs = options.debounceMs ?? 200;
		this.watchFactory = options.watchFactory ?? watch;
	}

	async discover(): Promise<readonly SkillDescriptor[]> {
		const commitGeneration = this.reloadGeneration + 1;
		this.reloadGeneration = commitGeneration;
		this.inFlightReloadGenerations.add(commitGeneration);
		const previousDescriptorsByName = this.descriptorByName;
		try {
			const byName = new Map<string, SkillDescriptor>();
			const order: string[] = [];

			for (const { source, path } of this.roots) {
				const entries = await safeReaddir(path);
				for (const entry of entries) {
					const skillPath = join(path, entry, "SKILL.md");
					const content = await safeReadFile(skillPath);
					if (content == null) {
						continue;
					}

					let descriptor: SkillDescriptor;
					try {
						const { frontmatter } = parseSkillMarkdown(content);
						const normalizedFrontmatter = applySourceTrustDefault(
							frontmatter,
							source,
						);
						descriptor = {
							name: normalizedFrontmatter.name,
							description: normalizedFrontmatter.description,
							path: skillPath,
							source,
							frontmatter: normalizedFrontmatter,
						};
					} catch {
						continue;
					}

					if (byName.has(descriptor.name)) {
						continue;
					}

					byName.set(descriptor.name, descriptor);
					order.push(descriptor.name);
				}
			}

			this.descriptorByName = byName;
			this.discoveryOrder = order;
			this.recentSkillNames = this.recentSkillNames.filter((name) =>
				byName.has(name),
			);
			this.evictUnreferencedLoadedSkills();
			const change = diffCatalog(previousDescriptorsByName, byName);
			this.lastSuccess = {
				generation: commitGeneration,
				completedAtEpochMs: Date.now(),
				catalogSize: byName.size,
				change,
			};
			if (
				change.added.length > 0 ||
				change.removed.length > 0 ||
				change.changed.length > 0
			) {
				for (const listener of this.changeListeners) {
					try {
						listener(change);
					} catch {
						// Listener failures must not break automatic catalog reload.
					}
				}
			}
			return order.map((name) => byName.get(name) as SkillDescriptor);
		} catch (error) {
			this.lastFailure = buildSkillsReloadFailureSnapshot(
				commitGeneration,
				error,
			);
			throw error;
		} finally {
			this.inFlightReloadGenerations.delete(commitGeneration);
		}
	}

	findByName(name: string): SkillDescriptor | undefined {
		return this.descriptorByName.get(name);
	}

	list(): readonly SkillDescriptor[] {
		return this.discoveryOrder.map(
			(name) => this.descriptorByName.get(name) as SkillDescriptor,
		);
	}

	async load(
		name: string,
		options: LoadSkillOptions = {},
	): Promise<LoadedSkill> {
		const descriptor = this.descriptorByName.get(name);
		if (descriptor == null) {
			throw new Error(`Skill not found: ${name}`);
		}

		const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
		const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		const resolvedPath = await realpath(descriptor.path);
		const allowedRoots = await resolveSkillRoots(this.roots);
		if (
			!allowedRoots.some((rootPath) => isWithinRoot(resolvedPath, rootPath))
		) {
			throw new Error("Skill path resolves outside configured roots");
		}

		const fileStats = await stat(resolvedPath);
		if (fileStats.size > maxBodyBytes) {
			throw new Error(
				`Skill body exceeds maxBodyBytes limit: ${fileStats.size} > ${maxBodyBytes}`,
			);
		}

		const content = await readFile(resolvedPath, "utf8");
		const { body } = parseSkillMarkdown(content);
		if (body.length > maxBodyChars) {
			throw new Error(
				`Skill body exceeds maxBodyChars limit: ${body.length} > ${maxBodyChars}`,
			);
		}

		return {
			descriptor,
			body,
			tokenEstimate: Math.max(1, Math.ceil(body.length / 4)),
		};
	}

	recordViewedSkill(
		skill: LoadedSkill,
		maxEntries = DEFAULT_MAX_RECENT_SKILL_NAMES,
	): void {
		this.loadedSkillByName.set(skill.descriptor.name, skill);
		this.recentSkillNames = [
			skill.descriptor.name,
			...this.recentSkillNames.filter(
				(entry) => entry !== skill.descriptor.name,
			),
		].slice(0, maxEntries);
		this.evictUnreferencedLoadedSkills();
	}

	getRecentSkillNames(): readonly string[] {
		return this.recentSkillNames;
	}

	getReloadStatus(): SkillsReloadStatus {
		const inFlightGenerations = Array.from(this.inFlightReloadGenerations).sort(
			(left, right) => left - right,
		);
		return {
			generation: this.reloadGeneration,
			watching: this.watching,
			inFlight: inFlightGenerations.length > 0,
			inFlightGenerations,
			lastSuccess:
				this.lastSuccess == null
					? null
					: {
							...this.lastSuccess,
							change: {
								added: [...this.lastSuccess.change.added],
								removed: [...this.lastSuccess.change.removed],
								changed: [...this.lastSuccess.change.changed],
							},
						},
			lastFailure: this.lastFailure == null ? null : { ...this.lastFailure },
		};
	}

	startWatching(paths?: readonly string[]): void {
		if (!this.watcherEnabled || this.watching) {
			return;
		}

		const watchRoots =
			paths?.filter((path) => path.length > 0) ??
			this.roots
				.filter((root) => root.source === "user" || root.source === "project")
				.map((root) => root.path);
		if (watchRoots.length === 0) {
			return;
		}

		const watchers: FSWatcher[] = [];
		for (const path of watchRoots) {
			try {
				watchers.push(this.createWatcher(path));
			} catch (error) {
				this.lastFailure = buildSkillsReloadFailureSnapshot(
					this.reloadGeneration,
					error,
				);
			}
		}
		this.activeWatchers = watchers;
		this.watching = watchers.length > 0;
	}

	stopWatching(): void {
		if (this.pendingRescanTimer != null) {
			clearTimeout(this.pendingRescanTimer);
			this.pendingRescanTimer = null;
		}
		for (const watcher of this.activeWatchers) {
			watcher.close();
		}
		this.activeWatchers = [];
		this.watching = false;
	}

	postCompactRestore(
		options: PostCompactRestoreOptions,
	): PostCompactRestoreResult {
		const maxSkills = options.maxSkills ?? DEFAULT_POST_COMPACT_MAX_SKILLS;
		const maxSkillTokens =
			options.maxSkillTokens ?? DEFAULT_POST_COMPACT_MAX_SKILL_TOKENS;
		const maxTotalTokens =
			options.maxTotalTokens ?? DEFAULT_POST_COMPACT_MAX_TOTAL_TOKENS;
		const estimate = options.estimateTokens ?? estimateTokens;
		const dedupedRecentNames = Array.from(new Set(options.recentSkillNames));
		const entries: PostCompactRestoreEntry[] = [];
		let totalTokens = 0;

		for (const name of dedupedRecentNames) {
			if (entries.length >= maxSkills) {
				break;
			}

			const descriptor = this.findByName(name);
			const loaded = this.loadedSkillByName.get(name);
			if (descriptor == null || loaded == null) {
				continue;
			}

			const tokenEstimate = estimate(loaded.body);
			if (tokenEstimate > maxSkillTokens) {
				continue;
			}
			if (totalTokens + tokenEstimate > maxTotalTokens) {
				break;
			}

			totalTokens += tokenEstimate;
			entries.push({
				name,
				source: descriptor.source,
				body: loaded.body,
				tokenEstimate,
			});
		}

		return {
			entries,
			totalTokens,
		};
	}

	onCatalogChange(listener: (change: SkillsCatalogChange) => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	detectSimilar(
		skillA: SkillDescriptor,
		skillB: SkillDescriptor,
	): MergeCandidate | null {
		const nameSim = jaccardSimilarity(
			tokenizeText(skillA.name),
			tokenizeText(skillB.name),
		);
		const descSim = jaccardSimilarity(
			tokenizeText(skillA.description),
			tokenizeText(skillB.description),
		);
		const whenSim = jaccardSimilarity(
			tokenizeText(skillA.frontmatter.whenToUse ?? ""),
			tokenizeText(skillB.frontmatter.whenToUse ?? ""),
		);

		const similarity = nameSim * 0.4 + descSim * 0.3 + whenSim * 0.3;
		if (similarity <= 0.8) {
			return null;
		}

		const overlapFields: string[] = [];
		if (nameSim > 0.8) {
			overlapFields.push("name");
		}
		if (descSim > 0.8) {
			overlapFields.push("description");
		}
		if (whenSim > 0.8) {
			overlapFields.push("whenToUse");
		}

		return {
			skillA,
			skillB,
			similarity: Math.round(similarity * 1000) / 1000,
			overlapFields,
		};
	}

	private scheduleRescan(): void {
		if (!this.watching) {
			return;
		}
		if (this.pendingRescanTimer != null) {
			clearTimeout(this.pendingRescanTimer);
		}
		this.pendingRescanTimer = setTimeout(() => {
			this.pendingRescanTimer = null;
			void this.discover().catch(() => undefined);
		}, this.debounceMs);
	}

	private evictUnreferencedLoadedSkills(): void {
		const allowed = new Set(this.recentSkillNames);
		for (const name of this.loadedSkillByName.keys()) {
			if (!allowed.has(name)) {
				this.loadedSkillByName.delete(name);
			}
		}
	}

	private createWatcher(path: string): FSWatcher {
		const onEvent = () => {
			this.scheduleRescan();
		};
		try {
			return this.watchFactory(path, { recursive: true }, onEvent);
		} catch {
			return this.watchFactory(path, {}, onEvent);
		}
	}
}

function buildSkillsReloadFailureSnapshot(
	generation: number,
	error: unknown,
): SkillsReloadFailureSnapshot {
	return {
		generation,
		completedAtEpochMs: Date.now(),
		errorName:
			error instanceof Error
				? error.name
				: typeof error === "string"
					? "Error"
					: "UnknownError",
		errorMessage:
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: "Unknown skills reload failure",
	};
}

function descriptorSignature(descriptor: SkillDescriptor): string {
	return JSON.stringify({
		name: descriptor.name,
		description: descriptor.description,
		path: descriptor.path,
		source: descriptor.source,
		frontmatter: descriptor.frontmatter,
	});
}

function diffCatalog(
	previousByName: ReadonlyMap<string, SkillDescriptor>,
	nextByName: ReadonlyMap<string, SkillDescriptor>,
): SkillsCatalogChange {
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];

	for (const [name, next] of nextByName) {
		const previous = previousByName.get(name);
		if (previous == null) {
			added.push(name);
			continue;
		}
		if (descriptorSignature(previous) !== descriptorSignature(next)) {
			changed.push(name);
		}
	}

	for (const name of previousByName.keys()) {
		if (!nextByName.has(name)) {
			removed.push(name);
		}
	}

	return { added, removed, changed };
}

function applySourceTrustDefault(
	frontmatter: SkillFrontmatter,
	source: SkillSource,
): SkillFrontmatter {
	if (frontmatter.trust != null) {
		return frontmatter;
	}

	const trust = defaultTrustForSource(source);
	return {
		...frontmatter,
		trust,
	};
}

function defaultTrustForSource(source: SkillSource): SkillTrustLevel {
	switch (source) {
		case "bundled":
			return "builtin";
		case "user":
			return "community";
		case "project":
		case "plugin":
			return "community";
	}
}

async function safeReaddir(path: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function safeReadFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function resolveSkillRoots(
	roots: readonly RootEntry[],
): Promise<readonly string[]> {
	const resolvedRoots = await Promise.all(
		roots.map(async ({ path }) => {
			try {
				return await realpath(path);
			} catch {
				return null;
			}
		}),
	);

	return resolvedRoots.filter(
		(rootPath): rootPath is string => rootPath != null,
	);
}

export function isWithinRoot(targetPath: string, rootPath: string): boolean {
	const pathRelative = relative(rootPath, targetPath);
	return (
		pathRelative === "" ||
		(!pathRelative.startsWith("..") && !isAbsolute(pathRelative))
	);
}

function tokenizeText(text: string): readonly string[] {
	const normalized = text.toLowerCase().replaceAll(/[^a-z0-9\s-]/gu, "");
	const tokens = normalized.split(/[\s-]+/u).filter((token) => token.length > 1);
	return [...new Set(tokens)];
}

function jaccardSimilarity(
	tokensA: readonly string[],
	tokensB: readonly string[],
): number {
	if (tokensA.length === 0 && tokensB.length === 0) {
		return 0;
	}

	const setA = new Set(tokensA);
	const setB = new Set(tokensB);
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection += 1;
		}
	}

	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
