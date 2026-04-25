import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scorer } from "../scorers/index.js";
import type {
	BenchmarkCost,
	BenchmarkResult,
	BenchmarkRun,
	BenchmarkTask,
} from "../wire/index.js";

export type BenchmarkRunPhase =
	| "setup"
	| "agent_loop"
	| "collect"
	| "score"
	| "cleanup";

export interface BenchmarkSpanSnapshot {
	readonly name: string;
	readonly attributes: Readonly<Record<string, unknown>>;
}

export interface BenchmarkSpanProvider {
	readonly snapshot: () => readonly BenchmarkSpanSnapshot[];
	readonly clear?: () => void;
}

export interface BenchmarkAgentMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string;
}

export interface BenchmarkTool {
	readonly name?: string;
	readonly execute: (args: unknown) => Promise<unknown>;
	readonly [key: string]: unknown;
}

export interface BenchmarkAgentLoopRuntimeConfig {
	readonly tools?: readonly BenchmarkTool[];
	readonly benchmarks?: {
		readonly network_whitelist?: readonly string[];
	};
	readonly [key: string]: unknown;
}

export interface BenchmarkAgentLoopConfig
	extends BenchmarkAgentLoopRuntimeConfig {
	readonly observability?: {
		readonly spans?: BenchmarkSpanProvider;
		readonly sessionId?: string;
		readonly userId?: string;
		readonly taskSummary?: string;
	};
}

export interface BenchmarkScratchpad {
	readonly write?: (input: {
		readonly taskId: string;
		readonly sessionId: string;
		readonly key: string;
		readonly value: string;
	}) => Promise<void>;
	readonly clear?: (input: {
		readonly taskId: string;
		readonly sessionId: string;
	}) => Promise<void>;
}

export type BenchmarkScorer = Scorer;

export interface BenchmarkScorerRegistry {
	readonly get: (scorerType: string) => BenchmarkScorer;
}

export type AgentLoopRunner = (
	config: BenchmarkAgentLoopConfig,
	messages: readonly BenchmarkAgentMessage[],
) => Promise<string>;

export interface BenchmarkRunnerOptions {
	readonly agentLoopConfig: BenchmarkAgentLoopRuntimeConfig;
	readonly scorer?: BenchmarkScorer;
	readonly scorerRegistry?: BenchmarkScorerRegistry;
	readonly scratchpad?: BenchmarkScratchpad;
	readonly spans?: BenchmarkSpanProvider;
	readonly runAgent: AgentLoopRunner;
	readonly networkWhitelist?: readonly string[];
	readonly clock?: () => Date;
	readonly createRunId?: () => string;
	readonly tmpRoot?: string;
	readonly userId?: string;
}

export interface RunBenchmarkTaskOptions {
	readonly task: BenchmarkTask;
	readonly options: BenchmarkRunnerOptions;
}

export interface BenchmarkRunExecution {
	readonly run: BenchmarkRun;
	readonly result: BenchmarkResult;
	readonly phases: readonly BenchmarkRunPhase[];
	readonly workspaceDir: string;
}

export class BenchmarkRunError extends Error {
	constructor(
		readonly phase: BenchmarkRunPhase,
		message: string,
		readonly cause?: unknown,
	) {
		super(`${phase}: ${message}`);
		this.name = "BenchmarkRunError";
	}
}

const networkWhitelistStore = new AsyncLocalStorage<readonly string[]>();
const homePathPattern = /^~(?:\/|$)/;
const pathFieldNames = new Set([
	"cache_dir",
	"cwd",
	"dir",
	"directory",
	"file_path",
	"filepath",
	"output_dir",
	"output_path",
	"path",
	"repo_dir",
	"repo_path",
	"repo_workdir",
	"workdir",
	"working_directory",
]);
const pathFieldSuffixPattern = /_(?:path|dir|directory)$/;
const shellExecToolNames = new Set(["shell_exec", "shell-exec", "shellExec"]);
const windowsAbsolutePathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const shellPathTokenPattern =
	/^(?:~(?:\/|$)|\/|\.\.(?:\/|$)|[a-zA-Z]:[\\/]|\\\\)|[\\/]\\.\\.(?:[\\/]|$)/;
