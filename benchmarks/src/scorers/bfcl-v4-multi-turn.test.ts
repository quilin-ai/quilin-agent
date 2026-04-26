import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BenchmarkTask } from "../wire/task.js";
import {
	__bfclV4MultiTurnPrivateForTests,
	BFCL_V4_MULTI_TURN_SCORER_TYPE,
	bfclV4MultiTurnScorer,
	scoreBfclV4MultiTurn,
} from "./index.js";

const task = {
	dataset: "bfcl-v4",
	expected: {
		category: "multi_turn_base",
		general_category: "multi_turn",
		initial_config: { GorillaFileSystem: { root: {} } },
		involved_classes: ["GorillaFileSystem"],
		possible_answer: [["cd(folder='document')"]],
	},
	inputs: { question: "Move a file" },
	metadata: {
		category: "multi_turn_base",
		general_category: "multi_turn",
		multi_turn: true,
	},
	scorer_type: BFCL_V4_MULTI_TURN_SCORER_TYPE,
	task_id: "multi_turn_base_0",
} satisfies BenchmarkTask;

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("bfclV4MultiTurnScorer", () => {
	it("returns the official checker score and breakdown", async () => {
		const result = await scoreBfclV4MultiTurn(
			task,
			{ model_output_trajectory: [[[{ cd: '{"folder":"document"}' }]]] },
			{
				spawnChecker: async ({ env, stdin }) => {
					expect(env.BFCL_CHECKER_ROOT).toContain("bfcl-v4");
					expect(JSON.parse(stdin)).toMatchObject({
						task: { task_id: "multi_turn_base_0" },
					});
					return {
						stderr: "",
						stdout: JSON.stringify({
							breakdown: { valid: true },
							score: 1,
							valid: true,
						}),
					};
				},
			},
		);

		expect(result).toEqual({
			details: {
				breakdown: { valid: true },
				category: "multi_turn_base",
				scorer_type: BFCL_V4_MULTI_TURN_SCORER_TYPE,
			},
			passed: true,
			score: 1,
		});
	});

	it("fails loudly when model trajectory or possible answer is malformed", async () => {
		await expect(bfclV4MultiTurnScorer(task, {})).resolves.toMatchObject({
			passed: false,
		});
		await expect(scoreBfclV4MultiTurn(task, {})).resolves.toMatchObject({
			details: { reason: "missing_model_output_trajectory" },
			passed: false,
			score: 0,
		});
		await expect(
			scoreBfclV4MultiTurn(
				{ ...task, expected: { ...task.expected, possible_answer: "bad" } },
				{ model_output_trajectory: [] },
			),
		).resolves.toMatchObject({
			details: { reason: "missing_possible_answer" },
			passed: false,
		});
	});

	it("rejects invalid checker JSON and timeout paths", async () => {
		await expect(
			scoreBfclV4MultiTurn(
				task,
				{ model_output_trajectory: [] },
				{
					spawnChecker: async () => ({ stderr: "", stdout: "not-json" }),
				},
			),
		).rejects.toThrow(/invalid JSON/);

		await expect(
			scoreBfclV4MultiTurn(
				task,
				{ model_output_trajectory: [] },
				{
					spawnChecker: async () => {
						throw new Error("BFCL multi-turn checker timed out");
					},
				},
			),
		).rejects.toThrow(/timed out/);
	});

	it("normalizes checker score edge cases and accepts trajectory aliases", async () => {
		await expect(
			scoreBfclV4MultiTurn(
				{ ...task, metadata: {} },
				{ trajectory: [] },
				{
					spawnChecker: async () => ({
						stderr: "",
						stdout: JSON.stringify({ score: 0.25, valid: false }),
					}),
				},
			),
		).resolves.toMatchObject({
			details: { category: "multi_turn_base" },
			passed: false,
			score: 0.25,
		});
		await expect(
			scoreBfclV4MultiTurn(
				{ ...task, expected: { ...task.expected, category: undefined } },
				{ result: [] },
				{
					spawnChecker: async () => ({
						stderr: "",
						stdout: JSON.stringify({ score: "not-a-number", valid: true }),
					}),
				},
			),
		).resolves.toMatchObject({ passed: true, score: 1 });
		await expect(
			scoreBfclV4MultiTurn(
				task,
				{ model_output_trajectory: [] },
				{
					spawnChecker: async () => ({
						stderr: "",
						stdout: JSON.stringify({ score: 2, valid: false }),
					}),
				},
			),
		).resolves.toMatchObject({ passed: false, score: 1 });
		await expect(
			scoreBfclV4MultiTurn(
				task,
				{ model_output_trajectory: [] },
				{
					spawnChecker: async () => ({
						stderr: "",
						stdout: JSON.stringify({ score: -1, valid: false }),
					}),
				},
			),
		).resolves.toMatchObject({ passed: false, score: 0 });
		await expect(
			scoreBfclV4MultiTurn(
				task,
				{ model_output_trajectory: [] },
				{
					spawnChecker: async () => ({
						stderr: "",
						stdout: JSON.stringify({ score: 1, valid: false }),
					}),
				},
			),
		).resolves.toMatchObject({
			details: { breakdown: {} },
			passed: true,
			score: 1,
		});
	});

	it("runs checker subprocesses after verifying the cached checker bundle", async () => {
		const cacheRoot = await writeCheckerBundle();
		const scriptPath = join(cacheRoot, "checker.mjs");
		await writeFile(
			scriptPath,
			"process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({valid:true,score:1,breakdown:{from:'node'}})));",
			"utf8",
		);

		await expect(
			__bfclV4MultiTurnPrivateForTests.runChecker({
				checkerRoot: join(cacheRoot, "datasets", "bfcl-v4"),
				checkerScriptPath: scriptPath,
				payload: { ok: true },
				pythonExecutable: process.execPath,
				timeoutMs: 1_000,
			}),
		).resolves.toMatchObject({
			breakdown: { from: "node" },
			score: 1,
			valid: true,
		});
	});

	it("runs the bundled Python checker wrapper against a cached checker package", async () => {
		const cacheRoot = await writeCheckerBundle();
		const checkerRoot = join(cacheRoot, "datasets", "bfcl-v4");
		await writeSupportFile(
			checkerRoot,
			"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py",
			[
				"def multi_turn_checker(decoded, possible_answer, test_entry, category, model_name):",
				"    return {'valid': decoded and decoded[0] and decoded[0][0] == possible_answer[0], 'category': category}",
				"def multi_turn_irrelevance_checker(decoded, possible_answer):",
				"    return {'valid': True}",
				"",
			].join("\n"),
		);

		await expect(
			scoreBfclV4MultiTurn(
				task,
				{ model_output_trajectory: [[["cd(folder='document')"]]] },
				{ cacheRoot, timeoutMs: 1_000 },
			),
		).resolves.toMatchObject({
			details: { breakdown: { category: "multi_turn_base", valid: true } },
			passed: true,
			score: 1,
		});
	});

	it("surfaces checker subprocess failures and non-object responses", async () => {
		const cacheRoot = await writeCheckerBundle();
		const failScriptPath = join(cacheRoot, "fail.mjs");
		const arrayScriptPath = join(cacheRoot, "array.mjs");
		await writeFile(
			failScriptPath,
			"process.stderr.write('boom'); process.exit(2);",
		);
		await writeFile(arrayScriptPath, "console.log('[]');");
		const checkerRoot = join(cacheRoot, "datasets", "bfcl-v4");

		await expect(
			__bfclV4MultiTurnPrivateForTests.runChecker({
				checkerRoot,
				checkerScriptPath: failScriptPath,
				payload: {},
				pythonExecutable: process.execPath,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/exit 2/);
		await expect(
			__bfclV4MultiTurnPrivateForTests.runChecker({
				checkerRoot,
				checkerScriptPath: arrayScriptPath,
				payload: {},
				pythonExecutable: process.execPath,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/non-object/);

		await expect(
			__bfclV4MultiTurnPrivateForTests.runChecker({
				checkerRoot,
				checkerScriptPath: "unused",
				payload: {},
				pythonExecutable: join(cacheRoot, "missing-command"),
				timeoutMs: 1_000,
			}),
		).rejects.toThrow();
	});

	it("kills checker subprocesses that exceed the timeout", async () => {
		const cacheRoot = await writeCheckerBundle();
		const slowScriptPath = join(cacheRoot, "slow.mjs");
		await writeFile(slowScriptPath, "setTimeout(() => {}, 1_000);");

		await expect(
			__bfclV4MultiTurnPrivateForTests.runChecker({
				checkerRoot: join(cacheRoot, "datasets", "bfcl-v4"),
				checkerScriptPath: slowScriptPath,
				payload: {},
				pythonExecutable: process.execPath,
				timeoutMs: 5,
			}),
		).rejects.toThrow(/timed out/);
	});

	it("bounds checker output buffers", () => {
		expect(
			__bfclV4MultiTurnPrivateForTests.appendBounded("", Buffer.from("ok")),
		).toBe("ok");
		expect(
			__bfclV4MultiTurnPrivateForTests.appendBounded(
				"",
				Buffer.alloc(1024 * 1024 + 10, "x"),
			),
		).toHaveLength(1024 * 1024);
	});

	it("verifies checker bundle sha256 entries before running the official adapter", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-bfcl-checker-"));
		tempRoots.push(cacheRoot);
		const checkerRoot = join(cacheRoot, "datasets", "bfcl-v4");
		const relativePath =
			"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py";
		const filePath = join(checkerRoot, relativePath);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, "print('checker')\n", "utf8");
		await writeFile(
			join(checkerRoot, "manifest.json"),
			`${JSON.stringify({
				attachments: {
					[relativePath]: {
						sha256: "0".repeat(64),
						size_bytes: 17,
					},
				},
			})}\n`,
		);

		await expect(
			__bfclV4MultiTurnPrivateForTests.verifyCheckerBundle(checkerRoot),
		).rejects.toThrow(/sha256 mismatch|missing manifest entry/);

		const completeRoot = await writeCheckerBundle();
		const completeCheckerRoot = join(completeRoot, "datasets", "bfcl-v4");
		const manifestPath = join(completeCheckerRoot, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.attachments[
			"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py"
		].sha256 = "1".repeat(64);
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expect(
			__bfclV4MultiTurnPrivateForTests.verifyCheckerBundle(completeCheckerRoot),
		).rejects.toThrow(/sha256 mismatch/);
	});
});

async function writeCheckerBundle(): Promise<string> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "quilin-bfcl-checker-"));
	tempRoots.push(cacheRoot);
	const checkerRoot = join(cacheRoot, "datasets", "bfcl-v4");
	const attachments: Record<
		string,
		{ readonly sha256: string; readonly size_bytes: number }
	> = {};
	for (const relativePath of checkerSupportFiles()) {
		const filePath = join(checkerRoot, relativePath);
		const content = `# ${relativePath}\n`;
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf8");
		attachments[relativePath] = {
			sha256: sha256(content),
			size_bytes: Buffer.byteLength(content),
		};
	}
	await writeFile(
		join(checkerRoot, "manifest.json"),
		`${JSON.stringify({ attachments }, null, 2)}\n`,
	);
	return cacheRoot;
}

async function writeSupportFile(
	checkerRoot: string,
	relativePath: string,
	content: string,
): Promise<void> {
	const filePath = join(checkerRoot, relativePath);
	await writeFile(filePath, content, "utf8");
	const manifestPath = join(checkerRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.attachments[relativePath] = {
		sha256: sha256(content),
		size_bytes: Buffer.byteLength(content),
	};
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function checkerSupportFiles(): readonly string[] {
	return [
		"bfcl_eval/__init__.py",
		"bfcl_eval/constants/__init__.py",
		"bfcl_eval/constants/executable_backend_config.py",
		"bfcl_eval/eval_checker/__init__.py",
		"bfcl_eval/eval_checker/multi_turn_eval/__init__.py",
		"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py",
		"bfcl_eval/eval_checker/multi_turn_eval/multi_turn_utils.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/__init__.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/gorilla_file_system.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/long_context.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/math_api.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/message_api.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/posting_api.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/ticket_api.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/trading_bot.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/travel_booking.py",
		"bfcl_eval/eval_checker/multi_turn_eval/func_source_code/vehicle_control.py",
	];
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
