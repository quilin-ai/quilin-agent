import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

interface McpProviderConfig {
	readonly name: string;
	readonly providerSubdir: string;
	readonly command: string;
	readonly args: readonly string[];
}

interface SpawnDeps {
	readonly spawnFn: typeof spawn;
	readonly existsFn: (path: string) => boolean;
}

const defaultDeps: SpawnDeps = {
	spawnFn: spawn,
	existsFn: existsSync,
};

class McpProviderRunner {
	private process: ChildProcess | null = null;

	constructor(
		private readonly cfg: McpProviderConfig,
		private readonly deps: SpawnDeps = defaultDeps,
	) {}

	isRunning(): boolean {
		return this.process != null && this.process.exitCode == null;
	}

	start(workspaceRoot: string): void {
		if (this.isRunning()) {
			logger.info(`${this.cfg.name} MCP already running`);
			return;
		}

		const cwd = join(workspaceRoot, this.cfg.providerSubdir);
		if (!this.deps.existsFn(cwd)) {
			logger.warn(
				{ cwd },
				`${this.cfg.name} MCP provider directory not found`,
			);
			return;
		}

		const env: NodeJS.ProcessEnv = { ...process.env };
		if (env.QUILIN_ENV == null) {
			env.QUILIN_ENV = env.NODE_ENV ?? "development";
		}

		const child = this.deps.spawnFn(this.cfg.command, [...this.cfg.args], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		child.on("exit", (code, signal) => {
			logger.info(
				{ code, signal, pid: child.pid },
				`${this.cfg.name} MCP process exited`,
			);
			this.process = null;
		});

		child.on("error", (err) => {
			logger.error(
				{ error: err.message, pid: child.pid },
				`${this.cfg.name} MCP process error`,
			);
			this.process = null;
		});

		child.stderr?.on("data", (data: Buffer) => {
			const trimmed = data.toString().trim();
			if (trimmed.length > 0) {
				logger.debug({ stderr: trimmed }, `${this.cfg.name} MCP stderr`);
			}
		});

		logger.info({ pid: child.pid, cwd }, `${this.cfg.name} MCP started`);
	}

	stop(): void {
		if (!this.isRunning() || this.process == null) {
			return;
		}

		const child = this.process;
		// Keep this.process set while the process may still be alive — null it
		// only after SIGKILL to avoid a race where a concurrent start() sees
		// it as not running during the 5-second grace period and spawns a
		// duplicate.

		child.on("exit", () => {
			logger.info(`${this.cfg.name} MCP stopped`);
		});

		child.kill("SIGTERM");

		setTimeout(() => {
			if (child.exitCode == null && !child.killed) {
				child.kill("SIGKILL");
				this.process = null;
			}
		}, 5000);
	}
}

const QUILIN_MEM_CFG: McpProviderConfig = {
	name: "quilin-mem",
	providerSubdir: join("providers", "memory"),
	command: "uv",
	args: ["run", "python", "-m", "quilin_mem"],
};

const QUILIN_WEB_CFG: McpProviderConfig = {
	name: "quilin-web",
	providerSubdir: join("providers", "web"),
	command: "uv",
	args: ["run", "python", "-m", "quilin_web"],
};

let memRunner = new McpProviderRunner(QUILIN_MEM_CFG);
let webRunner = new McpProviderRunner(QUILIN_WEB_CFG);

/** Test-only: replace runners with deps-injected versions for unit testing. */
export function __test_replaceRunners(deps: SpawnDeps): void {
	memRunner = new McpProviderRunner(QUILIN_MEM_CFG, deps);
	webRunner = new McpProviderRunner(QUILIN_WEB_CFG, deps);
}

/** Test-only: reset runners to default (production) deps. */
export function __test_resetRunners(): void {
	memRunner = new McpProviderRunner(QUILIN_MEM_CFG);
	webRunner = new McpProviderRunner(QUILIN_WEB_CFG);
}

export function isQuilinMemMcpRunning(): boolean {
	return memRunner.isRunning();
}

/**
 * Spawns the quilin-mem MCP server as a child process. Provider directory
 * is `<workspaceRoot>/providers/memory`; command is `uv run python -m
 * quilin_mem`. No-op if already running. If the provider directory is
 * missing, logs a warning and returns silently.
 */
export function startQuilinMemMcp(workspaceRoot: string): void {
	memRunner.start(workspaceRoot);
}

/**
 * Gracefully stops the quilin-mem MCP server. SIGTERM, escalating to
 * SIGKILL after a 5-second grace period.
 */
export function stopQuilinMemMcp(): void {
	memRunner.stop();
}

export function isQuilinWebMcpRunning(): boolean {
	return webRunner.isRunning();
}

/**
 * Spawns the quilin-web MCP server as a child process. Provider directory
 * is `<workspaceRoot>/providers/web`; command is `uv run python -m
 * quilin_web`. No-op if already running. If the provider directory is
 * missing, logs a warning and returns silently — supports environments
 * where the optional Crawl4AI extra is not installed.
 */
export function startQuilinWebMcp(workspaceRoot: string): void {
	webRunner.start(workspaceRoot);
}

/**
 * Gracefully stops the quilin-web MCP server. SIGTERM, escalating to
 * SIGKILL after a 5-second grace period.
 */
export function stopQuilinWebMcp(): void {
	webRunner.stop();
}