const fileUrlSchemePattern = /^file:\/\//i;
const remoteUrlSchemePattern = /^(?:https?|ftp|git|ssh):\/\//i;
const shortOptionPathValuePattern = /^-[A-Za-z](.+)$/;
const redirectPathValuePattern = /^(?:(?:\d+|&)?>>?|(?:\d+)?<<?)(.+)$/;
let guardedFetch: typeof globalThis.fetch | undefined;
let fetchGuardInstalled = false;

export async function runBenchmarkTask(
	input: RunBenchmarkTaskOptions,
): Promise<BenchmarkRunExecution> {
	const { task, options } = input;
	const runId = options.createRunId?.() ?? randomUUID();
	const sessionId = `benchmark:${runId}`;
	const phases: BenchmarkRunPhase[] = [];
	const clock = options.clock ?? (() => new Date());
	let workspaceDir = "";
	let output: Record<string, unknown> = {};
	let cost: BenchmarkCost = emptyCost();
	let latencyMs = 0;
	const startedAt = clock();

	try {
		phases.push("setup");
		workspaceDir = await setupTaskWorkspace({
			task,
			options,
			runId,
			sessionId,
		});

		phases.push("agent_loop");
		const loopOutput = await runAgentLoopForTask({
			task,
			options,
			runId,
			sessionId,
			workspaceDir,
		});

		phases.push("collect");
		output = collectOutput(loopOutput);
		const spans = options.spans?.snapshot() ?? [];
		cost = extractBenchmarkCost(spans);
		latencyMs = extractLatencyMs(spans, startedAt, clock());

		phases.push("score");
		const scorer = resolveScorer(options, task.scorer_type);
		const scoring = await scorer(task, output);

		phases.push("cleanup");
		await cleanupTaskWorkspace({ task, options, sessionId, workspaceDir });
		options.spans?.clear?.();

		const finishedAt = clock();
		return {
			run: {
				run_id: runId,
				task_id: task.task_id,
				agent_session_id: sessionId,
				started_at: startedAt.toISOString(),
				finished_at: finishedAt.toISOString(),
			},
			result: {
				run_id: runId,
				task_id: task.task_id,
				output,
				passed: scoring.passed,
				score: scoring.score,
				details: scoring.details,
				cost,
				latency_ms: latencyMs,
			},
			phases,
			workspaceDir,
		};
	} catch (error) {
		const phase = phases.at(-1) ?? "setup";
		await cleanupAfterFailure({
			task,
			options,
			sessionId,
			workspaceDir,
			phase,
		});
		throw error instanceof BenchmarkRunError
			? error
			: new BenchmarkRunError(phase, errorMessage(error), error);
	}
}

async function cleanupAfterFailure(input: {
	readonly task: BenchmarkTask;
	readonly options: BenchmarkRunnerOptions;
	readonly sessionId: string;
	readonly workspaceDir: string;
	readonly phase: BenchmarkRunPhase;
}): Promise<void> {
	if (input.phase === "cleanup" || input.workspaceDir.length === 0) {
		return;
	}

	try {
		await cleanupTaskWorkspace(input);
		input.options.spans?.clear?.();
	} catch {
		// Preserve the original phase error; cleanup failures are surfaced when
		// cleanup itself is the active phase.
	}
}

