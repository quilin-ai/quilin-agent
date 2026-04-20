import { renderSkillsCatalog } from "../skills/catalog-renderer.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { PromptSection } from "./prompt-types.js";

export interface SkillsCatalogSectionSource {
	list(): readonly SkillDescriptor[];
}

const SKILLS_CATALOG_ORDER = 50;

export function createSkillsCatalogSection(
	source: SkillsCatalogSectionSource,
): PromptSection {
	return {
		name: "skills-catalog",
		order: SKILLS_CATALOG_ORDER,
		updateFrequency: "per_session",
		compute: () => {
			const descriptors = source.list();
			if (descriptors.length === 0) {
				return null;
			}
			return renderSkillsCatalog(descriptors);
		},
	};
}
