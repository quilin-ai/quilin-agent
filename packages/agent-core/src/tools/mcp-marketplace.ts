import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ToolWithMetadata } from "./tool-metadata.js";
import type { ToolResult } from "./types.js";

/**
 * 远程 MCP Server 条目 / Remote MCP Server Entry
 *
 * Represents an MCP server available in a remote marketplace.
 * 表示远程市场中可用的 MCP server。
 */
export interface McpServerEntry {
	readonly name: string;
	readonly description: string;
	readonly url: string;
	readonly category?: string;
}

/**
 * MCP 安装结果 / MCP Install Result
 *
 * Result of downloading and saving an MCP server configuration.
 * MCP server 配置的下载和保存结果。
 */
export interface McpInstallResult {
	readonly ok: boolean;
	readonly configPath?: string;
	readonly error?: string;
}

/**
 * MCP 市场 / MCP Marketplace
 *
 * Searches and installs MCP server configurations from remote marketplaces.
 * Supports searching across multiple sources and downloading MCP config JSON
 * to a local directory for later registration.
 *
 * 从远程市场搜索和安装 MCP server 配置。支持跨多个数据源搜索，
 * 并将 MCP config JSON 下载到本地目录以供后续注册。
 */
export class McpMarketplace {
	private readonly searchUrls: readonly string[];
	private readonly fetchFn: typeof fetch;

	constructor(
		options: {
			readonly searchUrls?: readonly string[];
			readonly fetchFn?: typeof fetch;
		} = {},
	) {
		this.searchUrls = options.searchUrls ?? [
			"https://claudemarketplaces.com/mcp",
		];
		this.fetchFn = options.fetchFn ?? fetch;
	}

	/**
	 * 搜索远程 MCP Server 市场 / Search remote MCP server marketplace
	 *
	 * Queries configured marketplace sources for MCP servers matching
	 * the given query string. Results are deduplicated by URL.
	 *
	 * 查询已配置的市场数据源，搜索匹配查询字符串的 MCP server。
	 * 结果按 URL 去重。
	 */
	async search(query: string): Promise<readonly McpServerEntry[]> {
		const results: McpServerEntry[] = [];
		const seenUrls = new Set<string>();

		for (const baseUrl of this.searchUrls) {
			try {
				const url = `${baseUrl}/search?q=${encodeURIComponent(query)}`;
				const response = await this.fetchFn(url);

				if (!response.ok) {
					continue;
				}

				const data: unknown = await response.json();
				const entries = this.normalizeSearchResults(data);

				for (const entry of entries) {
					const key = entry.url || entry.name;
					if (!seenUrls.has(key)) {
						seenUrls.add(key);
						results.push(entry);
					}
				}
			} catch {
				// Skip failed sources; continue with others.
			}
		}

		return results;
	}

	/**
	 * 安装 MCP Server 配置 / Install MCP server configuration
	 *
	 * Downloads an MCP server configuration JSON from the given URL and
	 * saves it to the local MCP config directory. Returns the saved file path.
	 *
	 * 从给定 URL 下载 MCP server 配置 JSON，保存到本地 MCP config 目录。
	 * 返回保存的文件路径。
	 */
	async install(
		url: string,
		targetDir?: string,
	): Promise<McpInstallResult> {
		let response: Response;
		try {
			response = await this.fetchFn(url);
		} catch (error) {
			return {
				ok: false,
				error: `Failed to fetch MCP config: ${error instanceof Error ? error.message : "unknown error"}`,
			};
		}

		if (!response.ok) {
			return {
				ok: false,
				error: `Failed to download MCP config: HTTP ${response.status}`,
			};
		}

		let config: unknown;
		try {
			config = await response.json();
		} catch {
			return {
				ok: false,
				error: "Failed to parse MCP config JSON",
			};
		}

		const configDir =
			targetDir != null
				? resolve(targetDir)
				: resolve(homedir(), ".quilin", "mcp-configs");

		const fileName =
			this.extractFileNameFromUrl(url) ?? `mcp-server-${Date.now()}.json`;
		const configPath = join(configDir, fileName);

		try {
			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, JSON.stringify(config, null, 2), {
				encoding: "utf8",
				flag: "wx",
			});
		} catch (error) {
			if (
				typeof error === "object" &&
				error != null &&
				"code" in error &&
				(error as { code?: string }).code === "EEXIST"
			) {
				return {
					ok: false,
					error: `Config file already exists: ${configPath}`,
				};
			}
			return {
				ok: false,
				error: `Failed to write MCP config: ${error instanceof Error ? error.message : "unknown error"}`,
			};
		}

