/**
 * Unit tests for `ask_user_question` TUI tool — Iter F Slice 3c.
 *
 * Hermetic: uses `promptOverride` to drive the readline-equivalent
 * with a deterministic raw input string. No real stdin / stdout.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type AskUserQuestionTuiInput,
	createAskUserQuestionTuiTool,
	formatTuiAnswerForLlm,
	parseRawAnswer,
} from "./ask-user-question-tui.js";

function makeStubStream(): NodeJS.WriteStream {
	// Minimal write surface for `stderr.write(rendered)` calls. Tests don't
	// assert on rendered text so we just track writes for sanity.
	const writes: string[] = [];
	const stream = {
		write: (chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		},
		writes,
	} as unknown as NodeJS.WriteStream & { writes: string[] };
	return stream;
}

describe("ask_user_question TUI tool", () => {
	it("single mode: numeric input selects the matching option id", async () => {
		const promptOverride = vi.fn(async () => "1");
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({
			question: "Pick one",
			mode: "single",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta" },
			],
		});
		expect(result.isError).toBe(false);
		expect(result.content).toContain("selected_id=a");
		expect(result.content).toContain('label="Alpha"');
	});

	it("multi mode: comma list selects multiple options", async () => {
		const promptOverride = vi.fn(async () => "1,3");
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({
			question: "Pick any",
			mode: "multi",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta" },
				{ id: "c", label: "Gamma" },
			],
		});
		expect(result.isError).toBe(false);
		expect(result.content).toContain('selected_ids=["a","c"]');
	});

	it("free_text mode: returns the user's raw text", async () => {
		const promptOverride = vi.fn(async () => "I prefer concise replies");
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({ question: "Anything?", mode: "free_text" });
		expect(result.isError).toBe(false);
		expect(result.content).toContain("mode=free_text");
		expect(result.content).toContain('text="I prefer concise replies"');
	});

	it("empty input → timeout result", async () => {
		const promptOverride = vi.fn(async () => "");
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({
			question: "?",
			mode: "single",
			options: [{ id: "a", label: "A" }],
		});
		expect(result.isError).toBe(false);
		expect(result.content).toContain("mode=timeout");
	});

	it("null input (Ctrl-D / EOF) → timeout result", async () => {
		const promptOverride = vi.fn(async () => null);
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({
			question: "?",
			mode: "free_text",
		});
		expect(result.content).toContain("mode=timeout");
	});

	it("out-of-range single number → timeout result (defensive)", async () => {
		const promptOverride = vi.fn(async () => "99");
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({
			question: "?",
			mode: "single",
			options: [{ id: "a", label: "A" }],
		});
		expect(result.content).toContain("mode=timeout");
	});

	it("non-numeric input on single mode → timeout result", async () => {
		const promptOverride = vi.fn(async () => "abc");
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		const result = await tool.execute({
			question: "?",
			mode: "single",
			options: [{ id: "a", label: "A" }],
		});
		expect(result.content).toContain("mode=timeout");
	});

	it("invalid input shape → isError=true with invalid_arguments code", async () => {
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
		});
		const result = await tool.execute({
			question: "?",
			mode: "single",
			// missing required options for single mode
		} as unknown);
		expect(result.isError).toBe(true);
		expect(result.error?.code).toBe("invalid_arguments");
	});

	it("respects caller-provided timeoutMs", async () => {
		const promptOverride = vi.fn(async (_rendered: string, timeoutMs: number) => {
			expect(timeoutMs).toBe(10_000);
			return "1";
		});
		const tool = createAskUserQuestionTuiTool({
			stderr: makeStubStream(),
			promptOverride,
		});
		await tool.execute({
			question: "?",
			mode: "single",
			options: [{ id: "x", label: "X" }],
			timeoutMs: 10_000,
		});
		expect(promptOverride).toHaveBeenCalled();
	});

	it("parseRawAnswer handles whitespace + tab separators in multi mode", () => {
		const input: AskUserQuestionTuiInput = {
			question: "?",
			mode: "multi",
			options: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
				{ id: "c", label: "C" },
			],
		};
		const result = parseRawAnswer("1 2\t3", input);
		expect(result.mode).toBe("multi");
		if (result.mode === "multi") {
			expect(result.selectedIds).toEqual(["a", "b", "c"]);
		}
	});

	it("formatTuiAnswerForLlm renders unknown reply mode safely (defensive)", () => {
		// Force-cast for the unreachable branch defensive test.
		const result = formatTuiAnswerForLlm(
			// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid for branch coverage
			{ mode: "nonsense" } as any,
			{ question: "?", mode: "free_text" },
		);
		expect(result).toContain("mode=unknown");
	});

	it("multi mode with one out-of-range number → entire reply timeouts", () => {
		const input: AskUserQuestionTuiInput = {
			question: "?",
			mode: "multi",
			options: [{ id: "a", label: "A" }],
		};
		// "1,99" — first valid, second out of range. Whole reply rejected.
		const result = parseRawAnswer("1,99", input);
		expect(result.mode).toBe("timeout");
	});
});
