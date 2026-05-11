import type { ProviderLiveMatrixEntry } from "../llm/types.js";
import type { CapabilitiesConfig } from "./types.js";
import type { UserConfigLoadResult } from "./user-config.js";
import type { UserConfig } from "./user-config-schema.js";

export type FirstRunStepId =
	| "provider"
	| "mcp"
	| "skills"
	| "memory"
	| "self_evolution"
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
	/**
	 * Environment variables, used to detect whether the L3a observer
	 * (memory.observer) has its API key configured. Defaults to
	 * ``process.env`` when omitted. Tests pass an explicit object.
	 *
	 * 环境变量字典，用于探测 L3a observer 的 API key 是否配置。
	 * 缺省时使用 ``process.env``；测试用显式 mapping。
	 */
	readonly env?: Record<string, string | undefined>;
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
	const env = input.env ?? process.env;
	const steps = [
		buildProviderStep(config, input.providerMatrix),
		buildMcpStep(input.capabilities),
		buildSkillsStep(input.capabilities),
		buildMemoryStep(input.capabilities, config, env),
		buildSelfEvolutionStep(input.capabilities, config, env),
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
	config: UserConfig,
	env: Record<string, string | undefined>,
): FirstRunOnboardingStep {
	const servers = Object.entries(capabilities?.mcpServers ?? {});
	const hasMemoryServer = servers.some(([id, server]) =>
		`${id} ${server.namespace ?? ""} ${server.command} ${server.args.join(" ")}`
			.toLowerCase()
			.includes("memory"),
	);

	// L3a observer surface — explicit yes/no choice for the user at
	// first run. Default is OFF (per memoryObserverConfigSchema); we
	// surface it here so the user can see-and-decide rather than
	// silently inheriting the default. When enabled in config but the
	// env API key is missing, we escalate the step to "required" so the
	// user can't ship a half-configured observer to prod.
	//
	// 首次运行时把 L3a observer 的开关显式摆给用户：默认 OFF；如果用户
	// 在 config 里 enable 了但 env 没 API key，整步升级为 required，
	// 不许半配置就启动。
	const observer = config.memory.observer;
	// Use `||` instead of `??` so empty-string env vars fall through to
	// the next candidate. A shell `export QUILIN_OBSERVER_API_KEY=`
	// (with no value) leaves the var as `""` — `??` would treat that
	// as "set" and refuse to fall through to DEEPSEEK_API_KEY, which
	// contradicts the action-message implication that either var works.
	// Also strip whitespace so a misconfigured `"   "` doesn't pass.
	const hasObserverApiKey = Boolean(
		(env.QUILIN_OBSERVER_API_KEY || env.DEEPSEEK_API_KEY || "").trim(),
	);

	const observerActions: string[] = [];
	let observerEscalation: FirstRunStepStatus | null = null;

	if (observer.enabled) {
		if (hasObserverApiKey) {
			observerActions.push(
				`L3a observer: ENABLED (model=${observer.model}, every ${observer.frequency} turns) — auto-learns user preferences and writes to ~/.quilin/user.md.`,
			);
		} else {
			// enabled in config but no key in env → user misconfigured
			observerActions.push(
				"L3a observer: ENABLED in config but no API key in env — set DEEPSEEK_API_KEY (or QUILIN_OBSERVER_API_KEY) to actually activate, or set memory.observer.enabled = false.",
			);
			observerEscalation = "required";
		}
	} else {
		observerActions.push(
			"L3a observer: disabled (default). Enable to let Quilin auto-learn your preferences during conversations and persist them to ~/.quilin/user.md.",
			"To enable: set `memory.observer.enabled = true` in user config + ensure DEEPSEEK_API_KEY (or QUILIN_OBSERVER_API_KEY) is in env.",
			"To opt out permanently: leave the default — no API calls will be made.",
		);
	}

	if (hasMemoryServer) {
		return {
			id: "memory",
			status: observerEscalation ?? "complete",
			title: "Memory",
			summary: "Memory-capable MCP server detected.",
			actions: [
				"Review long-term memory write policy before enabling automation.",
				...observerActions,
			],
		};
	}

	return {
		id: "memory",
		status: observerEscalation ?? "recommended",
		title: "Memory",
		summary: "No memory-capable MCP server was detected.",
		actions: [
			"Enable quilin-mem for durable memory.",
			"Keep long-term memory writes reviewable and source-backed.",
			...observerActions,
		],
	};
}

