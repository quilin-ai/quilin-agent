import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WriteAuthority,
	type WriteRequest,
} from "../safety/write-authority.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { SkillManager } from "./manage.js";
import { SkillsManager } from "./manager.js";
import type {
	SkillDescriptor,
	SkillFrontmatter,
	SkillsGuard,
} from "./types.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quilin-skill-manage-"));
	createdDirs.push(dir);
	return dir;
}

function makeDescriptor(
	name: string,
	source: SkillDescriptor["source"] = "user",
): SkillDescriptor {
	return {
		name,
		description: `Skill ${name} description`,
		path: `/tmp/${name}/SKILL.md`,
		source,
		frontmatter: {
			name,
			description: `Skill ${name} description`,
			whenToUse: `When ${name} is relevant`,
			userInvocable: true,
			disableModelInvocation: false,
			trust: source === "user" ? "community" : "builtin",
		},
	};
}

function createSubject(options: {
	userRoot: string;
	projectRoot?: string;
	skillsManager: SkillsManager;
	writeAuthority?: WriteAuthority;
	fsOps?: ConstructorParameters<typeof SkillManager>[0]["fsOps"];
	guard?: SkillsGuard;
}): SkillManager {
	return new SkillManager({
		userRoot: options.userRoot,
		projectRoot: options.projectRoot,
		skillsManager: options.skillsManager,
		writeAuthority:
			options.writeAuthority ??
			new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
			}),
		fsOps: options.fsOps,
		guard: options.guard,
	});
}

