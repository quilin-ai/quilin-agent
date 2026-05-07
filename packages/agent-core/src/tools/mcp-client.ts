import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
	getLoggerRuntimeMode,
	type LoggerRuntimeMode,
	logger,
} from "../logger.js";
import { createMCPRequestMetadata } from "../observability/context.js";
import { jsonSchemaToZod } from "./schema-converter.js";
import {
	sanitizeMCPToolDescription,
	sanitizeMCPToolName,
} from "./tool-sanitizer.js";
import type { Tool } from "./types.js";

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
const ALLOWED_PATH_COMMANDS = new Set([
	"bun",
	"node",
	"npx",
	"python",
	"python3",
	"uv",
]);
const ALLOWED_ABSOLUTE_COMMANDS = new Set([
	"/usr/bin/bun",
	"/usr/bin/node",
	"/usr/bin/npx",
	"/usr/bin/python",
	"/usr/bin/python3",
	"/usr/bin/uv",
	"/usr/local/bin/bun",
	"/usr/local/bin/node",
	"/usr/local/bin/npx",
	"/usr/local/bin/python",
	"/usr/local/bin/python3",
	"/usr/local/bin/uv",
	"/opt/homebrew/bin/bun",
	"/opt/homebrew/bin/node",
	"/opt/homebrew/bin/npx",
	"/opt/homebrew/bin/python",
	"/opt/homebrew/bin/python3",
	"/opt/homebrew/bin/uv",
	resolve(homedir(), ".bun", "bin", "bun"),
	resolve(homedir(), ".local", "bin", "uv"),
	resolve(process.execPath),
	resolve(process.execPath.replace(/node(?:\.exe)?$/i, "npx")),
]);
const DISALLOWED_SHELL_EXECUTABLES = new Set([
	"bash",
	"cmd",
	"cmd.exe",
	"dash",
	"fish",
	"powershell",
	"pwsh",
	"sh",
	"zsh",
]);
const DISALLOWED_SHELL_ARGS = new Set([
	"-c",
	"-command",
	"-encodedcommand",
	"-lc",
	"/c",
	"/k",
]);
const CLIENT_INFO = {
	name: "quilin-agent-core",
	version: "0.0.1",
};

