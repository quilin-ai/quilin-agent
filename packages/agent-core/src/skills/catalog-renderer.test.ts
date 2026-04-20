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
		trust: "community",
	},
};

describe("renderSkillsCatalog", () => {
	it("renders available skills block and truncates long descriptions", () => {
		const xml = renderSkillsCatalog([descriptor]);

		expect(xml).toContain("<available_skills>");
		expect(xml).toContain('name="web-scraping"');
		expect(xml).toContain('source="bundled"');
		expect(xml).toContain("Extract structured data from websites and return machine-usab");
		expect(xml).not.toContain("JSON output.");
		expect(xml).toContain('when_to_use="User asks to scrape or extract from a URL"');
		expect(xml).toContain('allowed_tools="web_fetch,web_search"');
	});
});
