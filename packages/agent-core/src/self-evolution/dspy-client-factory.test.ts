import { describe, expect, it, vi } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import type { MCPRegistry } from "../tools/registry.js";
import {
	buildDspyClientFactoryFromRegistryRef,
	DSPY_OPTIMIZER_MCP_SERVER_ID,
	DspyOptimizerNotConnectedError,
	type MCPRegistryRef,
} from "./dspy-client-factory.js";
import { DSPY_OFFLINE_OPTIMIZER_ID } from "./dspy-offline-optimizer.js";
import { IdleEvolutionRunner } from "./idle-runner.js";
import { createOfflineOptimizer } from "./optimizer-factory.js";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import type {
	FailureAnalysis,
	OptimizationProposalDraft,
	StoredTrajectoryRecord,
} from "./types.js";
import { SELF_EVOLUTION_SCHEMA_VERSION } from "./types.js";

const FIXED_NOW = () => new Date("2026-05-09T00:00:00.000Z");

/**
 * Build a registry test double exposing only the surface
 * `dspy-client-factory` reads. We type-assert into `MCPRegistry` because
 * the factory only ever calls `.getServerCallToolTransport(...)` on it.
 *
 * 构造仅暴露 `dspy-client-factory` 实际调用面的 registry test double。
 * factory 只会用 `.getServerCallToolTransport(...)`，所以转成
 * `MCPRegistry` 类型是安全的。
 */
function fakeRegistryWithTransport(
	transport:
		| {
				callTool: (
					name: string,
					args: Record<string, unknown>,
				) => Promise<string>;
		  }
		| undefined,
): MCPRegistry {
	return {
		getServerCallToolTransport: () => transport,
	} as unknown as MCPRegistry;
}

function trajectory(
	overrides: Partial<StoredTrajectoryRecord> = {},
): StoredTrajectoryRecord {
	return {
		schemaVersion: 1,
		runId: "run-001",
		taskRef: "QUI-146",
		outcome: "failure",
		createdAt: "2026-05-09T00:00:00.000Z",
		trajectoryRef: "trajectory:run-001",
		contentHash: "a".repeat(64),
		steps: [
			{
				index: 0,
				kind: "tool",
				label: "shell_exec",
				error: "command failed",
				evidenceRefs: ["tool-call:1"],
			},
		],
		failures: [],
		...overrides,
	};
}

function emptyAnalysis(record: StoredTrajectoryRecord): FailureAnalysis {
	return {
		schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
		runId: record.runId,
		trajectoryRef: record.trajectoryRef,
		findings: [],
		noProposalReasons: [],
		shouldPropose: false,
	};
}

