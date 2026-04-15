import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
	it("estimates tokens with a simple 4-char heuristic", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("1234")).toBe(1);
		expect(estimateTokens("12345")).toBe(2);
		expect(estimateTokens("12345678")).toBe(2);
	});

	it("handles longer text with the same heuristic", () => {
		const text = "Quilin Agent keeps context assembly minimal in Phase 0.";

		expect(text.length).toBe(55);
		expect(estimateTokens(text)).toBe(14);
	});
});
