import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "./builtin/index.js";
import { MCPRegistry, type MCPServerEntry } from "./registry.js";
import { ToolRouter } from "./router.js";
import { type JsonSchemaObject, jsonSchemaToZod } from "./schema-converter.js";
import type { Tool } from "./types.js";

function createServerEntry(id: string, namespace: string): MCPServerEntry {
	return {
		id,
		namespace,
		config: {
			command: "uv",
			args: ["run", "python", "-m", "fake-mcp"],
		},
	};
}

function createFakeClient(tools: readonly Tool[]) {
	return {
		connect: vi.fn(async () => [...tools]),
		disconnect: vi.fn(async () => {}),
	};
}

function createFakeClientFactory(
	clients: readonly ReturnType<typeof createFakeClient>[],
) {
	const queue = [...clients];
	return () => {
		const client = queue.shift();
		if (client == null) {
			throw new Error("No fake client available");
		}

		return client;
	};
}

function createSchemaBackedTool(
	name: string,
	schema: JsonSchemaObject,
	execute: Tool["execute"],
	description = `${name} description`,
): Tool {
	return {
		name,
		description,
		parameters: jsonSchemaToZod(schema),
		execute,
	};
}

describe("tools integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(process.cwd(), "quilin-tools-integration-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("mixes builtin and MCP registrations and sorts tool descriptors by name", async () => {
		const registry = new MCPRegistry(
			createFakeClientFactory([
				createFakeClient([
					createSchemaBackedTool(
						"memory_recall",
						{
							type: "object",
							properties: {
								query: { type: "string" },
							},
							required: ["query"],
						},
						async () => ({
							toolCallId: "call-1",
							content: JSON.stringify({ records: [] }),
							isError: false,
						}),
						"Recall stored memories",
					),
				]),
			]),
		);

		registry.registerBuiltin(
			createBuiltinTools({
				shellExec: {
					runner: vi.fn(async () => ({
						stdout: "",
						stderr: "",
						exitCode: 0,
						timedOut: false,
					})),
				},
				webFetch: {
					fetcher: vi.fn(
						async () =>
							new Response("ok", {
								status: 200,
								headers: { "content-type": "text/plain" },
							}),
					),
				},
			}),
		);
		await registry.register(createServerEntry("omnimem", "omnimem"));

		const toolNames = registry.getAllTools().map((tool) => tool.name);
		expect(toolNames).toEqual(
			expect.arrayContaining([
				"file_read",
				"file_write",
				"file_list",
				"shell_exec",
				"web_fetch",
				"omnimem/memory_recall",
			]),
		);

		const descriptorNames = registry
			.getToolDescriptors()
			.map((descriptor) => descriptor.name);
		expect(descriptorNames).toEqual([...descriptorNames].sort());
	});

	it("findTool supports builtin exact match, MCP exact match, short-name fallback, and ambiguity detection", async () => {
		const registry = new MCPRegistry(
			createFakeClientFactory([
				createFakeClient([
					createSchemaBackedTool(
						"memory_recall",
						{
							type: "object",
							properties: {
								query: { type: "string" },
							},
							required: ["query"],
						},
						async () => ({
							toolCallId: "call-1",
							content: JSON.stringify({ ok: true }),
							isError: false,
						}),
					),
				]),
				createFakeClient([
					createSchemaBackedTool(
						"search",
						{
							type: "object",
							properties: {
								query: { type: "string" },
							},
							required: ["query"],
						},
						async () => ({
							toolCallId: "call-2",
							content: JSON.stringify({ ok: true }),
							isError: false,
						}),
					),
				]),
				createFakeClient([
					createSchemaBackedTool(
						"search",
						{
							type: "object",
							properties: {
								query: { type: "string" },
							},
							required: ["query"],
						},
						async () => ({
							toolCallId: "call-3",
							content: JSON.stringify({ ok: true }),
							isError: false,
						}),
					),
				]),
			]),
		);

		registry.registerBuiltin(createBuiltinTools());
		await registry.register(createServerEntry("omnimem", "omnimem"));
		await registry.register(createServerEntry("memory", "memory"));
		await registry.register(createServerEntry("web", "web"));

		expect(registry.findTool("file_read")?.name).toBe("file_read");
		expect(registry.findTool("omnimem/memory_recall")?.name).toBe(
			"omnimem/memory_recall",
		);
		expect(registry.findTool("memory_recall")?.name).toBe(
			"omnimem/memory_recall",
		);
		expect(registry.findTool("search")).toBeUndefined();
	});

	it("ToolRouter executes builtin tools and namespaced MCP tools from the registry", async () => {
		const recallExecute = vi.fn(async ({ query }: { query: string }) => ({
			toolCallId: "call-1",
			content: JSON.stringify({ echoed: query }),
			isError: false,
		}));
		const registry = new MCPRegistry(
			createFakeClientFactory([
				createFakeClient([
					createSchemaBackedTool(
						"memory_recall",
						{
							type: "object",
							properties: {
								query: { type: "string" },
							},
							required: ["query"],
						},
						recallExecute,
					),
				]),
			]),
		);
		registry.registerBuiltin(createBuiltinTools());
		await registry.register(createServerEntry("omnimem", "omnimem"));
		const router = new ToolRouter(registry.getAllTools());

		const filePath = join(tempDir, "notes.txt");
		await writeFile(filePath, "first line\nsecond line\n", "utf8");

		const builtinResult = await router.execute({
			id: "builtin-call",
			name: "file_read",
			arguments: { path: filePath, limit: 1 },
		});
		const fullNameResult = await router.execute({
			id: "mcp-full",
			name: "omnimem/memory_recall",
			arguments: { query: "老孟" },
		});
		const shortNameResult = await router.execute({
			id: "mcp-short",
			name: "memory_recall",
			arguments: { query: "小明" },
		});

		expect(builtinResult.isError).toBe(false);
		expect(JSON.parse(builtinResult.content)).toEqual({
			path: filePath,
			content: "1: first line",
			truncated: false,
		});
		expect(fullNameResult.isError).toBe(false);
		expect(shortNameResult.isError).toBe(false);
		expect(recallExecute).toHaveBeenNthCalledWith(1, { query: "老孟" });
		expect(recallExecute).toHaveBeenNthCalledWith(2, { query: "小明" });
	});

	it("handles number, boolean, and array parameters through the enhanced schema converter", async () => {
		const execute = vi.fn(async (args: unknown) => ({
			toolCallId: "call-1",
			content: JSON.stringify(args),
			isError: false,
		}));
		const registry = new MCPRegistry(
			createFakeClientFactory([
				createFakeClient([
					createSchemaBackedTool(
						"stats",
						{
							type: "object",
							properties: {
								threshold: { type: "number" },
								enabled: { type: "boolean" },
								tags: {
									type: "array",
									items: { type: "string" },
								},
							},
							required: ["threshold", "enabled", "tags"],
						},
						execute,
						"Process stats with richer schema types",
					),
				]),
			]),
		);
		await registry.register(createServerEntry("metrics", "metrics"));
		const router = new ToolRouter(registry.getAllTools());

		const valid = await router.execute({
			id: "stats-ok",
			name: "stats",
			arguments: {
				threshold: 0.75,
				enabled: true,
				tags: ["alpha", "beta"],
			},
		});
		const invalid = await router.execute({
			id: "stats-bad",
			name: "stats",
			arguments: {
				threshold: "0.75",
				enabled: true,
				tags: ["alpha"],
			},
		});

		expect(valid.isError).toBe(false);
		expect(execute).toHaveBeenCalledWith({
			threshold: 0.75,
			enabled: true,
			tags: ["alpha", "beta"],
		});
		expect(invalid.isError).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("disconnectAll closes every MCP connection and removes MCP tools while keeping builtins", async () => {
		const memoryClient = createFakeClient([
			createSchemaBackedTool(
				"memory_recall",
				{
					type: "object",
					properties: {
						query: { type: "string" },
					},
					required: ["query"],
				},
				async () => ({
					toolCallId: "call-1",
					content: JSON.stringify({ ok: true }),
					isError: false,
				}),
			),
		]);
		const webClient = createFakeClient([
			createSchemaBackedTool(
				"search",
				{
					type: "object",
					properties: {
						query: { type: "string" },
					},
					required: ["query"],
				},
				async () => ({
					toolCallId: "call-2",
					content: JSON.stringify({ ok: true }),
					isError: false,
				}),
			),
		]);
		const registry = new MCPRegistry(
			createFakeClientFactory([memoryClient, webClient]),
		);
		registry.registerBuiltin(createBuiltinTools());
		await registry.register(createServerEntry("omnimem", "omnimem"));
		await registry.register(createServerEntry("web", "web"));

		await registry.disconnectAll();

		expect(memoryClient.disconnect).toHaveBeenCalledTimes(1);
		expect(webClient.disconnect).toHaveBeenCalledTimes(1);
		expect(registry.findTool("omnimem/memory_recall")).toBeUndefined();
		expect(registry.findTool("web/search")).toBeUndefined();
		expect(registry.findTool("file_read")?.name).toBe("file_read");
	});
});
