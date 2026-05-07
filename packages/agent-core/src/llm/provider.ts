import {
	createOpenAICompatible,
	type MetadataExtractor,
} from "@ai-sdk/openai-compatible";
import type {
	LLMProviderId,
	LLMRouteDecision,
	LLMRouteRequest,
	ProviderAuthMode,
	ProviderAuthStrategy,
	ProviderCatalog,
	ProviderCatalogEntry,
	ProviderCredentialSource,
	ProviderLiveMatrixEntry,
	ProviderQuotaAwareness,
	ProviderQuotaAwarenessStatus,
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

export interface ProviderCredentialProbe {
	readonly env?: EnvLookup;
	readonly existingCredentialPaths?: readonly string[];
}

export type ProviderMissingCredentialReasonCode =
	| "credential_path_env_empty"
	| "credential_path_env_unset"
	| "credential_path_missing"
	| "env_empty"
	| "env_unset"
	| "unknown";

export interface ProviderMissingCredentialReason {
	readonly mode: ProviderAuthMode;
	readonly source: ProviderCredentialSource;
	readonly redactedSource: string;
	readonly code: ProviderMissingCredentialReasonCode;
	readonly message: string;
}

export interface ProviderCredentialLiveCheck {
	readonly mode: ProviderAuthMode;
	readonly source: ProviderCredentialSource;
	readonly label: string;
	readonly status: "configured" | "missing";
	readonly redactedSource: string;
	readonly missingReason?: ProviderMissingCredentialReason;
}

export interface ProviderQuotaProbeDescriptor {
	readonly status: ProviderQuotaAwarenessStatus;
	readonly source: ProviderQuotaAwareness["source"];
	readonly ready: boolean;
	readonly requiresExternalApi: boolean;
	readonly endpointHint?: string;
	readonly blockedReason?: string;
	readonly redactedCredentialSources: readonly string[];
}

export type ProviderLiveMatrixEntryWithDetails = ProviderLiveMatrixEntry & {
	readonly credentialChecks: readonly ProviderCredentialLiveCheck[];
	readonly missingCredentialReasons: readonly ProviderMissingCredentialReason[];
	readonly redactedSources: readonly string[];
	readonly quotaStatus: ProviderQuotaAwarenessStatus;
	readonly quotaProbe: ProviderQuotaProbeDescriptor;
};

export interface ProviderQuotaProbeRequest {
	readonly provider: LLMProviderId;
	readonly quotaStatus: ProviderQuotaAwarenessStatus;
	readonly quotaSource: ProviderQuotaAwareness["source"];
	readonly credentialMode: ProviderAuthMode;
	readonly credentialSource: ProviderCredentialSource;
	readonly redactedSource: string;
	readonly requiresExternalApi: boolean;
	readonly endpointHint?: string;
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

function redactedCredentialSource(strategy: ProviderAuthStrategy): string {
	if (strategy.requiredEnv != null && strategy.requiredEnv.length > 0) {
		return `env:${strategy.requiredEnv.join("|")}`;
	}

	if (strategy.credentialPathEnv != null) {
		return `${strategy.source}:${strategy.credentialPathEnv}`;
	}

	if (strategy.credentialPath != null) {
		return `${strategy.source}:${strategy.credentialPath}`;
	}

	return `${strategy.source}:${strategy.label}`;
}

function missingReason(
	strategy: ProviderAuthStrategy,
	code: ProviderMissingCredentialReasonCode,
	message: string,
): ProviderMissingCredentialReason {
	return {
		mode: strategy.mode,
		source: strategy.source,
		redactedSource: redactedCredentialSource(strategy),
		code,
		message,
	};
}

function evaluateCredentialStrategy(
	strategy: ProviderAuthStrategy,
	probe: ProviderCredentialProbe,
): ProviderCredentialLiveCheck {
	const env = probe.env ?? process.env;
	const redactedSource = redactedCredentialSource(strategy);
	const existingCredentialPaths = probe.existingCredentialPaths ?? [];

	if (strategy.requiredEnv != null && strategy.requiredEnv.length > 0) {
		const hasConfiguredEnv = strategy.requiredEnv.some(
			(name) => (env[name]?.trim().length ?? 0) > 0,
		);
		if (hasConfiguredEnv) {
			return {
				mode: strategy.mode,
				source: strategy.source,
				label: strategy.label,
				status: "configured",
				redactedSource,
			};
		}

		const hasEmptyEnv = strategy.requiredEnv.some(
			(name) => env[name] != null && env[name]?.trim().length === 0,
		);
		return {
			mode: strategy.mode,
			source: strategy.source,
			label: strategy.label,
			status: "missing",
			redactedSource,
			missingReason: missingReason(
				strategy,
				hasEmptyEnv ? "env_empty" : "env_unset",
				hasEmptyEnv
					? `Environment credential ${strategy.requiredEnv.join(" or ")} is present but empty.`
					: `Set ${strategy.requiredEnv.join(" or ")} to enable ${strategy.label}.`,
			),
		};
	}

	if (strategy.credentialPathEnv != null) {
		const credentialPath = env[strategy.credentialPathEnv]?.trim();
		if (credentialPath == null || credentialPath.length === 0) {
			return {
				mode: strategy.mode,
				source: strategy.source,
				label: strategy.label,
				status: "missing",
				redactedSource,
				missingReason: missingReason(
					strategy,
					env[strategy.credentialPathEnv] == null
						? "credential_path_env_unset"
						: "credential_path_env_empty",
					`Set ${strategy.credentialPathEnv} to the credential file path for ${strategy.label}.`,
				),
			};
		}

		if (existingCredentialPaths.includes(credentialPath)) {
			return {
				mode: strategy.mode,
				source: strategy.source,
				label: strategy.label,
				status: "configured",
				redactedSource,
			};
		}

		return {
			mode: strategy.mode,
			source: strategy.source,
			label: strategy.label,
			status: "missing",
			redactedSource,
			missingReason: missingReason(
				strategy,
				"credential_path_missing",
				`Credential file from ${strategy.credentialPathEnv} was not found.`,
			),
		};
	}

	if (strategy.credentialPath != null) {
		if (existingCredentialPaths.includes(strategy.credentialPath)) {
			return {
				mode: strategy.mode,
				source: strategy.source,
				label: strategy.label,
				status: "configured",
				redactedSource,
			};
		}

		return {
			mode: strategy.mode,
			source: strategy.source,
			label: strategy.label,
			status: "missing",
			redactedSource,
			missingReason: missingReason(
				strategy,
				"credential_path_missing",
				`Credential file ${strategy.credentialPath} was not found.`,
			),
		};
	}

	return {
		mode: strategy.mode,
		source: strategy.source,
		label: strategy.label,
		status: "missing",
		redactedSource,
		missingReason: missingReason(
			strategy,
			"unknown",
			`No credential source is configured for ${strategy.label}.`,
		),
	};
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

function quotaProbeDescriptor(
	quotaAwareness: ProviderQuotaAwareness,
	configuredCredentialChecks: readonly ProviderCredentialLiveCheck[],
): ProviderQuotaProbeDescriptor {
	const redactedCredentialSources = configuredCredentialChecks.map(
		(check) => check.redactedSource,
	);
	if (quotaAwareness.status === "unsupported") {
		return {
			status: quotaAwareness.status,
			source: quotaAwareness.source,
			ready: false,
			requiresExternalApi: quotaAwareness.requiresExternalApi,
			blockedReason: "quota_awareness_unsupported",
			redactedCredentialSources,
		};
	}

	if (configuredCredentialChecks.length === 0) {
		return {
			status: quotaAwareness.status,
			source: quotaAwareness.source,
			ready: false,
			requiresExternalApi: quotaAwareness.requiresExternalApi,
			...(quotaAwareness.endpointHint == null
				? {}
				: { endpointHint: quotaAwareness.endpointHint }),
			blockedReason: "missing_configured_credential",
			redactedCredentialSources,
		};
	}

	return {
		status: quotaAwareness.status,
		source: quotaAwareness.source,
		ready: true,
		requiresExternalApi: quotaAwareness.requiresExternalApi,
		...(quotaAwareness.endpointHint == null
			? {}
			: { endpointHint: quotaAwareness.endpointHint }),
		redactedCredentialSources,
	};
}

export function listProviderCredentialPathCandidates(
	catalog: ProviderCatalog = DEFAULT_PROVIDER_CATALOG,
	env: EnvLookup = process.env,
): readonly string[] {
	const paths: string[] = [];
	for (const entry of catalog.entries) {
		for (const strategy of listAuthStrategies(entry)) {
			if (strategy.credentialPath != null) {
				paths.push(strategy.credentialPath);
			}
			if (strategy.credentialPathEnv != null) {
				const envPath = env[strategy.credentialPathEnv]?.trim();
				if (envPath != null && envPath.length > 0) {
					paths.push(envPath);
				}
			}
		}
	}

	return Array.from(new Set(paths));
}

export function buildProviderLiveMatrix(
	catalog: ProviderCatalog = DEFAULT_PROVIDER_CATALOG,
	probe: ProviderCredentialProbe = {},
): readonly ProviderLiveMatrixEntryWithDetails[] {
	return catalog.entries.map((entry) => {
		const strategies = listAuthStrategies(entry);
		const credentialChecks = strategies.map((strategy) =>
			evaluateCredentialStrategy(strategy, probe),
		);
		const configuredCredentialChecks = credentialChecks.filter(
			(check) => check.status === "configured",
		);
		const configuredStrategies = strategies.filter((strategy) =>
			isStrategyConfigured(strategy, probe),
		);
		const missingCredentialReasons = credentialChecks
			.map((check) => check.missingReason)
			.filter(
				(reason): reason is ProviderMissingCredentialReason => reason != null,
			);
		const missingCredentials = strategies
			.filter((strategy) => !isStrategyConfigured(strategy, probe))
			.map(describeMissingCredential);
		const quotaAwareness = entry.quotaAwareness ?? unsupportedQuotaAwareness;

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
			quotaAwareness,
			credentialChecks,
			missingCredentialReasons,
			redactedSources: configuredCredentialChecks.map(
				(check) => check.redactedSource,
			),
			quotaStatus: quotaAwareness.status,
			quotaProbe: quotaProbeDescriptor(
				quotaAwareness,
				configuredCredentialChecks,
			),
		};
	});
}

export function buildProviderQuotaProbeRequests(
	matrix: readonly ProviderLiveMatrixEntryWithDetails[] = buildProviderLiveMatrix(),
): readonly ProviderQuotaProbeRequest[] {
	return matrix.flatMap((entry) => {
		if (!entry.quotaProbe.ready || entry.quotaStatus === "unsupported") {
			return [];
		}

		return entry.credentialChecks
			.filter((check) => check.status === "configured")
			.map((check) => ({
				provider: entry.provider,
				quotaStatus: entry.quotaStatus,
				quotaSource: entry.quotaAwareness.source,
				credentialMode: check.mode,
				credentialSource: check.source,
				redactedSource: check.redactedSource,
				requiresExternalApi: entry.quotaAwareness.requiresExternalApi,
				...(entry.quotaAwareness.endpointHint == null
					? {}
					: { endpointHint: entry.quotaAwareness.endpointHint }),
			}));
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
