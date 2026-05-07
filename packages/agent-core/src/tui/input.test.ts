import { describe, expect, it } from "vitest";
import {
	highlightSlashCommands,
	highlightSyntax,
	highlightToolNames,
	InputHistory,
	MultiLineAccumulator,
} from "./input.js";
import { stripAnsi, Theme } from "./theme.js";

describe("InputHistory", () => {
	it("starts with size 0", () => {
		const history = new InputHistory();
		expect(history.size).toBe(0);
	});

	it("adds entries and tracks size", () => {
		const history = new InputHistory();
		history.add("cmd1");
		history.add("cmd2");
		expect(history.size).toBe(2);
	});

	it("ignores blank input", () => {
		const history = new InputHistory();
		history.add("   ");
		history.add("");
		expect(history.size).toBe(0);
	});

	it("ignores consecutive duplicates", () => {
		const history = new InputHistory();
		history.add("cmd1");
		history.add("cmd1");
		expect(history.size).toBe(1);
	});

	it("getRecent returns entries most-recent-first", () => {
		const history = new InputHistory();
		history.add("first");
		history.add("second");
		const recent = history.getRecent();
		expect(recent[0]?.input).toBe("second");
		expect(recent[1]?.input).toBe("first");
	});

	it("getRecent with limit returns only that many", () => {
		const history = new InputHistory();
		history.add("a");
		history.add("b");
		history.add("c");
		expect(history.getRecent(2)).toHaveLength(2);
	});

	it("evicts oldest entries when exceeding maxSize", () => {
		const history = new InputHistory({ maxSize: 3 });
		history.add("a");
		history.add("b");
		history.add("c");
		history.add("d");
		expect(history.size).toBe(3);
		const recent = history.getRecent();
		expect(recent.map((e) => e.input)).toEqual(["d", "c", "b"]);
	});

	it("search finds matching entries case-insensitively", () => {
		const history = new InputHistory();
		history.add("apple");
		history.add("Banana");
		history.add("cherry");
		const results = history.search("a");
		expect(results.map((e) => e.input)).toContain("apple");
		expect(results.map((e) => e.input)).toContain("Banana");
		expect(results.map((e) => e.input)).not.toContain("cherry");
	});

	it("search returns all entries for empty query", () => {
		const history = new InputHistory();
		history.add("a");
		history.add("b");
		expect(history.search("")).toHaveLength(2);
	});

	it("search returns results most-recent-first", () => {
		const history = new InputHistory();
		history.add("cmd alpha");
		history.add("cmd beta");
		const results = history.search("cmd");
		expect(results[0]?.input).toBe("cmd beta");
		expect(results[1]?.input).toBe("cmd alpha");
	});

	it("search returns empty array when no match", () => {
		const history = new InputHistory();
		history.add("hello");
		expect(history.search("zzz")).toEqual([]);
	});

	it("previous navigates backward and stays at boundary", () => {
		const history = new InputHistory();
		history.add("first");
		history.add("second");
		history.add("third");
		history.startNavigation("");
		expect(history.previous()).toBe("third");
		expect(history.previous()).toBe("second");
		expect(history.previous()).toBe("first");
		expect(history.previous()).toBe("first");
	});

	it("next navigates forward and restores saved line", () => {
		const history = new InputHistory();
		history.add("first");
		history.add("second");
		const saved = "work in progress";
		history.startNavigation(saved);
		history.previous();
		history.next();
		const afterNext = history.next();
		expect(afterNext).toBe(saved);
	});

	it("startNavigation with empty history returns undefined", () => {
		const history = new InputHistory();
		history.startNavigation("line");
		expect(history.previous()).toBeUndefined();
	});

	it("next returns undefined when not navigating", () => {
		const history = new InputHistory();
		history.add("entry");
		expect(history.next()).toBeUndefined();
	});

	it("resetNavigation clears internal state", () => {
		const history = new InputHistory();
		history.add("entry");
		history.startNavigation("line");
		history.previous();
		history.resetNavigation();
		expect(history.next()).toBeUndefined();
	});

	it("entries include timestamps", () => {
		const before = Date.now();
		const history = new InputHistory();
		history.add("test");
		const recent = history.getRecent();
		expect(recent[0]?.timestamp).toBeGreaterThanOrEqual(before);
	});

	it("trim previous input before storing", () => {
		const history = new InputHistory();
		history.add("  hello world  ");
		expect(history.getRecent()[0]?.input).toBe("hello world");
	});
});

