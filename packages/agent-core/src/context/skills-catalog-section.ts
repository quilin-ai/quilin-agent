import {
	renderSkillsCatalog,
	type SkillsCatalogTurnContext,
} from "../skills/catalog-renderer.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { BuildContext, PromptSection } from "./prompt-types.js";

export interface SkillsCatalogSectionSource {
	list(): readonly SkillDescriptor[];
}

const SKILLS_CATALOG_ORDER = 50;

function toTurnContext(ctx: BuildContext): SkillsCatalogTurnContext {
	return {
		availableToolNames: ctx.availableTools,
		availableToolsets: ctx.availableToolsets ?? [],
		minTrustLevel: ctx.minTrustLevel ?? "community",
		platform: process.platform,
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
