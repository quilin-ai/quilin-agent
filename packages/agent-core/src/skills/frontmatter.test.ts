import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, parseSkillMarkdown } from "./frontmatter.js";

describe("parseSkillFrontmatter", () => {
	it("parses required fields and applies M0 defaults", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "web-scraping",
			description: "Extract structured data from websites",
		});

		expect(frontmatter).toEqual({
			name: "web-scraping",
			description: "Extract structured data from websites",
			mandatory: false,
			userInvocable: true,
			disableModelInvocation: false,
		});
	});

	it("normalizes equivalent kebab-case keys", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "crawl-page",
			description: "Read and summarize a web page",
			"allowed-tools": ["web_fetch", "web_search"],
			"when-to-use": "Use when a page needs to be summarized",
		});

		expect(frontmatter.allowedTools).toEqual(["web_fetch", "web_search"]);
		expect(frontmatter.whenToUse).toBe(
			"Use when a page needs to be summarized",
		);
	});

	it("parses M1 fields from top-level aliases and metadata.quilin", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "multi-tool-research",
			description: "Coordinate search and extraction",
			mandatory: true,
			requiresTools: ["web_fetch"],
			requires_toolsets: ["browser"],
			platforms: ["darwin", "linux"],
			metadata: {
				quilin: {
					trust: "trusted",
				},
			},
		});

		expect(frontmatter).toMatchObject({
			mandatory: true,
			requiresTools: ["web_fetch"],
			requiresToolsets: ["browser"],
			platforms: ["darwin", "linux"],
			trust: "trusted",
		});
	});

	it("lets top-level values win over metadata.quilin values", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "priority-check",
			description: "Verify field precedence",
			requiresTools: ["file_read"],
			trust: "trusted",
			metadata: {
				quilin: {
					requires_tools: ["web_fetch"],
					trust: "community",
				},
			},
		});

		expect(frontmatter.requiresTools).toEqual(["file_read"]);
		expect(frontmatter.trust).toBe("trusted");
	});

	it("ignores unknown fields", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "ignore-unknown",
			description: "Unknown fields should not break parsing",
			metadata: {
				quilin: {
					unknown_flag: "ignored",
				},
			},
			experimental: true,
		});

		expect(frontmatter).toMatchObject({
			name: "ignore-unknown",
			description: "Unknown fields should not break parsing",
		});
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

	it("parses nested metadata.quilin fields from markdown", () => {
		const parsed = parseSkillMarkdown(`---
name: planner-skill
description: Plan a complex task
metadata:
  quilin:
    requires_tools: [web_fetch, file_read]
    requires_toolsets: [browser]
    platforms: [darwin, linux]
    trust: trusted
---
# Planner Skill
`);

		expect(parsed.frontmatter).toMatchObject({
			requiresTools: ["web_fetch", "file_read"],
			requiresToolsets: ["browser"],
			platforms: ["darwin", "linux"],
			trust: "trusted",
		});
	});

	it("parses real upstream skill fixtures without translation", () => {
		const fixturePaths = [
			fileURLToPath(
				new URL(
					"../../../../upstreams/llm-vercel-ai/skills/add-provider-package/SKILL.md",
					import.meta.url,
				),
			),
			fileURLToPath(
				new URL(
					"../../../../upstreams/llm-vercel-ai/skills/adr-skill/SKILL.md",
					import.meta.url,
				),
			),
		];

		for (const fixturePath of fixturePaths) {
			const parsed = parseSkillMarkdown(readFileSync(fixturePath, "utf8"));
			expect(parsed.frontmatter.name).toMatch(/^[a-z0-9-]+$/);
			expect(parsed.frontmatter.description.length).toBeGreaterThan(0);
		}
	});

	it("rejects markdown without frontmatter block", () => {
		expect(() => parseSkillMarkdown("# no frontmatter")).toThrow(
			"SKILL.md must start with YAML frontmatter",
		);
	});
});
