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
import type {
	WriteAuthority,
	WriteOrigin,
	WriteRequest,
	WriteRiskLevel,
} from "../safety/write-authority.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { createSkillsGuard } from "./guard.js";
import {
	DEFAULT_MAX_BODY_BYTES,
	DEFAULT_MAX_BODY_CHARS,
	isWithinRoot,
	type SkillsManager,
} from "./manager.js";
import type {
	GuardDecision,
	SkillDescriptor,
	SkillFrontmatter,
	SkillManageAction,
	SkillManageResult,
	SkillSource,
	SkillsGuard,
	SkillTrustLevel,
} from "./types.js";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SENSITIVE_TOOLS = new Set(["shell_exec", "file_write", "skill_manage"]);

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
	readonly guard?: SkillsGuard;
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

function findSensitiveTools(
	allowedTools: readonly string[] | undefined,
): readonly string[] {
	if (allowedTools == null) {
		return [];
	}

	return allowedTools.filter((tool) => SENSITIVE_TOOLS.has(tool));
}

function defaultTrustForSource(source: SkillSource): SkillTrustLevel {
	switch (source) {
		case "bundled":
			return "builtin";
		case "user":
		case "project":
		case "plugin":
			return "community";
	}
}

function summarizeGuardDecision(
	decision: Exclude<GuardDecision, { kind: "pass" }>,
): string {
	const patternIds = Array.from(
		new Set(decision.findings.map((finding) => finding.pattern_id)),
	).slice(0, 3);
	return `skills_guard=${decision.kind}:${patternIds.join(",")} findings=${decision.findings.length}`;
}

export class SkillManager {
	private readonly userRoot: string;
	private readonly projectRoot?: string;
	private readonly skillsManager: SkillsManager;
	private readonly writeAuthority: WriteAuthority;
	private readonly maxBodyChars: number;
	private readonly maxBodyBytes: number;
	private readonly fsOps: FsOps;
	private readonly guard: SkillsGuard;

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
		this.guard = options.guard ?? createSkillsGuard();
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
			return createError(
				"validation_failed",
				"skill name must be a valid slug",
			);
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

		const guardOutcome = this.evaluateGuard(action.body, {
			trust:
				action.descriptor.frontmatter.trust ??
				defaultTrustForSource(action.descriptor.source),
			stage: "write",
			skillName: action.descriptor.name,
		});
		if ("error" in guardOutcome) {
			return guardOutcome.error;
		}

		const authorization = await this.authorizeWrite(
			this.buildCreateRequest(action, targetPath, guardOutcome),
		);
		if (authorization != null) {
			return authorization;
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
			return createError(
				"validation_failed",
				"skill name must be a valid slug",
			);
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

		const guardOutcome = this.evaluateGuard(nextBody, {
			trust: nextFrontmatter.trust ?? defaultTrustForSource(existing.source),
			stage: "write",
			skillName: action.name,
		});
		if ("error" in guardOutcome) {
			return guardOutcome.error;
		}

		const authorization = await this.authorizeWrite(
			this.buildUpdateRequest(
				action.name,
				existingPath.path,
				nextFrontmatter,
				nextBody,
				guardOutcome,
			),
		);
		if (authorization != null) {
			return authorization;
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
			return createError(
				"validation_failed",
				"skill name must be a valid slug",
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

		const authorization = await this.authorizeWrite(
			this.buildDeleteRequest(action.name, existingPath.path),
		);
		if (authorization != null) {
			return authorization;
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
		{ readonly path: string } | { readonly error: SkillManageResult }
	> {
		let resolvedPath: string;
		try {
			resolvedPath = await this.fsOps.realpath(path);
		} catch {
			return {
				error: createError("not_found", `skill path not found: ${path}`),
			};
		}

		const stats = await this.fsOps.lstat(path);
		if (stats.isSymbolicLink()) {
			return {
				error: createError("path_denied", "skill path cannot be a symlink"),
			};
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
	): { readonly markdown: string } | { readonly error: SkillManageResult } {
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

	private buildCreateRequest(
		action: Extract<SkillManageAction, { action: "create" }>,
		targetPath: string,
		guardOutcome: GuardWriteOutcome,
	): WriteRequest {
		return this.buildWriteRequest({
			action: "create",
			name: action.descriptor.name,
			path: targetPath,
			body: action.body,
			allowedTools: action.descriptor.frontmatter.allowedTools,
			riskLevel: guardOutcome.riskLevel ?? "high",
			guardSummary: guardOutcome.detail,
		});
	}

	private buildUpdateRequest(
		name: string,
		targetPath: string,
		frontmatter: SkillFrontmatter,
		body: string,
		guardOutcome: GuardWriteOutcome,
	): WriteRequest {
		return this.buildWriteRequest({
			action: "update",
			name,
			path: targetPath,
			body,
			allowedTools: frontmatter.allowedTools,
			riskLevel: guardOutcome.riskLevel ?? "high",
			guardSummary: guardOutcome.detail,
		});
	}

	private buildDeleteRequest(name: string, targetPath: string): WriteRequest {
		return this.buildWriteRequest({
			action: "delete",
			name,
			path: targetPath,
			riskLevel: "medium",
		});
	}

	private buildWriteRequest(input: {
		readonly action: "create" | "update" | "delete";
		readonly name: string;
		readonly path: string;
		readonly riskLevel: WriteRiskLevel;
		readonly body?: string;
		readonly allowedTools?: readonly string[];
		readonly origin?: WriteOrigin;
		readonly guardSummary?: string;
	}): WriteRequest {
		const sensitiveTools = findSensitiveTools(input.allowedTools);
		const riskLevel = sensitiveTools.length > 0 ? "critical" : input.riskLevel;
		const details = [
			`path=${input.path}`,
			input.body == null
				? undefined
				: `bytes=${Buffer.byteLength(input.body, "utf8")}`,
			sensitiveTools.length === 0
				? undefined
				: `sensitive_tools=${sensitiveTools.join(",")}`,
			input.guardSummary,
		].filter((value): value is string => value != null);

		return {
			tool: "skill_manage",
			origin: input.origin ?? "agent",
			riskLevel,
			summary: `skills.${input.action} ${input.name}`,
			detail: details.join(" | "),
		};
	}

	private async authorizeWrite(
		request: WriteRequest,
	): Promise<SkillManageResult | null> {
		const decision = await this.writeAuthority.authorize(request);
		if (decision.kind === "allow") {
			return null;
		}

		return createError(
			"write_denied",
			decision.kind === "deny"
				? decision.reason
				: "write request requires interactive confirmation",
		);
	}

	private evaluateGuard(
		body: string,
		ctx: {
			readonly trust: SkillTrustLevel;
			readonly stage: "write";
			readonly skillName: string;
		},
	): { readonly error: SkillManageResult } | GuardWriteOutcome {
		const decision = this.guard.scan(body, ctx);
		switch (decision.kind) {
			case "pass":
				return {};
			case "warn":
				return {
					detail: summarizeGuardDecision(decision),
				};
			case "ask":
				return {
					detail: summarizeGuardDecision(decision),
					riskLevel: "critical",
				};
			case "deny":
				return {
					error: createError("guard_denied", decision.detail),
				};
		}
	}
}

interface GuardWriteOutcome {
	readonly detail?: string;
	readonly riskLevel?: WriteRiskLevel;
}

function isNonEmptyDirectoryError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error != null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOTEMPTY"
	);
}
