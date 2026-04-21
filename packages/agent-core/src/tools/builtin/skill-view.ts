import { z } from "zod";
import type { SkillsManager } from "../../skills/manager.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_BODY_CHARS = 100_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function createErrorResult(message: string): ToolResult {
	return {
		toolCallId: "builtin-skill-view",
		content: JSON.stringify({ error: message }),
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
}

export function createSkillViewTool(
	options: SkillViewToolOptions,
): ToolWithMetadata {
	const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

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
				return createSuccessResult(skill.body);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to load skill";
				return createErrorResult(message);
			}
		},
	};
}
