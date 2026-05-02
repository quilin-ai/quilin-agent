import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createProvider,
	DEFAULT_PROVIDER_CATALOG,
	decideLLMRoute,
	getDefaultModel,
	validateProviderCatalog,
} from "./provider.js";

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
				baseURL: "https://api.deepseek.com",
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
	it("falls back to deepseek-v4-pro when no override is configured", () => {
		delete process.env.QUILIN_DEFAULT_MODEL;

		expect(getDefaultModel()).toBe("deepseek-v4-pro");
	});

	it("uses the configured model override", () => {
		process.env.QUILIN_DEFAULT_MODEL = "deepseek-v4-flash";

		expect(getDefaultModel()).toBe("deepseek-v4-flash");
	});

	it("rejects providerless model overrides outside the enabled default catalog", () => {
		process.env.QUILIN_DEFAULT_MODEL = "gpt-4.1";

		expect(() => getDefaultModel()).toThrow(
			/QUILIN_DEFAULT_MODEL gpt-4\.1 is not enabled in DEFAULT_PROVIDER_CATALOG/,
		);
	});
});

describe("provider catalog", () => {
	it("accepts enabled DeepSeek and blocked providers with missing env", () => {
		expect(() =>
			validateProviderCatalog(DEFAULT_PROVIDER_CATALOG, {
				DEEPSEEK_API_KEY: "test-key",
			}),
		).not.toThrow();
	});

	it("rejects enabled providers without required env or live evidence", () => {
		expect(() => validateProviderCatalog(DEFAULT_PROVIDER_CATALOG, {})).toThrow(
			/DEEPSEEK_API_KEY/,
		);

		expect(() =>
			validateProviderCatalog(
				{
					entries: [
						{
							provider: "deepseek",
							status: "enabled",
							transport: "direct",
							defaultModel: "deepseek-v4-pro",
							models: ["deepseek-v4-pro"],
							requiredEnv: ["DEEPSEEK_API_KEY"],
							liveEvidence: "missing",
						},
					],
				},
				{ DEEPSEEK_API_KEY: "test-key" },
			),
		).toThrow(/verified live evidence/);
	});
});

describe("decideLLMRoute", () => {
	it("emits configured and effective DeepSeek models", () => {
		expect(
			decideLLMRoute(
				{
					provider: "deepseek",
					model: "deepseek-v4-pro",
					thinkingMode: "enabled",
				},
				DEFAULT_PROVIDER_CATALOG,
			),
		).toEqual({
			provider: "deepseek",
			configuredModel: "deepseek-v4-pro",
			effectiveModel: "deepseek-v4-pro",
			fallbackUsed: false,
			reasoningStateAdapter: "captured_replayed_for_tool_calls",
		});
	});

	it("keeps legacy DeepSeek thinking compatibility for deepseek-chat", () => {
		expect(
			decideLLMRoute(
				{
					provider: "deepseek",
					model: "deepseek-chat",
					thinkingMode: "enabled",
				},
				DEFAULT_PROVIDER_CATALOG,
			),
		).toEqual({
			provider: "deepseek",
			configuredModel: "deepseek-chat",
			effectiveModel: "deepseek-reasoner",
			fallbackUsed: false,
			reasoningStateAdapter: "captured_replayed_for_tool_calls",
		});
	});

	it("allows arbitrary DeepSeek model ids without changing the effective model", () => {
		expect(
			decideLLMRoute(
				{
					provider: "deepseek",
					model: "deepseek-custom-router-target",
					thinkingMode: "disabled",
				},
				DEFAULT_PROVIDER_CATALOG,
			),
		).toEqual({
			provider: "deepseek",
			configuredModel: "deepseek-custom-router-target",
			effectiveModel: "deepseek-custom-router-target",
			fallbackUsed: false,
			reasoningStateAdapter: "none",
		});
	});

	it("refuses silent provider substitution when a provider is blocked", () => {
		expect(() =>
			decideLLMRoute(
				{
					provider: "openai",
					model: "gpt-4.1",
					thinkingMode: "disabled",
				},
				DEFAULT_PROVIDER_CATALOG,
			),
		).toThrow(/no provider fallback/);
	});
});
