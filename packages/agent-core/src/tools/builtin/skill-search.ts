import { z } from "zod";
import type { SkillsManager } from "../../skills/manager.js";
import type { SkillDescriptor } from "../../skills/types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

export interface SkillSearchToolOptions {
	readonly skillsManager?: SkillsManager;
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
}

interface SkillSearchHit {
	readonly skill_id: string;
	readonly name: string;
	readonly description: string;
	readonly source: SkillDescriptor["source"];
	readonly path: string;
	readonly score: number;
	readonly matched_fields: readonly string[];
	readonly metadata: {
		readonly when_to_use?: string;
		readonly mandatory?: boolean;
		readonly requires_tools?: readonly string[];
		readonly requires_toolsets?: readonly string[];
		readonly platforms?: readonly string[];
		readonly dependencies?: SkillDescriptor["frontmatter"]["dependencies"];
		readonly version?: string;
	};
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 50;
const skillSearchParametersSchema = z.object({
	query: z.string().trim().default(""),
	limit: z.number().int().positive().max(DEFAULT_MAX_LIMIT).optional(),
});

function tokenize(query: string): readonly string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^\p{L}\p{N}_-]+/u)
				.map((token) => token.trim())
				.filter((token) => token.length > 0),
		),
	];
}

function fieldText(value: unknown): string {
	if (value == null) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.map(fieldText).join(" ");
	}
	if (typeof value === "object") {
		return Object.values(value as Record<string, unknown>)
			.map(fieldText)
			.join(" ");
	}
	return String(value);
}

function descriptorSearchFields(
	descriptor: SkillDescriptor,
): Readonly<Record<string, string>> {
	const frontmatter = descriptor.frontmatter;
	return {
		name: descriptor.name,
		description: descriptor.description,
		when_to_use: frontmatter.whenToUse ?? "",
		requires_tools: fieldText(frontmatter.requiresTools),
		requires_toolsets: fieldText(frontmatter.requiresToolsets),
		platforms: fieldText(frontmatter.platforms),
		dependencies: fieldText(frontmatter.dependencies),
		source: descriptor.source,
		version: frontmatter.version ?? "",
	};
}

function scoreDescriptor(
	descriptor: SkillDescriptor,
	query: string,
	tokens: readonly string[],
): { readonly score: number; readonly matchedFields: readonly string[] } {
	const fields = descriptorSearchFields(descriptor);
	const normalizedQuery = query.toLowerCase().trim();
	const matchedFields = new Set<string>();
	let score = 0;

	for (const [field, rawValue] of Object.entries(fields)) {
		const value = rawValue.toLowerCase();
		if (value.length === 0) {
			continue;
		}
		if (normalizedQuery.length > 0 && value.includes(normalizedQuery)) {
			matchedFields.add(field);
			score += field === "name" ? 12 : 6;
		}
		for (const token of tokens) {
			if (value.includes(token)) {
				matchedFields.add(field);
				score += field === "name" ? 4 : 2;
			}
		}
	}

	if (descriptor.frontmatter.mandatory === true) {
		score += 0.5;
	}

	return { score, matchedFields: [...matchedFields].toSorted() };
}

function toHit(
	descriptor: SkillDescriptor,
	score: number,
	matchedFields: readonly string[],
): SkillSearchHit {
	const frontmatter = descriptor.frontmatter;
	return {
		skill_id: descriptor.name,
		name: descriptor.name,
		description: descriptor.description,
		source: descriptor.source,
		path: descriptor.path,
		score,
		matched_fields: matchedFields,
		metadata: {
			...(frontmatter.whenToUse == null
				? {}
				: { when_to_use: frontmatter.whenToUse }),
			...(frontmatter.mandatory == null
				? {}
				: { mandatory: frontmatter.mandatory }),
			...(frontmatter.requiresTools == null
				? {}
				: { requires_tools: frontmatter.requiresTools }),
			...(frontmatter.requiresToolsets == null
				? {}
				: { requires_toolsets: frontmatter.requiresToolsets }),
			...(frontmatter.platforms == null
				? {}
				: { platforms: frontmatter.platforms }),
			...(frontmatter.dependencies == null
				? {}
				: { dependencies: frontmatter.dependencies }),
			...(frontmatter.version == null ? {} : { version: frontmatter.version }),
		},
	};
}

function createJsonResult(content: unknown): ToolResult {
	return {
		toolCallId: "builtin-skill-search",
		content: JSON.stringify(content, null, 2),
		isError: false,
	};
}

export function createSkillSearchTool(
	options: SkillSearchToolOptions = {},
): ToolWithMetadata {
	const maxLimit = Math.max(1, options.maxLimit ?? DEFAULT_MAX_LIMIT);
	const defaultLimit = Math.min(
		Math.max(1, options.defaultLimit ?? DEFAULT_LIMIT),
		maxLimit,
	);

	return {
		name: "skill_search",
		description:
			"Search discovered skills by name, description, usage, tools, platforms, and dependency metadata.",
		category: "programmatic",
		riskLevel: "read",
		parameters: skillSearchParametersSchema.extend({
			limit: z.number().int().positive().max(maxLimit).optional(),
		}),
		async execute(args: unknown): Promise<ToolResult> {
			const parsed = skillSearchParametersSchema
				.extend({
					limit: z.number().int().positive().max(maxLimit).optional(),
				})
				.parse(args);
			const query = parsed.query;
			const tokens = tokenize(query);
			const limit = parsed.limit ?? defaultLimit;
			const descriptors = options.skillsManager?.list() ?? [];
			const matches = descriptors
				.map((descriptor) => {
					const { score, matchedFields } = scoreDescriptor(
						descriptor,
						query,
						tokens,
					);
					return { descriptor, score, matchedFields };
				})
				.filter(({ score }) => query.length === 0 || score > 0)
				.toSorted(
					(left, right) =>
						right.score - left.score ||
						left.descriptor.name.localeCompare(right.descriptor.name),
				);
			const hits = matches
				.slice(0, limit)
				.map(({ descriptor, score, matchedFields }) =>
					toHit(descriptor, score, matchedFields),
				);

			return createJsonResult({
				query,
				skills_configured: options.skillsManager != null,
				total: matches.length,
				results: hits,
				...(options.skillsManager == null
					? {
							message:
								"Skills are not configured for this runtime; search results are empty.",
						}
					: {}),
			});
		},
	};
}
