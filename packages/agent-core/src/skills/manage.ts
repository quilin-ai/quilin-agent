import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { WriteAuthority } from "../safety/write-authority.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import {
	DEFAULT_MAX_BODY_BYTES,
	DEFAULT_MAX_BODY_CHARS,
	isWithinRoot,
	type SkillsManager,
} from "./manager.js";
import type {
	SkillDescriptor,
	SkillFrontmatter,
	SkillManageAction,
	SkillManageResult,
} from "./types.js";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface FsOps {
	readonly mkdir: (
		path: string,
		options?: { recursive?: boolean },
	) => Promise<string | undefined>;
	readonly writeFile: (
		path: string,
		data: string,
		options?: { encoding?: "utf8"; flag?: string },
	) => Promise<void>;
	readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
	readonly unlink: (path: string) => Promise<void>;
	readonly rmdir: (path: string) => Promise<void>;
	readonly lstat: typeof lstat;
	readonly realpath: typeof realpath;
}

interface SkillManagerOptions {
	readonly userRoot: string;
	readonly projectRoot?: string;
	readonly skillsManager: SkillsManager;
	readonly writeAuthority: WriteAuthority;
	readonly maxBodyChars?: number;
	readonly maxBodyBytes?: number;
	readonly fsOps?: Partial<FsOps>;
}

const defaultFsOps: FsOps = {
	mkdir,
	writeFile,
	readFile,
	unlink,
	rmdir,
	lstat,
	realpath,
};

function serializeScalar(value: string | boolean): string {
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (/^[a-zA-Z0-9._/-]+$/.test(value)) {
		return value;
	}

	return JSON.stringify(value);
}

function serializeStringArray(value: readonly string[]): string {
	return `[${value.map((entry) => serializeScalar(entry)).join(", ")}]`;
}

function pushField(
	lines: string[],
	key: string,
	value: string | boolean | readonly string[] | undefined,
): void {
	if (value == null) {
		return;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return;
		}
		lines.push(`${key}: ${serializeStringArray(value)}`);
		return;
	}

	lines.push(`${key}: ${serializeScalar(value as string | boolean)}`);
}

function serializeSkillMarkdown(
	frontmatter: SkillFrontmatter,
	body: string,
): string {
	const lines = ["---"];
	pushField(lines, "name", frontmatter.name);
	pushField(lines, "description", frontmatter.description);
	pushField(lines, "whenToUse", frontmatter.whenToUse);
	pushField(lines, "allowedTools", frontmatter.allowedTools);
	pushField(lines, "mandatory", frontmatter.mandatory);
	pushField(lines, "requiresTools", frontmatter.requiresTools);
	pushField(lines, "requiresToolsets", frontmatter.requiresToolsets);
	pushField(lines, "platforms", frontmatter.platforms);
	pushField(lines, "version", frontmatter.version);
	pushField(lines, "userInvocable", frontmatter.userInvocable);
	pushField(
		lines,
		"disableModelInvocation",
		frontmatter.disableModelInvocation,
	);
	pushField(lines, "trust", frontmatter.trust);
	lines.push("---");
	lines.push(body);
	return `${lines.join("\n")}\n`;
}

function createError(
	error: Exclude<SkillManageResult, { ok: true }>["error"],
	detail: string,
): SkillManageResult {
	return { ok: false, error, detail };
}

function validateSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

function mergeFrontmatter(
	original: SkillFrontmatter,
	patch: Partial<SkillFrontmatter> | undefined,
): SkillFrontmatter {
	return {
		...original,
		...patch,
		name: original.name,
	};
}

export class SkillManager {
	private readonly userRoot: string;
	private readonly projectRoot?: string;
	private readonly skillsManager: SkillsManager;
	private readonly writeAuthority: WriteAuthority;
	private readonly maxBodyChars: number;
	private readonly maxBodyBytes: number;
	private readonly fsOps: FsOps;

	constructor(options: SkillManagerOptions) {
		this.userRoot = options.userRoot;
		this.projectRoot = options.projectRoot;
		this.skillsManager = options.skillsManager;
		this.writeAuthority = options.writeAuthority;
		this.maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
		this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		this.fsOps = {
			...defaultFsOps,
			...options.fsOps,
		};
	}

