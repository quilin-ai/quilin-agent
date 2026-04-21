import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { SkillManager } from "./manage.js";
import { SkillsManager } from "./manager.js";
import type { SkillDescriptor } from "./types.js";

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
}): SkillManager {
	return new SkillManager({
		userRoot: options.userRoot,
		projectRoot: options.projectRoot,
		skillsManager: options.skillsManager,
		writeAuthority: new WriteAuthority({
			mode: "auto-medium",
		}),
	});
}

afterEach(async () => {
	await Promise.all(
		createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
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
		const markdown = await readFile(join(userRoot, "new-skill", "SKILL.md"), "utf8");
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
		const markdown = await readFile(join(userRoot, "update-me", "SKILL.md"), "utf8");
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
});
