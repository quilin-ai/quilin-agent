/**
 * Builds dashboard data providers for the tasks / memory / tools panels
 * from live runtime references. Used by `index.ts` to late-bind the
 * providers once `MCPRegistry` / `SupervisorRuntimeControlPlane` /
 * `LocalMemoryBackend` are constructed inside `startRepl`. Kept in a
 * separate module so the wiring can be unit-tested without spinning up
 * a real REPL — see `dashboard-runtime-providers.test.ts`.
 *
 * 从运行时引用构造 dashboard tasks / memory / tools 面板的 data
 * provider。`index.ts` 用它在 `startRepl` 内部构造好 MCPRegistry /
 * SupervisorRuntimeControlPlane / LocalMemoryBackend 后，再把 provider
 * 接到真实数据源。逻辑独立成模块以便单独测试，避免拉起完整 REPL。
 */

import type { LocalMemoryBackend } from "../memory/local-backend.js";
import type {
	ChildRunStatusRecord,
	SupervisorRuntimeSnapshot,
} from "../multi-agent/index.js";
import type { SubagentRegistrySnapshotEntry } from "../tools/builtin/index.js";
import type { MCPRegistry } from "../tools/registry.js";
import type {
	DashboardMemoryData,
	DashboardTasksData,
	DashboardToolsData,
} from "./dashboard.js";

export interface SupervisorRuntimeSnapshotProvider {
	snapshot(): SupervisorRuntimeSnapshot;
}

/**
 * Holder for late-bound runtime references. Field values may be undefined
 * during the brief startup window between `startControlPlaneServer` and
 * `onRuntimeReady` firing inside `startRepl`. Provider closures read the
 * current value on each request, so flipping a field from undefined to a
 * concrete value automatically propagates without a server restart.
 *
 * 晚绑定运行时引用的容器。在 `startControlPlaneServer` 与 `startRepl`
 * 内 `onRuntimeReady` 触发之间的短暂启动窗口里，字段可能为 undefined。
 * Provider 闭包每次请求都读当前值，把字段从 undefined 切到真实对象后
 * 自动生效，无需重启 server。
 */
export interface DashboardRuntimeRefs {
	registry?: MCPRegistry;
	supervisorRuntime?: SupervisorRuntimeSnapshotProvider;
	/**
	 * Memory backend factory. We use a factory rather than a single live
	 * instance because `LocalMemoryBackend` holds an open SQLite handle and
	 * we want each request to use a short-lived connection that closes when
	 * the provider returns. Callers MUST close the backend in a `finally`.
	 *
	 * 用工厂而不是单实例，因为 LocalMemoryBackend 持有 SQLite 句柄；
	 * 每次请求拿一个短连接、provider 返回前在 finally 里 close。
	 */
	memoryBackendFactory?: () => LocalMemoryBackend;
}

const TERMINAL_STATUSES: ReadonlySet<ChildRunStatusRecord["status"]> = new Set([
	"completed",
	"failed",
	"cancelled",
	"deferred",
]);

const STALE_STATUSES: ReadonlySet<ChildRunStatusRecord["status"]> = new Set([
	"blocked",
	"waiting_for_review",
]);

function recordSummary(record: ChildRunStatusRecord): string {
	if (record.summary != null && record.summary.length > 0) {
		return record.summary;
	}
	if (record.currentStep != null && record.currentStep.length > 0) {
		return record.currentStep;
	}
	return `${record.status} (${record.runId})`;
}

/**
 * Maps a SupervisorRuntime snapshot into the dashboard tasks panel shape.
 * Records are returned newest-first by `updatedAt` so the UI surfaces
 * recently active runs at the top.
 */
export function buildTasksDataFromSnapshot(
	snapshot: SupervisorRuntimeSnapshot,
	subagentEntries: readonly SubagentRegistrySnapshotEntry[] = [],
): DashboardTasksData {
	const supervisorRecords = [...snapshot.records]
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.map((record) => ({
			childRunId: record.runId,
			taskId: record.taskId,
			eventType: "child_run",
			severity: record.status === "failed" ? "error" : "info",
			title: `${record.status}${record.workerId == null ? "" : ` · ${record.workerId}`}`,
			summary: recordSummary(record),
			timestamp: record.updatedAt,
		}));

	const subagentRecords = [...subagentEntries]
		.reverse() // newest first
		.map((entry) => ({
			childRunId: entry.runId,
			eventType: "subagent_spawn",
			severity: entry.status === "failed" ? "error" : "info",
			title: `subagent_${entry.status}${entry.worker === "default" ? "" : ` · ${entry.worker}`}`,
			summary:
				entry.task.length > 240 ? `${entry.task.slice(0, 240)}…` : entry.task,
			timestamp: entry.startedAt,
		}));

	const records = [...supervisorRecords, ...subagentRecords];

	const supervisorActive = snapshot.records.filter(
		(record) => !TERMINAL_STATUSES.has(record.status),
	).length;
	const supervisorStale = snapshot.records.filter((record) =>
		STALE_STATUSES.has(record.status),
	).length;
	const subagentRunning = subagentEntries.filter(
		(entry) => entry.status === "running",
	).length;

	return {
		records,
		activeRunCount: supervisorActive + subagentRunning,
		staleRunCount: supervisorStale,
	};
}

