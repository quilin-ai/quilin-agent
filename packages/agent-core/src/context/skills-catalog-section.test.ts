import { describe, expect, it } from "vitest";
import type { SkillDescriptor } from "../skills/types.js";
import { createSkillsCatalogSection } from "./skills-catalog-section.js";
import type { BuildContext } from "./prompt-types.js";

function makeDescriptor(name: string): SkillDescriptor {
	return {
		name,
		description: `Skill ${name} description`,
		path: `/tmp/${name}/SKILL.md`,
		source: "bundled",
		frontmatter: {
			name,
			description: `Skill ${name} description`,
			whenToUse: `When ${name} is relevant`,
			userInvocable: true,
			disableModelInvocation: false,
			trust: "builtin",
		},
	};
}

const baseCtx: BuildContext = {
	userInput: "",
	sessionState: {},
	modelId: "test-model",
	availableTools: [],
	profile: "full",
};

describe("createSkillsCatalogSection", () => {
	it("renders descriptors as <available_skills> XML", () => {
		const section = createSkillsCatalogSection({
			list: () => [makeDescriptor("alpha"), makeDescriptor("beta")],
		});

		const output = section.compute(baseCtx);
		expect(output).toContain("<available_skills>");
		expect(output).toContain('name="alpha"');
		expect(output).toContain('name="beta"');
		expect(output).toContain("</available_skills>");
	});

	it("returns null when no descriptors are available (section omitted)", () => {
		const section = createSkillsCatalogSection({ list: () => [] });
		expect(section.compute(baseCtx)).toBeNull();
	});

	it("exposes per_session update frequency and order=50", () => {
		const section = createSkillsCatalogSection({ list: () => [] });
		expect(section.name).toBe("skills-catalog");
		expect(section.order).toBe(50);
		expect(section.updateFrequency).toBe("per_session");
	});

	it("reflects manager state changes on subsequent renders", () => {
		let descriptors: readonly SkillDescriptor[] = [];
		const section = createSkillsCatalogSection({ list: () => descriptors });

		expect(section.compute(baseCtx)).toBeNull();

		descriptors = [makeDescriptor("gamma")];
		const output = section.compute(baseCtx);
		expect(output).toContain('name="gamma"');
	});
});
