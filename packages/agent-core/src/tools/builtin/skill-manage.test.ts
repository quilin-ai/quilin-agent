import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriteAuthority } from "../../safety/write-authority.js";
import { renderSkillsCatalog } from "../../skills/catalog-renderer.js";
import { SkillsManager } from "../../skills/manager.js";
import { ToolRouter } from "../router.js";
import { createBuiltinTools } from "./index.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-skill-manage-tool-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("builtin skill_manage tool", () => {
	it("registers skill_manage when skillsManager and writeAuthority are available", () => {
		const tools = createBuiltinTools({
			skillsManager: new SkillsManager({}),
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
		});

		expect(tools.map((tool) => tool.name)).toContain("skill_manage");
	});

	it("creates a skill through ToolRouter and exposes it to the catalog in the same session", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const tools = createBuiltinTools({
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
			skillManage: {
				userRoot,
			},
		});
		const router = new ToolRouter(tools);

		const result = await router.execute({
			id: "call-1",
			name: "skill_manage",
			arguments: {
				action: "create",
				descriptor: {
					name: "router-skill",
					description: "Router skill description",
					path: "/tmp/router-skill/SKILL.md",
					source: "user",
					frontmatter: {
						name: "router-skill",
						description: "Router skill description",
						userInvocable: true,
						disableModelInvocation: false,
						trust: "community",
					},
				},
				body: "# Router Skill",
			},
		});

		expect(result.isError).toBe(false);
		expect(skillsManager.findByName("router-skill")).toBeDefined();
		const catalog = renderSkillsCatalog(skillsManager.list(), {
			availableToolNames: [],
			availableToolsets: [],
			minTrustLevel: "community",
			platform: process.platform,
			userInput: "",
			recentSkillNames: [],
		});
		expect(catalog).toContain('name="router-skill"');
	});

	it("creates project skills when projectRoot is configured", async () => {
		const userRoot = await createTempDir();
		const projectRoot = await createTempDir();
		const skillsManager = new SkillsManager({
			userRoots: [userRoot],
			projectRoots: [projectRoot],
		});
		await skillsManager.discover();
		const tools = createBuiltinTools({
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
			skillManage: {
				userRoot,
				projectRoot,
			},
		});
		const router = new ToolRouter(tools);

		const result = await router.execute({
			id: "call-project-create",
			name: "skill_manage",
			arguments: {
				action: "create",
				target: "project",
				descriptor: {
					name: "project-router-skill",
					description: "Project router skill description",
					path: "/tmp/project-router-skill/SKILL.md",
					source: "project",
					frontmatter: {
						name: "project-router-skill",
						description: "Project router skill description",
						userInvocable: true,
						disableModelInvocation: false,
						trust: "community",
					},
				},
				body: "# Project Router Skill",
			},
		});

		expect(result.isError).toBe(false);
		expect(skillsManager.findByName("project-router-skill")).toMatchObject({
			source: "project",
		});
	});

	it("surfaces schema validation errors for malformed actions", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const tools = createBuiltinTools({
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
			skillManage: {
				userRoot,
			},
		});
		const router = new ToolRouter(tools);

		const result = await router.execute({
			id: "call-2",
			name: "skill_manage",
			arguments: {
				action: "createe",
			},
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("Invalid"),
		});
	});

	it("updates and deletes skills through the tool action mapper", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const tools = createBuiltinTools({
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
			skillManage: {
				userRoot,
			},
		});
		const router = new ToolRouter(tools);
		const descriptor = {
			name: "mutable-skill",
			description: "Mutable skill description",
			path: "/tmp/mutable-skill/SKILL.md",
			source: "user" as const,
			frontmatter: {
				name: "mutable-skill",
				description: "Mutable skill description",
				userInvocable: true,
				disableModelInvocation: false,
				trust: "community" as const,
			},
		};

		await expect(
			router.execute({
				id: "call-create",
				name: "skill_manage",
				arguments: {
					action: "create",
					descriptor,
					body: "# Mutable Skill",
				},
			}),
		).resolves.toEqual(expect.objectContaining({ isError: false }));

		const updateResult = await router.execute({
			id: "call-update",
			name: "skill_manage",
			arguments: {
				action: "update",
				name: "mutable-skill",
				patch: {
					frontmatter: {
						description: "Updated mutable skill",
						allowedTools: ["web_fetch"],
					},
				},
				body: "# Updated Skill",
			},
		});

		expect(updateResult.isError).toBe(false);
		expect(skillsManager.findByName("mutable-skill")).toMatchObject({
			description: "Updated mutable skill",
			frontmatter: expect.objectContaining({
				allowedTools: ["web_fetch"],
			}),
		});

		const deleteResult = await router.execute({
			id: "call-delete",
			name: "skill_manage",
			arguments: {
				action: "delete",
				name: "mutable-skill",
				reason: "cleanup",
			},
		});

		expect(deleteResult.isError).toBe(false);
		expect(skillsManager.findByName("mutable-skill")).toBeUndefined();
	});

	it("surfaces SkillManager failures as tool errors", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const tools = createBuiltinTools({
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
			skillManage: {
				userRoot,
			},
		});
		const router = new ToolRouter(tools);

		const result = await router.execute({
			id: "call-manager-error",
			name: "skill_manage",
			arguments: {
				action: "create",
				descriptor: {
					name: "mismatched-skill",
					description: "Mismatched skill description",
					path: "/tmp/mismatched-skill/SKILL.md",
					source: "user",
					frontmatter: {
						name: "other-skill",
						description: "Mismatched skill description",
						userInvocable: true,
						disableModelInvocation: false,
						trust: "community",
					},
				},
				body: "# Mismatched Skill",
			},
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("frontmatter.name"),
		});
	});
});
