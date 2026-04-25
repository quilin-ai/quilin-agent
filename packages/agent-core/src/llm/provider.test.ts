import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider, getDefaultModel } from "./provider.js";

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => vi.fn()),
}));

const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const originalDefaultModel = process.env.QUILIN_DEFAULT_MODEL;

afterEach(() => {
	if (originalDeepSeekApiKey == null) {
		delete process.env.DEEPSEEK_API_KEY;
	} else {
		process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
	}
	if (originalDefaultModel == null) {
		delete process.env.QUILIN_DEFAULT_MODEL;
	} else {
		process.env.QUILIN_DEFAULT_MODEL = originalDefaultModel;
	}
});

describe("createProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.DEEPSEEK_API_KEY = "test-key";
		delete process.env.QUILIN_DEFAULT_MODEL;
	});

	it("enables usage collection and installs the DeepSeek metadata extractor", () => {
		createProvider();

		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "deepseek",
				baseURL: "https://api.deepseek.com/v1",
				apiKey: "test-key",
				includeUsage: true,
				metadataExtractor: expect.objectContaining({
					extractMetadata: expect.any(Function),
					createStreamExtractor: expect.any(Function),
				}),
			}),
		);
	});

	it("extracts DeepSeek cache usage from raw responses", async () => {
		createProvider();

		const options = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0];
		const metadata = await options?.metadataExtractor?.extractMetadata({
			parsedBody: {
				usage: {
					prompt_cache_hit_tokens: 120,
					prompt_cache_miss_tokens: 30,
				},
			},
		});

		expect(metadata).toEqual({
			deepseek: {
				cacheReadTokens: 120,
				cacheWriteTokens: 30,
				cacheSource: "native",
			},
		});
	});

	it("extracts DeepSeek cache usage from streamed responses", () => {
		createProvider();

		const options = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0];
		const streamExtractor = options?.metadataExtractor?.createStreamExtractor();
		streamExtractor?.processChunk({
			usage: {
				prompt_cache_hit_tokens: 48,
				prompt_cache_miss_tokens: 12,
			},
		});

		expect(streamExtractor?.buildMetadata()).toEqual({
			deepseek: {
				cacheReadTokens: 48,
				cacheWriteTokens: 12,
				cacheSource: "native",
			},
		});
	});

	it("requires a DeepSeek API key before constructing the provider", () => {
		delete process.env.DEEPSEEK_API_KEY;

		expect(() => createProvider()).toThrow(/DEEPSEEK_API_KEY/);
		expect(createOpenAICompatible).not.toHaveBeenCalled();
	});

	it("returns undefined metadata for malformed or cache-free DeepSeek usage", async () => {
		createProvider();

		const options = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0];
		const extractor = options?.metadataExtractor;

		await expect(
			extractor?.extractMetadata({ parsedBody: null }),
		).resolves.toBeUndefined();
		await expect(
			extractor?.extractMetadata({ parsedBody: { usage: null } }),
		).resolves.toBeUndefined();
		await expect(
			extractor?.extractMetadata({ parsedBody: { usage: {} } }),
		).resolves.toBeUndefined();
		await expect(
			extractor?.extractMetadata({
				parsedBody: { usage: { prompt_cache_miss_tokens: 9 } },
			}),
		).resolves.toEqual({
			deepseek: {
				cacheReadTokens: undefined,
				cacheWriteTokens: 9,
				cacheSource: "native",
			},
		});
	});

	it("keeps the latest valid streamed DeepSeek usage and ignores invalid chunks", () => {
		createProvider();

		const options = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0];
		const streamExtractor = options?.metadataExtractor?.createStreamExtractor();

		expect(streamExtractor?.buildMetadata()).toBeUndefined();
		streamExtractor?.processChunk(null);
		streamExtractor?.processChunk({ usage: null });
		expect(streamExtractor?.buildMetadata()).toBeUndefined();

		streamExtractor?.processChunk({
			usage: {
				prompt_cache_hit_tokens: 7,
			},
		});

		expect(streamExtractor?.buildMetadata()).toEqual({
			deepseek: {
				cacheReadTokens: 7,
				cacheWriteTokens: undefined,
				cacheSource: "native",
			},
		});
	});
});

describe("getDefaultModel", () => {
	it("falls back to deepseek-chat when no override is configured", () => {
		delete process.env.QUILIN_DEFAULT_MODEL;

		expect(getDefaultModel()).toBe("deepseek-chat");
	});

	it("uses the configured model override", () => {
		process.env.QUILIN_DEFAULT_MODEL = "deepseek-reasoner";

		expect(getDefaultModel()).toBe("deepseek-reasoner");
	});
});
