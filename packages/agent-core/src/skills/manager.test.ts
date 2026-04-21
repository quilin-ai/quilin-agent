import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
