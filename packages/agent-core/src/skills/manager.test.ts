import type { WatchListener } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsManager } from "./manager.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-skills-"));
	createdDirs.push(dir);
	return dir;
}

async function writeSkill(
	root: string,
	name: string,
	description: string,
	body: string,
): Promise<void> {
	const skillDir = join(root, name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---
name: ${name}
description: ${description}
---
${body}
`,
		"utf8",
	);
}

async function writeSkillMarkdown(
	root: string,
	name: string,
	markdown: string,
): Promise<void> {
	const skillDir = join(root, name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(join(skillDir, "SKILL.md"), markdown, "utf8");
}

afterEach(async () => {
	await Promise.all(
		createdDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
	);
});

describe("SkillsManager", () => {
	it("discovers skills from bundled/user/project with project priority", async () => {
		const bundledRoot = await createTempDir();
		const userRoot = await createTempDir();
		const projectRoot = await createTempDir();

		await writeSkill(bundledRoot, "shared-skill", "bundled copy", "# bundled");
		await writeSkill(userRoot, "shared-skill", "user copy", "# user");
		await writeSkill(projectRoot, "shared-skill", "project copy", "# project");
		await writeSkill(userRoot, "user-only", "user skill", "# user-only");

		const manager = new SkillsManager({
			bundledRoots: [bundledRoot],
			userRoots: [userRoot],
			projectRoots: [projectRoot],
		});

		const descriptors = await manager.discover();

		expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
			"shared-skill",
			"user-only",
		]);
		expect(manager.findByName("shared-skill")?.source).toBe("project");
		expect(manager.findByName("shared-skill")?.description).toBe(
			"project copy",
		);
		expect(manager.findByName("user-only")?.source).toBe("user");
	});

	it("loads body on demand and keeps descriptor lightweight", async () => {
		const userRoot = await createTempDir();
		await writeSkill(
			userRoot,
			"read-page",
			"Read a page",
			"# Skill Body\n\nUse it.",
		);

		const manager = new SkillsManager({
			userRoots: [userRoot],
		});

		const descriptors = await manager.discover();
		expect(descriptors[0]).not.toHaveProperty("body");

		const loaded = await manager.load("read-page");
		expect(loaded.descriptor.name).toBe("read-page");
		expect(loaded.body).toContain("# Skill Body");
		expect(loaded.tokenEstimate).toBeGreaterThan(0);
	});

	it("rejects missing and oversized skill loads", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "heavy-skill", "Large body", "body");
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();

		await expect(manager.load("missing-skill")).rejects.toThrow(
			"Skill not found: missing-skill",
		);
		await expect(
			manager.load("heavy-skill", { maxBodyBytes: 1 }),
		).rejects.toThrow("Skill body exceeds maxBodyBytes limit");
	});

	it("applies source-based trust defaults while preserving explicit trust", async () => {
		const bundledRoot = await createTempDir();
		const userRoot = await createTempDir();
		const projectRoot = await createTempDir();

		await writeSkill(
			bundledRoot,
			"bundled-default",
			"Bundled default",
			"# body",
		);
		await writeSkill(userRoot, "user-default", "User default", "# body");
		await writeSkillMarkdown(
			projectRoot,
			"project-explicit",
			`---
name: project-explicit
description: Project explicit
trust: trusted
---
# body
`,
		);

		const manager = new SkillsManager({
			bundledRoots: [bundledRoot],
			userRoots: [userRoot],
			projectRoots: [projectRoot],
		});

		await manager.discover();

		expect(manager.findByName("bundled-default")?.frontmatter.trust).toBe(
			"builtin",
		);
		expect(manager.findByName("user-default")?.frontmatter.trust).toBe(
			"community",
		);
		expect(manager.findByName("project-explicit")?.frontmatter.trust).toBe(
			"trusted",
		);
	});

	it("discovers skills that use YAML block sequences in frontmatter", async () => {
		const userRoot = await createTempDir();
		await writeSkillMarkdown(
			userRoot,
			"block-sequence-skill",
			`---
name: block-sequence-skill
description: Uses block sequences
allowedTools:
  - shell_exec
  - file_read
dependencies:
  skills:
    - planner
  tools:
    - file_read
---
# Block Sequence Skill
`,
		);
		const manager = new SkillsManager({ userRoots: [userRoot] });

		const descriptors = await manager.discover();

		expect(descriptors.map((descriptor) => descriptor.name)).toContain(
			"block-sequence-skill",
		);
		expect(
			manager.findByName("block-sequence-skill")?.frontmatter,
		).toMatchObject({
			allowedTools: ["shell_exec", "file_read"],
			dependencies: {
				skills: ["planner"],
				tools: ["file_read"],
			},
		});
	});

	it("records viewed skills as newest-first unique recentSkillNames", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		await writeSkill(userRoot, "beta", "Beta", "# beta");
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();
		manager.recordViewedSkill(await manager.load("alpha"));
		manager.recordViewedSkill(await manager.load("beta"));
		manager.recordViewedSkill(await manager.load("alpha"));

		expect(manager.getRecentSkillNames()).toEqual(["alpha", "beta"]);
	});

	it("postCompactRestore skips oversized skills and enforces total budget", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "a".repeat(200));
		await writeSkill(userRoot, "beta", "Beta", "b".repeat(40));
		await writeSkill(userRoot, "gamma", "Gamma", "c".repeat(40));
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();
		manager.recordViewedSkill(await manager.load("gamma"));
		manager.recordViewedSkill(await manager.load("beta"));
		manager.recordViewedSkill(await manager.load("alpha"));

		const estimatedBodies: string[] = [];
		const result = manager.postCompactRestore({
			recentSkillNames: manager.getRecentSkillNames(),
			maxSkillTokens: 20,
			maxTotalTokens: 15,
			estimateTokens: (text) => {
				estimatedBodies.push(text);
				return Math.ceil(text.length / 4);
			},
		});

		expect(result.entries.map((entry) => entry.name)).toEqual(["beta"]);
		expect(result.totalTokens).toBe(11);
		expect(estimatedBodies).toHaveLength(3);
		expect(estimatedBodies[0]).toHaveLength(201);
		expect(estimatedBodies[1]).toHaveLength(41);
		expect(estimatedBodies[2]).toHaveLength(41);
	});

	it("postCompactRestore skips missing skills from the recent list", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();
		manager.recordViewedSkill(await manager.load("alpha"));

		const result = manager.postCompactRestore({
			recentSkillNames: ["missing", ...manager.getRecentSkillNames()],
		});

		expect(result.entries.map((entry) => entry.name)).toEqual(["alpha"]);
	});

	it("postCompactRestore stops at the max skill count", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		await writeSkill(userRoot, "beta", "Beta", "# beta");
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();
		manager.recordViewedSkill(await manager.load("alpha"));
		manager.recordViewedSkill(await manager.load("beta"));

		const result = manager.postCompactRestore({
			recentSkillNames: manager.getRecentSkillNames(),
			maxSkills: 1,
		});

		expect(result.entries.map((entry) => entry.name)).toEqual(["beta"]);
	});

	it("evicts cached loaded skills that fall outside the bounded recent window", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		await writeSkill(userRoot, "beta", "Beta", "# beta");
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();
		manager.recordViewedSkill(await manager.load("alpha"), 1);
		manager.recordViewedSkill(await manager.load("beta"), 1);

		const loadedSkillByName = (
			manager as unknown as {
				loadedSkillByName: Map<string, unknown>;
			}
		).loadedSkillByName;
		expect(manager.getRecentSkillNames()).toEqual(["beta"]);
		expect([...loadedSkillByName.keys()]).toEqual(["beta"]);
	});

	it("removes cached loaded skills when a watched skill disappears from the catalog", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		const manager = new SkillsManager({ userRoots: [userRoot] });

		await manager.discover();
		manager.recordViewedSkill(await manager.load("alpha"));
		await rm(join(userRoot, "alpha"), { recursive: true, force: true });
		await manager.discover();

		const loadedSkillByName = (
			manager as unknown as {
				loadedSkillByName: Map<string, unknown>;
			}
		).loadedSkillByName;
		expect(manager.getRecentSkillNames()).toEqual([]);
		expect(loadedSkillByName.size).toBe(0);
	});

	it("classifies added removed and changed descriptors in catalog diff notifications", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		await writeSkill(userRoot, "beta", "Beta", "# beta");
		const manager = new SkillsManager({ userRoots: [userRoot] });
		const seenChanges: unknown[] = [];
		manager.onCatalogChange((change) => {
			seenChanges.push(change);
		});

		await manager.discover();
		await writeSkill(userRoot, "gamma", "Gamma", "# gamma");
		await writeSkill(userRoot, "beta", "Beta updated", "# beta");
		await rm(join(userRoot, "alpha"), { recursive: true, force: true });
		await manager.discover();

		expect(seenChanges.at(-1)).toEqual({
			added: ["gamma"],
			removed: ["alpha"],
			changed: ["beta"],
		});
	});

	it("notifies listeners when an existing descriptor changes without add/remove", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "alpha", "Alpha", "# alpha");
		const manager = new SkillsManager({ userRoots: [userRoot] });
		const seenChanges: unknown[] = [];
		manager.onCatalogChange((change) => {
			seenChanges.push(change);
		});

		await manager.discover();
		await writeSkill(userRoot, "alpha", "Alpha updated", "# alpha");
		await manager.discover();

		expect(seenChanges.at(-1)).toEqual({
			added: [],
			removed: [],
			changed: ["alpha"],
		});
	});

	it("debounces watcher rescan and stopWatching prevents further refreshes", async () => {
		vi.useFakeTimers();
		try {
			const userRoot = await createTempDir();
			const watchCallbacks: Array<() => void> = [];
			const discoverSpy = vi.spyOn(SkillsManager.prototype, "discover");
			const closeSpy = vi.fn();
			const manager = new SkillsManager({
				userRoots: [userRoot],
				debounceMs: 200,
				watchFactory: ((
					_path: string,
					_options: { recursive?: boolean } | undefined,
					listener: WatchListener<string>,
				) => {
					watchCallbacks.push(listener as () => void);
					return {
						close: closeSpy,
					} as never;
				}) as never,
			});

			manager.startWatching();
			manager.startWatching();
			expect(watchCallbacks).toHaveLength(1);

			watchCallbacks[0]?.();
			watchCallbacks[0]?.();
			watchCallbacks[0]?.();
			await vi.advanceTimersByTimeAsync(199);
			expect(discoverSpy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(discoverSpy).toHaveBeenCalledTimes(1);

			manager.stopWatching();
			manager.stopWatching();
			expect(closeSpy).toHaveBeenCalledTimes(1);

			watchCallbacks[0]?.();
			await vi.advanceTimersByTimeAsync(200);
			expect(discoverSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not start watchers for disabled or non-runtime roots", async () => {
		const pluginRoot = await createTempDir();
		const disabledWatch = vi.fn();
		const pluginWatch = vi.fn();

		new SkillsManager({
			userRoots: [pluginRoot],
			watcherEnabled: false,
			watchFactory: disabledWatch as never,
		}).startWatching();
		new SkillsManager({
			pluginRoots: [pluginRoot],
			watchFactory: pluginWatch as never,
		}).startWatching();

		expect(disabledWatch).not.toHaveBeenCalled();
		expect(pluginWatch).not.toHaveBeenCalled();
	});
});
