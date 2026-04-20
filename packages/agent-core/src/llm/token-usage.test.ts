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
					cacheWriteTokens: 7,
				},
			}),
		).toEqual({
			inputTokens: 12,
			outputTokens: 34,
			cache: {
				readTokens: 5,
				writeTokens: 7,
				source: "native",
			},
		});
	});

	it("normalizes AI SDK v6 usage shapes", () => {
		expect(
			normalizeTokenUsage({
				inputTokens: 12,
				outputTokens: 34,
				inputTokenDetails: {
					cacheReadTokens: 5,
					cacheWriteTokens: 7,
				},
			}),
		).toEqual({
			inputTokens: 12,
			outputTokens: 34,
			cache: {
				readTokens: 5,
				writeTokens: 7,
				source: "native",
			},
		});
	});

	it("falls back to provider metadata when generic usage lacks cache details", () => {
		expect(
			normalizeTokenUsage(
				{
					inputTokens: 12,
					outputTokens: 34,
				},
				{
					deepseek: {
						cacheReadTokens: 9,
						cacheWriteTokens: 3,
						cacheSource: "native",
					},
				},
			),
		).toEqual({
			inputTokens: 12,
			outputTokens: 34,
			cache: {
				readTokens: 9,
				writeTokens: 3,
				source: "native",
			},
		});
	});
});
