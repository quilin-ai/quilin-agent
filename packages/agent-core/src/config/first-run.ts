import type { ProviderLiveMatrixEntry } from "../llm/types.js";
import type { CapabilitiesConfig } from "./types.js";
import type { UserConfigLoadResult } from "./user-config.js";
import type { UserConfig } from "./user-config-schema.js";

export type FirstRunStepId =
	| "provider"
	| "mcp"
	| "skills"
	| "memory"
	| "safety"
	| "review";

export type FirstRunStepStatus = "complete" | "recommended" | "required";

export interface FirstRunOnboardingStep {
	readonly id: FirstRunStepId;
	readonly status: FirstRunStepStatus;
	readonly title: string;
	readonly summary: string;
	readonly actions: readonly string[];
}

export interface FirstRunOnboardingInput {
	readonly userConfig: Pick<
		UserConfigLoadResult,
		"config" | "filePath" | "sources"
	>;
	readonly capabilities?: CapabilitiesConfig;
	readonly providerMatrix?: readonly ProviderLiveMatrixEntry[];
}

export interface FirstRunOnboardingPlan {
	readonly firstRun: boolean;
	readonly ready: boolean;
	readonly configPath: string | null;
	readonly requiredStepIds: readonly FirstRunStepId[];
	readonly recommendedStepIds: readonly FirstRunStepId[];
	readonly steps: readonly FirstRunOnboardingStep[];
	readonly redactedConfigSummary: RedactedConfigSummary;
}

export interface RedactedConfigSummary {
	readonly llm: {
		readonly routingMode: UserConfig["llm"]["routing"]["mode"];
		readonly defaultTier: UserConfig["llm"]["routing"]["default_tier"];
		readonly providers: readonly string[];
		readonly models: readonly string[];
	};
	readonly memory: {
		readonly scratchpadTtlSec: number;
		readonly scratchpadCapacityPerTask: number;
	};
	readonly observability: {
		readonly logLevel: UserConfig["observability"]["log_level"];
		readonly tracingEnabled: boolean;
		readonly metricsEnabled: boolean;
	};
	readonly session: {
		readonly storage: UserConfig["session"]["storage"];
		readonly dbPath: string;
	};
	readonly tools: {
		readonly enabledCount: number;
		readonly disabledCount: number;
	};
	readonly idleEvolution: {
		readonly enabled: boolean;
		readonly mode: UserConfig["idle_evolution"]["mode"];
	};
	readonly safety: {
		readonly trustMode: UserConfig["safety"]["trust_mode"];
	};
}

export function buildFirstRunOnboardingPlan(
	input: FirstRunOnboardingInput,
): FirstRunOnboardingPlan {
	const config = input.userConfig.config;
	const firstRun = input.userConfig.filePath == null;
	const steps = [
		buildProviderStep(config, input.providerMatrix),
		buildMcpStep(input.capabilities),
		buildSkillsStep(input.capabilities),
		buildMemoryStep(input.capabilities),
		buildSafetyStep(config),
		buildReviewStep(firstRun),
	] as const;
	const requiredStepIds = steps
		.filter((step) => step.status === "required")
		.map((step) => step.id);
	const recommendedStepIds = steps
		.filter((step) => step.status === "recommended")
		.map((step) => step.id);

	return {
		firstRun,
		ready: requiredStepIds.length === 0,
		configPath: input.userConfig.filePath,
		requiredStepIds,
		recommendedStepIds,
		steps,
		redactedConfigSummary: buildRedactedConfigSummary(config),
	};
}

function buildProviderStep(
	config: UserConfig,
	providerMatrix: readonly ProviderLiveMatrixEntry[] | undefined,
): FirstRunOnboardingStep {
	const configuredProviders =
		providerMatrix?.filter(
			(entry) => entry.credentialStatus === "configured",
		) ?? [];
	const selectedProviders = getConfiguredTierProviders(config);
	const selectedConfigured = configuredProviders.filter((entry) =>
		selectedProviders.includes(entry.provider),
	);
	const missingSelected =
		providerMatrix?.filter(
			(entry) =>
				selectedProviders.includes(entry.provider) &&
				entry.credentialStatus === "missing",
		) ?? [];

	if (selectedConfigured.length > 0) {
		return {
			id: "provider",
			status: "complete",
			title: "Provider",
			summary: `Configured provider credential found for ${selectedConfigured
				.map((entry) => entry.provider)
				.join(", ")}.`,
			actions: ["Validate provider live status before the first model call."],
		};
	}

	return {
		id: "provider",
		status: "required",
		title: "Provider",
		summary:
			missingSelected.length > 0
				? `Missing credentials for selected provider(s): ${missingSelected
						.map((entry) => entry.provider)
						.join(", ")}.`
				: "No configured provider credential was found.",
		actions: [
			"Choose API Key or OAuth setup for at least one provider.",
			"Validate credential status without logging raw secrets.",
		],
	};
}

