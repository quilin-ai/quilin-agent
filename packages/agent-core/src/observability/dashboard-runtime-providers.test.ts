import { afterEach, describe, expect, it } from "vitest";
import { LocalMemoryBackend } from "../memory/local-backend.js";
import {
	createChildRunStatusRecord,
	projectSupervisorProgressEvents,
} from "../multi-agent/supervisor-progress.js";
import type { SupervisorRuntimeSnapshot } from "../multi-agent/supervisor-runtime.js";
import { MCPRegistry } from "../tools/registry.js";
import type { ToolWithMetadata } from "../tools/tool-metadata.js";
import {
	createMemoryProviderFromRefs,
	createTasksProviderFromRefs,
	createToolsProviderFromRefs,
	type DashboardRuntimeRefs,
} from "./dashboard-runtime-providers.js";

const PROGRESS_NOW = "2026-05-09T08:00:00.000Z";

function builtinTool(overrides: Partial<ToolWithMetadata>): ToolWithMetadata {
	return {
		name: "tool",
		description: "desc",
		// biome-ignore lint/suspicious/noExplicitAny: test seam
		parameters: {} as any,
		execute: async () => ({
			toolCallId: "x",
			isError: false,
			content: "",
		}),
		category: "programmatic",
		riskLevel: "read",
		...overrides,
	};
}

function buildSnapshot(
	records: ReadonlyArray<Parameters<typeof createChildRunStatusRecord>[0]>,
): SupervisorRuntimeSnapshot {
	const built = records.map((input) => createChildRunStatusRecord(input));
	const projection = projectSupervisorProgressEvents(built, {
		now: PROGRESS_NOW,
		staleAfterMs: 120_000,
	});
	return { records: built, projection };
}

const closables: Array<{ close: () => void }> = [];

afterEach(() => {
	while (closables.length > 0) {
		const item = closables.pop();
		try {
			item?.close();
		} catch {
			/* ignore */
		}
	}
});

describe("dashboard tasks provider — late-bound runtime refs", () => {
	it("returns awaiting-runtime placeholder until supervisorRuntime is bound", () => {
		const refs: DashboardRuntimeRefs = {};
		const provider = createTasksProviderFromRefs(refs, () => []);

		const initial = provider();
		expect(initial.records).toEqual([]);
		expect(initial.activeRunCount).toBe(0);
		expect(initial.staleRunCount).toBe(0);
		expect(initial.message).toBe("tasks provider awaiting REPL runtime");

		// Late-bind supervisorRuntime — provider must light up on next call,
		// without re-creating the provider closure.
		refs.supervisorRuntime = {
			snapshot: () =>
				buildSnapshot([
					{
						runId: "run-active",
						taskId: "task-1",
						workerId: "researcher",
						status: "active",
						summary: "scraping docs",
						lastHeartbeatAt: "2026-05-09T07:59:30.000Z",
						updatedAt: "2026-05-09T07:59:30.000Z",
					},
					{
						runId: "run-blocked",
						taskId: "task-2",
						status: "blocked",
						blocker: "awaiting api key",
						summary: "blocked",
						lastHeartbeatAt: "2026-05-09T07:59:00.000Z",
						updatedAt: "2026-05-09T07:59:00.000Z",
					},
					{
						runId: "run-done",
						taskId: "task-3",
						status: "completed",
						summary: "shipped",
						lastHeartbeatAt: "2026-05-09T07:58:00.000Z",
						updatedAt: "2026-05-09T07:58:00.000Z",
					},
				]),
		};

		const subagentEntry = {
			runId: "subagent-1",
			task: "summarize doc",
			worker: "default",
			startedAt: "2026-05-09T07:55:00.000Z",
			status: "running" as const,
		};

		const wired = createTasksProviderFromRefs(refs, () => [subagentEntry])();
		expect(wired.message).toBeUndefined();
		// 2 active-ish supervisor records (active + blocked) + 1 running subagent = 3
		expect(wired.activeRunCount).toBe(3);
		// blocked counts as stale
		expect(wired.staleRunCount).toBe(1);
		// 3 supervisor + 1 subagent = 4 records
		expect(wired.records).toHaveLength(4);

		// Newest supervisor record (run-active @ 07:59:30) should sort first
		// among supervisor records.
		const supervisorRecords = wired.records.filter(
			(record) => record.eventType === "child_run",
		);
		expect(supervisorRecords[0]?.childRunId).toBe("run-active");
		expect(supervisorRecords[0]?.severity).toBe("info");
		const failedSupervisor = supervisorRecords.find((record) =>
			record.title.startsWith("completed"),
		);
		expect(failedSupervisor?.severity).toBe("info");

		// Subagent records
		const subagentRecords = wired.records.filter(
			(record) => record.eventType === "subagent_spawn",
		);
		expect(subagentRecords).toHaveLength(1);
		expect(subagentRecords[0]?.childRunId).toBe("subagent-1");
		expect(subagentRecords[0]?.summary).toBe("summarize doc");
	});

	it("handles supervisor snapshot errors gracefully without throwing", () => {
		const refs: DashboardRuntimeRefs = {
			supervisorRuntime: {
				snapshot: () => {
					throw new Error("boom");
				},
			},
		};
		const provider = createTasksProviderFromRefs(refs, () => []);
		const result = provider();
		expect(result.records).toEqual([]);
		expect(result.message).toContain("error reading supervisor snapshot");
	});
});

