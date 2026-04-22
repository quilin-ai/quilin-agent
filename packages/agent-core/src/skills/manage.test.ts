import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WriteAuthority,
	type WriteRequest,
} from "../safety/write-authority.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { SkillManager } from "./manage.js";
import { SkillsManager } from "./manager.js";
import type { SkillDescriptor, SkillsGuard } from "./types.js";

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
});
