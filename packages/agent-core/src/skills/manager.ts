import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSkillMarkdown } from "./frontmatter.js";
import type { LoadedSkill, SkillDescriptor, SkillSource } from "./types.js";

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

export class SkillsManager {
	private readonly roots: readonly RootEntry[];
	private descriptorByName: Map<string, SkillDescriptor> = new Map();
	private discoveryOrder: readonly string[] = [];

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
					descriptor = {
						name: frontmatter.name,
						description: frontmatter.description,
						path: skillPath,
						source,
						frontmatter,
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

	async load(name: string): Promise<LoadedSkill> {
		const descriptor = this.descriptorByName.get(name);
		if (descriptor == null) {
			throw new Error(`Skill not found: ${name}`);
		}

		const content = await readFile(descriptor.path, "utf8");
		const { body } = parseSkillMarkdown(content);
		return {
			descriptor,
			body,
			tokenEstimate: Math.max(1, Math.ceil(body.length / 4)),
		};
	}
}

async function safeReaddir(path: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
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