async function setupTaskWorkspace(input: {
	readonly task: BenchmarkTask;
	readonly options: BenchmarkRunnerOptions;
	readonly runId: string;
	readonly sessionId: string;
}): Promise<string> {
	return wrapPhase("setup", async () => {
		const workspaceDir = await mkdtemp(
			join(input.options.tmpRoot ?? tmpdir(), "quilin-benchmark-"),
		);
		try {
			await input.options.scratchpad?.write?.({
				taskId: input.task.task_id,
				sessionId: input.sessionId,
				key: "task",
				value: JSON.stringify(input.task),
			});
			return workspaceDir;
		} catch (error) {
			await rm(workspaceDir, { recursive: true, force: true });
			throw error;
		}
	});
}

async function runAgentLoopForTask(input: {
	readonly task: BenchmarkTask;
	readonly options: BenchmarkRunnerOptions;
	readonly runId: string;
	readonly sessionId: string;
	readonly workspaceDir: string;
}): Promise<string> {
	return wrapPhase("agent_loop", async () => {
		const run = resolveAgentRunner(input.options);
		const agentLoopConfig = createSandboxedAgentLoopConfig(
			input.options.agentLoopConfig,
			input.workspaceDir,
		);
		return run(
			{
				...agentLoopConfig,
				observability: {
					spans: input.options.spans,
					sessionId: input.sessionId,
					userId: input.options.userId ?? "benchmark",
					taskSummary: input.task.task_id,
				},
			},
			createTaskMessages(input.task, input.workspaceDir),
		);
	});
}

function collectOutput(loopOutput: string): Record<string, unknown> {
	return {
		patch: loopOutput,
	};
}

async function cleanupTaskWorkspace(input: {
	readonly task: BenchmarkTask;
	readonly options: BenchmarkRunnerOptions;
	readonly sessionId: string;
	readonly workspaceDir: string;
}): Promise<void> {
	await wrapPhase("cleanup", async () => {
		await input.options.scratchpad?.clear?.({
			taskId: input.task.task_id,
			sessionId: input.sessionId,
		});
		if (input.workspaceDir.length > 0) {
			await rm(input.workspaceDir, { recursive: true, force: true });
		}
	});
}

function createTaskMessages(
	task: BenchmarkTask,
	workspaceDir: string,
): BenchmarkAgentMessage[] {
	return [
		{
			role: "system",
			content:
				"You are running a benchmark task in an isolated workspace. Produce only the final patch diff.",
		},
		{
			role: "user",
			content: JSON.stringify({
				task_id: task.task_id,
				dataset: task.dataset,
				workspace_dir: workspaceDir,
				inputs: task.inputs,
			}),
		},
	];
}

function resolveAgentRunner(options: BenchmarkRunnerOptions): AgentLoopRunner {
	if (typeof options.runAgent === "function") {
		return async (config, messages) =>
			runWithNetworkWhitelist(resolveNetworkWhitelist(options), () =>
				options.runAgent(config, messages),
			);
	}
	throw new Error("Benchmark runner requires an injected runAgent");
}

function createSandboxedAgentLoopConfig(
	config: BenchmarkAgentLoopRuntimeConfig,
	workspaceDir: string,
): BenchmarkAgentLoopRuntimeConfig {
	if (config.tools == null) {
		return config;
	}

	return {
		...config,
		tools: config.tools.map((tool) => createSandboxedTool(tool, workspaceDir)),
	};
}

function createSandboxedTool(
	tool: BenchmarkTool,
	workspaceDir: string,
): BenchmarkTool {
	return {
		...tool,
		execute: async (args) =>
			tool.execute(sandboxToolArgs(tool, args, workspaceDir)),
	};
}

function sandboxToolArgs(
	tool: BenchmarkTool,
	args: unknown,
	workspaceDir: string,
): unknown {
	if (!isRecord(args)) {
		return args;
	}

	const next = cloneToolArg(args);
	if (!isRecord(next)) {
		return next;
	}

	if (isShellExecTool(tool) && typeof next.cwd !== "string") {
		next.cwd = workspaceDir;
	}
	assertContainedToolArgs(next, workspaceDir);

	if (isShellExecTool(tool) && typeof next.command === "string") {
		assertCommandContained(next.command, workspaceDir);
	}

	return next;
}

