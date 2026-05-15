import { describe, expect, it } from "vitest";

import {
	buildTranscriptBlocks,
	extractToolPartsFromBlocks,
	processBlockHasRunningTool,
} from "@/lib/transcript-blocks";

describe("buildTranscriptBlocks", () => {
	it("interleaves process blocks with markdown text blocks in original part order", () => {
		const blocks = buildTranscriptBlocks(
			[
				{ type: "reasoning", text: "I should inspect first." },
				{
					type: "tool-web_fetch",
					toolCallId: "call-1",
					state: "output-available",
					input: { url: "https://example.com/one" },
					output: { ok: true },
				},
				{ type: "text", text: "First answer.\n\n" },
				{
					type: "tool-web_extract",
					toolCallId: "call-2",
					state: "output-available",
					input: { selector: "main" },
				},
				{ type: "text", text: "Second answer." },
			],
			"msg-1",
		);

		expect(blocks.map((block) => block.type)).toEqual(["process", "text", "process", "text"]);
		expect(blocks[1]).toMatchObject({ type: "text", text: "First answer.\n\n" });
		expect(blocks[3]).toMatchObject({ type: "text", text: "Second answer." });
	});

	it("folds consecutive same-name tool calls into one tool group", () => {
		const blocks = buildTranscriptBlocks(
			[
				{
					type: "tool-web_fetch",
					toolCallId: "call-1",
					state: "output-available",
					input: { url: "https://example.com/one" },
				},
				{
					type: "tool-web_fetch",
					toolCallId: "call-2",
					state: "output-available",
					input: { url: "https://example.com/two" },
				},
				{
					type: "tool-web_fetch",
					toolCallId: "call-3",
					state: "output-available",
					input: { url: "https://example.com/three" },
				},
			],
			"msg-2",
		);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: "process",
			items: [{ type: "tool-group", name: "web_fetch" }],
		});
		if (blocks[0]?.type !== "process") throw new Error("expected process block");
		const item = blocks[0].items[0];
		if (item?.type !== "tool-group") throw new Error("expected tool group");
		expect(item.calls).toHaveLength(3);
	});

	it("does not fold same-name tool calls across a text boundary", () => {
		const blocks = buildTranscriptBlocks(
			[
				{ type: "tool-web_fetch", toolCallId: "call-1", state: "output-available" },
				{ type: "text", text: "Between calls." },
				{ type: "tool-web_fetch", toolCallId: "call-2", state: "output-available" },
			],
			"msg-3",
		);

		expect(blocks.map((block) => block.type)).toEqual(["process", "text", "process"]);
		expect(extractToolPartsFromBlocks(blocks)).toHaveLength(2);
	});

	it("deduplicates dynamic-tool and typed tool parts by toolCallId", () => {
		const blocks = buildTranscriptBlocks(
			[
				{
					type: "dynamic-tool",
					toolName: "web_fetch",
					toolCallId: "call-1",
					state: "output-available",
				},
				{
					type: "tool-web_fetch",
					toolCallId: "call-1",
					state: "output-available",
					input: { url: "https://example.com" },
				},
			],
			"msg-4",
		);

		const tools = extractToolPartsFromBlocks(blocks);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.type).toBe("tool-web_fetch");
	});
});

describe("processBlockHasRunningTool — Process UX bug fix 2026-05-15", () => {
	it("returns true when at least one tool call has input-streaming state", () => {
		const block = {
			type: "process" as const,
			id: "p1",
			items: [
				{
					type: "tool-group" as const,
					name: "shell_exec",
					calls: [{ type: "tool-shell_exec", toolCallId: "c1", state: "input-streaming" }],
				},
			],
		};
		expect(processBlockHasRunningTool(block)).toBe(true);
	});

	it("returns true when at least one tool call has input-available state", () => {
		const block = {
			type: "process" as const,
			id: "p2",
			items: [
				{
					type: "tool-group" as const,
					name: "web_fetch",
					calls: [{ type: "tool-web_fetch", toolCallId: "c1", state: "input-available" }],
				},
			],
		};
		expect(processBlockHasRunningTool(block)).toBe(true);
	});

	it("returns false when all tool calls are output-available (terminal)", () => {
		const block = {
			type: "process" as const,
			id: "p3",
			items: [
				{
					type: "tool-group" as const,
					name: "memory_recall",
					calls: [
						{ type: "tool-memory_recall", toolCallId: "c1", state: "output-available" },
						{ type: "tool-memory_recall", toolCallId: "c2", state: "output-available" },
					],
				},
			],
		};
		expect(processBlockHasRunningTool(block)).toBe(false);
	});

	it("returns false when block contains only reasoning items", () => {
		const block = {
			type: "process" as const,
			id: "p4",
			items: [
				{
					type: "reasoning" as const,
					part: { type: "reasoning", text: "thinking…" },
				},
			],
		};
		expect(processBlockHasRunningTool(block)).toBe(false);
	});

	it("returns false on an empty block", () => {
		const block = { type: "process" as const, id: "p5", items: [] };
		expect(processBlockHasRunningTool(block)).toBe(false);
	});

	it("returns true when mixed: one running + one done", () => {
		const block = {
			type: "process" as const,
			id: "p6",
			items: [
				{
					type: "tool-group" as const,
					name: "a",
					calls: [{ type: "tool-a", toolCallId: "c1", state: "output-available" }],
				},
				{
					type: "tool-group" as const,
					name: "b",
					calls: [{ type: "tool-b", toolCallId: "c2", state: "input-available" }],
				},
			],
		};
		expect(processBlockHasRunningTool(block)).toBe(true);
	});
});
