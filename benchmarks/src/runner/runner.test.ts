import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BenchmarkTask } from "../wire/index.js";
import {
	type BenchmarkAgentLoopConfig,
	type BenchmarkAgentMessage,
	BenchmarkRunError,
	type BenchmarkScratchpad,
	type BenchmarkSpanSnapshot,
	extractBenchmarkCost,
	runBenchmarkTask,
} from "./runner.js";

const task: BenchmarkTask = {
	task_id: "swe-1",
	dataset: "swe-bench-lite",
	inputs: {
		problem_statement: "Fix failing parser",
		repo: "org/repo",
		base_commit: "abc123",
	},
	expected: { golden_patch: "diff --git a/file b/file", test_patch: "" },
	scorer_type: "swe-bench-patch-apply",
};

describe("runBenchmarkTask", () => {
	it("runs setup, agent_loop, collect, score, and cleanup for one task", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-runner-test-"));
		const scratchpad = createScratchpad();
		const spans = createSpanProvider([
			{
				name: "agent.turn",
				attributes: { "turn.cost_usd": 0.05 },
			},
			{
				name: "llm.invoke",
				attributes: {
					"llm.model": "gpt-5",
					"llm.tokens_input": 11,
					"llm.tokens_output": 7,
					"llm.tokens_thinking": 3,
					"llm.cost_usd": 0.04,
					"llm.total_latency_ms": 120,
				},
			},
		]);
		let capturedMessages: readonly BenchmarkAgentMessage[] = [];
		let workspaceDir = "";
		const result = await runBenchmarkTask({
			task,
			options: {
				tmpRoot,
				agentLoopConfig: makeLoopConfig(),
				scratchpad,
				spans,
				createRunId: () => "run-1",
				clock: createClock([
					"2026-04-25T00:00:00.000Z",
					"2026-04-25T00:00:01.000Z",
				]),
				runAgent: async (_config, messages) => {
					capturedMessages = messages;
					const payload = JSON.parse(messages[1]?.content ?? "{}") as {
						workspace_dir?: string;
					};
					workspaceDir = payload.workspace_dir ?? "";
					return "diff --git a/file.ts b/file.ts";
				},
				scorer: async (_task, output) => ({
					passed: typeof output.patch === "string",
					score: 1,
					details: { scorer: "mock" },
				}),
			},
		});

		expect(result.phases).toEqual([
			"setup",
			"agent_loop",
			"collect",
			"score",
			"cleanup",
		]);
		expect(result.run).toEqual({
			run_id: "run-1",
			task_id: "swe-1",
			agent_session_id: "benchmark:run-1",
			started_at: "2026-04-25T00:00:00.000Z",
			finished_at: "2026-04-25T00:00:01.000Z",
		});
		expect(result.result.cost).toEqual({
			input_tokens: 11,
			output_tokens: 7,
			thinking_tokens: 3,
			total_usd: 0.05,
			per_model_usd: { "gpt-5": 0.04 },
		});
		expect(result.result.latency_ms).toBe(120);
		expect(result.result.output.patch).toContain("diff --git");
		expect(capturedMessages[1]?.content).toContain("workspace_dir");
		expect(scratchpad.writes).toHaveLength(1);
		expect(scratchpad.clears).toHaveLength(1);
		expect(spans.cleared).toBe(true);
		expect(existsSync(workspaceDir)).toBe(false);
	});

	it("wraps scorer failures as BenchmarkRunError with the score phase", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-runner-test-"));
		const scratchpad = createScratchpad();
		let workspaceDir = "";
		await expect(
			runBenchmarkTask({
				task,
				options: {
					tmpRoot,
					agentLoopConfig: makeLoopConfig(),
					scratchpad,
					runAgent: async (_config, messages) => {
						const payload = JSON.parse(messages[1]?.content ?? "{}") as {
							workspace_dir?: string;
						};
						workspaceDir = payload.workspace_dir ?? "";
						return "patch";
					},
					scorer: async () => {
						throw new Error("scorer offline");
					},
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "score",
			message: "score: scorer offline",
		});
		expect(scratchpad.clears).toHaveLength(1);
		expect(existsSync(workspaceDir)).toBe(false);
	});

	it("resolves the scorer from the registry when no direct scorer is supplied", async () => {
		const registryGets: string[] = [];
		const result = await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: makeLoopConfig(),
				createRunId: () => "run-registry",
				runAgent: async () => "patch",
				scorerRegistry: {
					get(scorerType) {
						registryGets.push(scorerType);
						return async (_task, output) => ({
							passed: output.patch === "patch",
							score: 0.5,
							details: { routed: scorerType },
						});
					},
				},
			},
		});

		expect(registryGets).toEqual(["swe-bench-patch-apply"]);
		expect(result.result.score).toBe(0.5);
		expect(result.result.details).toEqual({
			routed: "swe-bench-patch-apply",
		});
	});

	it("uses the agent-core runAgentLoop export when no runner is injected", async () => {
		const result = await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					llm: {
						chat: async () => ({
							content: "diff --git a/src/app.ts b/src/app.ts",
							finishReason: "stop",
							usage: { inputTokens: 1, outputTokens: 2 },
						}),
					},
				},
				scorer: async (_task, output) => ({
					passed: output.patch === "diff --git a/src/app.ts b/src/app.ts",
					score: 1,
					details: { default_runner: true },
				}),
			},
		});

		expect(result.result.output.patch).toBe(
			"diff --git a/src/app.ts b/src/app.ts",
		);
		expect(result.result.details).toEqual({ default_runner: true });
	});

	it("wraps missing scorer configuration as a score phase error", async () => {
		await expect(
			runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => "patch",
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "score",
			message: "score: Benchmark runner requires a scorer or scorerRegistry",
		});
	});

	it("wraps agent loop failures and preserves the agent_loop phase", async () => {
		await expect(
			runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => {
						throw new Error("model unavailable");
					},
					scorer: async () => ({
						passed: false,
						score: 0,
						details: {},
					}),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "agent_loop",
			message: "agent_loop: model unavailable",
		});
	});

	it("does not mask cleanup phase failures", async () => {
		await expect(
			runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => "patch",
					scorer: async () => ({
						passed: true,
						score: 1,
						details: {},
					}),
					scratchpad: {
						clear: async () => {
							throw new Error("scratchpad offline");
						},
					},
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "cleanup",
			message: "cleanup: scratchpad offline",
		});
	});

	it("reports setup failures before a workspace is available", async () => {
		await expect(
			runBenchmarkTask({
				task,
				options: {
					tmpRoot: join(tmpdir(), "missing-quilin-benchmark-parent"),
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => "patch",
					scorer: async () => ({
						passed: true,
						score: 1,
						details: {},
					}),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "setup",
		});
	});

	it("removes the temporary workspace when scratchpad setup fails", async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "quilin-runner-test-"));

		try {
			await expect(
				runBenchmarkTask({
					task,
					options: {
						tmpRoot,
						agentLoopConfig: makeLoopConfig(),
						runAgent: async () => "patch",
						scorer: async () => ({
							passed: true,
							score: 1,
							details: {},
						}),
						scratchpad: {
							write: async () => {
								throw new Error("scratchpad write failed");
							},
						},
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "setup",
				message: "setup: scratchpad write failed",
			});
			await expect(readdir(tmpRoot)).resolves.toEqual([]);
		} finally {
			await rm(tmpRoot, { recursive: true, force: true });
		}
	});
});

