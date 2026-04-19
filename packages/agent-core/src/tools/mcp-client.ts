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
import { jsonSchemaToZod } from "./schema-converter.js";
import type { Tool } from "./types.js";

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const ALLOWED_PATH_COMMANDS = new Set(["bun", "node", "npx", "python", "python3", "uv"]);
const ALLOWED_ABSOLUTE_COMMAND_PREFIXES = [
	"/bin/",
	"/opt/homebrew/bin/",
	"/usr/bin/",
	"/usr/local/bin/",
] as const;
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

interface MCPToolCallResult {
	readonly content: string;
	readonly isError: boolean;
}

export interface MCPServerConfig {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

function isAllowedAbsoluteCommand(command: string): boolean {
	return (
		isAbsolute(command) &&
		ALLOWED_ABSOLUTE_COMMAND_PREFIXES.some((prefix) =>
			command.startsWith(prefix),
		) &&
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
			rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
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
		return (
			parsed != null &&
			typeof parsed === "object" &&
			"error" in parsed &&
			typeof parsed.error === "string"
		);
	} catch {
		return false;
	}
}

function formatCallToolResult(result: CallToolResult): MCPToolCallResult {
	if ("toolResult" in result) {
		const content = JSON.stringify(result.toolResult);
		return {
			content,
			isError: detectErrorPayload(content),
		};
	}

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
		isError: result.isError === true || detectErrorPayload(content),
	};
}

export class MCPClientManager {
	private client?: Client;
	private transport?: StdioClientTransport;
	private isConnected = false;
	private disconnectReason = "MCP client is not connected";

	async connect(config: MCPServerConfig): Promise<Tool[]> {
		await this.disconnect();
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
			this.isConnected = false;
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
			await withTimeout(client.connect(transport), "MCP connect", CONNECT_TIMEOUT_MS);
			const { tools } = await withTimeout(
				client.listTools(),
				"MCP listTools",
				CONNECT_TIMEOUT_MS,
			);

			this.client = client;
			this.transport = transport;
			this.isConnected = true;
			this.disconnectReason = "MCP client is not connected";

			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: jsonSchemaToZod(tool.inputSchema),
				execute: async (args) => {
					const result = await this.callToolWithMetadata(
						tool.name,
						args as Record<string, unknown>,
					);

					return {
						toolCallId: "mcp-call",
						content: result.content,
						isError: result.isError,
					};
				},
			}));
		} catch (error) {
			await transport.close().catch(() => undefined);
			this.client = undefined;
			this.transport = undefined;
			this.isConnected = false;
			throw error;
		}
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const result = await this.callToolWithMetadata(name, args);
		return result.content;
	}

	async disconnect(): Promise<void> {
		this.isConnected = false;
		this.disconnectReason = "MCP client is not connected";

		await this.transport?.close();
		this.client = undefined;
		this.transport = undefined;
	}

	private async callToolWithMetadata(
		name: string,
		args: Record<string, unknown>,
	): Promise<MCPToolCallResult> {
		if (!this.isConnected || this.client == null) {
			return createDisconnectedResult(this.disconnectReason);
		}

		try {
			const result = await withTimeout(
				this.client.callTool({
					name,
					arguments: args,
				}),
				`MCP tool ${name}`,
				DEFAULT_TOOL_TIMEOUT_MS,
			);
			return formatCallToolResult(result);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes(`timed out after ${DEFAULT_TOOL_TIMEOUT_MS}ms`)
			) {
				throw error;
			}

			const message =
				error instanceof Error ? error.message : "MCP tool call failed";
			return createDisconnectedResult(message);
		}
	}
}
