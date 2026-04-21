import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SkillsManager } from "../../skills/manager.js";
import { ToolRouter } from "../router.js";
import { createSkillViewTool } from "./skill-view.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-skill-view-"));
	createdDirs.push(dir);
	return dir;
}

async function writeSkillFile(
	filePath: string,
	name: string,
	description: string,
	body: string,
): Promise<void> {
	await writeFile(
		filePath,
		`---
name: ${name}
description: ${description}
---
${body}
`,
		"utf8",
	);
}

async function writeSkill(
	root: string,
	name: string,
	description: string,
	body: string,
): Promise<void> {
	const skillDir = join(root, name);
	await mkdir(skillDir, { recursive: true });
	await writeSkillFile(join(skillDir, "SKILL.md"), name, description, body);
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("builtin skill_view tool", () => {
	it("returns the skill body for a discovered skill", async () => {
		const userRoot = await createTempDir();
		await writeSkill(
			userRoot,
			"read-page",
			"Read a page",
			"# Skill Body\n\nUse it carefully.",
		);

		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const tool = createSkillViewTool({ skillsManager });

		const result = await tool.execute({ skill_id: "read-page" });

		expect(result.isError).toBe(false);
		expect(result.content).toBe("# Skill Body\n\nUse it carefully.\n");
	});

	it("rejects skill files that resolve outside the configured roots", async () => {
		const userRoot = await createTempDir();
		const externalRoot = await createTempDir();
		const skillDir = join(userRoot, "escaped-skill");
		await mkdir(skillDir, { recursive: true });
		const externalSkillPath = join(externalRoot, "outside-skill.md");
		await writeSkillFile(
			externalSkillPath,
			"escaped-skill",
			"Escaped skill",
			"# Outside body",
		);
		await symlink(externalSkillPath, join(skillDir, "SKILL.md"));

		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const tool = createSkillViewTool({ skillsManager });

		const result = await tool.execute({ skill_id: "escaped-skill" });

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("outside"),
		});
	});

	it("rejects skills whose body exceeds the configured limit", async () => {
		const userRoot = await createTempDir();
		await writeSkill(userRoot, "big-skill", "Big skill", "A".repeat(64));

		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const tool = createSkillViewTool({
			skillsManager,
			maxBodyChars: 16,
		});

		const result = await tool.execute({ skill_id: "big-skill" });

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("exceeds"),
		});
	});

	it("returns a tool error when skill_id is missing", async () => {
		const userRoot = await createTempDir();
		await writeSkill(
			userRoot,
			"read-page",
			"Read a page",
			"# Skill Body\n\nUse it carefully.",
		);

		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const router = new ToolRouter([createSkillViewTool({ skillsManager })]);

		const result = await router.execute({
			id: "call-1",
			name: "skill_view",
			arguments: {},
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("skill_id"),
		});
	});
});
