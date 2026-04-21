import { z } from "zod";
import { createSkillsGuard } from "../../skills/guard.js";
import type { SkillsManager } from "../../skills/manager.js";
import type { SkillSource, SkillTrustLevel, SkillsGuard } from "../../skills/types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_BODY_CHARS = 100_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function createErrorResult(message: string, extra?: Record<string, unknown>): ToolResult {
	return {
		toolCallId: "builtin-skill-view",
		content: JSON.stringify(
			extra == null
				? { error: message }
				: {
						error: message,
						...extra,
					},
		),
		isError: true,
	};
}

function createSuccessResult(body: string): ToolResult {
	return {
		toolCallId: "builtin-skill-view",
		content: body,
		isError: false,
	};
}

export interface SkillViewToolOptions {
	readonly skillsManager: SkillsManager;
	readonly maxBodyChars?: number;
	readonly maxBodyBytes?: number;
	readonly guard?: SkillsGuard;
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

export function createSkillViewTool(
	options: SkillViewToolOptions,
): ToolWithMetadata {
	const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const guard = options.guard ?? createSkillsGuard();

	return {
		name: "skill_view",
		description: "Load the full body of a discovered skill by skill_id.",
		category: "programmatic",
		riskLevel: "read",
		parameters: z.object({
			skill_id: z.string().trim().min(1),
		}),
		async execute(args: unknown): Promise<ToolResult> {
			const { skill_id } = args as { skill_id: string };
			try {
				const skill = await options.skillsManager.load(skill_id, {
					maxBodyChars,
					maxBodyBytes,
				});
				const decision = guard.scan(skill.body, {
					trust:
						skill.descriptor.frontmatter.trust ??
						defaultTrustForSource(skill.descriptor.source),
					stage: "read",
					skillName: skill.descriptor.name,
				});
				if (decision.kind === "ask") {
					return createErrorResult("guard_ask", {
						detail: `skills_guard requires confirmation for ${skill.descriptor.name}`,
						findings: decision.findings,
					});
				}
				if (decision.kind === "deny") {
					return createErrorResult("guard_denied", {
						detail: decision.detail,
						findings: decision.findings,
					});
				}
				options.skillsManager.recordViewedSkill(skill);
				return createSuccessResult(skill.body);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to load skill";
				return createErrorResult(message);
			}
		},
	};
}
