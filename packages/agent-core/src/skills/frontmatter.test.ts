import { existsSync, readFileSync } from "node:fs";
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

	it("rejects invalid field types and trust values", () => {
		expect(() =>
			parseSkillFrontmatter({
				name: 123,
				description: "name must be a string",
			}),
		).toThrow("name must be a string");

		expect(() =>
			parseSkillFrontmatter({
				name: "blank-description",
				description: "   ",
			}),
		).toThrow("requires description");

		expect(() =>
			parseSkillFrontmatter({
				name: "bad-tools",
				description: "allowedTools must be an array",
				allowedTools: "web_fetch",
			}),
		).toThrow("allowedTools must be an array");

		expect(() =>
			parseSkillFrontmatter({
				name: "bad-tool-entry",
				description: "requiresTools entries must be strings",
				requiresTools: ["web_fetch", 1],
			}),
		).toThrow("requiresTools must contain strings");

		expect(() =>
			parseSkillFrontmatter({
				name: "bad-bool",
				description: "mandatory must be boolean",
				mandatory: "true",
			}),
		).toThrow("boolean field has invalid value");

		expect(() =>
			parseSkillFrontmatter({
				name: "bad-metadata",
				description: "metadata must be object",
				metadata: [],
			}),
		).toThrow("metadata must be an object");

		expect(() =>
			parseSkillFrontmatter({
				name: "bad-quilin-metadata",
				description: "metadata.quilin must be object",
				metadata: { quilin: [] },
			}),
		).toThrow("metadata.quilin must be an object");

		expect(() =>
			parseSkillFrontmatter({
				name: "bad-trust",
				description: "trust must be recognized",
				trust: "local",
			}),
		).toThrow("trust must be a valid trust level");
	});

	it("rejects overlong names and descriptions", () => {
		expect(() =>
			parseSkillFrontmatter({
				name: "a".repeat(65),
				description: "name too long",
			}),
		).toThrow("Skill name exceeds 64 characters");

		expect(() =>
			parseSkillFrontmatter({
				name: "description-too-long",
				description: "a".repeat(1025),
			}),
		).toThrow("Skill description exceeds 1024 characters");
	});

	it("normalizes blank optional strings to undefined", () => {
		const frontmatter = parseSkillFrontmatter({
			name: "blank-optionals",
			description: "Blank optional fields are ignored",
			whenToUse: "   ",
			version: "  ",
		});

		expect(frontmatter.whenToUse).toBeUndefined();
		expect(frontmatter.version).toBeUndefined();
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

	it("parses quoted scalars, comments, empty arrays, and explicit booleans", () => {
		const parsed = parseSkillMarkdown(`---
# comment lines are ignored
ignored malformed line
name: "quoted-skill"
description: 'Quoted description'
when-to-use: "Use when quoting matters"
allowedTools: []
userInvocable: false
disableModelInvocation: true
version: "1.0.0"
---
Body
`);

		expect(parsed.frontmatter).toMatchObject({
			name: "quoted-skill",
			description: "Quoted description",
			whenToUse: "Use when quoting matters",
			allowedTools: [],
			userInvocable: false,
			disableModelInvocation: true,
			version: "1.0.0",
		});
		expect(parsed.body).toBe("Body\n");
	});

	const upstreamFixturePaths = [
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
	const upstreamsAvailable = upstreamFixturePaths.every((p) => existsSync(p));
	const upstreamStyleFixtures = upstreamsAvailable
		? upstreamFixturePaths.map((fixturePath) =>
				readFileSync(fixturePath, "utf8"),
			)
		: [
				`---
name: add-provider-package
description: Add a provider package to the project dependencies
when-to-use: Use when wiring a new model provider
allowedTools:
  - shell_exec
userInvocable: false
disableModelInvocation: false
---
# Add Provider Package
`,
				`---
name: adr-skill
description: Draft an architecture decision record
whenToUse: Use when a technical decision needs to be recorded
allowedTools: []
userInvocable: true
disableModelInvocation: false
---
# ADR Skill
`,
			];

	it("parses upstream-style skill fixtures without translation", () => {
		for (const content of upstreamStyleFixtures) {
			const parsed = parseSkillMarkdown(content);
			expect(parsed.frontmatter.name).toMatch(/^[a-z0-9-]+$/);
			expect(parsed.frontmatter.description.length).toBeGreaterThan(0);
		}
	});

	it("rejects markdown without frontmatter block", () => {
		expect(() => parseSkillMarkdown("# no frontmatter")).toThrow(
			"SKILL.md must start with YAML frontmatter",
		);
	});

	it("rejects malformed frontmatter delimiters", () => {
		expect(() =>
			parseSkillMarkdown(`---
name: malformed
description: Missing closing delimiter
`),
		).toThrow("SKILL.md frontmatter block is malformed");
	});
});
