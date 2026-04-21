import {
	renderHotSkillsCatalog,
	renderSkillsCatalog,
	type SkillsCatalogTurnContext,
} from "../skills/catalog-renderer.js";
import type {
	PostCompactRestoreResult,
	SkillDescriptor,
} from "../skills/types.js";
import type { BuildContext, PromptSection } from "./prompt-types.js";

export interface SkillsCatalogSectionSource {
	list(): readonly SkillDescriptor[];
	postCompactRestore?(options: {
		readonly recentSkillNames: readonly string[];
	}): PostCompactRestoreResult;
}

const SKILLS_CATALOG_ORDER = 50;
const HOT_SKILLS_ORDER = 55;
const POST_COMPACT_SKILLS_ORDER = 60;

interface SkillsSessionState {
	readonly recentSkillNames?: readonly string[];
}

interface CompactionSessionState {
	readonly justCompacted?: boolean;
	readonly at?: number;
}

function toTurnContext(ctx: BuildContext): SkillsCatalogTurnContext {
	const skillState = (ctx.sessionState.skills ?? {}) as SkillsSessionState;
	return {
		availableToolNames: ctx.availableTools,
		availableToolsets: ctx.availableToolsets ?? [],
		minTrustLevel: ctx.minTrustLevel ?? "community",
		platform: process.platform,
		userInput: ctx.userInput,
		recentSkillNames: skillState.recentSkillNames ?? [],
	};
}

function shouldRenderPostCompact(ctx: BuildContext): boolean {
	const compaction = (ctx.sessionState.compaction ?? {}) as CompactionSessionState;
	return compaction.justCompacted === true;
}

function renderPostCompactSkills(
	result: PostCompactRestoreResult,
): string | null {
	if (result.entries.length === 0) {
		return null;
	}

	return [
		"<post_compact_skills>",
		...result.entries.map(
			(entry) =>
				`  <skill name="${entry.name}" source="${entry.source}" tokens="${entry.tokenEstimate}">\n${entry.body}\n  </skill>`,
		),
		"</post_compact_skills>",
	].join("\n");
}

export function createSkillsCatalogSection(
	source: SkillsCatalogSectionSource,
): PromptSection {
	return {
		name: "skills-catalog",
		order: SKILLS_CATALOG_ORDER,
		updateFrequency: "per_session",
		compute: (ctx) => {
			const descriptors = source.list();
			if (descriptors.length === 0) {
				return null;
			}
			return renderSkillsCatalog(descriptors, toTurnContext(ctx));
		},
	};
}

export function createHotSkillsSection(
	source: SkillsCatalogSectionSource,
): PromptSection {
	return {
		name: "hot-skills",
		order: HOT_SKILLS_ORDER,
		updateFrequency: "per_turn",
		compute: (ctx) => {
			const descriptors = source.list();
			if (descriptors.length === 0) {
				return null;
			}
			return renderHotSkillsCatalog(descriptors, toTurnContext(ctx));
		},
	};
}

export function createPostCompactSkillsSection(
	source: SkillsCatalogSectionSource,
): PromptSection {
	return {
		name: "post-compact-skills",
		order: POST_COMPACT_SKILLS_ORDER,
		updateFrequency: "per_turn",
		compute: (ctx) => {
			if (!shouldRenderPostCompact(ctx) || source.postCompactRestore == null) {
				return null;
			}

			const skillState = (ctx.sessionState.skills ?? {}) as SkillsSessionState;
			return renderPostCompactSkills(
				source.postCompactRestore({
					recentSkillNames: skillState.recentSkillNames ?? [],
				}),
			);
		},
	};
}
