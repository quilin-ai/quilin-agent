import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";
import { runConfigCommand } from "./cli/config-cmd.js";
import {
	buildCapabilitiesRuntime,
	loadCapabilitiesConfig,
} from "./config/loader.js";
import { bootstrapUserRuntime } from "./config/runtime.js";
import { createProvider, getDefaultModel } from "./llm/provider.js";
import { normalizeTokenUsage } from "./llm/token-usage.js";
import { configureLogger, logger } from "./logger.js";
import { JsonFileSpanExporter } from "./observability/exporters/json-file.js";
import { startRepl } from "./repl.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";

export * from "./context/index.js";
export * from "./llm/client.js";
export * from "./llm/provider.js";
export * from "./memory/index.js";
export { runAgentLoop } from "./loop.js";
export type { AgentLoopConfig, LoopHooks } from "./loop-types.js";
export {
	applyEvent,
	type BudgetLedger,
	type Checkpoint as PlanningCheckpoint,
	type CheckpointFailedPayload,
	createPlanningState,
	type PlanningEvent,
	type PlanningState,
	type PlanPhase,
} from "./planning/state.js";
export type {
	ClarificationRequest,
	DagPlan,
	Intent,
	IntentClassification,
	IntentClassifier,
	LinearPlan,
	LLMPlannerResponse,
	MemoryWriteScope,
	Plan,
	PlannerAudit,
	RiskLevel,
	SubTask,
} from "./planning/types.js";
export * from "./repl.js";
export * from "./safety/write-authority.js";
export * from "./state/checkpoint.js";
export * from "./tools/mcp-client.js";
export * from "./tools/router.js";
export * from "./types/index.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

export type RuntimeMode = "repl" | "service";

export interface MainOptions {
	readonly runtimeMode?: RuntimeMode;
	readonly serviceRunner?: () => Promise<void>;
}

interface ReplCliOptions {
	readonly sessionId?: string;
	readonly resumeLatest: boolean;
}

function findWorkspaceRoot(startDir: string): string {
	let currentDir = startDir;

	while (true) {
		if (existsSync(join(currentDir, "pnpm-workspace.yaml"))) {
			return currentDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			throw new Error("Could not find workspace root");
		}

		currentDir = parentDir;
	}
}

function resolveRuntimeMode(runtimeMode?: RuntimeMode): RuntimeMode {
	if (runtimeMode) {
		return runtimeMode;
	}

	const modeFromEnv = process.env.QUILIN_RUNTIME_MODE;
	if (modeFromEnv === "repl" || modeFromEnv === "service") {
		return modeFromEnv;
	}

	return process.stdin.isTTY && process.stderr.isTTY ? "repl" : "service";
}

function parseReplCliOptions(argv: readonly string[]): ReplCliOptions {
	let sessionId: string | undefined;
	let resumeLatest = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--resume") {
			const nextArg = argv[index + 1];
			if (nextArg == null || nextArg.startsWith("--")) {
				throw new Error("--resume requires a sessionId");
			}

			sessionId = nextArg;
			index += 1;
			continue;
		}

		if (arg === "--resume-latest") {
			resumeLatest = true;
		}
	}

	return { sessionId, resumeLatest };
}

async function resolveReplSessionId(
	argv: readonly string[] = process.argv.slice(2),
): Promise<string | undefined> {
	const cliOptions = parseReplCliOptions(argv);
	if (cliOptions.sessionId != null) {
		return cliOptions.sessionId;
	}

	if (!cliOptions.resumeLatest) {
		return undefined;
	}

	const sessionId = (await new SQLiteCheckpoint().list())[0];
	if (sessionId == null) {
		logger.warn("No saved sessions found — starting a new session");
		return undefined;
	}

	return sessionId;
}

async function runServiceLoop(): Promise<void> {
	await new Promise<void>(() => {
		setInterval(() => {
			logger.debug("agent-core heartbeat");
		}, HEARTBEAT_INTERVAL_MS);
	});
}

export async function main(options: MainOptions = {}): Promise<void> {
	const runtimeMode = resolveRuntimeMode(options.runtimeMode);
	configureLogger(runtimeMode);

	const userRuntime = await bootstrapUserRuntime();
	logger.info(
		{
			version: "0.0.1",
			user_config: {
				file_path: userRuntime.result.filePath,
				log_level: userRuntime.result.config.observability.log_level,
				default_model: userRuntime.result.config.llm.default_model,
				safety_trust: userRuntime.result.config.safety.trust_mode,
			},
		},
		"Quilin Agent starting",
	);

	const provider = createProvider();
	const modelId = getDefaultModel();

	logger.info(
		{ provider: "deepseek", model: modelId },
		"LLM provider initialized",
	);

	logger.info("Verifying LLM connection...");

	try {
		const { text, usage } = await generateText({
			model: provider(modelId),
			prompt: 'Reply with exactly: "Quilin Agent online." Nothing else.',
			maxOutputTokens: 20,
		});
		const normalizedUsage = normalizeTokenUsage(usage);

		logger.info(
			{
				response: text.trim(),
				inputTokens: normalizedUsage.inputTokens,
				outputTokens: normalizedUsage.outputTokens,
			},
			"LLM connection verified",
		);
	} catch (err) {
		logger.fatal({ err }, "LLM connection failed");
		process.exit(1);
	}

	if (runtimeMode === "repl") {
		const workspaceRoot = findWorkspaceRoot(
			dirname(fileURLToPath(import.meta.url)),
		);
		const loadedCapabilities = await loadCapabilitiesConfig({
			workspaceRoot,
			argv: process.argv.slice(2),
			env: process.env,
		});
		const capabilitiesRuntime = buildCapabilitiesRuntime(loadedCapabilities);
		const sessionId = await resolveReplSessionId();
		let shouldExit = false;

		logger.info({ mode: "repl" }, "Starting CLI REPL...");

		await startRepl({
			provider,
			modelId,
			...(sessionId == null ? {} : { sessionId }),
			observability: {
				spans: userRuntime.spanProvider,
				...(sessionId == null ? {} : { sessionId }),
			},
			spanExporter: new JsonFileSpanExporter(),
			mcpServers: capabilitiesRuntime.mcpServers,
			...(capabilitiesRuntime.skillsManager == null
				? {}
				: { skillsManager: capabilitiesRuntime.skillsManager }),
		});
		shouldExit = true;

		if (shouldExit) {
			process.exit(0);
			return;
		}
	}

	logger.info({ mode: "service" }, "Starting agent-core service loop...");
	await (options.serviceRunner ?? runServiceLoop)();
}

async function dispatchCli(argv: readonly string[]): Promise<void> {
	if (argv[0] === "config") {
		const result = await runConfigCommand(argv.slice(1));
		if (result.stdout.length > 0) {
			process.stdout.write(result.stdout);
		}
		if (result.stderr.length > 0) {
			process.stderr.write(result.stderr);
		}
		process.exit(result.exitCode);
	}
	await main();
}

if (import.meta.main) {
	dispatchCli(process.argv.slice(2)).catch((err) => {
		logger.fatal({ err }, "Unexpected error");
		process.exit(1);
	});
}
