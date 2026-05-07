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
		const plan = buildFirstRunOnboardingPlan({
			userConfig,
			providerMatrix: buildProviderLiveMatrix(undefined, { env: {} }),
		});

		expect(plan.firstRun).toBe(true);
		expect(plan.ready).toBe(false);
		expect(plan.requiredStepIds).toEqual(["provider", "review"]);
		expect(plan.redactedConfigSummary.llm.providers).toEqual(["deepseek"]);
		expect(JSON.stringify(plan)).not.toContain("DEEPSEEK_API_KEY");
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
		});

		expect(plan.steps.map((step) => [step.id, step.status])).toEqual([
			["provider", "complete"],
			["mcp", "complete"],
			["skills", "complete"],
			["memory", "complete"],
			["safety", "complete"],
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
});
