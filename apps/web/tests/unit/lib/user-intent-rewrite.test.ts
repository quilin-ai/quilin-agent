import { describe, expect, it } from "vitest";

import { intentRewriteSystemNote, rewriteUserIntentText } from "@/lib/user-intent-rewrite";

describe("user intent rewrite", () => {
	it("normalizes the high-confidence 又累的 typo", () => {
		const rewrite = rewriteUserIntentText("再搜搜又累的东方玄学出海团队吗？");

		expect(rewrite.changed).toBe(true);
		expect(rewrite.normalizedText).toBe("再搜搜有类似的东方玄学出海团队吗？");
		expect(rewrite.reason).toContain("有类似的");
	});

	it("is stable across repeated calls", () => {
		const input = "再搜搜又累的东方玄学出海团队吗？";

		expect(rewriteUserIntentText(input).normalizedText).toBe("再搜搜有类似的东方玄学出海团队吗？");
		expect(rewriteUserIntentText(input).normalizedText).toBe("再搜搜有类似的东方玄学出海团队吗？");
	});

	it("leaves low-confidence text unchanged", () => {
		const rewrite = rewriteUserIntentText("玄学出海团队有哪些？");

		expect(rewrite.changed).toBe(false);
		expect(rewrite.normalizedText).toBe("玄学出海团队有哪些？");
		expect(intentRewriteSystemNote(rewrite)).toBe("");
	});

	it("does not rewrite valid tiredness or fatigue wording", () => {
		const rewrite = rewriteUserIntentText("分析用户为什么又累的很快");

		expect(rewrite.changed).toBe(false);
		expect(rewrite.normalizedText).toBe("分析用户为什么又累的很快");
	});

	it("does not rewrite fatigue wording just because a later clause names a team", () => {
		const rewrite = rewriteUserIntentText("分析用户为什么又累的很快，团队后续怎么承接");

		expect(rewrite.changed).toBe(false);
		expect(rewrite.normalizedText).toBe("分析用户为什么又累的很快，团队后续怎么承接");
	});

	it("builds an explicit system note for changed input", () => {
		const rewrite = rewriteUserIntentText("有累的东方玄学团队吗？");
		const note = intentRewriteSystemNote(rewrite);

		expect(note).toContain("用户原文");
		expect(note).toContain("有类似的东方玄学团队吗？");
		expect(note).toContain("不要按错字逐字执行");
	});
});