	async manage(action: SkillManageAction): Promise<SkillManageResult> {
		switch (action.action) {
			case "create":
				return this.create(action);
			case "update":
				return this.update(action);
			case "delete":
				return this.delete(action);
		}
	}

	private async create(
		action: Extract<SkillManageAction, { action: "create" }>,
	): Promise<SkillManageResult> {
		if (!validateSkillName(action.descriptor.name)) {
			return createError("validation_failed", "skill name must be a valid slug");
		}

		if (action.descriptor.frontmatter.name !== action.descriptor.name) {
			return createError(
				"validation_failed",
				"descriptor.name must match frontmatter.name",
			);
		}

		const root = await this.resolveCreateRoot(action.target);
		if ("error" in root) {
			return root.error;
		}

		const validation = this.validateBody(action.body);
		if (validation != null) {
			return validation;
		}

		const targetDir = join(root.path, action.descriptor.name);
		const targetPath = join(targetDir, "SKILL.md");
		if (!(await this.isPathWithinRoot(targetDir, root.realpath))) {
			return createError("path_denied", "target path escapes configured root");
		}

		const existingCheck = await this.validateNoSymlinkTarget(targetPath);
		if (existingCheck != null) {
			return existingCheck;
		}

		const serialized = this.serializeAndValidate(
			action.descriptor.frontmatter,
			action.body,
		);
		if ("error" in serialized) {
			return serialized.error;
		}

		await this.fsOps.mkdir(targetDir, { recursive: true });
		await this.fsOps.writeFile(targetPath, serialized.markdown, { flag: "wx" });
		await this.skillsManager.discover();
		const descriptor = this.skillsManager.findByName(action.descriptor.name);
		if (descriptor == null) {
			return createError("not_found", "skill not found after discover");
		}
		return { ok: true, descriptor };
	}

	private async update(
		action: Extract<SkillManageAction, { action: "update" }>,
	): Promise<SkillManageResult> {
		if (!validateSkillName(action.name)) {
			return createError("validation_failed", "skill name must be a valid slug");
		}

		if (
			action.patch.name != null ||
			action.patch.path != null ||
			action.patch.source != null
		) {
			return createError(
				"validation_failed",
				"update does not allow renaming or moving skills",
			);
		}
		if (
			action.patch.frontmatter?.name != null &&
			action.patch.frontmatter.name !== action.name
		) {
			return createError(
				"validation_failed",
				"update does not allow renaming or moving skills",
			);
		}

		const existing = this.skillsManager.findByName(action.name);
		if (existing == null) {
			return createError("not_found", `skill not found: ${action.name}`);
		}

		const existingPath = await this.resolveExistingPath(existing.path);
		if ("error" in existingPath) {
			return existingPath.error;
		}

		const content = await this.fsOps.readFile(existingPath.path, "utf8");
		const parsed = parseSkillMarkdown(content);
		const nextFrontmatter = mergeFrontmatter(
			existing.frontmatter,
			action.patch.frontmatter,
		);
		const nextBody = action.body ?? parsed.body;
		const validation = this.validateBody(nextBody);
		if (validation != null) {
			return validation;
		}

		const serialized = this.serializeAndValidate(nextFrontmatter, nextBody);
		if ("error" in serialized) {
			return serialized.error;
		}

		await this.fsOps.writeFile(existingPath.path, serialized.markdown);
		await this.skillsManager.discover();
		const descriptor = this.skillsManager.findByName(action.name);
		if (descriptor == null) {
			return createError("not_found", "skill not found after discover");
		}
		return { ok: true, descriptor };
	}