export class MCPTimeoutError extends Error {
	readonly label: string;
	readonly timeoutMs: number;

	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs}ms`);
		this.name = "MCPTimeoutError";
		this.label = label;
		this.timeoutMs = timeoutMs;
	}
}

interface MCPToolCallResult {
	readonly content: string;
	readonly isError: boolean;
}

type MCPConnectionState = "idle" | "connecting" | "connected" | "disconnecting";

export interface MCPServerConfig {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

function isAllowedAbsoluteCommand(command: string): boolean {
	return (
		isAbsolute(command) &&
		ALLOWED_ABSOLUTE_COMMANDS.has(resolve(command)) &&
		!DISALLOWED_SHELL_EXECUTABLES.has(basename(command).toLowerCase())
	);
}

export function validateMCPServerConfig(config: MCPServerConfig): void {
	const normalizedCommand = config.command.trim();
	if (normalizedCommand === "") {
		throw new Error("MCP command must not be empty");
	}

	const lowerCommand = basename(normalizedCommand).toLowerCase();
	if (
		!ALLOWED_PATH_COMMANDS.has(normalizedCommand) &&
		!ALLOWED_PATH_COMMANDS.has(lowerCommand) &&
		!isAllowedAbsoluteCommand(normalizedCommand)
	) {
		throw new Error(`MCP command not allowed: ${config.command}`);
	}

	if (DISALLOWED_SHELL_EXECUTABLES.has(lowerCommand)) {
		throw new Error(`MCP command not allowed: ${config.command}`);
	}

	const disallowedArg = config.args.find((arg) =>
		DISALLOWED_SHELL_ARGS.has(arg.toLowerCase()),
	);
	if (disallowedArg != null) {
		throw new Error(`MCP arguments not allowed: ${disallowedArg}`);
	}
}

export function createMCPSpawnEnv(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	return {
		LOG_LEVEL: env.LOG_LEVEL ?? "debug",
		QUILIN_ENV: env.QUILIN_ENV ?? "dev",
	};
}

function withTimeout<T>(
	promise: Promise<T>,
	label: string,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			rejectPromise(new MCPTimeoutError(label, timeoutMs));
		}, timeoutMs);

		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolvePromise(value);
			},
			(error) => {
				clearTimeout(timeout);
				rejectPromise(error);
			},
		);
	});
}

function createDisconnectedResult(message: string): MCPToolCallResult {
	return {
		content: JSON.stringify({ error: message }),
		isError: true,
	};
}

export function writeReplLogSeparatorIfNeeded(
	runtimeMode: LoggerRuntimeMode = getLoggerRuntimeMode(),
): void {
	if (runtimeMode === "repl") {
		process.stderr.write("\n");
	}
}

function detectErrorPayload(content: string): boolean {
	try {
		const parsed = JSON.parse(content) as unknown;
		return containsErrorMarker(parsed);
	} catch {
		return false;
	}
}

function containsErrorMarker(
	value: unknown,
	seen = new WeakSet<object>(),
): boolean {
	if (value == null) {
		return false;
	}

	if (typeof value === "string") {
		try {
			return containsErrorMarker(JSON.parse(value), seen);
		} catch {
			return false;
		}
	}

	if (Array.isArray(value)) {
		return value.some((item) => containsErrorMarker(item, seen));
	}

	if (typeof value !== "object") {
		return false;
	}

	if (seen.has(value)) {
		return false;
	}
	seen.add(value);

	const record = value as Record<string, unknown>;
	if (record.isError === true) {
		return true;
	}

	if ("error" in record && record.error != null) {
		return true;
	}

	if (record.type === "text" && typeof record.text === "string") {
		return detectErrorPayload(record.text);
	}

	return Object.values(record).some((entry) =>
		containsErrorMarker(entry, seen),
	);
}

function formatCallToolResult(result: CallToolResult): MCPToolCallResult {
	const textContent = result.content
		.filter(
			(
				item,
			): item is Extract<(typeof result.content)[number], { type: "text" }> =>
				item.type === "text",
		)
		.map((item) => item.text)
		.join("\n");

	const content =
		textContent ||
		(result.structuredContent
			? JSON.stringify(result.structuredContent)
			: JSON.stringify(result.content));

	return {
		content,
		isError:
			result.isError === true ||
			result.structuredContent?.isError === true ||
			detectErrorPayload(content),
	};
}

export class MCPClientManager {
	private client?: Client;
	private transport?: StdioClientTransport;
	private _connected = false;
	private connectionState: MCPConnectionState = "idle";
	private connectInProgress?: Promise<Tool[]>;
	private disconnectReason = "MCP client is not connected";
	private lifecycleQueue: Promise<unknown> = Promise.resolve();
	private readonly pendingCalls = new Set<Promise<CallToolResult>>();

	/** Public read-only connection state for external queries (REPL /status, etc.) */
	get isConnected(): boolean {
		return this._connected;
	}

	async connect(config: MCPServerConfig): Promise<Tool[]> {
		if (this.connectInProgress != null) {
			return this.connectInProgress;
		}

		const connectPromise = this.queueLifecycleOperation(async () => {
			this.connectionState = "connecting";
			await this.disconnectInternal();
			validateMCPServerConfig(config);

			const transportConfig: StdioServerParameters = {
				command: config.command,
				args: [...config.args],
				cwd: config.cwd ? resolve(config.cwd) : undefined,
				stderr: "pipe",
				env: createMCPSpawnEnv(),
			};

			const client = new Client(CLIENT_INFO);
			const transport = new StdioClientTransport(transportConfig);

			transport.onerror = (error) => {
				writeReplLogSeparatorIfNeeded();
				logger.error({ err: error }, "MCP transport error");
			};
			transport.onclose = () => {
				this._connected = false;
				this.connectionState = "idle";
				this.disconnectReason = "MCP server disconnected";
				writeReplLogSeparatorIfNeeded();
				logger.warn("MCP transport closed");
			};

			transport.stderr?.on("data", (chunk) => {
				const message = chunk.toString().trim();
				if (message !== "") {
					writeReplLogSeparatorIfNeeded();
					logger.warn({ stderr: message }, "MCP server stderr");
				}
			});

			client.onerror = (error) => {
				writeReplLogSeparatorIfNeeded();
				logger.error({ err: error }, "MCP client error");
			};

			try {
				await withTimeout(
					client.connect(transport),
					"MCP connect",
					CONNECT_TIMEOUT_MS,
				);
				const { tools } = await withTimeout(
					client.listTools(),
					"MCP listTools",
					CONNECT_TIMEOUT_MS,
				);

				this.client = client;
				this.transport = transport;
				this._connected = true;
				this.connectionState = "connected";
				this.disconnectReason = "MCP client is not connected";

				return tools.map((tool) => {
					const name = sanitizeMCPToolName(tool.name);
					return {
						name,
						description: sanitizeMCPToolDescription(tool.description ?? "", {
							toolName: name,
						}),
						parameters: jsonSchemaToZod(tool.inputSchema),
						execute: async (args: unknown) => {
							const result = await this.callToolWithMetadata(
								name,
								args as Record<string, unknown>,
							);

							return {
								toolCallId: "mcp-call",
								content: result.content,
								isError: result.isError,
							};
						},
					};
				});
			} catch (error) {
				try { await transport.close(); } catch { /* already closed */ }
				this.client = undefined;
				this.transport = undefined;
				this._connected = false;
				this.connectionState = "idle";
				throw error;
			}
		});

		this.connectInProgress = connectPromise.finally(() => {
			if (this.connectInProgress === connectPromise) {
				this.connectInProgress = undefined;
			}
		});
		return this.connectInProgress;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const result = await this.callToolWithMetadata(name, args);
		return result.content;
	}

	async disconnect(): Promise<void> {
		await this.queueLifecycleOperation(async () => this.disconnectInternal());
	}

	private queueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.lifecycleQueue.catch(() => undefined).then(operation);
		this.lifecycleQueue = run.catch(() => undefined);
		return run;
	}

	private async disconnectInternal(): Promise<void> {
		this.connectionState = "disconnecting";
		this._connected = false;
		this.disconnectReason = "MCP server disconnected";

		if (this.pendingCalls.size > 0) {
			try {
				await withTimeout(
					Promise.allSettled([...this.pendingCalls]),
					"MCP disconnect drain",
					DISCONNECT_TIMEOUT_MS,
				);
			} catch (error) {
				writeReplLogSeparatorIfNeeded();
				logger.warn(
					{ err: error, pendingCallCount: this.pendingCalls.size },
					"MCP disconnect timed out waiting for in-flight tool calls",
				);
			}
		}

		await this.transport?.close();
		this.client = undefined;
		this.transport = undefined;
		this.connectionState = "idle";
	}

	private async callToolWithMetadata(
		name: string,
		args: Record<string, unknown>,
	): Promise<MCPToolCallResult> {
		const isOperational =
			this.connectionState === "connected" ||
			(this.connectionState === "idle" && this._connected);
		if (!isOperational || this.client == null) {
			return createDisconnectedResult(this.disconnectReason);
		}

		let pendingCall: Promise<CallToolResult> | undefined;
		try {
			const requestMetadata = createMCPRequestMetadata();
			pendingCall = withTimeout<CallToolResult>(
				this.client.callTool({
					name,
					arguments: args,
					...(requestMetadata == null ? {} : { _meta: requestMetadata }),
				}) as Promise<CallToolResult>,
				`MCP tool ${name}`,
				DEFAULT_TOOL_TIMEOUT_MS,
			);
			this.pendingCalls.add(pendingCall);
			const result = await pendingCall;
			return formatCallToolResult(result);
		} catch (error) {
			// NEVER throw from this method — all errors (including timeouts and
			// ERR_USE_AFTER_CLOSE from a closed transport) become safe MCPToolCallResult
			// values so they never propagate up to dispatchCli() and kill the REPL.
			if (error instanceof MCPTimeoutError) {
				return createDisconnectedResult(error.message);
			}

			const message =
				error instanceof Error ? error.message : "MCP tool call failed";
			return createDisconnectedResult(message);
		} finally {
			if (pendingCall != null) {
				this.pendingCalls.delete(pendingCall);
			}
		}
	}
}
