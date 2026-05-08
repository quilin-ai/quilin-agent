import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentLoopConfig } from "../../loop-types.js";
import { runAgentLoop } from "../../loop.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

export interface SubagentSpawnToolOptions {
	readonly getLoopConfig: () => Omit<AgentLoopConfig, "state">;
}

// Module-level registry shared by spawn + status tools
interface SubagentRecord {
	readonly task: string;
	readonly worker: string;
	readonly startedAt: string;
	status: "running" | "completed" | "failed";
	result?: string;
	error?: string;
}
const subagentRegistry = new Map<string, SubagentRecord>();

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
			task: z.string().min(1).describe("Task for the subagent"),
			worker: z.string().optional().default("default").describe("Worker label: researcher, coder, reviewer"),
		}),
		category: "interactive",
		riskLevel: "read",
		execute: async (args: unknown) => {
			const { task, worker } = z.object({
				task: z.string().min(1),
				worker: z.string().optional().default("default"),
			}).parse(args as Record<string, unknown>);
			const runId = randomUUID();
			const record: SubagentRecord = { task, worker, startedAt: new Date().toISOString(), status: "running" };
			subagentRegistry.set(runId, record);
			void (async () => {
				try {
					const loopConfig = options.getLoopConfig();
					const result = await runAgentLoop({ ...loopConfig, state: {
						messages: [{ role: "system", content: `Subagent [${worker}]. Task: ${task}. Work independently, report concisely.` }, { role: "user", content: task }],
						isTerminal: false, turnCount: 0, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
					} }, []);
					record.status = "completed"; record.result = result;
				} catch (err) { record.status = "failed"; record.error = String(err); }
			})();
			return { toolCallId: "subagent_spawn", isError: false, content: JSON.stringify({ runId, worker, task, status: "spawned", hint: "Use subagent_status to check progress" }) };
		},
	};
}

export function createSubagentStatusTool(): ToolWithMetadata {
	return {
		name: "subagent_status",
		description: "Check status of all spawned subagents. Returns run IDs, tasks, statuses, and results.",
		parameters: z.object({}),
		category: "interactive",
		riskLevel: "read",
		execute: async (): Promise<ToolResult> => {
			if (subagentRegistry.size === 0) return { toolCallId: "subagent_status", content: "No subagents spawned yet.", isError: false };
			const runs = [...subagentRegistry.entries()].map(([id, r]) => ({
				runId: id, worker: r.worker, task: r.task.slice(0, 120), status: r.status, startedAt: r.startedAt,
				...(r.status === "completed" ? { result: (r.result ?? "").slice(0, 500) } : {}),
				...(r.status === "failed" ? { error: r.error } : {}),
			}));
			return { toolCallId: "subagent_status", isError: false, content: JSON.stringify({ total: runs.length, running: runs.filter(r => r.status === "running").length, completed: runs.filter(r => r.status === "completed").length, failed: runs.filter(r => r.status === "failed").length, runs }) };
		},
	};
}
