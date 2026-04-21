import { describe, expect, it } from "vitest";
import { renderSkillsCatalog } from "./catalog-renderer.js";
import type { SkillDescriptor } from "./types.js";

const descriptor: SkillDescriptor = {
	name: "web-scraping",
	description:
		"Extract structured data from websites and return machine-usable JSON output.",
	path: "/tmp/skills/web-scraping/SKILL.md",
	source: "bundled",
	frontmatter: {
		name: "web-scraping",
		description:
			"Extract structured data from websites and return machine-usable JSON output.",
		whenToUse: "User asks to scrape or extract from a URL",
		allowedTools: ["web_fetch", "web_search"],
		userInvocable: true,
		disableModelInvocation: false,
		mandatory: false,
		trust: "community",
	},
};

const baseTurnContext = {
	availableToolNames: ["web_fetch", "web_search"],
	availableToolsets: ["browser"],
	minTrustLevel: "community" as const,
	platform: "linux" as const,
};

describe("renderSkillsCatalog", () => {
	it("renders available skills block and truncates long descriptions", () => {
		const xml = renderSkillsCatalog([descriptor], baseTurnContext);

		expect(xml).toContain("<available_skills>");
		expect(xml).toContain('name="web-scraping"');
		expect(xml).toContain('source="bundled"');
		expect(xml).toContain("Extract structured data from websites and return machine-usab");
		expect(xml).not.toContain("JSON output.");
		expect(xml).toContain('when_to_use="User asks to scrape or extract from a URL"');
		expect(xml).toContain('allowed_tools="web_fetch,web_search"');
	});

	it("filters out skills when required tools are missing", () => {
		const xml = renderSkillsCatalog(
			[
				{
					...descriptor,
					frontmatter: {
						...descriptor.frontmatter,
						requiresTools: ["shell_exec"],
					},
				},
			],
			baseTurnContext,
		);

		expect(xml).toBe("<available_skills />");
	});

	it("filters out skills when required toolsets are missing", () => {
		const xml = renderSkillsCatalog(
			[
				{
					...descriptor,
					frontmatter: {
						...descriptor.frontmatter,
						requiresToolsets: ["filesystem"],
					},
				},
			],
			baseTurnContext,
		);

		expect(xml).toBe("<available_skills />");
	});

	it("filters out skills when the platform does not match", () => {
		const xml = renderSkillsCatalog(
			[
				{
					...descriptor,
					frontmatter: {
						...descriptor.frontmatter,
						platforms: ["darwin"],
					},
				},
			],
			baseTurnContext,
		);

		expect(xml).toBe("<available_skills />");
	});

	it("filters out skills below the minimum trust level", () => {
		const xml = renderSkillsCatalog(
			[descriptor],
			{
				...baseTurnContext,
				minTrustLevel: "trusted",
			},
		);

		expect(xml).toBe("<available_skills />");
	});

	it("keeps skills when all activation filters pass", () => {
		const xml = renderSkillsCatalog(
			[
				{
					...descriptor,
					frontmatter: {
						...descriptor.frontmatter,
						requiresTools: ["web_fetch"],
						requiresToolsets: ["browser"],
						platforms: ["linux"],
						trust: "trusted",
					},
				},
			],
			{
				...baseTurnContext,
				minTrustLevel: "community",
			},
		);

		expect(xml).toContain('name="web-scraping"');
	});

	it("drops mandatory for non-bundled and non-user skills", () => {
		const xml = renderSkillsCatalog(
			[
				{
					...descriptor,
					source: "plugin",
					frontmatter: {
						...descriptor.frontmatter,
						mandatory: true,
					},
				},
			],
			baseTurnContext,
		);

		expect(xml).not.toContain('mandatory="true"');
	});

	it("keeps mandatory for user skills", () => {
		const xml = renderSkillsCatalog(
			[
				{
					...descriptor,
					source: "user",
					frontmatter: {
						...descriptor.frontmatter,
						mandatory: true,
					},
				},
			],
			baseTurnContext,
		);

		expect(xml).toContain('mandatory="true"');
	});
});
