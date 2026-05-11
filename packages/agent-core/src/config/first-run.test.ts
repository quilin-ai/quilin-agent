import { describe, expect, it } from "vitest";
import { buildProviderLiveMatrix } from "../llm/provider.js";
import { buildFirstRunOnboardingPlan } from "./first-run.js";
import type { CapabilitiesConfig } from "./types.js";
import { loadUserConfig } from "./user-config.js";

describe("buildFirstRunOnboardingPlan", () => {
	it("requires provider setup and write review on a clean first run", async () => {
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
		});
		// Pass a *separate* env mapping to the onboarding plan builder
		// that carries a secret value, so we can assert the secret is
		// not echoed into the plan output. The providerMatrix builder
		// gets the original empty env so provider step stays uncredentialed.
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: { DEEPSEEK_API_KEY: "sk-secret-should-not-leak" },
		});

		expect(plan.firstRun).toBe(true);
		expect(plan.ready).toBe(false);
		// self_evolution is now required by default (dspy is the singular
		// optimizer post 2026-05-12 refactor; needs MCP server + judge LM).
		expect(plan.requiredStepIds).toEqual([
			"provider",
			"self_evolution",
			"safety",
			"review",
		]);
		expect(plan.redactedConfigSummary.llm.providers).toEqual(["deepseek"]);
		// Real assertion: the secret VALUE never appears in plan output.
		// The env var NAME (DEEPSEEK_API_KEY) is fine to mention — users
		// need to know what to set.
		expect(JSON.stringify(plan)).not.toContain("sk-secret-should-not-leak");
	});

	it("marks provider and runtime setup complete when credentials and capabilities exist", async () => {
		const capabilities: CapabilitiesConfig = {
			schema_version: 1,
			mcpServers: {
				memory: {
					command: "uv",
					args: ["run", "python", "-m", "quilin_mem"],
					namespace: "quilin-mem",
				},
				// quilin-optimizer (DSPy GEPA backend) registered so self_evolution
				// step reaches the wired-and-judge-LM-available terminal "complete"
				// status. Default optimizer = "dspy" after the 2026-05-12 refactor.
				"quilin-optimizer": {
					command: "uv",
					args: ["run", "python", "-m", "quilin_optimizer"],
				},
			},
			skills: {
				enabled: true,
				bundledRoots: ["/opt/quilin/skills"],
				watcherEnabled: true,
				reloadStrategy: "watch",
			},
			safety: {},
		};
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: { DEEPSEEK_API_KEY: "redacted-in-tests" },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			capabilities,
			providerMatrix: buildProviderLiveMatrix(undefined, {
				env: { DEEPSEEK_API_KEY: "redacted-in-tests" },
			}),
			env: {
				DEEPSEEK_API_KEY: "redacted-in-tests",
				QUILIN_OPTIMIZER_JUDGE_API_KEY: "sk-judge-redacted",
			},
		});

		expect(plan.steps.map((step) => [step.id, step.status])).toEqual([
			["provider", "complete"],
			["mcp", "complete"],
			["skills", "complete"],
			["memory", "complete"],
			["self_evolution", "complete"],
			["safety", "required"],
			["review", "required"],
		]);
		expect(JSON.stringify(plan)).not.toContain("redacted-in-tests");
	});

	it("requires explicit confirmation when trust mode is auto", async () => {
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { safety: { trust_mode: "auto" } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
		});

		const safety = plan.steps.find((step) => step.id === "safety");
		expect(safety).toMatchObject({
			status: "required",
			summary:
				"trust_mode is auto; first-run setup must confirm this explicitly.",
		});
		expect(plan.requiredStepIds).toContain("safety");
	});

	// L3a observer first-run visibility — explicit yes/no choice surfaced.

	it("surfaces L3a observer disabled-default with opt-in instructions", async () => {
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {},
		});

		const memory = plan.steps.find((step) => step.id === "memory");
		expect(
			memory?.actions.some((a) => a.includes("L3a observer: disabled")),
		).toBe(true);
		expect(
			memory?.actions.some((a) => a.includes("memory.observer.enabled = true")),
		).toBe(true);
		// Disabled-default is NOT a required failure — user can legitimately
		// stay opted out.
		expect(plan.requiredStepIds).not.toContain("memory");
	});

	it("escalates memory step to required when observer is enabled but API key is missing", async () => {
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { memory: { observer: { enabled: true } } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {}, // no DEEPSEEK_API_KEY / QUILIN_OBSERVER_API_KEY
		});

		const memory = plan.steps.find((step) => step.id === "memory");
		expect(memory?.status).toBe("required");
		expect(
			memory?.actions.some((a) =>
				a.includes("L3a observer: ENABLED in config but no API key"),
			),
		).toBe(true);
		expect(plan.requiredStepIds).toContain("memory");
	});

	it("marks memory step complete when observer enabled with API key present", async () => {
		const capabilities: CapabilitiesConfig = {
			schema_version: 1,
			mcpServers: {
				memory: {
					command: "uv",
					args: ["run", "python", "-m", "quilin_mem"],
					namespace: "quilin-mem",
				},
			},
			skills: {
				enabled: true,
				bundledRoots: ["/opt/quilin/skills"],
				watcherEnabled: true,
				reloadStrategy: "watch",
			},
			safety: {},
		};
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { memory: { observer: { enabled: true } } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			capabilities,
			providerMatrix: buildProviderLiveMatrix(undefined, {
				env: { DEEPSEEK_API_KEY: "redacted" },
			}),
			env: { DEEPSEEK_API_KEY: "redacted" },
		});

		const memory = plan.steps.find((step) => step.id === "memory");
		expect(memory?.status).toBe("complete");
		expect(
			memory?.actions.some((a) =>
				a.startsWith("L3a observer: ENABLED (model="),
			),
		).toBe(true);
	});

	// Self-evolution optimizer first-run visibility.

	it("self-evolution step escalates to required for default dspy when nothing is wired", async () => {
		// Post 2026-05-12 refactor: `optimizer = "dspy"` is the default; with
		// no MCP server registered and no judge LM env, the step lands in
		// "required" (the user must wire either the MCP server + judge key,
		// or fall back to `optimizer = "noop"`).
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {},
		});

		const se = plan.steps.find((step) => step.id === "self_evolution");
		expect(se?.status).toBe("required");
		expect(se?.summary).toContain("dspy (GEPA)");
		expect(
			se?.actions.some((a) => a.includes("self_evolution.optimizer")),
		).toBe(true);
	});

	it("self-evolution step escalates to required when dspy is selected but quilin-optimizer MCP is missing", async () => {
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { self_evolution: { optimizer: "dspy" } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: { QUILIN_OPTIMIZER_JUDGE_API_KEY: "sk-judge-redacted" },
		});

		const se = plan.steps.find((step) => step.id === "self_evolution");
		expect(se?.status).toBe("required");
		expect(
			se?.actions.some((a) =>
				a.includes("`quilin-optimizer` MCP server is NOT registered"),
			),
		).toBe(true);
		expect(plan.requiredStepIds).toContain("self_evolution");
	});

	it("self-evolution step escalates to required when dspy is selected but judge LM is unavailable", async () => {
		const capabilities: CapabilitiesConfig = {
			schema_version: 1,
			mcpServers: {
				"quilin-optimizer": {
					command: "uv",
					args: ["run", "python", "-m", "quilin_optimizer"],
				},
			},
			skills: {
				enabled: true,
				bundledRoots: [],
				watcherEnabled: true,
				reloadStrategy: "watch",
			},
			safety: {},
		};
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { self_evolution: { optimizer: "dspy" } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			capabilities,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {}, // no QUILIN_OPTIMIZER_JUDGE_API_KEY, no JUDGE_MODE=dummy
		});

		const se = plan.steps.find((step) => step.id === "self_evolution");
		expect(se?.status).toBe("required");
		expect(
			se?.actions.some((a) => a.includes("DSPy judge LM unavailable")),
		).toBe(true);
	});

	it("self-evolution step marks dspy complete when wired + dummy judge mode enabled", async () => {
		const capabilities: CapabilitiesConfig = {
			schema_version: 1,
			mcpServers: {
				"quilin-optimizer": {
					command: "uv",
					args: ["run", "python", "-m", "quilin_optimizer"],
				},
			},
			skills: {
				enabled: true,
				bundledRoots: [],
				watcherEnabled: true,
				reloadStrategy: "watch",
			},
			safety: {},
		};
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: {
				self_evolution: { optimizer: "dspy" },
			},
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			capabilities,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: { QUILIN_OPTIMIZER_JUDGE_MODE: "dummy" },
		});

		const se = plan.steps.find((step) => step.id === "self_evolution");
		expect(se?.status).toBe("complete");
		expect(se?.summary).toContain("dspy (GEPA)");
		expect(se?.summary).toContain("DummyLM");
	});

	it("self-evolution step surfaces BOTH missing-MCP-server AND missing-judge-LM when dspy is selected with neither configured", async () => {
		// First-time DSPy user with nothing wired: bare capabilities + bare env.
		// Both required-to-activate gates must fire and both actionable
		// instructions must surface so the user sees the complete checklist.
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { self_evolution: { optimizer: "dspy" } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {}, // no MCP server in capabilities + no judge LM in env
		});

		const se = plan.steps.find((step) => step.id === "self_evolution");
		expect(se?.status).toBe("required");
		expect(
			se?.actions.some((a) =>
				a.includes("`quilin-optimizer` MCP server is NOT registered"),
			),
		).toBe(true);
		expect(
			se?.actions.some((a) => a.includes("DSPy judge LM unavailable")),
		).toBe(true);
		// Both actionable issues must be present together — the user gets
		// the complete fix-list in one pass, not a fix-one-then-rerun loop.
		const issueCount = se?.actions.filter(
			(a) =>
				a.includes("quilin-optimizer") ||
				a.includes("DSPy judge LM unavailable"),
		).length;
		expect(issueCount).toBe(2);
	});

	it("treats empty-string env vars as unset (export VAR= with no value)", async () => {
		// Shell `export QUILIN_OBSERVER_API_KEY=` produces an empty string
		// in process.env. `??`-based fall-through would stop at "" and miss
		// the chained DEEPSEEK_API_KEY backup. This test locks the
		// expected behavior: empty strings are treated as unset, the chain
		// falls through to the next candidate, and whitespace-only values
		// are also rejected.
		//
		// Memory MCP server is wired so the step's "recommended/complete"
		// distinction reflects observer config alone (otherwise "no memory
		// MCP server detected" path defaults the step to "recommended"
		// regardless of observer state).
		const capabilities: CapabilitiesConfig = {
			schema_version: 1,
			mcpServers: {
				memory: {
					command: "uv",
					args: ["run", "python", "-m", "quilin_mem"],
					namespace: "quilin-mem",
				},
			},
			skills: {
				enabled: true,
				bundledRoots: ["/opt/quilin/skills"],
				watcherEnabled: true,
				reloadStrategy: "watch",
			},
			safety: {},
		};
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { memory: { observer: { enabled: true } } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			capabilities,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {
				QUILIN_OBSERVER_API_KEY: "", // empty — must not block fall-through
				DEEPSEEK_API_KEY: "sk-real-key", // real key on fall-through path
			},
		});

		const memory = plan.steps.find((step) => step.id === "memory");
		// Empty observer key falls through to DEEPSEEK_API_KEY → observer
		// is effectively configured → step does NOT escalate to "required".
		expect(memory?.status).toBe("complete");
		expect(
			memory?.actions.some((a) =>
				a.startsWith("L3a observer: ENABLED (model="),
			),
		).toBe(true);
	});

	it("self-evolution step describes noop opt-out clearly", async () => {
		const userConfig = await loadUserConfig({
			configPath: "/tmp/quilin-missing-config.toml",
			env: {},
			cliOverrides: { self_evolution: { optimizer: "noop" } },
		});
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
			env: {},
		});

		const se = plan.steps.find((step) => step.id === "self_evolution");
		expect(se?.status).toBe("complete");
		expect(se?.summary).toContain("noop");
		expect(
			se?.actions.some((a) => a.includes("To enable suggestion generation")),
		).toBe(true);
	});
});
