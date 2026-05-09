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
 * Self-evolution configuration. Currently only governs which offline
 * optimizer the idle runner instantiates; future fields will live here
 * (e.g. proposal review TTL, dry-run toggles).
 *
 * 自我演进配置：当前仅控制 idle runner 选用的离线优化器。未来 self-evolution
 * 相关参数（提案审核 TTL、dry-run 开关等）也归到这里。
 *
 * Optimizer choices:
 * - `prompt_rewrite` (default): heuristic, dependency-free TS optimizer.
 * - `noop`: opt-out for evaluation runs that explicitly want no proposals.
 * - `dspy`: DSPy/GEPA-backed optimizer that talks to
 *   `providers/optimizer` over MCP. Stage A returns a deterministic stub;
 *   Stage C will swap in real DSPy compilation.
 *
 * Optimizer 选项：
 * - `prompt_rewrite`（默认）：零依赖的启发式 TS 优化器。
 * - `noop`：评估场景下显式禁用提案的 opt-out。
 * - `dspy`：经 MCP 调用 `providers/optimizer` 的 DSPy/GEPA 优化器；
 *   Stage A 返回确定性占位，Stage C 接入真实 DSPy 编译。
 */
export const selfEvolutionConfigSchema = z
	.object({
		optimizer: z
			.enum(["noop", "prompt_rewrite", "dspy"])
			.default("prompt_rewrite"),
	})
	.strict()
	.default({ optimizer: "prompt_rewrite" });

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

export const contextConfigSchema = z
	.object({
		budget: contextBudgetSchema,
	})
	.strict()
	.default({ budget: DEFAULT_CONTEXT_BUDGET });

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
