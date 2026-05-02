import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { WriteAuthority } from "../../safety/write-authority.js";
import { SkillManager } from "../../skills/manage.js";
import type { SkillsManager } from "../../skills/manager.js";
import type {
	SkillDescriptor,
	SkillFrontmatter,
	SkillManageAction,
} from "../../skills/types.js";
import type { SandboxPolicy, SandboxRequest } from "../sandbox.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const skillDependenciesSchema = z.object({
	skills: z.array(z.string()).optional(),
	tools: z.array(z.string()).optional(),
	toolsets: z.array(z.string()).optional(),
	packages: z.array(z.string()).optional(),
});

const skillFrontmatterSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	whenToUse: z.string().optional(),
	allowedTools: z.array(z.string()).optional(),
	mandatory: z.boolean().optional(),
	requiresTools: z.array(z.string()).optional(),
	requiresToolsets: z.array(z.string()).optional(),
	platforms: z.array(z.string()).optional(),
	version: z.string().optional(),
	dependencies: skillDependenciesSchema.optional(),
	userInvocable: z.boolean(),
	disableModelInvocation: z.boolean(),
	trust: z
		.enum(["builtin", "trusted", "community", "agent-created"])
		.optional(),
});

const skillDescriptorSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	path: z.string(),
	source: z.enum(["bundled", "user", "project", "plugin"]),
	frontmatter: skillFrontmatterSchema,
});

const skillManageSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("create"),
		descriptor: skillDescriptorSchema,
		body: z.string(),
		target: z.enum(["user", "project"]).optional(),
	}),
	z.object({
		action: z.literal("update"),
		name: z.string().trim().min(1),
		patch: z.object({
			name: z.string().optional(),
			description: z.string().optional(),
			path: z.string().optional(),
			source: z.enum(["bundled", "user", "project", "plugin"]).optional(),
			frontmatter: skillFrontmatterSchema.partial().optional(),
		}),
		body: z.string().optional(),
	}),
	z.object({
		action: z.literal("delete"),
		name: z.string().trim().min(1),
		reason: z.string().trim().min(1),
	}),
]);

function createErrorResult(message: string): ToolResult {
	return {
		toolCallId: "builtin-skill-manage",
		content: JSON.stringify({ error: message }),
		isError: true,
	};
}

function createSuccessResult(payload: unknown): ToolResult {
	return {
		toolCallId: "builtin-skill-manage",
		content: JSON.stringify(payload),
		isError: false,
	};
}

function toSkillFrontmatter(
	frontmatter: z.infer<typeof skillFrontmatterSchema>,
): SkillFrontmatter {
	return frontmatter;
}

function toSkillDescriptor(
	descriptor: z.infer<typeof skillDescriptorSchema>,
): SkillDescriptor {
	return {
		...descriptor,
		frontmatter: toSkillFrontmatter(descriptor.frontmatter),
	};
}

function toSkillManageAction(
	input: z.infer<typeof skillManageSchema>,
): SkillManageAction {
	switch (input.action) {
		case "create":
			return {
				action: "create",
				descriptor: toSkillDescriptor(input.descriptor),
				body: input.body,
				target: input.target,
			};
		case "update":
			return {
				action: "update",
				name: input.name,
				patch: input.patch as unknown as Partial<SkillDescriptor>,
				body: input.body,
			};
		case "delete":
			return {
				action: "delete",
				name: input.name,
				reason: input.reason,
			};
	}
}

function createSkillManageSandboxRequest(
	args: unknown,
	origin: SandboxRequest["origin"],
	options: {
		readonly skillsManager: SkillsManager;
		readonly userRoot: string;
		readonly projectRoot?: string;
	},
): SandboxRequest {
	const input = args as z.infer<typeof skillManageSchema>;
	const operation = input.action === "delete" ? "delete" : "write";
	const requestedPath = (() => {
		switch (input.action) {
			case "create": {
				const root =
					input.target === "project" ? options.projectRoot : options.userRoot;
				return root == null
					? undefined
					: join(root, input.descriptor.name, "SKILL.md");
			}
			case "update":
			case "delete":
				return options.skillsManager.findByName(input.name)?.path;
		}
	})();

	return {
		operation,
		...(origin == null ? {} : { origin }),
		...(requestedPath == null
			? {}
			: {
					signals: {
						paths: [
							{
								path: requestedPath,
								access: operation,
							},
						],
					},
				}),
	};
}

function createSkillManageSandboxPolicy(options: {
	readonly skillsManager: SkillsManager;
	readonly userRoot: string;
	readonly projectRoot?: string;
}): SandboxPolicy {
	return (context) =>
		createSkillManageSandboxRequest(
			context.parsedArguments,
			context.origin,
			options,
		);
}

export interface SkillManageToolOptions {
	readonly skillsManager: SkillsManager;
	readonly writeAuthority: WriteAuthority;
	readonly userRoot?: string;
	readonly projectRoot?: string;
}

export function createSkillManageTool(
	options: SkillManageToolOptions,
): ToolWithMetadata {
	const userRoot = options.userRoot ?? resolve(homedir(), ".quilin/skills");
	const projectRoot =
		options.projectRoot == null ? undefined : resolve(options.projectRoot);
	const manager = new SkillManager({
		skillsManager: options.skillsManager,
		writeAuthority: options.writeAuthority,
		userRoot,
		projectRoot,
	});

	return {
		name: "skill_manage",
		description:
			"Create, update, or delete user/project skills through the WriteAuthority gate.",
		category: "programmatic",
		riskLevel: "high-risk",
		sandboxOperation: "write",
		sandboxPolicy: createSkillManageSandboxPolicy({
			skillsManager: options.skillsManager,
			userRoot,
			projectRoot,
		}),
		parameters: skillManageSchema,
		async execute(args: unknown): Promise<ToolResult> {
			try {
				const action = toSkillManageAction(
					args as z.infer<typeof skillManageSchema>,
				);
				const result = await manager.manage(action);
				if (!result.ok) {
					return createErrorResult(result.detail);
				}
				return createSuccessResult(result);
			} catch (error) {
				return createErrorResult(
					error instanceof Error ? error.message : "Failed to manage skill",
				);
			}
		},
	};
}
