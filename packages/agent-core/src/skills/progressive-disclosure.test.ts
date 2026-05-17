import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_SECTIONS,
	expandSection,
	progressiveDisclose,
	scoreSection,
	splitIntoSections,
	tokenizeQuery,
} from "./progressive-disclosure.js";
import type { LoadedSkill, SkillDescriptor } from "./types.js";

function makeLoadedSkill(body: string, name = "demo-skill"): LoadedSkill {
	const descriptor: SkillDescriptor = {
		name,
		description: `${name} description`,
		path: `/tmp/${name}/SKILL.md`,
		source: "user",
		frontmatter: {
			name,
			description: `${name} description`,
			userInvocable: true,
			disableModelInvocation: false,
			trust: "community",
		},
	};
	return { descriptor, body, tokenEstimate: Math.max(1, body.length / 4) };
}

const sampleBody = `Intro paragraph that explains the skill at a high level.
It spans multiple lines but has no heading.

## Installation
Run pnpm install and configure the environment variables.

## Usage
Call the run() function with the input payload.
This section talks about input payload handling and error retries.

## Error handling
Handle network errors with exponential backoff.
Database errors should bubble up to the caller.

## FAQ
### Why is the cache slow
Because the LRU cap is too low — increase it.

### How to disable telemetry
Set TELEMETRY_DISABLED=1.
`;

describe("splitIntoSections", () => {
	it("splits markdown into sections by heading and preserves prelude", () => {
		const sections = splitIntoSections(sampleBody);
		const headings = sections.map((entry) => entry.heading);
		expect(headings).toEqual([
			"",
			"Installation",
			"Usage",
			"Error handling",
			"FAQ",
			"Why is the cache slow",
			"How to disable telemetry",
		]);
		expect(sections[0]?.level).toBe(1);
		expect(sections[5]?.level).toBe(3);
	});

	it("returns empty list for empty body", () => {
		expect(splitIntoSections("")).toEqual([]);
	});

	it("treats body with no heading as a single anonymous section", () => {
		const sections = splitIntoSections(
			"just some text without any heading\nstill no heading here.",
		);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.heading).toBe("");
		expect(sections[0]?.content).toContain("just some text");
	});

	it("ignores prelude that is only whitespace", () => {
		const sections = splitIntoSections("\n\n## Real\nbody\n");
		expect(sections).toHaveLength(1);
		expect(sections[0]?.heading).toBe("Real");
	});

	it("clamps heading level above 6 down to 6", () => {
		const sections = splitIntoSections("####### way too deep\nbody\n");
		// 7 # symbols are not a valid markdown heading, so the line is treated
		// as content; the body becomes an anonymous section.
		expect(sections).toHaveLength(1);
		expect(sections[0]?.heading).toBe("");
	});

	it("accepts H6 headings without further clamping", () => {
		const sections = splitIntoSections("###### deep\nbody\n");
		expect(sections).toHaveLength(1);
		expect(sections[0]?.heading).toBe("deep");
		expect(sections[0]?.level).toBe(6);
	});

	it("accepts H1 headings and reports level 1", () => {
		const sections = splitIntoSections("# Top Heading\nbody one\n");
		expect(sections).toHaveLength(1);
		expect(sections[0]?.heading).toBe("Top Heading");
		expect(sections[0]?.level).toBe(1);
	});

	it("drops a heading whose body is whitespace-only", () => {
		const sections = splitIntoSections(
			"## First\n\n## Second\nreal content\n",
		);
		// First heading has whitespace-only content and IS still emitted
		// because the heading itself is non-empty.
		expect(sections.map((entry) => entry.heading)).toEqual([
			"First",
			"Second",
		]);
	});
});

describe("tokenizeQuery + scoreSection", () => {
	it("tokenizes a query and drops stopwords", () => {
		expect(tokenizeQuery("How to handle the network errors")).toEqual([
			"handle",
			"network",
			"errors",
		]);
	});

	it("weights heading matches higher than content matches", () => {
		const sections = splitIntoSections(sampleBody);
		const usage = sections.find((entry) => entry.heading === "Usage");
		const errorHandling = sections.find(
			(entry) => entry.heading === "Error handling",
		);
		expect(usage).toBeDefined();
		expect(errorHandling).toBeDefined();

		const query = tokenizeQuery("error retry handling");
		const usageScore = scoreSection(usage as NonNullable<typeof usage>, query);
		const errorScore = scoreSection(
			errorHandling as NonNullable<typeof errorHandling>,
			query,
		);
		// heading "Error handling" matches both "error" and "handling" (heading
		// weight 3x each), while "Usage" only catches "error"/"retries" in body
		// at weight 1.
		expect(errorScore.score).toBeGreaterThan(usageScore.score);
	});

	it("returns zero score when query is empty", () => {
		const sections = splitIntoSections(sampleBody);
		const target = sections[1] as NonNullable<(typeof sections)[number]>;
		expect(scoreSection(target, []).score).toBe(0);
	});
});

