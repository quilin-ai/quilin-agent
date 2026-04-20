import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "../logger.js";
import type { MCPServerConfig } from "./mcp-client.js";
import { MCPRegistry } from "./registry.js";
import type { ToolWithMetadata } from "./tool-metadata.js";
import type { Tool } from "./types.js";

vi.mock("../logger.js", () => ({
	logger: {
		warn: vi.fn(),
	},
}));

function createServerConfig(): MCPServerConfig {
	return {
		command: "uv",
		args: ["run", "python", "-m", "fake-mcp"],
	};
}

function createTool(name: string, description = `${name} description`): Tool {
	return {
		name,
		description,
		parameters: z.object({ query: z.string().optional() }),
		execute: async () => ({
			toolCallId: "call-1",
			content: JSON.stringify({ ok: true }),
			isError: false,
		}),
	};
}

function createBuiltinTool(name: string): ToolWithMetadata {
	return {
		name,
		description: `${name} description`,
		parameters: z.object({ path: z.string() }),
		execute: async () => ({
			toolCallId: "call-1",
			content: JSON.stringify({ ok: true }),
			isError: false,
		}),
		category: "programmatic",
		riskLevel: "read",
	};
}

function createFakeClient(tools: readonly Tool[]) {
	return {
		connect: vi.fn(async (_config: MCPServerConfig) => [...tools]),
		disconnect: vi.fn(async () => {}),
	};
}

