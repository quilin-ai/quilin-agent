import { describe, expect, it } from "vitest";
import {
	ANSI, applyColor, BORDER_DOUBLE, BORDER_HEAVY, BORDER_ROUNDED,
	BORDER_SINGLE, Borders, BRAND_MARK, LOGO, padVisible, stripAnsi,
	Theme, truncateVisible, visibleWidth,
} from "./theme.js";

describe("ANSI codes", () => {
	it("all ANSI codes are non-empty strings", () => {
		for (const [key, value] of Object.entries(ANSI)) {
			expect(value, "ANSI." + key).toBeTypeOf("string");
			expect(value.length, "ANSI." + key).toBeGreaterThan(0);
		}
	});
	it("ANSI.reset is standard", () => { expect(ANSI.reset).toBe("\x1b[0m"); });
	it("ANSI.bold is bold", () => { expect(ANSI.bold).toBe("\x1b[1m"); });
	it("ANSI.dim is dim", () => { expect(ANSI.dim).toBe("\x1b[2m"); });
});

describe("Theme", () => {
	it("every theme role is a non-empty string", () => {
		for (const [key, value] of Object.entries(Theme)) {
			expect(value, "Theme." + key).toBeTypeOf("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});
	it("primary is cyan", () => { expect(Theme.primary).toBe(ANSI.cyan); });
	it("error is red", () => { expect(Theme.error).toBe(ANSI.red); });
	it("success is green", () => { expect(Theme.success).toBe(ANSI.green); });
	it("warning is yellow", () => { expect(Theme.warning).toBe(ANSI.yellow); });
	it("highlight has bold+cyan", () => {
		expect(Theme.highlight).toContain(ANSI.bold);
		expect(Theme.highlight).toContain(ANSI.cyan);
	});
	it("muted has dim", () => { expect(Theme.muted).toContain(ANSI.dim); });
	it("slashCommand has bold+magenta", () => {
		expect(Theme.slashCommand).toContain(ANSI.bold);
		expect(Theme.slashCommand).toContain(ANSI.brightMagenta);
	});
	it("toolName is brightGreen", () => { expect(Theme.toolName).toBe(ANSI.brightGreen); });
});

describe("applyColor", () => {
	it("wraps text with colour+reset", () => {
		expect(applyColor("hello", ANSI.red)).toBe("\x1b[31mhello\x1b[0m");
	});
	it("returns orig when colour empty", () => {
		expect(applyColor("hello", "")).toBe("hello");
	});
	it("works with composite colours", () => {
		const c = ANSI.bold + ANSI.cyan;
		const r = applyColor("test", c);
		expect(r.startsWith(c)).toBe(true);
		expect(r.endsWith(ANSI.reset)).toBe(true);
	});
});

describe("stripAnsi", () => {
	it("removes ANSI sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m \x1b[1mbold\x1b[0m")).toBe("red bold");
	});
	it("returns plain unchanged", () => { expect(stripAnsi("plain")).toBe("plain"); });
	it("handles multi-digit SGR", () => {
		expect(stripAnsi("\x1b[107mbg\x1b[0m")).toBe("bg");
	});
	it("handles empty", () => { expect(stripAnsi("")).toBe(""); });
});

describe("visibleWidth", () => {
	it("plain ASCII", () => { expect(visibleWidth("abc")).toBe(3); });
	it("strips ANSI", () => { expect(visibleWidth(applyColor("test", ANSI.green))).toBe(4); });
	it("CJK 2 cols", () => { expect(visibleWidth("你好")).toBe(4); });
	it("mixed", () => { expect(visibleWidth("abc中文")).toBe(7); });
	it("empty", () => { expect(visibleWidth("")).toBe(0); });
});

describe("padVisible", () => {
	it("pads ASCII", () => {
		const r = padVisible("hi", 5);
		expect(stripAnsi(r)).toBe("hi   ");
		expect(visibleWidth(r)).toBe(5);
	});
	it("no pad when wide", () => { expect(padVisible("hello world", 5)).toBe("hello world"); });
	it("CJK pad", () => { expect(visibleWidth(padVisible("中文", 8))).toBe(8); });
	it("empty pad", () => { expect(padVisible("", 3)).toBe("   "); });
});

describe("truncateVisible", () => {
	it("short text unchanged", () => { expect(truncateVisible("hi", 10)).toBe("hi"); });
	it("truncates with ellipsis", () => {
		const r = truncateVisible("hello world", 8);
		expect(visibleWidth(r)).toBeLessThanOrEqual(8);
		expect(r).toContain("…");
	});
	it("custom ellipsis", () => { expect(truncateVisible("hello world", 5, "...")).toBe("he..."); });
	it("empty string", () => { expect(truncateVisible("", 5)).toBe(""); });
});

describe("Border sets", () => {
	it("all border sets have required fields", () => {
		const keys = ["topLeft","topRight","bottomLeft","bottomRight","horizontal","vertical","teeLeft","teeRight","teeTop","teeBottom","cross"];
		const sets = [BORDER_SINGLE, BORDER_DOUBLE, BORDER_ROUNDED, BORDER_HEAVY];
		for (const set of sets) {
			for (const k of keys) {
				const v = (set as unknown as Record<string,unknown>)[k];
				expect(v, k).toBeTypeOf("string");
			}
		}
	});
	it("Borders maps all four styles", () => {
		expect(Borders.single).toBe(BORDER_SINGLE);
		expect(Borders.double).toBe(BORDER_DOUBLE);
		expect(Borders.rounded).toBe(BORDER_ROUNDED);
		expect(Borders.heavy).toBe(BORDER_HEAVY);
	});
});

describe("Logo", () => {
	it("multiple lines", () => { expect(LOGO.split("\n").length).toBeGreaterThan(2); });
	it("has box-drawing art", () => {
		const p = stripAnsi(LOGO);
		expect(p).toContain("╗");
		expect(p).toContain("╚");
		expect(p).toMatch(/[╔╗╚╝║═╠╣╦╩╬]/u);
	});
	it("non-empty", () => { expect(LOGO.length).toBeGreaterThan(0); });
});

describe("BRAND_MARK", () => {
	it("non-empty", () => { expect(BRAND_MARK.length).toBeGreaterThan(0); });
	it("has Quilin", () => { expect(BRAND_MARK).toContain("Quilin"); });
});