describe("buildDspyClientFactoryFromRegistryRef", () => {
	it("returns undefined when capabilities config has no quilin-optimizer entry", () => {
		const ref: MCPRegistryRef = {};
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => false,
		});
		expect(factory).toBeUndefined();
	});

	it("returns a factory when capabilities config has quilin-optimizer entry", () => {
		const ref: MCPRegistryRef = {};
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		expect(factory).toBeTypeOf("function");
	});

	it("client.callTool throws DspyOptimizerNotConnectedError when registry is not yet bound", async () => {
		const ref: MCPRegistryRef = {};
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		const client = factory?.();
		expect(client).toBeDefined();
		await expect(client?.callTool("optimize", {})).rejects.toBeInstanceOf(
			DspyOptimizerNotConnectedError,
		);
	});

	it("client.callTool throws DspyOptimizerNotConnectedError when registry has no transport for quilin-optimizer", async () => {
		const ref: MCPRegistryRef = {
			registry: fakeRegistryWithTransport(undefined),
		};
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		const client = factory?.();
		await expect(client?.callTool("optimize", {})).rejects.toBeInstanceOf(
			DspyOptimizerNotConnectedError,
		);
	});

	it("client.callTool resolves the transport lazily — works when registry is bound after factory build", async () => {
		const callTool = vi.fn(
			async (_name: string, _args: Record<string, unknown>) => "ok",
		);
		const ref: MCPRegistryRef = {};
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		const client = factory?.();

		// Late-bind the registry AFTER the factory + client have been built.
		// 构造完 factory + client 之后才注入 registry。
		ref.registry = fakeRegistryWithTransport({ callTool });

		const result = await client?.callTool("optimize", { foo: 1 });
		expect(result).toBe("ok");
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(callTool).toHaveBeenCalledWith("optimize", { foo: 1 });
	});

	it("uses the default DSPY_OPTIMIZER_MCP_SERVER_ID when serverId is not overridden", async () => {
		const transport = vi.fn(
			async (_name: string, _args: Record<string, unknown>) => "ok",
		);
		const lookups: string[] = [];
		const registry = {
			getServerCallToolTransport: (serverId: string) => {
				lookups.push(serverId);
				return { callTool: transport };
			},
		} as unknown as MCPRegistry;
		const ref: MCPRegistryRef = { registry };
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		await factory?.()?.callTool("optimize", {});
		expect(lookups).toEqual([DSPY_OPTIMIZER_MCP_SERVER_ID]);
	});

	it("supports a custom serverId override", async () => {
		const lookups: string[] = [];
		const registry = {
			getServerCallToolTransport: (serverId: string) => {
				lookups.push(serverId);
				return {
					callTool: vi.fn(
						async (_name: string, _args: Record<string, unknown>) => "ok",
					),
				};
			},
		} as unknown as MCPRegistry;
		const ref: MCPRegistryRef = { registry };
		const factory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
			serverId: "custom-optimizer",
		});
		await factory?.()?.callTool("optimize", {});
		expect(lookups).toEqual(["custom-optimizer"]);
	});
});

describe("createOfflineOptimizer + dspy-client-factory wiring", () => {
	it("returns DspyOfflineOptimizer when choice=dspy and a registry-backed factory is wired", () => {
		const ref: MCPRegistryRef = {
			registry: fakeRegistryWithTransport({ callTool: async () => "{}" }),
		};
		const dspyClientFactory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		expect(dspyClientFactory).toBeDefined();
		const optimizer = createOfflineOptimizer({
			choice: "dspy",
			...(dspyClientFactory == null ? {} : { dspyClientFactory }),
		});
		expect(optimizer.optimizerId).toBe(DSPY_OFFLINE_OPTIMIZER_ID);
	});

	it("falls back to LocalNoopOfflineOptimizer when choice=dspy but registry has no quilin-optimizer entry", () => {
		// Post 2026-05-12 refactor: the fallback path is `noop`, not the
		// deleted `PromptRewriteOptimizer`. Users get a clear warning log
		// and no proposals until they wire the MCP server.
		const ref: MCPRegistryRef = {};
		const dspyClientFactory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => false,
		});
		expect(dspyClientFactory).toBeUndefined();
		const optimizer = createOfflineOptimizer({
			choice: "dspy",
			...(dspyClientFactory == null ? {} : { dspyClientFactory }),
		});
		expect(optimizer).toBeInstanceOf(LocalNoopOfflineOptimizer);
	});
});