		return { ok: true, configPath };
	}

	/**
	 * Normalize raw API search response to McpServerEntry array.
	 * Handles both array responses and { results: [...] } envelope.
	 */
	private normalizeSearchResults(data: unknown): readonly McpServerEntry[] {
		if (Array.isArray(data)) {
			return data
				.map((item) => this.normalizeEntry(item))
				.filter((entry): entry is McpServerEntry => entry != null);
		}

		if (
			typeof data === "object" &&
			data != null &&
			"results" in data &&
			Array.isArray((data as Record<string, unknown>).results)
		) {
			return (
				(data as Record<string, unknown>).results as unknown[]
			)
				.map((item) => this.normalizeEntry(item))
				.filter((entry): entry is McpServerEntry => entry != null);
		}

		return [];
	}

	/**
	 * Normalize a single raw API entry to McpServerEntry.
	 * Returns null if required fields are missing.
	 */
	private normalizeEntry(item: unknown): McpServerEntry | null {
		if (typeof item !== "object" || item == null) {
			return null;
		}

		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const description =
			typeof obj.description === "string" ? obj.description.trim() : "";
		const url =
			typeof obj.url === "string"
				? obj.url
				: typeof obj.homepage === "string"
					? obj.homepage
					: typeof obj.repository === "string"
						? obj.repository
						: "";
		const category =
			typeof obj.category === "string" ? obj.category : undefined;

		if (name.length === 0) {
			return null;
		}

		return {
			name,
			description: description.length > 0 ? description : name,
			url: url.length > 0 ? url : "",
			...(category == null ? {} : { category }),
		};
	}

	/**
	 * Extract a safe file name from a URL path.
	 */
	private extractFileNameFromUrl(url: string): string | null {
		try {
			const parsed = new URL(url);
			const segments = parsed.pathname.split("/").filter(Boolean);
			if (segments.length === 0) {
				return null;
			}
			const last = segments[segments.length - 1];
			// Sanitize: only allow alphanumeric, dash, underscore, dot.
			const sanitized = last.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
			return sanitized.length > 0 ? sanitized : null;
		} catch {
			return null;
		}
	}
}

/**
 * MCP 搜索工具 / MCP Search Tool
 *
 * Creates a tool that searches the remote MCP marketplace for servers
 * matching the given query. Supports optional category filtering.
 *
 * 创建一个搜索远程 MCP 市场的工具，根据给定查询匹配 server。
 * 支持可选的分类过滤。
 */
export interface McpSearchToolOptions {
	readonly marketplace?: McpMarketplace;
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
}

const DEFAULT_MCP_SEARCH_LIMIT = 10;
const DEFAULT_MCP_MAX_LIMIT = 50;

const mcpSearchParametersSchema = z.object({
	query: z.string().trim().default(""),
	category: z.string().trim().optional(),
	limit: z.number().int().positive().max(DEFAULT_MCP_MAX_LIMIT).optional(),
});

function createJsonResult(
	toolCallId: string,
	content: unknown,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify(content, null, 2),
		isError: false,
	};
}

function createErrorResult(
	toolCallId: string,
	message: string,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify({ error: message }),
		isError: true,
	};
}

export function createMcpSearchTool(
	options: McpSearchToolOptions = {},
): ToolWithMetadata {
	const maxLimit = Math.max(1, options.maxLimit ?? DEFAULT_MCP_MAX_LIMIT);
	const defaultLimit = Math.min(
		Math.max(1, options.defaultLimit ?? DEFAULT_MCP_SEARCH_LIMIT),
		maxLimit,
	);
	const marketplace = options.marketplace ?? new McpMarketplace();

	return {
		name: "mcp_search",
		description:
			"Search the remote MCP server marketplace for servers by name, description, or category. Use this to discover new MCP tools available for installation.",
		category: "programmatic",
		riskLevel: "read",
		parameters: mcpSearchParametersSchema.extend({
			limit: z.number().int().positive().max(maxLimit).optional(),
		}),
		async execute(args: unknown): Promise<ToolResult> {
			try {
				const parsed = mcpSearchParametersSchema
					.extend({
						limit: z.number().int().positive().max(maxLimit).optional(),
					})
					.parse(args);

				const query = parsed.query;
				const category = parsed.category;
				const limit = parsed.limit ?? defaultLimit;

				let results = await marketplace.search(query);

				if (category != null && category.length > 0) {
					const normalizedCategory = category.toLowerCase().trim();
					results = results.filter(
						(entry) =>
							entry.category?.toLowerCase() === normalizedCategory,
					);
				}

				return createJsonResult("builtin-mcp-search", {
					query,
					...(category == null ? {} : { category }),
					total: results.length,
					results: results.slice(0, limit),
				});
			} catch (error) {
				return createErrorResult(
					"builtin-mcp-search",
					error instanceof Error
						? error.message
						: "Failed to search MCP marketplace",
				);
			}
		},
	};
}
