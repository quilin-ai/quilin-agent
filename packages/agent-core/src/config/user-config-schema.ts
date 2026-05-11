// User-level runtime config schema, frozen by ADR-009 §3.4.
// Distinct from capability YAML schema in ./schema.ts which describes
// project-level skills/tools registration.

import { z } from "zod";

export const USER_CONFIG_SCHEMA_VERSION = 1 as const;
export type UserConfigSchemaVersion = 1;

const llmProviderSchema = z.enum(["anthropic", "deepseek", "gemini", "openai"]);
const thinkingModeSchema = z.enum(["disabled", "enabled", "auto"]);
const modelTierSchema = z.enum(["flash", "lite", "pro"]);

const defaultLlmTiers = {
	flash: {
		provider: "deepseek" as const,
		model: "deepseek-v4-flash",
		thinking: "disabled" as const,
	},
	lite: {
		provider: "deepseek" as const,
		model: "deepseek-v4-flash",
		thinking: "enabled" as const,
	},
	pro: {
		provider: "deepseek" as const,
		model: "deepseek-v4-pro",
		thinking: "enabled" as const,
	},
} as const;

function llmTierProfileSchema(
	defaultProfile: (typeof defaultLlmTiers)[keyof typeof defaultLlmTiers],
) {
	return z
		.object({
			provider: llmProviderSchema.default(defaultProfile.provider),
			model: z.string().min(1).default(defaultProfile.model),
			thinking: thinkingModeSchema.default(defaultProfile.thinking),
			temperature: z.number().min(0).max(2).optional(),
			max_tokens: z.number().int().positive().optional(),
			thinking_budget_tokens: z.number().int().positive().optional(),
			top_p: z.number().min(0).max(1).optional(),
		})
		.strict();
}

export const llmConfigSchema = z
	.object({
		default_model: z.string().min(1).default("claude-sonnet-4-6"),
		fallback_model: z.string().min(1).optional(),
		temperature: z.number().min(0).max(2).default(0.7),
		max_tokens: z.number().int().positive().default(8192),
		thinking: z
			.object({
				enabled: z.boolean().default(true),
				budget_tokens: z.number().int().positive().default(10_000),
			})
			.strict()
			.default({ enabled: true, budget_tokens: 10_000 }),
		routing: z
			.object({
				mode: z.enum(["auto", "flash", "lite", "pro"]).default("auto"),
				default_tier: modelTierSchema.default("lite"),
				allow_escalation: z.boolean().default(true),
			})
			.strict()
			.default({
				mode: "auto",
				default_tier: "lite",
				allow_escalation: true,
			}),
		tiers: z
			.object({
				flash: llmTierProfileSchema(defaultLlmTiers.flash).default(
					defaultLlmTiers.flash,
				),
				lite: llmTierProfileSchema(defaultLlmTiers.lite).default(
					defaultLlmTiers.lite,
				),
				pro: llmTierProfileSchema(defaultLlmTiers.pro).default(
					defaultLlmTiers.pro,
				),
			})
			.strict()
			.default(defaultLlmTiers),
	})
	.strict();

export const memoryObserverConfigSchema = z
	.object({
		// Default OFF — observer hits an external LLM every N turns. Users
		// must explicitly opt in. API key is sourced from env (DEEPSEEK_API_KEY
		// or QUILIN_OBSERVER_API_KEY) — never from this config.
		// 默认关闭 — 观察器每 N 回合调外部 LLM，必须显式 opt in。API key
		// 只从环境变量取（DEEPSEEK_API_KEY / QUILIN_OBSERVER_API_KEY），
		// 不从此 config 取。
		enabled: z.boolean().default(false),
		model: z.string().min(1).default("deepseek-v4-flash"),
		frequency: z.number().int().min(1).default(10),
	})
	.strict()
	.default({ enabled: false, model: "deepseek-v4-flash", frequency: 10 });

export const memoryConfigSchema = z
	.object({
		scratchpad: z
			.object({
				ttl_sec: z.number().int().positive().default(3600),
				capacity_per_task: z.number().int().positive().default(1024),
			})
			.strict()
			.default({ ttl_sec: 3600, capacity_per_task: 1024 }),
		observer: memoryObserverConfigSchema,
	})
	.strict()
	.default({
		scratchpad: { ttl_sec: 3600, capacity_per_task: 1024 },
		observer: { enabled: false, model: "deepseek-v4-flash", frequency: 10 },
	});

export const observabilityConfigSchema = z
	.object({
		log_level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
		tracing: z
			.object({
				enabled: z.boolean().default(false),
				endpoint: z.string().url().optional(),
			})
			.strict()
			.default({ enabled: false }),
		metrics: z
			.object({
				enabled: z.boolean().default(false),
				port: z.number().int().min(1).max(65_535).optional(),
			})
			.strict()
			.default({ enabled: false }),
	})
	.strict()
	.default({
		log_level: "INFO",
		tracing: { enabled: false },
		metrics: { enabled: false },
	});

