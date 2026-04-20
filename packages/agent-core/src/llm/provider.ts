import {
	createOpenAICompatible,
	type MetadataExtractor,
} from "@ai-sdk/openai-compatible";

interface DeepSeekUsagePayload {
	readonly prompt_cache_hit_tokens?: number;
	readonly prompt_cache_miss_tokens?: number;
}

interface DeepSeekResponseLike {
	readonly usage?: DeepSeekUsagePayload;
}

function readDeepSeekUsage(value: unknown): DeepSeekUsagePayload | undefined {
	if (value == null || typeof value !== "object") {
		return undefined;
	}

	const usage = (value as DeepSeekResponseLike).usage;
	if (usage == null || typeof usage !== "object") {
		return undefined;
	}

	return usage;
}

function toDeepSeekMetadata(
	usage: DeepSeekUsagePayload | undefined,
): { deepseek: { cacheReadTokens?: number; cacheWriteTokens?: number; cacheSource: "native" } } | undefined {
	if (usage?.prompt_cache_hit_tokens == null && usage?.prompt_cache_miss_tokens == null) {
		return undefined;
	}

	return {
		deepseek: {
			cacheReadTokens: usage?.prompt_cache_hit_tokens,
			cacheWriteTokens: usage?.prompt_cache_miss_tokens,
			cacheSource: "native",
		},
	};
}

const deepSeekMetadataExtractor: MetadataExtractor = {
	async extractMetadata({ parsedBody }) {
		return toDeepSeekMetadata(readDeepSeekUsage(parsedBody));
	},
	createStreamExtractor() {
		let latestUsage: DeepSeekUsagePayload | undefined;

		return {
			processChunk(parsedChunk) {
				const usage = readDeepSeekUsage(parsedChunk);
				if (usage != null) {
					latestUsage = usage;
				}
			},
			buildMetadata() {
				return toDeepSeekMetadata(latestUsage);
			},
		};
	},
};

const metadataExtractorRegistry = {
	deepseek: deepSeekMetadataExtractor,
	"openai-compatible-default": undefined,
} as const;

export function createProvider() {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) {
		throw new Error(
			"DEEPSEEK_API_KEY is required. Copy .env.example to .env and fill in your key.",
		);
	}

	return createOpenAICompatible({
		name: "deepseek",
		baseURL: "https://api.deepseek.com/v1",
		apiKey,
		includeUsage: true,
		metadataExtractor: metadataExtractorRegistry.deepseek,
	});
}

export function getDefaultModel() {
	return process.env.QUILIN_DEFAULT_MODEL ?? "deepseek-chat";
}