describe("highlightSlashCommands", () => {
	it("highlights a slash command", () => {
		const result = highlightSlashCommands("/help");
		expect(result).toContain(Theme.slashCommand);
		expect(stripAnsi(result)).toBe("/help");
	});

	it("highlights only the command name, not args", () => {
		const result = highlightSlashCommands("/resume 42");
		expect(result).toContain(Theme.slashCommand);
		expect(stripAnsi(result)).toBe("/resume 42");
	});

	it("does not highlight non-command text", () => {
		const result = highlightSlashCommands("hello world");
		expect(result).toBe("hello world");
	});

	it("handles multi-line text", () => {
		const result = highlightSlashCommands("/help\n/status");
		const lines = result.split("\n");
		expect(lines[0]).toContain(Theme.slashCommand);
		expect(lines[1]).toContain(Theme.slashCommand);
	});

	it("preserves leading whitespace", () => {
		const result = highlightSlashCommands("   /exit");
		expect(result).toContain(Theme.slashCommand);
		expect(stripAnsi(result)).toBe("   /exit");
	});

	it("handles empty string", () => {
		expect(highlightSlashCommands("")).toBe("");
	});

	it("highlights commands with hyphens and underscores", () => {
		const result = highlightSlashCommands("/my_command");
		expect(result).toContain(Theme.slashCommand);
		expect(stripAnsi(result)).toBe("/my_command");
	});
});

describe("highlightToolNames", () => {
	it("highlights tool name preceding (", () => {
		const result = highlightToolNames("web_fetch(arg)");
		expect(result).toContain(Theme.toolName);
		expect(stripAnsi(result)).toBe("web_fetch(arg)");
	});

	it("highlights dot-qualified tool names", () => {
		const result = highlightToolNames("quilin.mem.recall(key)");
		expect(result).toContain(Theme.toolName);
	});

	it("does not highlight when no ( follows", () => {
		const result = highlightToolNames("just_text");
		expect(result).toBe("just_text");
	});

	it("highlights multiple tool names in one line", () => {
		const result = highlightToolNames("fetch(a) and parse(b)");
		const occurrences = (result.match(/\x1b\[92m/g) ?? []).length;
		expect(occurrences).toBe(2);
	});

	it("handles empty string", () => {
		expect(highlightToolNames("")).toBe("");
	});
});

describe("highlightSyntax", () => {
	it("highlights slash commands in text", () => {
		const result = highlightSyntax("/status");
		expect(result).toContain(Theme.slashCommand);
	});

	it("returns non-command text unchanged", () => {
		expect(highlightSyntax("regular input")).toBe("regular input");
	});
});

describe("MultiLineAccumulator", () => {
	it("starts with 0 buffered lines", () => {
		const acc = new MultiLineAccumulator();
		expect(acc.bufferedCount).toBe(0);
	});

	it("accumulates lines until terminator", () => {
		const acc = new MultiLineAccumulator();
		const r1 = acc.feed("line one");
		expect(r1.done).toBe(false);
		expect(r1.lineCount).toBe(1);
		expect(acc.bufferedCount).toBe(1);
		const r2 = acc.feed("line two");
		expect(r2.done).toBe(false);
		expect(r2.lineCount).toBe(2);
		const r3 = acc.feed(".");
		expect(r3.done).toBe(true);
		expect(r3.content).toBe("line one\nline two");
		expect(r3.lineCount).toBe(0);
		expect(acc.bufferedCount).toBe(0);
	});

	it("preserves original line content including whitespace", () => {
		const acc = new MultiLineAccumulator();
		acc.feed("  indented  ");
		acc.feed("\t tabbed");
		const result = acc.feed(".");
		expect(result.content).toBe("  indented  \n\t tabbed");
	});

	it("accepts custom terminator", () => {
		const acc = new MultiLineAccumulator({ terminator: "EOF" });
		acc.feed("content");
		const result = acc.feed("EOF");
		expect(result.done).toBe(true);
		expect(result.content).toBe("content");
	});

	it("does not treat terminator substring as terminator", () => {
		const acc = new MultiLineAccumulator();
		const r1 = acc.feed("...");
		expect(r1.done).toBe(false);
		expect(acc.bufferedCount).toBe(1);
	});

	it("reset discards buffered lines", () => {
		const acc = new MultiLineAccumulator();
		acc.feed("line1");
		acc.feed("line2");
		expect(acc.bufferedCount).toBe(2);
		acc.reset();
		expect(acc.bufferedCount).toBe(0);
	});

	it("handles empty content (terminator on first line)", () => {
		const acc = new MultiLineAccumulator();
		const result = acc.feed(".");
		expect(result.done).toBe(true);
		expect(result.content).toBe("");
	});

	it("trims trailing whitespace for terminator comparison only", () => {
		const acc = new MultiLineAccumulator();
		acc.feed("content line");
		const result = acc.feed(".  ");
		expect(result.done).toBe(true);
		expect(result.content).toBe("content line");
	});

	it("can be reused after reset", () => {
		const acc = new MultiLineAccumulator();
		acc.feed(".");
		expect(acc.bufferedCount).toBe(0);
		acc.feed("new");
		const result = acc.feed(".");
		expect(result.done).toBe(true);
		expect(result.content).toBe("new");
	});
});