function cloneToolArg(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => cloneToolArg(entry));
	}
	if (!isRecord(value)) {
		return value;
	}

	const cloned: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		cloned[key] = cloneToolArg(nested);
	}
	return cloned;
}

function assertContainedToolArgs(
	args: Record<string, unknown>,
	workspaceDir: string,
): void {
	for (const [key, value] of Object.entries(args)) {
		assertContainedValue(key, value, workspaceDir);
	}
}

function assertContainedValue(
	key: string,
	value: unknown,
	workspaceDir: string,
): void {
	if (typeof value === "string" && isPathFieldName(key)) {
		assertPathContained(value, workspaceDir, key);
		return;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			assertContainedValue(key, entry, workspaceDir);
		}
		return;
	}

	if (isRecord(value)) {
		for (const [nestedKey, nestedValue] of Object.entries(value)) {
			assertContainedValue(nestedKey, nestedValue, workspaceDir);
		}
	}
}

function assertCommandContained(command: string, workspaceDir: string): void {
	for (const token of commandTokens(command)) {
		assertCommandTokenContained(token, workspaceDir);
	}
}

function commandTokens(command: string): string[] {
	return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
		(match) => match[1] ?? match[2] ?? match[3] ?? "",
	);
}

function assertCommandTokenContained(
	token: string,
	workspaceDir: string,
): void {
	const trimmed = token.trim();
	if (trimmed.length === 0) {
		return;
	}
	if (isFileUrlToken(trimmed)) {
		assertFileUrlContained(trimmed, workspaceDir);
		return;
	}
	if (isUrlToken(trimmed)) {
		return;
	}

	const redirectValue = redirectPathValue(trimmed);
	if (redirectValue !== undefined) {
		assertCommandPathValueContained(redirectValue, workspaceDir);
		return;
	}

	const assignmentValue = assignmentTokenValue(trimmed);
	if (assignmentValue !== undefined) {
		assertCommandPathValueContained(assignmentValue, workspaceDir);
		return;
	}

	const shortOptionValue = shortOptionPathValue(trimmed);
	if (shortOptionValue !== undefined) {
		assertCommandPathValueContained(shortOptionValue, workspaceDir);
		return;
	}

	if (isPathLikeCommandValue(trimmed)) {
		assertPathContained(trimmed, workspaceDir, "command");
	}
}

function assignmentTokenValue(token: string): string | undefined {
	const assignmentIndex = token.indexOf("=");
	if (assignmentIndex <= 0) {
		return undefined;
	}
	return token.slice(assignmentIndex + 1);
}

function redirectPathValue(token: string): string | undefined {
	const match = redirectPathValuePattern.exec(token);
	const value = match?.[1];
	return value != null && value.length > 0 ? value : undefined;
}

function shortOptionPathValue(token: string): string | undefined {
	if (token.startsWith("--")) {
		return undefined;
	}
	const match = shortOptionPathValuePattern.exec(token);
	const value = match?.[1];
	return value != null && isPathLikeCommandValue(value) ? value : undefined;
}

function assertCommandPathValueContained(
	value: string,
	workspaceDir: string,
): void {
	const normalized = stripMatchingQuotes(value.trim());
	if (normalized.length === 0) {
		return;
	}
	if (isFileUrlToken(normalized)) {
		assertFileUrlContained(normalized, workspaceDir);
		return;
	}
	if (isUrlToken(normalized)) {
		return;
	}
	if (isPathLikeCommandValue(normalized)) {
		assertPathContained(normalized, workspaceDir, "command");
	}
}

