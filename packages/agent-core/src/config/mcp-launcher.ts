import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

let quilinMemProcess: ChildProcess | null = null;

/**
 * Returns true when a quilin-mem MCP child process has been launched by this
 * module and has not yet exited.
 */
export function isQuilinMemMcpRunning(): boolean {
	return quilinMemProcess != null && quilinMemProcess.exitCode == null;
}

/**
 * Spawns the quilin-mem MCP server as a child process so it follows the
 * lifecycle of the main agent-core entrypoint.  When the process is already
 * running (launched by a previous call) this is a no-op.
 *
 * The child process is started with:
 *   uv run python -m quilin_mem
 * from <workspaceRoot>/providers/memory.
 *
 * The environment inherits from the current process and sets QUILIN_ENV when
 * it is not already present, falling back to NODE_ENV or "development".
 */
export function startQuilinMemMcp(workspaceRoot: string): void {
	if (isQuilinMemMcpRunning()) {
		logger.info("quilin-mem MCP already running");
		return;
	}

	const cwd = join(workspaceRoot, "providers", "memory");
	if (!existsSync(cwd)) {
		logger.warn({ cwd }, "quilin-mem MCP provider directory not found");
		return;
	}

	const env: NodeJS.ProcessEnv = { ...process.env };
	if (env.QUILIN_ENV == null) {
		env.QUILIN_ENV = env.NODE_ENV ?? "development";
	}

	quilinMemProcess = spawn("uv", ["run", "python", "-m", "quilin_mem"], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	quilinMemProcess.on("exit", (code, signal) => {
		logger.info(
			{ code, signal, pid: quilinMemProcess?.pid },
			"quilin-mem MCP process exited",
		);
		quilinMemProcess = null;
	});

	quilinMemProcess.on("error", (err) => {
		logger.error(
			{ error: err.message, pid: quilinMemProcess?.pid },
			"quilin-mem MCP process error",
		);
		quilinMemProcess = null;
	});

	quilinMemProcess.stderr?.on("data", (data: Buffer) => {
		const trimmed = data.toString().trim();
		if (trimmed.length > 0) {
			logger.debug({ stderr: trimmed }, "quilin-mem MCP stderr");
		}
	});

	logger.info(
		{ pid: quilinMemProcess.pid, cwd },
		"quilin-mem MCP started",
	);
}

/**
 * Gracefully stops the quilin-mem MCP server process.
 *
 * Sends SIGTERM first, then escalates to SIGKILL after a 5-second grace
 * period if the process has not yet exited.
 */
export function stopQuilinMemMcp(): void {
	if (!isQuilinMemMcpRunning() || quilinMemProcess == null) {
		return;
	}

	const child = quilinMemProcess;
	// Keep quilinMemProcess set while the process may still be
	// alive — null it only after SIGKILL to avoid a race where
	// startQuilinMemMcp() sees it as not running during the
	// 5-second grace period and spawns a duplicate.

	child.on("exit", () => {
		logger.info("quilin-mem MCP stopped");
	});

	child.kill("SIGTERM");

	setTimeout(() => {
		if (child.exitCode == null && !child.killed) {
			child.kill("SIGKILL");
			quilinMemProcess = null;
		}
	}, 5000);
}