describe("dashboard memory provider — late-bound LocalMemoryBackend", () => {
	it("counts memories by tier from a real SQLite-backed backend", () => {
		const refs: DashboardRuntimeRefs = {};
		const provider = createMemoryProviderFromRefs(refs);

		const placeholder = provider();
		expect(placeholder.tiers.map((t) => t.name)).toEqual([
			"working",
			"episodic",
			"semantic",
			"skill",
		]);
		expect(placeholder.tiers[0]?.note).toBe(
			"memory provider awaiting REPL runtime",
		);

		// Seed an in-memory backend with rows in 3 of 4 tiers.
		const seedBackend = new LocalMemoryBackend(":memory:");
		closables.push(seedBackend);
		const baseTimestamp = Date.now();
		seedBackend.store({
			content: "wm-1",
			layer: "working",
			score: 0,
			timestamp: baseTimestamp,
			metadata_json: "{}",
		});
		seedBackend.store({
			content: "wm-2",
			layer: "working",
			score: 0,
			timestamp: baseTimestamp + 1,
			metadata_json: "{}",
		});
		seedBackend.store({
			content: "ep-1",
			layer: "episodic",
			score: 0,
			timestamp: baseTimestamp + 2,
			metadata_json: "{}",
		});
		seedBackend.store({
			content: "sk-1",
			layer: "skill",
			score: 0,
			timestamp: baseTimestamp + 3,
			metadata_json: "{}",
		});

		// Provider asks the factory for a fresh handle to the same DB; we
		// simulate that by exposing the seeded backend directly. The contract
		// guarantees the provider closes the handle, so we mark it consumed.
		let factoryCalls = 0;
		refs.memoryBackendFactory = () => {
			factoryCalls += 1;
			return seedBackend;
		};

		const wired = provider();
		expect(factoryCalls).toBe(1);
		expect(wired.tiers).toEqual([
			{ name: "working", count: 2 },
			{ name: "episodic", count: 1 },
			{ name: "semantic", count: 0 },
			{ name: "skill", count: 1 },
		]);

		// After the provider call, the closables hook will close the
		// (already-closed) backend; LocalMemoryBackend.close is idempotent at
		// the better-sqlite3 layer when wrapped in try/catch in the provider.
	});

	it("returns 'memory backend unavailable' note when factory throws", () => {
		const refs: DashboardRuntimeRefs = {
			memoryBackendFactory: () => {
				throw new Error("disk full");
			},
		};
		const provider = createMemoryProviderFromRefs(refs);
		const result = provider();
		expect(result.tiers.every((tier) => tier.count === 0)).toBe(true);
		expect(result.tiers[0]?.note).toBe("memory backend unavailable");
	});
});

describe("dashboard tools provider — late-bound MCPRegistry", () => {
	it("lists registered builtin and namespaced tools with byNamespace count", () => {
		const refs: DashboardRuntimeRefs = {};
		const provider = createToolsProviderFromRefs(refs);

		const empty = provider();
		expect(empty).toEqual({ tools: [], total: 0, byNamespace: {} });

		const registry = new MCPRegistry();
		registry.registerBuiltin([
			builtinTool({ name: "file_read", description: "read files" }),
			builtinTool({ name: "shell_exec", description: "execute commands" }),
		]);

		// Inject namespaced tools by going through registerBuiltin with a
		// pre-namespaced name + namespace metadata; this matches what
		// MCPRegistry sees from real MCP server registration.
		registry.registerBuiltin([
			builtinTool({
				name: "quilin-mem/memory_store",
				namespace: "quilin-mem",
				description: "store memories",
			}),
		]);

		refs.registry = registry;
		const wired = provider();
		expect(wired.total).toBe(3);
		expect(wired.tools.map((tool) => tool.name)).toEqual([
			"file_read",
			"quilin-mem/memory_store",
			"shell_exec",
		]);
		expect(wired.byNamespace).toEqual({ builtin: 2, "quilin-mem": 1 });
		// Description must be truncated at 240 chars (defensive cap).
		expect(wired.tools[0]?.description?.length).toBeLessThanOrEqual(240);
	});
});