export const sessionConfigSchema = z
	.object({
		storage: z.enum(["sqlite", "memory"]).default("sqlite"),
		db_path: z.string().min(1).default("~/.quilin/sessions.db"),
		max_history_tokens: z.number().int().positive().default(32_000),
		auto_save_interval: z.number().int().positive().default(30),
	})
	.strict()
	.default({
		storage: "sqlite",
		db_path: "~/.quilin/sessions.db",
		max_history_tokens: 32_000,
		auto_save_interval: 30,
	});

export const toolsConfigSchema = z
	.object({
		enabled: z.array(z.string().min(1)).default([]),
		disabled: z.array(z.string().min(1)).default([]),
	})
	.strict()
	.default({ enabled: [], disabled: [] });

export const idleEvolutionConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		mode: z.enum(["api", "subscription"]).default("api"),
		daily_budget_tokens: z.number().int().nonnegative().default(0),
		allowed_hours: z
			.string()
			.regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, {
				message: "allowed_hours must be HH:MM-HH:MM",
			})
			.optional(),
		min_idle_minutes: z.number().int().positive().default(30),
	})
	.strict()
	.default({
		enabled: false,
		mode: "api",
		daily_budget_tokens: 0,
		min_idle_minutes: 30,
	});

export const safetyConfigSchema = z
	.object({
		trust_mode: z.enum(["read_only", "ask", "auto", "yolo"]).default("auto"),
	})
	.strict()
	.default({ trust_mode: "auto" });

/**
 * Hot reload webhook trigger configuration (QUI-148).
 *
 * Default OFF. When enabled, opens a localhost-bound HTTP server with a
 * single `POST /reload` endpoint that triggers the capabilities hot
 * reload. HMAC-SHA256 signature verification is mandatory: the
 * `QUILIN_RELOAD_WEBHOOK_SECRET` env var MUST be set or the webhook
 * refuses to start. The host MUST be a loopback address — public IPs
 * are rejected at startup.
 *
 * 热更新 webhook 配置（QUI-148）。默认关闭；启用后开放 `POST /reload` HTTP
 * 端点用于触发 capabilities 热更新。HMAC-SHA256 签名校验强制开启，
 * `QUILIN_RELOAD_WEBHOOK_SECRET` 环境变量必须设置，否则拒绝启动。host
 * 必须为环回地址，启动时拒绝任何公网 IP。
 */
export const reloadWebhookConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		port: z.number().int().min(0).max(65_535).default(0),
		host: z.string().min(1).default("127.0.0.1"),
	})
	.strict()
	.default({ enabled: false, port: 0, host: "127.0.0.1" });

export const hotReloadConfigSchema = z
	.object({
		webhook: reloadWebhookConfigSchema,
	})
	.strict()
	.default({ webhook: { enabled: false, port: 0, host: "127.0.0.1" } });

/**
 * Runtime configuration namespace (QUI-148).
 *
 * Holds runtime-level toggles distinct from per-domain (LLM / memory /
 * tools) settings. Currently exposes:
 * - `hot_reload.webhook` — opt-in HTTP webhook trigger.
 * - `sandbox.default` — default sandbox provider; `local-dev` is dev-only
 *   and refused in production mode (NODE_ENV=production / QUILIN_PROD=1).
 *
 * 运行时配置命名空间（QUI-148）。承载运行时层面的开关，与按领域划分的配置
 * （LLM / 记忆 / 工具）互不干扰。当前暴露：
 * - `hot_reload.webhook`：opt-in 的 HTTP webhook 触发器。
 * - `sandbox.default`：默认 sandbox 后端；`local-dev` 仅限开发环境，生产
 *   模式（NODE_ENV=production / QUILIN_PROD=1）下启动即报错。
 */
export const runtimeSandboxConfigSchema = z
	.object({
		default: z.enum(["docker", "local-dev"]).default("docker"),
	})
	.strict()
	.default({ default: "docker" });

export const runtimeConfigSchema = z
	.object({
		hot_reload: hotReloadConfigSchema,
		sandbox: runtimeSandboxConfigSchema,
	})
	.strict()
	.default({
		hot_reload: { webhook: { enabled: false, port: 0, host: "127.0.0.1" } },
		sandbox: { default: "docker" },
	});

/**
 * Self-evolution configuration. Currently only governs which offline
 * optimizer the idle runner instantiates; future fields will live here
 * (e.g. proposal review TTL, dry-run toggles).
 *
 * 自我演进配置：当前仅控制 idle runner 选用的离线优化器。未来 self-evolution
 * 相关参数（提案审核 TTL、dry-run 开关等）也归到这里。
 *
 * Optimizer choices (singular path post 2026-05-12 refactor):
 * - `dspy` (default): DSPy/GEPA optimizer over MCP. GEPA is the only
 *   compiler (ICLR 2026 Oral; rationale in
 *   docs/10-self-evolution/README.md §2.4).
 * - `noop`: opt-out for evaluation runs that explicitly want no
 *   proposals. Also the silent fallback when `dspy` is chosen but
 *   the MCP client cannot be wired.
 *
 * 优化器选项（2026-05-12 重构后只有一条路径）：
 * - `dspy`（默认）：经 MCP 调用 `providers/optimizer` 的 DSPy/GEPA 优化器。
 *   GEPA 是唯一编译器（ICLR 2026 Oral 接收；决策依据见
 *   docs/10-self-evolution/README.md §2.4）。
 * - `noop`：评估场景下显式禁用提案的 opt-out；也是 `dspy` 选了但 MCP
 *   client 未接通时的静默回退。
 *
 * Removed 2026-05-12: `optimizer = "prompt_rewrite"` (TS heuristic)
 * and `optimizer_choice = "mipro"` (the prior DSPy compiler). Existing
 * configs that still set these will fail Zod validation — update to
 * `optimizer = "dspy"` (or "noop") to migrate.
 */
