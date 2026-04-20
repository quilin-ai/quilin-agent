import { describe, expect, it } from "vitest";
import {
	parseSkillFrontmatter,
	parseSkillMarkdown,
} from "./frontmatter.js";

describe("parseSkillFrontmatter", () => {
	it("parses required fields and applies M0 defaults", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "web-scraping",
			description: "Extract structured data from websites",
		});

		expect(frontmatter).toEqual({
			name: "web-scraping",
			description: "Extract structured data from websites",
			userInvocable: true,
			disableModelInvocation: false,
			trust: "community",
		});
	});

	it("normalizes equivalent anthropic keys", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "crawl-page",
			description: "Read and summarize a web page",
			"allowed-tools": ["web_fetch", "web_search"],
		});

		expect(frontmatter.allowedTools).toEqual(["web_fetch", "web_search"]);
	});

	it("rejects missing required fields", () => {
		expect(() =>
			parseSkillFrontmatter({
				description: "missing name",
			}),
		).toThrow("Skill frontmatter requires name");

		expect(() =>
			parseSkillFrontmatter({
				name: "missing-description",
			}),
		).toThrow("Skill frontmatter requires description");
	});

	it("rejects invalid skill names", () => {
		expect(() =>
			parseSkillFrontmatter({
				name: "Bad Name",
				description: "invalid name format",
			}),
		).toThrow("Skill name must be kebab-case");
	});
});

describe("parseSkillMarkdown", () => {
	it("extracts frontmatter and body from SKILL.md", () => {
		const parsed = parseSkillMarkdown(`---
name: web-scraping
description: Extract structured data from websites
whenToUse: User asks to scrape a URL
---
# Web Scraping

Use browser + parser tools.
`);

		expect(parsed.frontmatter).toMatchObject({
			name: "web-scraping",
			description: "Extract structured data from websites",
			whenToUse: "User asks to scrape a URL",
		});
		expect(parsed.body).toContain("# Web Scraping");
	});

	it("rejects markdown without frontmatter block", () => {
		expect(() => parseSkillMarkdown("# no frontmatter")).toThrow(
			"SKILL.md must start with YAML frontmatter",
		);
	});
});
