import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	renderHotSkillsCatalog,
	renderSkillsCatalog,
} from "./catalog-renderer.js";
import type { SkillDescriptor, SkillFrontmatter } from "./types.js";

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
	userInput: "",
	recentSkillNames: [],
};

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

type DescriptorOverrides = Omit<Partial<SkillDescriptor>, "frontmatter"> & {
	readonly frontmatter?: Partial<SkillFrontmatter>;
};

function makeDescriptor(
	name: string,
	overrides: DescriptorOverrides = {},
): SkillDescriptor {
	const overrideFrontmatter = overrides.frontmatter ?? {};
	const frontmatter = Object.assign({}, descriptor.frontmatter, {
		name,
		description: `Skill ${name} description`,
		mandatory: false,
	}, overrideFrontmatter);

	return {
		...descriptor,
		name,
		description: `Skill ${name} description`,
		path: `/tmp/${name}/SKILL.md`,
		...overrides,
		frontmatter,
	};
}

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

	it("keeps the stable prefix lexicographically sorted and hash-stable across recency changes", () => {
		const descriptors = [
			makeDescriptor("zeta", { source: "user" }),
			makeDescriptor("alpha", { source: "bundled" }),
			makeDescriptor("mid", { source: "user" }),
		];

		const first = renderSkillsCatalog(descriptors, {
			...baseTurnContext,
			recentSkillNames: ["zeta", "alpha", "mid"],
			userInput: "mid zeta",
		});
		const second = renderSkillsCatalog(descriptors, {
			...baseTurnContext,
			recentSkillNames: ["alpha", "mid", "zeta"],
			userInput: "alpha",
		});

		expect(first).toContain('name="alpha"');
		expect(first).toContain('name="mid"');
		expect(first).toContain('name="zeta"');
		expect(first.indexOf('name="alpha"')).toBeLessThan(
			first.indexOf('name="mid"'),
		);
		expect(first.indexOf('name="mid"')).toBeLessThan(
			first.indexOf('name="zeta"'),
		);
		expect(stableHash(first)).toBe(stableHash(second));
	});

	it("does not allow plugin mandatory to enter stable prefix even if P1-a normalization is bypassed", () => {
		const xml = renderSkillsCatalog(
			[
				makeDescriptor("forced-plugin", {
					source: "plugin",
					frontmatter: {
						mandatory: true,
					},
				}),
			],
			baseTurnContext,
		);

		expect(xml).toBe("<available_skills />");
	});
});

describe("renderHotSkillsCatalog", () => {
	it("renders hot skills as a separate XML block", () => {
		const xml = renderHotSkillsCatalog(
			[
				makeDescriptor("project-skill", {
					source: "project",
				}),
			],
			baseTurnContext,
		);

		expect(xml).toContain("<hot_skills>");
		expect(xml).toContain('name="project-skill"');
	});

	it("limits hot skills to 10 entries", () => {
		const descriptors = Array.from({ length: 15 }, (_, index) =>
			makeDescriptor(`project-skill-${index}`, {
				source: "project",
			}),
		);

		const xml = renderHotSkillsCatalog(descriptors, baseTurnContext);
		expect(xml.match(/<skill /g)?.length ?? 0).toBeLessThanOrEqual(10);
	});

	it("ranks hot skills by recency first and relevance second", () => {
		const xml = renderHotSkillsCatalog(
			[
				makeDescriptor("web-fetch-advanced", {
					source: "project",
				}),
				makeDescriptor("browser-automation", {
					source: "plugin",
				}),
				makeDescriptor("database-admin", {
					source: "project",
				}),
			],
			{
				...baseTurnContext,
				userInput: "browser automation",
				recentSkillNames: ["web-fetch-advanced", "database-admin"],
			},
		);

		expect(xml.indexOf('name="web-fetch-advanced"')).toBeLessThan(
			xml.indexOf('name="browser-automation"'),
		);
		expect(xml.indexOf('name="browser-automation"')).toBeLessThan(
			xml.indexOf('name="database-admin"'),
		);
	});

	it("keeps bypassed plugin mandatory skills in hot_skills instead of the stable prefix", () => {
		const xml = renderHotSkillsCatalog(
			[
				makeDescriptor("forced-plugin", {
					source: "plugin",
					frontmatter: {
						mandatory: true,
					},
				}),
			],
			baseTurnContext,
		);

		expect(xml).toContain("<hot_skills>");
		expect(xml).toContain('name="forced-plugin"');
		expect(xml).not.toContain('mandatory="true"');
	});
});
