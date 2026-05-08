import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
	it("estimates tokens with a 4-char heuristic for pure ASCII", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("1234")).toBe(1);
		expect(estimateTokens("12345")).toBe(2);
		expect(estimateTokens("12345678")).toBe(2);
	});

	it("handles longer ASCII text with the same heuristic", () => {
		const text = "Quilin Agent keeps context assembly minimal in Phase 0.";

		expect(text.length).toBe(55);
		expect(estimateTokens(text)).toBe(14);
	});

	describe("CJK-aware estimation (QUI-140 third-round #2)", () => {
		it("returns 0 for an empty string", () => {
			expect(estimateTokens("")).toBe(0);
		});

		it("estimates pure ASCII at length / 4 (parity with legacy)", () => {
			expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 4));
			expect(estimateTokens("abcd")).toBe(1);
		});

		it("matches length/4 for long ASCII (>1000 chars)", () => {
			const long = "a".repeat(1200);
			expect(estimateTokens(long)).toBe(Math.ceil(1200 / 4));
			expect(estimateTokens(long)).toBe(300);
		});

		it("estimates pure Chinese at ~1 token per character", () => {
			// 6 CJK ideographs → 6 tokens
			expect(estimateTokens("你好世界中文")).toBe(6);
			// 8 CJK ideographs → 8 tokens
			expect(estimateTokens("调试程序解决问题")).toBe(8);
		});

		it("estimates pure Japanese (kana + kanji) at ~1 token per character", () => {
			// 6 hiragana → 6 tokens
			expect(estimateTokens("こんにちは世")).toBe(6);
			// Mixed kana + kanji (each char ≈ 1 token)
			const text = "ありがとう日本語"; // 8 chars: 5 hiragana + 3 kanji
			expect(estimateTokens(text)).toBe(8);
		});

		it("estimates pure Korean (Hangul) at ~1 token per character", () => {
			// 4 hangul syllables → 4 tokens
			expect(estimateTokens("안녕하세")).toBe(4);
			// 6 hangul syllables → 6 tokens
			expect(estimateTokens("프로그램오류")).toBe(6);
		});

		it("estimates Chinese-English mixed text by per-char weights", () => {
			// "调试 BUG" = 2 CJK (2.0) + " " (0.25) + "BUG" (0.75) = 3.0 → ceil = 3
			expect(estimateTokens("调试 BUG")).toBe(3);
			// "调试程序 BUG" = 4 CJK (4.0) + " " (0.25) + "BUG" (0.75) = 5.0 → ceil = 5
			expect(estimateTokens("调试程序 BUG")).toBe(5);
			// Sanity: above the legacy length/4 floor, which would have given
			// ceil(8/4) = 2 — confirming the 4x undercount fix lands in the
			// 5-7 corridor expected by the spec.
			expect(estimateTokens("调试程序 BUG")).toBeGreaterThanOrEqual(5);
		});

		it("estimates CJK Extension B (U+20000+) at ~1 token per character", () => {
			// U+20000 is the first code point of CJK Unified Ideographs Extension B,
			// which lives in the supplementary plane and is encoded as a UTF-16
			// surrogate pair. The estimator must iterate by code point and apply
			// the CJK weight (1.0), not the "other non-ASCII" weight (1/3).
			const extB = "\u{20000}"; // single Extension B ideograph
			expect(estimateTokens(extB)).toBe(1);

			// Three Extension B ideographs → 3 tokens (not 1 from rounding 3 * 1/3).
			const threeExtB = "\u{20000}\u{20001}\u{20002}";
			expect(estimateTokens(threeExtB)).toBe(3);
		});

		it("handles emoji and surrogate pairs without crashing", () => {
			// Emoji "🤖" is in the supplementary plane (U+1F916). `for..of`
			// iterates one code point per emoji, so length reported here is in
			// code points, not UTF-16 code units. Each emoji counts as one
			// "other non-ASCII" weight (1/3), three emoji → 1 token.
			expect(() => estimateTokens("🤖🤖🤖")).not.toThrow();
			expect(estimateTokens("🤖🤖🤖")).toBe(1);
			// Mixed ASCII + emoji
			expect(estimateTokens("hi 🤖")).toBeGreaterThan(0);
			// Single emoji never returns 0 / NaN / negative
			const single = estimateTokens("🤖");
			expect(single).toBeGreaterThan(0);
			expect(Number.isFinite(single)).toBe(true);
		});
	});
});
