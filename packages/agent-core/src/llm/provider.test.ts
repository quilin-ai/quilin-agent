import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "./provider.js";

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => vi.fn()),
}));

describe("createProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.DEEPSEEK_API_KEY = "test-key";
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
});
