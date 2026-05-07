import { describe, expect, it } from "vitest";
import {
	renderDivider, renderFooter, renderHeader, renderLayout, renderLogo,
	renderPanel, renderStatusLine, renderTable,
} from "./renderer.js";
import { stripAnsi, Theme, ANSI } from "./theme.js";

describe("renderPanel", () => {
	it("renders bordered panel", () => {
		const r = renderPanel("hello");
		const lines = r.split("\n");
		expect(lines.length).toBe(3);
		expect(lines[0]).toMatch(/^┌─+┐$/u);
		expect(stripAnsi(lines[1] ?? "")).toContain("hello");
		expect(lines[2]).toMatch(/^└─+┘$/u);
	});
	it("renders title when wide enough", () => {
		const r = renderPanel("content long enough here", { title: "My Panel" });
		expect(stripAnsi(r)).toContain("My Panel");
	});
	it("renders title when narrow content", () => {
		const r = renderPanel("x", { title: "T" });
		expect(stripAnsi(r)).toContain("T");
	});
	it("handles empty content", () => {
		const r = renderPanel("");
		const lines = r.split("\n");
		expect(lines.length).toBe(3);
		expect(lines[1]).toMatch(/^│\s+│$/u);
	});
	it("renders multi-line", () => {
		const r = renderPanel("line1\nline2");
		const lines = r.split("\n");
		expect(lines.length).toBe(4);
		expect(stripAnsi(lines[1] ?? "")).toContain("line1");
		expect(stripAnsi(lines[2] ?? "")).toContain("line2");
	});
	it("supports double border", () => {
		const r = renderPanel("test", { borderStyle: "double" });
		expect(r).toContain("╔");
		expect(r).toContain("║");
	});
	it("supports rounded border", () => {
		const r = renderPanel("test", { borderStyle: "rounded" });
		expect(r).toContain("╭");
	});
	it("supports heavy border", () => {
		const r = renderPanel("test", { borderStyle: "heavy" });
		expect(r).toContain("┏");
	});
	it("honours maxWidth", () => {
		const r = renderPanel("x".repeat(120), { maxWidth: 40 });
		const lines = r.split("\n");
		const topBar = stripAnsi(lines[0] ?? "");
		expect(topBar.length).toBeLessThanOrEqual(42);
	});
	it("truncates long title", () => {
		const r = renderPanel("ok", { title: "A".repeat(100), maxWidth: 30 });
		expect(r).toContain("…");
	});
	it("single border default", () => {
		const r = renderPanel("test");
		expect(r).toContain("┌");
		expect(r).toContain("└");
	});
});

describe("renderTable", () => {
	const cols = [{ header: "ID", key: "id" as const }, { header: "Name", key: "name" as const }] as const;
	it("renders table with rows", () => {
		const rows = [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }];
		const r = renderTable(cols, rows);
		expect(r.split("\n").length).toBe(6);
		expect(stripAnsi(r)).toContain("ID");
		expect(stripAnsi(r)).toContain("Alice");
	});
	it("zero columns returns empty", () => { expect(renderTable([], [])).toBe(""); });
	it("empty rows no mid bar", () => {
		const r = renderTable(cols, []);
		expect(r.split("\n").length).toBe(3);
		expect(stripAnsi(r)).not.toContain("├");
	});
	it("explicit column widths", () => {
		const wc = [{ header: "ID", key: "id" as const, width: 10 }, { header: "Name", key: "name" as const, width: 20 }];
		const r = renderTable(wc, [{ id: "1", name: "Alice" }]);
		expect(stripAnsi(r)).toContain("Alice");
	});
	it("alignment", () => {
		const ac = [
			{ header: "L", key: "l" as const, align: "left" as const, width: 8 },
			{ header: "R", key: "r" as const, align: "right" as const, width: 8 },
			{ header: "C", key: "c" as const, align: "center" as const, width: 8 },
		];
		const r = renderTable(ac, [{ l: "a", r: "b", c: "d" }]);
		expect(stripAnsi(r)).toContain("a");
		expect(stripAnsi(r)).toContain("b");
		expect(stripAnsi(r)).toContain("d");
	});
	it("undefined cell", () => {
		const oc = [{ header: "ID", key: "id" as const }, { header: "X", key: "x" as const }];
		const r = renderTable(oc, [{ id: "1", x: undefined }]);
		expect(stripAnsi(r)).toContain("1");
	});
	it("double border style", () => {
		const r = renderTable(cols, [{ id: "1", name: "T" }], { borderStyle: "double" });
		expect(r).toContain("╔");
	});
	it("CJK cells", () => {
		const cjk = [{ header: "编号", key: "id" as const }, { header: "名字", key: "name" as const }];
		const r = renderTable(cjk, [{ id: "1", name: "麒麟" }]);
		expect(stripAnsi(r)).toContain("编号");
		expect(stripAnsi(r)).toContain("麒麟");
	});
});

describe("renderHeader", () => {
	it("heading with underline", () => {
		const r = renderHeader("Section");
		expect(r.split("\n").length).toBe(2);
		expect(stripAnsi(r.split("\n")[0] ?? "")).toBe("Section");
	});
	it("has heading colour", () => { expect(renderHeader("T")).toContain(Theme.heading); });
});

describe("renderFooter", () => {
	it("dim text", () => {
		const r = renderFooter("status");
		expect(r).toContain(ANSI.dim);
		expect(stripAnsi(r)).toBe("status");
	});
});

describe("renderDivider", () => {
	it("default width 80", () => { expect(renderDivider().length).toBe(80); });
	it("custom width+char", () => { expect(renderDivider({ width: 10, char: "=" })).toBe("=".repeat(10)); });
	it("width 0", () => { expect(renderDivider({ width: 0 })).toBe(""); });
});

describe("renderStatusLine", () => {
	it("left+right", () => {
		const r = renderStatusLine({ left: "L", right: "R", width: 20 });
		expect(r.startsWith("L")).toBe(true);
		expect(r.endsWith("R")).toBe(true);
	});
	it("default width", () => { expect(stripAnsi(renderStatusLine({ left: "a", right: "b" })).length).toBe(80); });
	it("fill width", () => { expect(stripAnsi(renderStatusLine({ left: "ab", right: "cd", width: 4 }))).toBe("abcd"); });
});

describe("renderLogo", () => {
	it("non-empty", () => { expect(renderLogo().length).toBeGreaterThan(0); });
	it("primary colour", () => { expect(renderLogo()).toContain(Theme.primary); });
});

describe("renderLayout", () => {
	it("sections with dividers", () => {
		const r = renderLayout({
			sections: [
				{ header: "S1", content: "B1" },
				{ content: "B2", footer: "End" },
			],
		});
		expect(stripAnsi(r)).toContain("S1");
		expect(stripAnsi(r)).toContain("B2");
		expect(stripAnsi(r)).toContain("End");
		expect(r).toContain("────");
	});
	it("single section no divider", () => {
		const r = renderLayout({ sections: [{ content: "only" }] });
		expect(stripAnsi(r)).toBe("only");
		expect(r).not.toContain("───");
	});
	it("empty sections", () => { expect(renderLayout({ sections: [] })).toBe(""); });
	it("skip optional header/footer", () => {
		expect(stripAnsi(renderLayout({ sections: [{ content: "c" }] }))).toBe("c");
	});
});
