import {
	createOpenAICompatible,
	type MetadataExtractor,
} from "@ai-sdk/openai-compatible";
import type {
	LLMProviderId,
	LLMRouteDecision,
	LLMRouteRequest,
	ProviderAuthStrategy,
	ProviderCatalog,
	ProviderCatalogEntry,
	ProviderLiveMatrixEntry,
	ProviderQuotaAwareness,
} from "./types.js";

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

function toDeepSeekMetadata(usage: DeepSeekUsagePayload | undefined):
	| {
			deepseek: {
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
				cacheSource: "native";
			};
	  }
	| undefined {
	if (
		usage?.prompt_cache_hit_tokens == null &&
		usage?.prompt_cache_miss_tokens == null
	) {
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

type EnvLookup = Readonly<Record<string, string | undefined>>;

interface ProviderCredentialProbe {
	readonly env?: EnvLookup;
	readonly existingCredentialPaths?: readonly string[];
}

const unsupportedQuotaAwareness: ProviderQuotaAwareness = {
	status: "unsupported",
	source: "none",
	label: "No quota probe configured",
	requiresExternalApi: false,
};

const deepSeekQuotaAwareness: ProviderQuotaAwareness = {
	status: "planned",
	source: "api_balance",
	label: "DeepSeek API balance endpoint",
	requiresExternalApi: true,
	endpointHint: "Provider account balance endpoint",
};

const openAiCodexOAuthQuotaAwareness: ProviderQuotaAwareness = {
	status: "planned",
	source: "oauth_usage_api",
	label: "Codex OAuth usage snapshot",
	requiresExternalApi: true,
	endpointHint: "ChatGPT subscription usage endpoint",
};

const anthropicOAuthQuotaAwareness: ProviderQuotaAwareness = {
	status: "planned",
	source: "oauth_usage_api",
	label: "Claude OAuth usage snapshot",
	requiresExternalApi: true,
	endpointHint: "Claude subscription usage endpoint",
};

const geminiOAuthQuotaAwareness: ProviderQuotaAwareness = {
	status: "planned",
	source: "oauth_usage_api",
	label: "Gemini OAuth usage snapshot",
	requiresExternalApi: true,
	endpointHint: "Gemini CLI or Google account usage endpoint",
};

export const DEFAULT_PROVIDER_CATALOG: ProviderCatalog = {
	entries: [
		{
			provider: "deepseek",
			status: "enabled",
			transport: "direct",
			defaultModel: "deepseek-v4-pro",
			models: [
				"deepseek-v4-flash",
				"deepseek-v4-pro",
				"deepseek-chat",
				"deepseek-reasoner",
			],
			allowCustomModels: true,
			requiredEnv: ["DEEPSEEK_API_KEY"],
			authStrategies: [
				{
					mode: "api_key",
					source: "env",
					label: "DEEPSEEK_API_KEY",
					requiredEnv: ["DEEPSEEK_API_KEY"],
				},
			],
			quotaAwareness: deepSeekQuotaAwareness,
			liveEvidence: "verified",
		},
		{
			provider: "openai",
			status: "blocked",
			transport: "candidate",
			models: [],
			requiredEnv: ["OPENAI_API_KEY"],
			authStrategies: [
				{
					mode: "api_key",
					source: "env",
					label: "OPENAI_API_KEY",
					requiredEnv: ["OPENAI_API_KEY"],
				},
				{
					mode: "oauth",
					source: "oauth_file",
					label: "Codex OAuth auth.json",
					credentialPath: "~/.codex/auth.json",
					refreshAfterDays: 8,
				},
			],
			quotaAwareness: openAiCodexOAuthQuotaAwareness,
			liveEvidence: "missing",
			blockReason: "No current direct production integration evidence.",
		},
		{
			provider: "anthropic",
			status: "blocked",
			transport: "candidate",
			models: [],
			requiredEnv: ["ANTHROPIC_API_KEY"],
			authStrategies: [
				{
					mode: "api_key",
					source: "env",
					label: "ANTHROPIC_API_KEY",
					requiredEnv: ["ANTHROPIC_API_KEY"],
				},
				{
					mode: "oauth",
					source: "oauth_cli",
					label: "Claude OAuth CLI session",
					credentialPathEnv: "QUILIN_ANTHROPIC_OAUTH_SESSION",
				},
			],
			quotaAwareness: anthropicOAuthQuotaAwareness,
			liveEvidence: "missing",
			blockReason: "No current direct production integration evidence.",
		},
		{
			provider: "gemini",
			status: "candidate",
			transport: "candidate",
			models: [],
			requiredEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"],
			authStrategies: [
				{
					mode: "api_key",
					source: "env",
					label: "GOOGLE_GENERATIVE_AI_API_KEY",
					requiredEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"],
				},
				{
					mode: "oauth",
					source: "oauth_cli",
					label: "Gemini CLI OAuth session",
					credentialPathEnv: "QUILIN_GEMINI_OAUTH_SESSION",
				},
			],
			quotaAwareness: geminiOAuthQuotaAwareness,
			liveEvidence: "missing",
			blockReason: "Candidate data only; no production adapter in this slice.",
		},
	],
};

function findProviderEntry(
	catalog: ProviderCatalog,
	provider: LLMProviderId,
): ProviderCatalogEntry | undefined {
	return catalog.entries.find((entry) => entry.provider === provider);
}

function missingRequiredEnv(
	entry: ProviderCatalogEntry,
	env: EnvLookup,
): readonly string[] {
	return (entry.requiredEnv ?? []).filter((name) => env[name] == null);
}

function inferLegacyApiKeyAuthStrategy(
	entry: ProviderCatalogEntry,
): readonly ProviderAuthStrategy[] {
	if (entry.requiredEnv == null || entry.requiredEnv.length === 0) {
		return [];
	}

	return [
		{
			mode: "api_key",
			source: "env",
			label: entry.requiredEnv.join(" or "),
			requiredEnv: entry.requiredEnv,
		},
	];
}

function listAuthStrategies(
	entry: ProviderCatalogEntry,
): readonly ProviderAuthStrategy[] {
	return entry.authStrategies ?? inferLegacyApiKeyAuthStrategy(entry);
}

function isStrategyConfigured(
	strategy: ProviderAuthStrategy,
	probe: ProviderCredentialProbe,
): boolean {
	const env = probe.env ?? process.env;
	if (
		strategy.requiredEnv?.some((name) => (env[name]?.trim().length ?? 0) > 0)
	) {
		return true;
	}

	if (strategy.credentialPathEnv != null) {
		const credentialPath = env[strategy.credentialPathEnv]?.trim();
		if (
			credentialPath != null &&
			credentialPath.length > 0 &&
			(probe.existingCredentialPaths ?? []).includes(credentialPath)
		) {
			return true;
		}
	}

	if (strategy.credentialPath == null) {
		return false;
	}

	return (probe.existingCredentialPaths ?? []).includes(
		strategy.credentialPath,
	);
}

function describeMissingCredential(strategy: ProviderAuthStrategy): string {
	if (strategy.requiredEnv != null && strategy.requiredEnv.length > 0) {
		return `${strategy.mode}:${strategy.requiredEnv.join("|")}`;
	}

	if (strategy.credentialPathEnv != null) {
		return `${strategy.mode}:${strategy.credentialPathEnv}`;
	}

	if (strategy.credentialPath != null) {
		return `${strategy.mode}:${strategy.credentialPath}`;
	}

	return `${strategy.mode}:${strategy.label}`;
}

export function buildProviderLiveMatrix(
	catalog: ProviderCatalog = DEFAULT_PROVIDER_CATALOG,
	probe: ProviderCredentialProbe = {},
): readonly ProviderLiveMatrixEntry[] {
	return catalog.entries.map((entry) => {
		const strategies = listAuthStrategies(entry);
		const configuredStrategies = strategies.filter((strategy) =>
			isStrategyConfigured(strategy, probe),
		);
		const missingCredentials = strategies
			.filter((strategy) => !isStrategyConfigured(strategy, probe))
			.map(describeMissingCredential);

		return {
			provider: entry.provider,
			status: entry.status,
			transport: entry.transport,
			authModes: Array.from(
				new Set(strategies.map((strategy) => strategy.mode)),
			),
			credentialStatus:
				strategies.length === 0
					? "not_required"
					: configuredStrategies.length > 0
						? "configured"
						: "missing",
			configuredSources: configuredStrategies.map(
				(strategy) => strategy.source,
			),
			missingCredentials,
			liveEvidence: entry.liveEvidence,
			quotaAwareness: entry.quotaAwareness ?? unsupportedQuotaAwareness,
		};
	});
}

function getEnabledDefaultCatalogModels(): readonly string[] {
	return DEFAULT_PROVIDER_CATALOG.entries.flatMap((entry) =>
		entry.status === "enabled" ? entry.models : [],
	);
}

function isModelEnabledForEntry(
	entry: ProviderCatalogEntry,
	model: string,
): boolean {
	return entry.allowCustomModels === true || entry.models.includes(model);
}

function getDeepSeekDefaultCatalogEntry(): ProviderCatalogEntry & {
	readonly defaultModel: string;
} {
	const entry = DEFAULT_PROVIDER_CATALOG.entries.find(
		(candidate) => candidate.provider === "deepseek",
	);
	if (
		entry == null ||
		entry.status !== "enabled" ||
		entry.defaultModel == null
	) {
		throw new Error(
			"DEFAULT_PROVIDER_CATALOG requires enabled DeepSeek default model.",
		);
	}

	return { ...entry, defaultModel: entry.defaultModel };
}

export function validateProviderCatalog(
	catalog: ProviderCatalog = DEFAULT_PROVIDER_CATALOG,
	env: EnvLookup = process.env,
): ProviderCatalog {
	for (const entry of catalog.entries) {
		if (entry.status !== "enabled") {
			continue;
		}

		const missing = missingRequiredEnv(entry, env);
		if (missing.length > 0) {
			throw new Error(
				`Enabled provider ${entry.provider} is missing required env: ${missing.join(", ")}`,
			);
		}

		if (entry.liveEvidence !== "verified") {
			throw new Error(
				`Enabled provider ${entry.provider} requires verified live evidence.`,
			);
		}

		if (
			entry.defaultModel == null ||
			!isModelEnabledForEntry(entry, entry.defaultModel)
		) {
			throw new Error(
				`Enabled provider ${entry.provider} requires a default model in its model list.`,
			);
		}
	}

	return catalog;
}

export function decideLLMRoute(
	request: LLMRouteRequest,
	catalog: ProviderCatalog = DEFAULT_PROVIDER_CATALOG,
): LLMRouteDecision {
	const entry = findProviderEntry(catalog, request.provider);
	if (entry == null) {
		throw new Error(
			`Provider ${request.provider} is not in the provider catalog.`,
		);
	}

	if (entry.status !== "enabled") {
		throw new Error(
			`Provider ${request.provider} is ${entry.status}; no provider fallback is configured.`,
		);
	}

	if (!isModelEnabledForEntry(entry, request.model)) {
		throw new Error(
			`Model ${request.model} is not enabled for provider ${request.provider}.`,
		);
	}

	const effectiveModel =
		request.provider === "deepseek" &&
		request.model === "deepseek-chat" &&
		request.thinkingMode != null &&
		request.thinkingMode !== "disabled"
			? "deepseek-reasoner"
			: request.model;

	if (!isModelEnabledForEntry(entry, effectiveModel)) {
		throw new Error(
			`Effective model ${effectiveModel} is not enabled for provider ${request.provider}.`,
		);
	}

	return {
		provider: request.provider,
		configuredModel: request.model,
		effectiveModel,
		fallbackUsed: false,
		reasoningStateAdapter:
			request.thinkingMode == null || request.thinkingMode === "disabled"
				? "none"
				: request.provider === "deepseek"
					? "captured_replayed_for_tool_calls"
					: "captured_not_replayed",
	};
}

export function createProvider() {
	validateProviderCatalog();
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) {
		throw new Error(
			"DEEPSEEK_API_KEY is required. Copy .env.example to .env and fill in your key.",
		);
	}

	return createOpenAICompatible({
		name: "deepseek",
		baseURL: "https://api.deepseek.com",
		apiKey,
		includeUsage: true,
		metadataExtractor: metadataExtractorRegistry.deepseek,
	});
}

export function getDefaultModel() {
	const configuredModel = process.env.QUILIN_DEFAULT_MODEL;
	if (configuredModel == null || configuredModel.length === 0) {
		return getDeepSeekDefaultCatalogEntry().defaultModel;
	}

	const enabledModels = getEnabledDefaultCatalogModels();
	if (!enabledModels.includes(configuredModel)) {
		throw new Error(
			`QUILIN_DEFAULT_MODEL ${configuredModel} is not enabled in DEFAULT_PROVIDER_CATALOG.`,
		);
	}

	return configuredModel;
}
