import { describe, expect, it } from "vitest";
import {
	normalizeTokenUsage,
	type ProviderMetadataLike,
} from "./token-usage.js";

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

	it("handles empty usage and provider metadata variants", () => {
		expect(normalizeTokenUsage(undefined)).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cache: undefined,
		});
		expect(
			normalizeTokenUsage(
				{
					promptTokens: 1,
					completionTokens: 2,
				},
				{
					anthropic: {
						cacheReadTokens: 4,
					},
				},
			),
		).toEqual({
			inputTokens: 1,
			outputTokens: 2,
			cache: {
				readTokens: 4,
				writeTokens: undefined,
				source: "unknown",
			},
		});
		expect(
			normalizeTokenUsage(
				{
					inputTokens: 3,
					outputTokens: 5,
				},
				{
					deepseek: "not-cache-metadata",
					openai: {
						cacheWriteTokens: 8,
						cacheSource: "native",
					},
				} as unknown as ProviderMetadataLike,
			),
		).toEqual({
			inputTokens: 3,
			outputTokens: 5,
			cache: {
				readTokens: undefined,
				writeTokens: 8,
				source: "native",
			},
		});
	});
});
