import { describe, expect, it } from "vitest";
import { normalizeTokenUsage } from "./token-usage.js";

describe("normalizeTokenUsage", () => {
	it("normalizes AI SDK v5 usage shapes", () => {
		expect(
			normalizeTokenUsage({
				promptTokens: 12,
				completionTokens: 34,
				inputTokenDetails: {
					cacheReadTokens: 5,
				},
			}),
		).toEqual({
			inputTokens: 12,
			outputTokens: 34,
			cacheHitTokens: 5,
		});
	});

	it("normalizes AI SDK v6 usage shapes", () => {
		expect(
			normalizeTokenUsage({
				inputTokens: 12,
				outputTokens: 34,
				inputTokenDetails: {
					cacheReadTokens: 5,
				},
			}),
		).toEqual({
			inputTokens: 12,
			outputTokens: 34,
			cacheHitTokens: 5,
		});
	});
});