function buildMcpStep(
	capabilities: CapabilitiesConfig | undefined,
): FirstRunOnboardingStep {
	const servers = capabilities?.mcpServers ?? {};
	const enabledServers = Object.entries(servers).filter(
		([, server]) => server.enabled !== false,
	);
	if (enabledServers.length > 0) {
		return {
			id: "mcp",
			status: "complete",
			title: "MCP",
			summary: `${enabledServers.length} MCP server(s) enabled.`,
			actions: ["Review MCP health in /status or the Web control surface."],
		};
	}

	return {
		id: "mcp",
		status: "recommended",
		title: "MCP",
		summary: "No enabled MCP server is configured.",
		actions: [
			"Enable bundled quilin-mem MCP when available.",
			"Add optional MCP servers after reviewing command, cwd, env, and risk.",
		],
	};
}

function buildSkillsStep(
	capabilities: CapabilitiesConfig | undefined,
): FirstRunOnboardingStep {
	const skills = capabilities?.skills;
	const roots = [
		...(skills?.bundledRoots ?? []),
		...(skills?.userRoots ?? []),
		...(skills?.projectRoots ?? []),
		...(skills?.pluginRoots ?? []),
	];
	if (skills?.enabled !== false && roots.length > 0) {
		return {
			id: "skills",
			status: "complete",
			title: "Skills",
			summary: `${roots.length} skill root(s) configured; watcher ${
				skills?.watcherEnabled === false ? "disabled" : "enabled"
			}.`,
			actions: [
				"Use skill_search to discover skills without eager loading bodies.",
			],
		};
	}

	return {
		id: "skills",
		status: "recommended",
		title: "Skills",
		summary: "No skill root is configured.",
		actions: [
			"Configure bundled, user, project, or plugin skill roots.",
			"Enable watcher-based reload unless the environment requires manual reload.",
		],
	};
}

function buildMemoryStep(
	capabilities: CapabilitiesConfig | undefined,
): FirstRunOnboardingStep {
	const servers = Object.entries(capabilities?.mcpServers ?? {});
	const hasMemoryServer = servers.some(([id, server]) =>
		`${id} ${server.namespace ?? ""} ${server.command} ${server.args.join(" ")}`
			.toLowerCase()
			.includes("memory"),
	);
	if (hasMemoryServer) {
		return {
			id: "memory",
			status: "complete",
			title: "Memory",
			summary: "Memory-capable MCP server detected.",
			actions: [
				"Review long-term memory write policy before enabling automation.",
			],
		};
	}

	return {
		id: "memory",
		status: "recommended",
		title: "Memory",
		summary: "No memory-capable MCP server was detected.",
		actions: [
			"Enable quilin-mem for durable memory.",
			"Keep long-term memory writes reviewable and source-backed.",
		],
	};
}

function buildSafetyStep(config: UserConfig): FirstRunOnboardingStep {
	if (config.safety.trust_mode === "auto") {
		return {
			id: "safety",
			status: "required",
			title: "Safety",
			summary:
				"trust_mode is auto; first-run setup must confirm this explicitly.",
			actions: [
				"Prefer read_only or ask for first run.",
				"Require explicit user approval before enabling auto trust.",
			],
		};
	}

	return {
		id: "safety",
		status: "complete",
		title: "Safety",
		summary: `trust_mode is ${config.safety.trust_mode}.`,
		actions: ["Keep write operations behind WriteAuthority."],
	};
}

function buildReviewStep(firstRun: boolean): FirstRunOnboardingStep {
	return {
		id: "review",
		status: firstRun ? "required" : "recommended",
		title: "Review",
		summary: firstRun
			? "No user config file was loaded; write approval is required."
			: "Existing config loaded; review before changing setup.",
		actions: [
			"Show a dry-run summary before writing config.",
			"Never print raw secrets in logs or run history.",
		],
	};
}

function getConfiguredTierProviders(config: UserConfig): readonly string[] {
	return Array.from(
		new Set(Object.values(config.llm.tiers).map((tier) => tier.provider)),
	).sort();
}

function buildRedactedConfigSummary(config: UserConfig): RedactedConfigSummary {
	return {
		llm: {
			routingMode: config.llm.routing.mode,
			defaultTier: config.llm.routing.default_tier,
			providers: getConfiguredTierProviders(config),
			models: Array.from(
				new Set(Object.values(config.llm.tiers).map((tier) => tier.model)),
			).sort(),
		},
		memory: {
			scratchpadTtlSec: config.memory.scratchpad.ttl_sec,
			scratchpadCapacityPerTask: config.memory.scratchpad.capacity_per_task,
		},
		observability: {
			logLevel: config.observability.log_level,
			tracingEnabled: config.observability.tracing.enabled,
			metricsEnabled: config.observability.metrics.enabled,
		},
		session: {
			storage: config.session.storage,
			dbPath: sanitizePathForDisplay(config.session.db_path),
		},
		tools: {
			enabledCount: config.tools.enabled.length,
			disabledCount: config.tools.disabled.length,
		},
		idleEvolution: {
			enabled: config.idle_evolution.enabled,
			mode: config.idle_evolution.mode,
		},
		safety: {
			trustMode: config.safety.trust_mode,
		},
	};
}

function sanitizePathForDisplay(raw: string): string {
	return raw
		.replace(/\/Users\/[^/]+/, "/Users/[user]")
		.replace(/\/home\/[^/]+/, "/home/[user]");
}