function buildSelfEvolutionStep(
	capabilities: CapabilitiesConfig | undefined,
	config: UserConfig,
	env: Record<string, string | undefined>,
): FirstRunOnboardingStep {
	// Self-evolution offers three optimizer modes:
	//   - prompt_rewrite (default) : zero-dep heuristic TS optimizer
	//   - dspy                     : real DSPy MIPROv2 / GEPA via MCP
	//   - noop                     : eval-mode opt-out
	//
	// At first-run we surface the choice + check whether the user's
	// selection is actually wired (DSPy needs the quilin-optimizer
	// MCP server + a judge LM source: either an API key in env or
	// dummy mode). Misconfigured = step escalates to "required".
	//
	// 首次运行时显式展示 optimizer 选择，并校验依赖：DSPy 模式需要
	// `quilin-optimizer` MCP server 已注册 + judge LM 可用（env API key
	// 或 dummy 模式）。配置不一致时升级为 required。
	const optimizer = config.self_evolution.optimizer;
	const optimizerChoice = config.self_evolution.optimizer_choice;

	if (optimizer === "noop") {
		return {
			id: "self_evolution",
			status: "complete",
			title: "Self-evolution",
			summary: "Optimizer: noop (proposals suppressed — eval mode).",
			actions: [
				'To enable suggestion generation: set `self_evolution.optimizer = "prompt_rewrite"` (default heuristic) or `"dspy"` (real DSPy + judge LM).',
			],
		};
	}

	if (optimizer === "prompt_rewrite") {
		return {
			id: "self_evolution",
			status: "complete",
			title: "Self-evolution",
			summary:
				"Optimizer: prompt_rewrite (zero-dep heuristic TS — default, runs fully offline).",
			actions: [
				"Generated proposals route through WriteAuthority + sandbox-policy gates; nothing auto-applies.",
				'To upgrade to real DSPy (MIPROv2 / GEPA): set `self_evolution.optimizer = "dspy"` + `optimizer_choice = "mipro"|"gepa"`, install `dspy-ai` extra (`uv sync --extra dspy`), and set QUILIN_OPTIMIZER_JUDGE_API_KEY (or QUILIN_OPTIMIZER_JUDGE_MODE=dummy for zero-cost real-code-path testing).',
			],
		};
	}

	// optimizer === "dspy" — verify the path is fully wired.
	const dspyServers = Object.entries(capabilities?.mcpServers ?? {});
	const hasOptimizerServer = dspyServers.some(([id, server]) =>
		`${id} ${server.namespace ?? ""} ${server.command} ${server.args.join(" ")}`
			.toLowerCase()
			.includes("optimizer"),
	);
	const judgeMode = (env.QUILIN_OPTIMIZER_JUDGE_MODE ?? "")
		.trim()
		.toLowerCase();
	// Same empty-string-rejection rationale as observer key (line ~256):
	// `export QUILIN_OPTIMIZER_JUDGE_API_KEY=` leaves "" — not a real key.
	const hasJudgeApiKey = Boolean(
		(env.QUILIN_OPTIMIZER_JUDGE_API_KEY || "").trim(),
	);
	const judgeReady = hasJudgeApiKey || judgeMode === "dummy";

	const issues: string[] = [];
	if (!hasOptimizerServer) {
		issues.push(
			"`quilin-optimizer` MCP server is NOT registered in capabilities — DSPy choice will silently fall back to prompt_rewrite. Add the server entry to capabilities config.",
		);
	}
	if (!judgeReady) {
		issues.push(
			"DSPy judge LM unavailable — set QUILIN_OPTIMIZER_JUDGE_API_KEY in env (real LLM, costs tokens) or QUILIN_OPTIMIZER_JUDGE_MODE=dummy (zero-cost real-DSPy code path).",
		);
	}

	if (issues.length === 0) {
		const judgeNote =
			judgeMode === "dummy"
				? "DummyLM (zero-cost real-code-path mode)"
				: "real LLM via QUILIN_OPTIMIZER_JUDGE_API_KEY";
		return {
			id: "self_evolution",
			status: "complete",
			title: "Self-evolution",
			summary: `Optimizer: dspy (${optimizerChoice}) — judge ${judgeNote}.`,
			actions: [
				`DSPy compile loop active for ${optimizerChoice.toUpperCase()}; proposals still route through WriteAuthority + sandbox-policy gates.`,
				"Switch optimizer_choice between `mipro` and `gepa` to compare; bench script `scripts/bench-real-dspy.py` runs 3-way A/B locally.",
			],
		};
	}

	return {
		id: "self_evolution",
		status: "required",
		title: "Self-evolution",
		summary: `Optimizer: dspy (${optimizerChoice}) — configuration is INCOMPLETE.`,
		actions: [
			...issues,
			'Or set `self_evolution.optimizer = "prompt_rewrite"` to fall back to the zero-dep default.',
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