afterEach(async () => {
	await Promise.all(
		createdDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("SkillManager", () => {
	it("create writes a new skill and discover refreshes catalog", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		await skillsManager.discover();
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("new-skill"),
			body: "# New Skill\n\nUse it.",
		});

		expect(result).toEqual({
			ok: true,
			descriptor: expect.objectContaining({
				name: "new-skill",
				source: "user",
			}),
		});
		expect(skillsManager.findByName("new-skill")).toBeDefined();
		const markdown = await readFile(
			join(userRoot, "new-skill", "SKILL.md"),
			"utf8",
		);
		expect(markdown).toContain("name: new-skill");
		expect(markdown).toContain("# New Skill");
	});

	it("rejects invalid create names such as path traversal", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("bad-slug"),
			body: "body",
			target: "user",
		});

		const invalid = await subject.manage({
			action: "create",
			descriptor: {
				...makeDescriptor("bad-slug"),
				name: "../escape",
				frontmatter: {
					...makeDescriptor("bad-slug").frontmatter,
					name: "../escape",
				},
			},
			body: "body",
		});

		expect(result.ok).toBe(true);
		expect(invalid).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("valid slug"),
		});
	});

	it("rejects create when descriptor.name and frontmatter.name differ", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: {
				...makeDescriptor("mismatch"),
				frontmatter: {
					...makeDescriptor("mismatch").frontmatter,
					name: "other",
				},
			},
			body: "body",
		});

		expect(result).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("frontmatter.name"),
		});
	});

	it("rejects create when body exceeds maxBodyChars", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = new SkillManager({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({ mode: "auto-medium" }),
			maxBodyChars: 5,
		});

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("too-long"),
			body: "123456",
		});

		expect(result).toEqual({
			ok: false,
			error: "size_exceeded",
			detail: expect.stringContaining("maxBodyChars"),
		});
	});

	it("rejects create when body exceeds maxBodyBytes", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = new SkillManager({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({ mode: "auto-medium" }),
			maxBodyBytes: 4,
		});

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("too-many-bytes"),
			body: "你好啊",
		});

		expect(result).toEqual({
			ok: false,
			error: "size_exceeded",
			detail: expect.stringContaining("maxBodyBytes"),
		});
	});

	it("rejects create when target path already exists as a symlink", async () => {
		const userRoot = await createTempDir();
		const outsideDir = await createTempDir();
		const skillDir = join(userRoot, "symlink-skill");
		await mkdir(skillDir, { recursive: true });
		await symlink(join(outsideDir, "SKILL.md"), join(skillDir, "SKILL.md"));
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("symlink-skill"),
			body: "body",
		});

		expect(result).toEqual({
			ok: false,
			error: "path_denied",
			detail: expect.stringContaining("symlink"),
		});
	});

	it("rejects create when a regular skill file already exists", async () => {
		const userRoot = await createTempDir();
		const skillDir = join(userRoot, "existing-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "already here", "utf8");
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("existing-skill"),
			body: "body",
		});

		expect(result).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("already exists"),
		});
	});

	it("rejects project-target create when projectRoot is not configured", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("project-only"),
			body: "body",
			target: "project",
		});

		expect(result).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("projectRoot"),
		});
	});

	it("update returns not_found for unknown skills", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "update",
			name: "missing-skill",
			patch: {},
		});

		expect(result).toEqual({
			ok: false,
			error: "not_found",
			detail: expect.stringContaining("missing-skill"),
		});
	});

	it("update rejects rename attempts through patch.name or patch.frontmatter.name", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("rename-test"),
			body: "body",
		});

		const byName = await subject.manage({
			action: "update",
			name: "rename-test",
			patch: {
				name: "other",
			},
		});
		const byFrontmatter = await subject.manage({
			action: "update",
			name: "rename-test",
			patch: {
				frontmatter: {
					...makeDescriptor("rename-test").frontmatter,
					name: "other",
				},
			},
		});

		expect(byName).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.any(String),
		});
		expect(byFrontmatter).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.any(String),
		});
	});

	it("update rejects move attempts through patch.path or patch.source", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("move-test"),
			body: "body",
		});

		const byPath = await subject.manage({
			action: "update",
			name: "move-test",
			patch: {
				path: "/tmp/elsewhere/SKILL.md",
			},
		});
		const bySource = await subject.manage({
			action: "update",
			name: "move-test",
			patch: {
				source: "project",
			},
		});

		expect(byPath).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("renaming or moving"),
		});
		expect(bySource).toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("renaming or moving"),
		});
	});

	it("update rejects an existing skill path that became a symlink", async () => {
		const userRoot = await createTempDir();
		const outsideDir = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("symlink-update"),
			body: "body",
		});

		const skillPath = join(userRoot, "symlink-update", "SKILL.md");
		const outsidePath = join(outsideDir, "SKILL.md");
		await writeFile(outsidePath, "external", "utf8");
		await rm(skillPath, { force: true });
		await symlink(outsidePath, skillPath);

		const result = await subject.manage({
			action: "update",
			name: "symlink-update",
			patch: {},
			body: "updated",
		});

		expect(result).toEqual({
			ok: false,
			error: "path_denied",
			detail: expect.stringContaining("symlink"),
		});
	});

	it("update rewrites markdown and roundtrips through parseSkillMarkdown", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("update-me"),
			body: "# Old Body",
		});

		const result = await subject.manage({
			action: "update",
			name: "update-me",
			patch: {
				frontmatter: {
					...makeDescriptor("update-me").frontmatter,
					description: "Updated description",
					allowedTools: ["web_fetch"],
				},
			},
			body: "# New Body",
		});

		expect(result.ok).toBe(true);
		const markdown = await readFile(
			join(userRoot, "update-me", "SKILL.md"),
			"utf8",
		);
		const parsed = parseSkillMarkdown(markdown);
		expect(parsed.frontmatter.description).toBe("Updated description");
		expect(parsed.frontmatter.allowedTools).toEqual(["web_fetch"]);
		expect(parsed.body).toContain("# New Body");
	});

	it("delete returns not_found for unknown skills", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });

		const result = await subject.manage({
			action: "delete",
			name: "missing-skill",
			reason: "cleanup",
		});

		expect(result).toEqual({
			ok: false,
			error: "not_found",
			detail: expect.stringContaining("missing-skill"),
		});
	});

	it("delete removes the file and refreshes catalog", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("delete-me"),
			body: "body",
		});

		const result = await subject.manage({
			action: "delete",
			name: "delete-me",
			reason: "cleanup",
		});

		expect(result.ok).toBe(true);
		expect(skillsManager.findByName("delete-me")).toBeUndefined();
		await expect(
			readFile(join(userRoot, "delete-me", "SKILL.md"), "utf8"),
		).rejects.toThrow();
	});

	it("delete ignores non-empty skill directories after removing SKILL.md", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("nonempty-delete"),
			body: "body",
		});
		await writeFile(
			join(userRoot, "nonempty-delete", "notes.txt"),
			"keep",
			"utf8",
		);

		const result = await subject.manage({
			action: "delete",
			name: "nonempty-delete",
			reason: "cleanup",
		});

		expect(result.ok).toBe(true);
		expect(skillsManager.findByName("nonempty-delete")).toBeUndefined();
		await expect(
			readFile(join(userRoot, "nonempty-delete", "notes.txt"), "utf8"),
		).resolves.toBe("keep");
	});

	it("create writes to projectRoot when target=project", async () => {
		const userRoot = await createTempDir();
		const projectRoot = await createTempDir();
		const skillsManager = new SkillsManager({
			userRoots: [userRoot],
			projectRoots: [projectRoot],
		});
		await skillsManager.discover();
		const subject = createSubject({ userRoot, projectRoot, skillsManager });

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("project-skill", "project"),
			body: "body",
			target: "project",
		});

		expect(result.ok).toBe(true);
		expect(skillsManager.findByName("project-skill")?.source).toBe("project");
	});

	it("create sends high-risk agent requests when no sensitive tools are present", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});

		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("audited"),
			body: "body",
		});

		expect(seenRequests).toContainEqual(
			expect.objectContaining({
				tool: "skill_manage",
				origin: "agent",
				riskLevel: "high",
				summary: "skills.create audited",
			}),
		);
	});

	it("create escalates to critical for shell_exec", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});

		await subject.manage({
			action: "create",
			descriptor: {
				...makeDescriptor("shell-sensitive"),
				frontmatter: {
					...makeDescriptor("shell-sensitive").frontmatter,
					allowedTools: ["shell_exec"],
				},
			},
			body: "body",
		});

		expect(seenRequests.at(-1)).toEqual(
			expect.objectContaining({
				riskLevel: "critical",
				detail: expect.stringContaining("shell_exec"),
			}),
		);
	});

	it("create escalates to critical for file_write", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});

		await subject.manage({
			action: "create",
			descriptor: {
				...makeDescriptor("file-sensitive"),
				frontmatter: {
					...makeDescriptor("file-sensitive").frontmatter,
					allowedTools: ["file_write"],
				},
			},
			body: "body",
		});

		expect(seenRequests.at(-1)?.riskLevel).toBe("critical");
	});

	it("create escalates to critical for skill_manage self-reference", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});

		await subject.manage({
			action: "create",
			descriptor: {
				...makeDescriptor("self-managing"),
				frontmatter: {
					...makeDescriptor("self-managing").frontmatter,
					allowedTools: ["skill_manage"],
				},
			},
			body: "body",
		});

		expect(seenRequests.at(-1)?.riskLevel).toBe("critical");
	});

	it("update escalates to critical when merged allowedTools introduce shell_exec", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("update-sensitive"),
			body: "body",
		});

		await subject.manage({
			action: "update",
			name: "update-sensitive",
			patch: {
				frontmatter: {
					...makeDescriptor("update-sensitive").frontmatter,
					allowedTools: ["shell_exec"],
				},
			},
		});

		expect(seenRequests.at(-1)).toEqual(
			expect.objectContaining({
				summary: "skills.update update-sensitive",
				riskLevel: "critical",
			}),
		);
	});

	it("delete uses medium risk", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("delete-risk"),
			body: "body",
		});

		await subject.manage({
			action: "delete",
			name: "delete-risk",
			reason: "cleanup",
		});

		expect(seenRequests.at(-1)).toEqual(
			expect.objectContaining({
				summary: "skills.delete delete-risk",
				riskLevel: "medium",
			}),
		);
	});

	it("returns write_denied when WriteAuthority is deny-all", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({ mode: "deny-all" }),
		});

		const createResult = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("denied"),
			body: "body",
		});
		const updateResult = await subject.manage({
			action: "update",
			name: "denied",
			patch: {},
		});
		const deleteResult = await subject.manage({
			action: "delete",
			name: "denied",
			reason: "cleanup",
		});

		expect(createResult).toEqual({
			ok: false,
			error: "write_denied",
			detail: expect.stringContaining("disabled"),
		});
		expect(updateResult).toEqual({
			ok: false,
			error: "not_found",
			detail: expect.any(String),
		});
		expect(deleteResult).toEqual({
			ok: false,
			error: "not_found",
			detail: expect.any(String),
		});
	});

	it("returns write_denied when authorization still requires confirmation", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const authorize = vi.fn(async () => ({
			kind: "confirm" as const,
			prompt: "approve write",
		}));
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: { authorize } as unknown as WriteAuthority,
		});

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("needs-confirm"),
			body: "body",
		});

		expect(result).toEqual({
			ok: false,
			error: "write_denied",
			detail: expect.stringContaining("interactive confirmation"),
		});
		expect(authorize).toHaveBeenCalledTimes(1);
	});

	it("routes every allowed create/update/delete mutation through authorize exactly once", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const authorize = vi.fn(async () => ({ kind: "allow" as const }));
		const writeAuthority = {
			authorize,
		} as unknown as WriteAuthority;
		const writeFileSpy = vi.fn(async (path: string, data: string) => {
			await import("node:fs/promises").then(({ writeFile: nodeWriteFile }) =>
				nodeWriteFile(path, data, "utf8"),
			);
		});
		const unlinkSpy = vi.fn(async (path: string) => {
			await import("node:fs/promises").then(({ unlink: nodeUnlink }) =>
				nodeUnlink(path),
			);
		});
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority,
			fsOps: {
				writeFile: writeFileSpy,
				unlink: unlinkSpy,
			},
		});

		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("contract"),
			body: "body",
		});
		await subject.manage({
			action: "update",
			name: "contract",
			patch: {
				frontmatter: {
					...makeDescriptor("contract").frontmatter,
					description: "updated",
				},
			},
		});
		await subject.manage({
			action: "delete",
			name: "contract",
			reason: "cleanup",
		});

		expect(authorize).toHaveBeenCalledTimes(3);
		expect(writeFileSpy).toHaveBeenCalledTimes(2);
		expect(unlinkSpy).toHaveBeenCalledTimes(1);
		expect(writeFileSpy.mock.calls.length + unlinkSpy.mock.calls.length).toBe(
			authorize.mock.calls.length,
		);
	});

	it("returns guard_denied before authorize when create body is denied", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const authorize = vi.fn(async () => ({ kind: "allow" as const }));
		const guard: SkillsGuard = {
			scan: vi.fn(() => ({
				kind: "deny" as const,
				detail:
					"skills_guard denied denied-create due to matched threat patterns",
				findings: [
					{
						category: "destructive_ops" as const,
						severity: "critical" as const,
						pattern_id: "DESTRUCT-001",
						match: "rm -rf /",
						line: 1,
					},
				],
			})),
		};
		const subject = createSubject({
			userRoot,
			skillsManager,
			writeAuthority: { authorize } as unknown as WriteAuthority,
			guard,
		});

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("denied-create"),
			body: "rm -rf /",
		});

		expect(result).toEqual({
			ok: false,
			error: "guard_denied",
			detail: expect.stringContaining("skills_guard denied"),
		});
		expect(guard.scan).toHaveBeenCalledTimes(1);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("escalates ask findings to critical before WriteAuthority", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const guard: SkillsGuard = {
			scan: vi.fn(() => ({
				kind: "ask" as const,
				findings: [
					{
						category: "prompt_injection" as const,
						severity: "medium" as const,
						pattern_id: "PROMPT-INJECT-001",
						match: "ignore previous instructions",
						line: 1,
					},
				],
			})),
		};
		const subject = createSubject({
			userRoot,
			skillsManager,
			guard,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});

		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("ask-create"),
			body: "ignore previous instructions",
		});

		expect(seenRequests.at(-1)).toEqual(
			expect.objectContaining({
				riskLevel: "critical",
				detail: expect.stringContaining("skills_guard=ask:PROMPT-INJECT-001"),
			}),
		);
	});

	it("appends warn findings to update detail without blocking writes", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenRequests: WriteRequest[] = [];
		const guard: SkillsGuard = {
			scan: vi.fn((body) =>
				body.includes("launchctl")
					? {
							kind: "warn" as const,
							findings: [
								{
									category: "persistence" as const,
									severity: "high" as const,
									pattern_id: "PERSIST-002",
									match: "launchctl load",
									line: 1,
								},
							],
						}
					: { kind: "pass" as const },
			),
		};
		const subject = createSubject({
			userRoot,
			skillsManager,
			guard,
			writeAuthority: new WriteAuthority({
				mode: "ask",
				confirm: async () => true,
				auditLog: (record) => {
					seenRequests.push(record.request);
				},
			}),
		});
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("warn-update"),
			body: "safe",
		});

		const result = await subject.manage({
			action: "update",
			name: "warn-update",
			patch: {},
			body: "launchctl load ~/Library/LaunchAgents/com.bad.plist",
		});

		expect(result.ok).toBe(true);
		expect(seenRequests.at(-1)).toEqual(
			expect.objectContaining({
				summary: "skills.update warn-update",
				detail: expect.stringContaining("skills_guard=warn:PERSIST-002"),
				riskLevel: "high",
			}),
		);
	});

	it("calls guard exactly once for create and update, and skips delete", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const guard: SkillsGuard = {
			scan: vi.fn(() => ({ kind: "pass" as const })),
		};
		const subject = createSubject({ userRoot, skillsManager, guard });

		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("guard-contract"),
			body: "create body",
		});
		await subject.manage({
			action: "update",
			name: "guard-contract",
			patch: {},
		});
		await subject.manage({
			action: "delete",
			name: "guard-contract",
			reason: "cleanup",
		});

		expect(guard.scan).toHaveBeenCalledTimes(2);
		expect(guard.scan).toHaveBeenNthCalledWith(
			1,
			"create body",
			expect.objectContaining({
				stage: "write",
				skillName: "guard-contract",
			}),
		);
		expect(guard.scan).toHaveBeenNthCalledWith(
			2,
			"create body\n",
			expect.objectContaining({
				stage: "write",
				skillName: "guard-contract",
			}),
		);
	});

	it("falls back to source trust and omits empty array frontmatter fields", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const seenTrust: string[] = [];
		const guard: SkillsGuard = {
			scan: vi.fn((_body, ctx) => {
				seenTrust.push(ctx.trust);
				return { kind: "pass" as const };
			}),
		};
		const subject = createSubject({ userRoot, skillsManager, guard });

		for (const source of ["bundled", "user", "project", "plugin"] as const) {
			const descriptor = makeDescriptor(`trust-${source}`, source);
			await subject.manage({
				action: "create",
				descriptor: {
					...descriptor,
					frontmatter: {
						...descriptor.frontmatter,
						allowedTools: [],
						trust: undefined,
					},
				},
				body: "body",
			});
		}

		expect(seenTrust).toEqual([
			"builtin",
			"community",
			"community",
			"community",
		]);
		const markdown = await readFile(
			join(userRoot, "trust-user", "SKILL.md"),
			"utf8",
		);
		expect(markdown).not.toContain("allowedTools:");
	});

	it("rejects create when the resolved target directory escapes the root", async () => {
		const userRoot = await createTempDir();
		const outsideRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({
			userRoot,
			skillsManager,
			fsOps: {
				realpath: vi
					.fn()
					.mockResolvedValueOnce(outsideRoot)
					.mockResolvedValue(userRoot) as never,
			},
		});

		const result = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("escape-root"),
			body: "body",
		});

		expect(result).toEqual({
			ok: false,
			error: "path_denied",
			detail: expect.stringContaining("escapes"),
		});
	});

	it("returns not_found when discover does not publish created or updated skills", async () => {
		const userRoot = await createTempDir();
		const skillPath = join(userRoot, "missing-after-update", "SKILL.md");
		await mkdir(dirname(skillPath), { recursive: true });
		await writeFile(
			skillPath,
			[
				"---",
				"name: missing-after-update",
				"description: Existing skill",
				"whenToUse: When testing",
				"---",
				"body",
			].join("\n"),
			"utf8",
		);
		const staleDescriptor = {
			...makeDescriptor("missing-after-update"),
			path: skillPath,
		};
		const skillsManager = {
			discover: vi.fn(async () => undefined),
			findByName: vi
				.fn()
				.mockReturnValueOnce(undefined)
				.mockReturnValueOnce(staleDescriptor)
				.mockReturnValueOnce(undefined),
		} as unknown as SkillsManager;
		const subject = createSubject({ userRoot, skillsManager });

		const createResult = await subject.manage({
			action: "create",
			descriptor: makeDescriptor("missing-after-create"),
			body: "body",
		});
		const updateResult = await subject.manage({
			action: "update",
			name: "missing-after-update",
			patch: {},
			body: "new body",
		});

		expect(createResult).toEqual({
			ok: false,
			error: "not_found",
			detail: expect.stringContaining("after discover"),
		});
		expect(updateResult).toEqual({
			ok: false,
			error: "not_found",
			detail: expect.stringContaining("after discover"),
		});
	});

	it("rejects invalid update/delete names, oversized updates, and invalid serialized updates", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("update-validation"),
			body: "body",
		});
		const tinySubject = new SkillManager({
			userRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({ mode: "auto-medium" }),
			maxBodyChars: 2,
		});

		await expect(
			subject.manage({
				action: "update",
				name: "../bad",
				patch: {},
			}),
		).resolves.toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("valid slug"),
		});
		await expect(
			subject.manage({
				action: "delete",
				name: "../bad",
				reason: "cleanup",
			}),
		).resolves.toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("valid slug"),
		});
		await expect(
			tinySubject.manage({
				action: "update",
				name: "update-validation",
				patch: {},
				body: "too long",
			}),
		).resolves.toEqual({
			ok: false,
			error: "size_exceeded",
			detail: expect.stringContaining("maxBodyChars"),
		});
		await expect(
			subject.manage({
				action: "update",
				name: "update-validation",
				patch: {
					frontmatter: {
						description: undefined,
					} as unknown as SkillFrontmatter,
				},
			}),
		).resolves.toEqual({
			ok: false,
			error: "validation_failed",
			detail: expect.stringContaining("roundtrip validation failed"),
		});
	});

	it("blocks update/delete through guard, path, and authorization failures", async () => {
		const userRoot = await createTempDir();
		const projectRoot = await createTempDir();
		const skillsManager = new SkillsManager({
			userRoots: [userRoot],
			projectRoots: [projectRoot],
		});
		const subject = createSubject({
			userRoot,
			projectRoot,
			skillsManager,
		});
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("guard-update"),
			body: "body",
		});
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("project-owned", "project"),
			body: "body",
			target: "project",
		});

		const guardSubject = createSubject({
			userRoot,
			skillsManager,
			guard: {
				scan: vi.fn(() => ({
					kind: "deny" as const,
					detail: "blocked update",
					findings: [],
				})),
			},
		});
		const denySubject = createSubject({
			userRoot,
			projectRoot,
			skillsManager,
			writeAuthority: new WriteAuthority({ mode: "deny-all" }),
		});
		const missingPathManager = {
			discover: vi.fn(async () => undefined),
			findByName: vi.fn(() => ({
				...makeDescriptor("missing-path"),
				path: join(userRoot, "missing-path", "SKILL.md"),
			})),
		} as unknown as SkillsManager;
		const missingPathSubject = createSubject({
			userRoot,
			skillsManager: missingPathManager,
		});

		await expect(
			guardSubject.manage({
				action: "update",
				name: "guard-update",
				patch: {},
				body: "blocked",
			}),
		).resolves.toEqual({
			ok: false,
			error: "guard_denied",
			detail: "blocked update",
		});
		await expect(
			denySubject.manage({
				action: "update",
				name: "guard-update",
				patch: {},
			}),
		).resolves.toEqual({
			ok: false,
			error: "write_denied",
			detail: expect.stringContaining("disabled"),
		});
		await expect(
			missingPathSubject.manage({
				action: "delete",
				name: "missing-path",
				reason: "cleanup",
			}),
		).resolves.toEqual({
			ok: false,
			error: "not_found",
			detail: expect.stringContaining("skill path not found"),
		});
		await expect(
			denySubject.manage({
				action: "delete",
				name: "project-owned",
				reason: "cleanup",
			}),
		).resolves.toEqual({
			ok: false,
			error: "write_denied",
			detail: expect.stringContaining("disabled"),
		});
	});

	it("rethrows unexpected directory cleanup errors after delete", async () => {
		const userRoot = await createTempDir();
		const skillsManager = new SkillsManager({ userRoots: [userRoot] });
		const subject = createSubject({ userRoot, skillsManager });
		await subject.manage({
			action: "create",
			descriptor: makeDescriptor("delete-eacces"),
			body: "body",
		});
		const failingCleanupSubject = createSubject({
			userRoot,
			skillsManager,
			fsOps: {
				rmdir: vi.fn(async () => {
					const error = new Error("permission denied") as Error & {
						code: string;
					};
					error.code = "EACCES";
					throw error;
				}),
			},
		});

		await expect(
			failingCleanupSubject.manage({
				action: "delete",
				name: "delete-eacces",
				reason: "cleanup",
			}),
		).rejects.toThrow("permission denied");
	});
});