	private async delete(
		action: Extract<SkillManageAction, { action: "delete" }>,
	): Promise<SkillManageResult> {
		if (!validateSkillName(action.name)) {
			return createError("validation_failed", "skill name must be a valid slug");
		}

		const existing = this.skillsManager.findByName(action.name);
		if (existing == null) {
			return createError("not_found", `skill not found: ${action.name}`);
		}

		const existingPath = await this.resolveExistingPath(existing.path);
		if ("error" in existingPath) {
			return existingPath.error;
		}

		await this.fsOps.unlink(existingPath.path);
		try {
			await this.fsOps.rmdir(dirname(existingPath.path));
		} catch (error) {
			if (!isNonEmptyDirectoryError(error)) {
				throw error;
			}
		}
		await this.skillsManager.discover();
		return { ok: true, descriptor: existing };
	}

	private validateBody(body: string): SkillManageResult | null {
		if (body.length > this.maxBodyChars) {
			return createError("size_exceeded", "skill body exceeds maxBodyChars");
		}

		if (Buffer.byteLength(body, "utf8") > this.maxBodyBytes) {
			return createError("size_exceeded", "skill body exceeds maxBodyBytes");
		}

		return null;
	}

	private async resolveCreateRoot(
		target: "user" | "project" | undefined,
	): Promise<
		| { readonly path: string; readonly realpath: string }
		| { readonly error: SkillManageResult }
	> {
		if (target === "project") {
			if (this.projectRoot == null) {
				return {
					error: createError(
						"validation_failed",
						"project target requires configured projectRoot",
					),
				};
			}
			await this.fsOps.mkdir(this.projectRoot, { recursive: true });
			return {
				path: this.projectRoot,
				realpath: await this.fsOps.realpath(this.projectRoot),
			};
		}

		await this.fsOps.mkdir(this.userRoot, { recursive: true });
		return {
			path: this.userRoot,
			realpath: await this.fsOps.realpath(this.userRoot),
		};
	}

	private async resolveExistingPath(
		path: string,
	): Promise<
		| { readonly path: string }
		| { readonly error: SkillManageResult }
	> {
		let resolvedPath: string;
		try {
			resolvedPath = await this.fsOps.realpath(path);
		} catch {
			return { error: createError("not_found", `skill path not found: ${path}`) };
		}

		const stats = await this.fsOps.lstat(path);
		if (stats.isSymbolicLink()) {
			return { error: createError("path_denied", "skill path cannot be a symlink") };
		}

		const roots = [this.userRoot, this.projectRoot].filter(
			(root): root is string => root != null,
		);
		for (const root of roots) {
			const resolvedRoot = await this.fsOps.realpath(root);
			if (isWithinRoot(resolvedPath, resolvedRoot)) {
				return { path };
			}
		}

		return {
			error: createError(
				"path_denied",
				"existing skill path resolves outside configured roots",
			),
		};
	}

	private async isPathWithinRoot(
		targetDir: string,
		rootPath: string,
	): Promise<boolean> {
		const parentDir = dirname(targetDir);
		const resolvedParentDir = await this.fsOps.realpath(parentDir);
		return isWithinRoot(resolvedParentDir, rootPath);
	}

	private async validateNoSymlinkTarget(
		targetPath: string,
	): Promise<SkillManageResult | null> {
		try {
			const stats = await this.fsOps.lstat(targetPath);
			if (stats.isSymbolicLink()) {
				return createError("path_denied", "refusing to write through symlink");
			}
			return createError(
				"validation_failed",
				"skill already exists at target path",
			);
		} catch {
			return null;
		}
	}

	private serializeAndValidate(
		frontmatter: SkillFrontmatter,
		body: string,
	):
		| { readonly markdown: string }
		| { readonly error: SkillManageResult } {
		const markdown = serializeSkillMarkdown(frontmatter, body);
		try {
			const parsed = parseSkillMarkdown(markdown);
			if (parsed.frontmatter.name !== frontmatter.name) {
				return {
					error: createError(
						"validation_failed",
						"roundtrip validation failed for skill markdown",
					),
				};
			}
			return { markdown };
		} catch (error) {
			return {
				error: createError(
					"validation_failed",
					error instanceof Error
						? `roundtrip validation failed: ${error.message}`
						: "roundtrip validation failed",
				),
			};
		}
	}
}

function isNonEmptyDirectoryError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error != null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOTEMPTY"
	);
}
