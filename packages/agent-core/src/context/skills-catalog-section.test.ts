import { describe, expect, it } from "vitest";
import type { SkillDescriptor } from "../skills/types.js";
import {
	createHotSkillsSection,
	createSkillsCatalogSection,
} from "./skills-catalog-section.js";
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
			mandatory: false,
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

	it("filters descriptors based on available tools from build context", () => {
		const section = createSkillsCatalogSection({
			list: () => [
				{
					...makeDescriptor("browser-skill"),
					frontmatter: {
						...makeDescriptor("browser-skill").frontmatter,
						requiresTools: ["web_fetch"],
					},
				},
			],
		});

		expect(
			section.compute({
				...baseCtx,
				availableTools: [],
			}),
		).toBe("<available_skills />");

		expect(
			section.compute({
				...baseCtx,
				availableTools: ["web_fetch"],
			}),
		).toContain('name="browser-skill"');
	});

	it("only keeps stable-prefix descriptors in the per_session section", () => {
		const section = createSkillsCatalogSection({
			list: () => [
				makeDescriptor("bundled-skill"),
				{
					...makeDescriptor("project-skill"),
					source: "project",
				},
			],
		});

		const output = section.compute(baseCtx);
		expect(output).toContain('name="bundled-skill"');
		expect(output).not.toContain('name="project-skill"');
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

describe("createHotSkillsSection", () => {
	it("renders project and plugin skills into a per_turn hot-skills block", () => {
		const section = createHotSkillsSection({
			list: () => [
				{
					...makeDescriptor("project-skill"),
					source: "project",
				},
			],
		});

		const output = section.compute({
			...baseCtx,
			userInput: "project",
		});

		expect(output).toContain("<hot_skills>");
		expect(output).toContain('name="project-skill"');
		expect(section.updateFrequency).toBe("per_turn");
		expect(section.order).toBe(55);
	});

	it("uses sessionState recentSkillNames to rank hot skills", () => {
		const section = createHotSkillsSection({
			list: () => [
				{
					...makeDescriptor("alpha"),
					source: "project",
				},
				{
					...makeDescriptor("beta"),
					source: "project",
				},
			],
		});

		const output = section.compute({
			...baseCtx,
			sessionState: {
				skills: {
					recentSkillNames: ["beta", "alpha"],
				},
			},
		});

		if (output == null) {
			throw new Error("expected hot skills output");
		}
		expect(output.indexOf('name="beta"')).toBeLessThan(
			output.indexOf('name="alpha"'),
		);
	});
});