describe("progressiveDisclose", () => {
	it("returns top-K sections matching the query plus TOC and hint", () => {
		const skill = makeLoadedSkill(sampleBody);
		const result = progressiveDisclose({
			skill,
			query: "how to handle network errors",
			maxSections: 2,
		});

		expect(result.skillName).toBe("demo-skill");
		expect(result.selected.map((entry) => entry.section.heading)).toContain(
			"Error handling",
		);
		expect(result.selected.length).toBeLessThanOrEqual(2);
		expect(result.toc.length).toBeGreaterThan(result.selected.length);
		expect(result.omittedHeadings).toContain("Installation");
		expect(result.hint).toMatch(/expand_section\('demo-skill'/u);
		expect(result.totalSections).toBeGreaterThanOrEqual(result.toc.length);
	});

	it("returns prelude truncated to preludeChars with ellipsis", () => {
		const skill = makeLoadedSkill(sampleBody);
		const result = progressiveDisclose({
			skill,
			query: "installation",
			preludeChars: 20,
		});
		expect(result.prelude.endsWith("…")).toBe(true);
		expect(result.prelude.length).toBeLessThanOrEqual(21);
	});

	it("falls back to no selection when query has no matches", () => {
		const skill = makeLoadedSkill(sampleBody);
		const result = progressiveDisclose({
			skill,
			query: "completely unrelated zzzqqqxxx",
		});
		expect(result.selected).toEqual([]);
		expect(result.hint).toMatch(/no sections matched/u);
	});

	it("emits 'entire skill body has been disclosed' when nothing was omitted", () => {
		const skill = makeLoadedSkill("## Only Section\nonly content here.");
		const result = progressiveDisclose({
			skill,
			query: "only section content",
			maxSections: DEFAULT_MAX_SECTIONS,
		});
		expect(result.selected).toHaveLength(1);
		expect(result.omittedHeadings).toEqual([]);
		expect(result.hint).toMatch(/entire skill body/u);
	});

	it("respects custom minScore filter", () => {
		const skill = makeLoadedSkill(sampleBody);
		// A query with only weak (content-only) matches scores well below 1.0.
		// Filtering at >= 1.0 strips all matches because heading weight is 3x.
		const result = progressiveDisclose({
			skill,
			query: "retries payload",
			minScore: 1,
		});
		expect(result.selected).toEqual([]);
	});

	it("handles empty body gracefully", () => {
		const skill = makeLoadedSkill("");
		const result = progressiveDisclose({ skill, query: "anything" });
		expect(result.selected).toEqual([]);
		expect(result.toc).toEqual([]);
		expect(result.prelude).toBe("");
		expect(result.totalSections).toBe(0);
	});

	it("returns full prelude when shorter than preludeChars cap", () => {
		const skill = makeLoadedSkill("short intro\n## Heading\nbody");
		const result = progressiveDisclose({
			skill,
			query: "heading",
			preludeChars: 200,
		});
		expect(result.prelude).toBe("short intro");
	});
});

describe("progressiveDisclose edge cases", () => {
	it("breaks ties via original document order", () => {
		// Two sections with identical content tokens — query matches both
		// at the same score; the section that appears first in the document
		// must be returned first.
		const body =
			"## First match\nshared keyword foo\n\n## Second match\nshared keyword foo\n";
		const skill = makeLoadedSkill(body);
		const result = progressiveDisclose({
			skill,
			query: "shared keyword foo",
			maxSections: 5,
		});
		expect(result.selected.map((entry) => entry.section.heading)).toEqual([
			"First match",
			"Second match",
		]);
	});

	it("sorts by score primarily and uses TOC across mixed scores + ties", () => {
		// Build a body with: high-score heading match, two equal-score
		// content-only matches, and one unrelated section. This exercises
		// both branches of the sort comparator.
		const body = `## High score alpha
alpha is in the heading already.

## Mid score one
beta beta beta.

## Mid score two
beta beta beta.

## Unrelated
nothing useful here.
`;
		const skill = makeLoadedSkill(body);
		const result = progressiveDisclose({
			skill,
			query: "alpha beta",
			maxSections: 3,
		});
		expect(result.selected[0]?.section.heading).toBe("High score alpha");
		expect(
			result.selected.slice(1).map((entry) => entry.section.heading),
		).toEqual(["Mid score one", "Mid score two"]);
	});

	it("returns empty prelude when preludeChars is zero", () => {
		const skill = makeLoadedSkill(sampleBody);
		const result = progressiveDisclose({
			skill,
			query: "installation",
			preludeChars: 0,
		});
		expect(result.prelude).toBe("");
	});

	it("uses the first heading when the body has no prelude text", () => {
		const skill = makeLoadedSkill("## Heading One\nbody one\n");
		const result = progressiveDisclose({
			skill,
			query: "heading",
			preludeChars: 200,
		});
		expect(result.prelude).toContain("Heading One");
	});

	it("clamps maxSections to zero when given a negative value", () => {
		const skill = makeLoadedSkill(sampleBody);
		const result = progressiveDisclose({
			skill,
			query: "installation",
			maxSections: -5,
		});
		expect(result.selected).toEqual([]);
	});
});

describe("expandSection", () => {
	it("returns the section content for a known heading (case-insensitive)", () => {
		const skill = makeLoadedSkill(sampleBody);
		const section = expandSection(skill, "  error HANDLING  ");
		expect(section).not.toBeNull();
		expect(section?.heading).toBe("Error handling");
		expect(section?.content).toMatch(/exponential backoff/u);
	});

	it("returns null for an unknown heading", () => {
		const skill = makeLoadedSkill(sampleBody);
		expect(expandSection(skill, "Nonexistent")).toBeNull();
	});

	it("returns null for an empty heading", () => {
		const skill = makeLoadedSkill(sampleBody);
		expect(expandSection(skill, "   ")).toBeNull();
	});
});