function stripMatchingQuotes(value: string): string {
	const first = value.at(0);
	const last = value.at(-1);
	if (
		value.length >= 2 &&
		((first === '"' && last === '"') || (first === "'" && last === "'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function assertPathContained(
	value: string,
	workspaceDir: string,
	fieldName: string,
): void {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return;
	}
	if (homePathPattern.test(trimmed)) {
		throw new Error(
			`Benchmark sandbox blocked path outside workspace: ${fieldName}`,
		);
	}
	if (windowsAbsolutePathPattern.test(trimmed)) {
		throw new Error(
			`Benchmark sandbox blocked path outside workspace: ${fieldName}`,
		);
	}

	const workspaceRoot = resolve(workspaceDir);
	const candidate = isAbsolute(trimmed)
		? resolve(trimmed)
		: resolve(workspaceRoot, trimmed);
	if (!isInsidePath(workspaceRoot, candidate)) {
		throw new Error(
			`Benchmark sandbox blocked path outside workspace: ${fieldName}`,
		);
	}

	assertRealPathContained(workspaceRoot, candidate, fieldName);
}

function assertFileUrlContained(value: string, workspaceDir: string): void {
	let filePath: string;
	try {
		filePath = fileURLToPath(value);
	} catch {
		throw new Error("Benchmark sandbox blocked malformed file URL: command");
	}
	assertPathContained(filePath, workspaceDir, "command");
}

function isInsidePath(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	);
}

function isPathFieldName(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		pathFieldNames.has(normalized) || pathFieldSuffixPattern.test(normalized)
	);
}

function isPathLikeCommandValue(value: string): boolean {
	return (
		!isUrlToken(value) &&
		(hasPathSeparator(value) || shellPathTokenPattern.test(value))
	);
}

function hasPathSeparator(value: string): boolean {
	return value.includes("/") || value.includes("\\");
}

function isUrlToken(value: string): boolean {
	return remoteUrlSchemePattern.test(value);
}

function isFileUrlToken(value: string): boolean {
	return fileUrlSchemePattern.test(value);
}

function isShellExecTool(tool: BenchmarkTool): boolean {
	return typeof tool.name === "string" && shellExecToolNames.has(tool.name);
}

function assertRealPathContained(
	workspaceRoot: string,
	candidate: string,
	fieldName: string,
): void {
	const realWorkspaceRoot = realpathSync.native(workspaceRoot);
	const existingPath = nearestExistingPath(candidate, workspaceRoot);

	let realExistingPath: string;
	try {
		realExistingPath = realpathSync.native(existingPath);
	} catch (error) {
		throw new Error(
			`Benchmark sandbox blocked unresolved path: ${fieldName} (${errorMessage(error)})`,
		);
	}

	if (!isInsidePath(realWorkspaceRoot, realExistingPath)) {
		throw new Error(
			`Benchmark sandbox blocked path outside workspace: ${fieldName}`,
		);
	}
}

function nearestExistingPath(candidate: string, workspaceRoot: string): string {
	let current = candidate;
	while (true) {
		try {
			lstatSync(current);
			return current;
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}

		const parent = dirname(current);
		if (!isInsidePath(workspaceRoot, parent)) {
			return workspaceRoot;
		}
		current = parent;
	}
}

async function runWithNetworkWhitelist<T>(
	whitelist: readonly string[] | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	if (whitelist === undefined) {
		return operation();
	}
	installFetchGuard();
	return networkWhitelistStore.run(whitelist, operation);
}

function installFetchGuard(): void {
	if (fetchGuardInstalled && globalThis.fetch === guardedFetch) {
		return;
	}
	if (typeof globalThis.fetch !== "function") {
		throw new Error("Benchmark network whitelist requires global fetch");
	}

	const fetchImpl = globalThis.fetch.bind(
		globalThis,
	) as typeof globalThis.fetch;
	guardedFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
		const whitelist = networkWhitelistStore.getStore();
		if (whitelist !== undefined) {
			assertFetchAllowed(args[0], whitelist);
		}
		return fetchImpl(...args);
	}) as typeof globalThis.fetch;
	globalThis.fetch = guardedFetch;
	fetchGuardInstalled = true;
}

