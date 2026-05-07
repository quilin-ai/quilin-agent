import { describe, expect, it } from "vitest";
import type { FirstRunOnboardingPlan } from "../config/first-run.js";
import { formatFirstRunWelcome } from "./first-run-welcome.js";

function buildTestPlan(
	overrides: Partial<FirstRunOnboardingPlan> = {},
): FirstRunOnboardingPlan {
	return {
		firstRun: true,
		ready: false,
		configPath: null,
		requiredStepIds: ["provider", "review"],
		recommendedStepIds: ["mcp", "skills", "memory"],
		steps: [
			{
				id: "provider",
				status: "required",
				title: "Provider",
				summary: "No configured provider credential was found.",
				actions: [
					"Choose API Key or OAuth setup for at least one provider.",
					"Validate credential status without logging raw secrets.",
				],
			},
			{
				id: "mcp",
				status: "recommended",
				title: "MCP",
				summary: "No enabled MCP server is configured.",
				actions: ["Enable bundled quilin-mem MCP when available."],
			},
			{
				id: "skills",
				status: "recommended",
				title: "Skills",
				summary: "No skill root is configured.",
				actions: ["Configure bundled, user, project, or plugin skill roots."],
			},
			{
				id: "memory",
				status: "recommended",
				title: "Memory",
				summary: "No memory-capable MCP server was detected.",
				actions: ["Enable quilin-mem for durable memory."],
			},
			{
				id: "safety",
				status: "complete",
				title: "Safety",
				summary: "trust_mode is ask.",
				actions: ["Keep write operations behind WriteAuthority."],
			},
			{
				id: "review",
				status: "required",
				title: "Review",
				summary: "No user config file was loaded; write approval is required.",
				actions: [
					"Show a dry-run summary before writing config.",
					"Never print raw secrets in logs or run history.",
				],
			},
		],
		redactedConfigSummary: {
			llm: {
				routingMode: "auto",
				defaultTier: "pro",
				providers: ["deepseek"],
				models: ["deepseek-chat"],
			},
			memory: {
				scratchpadTtlSec: 3600,
				scratchpadCapacityPerTask: 50,
			},
			observability: {
				logLevel: "INFO",
				tracingEnabled: true,
				metricsEnabled: false,
			},
			session: {
				storage: "sqlite",
				dbPath: "/Users/[user]/.quilin/sessions.db",
			},
			tools: {
				enabledCount: 0,
				disabledCount: 0,
			},
			idleEvolution: {
				enabled: false,
				mode: "api",
			},
			safety: {
				trustMode: "ask",
			},
		},
		...overrides,
	};
}

describe("formatFirstRunWelcome", () => {
	it("includes the agent name", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("QUILIN AGENT");
		expect(output).toContain("麒麟");
	});

	it("mentions first run", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("first run");
	});

	it("shows config path when available", () => {
		const plan = buildTestPlan({
			configPath: "/Users/testuser/.quilin/config.toml",
		});
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("/Users/testuser/.quilin/config.toml");
	});

	it("shows defaults message when no config path", () => {
		const plan = buildTestPlan({ configPath: null });
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("built-in defaults");
	});

	it("shows required and recommended counts", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("2 required");
		expect(output).toContain("3 recommended");
	});

	it("marks required steps with [REQUIRED]", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("[REQUIRED] Provider");
		expect(output).toContain("[REQUIRED] Review");
	});

	it("marks complete steps with [OK]", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("[OK] Safety");
	});

	it("marks recommended steps with [recommended]", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("[recommended] MCP");
	});

	it("includes step actions", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain(
			"Choose API Key or OAuth setup for at least one provider.",
		);
	});

	it("shows quick start when required steps exist", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("Quick start:");
		expect(output).toContain("quilin config init");
	});

	it("hides quick start when no required steps", () => {
		const plan = buildTestPlan({
			requiredStepIds: [],
			steps: buildTestPlan().steps.map((s) => ({
				...s,
				status: "complete" as const,
			})),
		});
		const output = formatFirstRunWelcome(plan);
		expect(output).not.toContain("Quick start:");
	});

	it("includes soul.md tip", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		expect(output).toContain("~/.quilin/soul.md");
	});

	it("includes all step titles", () => {
		const plan = buildTestPlan();
		const output = formatFirstRunWelcome(plan);
		for (const step of plan.steps) {
			expect(output).toContain(step.title);
		}
	});

	it("returns a non-empty string for ready plan", () => {
		const plan = buildTestPlan({
			ready: true,
			requiredStepIds: [],
			recommendedStepIds: [],
			steps: buildTestPlan().steps.map((s) => ({
				...s,
				status: "complete" as const,
			})),
		});
		const output = formatFirstRunWelcome(plan);
		expect(output.length).toBeGreaterThan(0);
		expect(output).toContain("QUILIN AGENT");
	});
});
