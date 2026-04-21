import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { estimateTokens } from "../context/tokens.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import type {
	LoadedSkill,
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
}

interface RootEntry {
	readonly source: SkillSource;
	readonly path: string;
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
	private readonly changeListeners = new Set<() => void>();
	private recentSkillNames: readonly string[] = [];
	private loadedSkillByName = new Map<string, LoadedSkill>();

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
	}

	async discover(): Promise<readonly SkillDescriptor[]> {
		const previousOrder = this.discoveryOrder.join(",");
		const previousDescriptors = this.discoveryOrder
			.map((name) => {
				const descriptor = this.descriptorByName.get(name);
				return descriptor == null
					? name
					: `${descriptor.name}:${descriptor.path}:${descriptor.source}`;
			})
			.join(",");
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
		const nextOrder = order.join(",");
		const nextDescriptors = order
			.map((name) => {
				const descriptor = byName.get(name) as SkillDescriptor;
				return `${descriptor.name}:${descriptor.path}:${descriptor.source}`;
			})
			.join(",");
		if (
			previousOrder !== nextOrder ||
			previousDescriptors !== nextDescriptors
		) {
			for (const listener of this.changeListeners) {
				listener();
			}
		}
		return order.map((name) => byName.get(name) as SkillDescriptor);
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
			...this.recentSkillNames.filter((entry) => entry !== skill.descriptor.name),
		].slice(0, maxEntries);
	}

	getRecentSkillNames(): readonly string[] {
		return this.recentSkillNames;
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

	onCatalogChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}
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