describe("end-to-end: IdleEvolutionRunner + dspy client factory + proposalStore", () => {
	it("flows a stubbed DSPy proposal through tryRun() into proposalStore.append", async () => {
		// Stub MCP transport returning a deterministic DSPy proposal payload.
		// 占位 MCP transport，返回确定性 DSPy 提案负载。
		const dspyPayload = {
			schema_version: SELF_EVOLUTION_SCHEMA_VERSION,
			optimizer_id: DSPY_OFFLINE_OPTIMIZER_ID,
			mode: "prompt_optimization",
			created_at: "2026-05-09T00:00:00.000Z",
			proposals: [
				{
					title: "stub-dspy-proposal",
					summary: "summary from stubbed DSPy",
					artifacts: [
						{
							kind: "markdown",
							title: "patch",
							content: "## Proposed change\n",
							sourceRefs: ["trajectory:run-001"],
						},
					],
					evidenceHashes: [],
					riskPreview: {
						level: "medium",
						reasons: ["test"],
						touchesRuntime: false,
						requiresHumanReview: true,
					},
				},
			],
			no_proposal_reasons: [],
		};
		const callTool = vi.fn(
			async (_name: string, _args: Record<string, unknown>) =>
				JSON.stringify(dspyPayload),
		);
		const registry = fakeRegistryWithTransport({ callTool });

		const ref: MCPRegistryRef = { registry };
		const dspyClientFactory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		expect(dspyClientFactory).toBeDefined();

		const optimizer = createOfflineOptimizer({
			choice: "dspy",
			now: FIXED_NOW,
			...(dspyClientFactory == null ? {} : { dspyClientFactory }),
		});
		expect(optimizer.optimizerId).toBe(DSPY_OFFLINE_OPTIMIZER_ID);

		const append = vi.fn(async (_proposal: OptimizationProposalDraft) => ({
			ok: true,
		}));
		const authority = new WriteAuthority({
			mode: "auto-medium",
			actor: "test",
		});

		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 10_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			writeAuthority: authority,
			now: FIXED_NOW,
		});

		await runner.tryRun();

		// The factory was actually invoked end-to-end (catches "wired but
		// never called" regressions).
		// factory 真的被端到端调用（防御 “接好但从未触发” 的回归）。
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(callTool.mock.calls[0]?.[0]).toBe("optimize");

		// Proposal flowed through the runner into proposalStore.append.
		// 提案经 runner 流入 proposalStore.append。
		expect(append).toHaveBeenCalledTimes(1);
		expect(append.mock.calls[0]?.[0]?.title).toBe("stub-dspy-proposal");
	});

	it("late-bound registry: factory built before registry is populated still flows proposals once registry binds", async () => {
		const callTool = vi.fn(
			async (_name: string, _args: Record<string, unknown>) =>
				JSON.stringify({
					schema_version: SELF_EVOLUTION_SCHEMA_VERSION,
					optimizer_id: DSPY_OFFLINE_OPTIMIZER_ID,
					mode: "prompt_optimization",
					created_at: "2026-05-09T00:00:00.000Z",
					proposals: [
						{
							title: "late-bound-proposal",
							summary: "registry was undefined at construction time",
							artifacts: [],
							evidenceHashes: [],
							riskPreview: {
								level: "medium",
								reasons: ["late-bound"],
								touchesRuntime: false,
								requiresHumanReview: true,
							},
						},
					],
					no_proposal_reasons: [],
				}),
		);

		// Build factory + optimizer + runner BEFORE registry is bound — the
		// realistic timing during REPL startup.
		// registry 绑定前先构造 factory + optimizer + runner——对齐 REPL
		// 启动时的实际时序。
		const ref: MCPRegistryRef = {};
		const dspyClientFactory = buildDspyClientFactoryFromRegistryRef({
			registryRef: ref,
			hasOptimizerEntry: () => true,
		});
		const optimizer = createOfflineOptimizer({
			choice: "dspy",
			now: FIXED_NOW,
			...(dspyClientFactory == null ? {} : { dspyClientFactory }),
		});
		const append = vi.fn(async (_proposal: OptimizationProposalDraft) => ({
			ok: true,
		}));
		const authority = new WriteAuthority({
			mode: "auto-medium",
			actor: "test",
		});
		const runner = new IdleEvolutionRunner({
			idleBudget: { dailyTokenQuota: 10_000 },
			trajectoryStore: { list: async () => [trajectory()] },
			failureAnalyzer: emptyAnalysis,
			proposalStore: { append },
			optimizer,
			writeAuthority: authority,
			now: FIXED_NOW,
		});

		// Now bind the registry (mirrors `onRuntimeReady` firing inside
		// `startRepl`).
		// 注入 registry（模拟 `startRepl` 内 `onRuntimeReady` 触发）。
		ref.registry = fakeRegistryWithTransport({ callTool });

		await runner.tryRun();

		expect(callTool).toHaveBeenCalledTimes(1);
		expect(append).toHaveBeenCalledTimes(1);
		expect(append.mock.calls[0]?.[0]?.title).toBe("late-bound-proposal");
	});
});
