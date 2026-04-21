import type { LanguageModel } from "ai";
import { vi } from "vitest";
import type { createProvider } from "../llm/provider.js";

type GenerateTextResult = Awaited<
	ReturnType<typeof import("ai").generateText>
>;

type StreamTextResult = ReturnType<typeof import("ai").streamText>;

export function createMockLanguageModel(
	overrides: Partial<Record<string, unknown>> = {},
): LanguageModel {
	return {
		specificationVersion: "v3",
		provider: "mock-provider",
		modelId: "mock-model",
		supportedUrls: {},
		doGenerate: vi.fn(),
		doStream: vi.fn(),
		...overrides,
	} as unknown as LanguageModel;
}

export function mockGenerateTextResult(overrides: Record<string, unknown> = {}) {
	return overrides as unknown as GenerateTextResult;
}

export function mockStreamTextResult(overrides: Record<string, unknown> = {}) {
	return overrides as unknown as StreamTextResult;
}

export function createMockProvider(
	modelFactory: (requestedModelId: string) => LanguageModel = (requestedModelId) =>
		createMockLanguageModel({
			provider: "deepseek",
			modelId: requestedModelId,
		}),
): ReturnType<typeof createProvider> {
	const provider = Object.assign(
		(requestedModelId: string) => modelFactory(requestedModelId),
		{
			specificationVersion: "v3",
			languageModel: vi.fn((requestedModelId: string) =>
				modelFactory(requestedModelId),
			),
			chatModel: vi.fn((requestedModelId: string) => modelFactory(requestedModelId)),
			completionModel: vi.fn((requestedModelId: string) =>
				modelFactory(requestedModelId),
			),
			embeddingModel: vi.fn(),
			textEmbeddingModel: vi.fn(),
			imageModel: vi.fn(),
		},
	);

	return provider as unknown as ReturnType<typeof createProvider>;
}
