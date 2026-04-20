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
	private readonly shortNameIndex = new Map<string, ToolWithMetadata | null>();
	private readonly changeListeners = new Set<() => void>();

	constructor(
		private readonly createClient: () => MCPClientConnection = () =>
			new MCPClientManager(),
	) {}

	private buildPendingServerState(
		serverId: string,
		client: MCPClientConnection,
		tools: readonly ToolWithMetadata[],
	): {
		readonly connections: Map<string, MCPClientConnection>;
		readonly serverToolNames: Map<string, readonly string[]>;
		readonly serverTools: Map<string, ToolWithMetadata>;
	} {
		const duplicateToolName = new Set<string>();
		const toolNames = tools.map((tool) => tool.name);
		for (const toolName of toolNames) {
			if (duplicateToolName.has(toolName)) {
				throw new Error(`Duplicate MCP tool name: ${toolName}`);
			}
			duplicateToolName.add(toolName);
		}

		const pendingConnections = new Map(this.connections);
		const pendingServerToolNames = new Map(this.serverToolNames);
		const pendingServerTools = new Map(this.serverTools);
		const previousToolNames = pendingServerToolNames.get(serverId) ?? [];

		for (const toolName of previousToolNames) {
			pendingServerTools.delete(toolName);
		}

		pendingConnections.set(serverId, client);
		pendingServerToolNames.set(serverId, toolNames);
		for (const tool of tools) {
			pendingServerTools.set(tool.name, tool);
		}

		return {
			connections: pendingConnections,
			serverToolNames: pendingServerToolNames,
			serverTools: pendingServerTools,
		};
	}

	private applyServerState(state: {
		readonly connections: Map<string, MCPClientConnection>;
		readonly serverToolNames: Map<string, readonly string[]>;
		readonly serverTools: Map<string, ToolWithMetadata>;
	}): void {
		this.connections.clear();
		this.serverToolNames.clear();
		this.serverTools.clear();

		state.connections.forEach((client, serverId) => {
			this.connections.set(serverId, client);
		});
		state.serverToolNames.forEach((toolNames, serverId) => {
			this.serverToolNames.set(serverId, toolNames);
		});
		state.serverTools.forEach((tool, toolName) => {
			this.serverTools.set(toolName, tool);
		});
		this.rebuildShortNameIndex();
		this.emitChange();
	}

	private clearServerTools(serverId: string): void {
		const toolNames = this.serverToolNames.get(serverId) ?? [];

		this.connections.delete(serverId);
		this.serverToolNames.delete(serverId);
		toolNames.forEach((toolName) => {
			this.serverTools.delete(toolName);
		});
		this.rebuildShortNameIndex();
		this.emitChange();
	}

	private rebuildShortNameIndex(): void {
		this.shortNameIndex.clear();
		for (const tool of [...this.builtinTools.values(), ...this.serverTools.values()]) {
			const shortName = getShortName(tool);
			if (!this.shortNameIndex.has(shortName)) {
				this.shortNameIndex.set(shortName, tool);
				continue;
			}

			this.shortNameIndex.set(shortName, null);
		}
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) {
			listener();
		}
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

			const pendingState = this.buildPendingServerState(
				entry.id,
				client,
				wrappedTools,
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
			}

			try {
				this.applyServerState(pendingState);
			} catch (error) {
				await client.disconnect().catch(() => undefined);
				throw error;
			}

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
		this.rebuildShortNameIndex();
		this.emitChange();
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
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

		return this.shortNameIndex.get(name) ?? undefined;
	}

	async disconnectAll(): Promise<void> {
		await Promise.all(
			[...this.connections.keys()].map((serverId) => this.unregister(serverId)),
		);
	}
}