describe("extractBenchmarkCost", () => {
	it("falls back to summed LLM cost when turn cost is absent", () => {
		expect(
			extractBenchmarkCost([
				{
					name: "llm.invoke",
					attributes: {
						"llm.model": "gpt-5",
						"llm.tokens_input": 2,
						"llm.tokens_output": 4,
						"llm.tokens_thinking": 6,
						"llm.cost_usd": 0.02,
					},
				},
				{
					name: "llm.invoke",
					attributes: {
						"llm.model": "claude",
						"llm.tokens_input": 1,
						"llm.tokens_output": 3,
						"llm.tokens_thinking": 5,
						"llm.cost_usd": 0.03,
					},
				},
			]),
		).toEqual({
			input_tokens: 3,
			output_tokens: 7,
			thinking_tokens: 11,
			total_usd: 0.05,
			per_model_usd: { "gpt-5": 0.02, claude: 0.03 },
		});
	});

	it("uses zeroes for missing or malformed attributes", () => {
		expect(
			extractBenchmarkCost([
				{
					name: "llm.invoke",
					attributes: {
						"llm.model": "",
						"llm.tokens_input": "bad",
						"llm.cost_usd": Number.NaN,
					},
				},
			]),
		).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			thinking_tokens: 0,
			total_usd: 0,
			per_model_usd: { unknown: 0 },
		});
	});
});

function makeLoopConfig(): Omit<BenchmarkAgentLoopConfig, "observability"> {
	return {
		llm: {
			chat: vi.fn(),
		},
		inferenceConfig: {
			temperature: 0,
			maxTokens: 128,
			thinkingMode: "disabled",
		},
	};
}

function createScratchpad(): BenchmarkScratchpad & {
	writes: unknown[];
	clears: unknown[];
} {
	const writes: unknown[] = [];
	const clears: unknown[] = [];
	return {
		writes,
		clears,
		write: async (input) => {
			writes.push(input);
		},
		clear: async (input) => {
			clears.push(input);
		},
	};
}

function createSpanProvider(spans: readonly BenchmarkSpanSnapshot[]) {
	return {
		cleared: false,
		snapshot: () => spans,
		clear() {
			this.cleared = true;
		},
	};
}

function createClock(values: readonly string[]): () => Date {
	let index = 0;
	return () => new Date(values[Math.min(index++, values.length - 1)]);
}

void BenchmarkRunError;