export const selfEvolutionConfigSchema = z
	.object({
		optimizer: z.enum(["noop", "dspy"]).default("dspy"),
	})
	.strict()
	.default({ optimizer: "dspy" });

// Default token budget mirrors DEFAULT_CONTEXT_BUDGET in
// ../context/manager.ts. Keep them in sync — Phase 0 only enforces
// budget.total; per-section caps are reserved for Phase 1+.
const DEFAULT_CONTEXT_BUDGET = {
	total: 4096,
	system: 1024,
	memory: 1024,
	tools: 512,
	conversation: 1024,
	reserved: 512,
} as const;

export const contextBudgetSchema = z
	.object({
		total: z.number().int().positive().default(DEFAULT_CONTEXT_BUDGET.total),
		system: z
			.number()
			.int()
			.nonnegative()
			.default(DEFAULT_CONTEXT_BUDGET.system),
		memory: z
			.number()
			.int()
			.nonnegative()
			.default(DEFAULT_CONTEXT_BUDGET.memory),
		tools: z.number().int().nonnegative().default(DEFAULT_CONTEXT_BUDGET.tools),
		conversation: z
			.number()
			.int()
			.nonnegative()
			.default(DEFAULT_CONTEXT_BUDGET.conversation),
		reserved: z
			.number()
			.int()
			.nonnegative()
			.default(DEFAULT_CONTEXT_BUDGET.reserved),
	})
	.strict()
	.default(DEFAULT_CONTEXT_BUDGET);

// Relevance selection defaults — keep in sync with
// DEFAULT_RELEVANCE_THRESHOLD / DEFAULT_RELEVANCE_STRATEGY in
// ../context/relevance-selector.ts. docs/02-context/README.md line 468
// pins threshold = 0.65; rerank is opt-in because of LLM call cost.
const DEFAULT_RELEVANCE_CONFIG = {
	threshold: 0.65,
	rerankEnabled: false,
	strategy: "keyword" as const,
};

export const contextRelevanceSchema = z
	.object({
		threshold: z
			.number()
			.min(0)
			.max(1)
			.default(DEFAULT_RELEVANCE_CONFIG.threshold),
		rerankEnabled: z.boolean().default(DEFAULT_RELEVANCE_CONFIG.rerankEnabled),
		strategy: z
			.enum(["keyword", "vector", "llm_rerank"])
			.default(DEFAULT_RELEVANCE_CONFIG.strategy),
	})
	.strict()
	.default(DEFAULT_RELEVANCE_CONFIG);

export const contextConfigSchema = z
	.object({
		budget: contextBudgetSchema,
		relevance: contextRelevanceSchema,
	})
	.strict()
	.default({
		budget: DEFAULT_CONTEXT_BUDGET,
		relevance: DEFAULT_RELEVANCE_CONFIG,
	});

export const userConfigSchema = z
	.object({
		schema_version: z
			.literal(USER_CONFIG_SCHEMA_VERSION)
			.default(USER_CONFIG_SCHEMA_VERSION),
		llm: llmConfigSchema.default({
			default_model: "claude-sonnet-4-6",
			temperature: 0.7,
			max_tokens: 8192,
			thinking: { enabled: true, budget_tokens: 10_000 },
			routing: {
				mode: "auto",
				default_tier: "lite",
				allow_escalation: true,
			},
			tiers: defaultLlmTiers,
		}),
		memory: memoryConfigSchema,
		observability: observabilityConfigSchema,
		session: sessionConfigSchema,
		tools: toolsConfigSchema,
		idle_evolution: idleEvolutionConfigSchema,
		safety: safetyConfigSchema,
		context: contextConfigSchema,
		self_evolution: selfEvolutionConfigSchema,
		runtime: runtimeConfigSchema,
	})
	.strict();

export type UserConfig = z.infer<typeof userConfigSchema>;
export type UserConfigInput = z.input<typeof userConfigSchema>;

// Forbidden field-name fragments (ADR-009 §3.6 safety).
// If any leaf key in the parsed TOML matches one of these, the loader
// must reject the file because API keys must come from env vars only.
export const FORBIDDEN_FIELD_FRAGMENTS = [
	"_api_key",
	"_token",
	"_secret",
] as const;
