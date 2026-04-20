import { describe, expect, test } from "vitest";
import { PromptBuilder } from "./prompt-builder.js";
import { PromptSessionAssembler } from "./prompt-session-assembler.js";

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
});