function assertFetchAllowed(
	input: Parameters<typeof globalThis.fetch>[0],
	whitelist: readonly string[],
): void {
	const url = fetchUrl(input);
	if (!whitelist.some((entry) => matchesAllowedTarget(url, entry))) {
		throw new Error(`Benchmark network blocked outbound fetch: ${url.origin}`);
	}
}

function fetchUrl(input: Parameters<typeof globalThis.fetch>[0]): URL {
	if (typeof input === "string" || input instanceof URL) {
		return new URL(input);
	}
	const value = input as { readonly url?: unknown };
	if (typeof value.url === "string") {
		return new URL(value.url);
	}
	throw new Error("Benchmark network whitelist could not inspect fetch URL");
}

function matchesAllowedTarget(url: URL, entry: string): boolean {
	const target = entry.trim();
	if (target.length === 0) {
		return false;
	}
	if (target.includes("://")) {
		return url.origin === new URL(target).origin;
	}
	return url.host === target || url.hostname === target;
}

function resolveNetworkWhitelist(
	options: BenchmarkRunnerOptions,
): readonly string[] | undefined {
	return (
		options.networkWhitelist ??
		options.agentLoopConfig.benchmarks?.network_whitelist
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
	return (
		error != null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function resolveScorer(
	options: BenchmarkRunnerOptions,
	scorerType: string,
): BenchmarkScorer {
	if (options.scorer != null) {
		return options.scorer;
	}
	if (options.scorerRegistry != null) {
		return options.scorerRegistry.get(scorerType);
	}
	throw new Error("Benchmark runner requires a scorer or scorerRegistry");
}

export function extractBenchmarkCost(
	spans: readonly BenchmarkSpanSnapshot[],
): BenchmarkCost {
	let inputTokens = 0;
	let outputTokens = 0;
	let thinkingTokens = 0;
	let llmCostUsd = 0;
	let turnCostUsd = 0;
	const perModelUsd: Record<string, number> = {};

	for (const span of spans) {
		const attributes = span.attributes;
		if (span.name === "agent.turn") {
			turnCostUsd += numberAttribute(attributes, "turn.cost_usd");
		}
		if (span.name !== "llm.invoke") {
			continue;
		}
		const model = stringAttribute(attributes, "llm.model") ?? "unknown";
		const modelCost = numberAttribute(attributes, "llm.cost_usd");
		inputTokens += numberAttribute(attributes, "llm.tokens_input");
		outputTokens += numberAttribute(attributes, "llm.tokens_output");
		thinkingTokens += numberAttribute(attributes, "llm.tokens_thinking");
		llmCostUsd += modelCost;
		perModelUsd[model] = (perModelUsd[model] ?? 0) + modelCost;
	}

	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		thinking_tokens: thinkingTokens,
		total_usd: turnCostUsd > 0 ? turnCostUsd : llmCostUsd,
		per_model_usd: perModelUsd,
	};
}

function extractLatencyMs(
	spans: readonly BenchmarkSpanSnapshot[],
	startedAt: Date,
	finishedAt: Date,
): number {
	const llmLatency = spans
		.filter((span) => span.name === "llm.invoke")
		.reduce(
			(total, span) =>
				total + numberAttribute(span.attributes, "llm.total_latency_ms"),
			0,
		);
	return llmLatency > 0
		? llmLatency
		: finishedAt.getTime() - startedAt.getTime();
}

function emptyCost(): BenchmarkCost {
	return {
		input_tokens: 0,
		output_tokens: 0,
		thinking_tokens: 0,
		total_usd: 0,
		per_model_usd: {},
	};
}

async function wrapPhase<T>(
	phase: BenchmarkRunPhase,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw new BenchmarkRunError(phase, errorMessage(error), error);
	}
}

function numberAttribute(
	attributes: Readonly<Record<string, unknown>>,
	key: string,
): number {
	const value = attributes[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringAttribute(
	attributes: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = attributes[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "benchmark run failed";
}
