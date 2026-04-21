import {
	renderHotSkillsCatalog,
	renderSkillsCatalog,
	type SkillsCatalogTurnContext,
} from "../skills/catalog-renderer.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { BuildContext, PromptSection } from "./prompt-types.js";

export interface SkillsCatalogSectionSource {
	list(): readonly SkillDescriptor[];
}

const SKILLS_CATALOG_ORDER = 50;
const HOT_SKILLS_ORDER = 55;

interface SkillsSessionState {
	readonly recentSkillNames?: readonly string[];
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
