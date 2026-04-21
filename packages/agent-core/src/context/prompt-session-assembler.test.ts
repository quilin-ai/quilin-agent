import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { PromptBuilder } from "./prompt-builder.js";
import { PromptSessionAssembler } from "./prompt-session-assembler.js";
import {
	createHotSkillsSection,
	createSkillsCatalogSection,
} from "./skills-catalog-section.js";
import type { SkillDescriptor } from "../skills/types.js";

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function makeSkill(
	name: string,
	source: SkillDescriptor["source"],
): SkillDescriptor {
	return {
		name,
		description: `Skill ${name} description`,
		path: `/tmp/${name}/SKILL.md`,
		source,
		frontmatter: {
			name,
			description: `Skill ${name} description`,
			whenToUse: `When ${name} is relevant`,
			mandatory: false,
			userInvocable: true,
			disableModelInvocation: false,
			trust: source === "bundled" ? "builtin" : "community",
		},
	};
}

describe("PromptSessionAssembler", () => {
	test("reuses per_session prompt sections across outbound builds", () => {
		const builder = new PromptBuilder();
		let counter = 0;
		builder.register({
			name: "identity",
			order: 10,
			updateFrequency: "per_session",
			compute: () => `value-${++counter}`,
		});

		const assembler = new PromptSessionAssembler({
			promptBuilder: builder,
			modelId: "deepseek-chat",
			sessionStartedAt: "2026-04-21T00:00:00.000Z",
			now: () => new Date("2026-04-21T10:00:00.000Z"),
		});

		const transcript = [{ role: "user", content: "hello" }] as const;
		const first = assembler.buildOutboundMessages({
			transcript,
			turnKind: "user-turn",
		});
		const second = assembler.buildOutboundMessages({
			transcript,
			turnKind: "user-turn",
		});

		expect(first[0]?.content).toContain("value-1");
		expect(second[0]?.content).toContain("value-1");
		expect(counter).toBe(1);
	});

	test("decorates only the outbound latest user message and leaves transcript untouched", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "identity",
			order: 10,
			updateFrequency: "static",
			compute: () => "You are Quilin Agent.",
		});

		const assembler = new PromptSessionAssembler({
			promptBuilder: builder,
			modelId: "deepseek-chat",
			sessionStartedAt: "2026-04-21T09:00:00.000Z",
			lastSessionEndedAt: "2026-04-20T23:00:00.000Z",
			now: () => new Date("2026-04-21T10:00:00.000Z"),
		});

		const transcript = [
			{ role: "user", content: "before" },
			{ role: "assistant", content: "after" },
			{ role: "user", content: "next" },
		] as const;
		const outbound = assembler.buildOutboundMessages({
			transcript,
			turnKind: "user-turn",
			lastMessageTime: "2026-04-21T09:57:00.000Z",
		});

		expect(outbound[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining("You are Quilin Agent."),
		});
		expect(outbound.at(-1)).toMatchObject({
			role: "user",
			content: expect.stringContaining("[时间上下文]"),
		});
		expect(outbound.at(-1)).toMatchObject({
			role: "user",
			content: expect.stringContaining("next"),
		});
		expect(transcript.at(-1)).toEqual({ role: "user", content: "next" });
	});

	test("returns the assembled prompt alongside outbound messages", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "identity",
			order: 10,
			updateFrequency: "static",
			compute: () => "You are Quilin Agent.",
		});

		const assembler = new PromptSessionAssembler({
			promptBuilder: builder,
			modelId: "deepseek-chat",
			sessionStartedAt: "2026-04-21T09:00:00.000Z",
			now: () => new Date("2026-04-21T10:00:00.000Z"),
		});

		const outbound = assembler.buildOutboundRequest({
			transcript: [{ role: "user", content: "next" }],
			turnKind: "user-turn",
		});

		expect(outbound.prompt.segments).toEqual([
			expect.objectContaining({
				id: "identity",
				role: "system",
			}),
		]);
		expect(outbound.messages[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining("You are Quilin Agent."),
		});
	});

	test("keeps stable skill prefix hash identical across three turns while hot skills vary", () => {
		const builder = new PromptBuilder();
		const descriptors = [
			makeSkill("alpha", "bundled"),
			makeSkill("zeta", "user"),
			makeSkill("browser-automation", "project"),
			makeSkill("db-inspector", "plugin"),
		];
		const state = {
			recentSkillNames: ["browser-automation"],
		};

		builder.register(createSkillsCatalogSection({ list: () => descriptors }));
		builder.register(createHotSkillsSection({ list: () => descriptors }));

		const assembler = new PromptSessionAssembler({
			promptBuilder: builder,
			modelId: "deepseek-chat",
			sessionStartedAt: "2026-04-21T09:00:00.000Z",
			now: () => new Date("2026-04-21T10:00:00.000Z"),
			getSessionState: () => ({
				skills: {
					recentSkillNames: state.recentSkillNames,
				},
			}),
		});

		const first = assembler.buildOutboundRequest({
			transcript: [{ role: "user", content: "browser automation" }],
			turnKind: "user-turn",
		});

		state.recentSkillNames = ["db-inspector", "browser-automation"];
		const second = assembler.buildOutboundRequest({
			transcript: [{ role: "user", content: "database inspection" }],
			turnKind: "user-turn",
		});

		state.recentSkillNames = ["browser-automation", "db-inspector"];
		const third = assembler.buildOutboundRequest({
			transcript: [{ role: "user", content: "browser again" }],
			turnKind: "user-turn",
		});

		expect(stableHash(first.prompt.staticPrefix)).toBe(
			stableHash(second.prompt.staticPrefix),
		);
		expect(stableHash(second.prompt.staticPrefix)).toBe(
			stableHash(third.prompt.staticPrefix),
		);
		expect(first.prompt.staticPrefix).toContain('name="alpha"');
		expect(first.prompt.staticPrefix).toContain('name="zeta"');
		expect(first.prompt.staticPrefix).not.toContain("<hot_skills>");
		expect(first.prompt.dynamicSuffix).toContain("<hot_skills>");
		expect(second.prompt.dynamicSuffix).toContain('name="db-inspector"');
		expect(third.prompt.dynamicSuffix).toContain('name="browser-automation"');
	});
});