describe("MCPRegistry", () => {
	it("registers MCP tools with namespace prefixes and default metadata", async () => {
		const fakeClient = createFakeClient([
			createTool("memory_recall", "Recall stored memories"),
		]);
		const registry = new MCPRegistry(() => fakeClient);
		const config = createServerConfig();

		const tools = await registry.register({
			id: "omnimem",
			config,
			namespace: "omnimem",
			defaultRiskLevel: "read",
		});

		expect(fakeClient.connect).toHaveBeenCalledWith(config);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			name: "omnimem/memory_recall",
			description: "Recall stored memories",
			namespace: "omnimem",
			category: "programmatic",
			riskLevel: "read",
		});
		expect(registry.findTool("omnimem/memory_recall")?.name).toBe(
			"omnimem/memory_recall",
		);
		expect(registry.findTool("memory_recall")?.name).toBe(
			"omnimem/memory_recall",
		);
	});

	it("merges builtin and MCP tools into one available tool list", async () => {
		const fakeClient = createFakeClient([createTool("memory_store")]);
		const registry = new MCPRegistry(() => fakeClient);

		registry.registerBuiltin([createBuiltinTool("file_read")]);
		await registry.register({
			id: "omnimem",
			config: createServerConfig(),
			namespace: "omnimem",
		});

		expect(registry.getAllTools().map((tool) => tool.name)).toEqual([
			"file_read",
			"omnimem/memory_store",
		]);
	});

	it("returns stable prompt descriptors for all registered tools", async () => {
		const fakeClient = createFakeClient([
			createTool("z_tool", "Last tool"),
			createTool("a_tool", "First tool"),
		]);
		const registry = new MCPRegistry(() => fakeClient);

		registry.registerBuiltin([createBuiltinTool("file_read")]);
		await registry.register({
			id: "omnimem",
			config: createServerConfig(),
			namespace: "omnimem",
			defaultRiskLevel: "write",
		});

		expect(registry.getToolDescriptors()).toEqual([
			{
				name: "file_read",
				description: "file_read description",
				category: "programmatic",
				riskLevel: "read",
			},
			{
				name: "omnimem/a_tool",
				description: "First tool",
				category: "programmatic",
				riskLevel: "write",
			},
			{
				name: "omnimem/z_tool",
				description: "Last tool",
				category: "programmatic",
				riskLevel: "write",
			},
		]);
	});

	it("prefers exact namespace matches and rejects ambiguous short names", async () => {
		const clients = [
			createFakeClient([createTool("search")]),
			createFakeClient([createTool("search")]),
		];
		const registry = new MCPRegistry(
			() => clients.shift() ?? createFakeClient([]),
		);

		await registry.register({
			id: "memory",
			config: createServerConfig(),
			namespace: "memory",
		});
		await registry.register({
			id: "web",
			config: createServerConfig(),
			namespace: "web",
		});

		expect(registry.findTool("memory/search")?.name).toBe("memory/search");
		expect(registry.findTool("web/search")?.name).toBe("web/search");
		expect(registry.findTool("search")).toBeUndefined();
	});

	it("unregisters one server without affecting others and disconnectAll keeps builtins", async () => {
		const omnimemClient = createFakeClient([createTool("memory_recall")]);
		const webClient = createFakeClient([createTool("fetch")]);
		const clients = [omnimemClient, webClient];
		const registry = new MCPRegistry(
			() => clients.shift() ?? createFakeClient([]),
		);

		registry.registerBuiltin([createBuiltinTool("file_read")]);
		await registry.register({
			id: "omnimem",
			config: createServerConfig(),
			namespace: "omnimem",
		});
		await registry.register({
			id: "web",
			config: createServerConfig(),
			namespace: "web",
		});

		await registry.unregister("omnimem");

		expect(omnimemClient.disconnect).toHaveBeenCalledTimes(1);
		expect(registry.findTool("omnimem/memory_recall")).toBeUndefined();
		expect(registry.findTool("web/fetch")?.name).toBe("web/fetch");
		expect(registry.findTool("file_read")?.name).toBe("file_read");

		await registry.disconnectAll();

		expect(webClient.disconnect).toHaveBeenCalledTimes(1);
		expect(registry.findTool("web/fetch")).toBeUndefined();
		expect(registry.findTool("file_read")?.name).toBe("file_read");
	});

	it("keeps the existing server state when replacement connect fails", async () => {
		const existingClient = createFakeClient([createTool("memory_recall")]);
		const replacementClient = {
			connect: vi.fn(async () => {
				throw new Error("connect failed");
			}),
			disconnect: vi.fn(async () => {}),
		};
		const registry = new MCPRegistry(() => {
			if (!registry.findTool("memory/memory_recall")) {
				return existingClient;
			}

			return replacementClient;
		});

		await registry.register({
			id: "memory",
			config: createServerConfig(),
			namespace: "memory",
		});

		await expect(
			registry.register({
				id: "memory",
				config: createServerConfig(),
				namespace: "memory",
			}),
		).rejects.toThrow("connect failed");

		expect(existingClient.disconnect).not.toHaveBeenCalled();
		expect(replacementClient.disconnect).toHaveBeenCalledTimes(1);
		expect(registry.findTool("memory/memory_recall")?.name).toBe(
			"memory/memory_recall",
		);
	});

	it("cleans registry state even when disconnect throws during unregister", async () => {
		const disconnectError = new Error("disconnect failed");
		const failingClient = {
			connect: vi.fn(async (_config: MCPServerConfig) => [
				createTool("memory_recall"),
			]),
			disconnect: vi.fn(async () => {
				throw disconnectError;
			}),
		};
		const registry = new MCPRegistry(() => failingClient);

		await registry.register({
			id: "memory",
			config: createServerConfig(),
			namespace: "memory",
		});

		await expect(registry.unregister("memory")).resolves.toBeUndefined();

		expect(logger.warn).toHaveBeenCalledWith(
			{ err: disconnectError, serverId: "memory" },
			"MCP server disconnect failed during unregister",
		);
		expect(registry.findTool("memory/memory_recall")).toBeUndefined();
		expect(registry.getAllTools()).toEqual([]);
	});

	it("keeps existing global tool state unchanged when replacement registration fails mid-build", async () => {
		const existingClient = createFakeClient([
			createTool("memory_recall"),
			createTool("memory_store"),
		]);
		const duplicateToolClient = createFakeClient([
			createTool("memory_recall"),
			createTool("memory_recall"),
		]);
		const registry = new MCPRegistry(() => {
			if (!registry.findTool("memory/memory_recall")) {
				return existingClient;
			}

			return duplicateToolClient;
		});

		await registry.register({
			id: "memory",
			config: createServerConfig(),
			namespace: "memory",
		});

		const previousToolNames = registry.getAllTools().map((tool) => tool.name);

		await expect(
			registry.register({
				id: "memory",
				config: createServerConfig(),
				namespace: "memory",
			}),
		).rejects.toThrow(/duplicate/i);

		expect(existingClient.disconnect).not.toHaveBeenCalled();
		expect(duplicateToolClient.disconnect).toHaveBeenCalledTimes(1);
		expect(registry.getAllTools().map((tool) => tool.name)).toEqual(
			previousToolNames,
		);
	});

	it("finds unique short names without rescanning getAllTools", async () => {
		const fakeClient = createFakeClient([createTool("memory_recall")]);
		const registry = new MCPRegistry(() => fakeClient);

		await registry.register({
			id: "memory",
			config: createServerConfig(),
			namespace: "memory",
		});

		const getAllToolsSpy = vi.spyOn(registry, "getAllTools");

		expect(registry.findTool("memory_recall")?.name).toBe("memory/memory_recall");
		expect(getAllToolsSpy).not.toHaveBeenCalled();
	});
});
