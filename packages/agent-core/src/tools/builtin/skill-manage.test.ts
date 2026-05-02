import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriteAuthority } from "../../safety/write-authority.js";
import { renderSkillsCatalog } from "../../skills/catalog-renderer.js";
import { parseSkillMarkdown } from "../../skills/frontmatter.js";
import { SkillsManager } from "../../skills/manager.js";
import { ToolRouter } from "../router.js";
import { resolveSandboxPolicy } from "../sandbox.js";
import { createBuiltinTools } from "./index.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-skill-manage-tool-"));
	createdDirs.push(dir);
	return dir;
}

function createSandboxAllowingRouter(
	tools: ReturnType<typeof createBuiltinTools>,
): ToolRouter {
	return new ToolRouter(tools, {
		sandboxEvaluator: () => ({
			kind: "allow",
			reasonCodes: [],
			requiredApprovals: [],
		}),
	});
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

	it("uses actual skill target paths in sandbox requests", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const existingPath = join(userRoot, "existing-skill", "SKILL.md");
		await mkdir(join(userRoot, "existing-skill"), { recursive: true });
		await writeFile(
			existingPath,
			[
				"---",
				"name: existing-skill",
				"description: Existing skill description",
				"userInvocable: true",
				"disableModelInvocation: false",
				"trust: community",
				"---",
				"# Existing Skill",
			].join("\n"),
		);
		await skillsManager.discover();
		const [tool] = createBuiltinTools({
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
			skillManage: {
				userRoot,
			},
		}).filter((candidate) => candidate.name === "skill_manage");

		if (tool?.sandboxPolicy == null) {
			throw new Error("skill_manage sandbox policy is not configured");
		}

		const createRequest = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-skill-create",
			requestedToolName: "skill_manage",
			resolvedToolName: "skill_manage",
			parsedArguments: {
				action: "create",
				descriptor: {
					name: "sandboxed-skill",
					description: "Sandboxed skill description",
					path: "/tmp/not-the-managed-target/SKILL.md",
					source: "user",
					frontmatter: {
						name: "sandboxed-skill",
						description: "Sandboxed skill description",
						userInvocable: true,
						disableModelInvocation: false,
					},
				},
				body: "# Sandboxed Skill",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "high-risk",
			sandboxOperation: "write",
		});
		const updateRequest = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-skill-update",
			requestedToolName: "skill_manage",
			resolvedToolName: "skill_manage",
			parsedArguments: {
				action: "update",
				name: "existing-skill",
				patch: {
					path: "/tmp/not-the-managed-target/SKILL.md",
					frontmatter: {
						description: "Updated existing skill description",
					},
				},
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "high-risk",
			sandboxOperation: "write",
		});
		const deleteRequest = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-skill-delete",
			requestedToolName: "skill_manage",
			resolvedToolName: "skill_manage",
			parsedArguments: {
				action: "delete",
				name: "existing-skill",
				reason: "cleanup",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "high-risk",
			sandboxOperation: "write",
		});

		expect(createRequest).toEqual({
			operation: "write",
			origin: "agent",
			signals: {
				paths: [
					{
						path: join(userRoot, "sandboxed-skill", "SKILL.md"),
						access: "write",
					},
				],
			},
		});
		expect(updateRequest).toEqual({
			operation: "write",
			origin: "agent",
			signals: {
				paths: [
					{
						path: existingPath,
						access: "write",
					},
				],
			},
		});
		expect(deleteRequest).toEqual({
			operation: "delete",
			origin: "agent",
			signals: {
				paths: [
					{
						path: existingPath,
						access: "delete",
					},
				],
			},
		});
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
		const router = createSandboxAllowingRouter(tools);

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

	it("forces safe source and trust through create and update tool calls", async () => {
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
		const router = createSandboxAllowingRouter(tools);

		const createResult = await router.execute({
			id: "call-self-promote-create",
			name: "skill_manage",
			arguments: {
				action: "create",
				descriptor: {
					name: "tool-self-promote",
					description: "Tool self promote description",
					path: "/tmp/tool-self-promote/SKILL.md",
					source: "bundled",
					frontmatter: {
						name: "tool-self-promote",
						description: "Tool self promote description",
						userInvocable: true,
						disableModelInvocation: false,
						trust: "builtin",
					},
				},
				body: "# Tool Self Promote",
			},
		});

		expect(createResult.isError).toBe(false);
		expect(JSON.parse(createResult.content)).toMatchObject({
			descriptor: {
				source: "user",
				frontmatter: {
					trust: "community",
				},
			},
		});

		const updateResult = await router.execute({
			id: "call-self-promote-update",
			name: "skill_manage",
			arguments: {
				action: "update",
				name: "tool-self-promote",
				patch: {
					frontmatter: {
						trust: "builtin",
					},
				},
			},
		});

		expect(updateResult.isError).toBe(false);
		expect(JSON.parse(updateResult.content)).toMatchObject({
			descriptor: {
				source: "user",
				frontmatter: {
					trust: "community",
				},
			},
		});
		const markdown = await readFile(
			join(userRoot, "tool-self-promote", "SKILL.md"),
			"utf8",
		);
		expect(parseSkillMarkdown(markdown).frontmatter.trust).toBe("community");
	});

	it("accepts dependency metadata on create and update actions", async () => {
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
		const router = createSandboxAllowingRouter(tools);
		const initialDependencies = {
			skills: ["planner"],
			tools: ["file_read"],
		};
		const nextDependencies = {
			skills: ["planner", "browser-use"],
			toolsets: ["filesystem"],
			packages: ["zod"],
		};

		const createResult = await router.execute({
			id: "call-dependency-create",
			name: "skill_manage",
			arguments: {
				action: "create",
				descriptor: {
					name: "dependency-router-skill",
					description: "Dependency router skill description",
					path: "/tmp/dependency-router-skill/SKILL.md",
					source: "user",
					frontmatter: {
						name: "dependency-router-skill",
						description: "Dependency router skill description",
						dependencies: initialDependencies,
						userInvocable: true,
						disableModelInvocation: false,
						trust: "community",
					},
				},
				body: "# Dependency Router Skill",
			},
		});

		expect(createResult.isError).toBe(false);
		expect(
			skillsManager.findByName("dependency-router-skill")?.frontmatter
				.dependencies,
		).toEqual(initialDependencies);

		const updateResult = await router.execute({
			id: "call-dependency-update",
			name: "skill_manage",
			arguments: {
				action: "update",
				name: "dependency-router-skill",
				patch: {
					frontmatter: {
						dependencies: nextDependencies,
					},
				},
			},
		});

		expect(updateResult.isError).toBe(false);
		const markdown = await readFile(
			join(userRoot, "dependency-router-skill", "SKILL.md"),
			"utf8",
		);
		expect(parseSkillMarkdown(markdown).frontmatter.dependencies).toEqual(
			nextDependencies,
		);
		expect(
			skillsManager.findByName("dependency-router-skill")?.frontmatter
				.dependencies,
		).toEqual(nextDependencies);
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
		const router = createSandboxAllowingRouter(tools);

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
		const router = createSandboxAllowingRouter(tools);

		const result = await router.execute({
			id: "call-2",
			name: "skill_manage",
			arguments: {
				action: "createe",
			},
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toMatchObject({
			error: expect.stringContaining("Invalid"),
			code: "invalid_arguments",
			details: {
				issues: [
					expect.objectContaining({
						code: "invalid_union",
						path: ["action"],
						message: "Invalid input",
					}),
				],
			},
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
		const router = createSandboxAllowingRouter(tools);
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
		const router = createSandboxAllowingRouter(tools);

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
