import { existsSync, symlinkSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BenchmarkTask } from "../wire/index.js";
import {
	type BenchmarkAgentLoopRuntimeConfig,
	type BenchmarkAgentMessage,
	BenchmarkRunError,
	type BenchmarkRunnerOptions,
	type BenchmarkSandbox,
	type BenchmarkScratchpad,
	type BenchmarkSpanSnapshot,
	type BenchmarkTool,
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

const gaiaTask: BenchmarkTask = {
	task_id: "gaia-1",
	dataset: "gaia",
	inputs: {
		level: 1,
		question: "What is the capital of France?",
	},
	expected: { final_answer: "Paris" },
	scorer_type: "gaia-exact-match",
};

const bfclTask: BenchmarkTask = {
	task_id: "simple_python_0",
	dataset: "bfcl-v4",
	inputs: {
		function_definitions: [
			{
				name: "calculate_triangle_area",
				parameters: {
					properties: {
						base: { type: "integer" },
						height: { type: "integer" },
					},
					required: ["base", "height"],
					type: "dict",
				},
			},
		],
		question: "Find the triangle area.",
	},
	expected: {
		category: "simple_python",
		general_category: "non_live",
		ground_truth: [{ calculate_triangle_area: { base: [10], height: [5] } }],
	},
	metadata: {
		category: "simple_python",
		general_category: "non_live",
	},
	scorer_type: "bfcl-v4-ast",
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

	it("collects GAIA model_answer JSON instead of patch output", async () => {
		let capturedSystemPrompt = "";
		let capturedUserPrompt = "";
		const hostPath = join(tmpdir(), "gaia-secret.xlsx");
		const result = await runBenchmarkTask({
			task: {
				...gaiaTask,
				inputs: {
					...gaiaTask.inputs,
					file_attachments: [
						"raw-attachment-marker",
						{
							container_path:
								"/workspace/cache/datasets/gaia/attachments/secret.xlsx",
							file_name: "secret.xlsx",
							file_path:
								"/workspace/cache/datasets/gaia/attachments/secret.xlsx",
							host_path: hostPath,
							relative_path: "attachments/secret.xlsx",
							sha256: "a".repeat(64),
							size_bytes: 123,
						},
						{
							container_path: 42,
							file_name: 42,
							file_path: 42,
							host_path: hostPath,
							relative_path: "attachments/ignored.xlsx",
							sha256: 42,
							size_bytes: "123",
						},
					],
					file_host_path: hostPath,
					file_path: "/workspace/cache/datasets/gaia/attachments/secret.xlsx",
				},
			},
			options: {
				agentLoopConfig: makeLoopConfig(),
				createRunId: () => "run-gaia",
				runAgent: async (_config, messages) => {
					capturedSystemPrompt = messages[0]?.content ?? "";
					capturedUserPrompt = messages[1]?.content ?? "";
					return JSON.stringify({
						model_answer: "Paris",
						reasoning_trace: "Looked up the capital.",
					});
				},
				scorer: async (_task, output) => ({
					passed: output.model_answer === "Paris",
					score: 1,
					details: { output },
				}),
			},
		});

		expect(capturedSystemPrompt).toContain("GAIA benchmark task");
		expect(capturedUserPrompt).toContain("/workspace/cache/datasets/gaia");
		expect(capturedUserPrompt).toContain("raw-attachment-marker");
		expect(capturedUserPrompt).not.toContain(hostPath);
		expect(capturedUserPrompt).not.toContain("file_host_path");
		expect(capturedUserPrompt).not.toContain("host_path");
		expect(capturedUserPrompt).not.toContain("relative_path");
		expect(result.result.output).toEqual({
			model_answer: "Paris",
			reasoning_trace: "Looked up the capital.",
		});
		expect(result.result.passed).toBe(true);
	});

	it("fails loudly when GAIA agent output is not strict answer JSON", async () => {
		await expect(
			runBenchmarkTask({
				task: gaiaTask,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => "Paris",
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "collect",
			message: expect.stringContaining(
				"GAIA agent output must be a JSON object",
			),
		});

		await expect(
			runBenchmarkTask({
				task: gaiaTask,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => "[]",
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "collect",
			message: "collect: GAIA agent output must be a JSON object",
		});

		await expect(
			runBenchmarkTask({
				task: gaiaTask,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => JSON.stringify({ model_answer: " " }),
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "collect",
			message: "collect: GAIA agent output requires non-empty model_answer",
		});
	});

	it("omits empty GAIA reasoning_trace from collected output", async () => {
		const result = await runBenchmarkTask({
			task: gaiaTask,
			options: {
				agentLoopConfig: makeLoopConfig(),
				runAgent: async () =>
					JSON.stringify({ model_answer: "Paris", reasoning_trace: " " }),
				scorer: async (_task, output) => ({
					passed: output.reasoning_trace === undefined,
					score: 1,
					details: { output },
				}),
			},
		});

		expect(result.result.output).toEqual({ model_answer: "Paris" });
	});

	it("collects BFCL v4 strict tool_calls JSON and prompts the output contract", async () => {
		let capturedSystemPrompt = "";
		const result = await runBenchmarkTask({
			task: bfclTask,
			options: {
				agentLoopConfig: makeLoopConfig(),
				createRunId: () => "run-bfcl",
				runAgent: async (_config, messages) => {
					capturedSystemPrompt = messages[0]?.content ?? "";
					return JSON.stringify({
						tool_calls: [
							{
								arguments: { base: 10, height: 5 },
								function: "calculate_triangle_area",
							},
						],
					});
				},
				scorer: async (_task, output) => ({
					details: { output },
					passed: Array.isArray(output.tool_calls),
					score: 1,
				}),
			},
		});

		expect(capturedSystemPrompt).toContain("BFCL v4");
		expect(result.result.output).toEqual({
			tool_calls: [
				{
					arguments: { base: 10, height: 5 },
					function: "calculate_triangle_area",
				},
			],
		});
		expect(result.result.passed).toBe(true);
	});

	it("fails loudly when BFCL v4 agent output is not strict tool_calls JSON", async () => {
		await expect(
			runBenchmarkTask({
				task: bfclTask,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => "[]",
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "collect",
			message: "collect: BFCL v4 agent output must be a JSON object",
		});

		await expect(
			runBenchmarkTask({
				task: bfclTask,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () => JSON.stringify({ tool_calls: "bad" }),
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "collect",
			message: "collect: BFCL v4 agent output requires tool_calls array",
		});

		await expect(
			runBenchmarkTask({
				task: bfclTask,
				options: {
					agentLoopConfig: makeLoopConfig(),
					runAgent: async () =>
						JSON.stringify({ tool_calls: [{ function: "x" }] }),
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "collect",
			message: "collect: BFCL v4 tool_call requires arguments object",
		});
	});

	it("requires an injected agent runner instead of importing agent-core internals", async () => {
		const options = {
			agentLoopConfig: makeLoopConfig(),
			scorer: async () => ({ passed: true, score: 1, details: {} }),
		} as unknown as BenchmarkRunnerOptions;

		await expect(runBenchmarkTask({ task, options })).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "agent_loop",
			message: "agent_loop: Benchmark runner requires an injected runAgent",
		});
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

	it("wraps shell_exec tools with workspace cwd containment", async () => {
		const calls: unknown[] = [];
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async (args) => {
				calls.push(args);
				return { content: "{}", isError: false };
			}),
		};
		let workspaceDir = "";

		const result = await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [shellExec],
				},
				runAgent: async (config, messages) => {
					const payload = JSON.parse(messages[1]?.content ?? "{}") as {
						workspace_dir?: string;
					};
					workspaceDir = payload.workspace_dir ?? "";
					await config.tools?.[0]?.execute({
						command: "touch result.txt",
						outputs: [{ output_dir: "artifacts" }],
						path: "result.txt",
						workspace_directory: ".",
					});
					return "patch";
				},
				scorer: async (_task, output) => ({
					passed: output.patch === "patch",
					score: 1,
					details: {},
				}),
			},
		});

		expect(result.result.passed).toBe(true);
		expect(calls).toEqual([
			{
				command: "touch result.txt",
				cwd: workspaceDir,
				outputs: [{ output_dir: "artifacts" }],
				path: "result.txt",
				workspace_directory: ".",
			},
		]);
		expect(existsSync(workspaceDir)).toBe(false);
	});

	it("routes shell_exec tools through an injected sandbox", async () => {
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async () => ({ content: "{}", isError: false })),
		};
		const sandbox: BenchmarkSandbox = {
			runShellCommand: vi.fn(async () => ({
				content: JSON.stringify({ exitCode: 0, stderr: "", stdout: "ok" }),
				isError: false,
			})),
		};

		const result = await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [shellExec],
				},
				runAgent: async (config) => {
					await config.tools?.[0]?.execute({
						command: "echo ok",
						timeoutMs: 123,
					});
					return "patch";
				},
				sandbox,
				scorer: async () => ({ passed: true, score: 1, details: {} }),
			},
		});

		expect(result.result.passed).toBe(true);
		expect(shellExec.execute).not.toHaveBeenCalled();
		expect(sandbox.runShellCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "echo ok",
				timeoutMs: 123,
			}),
		);
	});

	it("allows DockerSandbox container paths without host workspace guard rejection", async () => {
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async () => ({ content: "{}", isError: false })),
		};
		const sandbox: BenchmarkSandbox = {
			runShellCommand: vi.fn(async () => ({
				content: JSON.stringify({ exitCode: 0, stderr: "", stdout: "" }),
				isError: false,
			})),
		};

		const command =
			"cat /workspace/base/input.txt > /workspace/artifacts/output.txt";
		await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [shellExec],
				},
				runAgent: async (config) => {
					await config.tools?.[0]?.execute({ command });
					return "patch";
				},
				sandbox,
				scorer: async () => ({ passed: true, score: 1, details: {} }),
			},
		});

		expect(shellExec.execute).not.toHaveBeenCalled();
		expect(sandbox.runShellCommand).toHaveBeenCalledWith(
			expect.objectContaining({ command }),
		);
	});

	it("does not route non-shell tools through the sandbox", async () => {
		const calls: unknown[] = [];
		const tool: BenchmarkTool = {
			name: "echo",
			execute: vi.fn(async (args) => {
				calls.push(args);
				return { content: "ok" };
			}),
		};
		const sandbox: BenchmarkSandbox = {
			runShellCommand: vi.fn(async () => ({
				content: "{}",
				isError: false,
			})),
		};

		await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [tool],
				},
				runAgent: async (config) => {
					await config.tools?.[0]?.execute({ command: "echo ok" });
					return "patch";
				},
				sandbox,
				scorer: async () => ({ passed: true, score: 1, details: {} }),
			},
		});

		expect(calls).toEqual([{ command: "echo ok" }]);
		expect(sandbox.runShellCommand).not.toHaveBeenCalled();
	});

	it("falls back to shell_exec when sandboxed args are not commands", async () => {
		const calls: unknown[] = [];
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async (args) => {
				calls.push(args);
				return { content: "ok" };
			}),
		};
		const sandbox: BenchmarkSandbox = {
			runShellCommand: vi.fn(async () => ({
				content: "{}",
				isError: false,
			})),
		};

		await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [shellExec],
				},
				runAgent: async (config) => {
					await config.tools?.[0]?.execute({ command: 42 });
					return "patch";
				},
				sandbox,
				scorer: async () => ({ passed: true, score: 1, details: {} }),
			},
		});

		expect(calls).toEqual([{ command: 42, cwd: expect.any(String) }]);
		expect(sandbox.runShellCommand).not.toHaveBeenCalled();
	});

	it("passes non-object tool arguments through unchanged", async () => {
		const calls: unknown[] = [];
		const tool: BenchmarkTool = {
			name: "echo",
			execute: vi.fn(async (args) => {
				calls.push(args);
				return { content: "ok" };
			}),
		};

		await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [tool],
				},
				runAgent: async (config) => {
					await config.tools?.[0]?.execute("raw-input");
					return "patch";
				},
				scorer: async () => ({ passed: true, score: 1, details: {} }),
			},
		});

		expect(calls).toEqual(["raw-input"]);
	});

	it.each([
		["home secret", "~/.quilin/secret.txt"],
		["system file", "/etc/hosts"],
		["repo root", resolve(process.cwd(), "..", "readme.md")],
		["windows drive", "C:\\Users\\secret.txt"],
	])("blocks %s paths outside the task workspace", async (_label, path) => {
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async () => ({ content: "{}", isError: false })),
		};

		await expect(
			runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: {
						...makeLoopConfig(),
						tools: [shellExec],
					},
					runAgent: async (config) => {
						await config.tools?.[0]?.execute({
							command: "pwd",
							path,
						});
						return "patch";
					},
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "agent_loop",
			message:
				"agent_loop: Benchmark sandbox blocked path outside workspace: path",
		});
		expect(shellExec.execute).not.toHaveBeenCalled();
	});

	it("blocks workspace symlinks that resolve outside the task workspace", async () => {
		const outsideDir = await mkdtemp(join(tmpdir(), "quilin-runner-outside-"));
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async () => ({ content: "{}", isError: false })),
		};

		try {
			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: {
							...makeLoopConfig(),
							tools: [shellExec],
						},
						runAgent: async (config, messages) => {
							const payload = JSON.parse(messages[1]?.content ?? "{}") as {
								workspace_dir?: string;
							};
							const workspaceDir = payload.workspace_dir ?? "";
							symlinkSync(outsideDir, join(workspaceDir, "link-out"), "dir");
							await config.tools?.[0]?.execute({
								command: "pwd",
								path: "link-out/result.txt",
							});
							return "patch";
						},
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark sandbox blocked path outside workspace: path",
			});
			expect(shellExec.execute).not.toHaveBeenCalled();
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	it("blocks relative command paths that traverse workspace symlinks", async () => {
		const outsideDir = await mkdtemp(join(tmpdir(), "quilin-runner-outside-"));
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async () => ({ content: "{}", isError: false })),
		};

		try {
			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: {
							...makeLoopConfig(),
							tools: [shellExec],
						},
						runAgent: async (config, messages) => {
							const payload = JSON.parse(messages[1]?.content ?? "{}") as {
								workspace_dir?: string;
							};
							const workspaceDir = payload.workspace_dir ?? "";
							symlinkSync(outsideDir, join(workspaceDir, "link-out"), "dir");
							await config.tools?.[0]?.execute({
								command: "cat link-out/secret.txt",
							});
							return "patch";
						},
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark sandbox blocked path outside workspace: command",
			});
			expect(shellExec.execute).not.toHaveBeenCalled();
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	it.each([
		"cat /etc/hosts",
		'cat "/etc/hosts"',
		"cat '../secret.txt'",
		"cat ../secret.txt",
		"cat ~/.quilin/secret.txt",
		"type C:\\Windows\\win.ini",
		"wget --output-document=/tmp/secret https://x.com/y",
		'wget --output-document="/tmp/secret" https://x.com/y',
		"wget --output-document=../secret.txt https://x.com/y",
		"curl -O/tmp/secret https://x.com/y",
		"curl file:///tmp/secret.txt",
		"tool --remote=file:///tmp/secret.txt",
		"echo ok >/tmp/secret.txt",
		"echo ok >>/tmp/secret.txt",
		"cat </tmp/secret.txt",
		"cat <<../secret.txt",
		"echo ok 2>/tmp/secret.txt",
		"echo ok 2>>/tmp/secret.txt",
		"echo ok &>/tmp/secret.txt",
		"echo ok &>>/tmp/secret.txt",
		"echo ok >../secret.txt",
	])("blocks paths embedded in shell_exec commands: %s", async (command) => {
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async () => ({ content: "{}", isError: false })),
		};

		await expect(
			runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: {
						...makeLoopConfig(),
						tools: [shellExec],
					},
					runAgent: async (config) => {
						await config.tools?.[0]?.execute({ command });
						return "patch";
					},
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			}),
		).rejects.toMatchObject({
			name: "BenchmarkRunError",
			phase: "agent_loop",
			message:
				"agent_loop: Benchmark sandbox blocked path outside workspace: command",
		});
		expect(shellExec.execute).not.toHaveBeenCalled();
	});

	it.each([
		"echo --flag=",
		"echo --verbose",
		"git clone https://x.com/y",
		"git remote add origin ssh://git@example.com/org/repo",
		"tool --remote=https://x.com/y",
		"wget --output-document=path/to/file https://x.com/y",
		"wget --output-document='path/to/file' https://x.com/y",
		"echo ok >path/to/file",
		"cat <path/to/file",
		"cat <<EOF",
	])("allows URL and workspace-relative command tokens: %s", async (command) => {
		const calls: unknown[] = [];
		const shellExec: BenchmarkTool = {
			name: "shell_exec",
			execute: vi.fn(async (args) => {
				calls.push(args);
				return { content: "{}", isError: false };
			}),
		};

		const result = await runBenchmarkTask({
			task,
			options: {
				agentLoopConfig: {
					...makeLoopConfig(),
					tools: [shellExec],
				},
				runAgent: async (config) => {
					await config.tools?.[0]?.execute({ command });
					return "patch";
				},
				scorer: async () => ({ passed: true, score: 1, details: {} }),
			},
		});

		expect(result.result.passed).toBe(true);
		expect(calls).toEqual([expect.objectContaining({ command })]);
	});

	it("enforces the benchmark network whitelist around agent fetch calls", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response("ok"));
		globalThis.fetch = fetchMock as typeof globalThis.fetch;
		try {
			const allowed = await runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: makeLoopConfig(),
					networkWhitelist: ["allowed.example"],
					runAgent: async () => {
						await fetch("https://allowed.example/data");
						return "patch";
					},
					scorer: async (_task, output) => ({
						passed: output.patch === "patch",
						score: 1,
						details: {},
					}),
				},
			});
			expect(allowed.result.passed).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			const allowedByHostname = await runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: makeLoopConfig(),
					networkWhitelist: ["allowed.example"],
					runAgent: async () => {
						await fetch("https://allowed.example:8443/data");
						return "patch";
					},
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			});
			expect(allowedByHostname.result.passed).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);

			const allowedByConfig = await runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: {
						...makeLoopConfig(),
						benchmarks: {
							network_whitelist: ["https://origin.example"],
						},
					},
					runAgent: async () => {
						await fetch(new URL("https://origin.example/data"));
						return "patch";
					},
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			});
			expect(allowedByConfig.result.passed).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(3);

			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: {
							...makeLoopConfig(),
							benchmarks: {
								network_whitelist: ["https://origin.example"],
							},
						},
						runAgent: async () => {
							await fetch("https://not-origin.example/data");
							return "patch";
						},
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark network blocked outbound fetch: https://not-origin.example",
			});
			expect(fetchMock).toHaveBeenCalledTimes(3);

			const allowedRequestObject = await runBenchmarkTask({
				task,
				options: {
					agentLoopConfig: makeLoopConfig(),
					networkWhitelist: ["object.example"],
					runAgent: async () => {
						await fetch({
							url: "https://object.example/data",
						} as Parameters<typeof globalThis.fetch>[0]);
						return "patch";
					},
					scorer: async () => ({ passed: true, score: 1, details: {} }),
				},
			});
			expect(allowedRequestObject.result.passed).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(4);

			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: makeLoopConfig(),
						networkWhitelist: [" "],
						runAgent: async () => {
							await fetch("https://blank.example/data");
							return "patch";
						},
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark network blocked outbound fetch: https://blank.example",
			});
			expect(fetchMock).toHaveBeenCalledTimes(4);

			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: makeLoopConfig(),
						networkWhitelist: ["allowed.example"],
						runAgent: async () => {
							await fetch({} as Parameters<typeof globalThis.fetch>[0]);
							return "patch";
						},
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark network whitelist could not inspect fetch URL",
			});
			expect(fetchMock).toHaveBeenCalledTimes(4);

			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: makeLoopConfig(),
						networkWhitelist: ["allowed.example"],
						runAgent: async () => {
							await fetch("https://blocked.example/data");
							return "patch";
						},
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark network blocked outbound fetch: https://blocked.example",
			});
			expect(fetchMock).toHaveBeenCalledTimes(4);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("fails closed when a network whitelist is configured without global fetch", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = undefined as unknown as typeof globalThis.fetch;
		try {
			await expect(
				runBenchmarkTask({
					task,
					options: {
						agentLoopConfig: makeLoopConfig(),
						networkWhitelist: ["allowed.example"],
						runAgent: async () => "patch",
						scorer: async () => ({ passed: true, score: 1, details: {} }),
					},
				}),
			).rejects.toMatchObject({
				name: "BenchmarkRunError",
				phase: "agent_loop",
				message:
					"agent_loop: Benchmark network whitelist requires global fetch",
			});
		} finally {
			globalThis.fetch = originalFetch;
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

function makeLoopConfig(): BenchmarkAgentLoopRuntimeConfig {
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
