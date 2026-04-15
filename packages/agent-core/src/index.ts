import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";
import { createProvider, getDefaultModel } from "./llm/provider.js";
import { configureLogger, logger } from "./logger.js";
import { startRepl } from "./repl.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import { MCPClientManager } from "./tools/mcp-client.js";

export * from "./context/manager.js";
export * from "./llm/client.js";
export * from "./llm/provider.js";
export * from "./repl.js";
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

function getTokenCount(
	usage:
		| {
				promptTokens?: number;
				completionTokens?: number;
				inputTokens?: number;
				outputTokens?: number;
		  }
		| undefined,
	key: "input" | "output",
) {
	if (key === "input") {
		return usage?.promptTokens ?? usage?.inputTokens ?? 0;
	}

	return usage?.completionTokens ?? usage?.outputTokens ?? 0;
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

	logger.info({ version: "0.0.1" }, "Quilin Agent starting");

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
			maxTokens: 20,
		});

		logger.info(
			{
				response: text.trim(),
				inputTokens: getTokenCount(usage, "input"),
				outputTokens: getTokenCount(usage, "output"),
			},
			"LLM connection verified",
		);
	} catch (err) {
		logger.fatal({ err }, "LLM connection failed");
		process.exit(1);
	}

	if (runtimeMode === "repl") {
		const mcpClient = new MCPClientManager();
		const workspaceRoot = findWorkspaceRoot(
			dirname(fileURLToPath(import.meta.url)),
		);
		const sessionId = await resolveReplSessionId();
		let shouldExit = false;

		logger.info({ mode: "repl" }, "Starting CLI REPL...");

		try {
			logger.info("Connecting OmniMem MCP server...");
			const tools = await mcpClient.connect({
				command: "uv",
				args: ["run", "python", "-m", "omnimem"],
				cwd: join(workspaceRoot, "providers", "memory"),
			});
			logger.info({ toolCount: tools.length }, "OmniMem MCP connected");

			await startRepl({
				provider,
				modelId,
				...(sessionId == null ? {} : { sessionId }),
				tools,
			});
			shouldExit = true;
		} finally {
			await mcpClient.disconnect().catch((err) => {
				logger.warn({ err }, "OmniMem MCP disconnect failed");
			});
		}

		if (shouldExit) {
			process.exit(0);
			return;
		}
	}

	logger.info({ mode: "service" }, "Starting agent-core service loop...");
	await (options.serviceRunner ?? runServiceLoop)();
}

if (import.meta.main) {
	main().catch((err) => {
		logger.fatal({ err }, "Unexpected error");
		process.exit(1);
	});
}
