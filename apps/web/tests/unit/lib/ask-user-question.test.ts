/**
 * Unit tests for `ask_user_question` tool — Iter F Slice 3a.
 *
 * Tool execution flow is exercised end-to-end with a fake AgentService
 * and a fake awaitAsk: we record the emitted event, immediately resolve
 * the pending Promise with a synthetic reply, and verify the tool's
 * returned string matches the prompt-engineering contract.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentReplyPayload, AgentServiceLike } from "@/lib/agent-service-client";
import { formatReplyForLlm, makeAskUserQuestionTool } from "@/lib/tools/ask-user-question";

function makeFakeService(): {
	service: AgentServiceLike;
	emitted: Array<{ sessionId: string; payload: unknown }>;
} {
	const emitted: Array<{ sessionId: string; payload: unknown }> = [];
	const service = {
		emitFromRunner: (sessionId: string, payload: unknown) => {
			emitted.push({ sessionId, payload });
		},
	} as unknown as AgentServiceLike;
	return { service, emitted };
}

describe("makeAskUserQuestionTool", () => {
	it("emits ask_user_question event and returns formatted single-select answer", async () => {
		const { service, emitted } = makeFakeService();
		const awaitAsk = vi.fn(() => ({
			askToken: "fake-token-abc",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_answered_question",
				askId: "fixed-id",
				answer: { mode: "single", selectedId: "opt-a" },
			}),
		}));

		const askTool = makeAskUserQuestionTool({
			sessionId: "sess-1",
			service,
			awaitAsk,
			generateAskId: () => "fixed-id",
		});

		const execute = askTool.execute;
		if (execute == null) throw new Error("tool.execute should be defined");
		const result = await execute(
			{
				question: "Which library?",
				mode: "single",
				options: [
					{ id: "opt-a", label: "A library" },
					{ id: "opt-b", label: "B library" },
				],
			},
			{ toolCallId: "tc-1", messages: [] },
		);

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.sessionId).toBe("sess-1");
		const payload = emitted[0]?.payload as Record<string, unknown>;
		expect(payload.type).toBe("ask_user_question");
		expect(payload.askId).toBe("fixed-id");
		expect(payload.mode).toBe("single");

		expect(awaitAsk).toHaveBeenCalledWith({
			sessionId: "sess-1",
			askId: "fixed-id",
			kind: "user_answered_question",
			timeoutMs: 5 * 60 * 1000,
		});

		expect(result).toContain("selected_id=opt-a");
		expect(result).toContain('label="A library"');
	});

	it("formats multi-select reply with labels resolved from options", () => {
		const result = formatReplyForLlm(
			{
				kind: "user_answered_question",
				askId: "x",
				answer: { mode: "multi", selectedIds: ["a", "b"] },
			},
			{
				question: "Pick any",
				mode: "multi",
				options: [
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta" },
					{ id: "c", label: "Gamma" },
				],
			},
		);
		expect(result).toContain('selected_ids=["a","b"]');
		expect(result).toContain('labels=["Alpha","Beta"]');
	});

	it("formats free_text reply with JSON-escaped text", () => {
		const result = formatReplyForLlm(
			{
				kind: "user_answered_question",
				askId: "x",
				answer: { mode: "free_text", text: 'user said "yes"\nwith a newline' },
			},
			{ question: "What?", mode: "free_text" },
		);
		expect(result).toBe('user_answered mode=free_text text="user said \\"yes\\"\\nwith a newline"');
	});

	it("returns timeout marker when registry resolves with timeout", () => {
		const result = formatReplyForLlm(
			{
				kind: "user_answered_question",
				askId: "x",
				answer: { mode: "timeout" },
			},
			{ question: "?", mode: "single", options: [{ id: "a", label: "A" }] },
		);
		expect(result).toContain("mode=timeout");
		expect(result).toContain("用户");
	});

	it("returns unexpected-kind marker when registry resolves with user_decision (wrong reply type)", () => {
		const result = formatReplyForLlm(
			{ kind: "user_decision", askId: "x", decision: "allow" },
			{ question: "?", mode: "single", options: [{ id: "a", label: "A" }] },
		);
		expect(result).toContain("kind=user_decision");
	});

	it("uses unknown id literal when reply selects an id not in input.options", () => {
		const result = formatReplyForLlm(
			{
				kind: "user_answered_question",
				askId: "x",
				answer: { mode: "single", selectedId: "z-unknown" },
			},
			{
				question: "?",
				mode: "single",
				options: [{ id: "a", label: "A" }],
			},
		);
		expect(result).toContain("selected_id=z-unknown");
		expect(result).toContain('label="z-unknown"');
	});

	it("rejects single-mode input without options at schema validation time", async () => {
		const { service } = makeFakeService();
		const askTool = makeAskUserQuestionTool({ sessionId: "s", service });
		await expect(
			(askTool.execute as NonNullable<typeof askTool.execute>)(
				// biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
				{ question: "?", mode: "single" } as any,
				{ toolCallId: "tc-2", messages: [] },
			),
		).rejects.toThrow();
	});

	it("rejects free_text mode with options at schema validation time", async () => {
		const { service } = makeFakeService();
		const askTool = makeAskUserQuestionTool({ sessionId: "s", service });
		await expect(
			(askTool.execute as NonNullable<typeof askTool.execute>)(
				{
					question: "?",
					mode: "free_text",
					options: [{ id: "a", label: "A" }],
					// biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
				} as any,
				{ toolCallId: "tc-3", messages: [] },
			),
		).rejects.toThrow();
	});

	it("rejects defaultId that doesn't match any option id", async () => {
		const { service } = makeFakeService();
		const askTool = makeAskUserQuestionTool({ sessionId: "s", service });
		await expect(
			(askTool.execute as NonNullable<typeof askTool.execute>)(
				{
					question: "?",
					mode: "single",
					options: [{ id: "a", label: "A" }],
					defaultId: "not-real",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
				} as any,
				{ toolCallId: "tc-4", messages: [] },
			),
		).rejects.toThrow();
	});

	it("rejects defaultId when mode is free_text (no options to resolve it against)", async () => {
		const { service } = makeFakeService();
		const askTool = makeAskUserQuestionTool({ sessionId: "s", service });
		await expect(
			(askTool.execute as NonNullable<typeof askTool.execute>)(
				{
					question: "?",
					mode: "free_text",
					defaultId: "anything",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
				} as any,
				{ toolCallId: "tc-6", messages: [] },
			),
		).rejects.toThrow();
	});

	it("respects caller-provided timeoutMs in the awaitAsk registration", async () => {
		const { service } = makeFakeService();
		const awaitAsk = vi.fn(() => ({
			askToken: "fake-token-xyz",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_answered_question",
				askId: "x",
				answer: { mode: "free_text", text: "hi" },
			}),
		}));
		const askTool = makeAskUserQuestionTool({
			sessionId: "s",
			service,
			awaitAsk,
			generateAskId: () => "x",
		});

		await (askTool.execute as NonNullable<typeof askTool.execute>)(
			{ question: "?", mode: "free_text", timeoutMs: 30_000 },
			{ toolCallId: "tc-5", messages: [] },
		);

		expect(awaitAsk).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
	});
});
