import { describe, expect, it } from "vitest";
import {
	DSPY_OFFLINE_OPTIMIZER_ID,
	type DspyOptimizerMCPClient,
} from "./dspy-offline-optimizer.js";
import { LocalNoopOfflineOptimizer } from "./offline-optimizer.js";
import { createOfflineOptimizer } from "./optimizer-factory.js";
import { PromptRewriteOptimizer } from "./prompt-rewrite-optimizer.js";
import {
	LOCAL_NOOP_OPTIMIZER_ID,
	PROMPT_REWRITE_OPTIMIZER_ID,
} from "./types.js";

class StubMCPClient implements DspyOptimizerMCPClient {
	async callTool(): Promise<string> {
		return JSON.stringify({
			schema_version: 1,
			optimizer_id: "dspy-stub",
			mode: "prompt_rewrite",
			created_at: "2026-05-09T00:00:00.000Z",
			proposals: [],
			no_proposal_reasons: [],
		});
	}
}

describe("createOfflineOptimizer", () => {
	it("returns a PromptRewriteOptimizer for prompt_rewrite (default)", () => {
		const optimizer = createOfflineOptimizer({ choice: "prompt_rewrite" });
		expect(optimizer).toBeInstanceOf(PromptRewriteOptimizer);
		expect(optimizer.optimizerId).toBe(PROMPT_REWRITE_OPTIMIZER_ID);
	});

	it("returns a LocalNoopOfflineOptimizer for noop", () => {
		const optimizer = createOfflineOptimizer({ choice: "noop" });
		expect(optimizer).toBeInstanceOf(LocalNoopOfflineOptimizer);
		expect(optimizer.optimizerId).toBe(LOCAL_NOOP_OPTIMIZER_ID);
	});

	it("returns a DspyOfflineOptimizer for dspy when a client factory is wired", () => {
		const optimizer = createOfflineOptimizer({
			choice: "dspy",
			dspyClientFactory: () => new StubMCPClient(),
		});
		expect(optimizer.optimizerId).toBe(DSPY_OFFLINE_OPTIMIZER_ID);
	});

	it("falls back to PromptRewriteOptimizer when dspy is chosen without a client factory", () => {
		const optimizer = createOfflineOptimizer({ choice: "dspy" });
		expect(optimizer).toBeInstanceOf(PromptRewriteOptimizer);
	});

	it("forwards now() to the constructed optimizer", async () => {
		const optimizer = createOfflineOptimizer({
			choice: "prompt_rewrite",
			now: () => new Date("2030-01-01T00:00:00.000Z"),
		});
		const result = await optimizer.optimize({ trajectories: [] });
		expect(result.createdAt).toBe("2030-01-01T00:00:00.000Z");
	});

	it("passes through the dspy tool name override", async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const optimizer = createOfflineOptimizer({
			choice: "dspy",
			dspyClientFactory: () => ({
				async callTool(name, args) {
					calls.push({ name, args });
					return JSON.stringify({
						schema_version: 1,
						optimizer_id: "dspy-stub",
						mode: "prompt_rewrite",
						created_at: "2026-05-09T00:00:00.000Z",
						proposals: [],
						no_proposal_reasons: [],
					});
				},
			}),
			dspyToolName: "optimize_v2",
		});
		await optimizer.optimize({
			trajectories: [
				{
					schemaVersion: 1,
					runId: "r1",
					trajectoryRef: "trajectory:r1",
					contentHash: "x".repeat(64),
					outcome: "failure",
					createdAt: "2026-05-09T00:00:00.000Z",
					steps: [],
				},
			],
		});
		expect(calls[0]?.name).toBe("optimize_v2");
	});
});
