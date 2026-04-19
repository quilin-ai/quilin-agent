import { logger } from "../logger.js";
import { MCPClientManager, type MCPServerConfig } from "./mcp-client.js";
import type {
	RiskLevel,
	ToolPromptDescriptor,
	ToolWithMetadata,
} from "./tool-metadata.js";
import type { Tool } from "./types.js";

interface MCPClientConnection {
	connect(config: MCPServerConfig): Promise<Tool[]>;
	disconnect(): Promise<void>;
}

export interface MCPServerEntry {
	readonly id: string;
	readonly config: MCPServerConfig;
	readonly namespace: string;
	readonly defaultRiskLevel?: RiskLevel;
}

function toNamespacedTool(
	tool: Tool,
	namespace: string,
	riskLevel: RiskLevel,
): ToolWithMetadata {
	return {
		...tool,
		name: `${namespace}/${tool.name}`,
		namespace,
		category: "programmatic",
		riskLevel,
	};
}

function getShortName(tool: ToolWithMetadata): string {
	if (tool.namespace != null && tool.name.startsWith(`${tool.namespace}/`)) {
		return tool.name.slice(tool.namespace.length + 1);
	}

	const slashIndex = tool.name.indexOf("/");
	return slashIndex === -1 ? tool.name : tool.name.slice(slashIndex + 1);
}

export class MCPRegistry {
	private readonly connections = new Map<string, MCPClientConnection>();
	private readonly serverToolNames = new Map<string, readonly string[]>();
	private readonly serverTools = new Map<string, ToolWithMetadata>();
	private readonly builtinTools = new Map<string, ToolWithMetadata>();

	constructor(
		private readonly createClient: () => MCPClientConnection = () =>
			new MCPClientManager(),
	) {}

	private installServerTools(
		serverId: string,
		client: MCPClientConnection,
		tools: readonly ToolWithMetadata[],
	): void {
		this.connections.set(serverId, client);
		this.serverToolNames.set(
			serverId,
			tools.map((tool) => tool.name),
		);
		tools.forEach((tool) => {
			this.serverTools.set(tool.name, tool);
		});
	}

	private clearServerTools(serverId: string): void {
		const toolNames = this.serverToolNames.get(serverId) ?? [];

		this.connections.delete(serverId);
		this.serverToolNames.delete(serverId);
		toolNames.forEach((toolName) => {
			this.serverTools.delete(toolName);
		});
	}

	async register(entry: MCPServerEntry): Promise<ToolWithMetadata[]> {
		const client = this.createClient();

		try {
			const connectedTools = await client.connect(entry.config);
			const wrappedTools = connectedTools.map((tool) =>
				toNamespacedTool(
					tool,
					entry.namespace,
					entry.defaultRiskLevel ?? "read",
				),
			);

			const existingClient = this.connections.get(entry.id);
			if (existingClient != null) {
				try {
					await existingClient.disconnect();
				} catch (error) {
					await client.disconnect().catch(() => undefined);
					logger.warn(
						{ err: error, serverId: entry.id },
						"MCP server disconnect failed during register",
					);
					throw error;
				}

				this.clearServerTools(entry.id);
			}

			this.installServerTools(entry.id, client, wrappedTools);

			return wrappedTools;
		} catch (error) {
			await client.disconnect().catch(() => undefined);
			throw error;
		}
	}

	async unregister(serverId: string): Promise<void> {
		const client = this.connections.get(serverId);

		try {
			await client?.disconnect();
		} catch (error) {
			logger.warn(
				{ err: error, serverId },
				"MCP server disconnect failed during unregister",
			);
		} finally {
			this.clearServerTools(serverId);
		}
	}

	registerBuiltin(tools: readonly ToolWithMetadata[]): void {
		tools.forEach((tool) => {
			this.builtinTools.set(tool.name, tool);
		});
	}

	getAllTools(): ToolWithMetadata[] {
		return [...this.builtinTools.values(), ...this.serverTools.values()];
	}

	getToolDescriptors(): ToolPromptDescriptor[] {
		return this.getAllTools()
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				category: tool.category,
				riskLevel: tool.riskLevel,
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	findTool(name: string): ToolWithMetadata | undefined {
		const exactMatch =
			this.builtinTools.get(name) ?? this.serverTools.get(name);
		if (exactMatch != null) {
			return exactMatch;
		}

		const shortNameMatches = this.getAllTools().filter(
			(tool) => getShortName(tool) === name,
		);

		return shortNameMatches.length === 1 ? shortNameMatches[0] : undefined;
	}

	async disconnectAll(): Promise<void> {
		await Promise.all(
			[...this.connections.keys()].map((serverId) => this.unregister(serverId)),
		);
	}
}
