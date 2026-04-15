import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../logger.js";
import type { Tool } from "./types.js";

const CONNECT_TIMEOUT_MS = 5_000;
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

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			rejectPromise(
				new Error(`${label} timed out after ${CONNECT_TIMEOUT_MS}ms`),
			);
		}, CONNECT_TIMEOUT_MS);

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

function jsonSchemaToZodObject(schema: {
	type: "object";
	properties?: Record<string, { type?: string }>;
	required?: string[];
}) {
	const required = new Set(schema.required ?? []);
	const shape = Object.fromEntries(
		Object.entries(schema.properties ?? {}).map(([name, propertySchema]) => {
			if (propertySchema.type !== "string") {
				throw new Error(
					`Unsupported MCP schema type for "${name}": ${propertySchema.type ?? "unknown"}`,
				);
			}

			const zodSchema = required.has(name) ? z.string() : z.string().optional();
			return [name, zodSchema];
		}),
	);

	return z.object(shape);
}

export class MCPClientManager {
	private client?: Client;
	private transport?: StdioClientTransport;
	private isConnected = false;
	private disconnectReason = "MCP client is not connected";

	async connect(config: MCPServerConfig): Promise<Tool[]> {
		await this.disconnect();

		const transportConfig: StdioServerParameters = {
			command: config.command,
			args: [...config.args],
			cwd: config.cwd ? resolve(config.cwd) : undefined,
			stderr: "pipe",
			env: {
				LOG_LEVEL: process.env.LOG_LEVEL ?? "debug",
				QUILIN_ENV: process.env.QUILIN_ENV ?? "dev",
			},
		};

		const client = new Client(CLIENT_INFO);
		const transport = new StdioClientTransport(transportConfig);

		transport.onerror = (error) => {
			logger.error({ err: error }, "MCP transport error");
		};
		transport.onclose = () => {
			this.isConnected = false;
			this.disconnectReason = "MCP server disconnected";
			logger.warn("MCP transport closed");
		};

		transport.stderr?.on("data", (chunk) => {
			const message = chunk.toString().trim();
			if (message !== "") {
				logger.warn({ stderr: message }, "MCP server stderr");
			}
		});

		client.onerror = (error) => {
			logger.error({ err: error }, "MCP client error");
		};

		try {
			await withTimeout(client.connect(transport), "MCP connect");
			const { tools } = await withTimeout(client.listTools(), "MCP listTools");

			this.client = client;
			this.transport = transport;
			this.isConnected = true;
			this.disconnectReason = "MCP client is not connected";

			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: jsonSchemaToZodObject(tool.inputSchema),
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
			const result = await this.client.callTool({
				name,
				arguments: args,
			});
			return formatCallToolResult(result);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "MCP tool call failed";
			return createDisconnectedResult(message);
		}
	}
}
