import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkTask } from "../wire/task.js";
import type { Scorer, ScorerResult } from "./types.js";

export const BFCL_V4_MULTI_TURN_SCORER_TYPE = "bfcl-v4-multi-turn";

export interface BfclV4MultiTurnScorerOptions {
	readonly cacheRoot?: string;
	readonly checkerScriptPath?: string;
	readonly pythonExecutable?: string;
	readonly spawnChecker?: BfclCheckerProcess;
	readonly timeoutMs?: number;
}

type BfclCheckerProcess = (input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly stdin: string;
	readonly timeoutMs: number;
}) => Promise<{ readonly stdout: string; readonly stderr: string }>;

type CheckerResponse = {
	readonly score?: unknown;
	readonly valid?: unknown;
	readonly breakdown?: unknown;
};

const DEFAULT_CHECKER_TIMEOUT_MS = 10_000;
const MAX_CHECKER_OUTPUT_BYTES = 1024 * 1024;
const checkerSupportFiles = [
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
] as const;

export const bfclV4MultiTurnScorer: Scorer = async (task, output) =>
	scoreBfclV4MultiTurn(task, output);

export async function scoreBfclV4MultiTurn(
	task: BenchmarkTask,
	output: Record<string, unknown>,
	options: BfclV4MultiTurnScorerOptions = {},
): Promise<ScorerResult> {
	const category = readString(
		task.metadata?.category ?? task.expected.category,
	);
	const trajectory =
		output.model_output_trajectory ?? output.trajectory ?? output.result;
	if (!Array.isArray(trajectory)) {
		return failedResult("missing_model_output_trajectory", { category });
	}
	const possibleAnswer = task.expected.possible_answer;
	if (!Array.isArray(possibleAnswer)) {
		return failedResult("missing_possible_answer", { category });
	}
	const checkerRoot = resolve(
		options.cacheRoot ?? ".benchmarks",
		"datasets",
		"bfcl-v4",
	);
	const payload = {
		model_output_trajectory: trajectory,
		task,
	};
	const response = await runChecker({
		checkerRoot,
		checkerScriptPath: options.checkerScriptPath,
		payload,
		pythonExecutable: options.pythonExecutable,
		spawnChecker: options.spawnChecker,
		timeoutMs: options.timeoutMs ?? DEFAULT_CHECKER_TIMEOUT_MS,
	});
	const passed = response.valid === true || response.score === 1;
	const score = normalizeScore(response.score, passed);
	return {
		details: {
			breakdown: response.breakdown ?? {},
			category,
			scorer_type: BFCL_V4_MULTI_TURN_SCORER_TYPE,
		},
		passed,
		score,
	};
}

async function runChecker(input: {
	readonly checkerRoot: string;
	readonly checkerScriptPath?: string;
	readonly payload: unknown;
	readonly pythonExecutable?: string;
	readonly spawnChecker?: BfclCheckerProcess;
	readonly timeoutMs: number;
}): Promise<CheckerResponse> {
	const checkerScriptPath =
		input.checkerScriptPath ?? defaultCheckerScriptPath();
	const pythonExecutable = input.pythonExecutable ?? "python3";
	const stdin = `${JSON.stringify(input.payload)}\n`;
	const spawnChecker = input.spawnChecker ?? spawnCheckerProcess;
	if (input.spawnChecker == null) {
		await verifyCheckerBundle(input.checkerRoot);
	}
	const { stdout } = await spawnChecker({
		args: [checkerScriptPath],
		command: pythonExecutable,
		env: {
			BFCL_CHECKER_ROOT: input.checkerRoot,
		},
		stdin,
		timeoutMs: input.timeoutMs,
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`BFCL multi-turn checker returned invalid JSON: ${error}`);
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("BFCL multi-turn checker returned a non-object response");
	}
	return parsed as CheckerResponse;
}

async function verifyCheckerBundle(checkerRoot: string): Promise<void> {
	const manifestPath = resolve(checkerRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		readonly attachments?: Record<
			string,
			{ readonly sha256?: unknown; readonly size_bytes?: unknown }
		>;
	};
	for (const relativePath of checkerSupportFiles) {
		const entry = manifest.attachments?.[relativePath];
		if (
			entry == null ||
			typeof entry.sha256 !== "string" ||
			typeof entry.size_bytes !== "number"
		) {
			throw new Error(
				`BFCL checker bundle missing manifest entry: ${relativePath}`,
			);
		}
		const file = await readFile(resolve(checkerRoot, relativePath));
		if (
			computeSha256(file) !== entry.sha256 ||
			file.byteLength !== entry.size_bytes
		) {
			throw new Error(`BFCL checker bundle sha256 mismatch: ${relativePath}`);
		}
	}
}

function spawnCheckerProcess(input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly stdin: string;
	readonly timeoutMs: number;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(input.command, [...input.args], {
			env: { ...process.env, ...input.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				child.kill("SIGKILL");
				settled = true;
				reject(new Error("BFCL multi-turn checker timed out"));
			}
		}, input.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk);
		});
		child.on("error", (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});
		child.on("close", (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new Error(
						`BFCL multi-turn checker failed with exit ${code}: ${stderr}`,
					),
				);
				return;
			}
			resolvePromise({ stderr, stdout });
		});
		child.stdin.end(input.stdin);
	});
}

function appendBounded(current: string, chunk: Buffer): string {
	const next = current + chunk.toString("utf8");
	if (Buffer.byteLength(next, "utf8") <= MAX_CHECKER_OUTPUT_BYTES) {
		return next;
	}
	return next.slice(0, MAX_CHECKER_OUTPUT_BYTES);
}

function computeSha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function normalizeScore(value: unknown, passed: boolean): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.min(1, value));
	}
	return passed ? 1 : 0;
}

function failedResult(
	reason: string,
	details: Record<string, unknown>,
): ScorerResult {
	return {
		details: {
			...details,
			reason,
			scorer_type: BFCL_V4_MULTI_TURN_SCORER_TYPE,
		},
		passed: false,
		score: 0,
	};
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function defaultCheckerScriptPath(): string {
	return resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../scripts/bfcl-multi-turn-checker.py",
	);
}

export const __privateForTests = {
	appendBounded,
	runChecker,
	verifyCheckerBundle,
} as const;
