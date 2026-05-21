import { describe, expect, it } from "vitest";
import type { CapabilitiesRuntime } from "../../config/loader.js";
import {
	type UserConfig,
	userConfigSchema,
} from "../../config/user-config-schema.js";
import type { DashboardRuntimeRefs } from "../../observability/dashboard-runtime-providers.js";
import type { SQLiteCheckpoint } from "../../state/checkpoint.js";
import type { AgentState } from "../../state/types.js";
import { V2RuntimeAdapter } from "./adapter.js";

interface AdapterTestOptions {
	readonly refs?: DashboardRuntimeRefs;
	readonly checkpoint?: SQLiteCheckpoint;
	readonly runtime?: CapabilitiesRuntime;
}

function makeAdapter(
	config: UserConfig,
	options: AdapterTestOptions = {},
): V2RuntimeAdapter {
	return new V2RuntimeAdapter({
		refs: options.refs ?? ({} satisfies DashboardRuntimeRefs),
		checkpoint: options.checkpoint ?? ({} as unknown as SQLiteCheckpoint),
		getUserConfig: () => config,
		getCapabilitiesRuntime: () =>
			options.runtime ?? ({} as CapabilitiesRuntime),
	});
}

describe("V2RuntimeAdapter config bridge", () => {
	it("maps the current user config schema into the v2 config shape", () => {
		const config = userConfigSchema.parse({});
		config.safety.trust_mode = "ask";
		config.idle_evolution.enabled = true;
		config.idle_evolution.daily_budget_tokens = 12_345;
		config.memory.observer.enabled = true;
		config.llm.default_model = "claude-sonnet-4-6";
		config.llm.tiers.flash.model = "deepseek-v4-flash";

		const adapter = makeAdapter(config);

		expect(adapter.getConfig()).toMatchObject({
			trustMode: "ask",
			idleEvolution: true,
			autoReflect: true,
			tokenBudgetDaily: 12_345,
			tokenBudgetWarnAt: 0.8,
			modelDefault: "claude-sonnet-4-6",
			modelCheap: "deepseek-v4-flash",
			redactionPolicy: "standard",
		});
	});

	it("rejects critical config writes until a WriteAuthority gate is wired", () => {
		const config = userConfigSchema.parse({});
		const adapter = makeAdapter(config);

		expect(adapter.writeConfig({ trustMode: "yolo" })).toMatchObject({
			kind: "forbidden",
			code: "forbidden_critical_write",
			detail: { field: "trustMode" },
		});
		expect(config.safety.trust_mode).toBe("auto");

		expect(
			adapter.writeConfig({ modelDefault: "claude-opus-4-7" }),
		).toMatchObject({
			kind: "forbidden",
			code: "forbidden_critical_write",
			detail: { field: "modelDefault" },
		});
		expect(config.llm.default_model).toBe("claude-sonnet-4-6");
	});

	it("applies non-critical config patches to the live in-memory config", () => {
		const config = userConfigSchema.parse({});
		const adapter = makeAdapter(config);

		const result = adapter.writeConfig({
			idleEvolution: true,
			autoReflect: true,
			tokenBudgetDaily: 4096,
			tokenBudgetWarnAt: 0.7,
			modelCheap: "deepseek-v4-mini",
			redactionPolicy: "strict",
		});

		expect(result).toMatchObject({
			kind: "ok",
			config: {
				idleEvolution: true,
				autoReflect: true,
				tokenBudgetDaily: 4096,
				tokenBudgetWarnAt: 0.7,
				modelCheap: "deepseek-v4-mini",
				redactionPolicy: "strict",
			},
		});
		expect(config.idle_evolution.enabled).toBe(true);
		expect(config.memory.observer.enabled).toBe(true);
		expect(config.idle_evolution.daily_budget_tokens).toBe(4096);
		expect(config.llm.tiers.flash.model).toBe("deepseek-v4-mini");
	});
});

describe("V2RuntimeAdapter live data mapping", () => {
	it("maps checkpoint sessions and skips tool turns in session detail", async () => {
		const config = userConfigSchema.parse({});
		const state = {
			messages: [
				{
					role: "user",
					content: "hello",
					tokens: { response: 4, thinking: 6 },
				},
				{ role: "assistant", content: "hi" },
				{ role: "tool", content: "internal result" },
			],
			isTerminal: false,
			turnCount: 1,
			createdAt: "2026-05-21T00:00:00.000Z",
			lastActiveAt: "2026-05-21T00:01:00.000Z",
		} as unknown as AgentState;
		const checkpoint = {
			listSessions: async () => [
				{
					sessionId: "session-1",
					lastMessage: "hello",
					messageCount: 3,
					lastActiveAt: "2026-05-21T00:01:00.000Z",
				},
			],
			load: async () => state,
		} as unknown as SQLiteCheckpoint;
		const adapter = makeAdapter(config, { checkpoint });

		const sessions = await adapter.listSessions({});
		expect(sessions.items[0]).toMatchObject({
			id: "session-1",
			turnsCount: 1,
			tokensTotal: 10,
		});

		const detail = await adapter.getSession("session-1");
		expect(detail?.turns).toHaveLength(2);
		expect(detail?.turns.map((turn) => turn.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("maps skill descriptors into the v2 skills catalog", async () => {
		const config = userConfigSchema.parse({});
		const runtime = {
			skillsManager: {
				discover: async () => [
					{
						name: "project-skill",
						description: "Project scoped skill",
						path: "/tmp/project/SKILL.md",
						source: "project",
						frontmatter: {
							name: "project-skill",
							description: "Project scoped skill",
							whenToUse: "Use inside this repo",
							userInvocable: true,
							disableModelInvocation: false,
						},
					},
					{
						name: "user-skill",
						description: "User scoped skill",
						path: "/tmp/user/SKILL.md",
						source: "user",
						frontmatter: {
							name: "user-skill",
							description: "User scoped skill",
							whenToUse: "   ",
							userInvocable: true,
							disableModelInvocation: false,
						},
					},
				],
			},
			mcpServers: [],
		} as unknown as CapabilitiesRuntime;
		const adapter = makeAdapter(config, { runtime });

		await expect(adapter.listSkills()).resolves.toEqual([
			expect.objectContaining({
				name: "project-skill",
				source: "project",
				triggers: ["Use inside this repo"],
			}),
			expect.objectContaining({
				name: "user-skill",
				source: "local",
				triggers: [],
			}),
		]);
	});

	it("maps MCP runtime entries and counts registered tools by namespace", async () => {
		const config = userConfigSchema.parse({});
		const runtime = {
			mcpServers: [
				{
					id: "docs",
					namespace: "docs-ns",
					config: { type: "http" },
				},
			],
		} as unknown as CapabilitiesRuntime;
		const refs = {
			registry: {
				getAllTools: () => [
					{ name: "search", namespace: "docs" },
					{ name: "fetch", namespace: "docs-ns" },
					{ name: "other", namespace: "other" },
				],
			},
		} as unknown as DashboardRuntimeRefs;
		const adapter = makeAdapter(config, { refs, runtime });

		await expect(adapter.listMcp()).resolves.toEqual([
			{
				name: "docs",
				transport: "http",
				status: "healthy",
				toolsCount: 2,
				callsToday: 0,
				avgLatencyMs: 0,
			},
		]);
	});
});