export function buildMemoryDataFromBackend(
	counts: Readonly<
		Record<"working" | "episodic" | "semantic" | "skill", number>
	>,
): DashboardMemoryData {
	return {
		tiers: [
			{ name: "working", count: counts.working },
			{ name: "episodic", count: counts.episodic },
			{ name: "semantic", count: counts.semantic },
			{ name: "skill", count: counts.skill },
		],
	};
}

export function buildToolsDataFromRegistry(
	registry: MCPRegistry,
): DashboardToolsData {
	const allTools = registry.getAllTools();
	const tools = allTools
		.map((tool) => ({
			name: tool.name,
			...(tool.namespace == null ? {} : { namespace: tool.namespace }),
			...(tool.category == null ? {} : { category: tool.category }),
			...(tool.riskLevel == null ? {} : { riskLevel: tool.riskLevel }),
			...(tool.description == null
				? {}
				: { description: tool.description.slice(0, 240) }),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));

	const byNamespace: Record<string, number> = {};
	for (const tool of allTools) {
		const ns = tool.namespace ?? "builtin";
		byNamespace[ns] = (byNamespace[ns] ?? 0) + 1;
	}

	return {
		tools,
		total: tools.length,
		byNamespace,
	};
}

/**
 * Builds a `tasks` provider closure that reads from `refs` lazily on each
 * call. Returns the `emptyTasksData()` placeholder until the supervisor
 * runtime has been bound — the placeholder includes a `message` hint so
 * the UI can distinguish "no data yet" from "no provider wired" (mirrors
 * QUI-105 round-2 D1).
 */
export function createTasksProviderFromRefs(
	refs: DashboardRuntimeRefs,
	getSubagentEntries: () => readonly SubagentRegistrySnapshotEntry[],
): () => DashboardTasksData {
	return () => {
		const supervisor = refs.supervisorRuntime;
		if (supervisor == null) {
			return {
				records: [],
				activeRunCount: 0,
				staleRunCount: 0,
				message: "tasks provider awaiting REPL runtime",
			};
		}
		try {
			return buildTasksDataFromSnapshot(
				supervisor.snapshot(),
				getSubagentEntries(),
			);
		} catch {
			return {
				records: [],
				activeRunCount: 0,
				staleRunCount: 0,
				message: "tasks provider error reading supervisor snapshot",
			};
		}
	};
}

export function createMemoryProviderFromRefs(
	refs: DashboardRuntimeRefs,
): () => DashboardMemoryData {
	return () => {
		const factory = refs.memoryBackendFactory;
		if (factory == null) {
			return {
				tiers: [
					{
						name: "working",
						count: 0,
						note: "memory provider awaiting REPL runtime",
					},
					{
						name: "episodic",
						count: 0,
						note: "memory provider awaiting REPL runtime",
					},
					{
						name: "semantic",
						count: 0,
						note: "memory provider awaiting REPL runtime",
					},
					{
						name: "skill",
						count: 0,
						note: "memory provider awaiting REPL runtime",
					},
				],
			};
		}
		let backend: LocalMemoryBackend | undefined;
		try {
			backend = factory();
			const counts = backend.countByTier();
			return buildMemoryDataFromBackend(counts);
		} catch {
			return {
				tiers: [
					{ name: "working", count: 0, note: "memory backend unavailable" },
					{ name: "episodic", count: 0, note: "memory backend unavailable" },
					{ name: "semantic", count: 0, note: "memory backend unavailable" },
					{ name: "skill", count: 0, note: "memory backend unavailable" },
				],
			};
		} finally {
			try {
				backend?.close();
			} catch {
				/* swallow close errors so they don't mask request errors */
			}
		}
	};
}

export function createToolsProviderFromRefs(
	refs: DashboardRuntimeRefs,
): () => DashboardToolsData {
	return () => {
		const registry = refs.registry;
		if (registry == null) {
			return { tools: [], total: 0, byNamespace: {} };
		}
		try {
			return buildToolsDataFromRegistry(registry);
		} catch {
			return { tools: [], total: 0, byNamespace: {} };
		}
	};
}
