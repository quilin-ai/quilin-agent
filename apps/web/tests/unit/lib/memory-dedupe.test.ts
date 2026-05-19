import { describe, expect, it } from "vitest";

import { buildDedupePlan, normalizeContent } from "@/lib/memory-dedupe";

describe("normalizeContent", () => {
	it("trims surrounding whitespace", () => {
		expect(normalizeContent("  hello  ")).toBe("hello");
	});

	it("collapses internal whitespace runs into a single space", () => {
		expect(normalizeContent("用户叫小明\n\t  和\n\n小红")).toBe("用户叫小明 和 小红");
	});

	it("preserves case (English casing is meaningful)", () => {
		expect(normalizeContent("Hello World")).toBe("Hello World");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(normalizeContent("   \n\t  ")).toBe("");
	});
});

describe("buildDedupePlan", () => {
	it("returns empty plan for empty input", () => {
		const plan = buildDedupePlan([]);
		expect(plan.groups).toEqual([]);
		expect(plan.totalDelete).toBe(0);
		expect(plan.totalKeep).toBe(0);
	});

	it("ignores singletons (no duplicates)", () => {
		const plan = buildDedupePlan([
			{ id: "1", content: "alpha", tier: "working", createdAt: null },
			{ id: "2", content: "beta", tier: "working", createdAt: null },
		]);
		expect(plan.groups).toHaveLength(0);
		expect(plan.totalDelete).toBe(0);
		expect(plan.totalKeep).toBe(0);
	});

	it("groups by (tier, normalized content) and keeps the earliest by createdAt", () => {
		const plan = buildDedupePlan([
			{ id: "a", content: "用户叫小明", tier: "working", createdAt: "2026-05-10T10:00:00Z" },
			{ id: "b", content: "用户叫小明", tier: "working", createdAt: "2026-05-05T10:00:00Z" },
			{ id: "c", content: "用户叫小明", tier: "working", createdAt: "2026-05-15T10:00:00Z" },
		]);
		expect(plan.groups).toHaveLength(1);
		const group = plan.groups[0];
		if (group == null) throw new Error("group missing");
		expect(group.keepId).toBe("b");
		expect([...group.deleteIds].sort()).toEqual(["a", "c"]);
		expect(group.tier).toBe("working");
		expect(group.content).toBe("用户叫小明");
		expect(plan.totalKeep).toBe(1);
		expect(plan.totalDelete).toBe(2);
	});

	it("does not cross tiers — same content in different tier stays separate", () => {
		const plan = buildDedupePlan([
			{ id: "a", content: "用户叫小明", tier: "working", createdAt: "2026-05-10T10:00:00Z" },
			{ id: "b", content: "用户叫小明", tier: "working", createdAt: "2026-05-11T10:00:00Z" },
			{ id: "c", content: "用户叫小明", tier: "semantic", createdAt: "2026-05-12T10:00:00Z" },
		]);
		expect(plan.groups).toHaveLength(1);
		expect(plan.groups[0]?.tier).toBe("working");
		expect(plan.totalDelete).toBe(1);
	});

	it("falls back to array order when createdAt is missing", () => {
		const plan = buildDedupePlan([
			{ id: "first", content: "用户叫小明", tier: "working", createdAt: null },
			{ id: "second", content: "用户叫小明", tier: "working", createdAt: null },
			{ id: "third", content: "用户叫小明", tier: "working", createdAt: null },
		]);
		const group = plan.groups[0];
		if (group == null) throw new Error("group missing");
		expect(group.keepId).toBe("first");
		expect(group.deleteIds).toEqual(["second", "third"]);
	});

	it("treats unparseable createdAt as +Infinity so it loses to valid timestamps", () => {
		const plan = buildDedupePlan([
			{ id: "broken", content: "foo", tier: "working", createdAt: "not-a-date" },
			{ id: "good", content: "foo", tier: "working", createdAt: "2026-05-10T10:00:00Z" },
		]);
		expect(plan.groups[0]?.keepId).toBe("good");
		expect(plan.groups[0]?.deleteIds).toEqual(["broken"]);
	});

	it("normalizes leading/trailing whitespace before grouping", () => {
		// 'a' and 'b' should merge after trim + collapse; 'c' has an
		// internal newline that turns into a real space — semantically
		// different from no-space, so it stays in its own bucket.
		const plan = buildDedupePlan([
			{ id: "a", content: "用户叫小明", tier: "working", createdAt: "2026-05-10T10:00:00Z" },
			{ id: "b", content: "  用户叫小明 ", tier: "working", createdAt: "2026-05-11T10:00:00Z" },
			{ id: "c", content: "用户叫\n小明", tier: "working", createdAt: "2026-05-12T10:00:00Z" },
		]);
		expect(plan.groups).toHaveLength(1);
		expect(plan.totalDelete).toBe(1);
		expect(plan.groups[0]?.deleteIds).toEqual(["b"]);
	});

	it("skips records with empty content after normalization", () => {
		const plan = buildDedupePlan([
			{ id: "blank-1", content: "   ", tier: "working", createdAt: null },
			{ id: "blank-2", content: "\n\n", tier: "working", createdAt: null },
		]);
		expect(plan.groups).toHaveLength(0);
		expect(plan.totalDelete).toBe(0);
	});

	it("returns groups sorted by deleteIds length descending (noisiest first)", () => {
		const plan = buildDedupePlan([
			// small group (2x)
			{ id: "x1", content: "small", tier: "working", createdAt: "2026-05-10T10:00:00Z" },
			{ id: "x2", content: "small", tier: "working", createdAt: "2026-05-11T10:00:00Z" },
			// big group (4x)
			{ id: "y1", content: "big", tier: "working", createdAt: "2026-05-10T10:00:00Z" },
			{ id: "y2", content: "big", tier: "working", createdAt: "2026-05-11T10:00:00Z" },
			{ id: "y3", content: "big", tier: "working", createdAt: "2026-05-12T10:00:00Z" },
			{ id: "y4", content: "big", tier: "working", createdAt: "2026-05-13T10:00:00Z" },
		]);
		expect(plan.groups).toHaveLength(2);
		expect(plan.groups[0]?.deleteIds).toHaveLength(3);
		expect(plan.groups[1]?.deleteIds).toHaveLength(1);
		expect(plan.totalDelete).toBe(4);
		expect(plan.totalKeep).toBe(2);
	});
});
