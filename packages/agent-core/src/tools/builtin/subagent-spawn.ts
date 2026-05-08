import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentLoopConfig } from "../../loop-types.js";
import { runAgentLoop } from "../../loop.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

export interface SubagentSpawnToolOptions {
	readonly getLoopConfig: () => Omit<AgentLoopConfig, "state">;
}

// Hard ceiling on a spawned subagent's task description so a malicious or
// runaway upstream cannot blow up the system prompt and starve the token
// budget. Tasks beyond this size should be split before delegation.
const MAX_TASK_CHARS = 50_000;

// Module-level registry shared by spawn + status tools.
// Bounded so an 8h+ session that spawns thousands of subagents does not
// monotonically grow the Map. When the cap is hit we evict the oldest
// terminal records (completed / failed) first; running records are never
// evicted because they're still doing work the user might query.
interface SubagentRecord {
	readonly task: string;
	readonly worker: string;
	readonly startedAt: string;
	status: "running" | "completed" | "failed";
	result?: string;
	error?: string;
}
const MAX_REGISTRY_RECORDS = 200;
const subagentRegistry = new Map<string, SubagentRecord>();

function evictTerminalRecordsIfFull(): void {
	while (subagentRegistry.size >= MAX_REGISTRY_RECORDS) {
		// Map iteration order is insertion order, so the first terminal entry
		// we hit is the oldest one available for eviction.
		let evicted: string | undefined;
		for (const [id, record] of subagentRegistry) {
			if (record.status !== "running") {
				evicted = id;
				break;
			}
		}
		if (evicted == null) {
			// Nothing terminal to drop — every slot is occupied by an
			// in-flight subagent. Stop trying; we'd rather grow past the cap
			// than discard live work.
			return;
		}
		subagentRegistry.delete(evicted);
	}
}

// Test-only seam — production code never calls this.
export function _resetSubagentRegistryForTests(): void {
	subagentRegistry.clear();
}

export function createSubagentSpawnTool(
	options: SubagentSpawnToolOptions,
): ToolWithMetadata {
	return {
		name: "subagent_spawn",
		description:
			"Spawn a background subagent to work on a task independently. " +
			"Runs in parallel. Use subagent_status to check progress. " +
			"Good for: research, code review, data analysis, file search.",
		parameters: z.object({
			task: z
				.string()
				.min(1)
				.max(MAX_TASK_CHARS)
				.describe(
					`Task for the subagent (max ${MAX_TASK_CHARS} chars; split larger tasks before delegation)`,
				),
			worker: z.string().optional().default("default").describe("Worker label: researcher, coder, reviewer"),
		}),
		category: "interactive",
		riskLevel: "read",
		execute: async (args: unknown) => {
			const { task, worker } = z.object({
				task: z.string().min(1).max(MAX_TASK_CHARS),
				worker: z.string().optional().default("default"),
			}).parse(args as Record<string, unknown>);
			const runId = randomUUID();
			const record: SubagentRecord = { task, worker, startedAt: new Date().toISOString(), status: "running" };
			evictTerminalRecordsIfFull();
			subagentRegistry.set(runId, record);
			void (async () => {
				try {
					const loopConfig = options.getLoopConfig();
					const subMessages = [
						{
							role: "system" as const,
							content: `Subagent [${worker}]. Task: ${task}. Work independently, report concisely.`,
						},
						{ role: "user" as const, content: task },
					];
					const now = new Date().toISOString();
					const result = await runAgentLoop(
						{
							...loopConfig,
							state: {
								messages: subMessages,
								isTerminal: false,
								turnCount: 0,
								createdAt: now,
								lastActiveAt: now,
							},
						},
						subMessages,
					);
					record.status = "completed"; record.result = result;
				} catch (err) { record.status = "failed"; record.error = String(err); }
			})();
			return { toolCallId: "subagent_spawn", isError: false, content: JSON.stringify({ runId, worker, task, status: "spawned", hint: "Use subagent_status to check progress" }) };
		},
	};
}

const STATUS_FILTER_VALUES = ["all", "running", "completed", "failed"] as const;
const subagentStatusParametersSchema = z.object({
	status: z
		.enum(STATUS_FILTER_VALUES)
		.optional()
		.default("all")
		.describe("Filter by subagent status. Default 'all'."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.default(50)
		.describe("Max records to return (most recent first). Default 50, hard max 500."),
});

export function createSubagentStatusTool(): ToolWithMetadata {
	return {
		name: "subagent_status",
		description:
			"Check status of spawned subagents. Returns run IDs, tasks, statuses, and results. " +
			"Supports filtering by status and limiting result count to keep responses bounded.",
		parameters: subagentStatusParametersSchema,
		category: "interactive",
		riskLevel: "read",
		execute: async (args: unknown): Promise<ToolResult> => {
			const { status: filter, limit } = subagentStatusParametersSchema.parse(
				(args as Record<string, unknown>) ?? {},
			);
			if (subagentRegistry.size === 0) {
				return { toolCallId: "subagent_status", content: "No subagents spawned yet.", isError: false };
			}
			const allEntries = [...subagentRegistry.entries()];
			const matching = allEntries.filter(([, r]) =>
				filter === "all" ? true : r.status === filter,
			);
			// Most recent first (insertion order is oldest→newest in a Map).
			const recent = matching.slice(-limit).reverse();
			const runs = recent.map(([id, r]) => ({
				runId: id,
				worker: r.worker,
				task: r.task.slice(0, 120),
				status: r.status,
				startedAt: r.startedAt,
				...(r.status === "completed" ? { result: (r.result ?? "").slice(0, 500) } : {}),
				...(r.status === "failed" ? { error: r.error } : {}),
			}));
			const totals = {
				total: subagentRegistry.size,
				running: allEntries.filter(([, r]) => r.status === "running").length,
				completed: allEntries.filter(([, r]) => r.status === "completed").length,
				failed: allEntries.filter(([, r]) => r.status === "failed").length,
			};
			return {
				toolCallId: "subagent_status",
				isError: false,
				content: JSON.stringify({
					...totals,
					filter,
					shown: runs.length,
					capacity: MAX_REGISTRY_RECORDS,
					runs,
				}),
			};
		},
	};
}
