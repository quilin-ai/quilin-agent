/**
 * Unified tool loader for the web process. Owns the single MCP registry
 * and built-in tool list shared by the chat route (`/api/chat`) and the
 * read-only catalog pages (`/api/tools`, `/api/mcp`).
 *
 * Why a separate module: previously the chat route held its own cached
 * `loadBuiltinTools()` closure, which meant the /tools and /mcp pages
 * couldn't see the same data without spawning a second MCP registry
 * (= second copy of every stdio subprocess). Lifting the cache to
 * `globalThis` lets every route share one registry.
 *
 * 统一工具加载器:把原本散在 chat route 内部的 MCP 注册表和 builtin 工具
 * 集合提到 globalThis 上,/api/tools / /api/mcp 直接读同一份,避免多次启动
 * MCP stdio 子进程。
 */

import type { Tool as AiSdkTool } from "ai";
import { adaptToolsForAiSdk, sanitizeToolNameForOpenAI } from "@/lib/agent-core-tool-adapter";
import { loadMcpRegistry } from "@/lib/mcp-loader";
import { getSkillsManager } from "@/lib/skills-loader";

/**
 * Local mirror of `agent-core`'s `Tool` shape — agent-core ships JS only
 * (no `.d.ts`), so we describe the contract inline.
 */
export interface AgentCoreToolMetadata {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
}

export interface AgentCoreToolExecutable extends AgentCoreToolMetadata {
	readonly execute: (args: unknown) => Promise<{
		readonly content: string;
		readonly isError: boolean;
		readonly error?: { readonly message: string; readonly code?: string };
	}>;
}

interface MCPServerResult {
	readonly id: string;
	readonly transport: "stdio" | "http";
	readonly toolCount: number;
	readonly error: string | null;
}

export interface ToolEntry {
	/** Sanitized name actually exposed to the LLM (`exa__web_search`). */
	readonly publicName: string;
	/** Original agent-core / MCP-namespaced name (`exa/web_search`). */
	readonly originalName: string;
	readonly description: string;
	readonly source: "builtin" | "inline" | "mcp";
	/** Only set when `source === "mcp"`; the MCP server id. */
	readonly mcpServer: string | null;
	/**
	 * JSON-schema-ish shape sampled from the Zod schema for display only —
	 * never used for validation. Shape: `{ shape: Record<string, string> }`
	 * where each value is the inferred Zod type tag (e.g., `ZodString`).
	 */
	readonly inputShape: Record<string, string> | null;
}

export interface ToolsCatalog {
	readonly entries: readonly ToolEntry[];
	readonly mcpResults: readonly MCPServerResult[];
	/** Adapted tool map ready to pass to AI SDK `streamText({ tools })`. */
	readonly adapted: Record<string, AiSdkTool>;
	/**
	 * Raw agent-core tools (with their `execute` methods). Other web
	 * routes (e.g. /api/memory) call these directly when they need to
	 * invoke a specific MCP tool rather than going through the LLM.
	 */
	readonly rawTools: readonly AgentCoreToolExecutable[];
}

declare global {
	var __quilin_tools_catalog__: ToolsCatalog | undefined;
	/**
	 * In-flight promise for first-time catalog construction. Prevents two
	 * concurrent first-hit requests (e.g. user opens /tools and /mcp at the
	 * same time) from both calling `loadMcpRegistry`, which would spawn
	 * duplicate stdio subprocesses and leak the registry that loses the
	 * `globalThis` write race.
	 *
	 * Concurrent callers await the same promise; only the first call does
	 * the work.
	 */
	var __quilin_tools_catalog_inflight__: Promise<ToolsCatalog> | undefined;
}

interface SkillsManagerForCreateBuiltins {
	discover(): Promise<unknown>;
}

interface AgentCoreModule {
	createBuiltinTools: (options?: {
		fileRead?: { allowedRoots?: readonly string[] };
		fileWrite?: { allowedRoots?: readonly string[] };
		fileList?: { allowedRoots?: readonly string[] };
		shellExec?: { workingDirectory?: string };
		skillsManager?: SkillsManagerForCreateBuiltins | undefined;
	}) => readonly AgentCoreToolMetadata[];
}

/**
 * Best-effort introspection of a Zod schema into a `{ field: typeTag }`
 * map for display. Walks the public `.shape` property exposed by
 * `ZodObject`. Returns `null` for non-object roots so the UI can show
 * "primitive input" instead of a misleading empty map.
 *
 * Why not the full Zod-to-JSON-Schema conversion? We just need a human
 * label per field; full conversion would pull in another dependency for
 * a use case where "ZodString" is good enough.
 */
/**
 * Read the type tag of a Zod schema in a way that works for both Zod 3
 * and Zod 4. Zod 3 uses `_def.typeName` ("ZodObject"); Zod 4 uses
 * `def.type` ("object"). We normalize both to a single string label.
 */
function readZodTypeTag(node: unknown): { readonly tag: string; readonly inner: unknown } | null {
	if (node == null || typeof node !== "object") return null;
	const z3 = (node as { _def?: { typeName?: string; innerType?: unknown } })._def;
	if (z3?.typeName != null) {
		return { tag: z3.typeName, inner: z3.innerType };
	}
	const z4 = (node as { def?: { type?: string; innerType?: unknown } }).def;
	if (z4?.type != null) {
		return { tag: z4.type, inner: z4.innerType };
	}
	return null;
}

function isObjectTag(tag: string): boolean {
	return tag === "ZodObject" || tag === "object";
}

function isWrapperTag(tag: string): boolean {
	return (
		tag === "ZodOptional" ||
		tag === "ZodNullable" ||
		tag === "ZodDefault" ||
		tag === "ZodEffects" ||
		tag === "optional" ||
		tag === "nullable" ||
		tag === "default" ||
		tag === "pipe"
	);
}

function sniffInputShape(parameters: unknown): Record<string, string> | null {
	if (parameters == null || typeof parameters !== "object") return null;
	const probe = readZodTypeTag(parameters);
	if (probe == null) return null;
	if (!isObjectTag(probe.tag)) {
		if (isWrapperTag(probe.tag) && probe.inner != null) {
			return sniffInputShape(probe.inner);
		}
		return null;
	}
	const root = parameters as { shape?: unknown };
	const shape =
		typeof root.shape === "function"
			? (root.shape as () => Record<string, unknown>)()
			: (root.shape as Record<string, unknown> | undefined);
	if (shape == null) return null;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(shape)) {
		out[k] = describeZodLeaf(v);
	}
	return out;
}

function describeZodLeaf(node: unknown): string {
	const probe = readZodTypeTag(node);
	if (probe == null) return "unknown";
	if (isWrapperTag(probe.tag) && probe.inner != null) {
		return `${describeZodLeaf(probe.inner)}?`;
	}
	if (probe.tag.startsWith("Zod")) return probe.tag.slice(3);
	return probe.tag;
}

function classifyTool(name: string): {
	readonly source: ToolEntry["source"];
	readonly mcpServer: string | null;
} {
	if (name.includes("/")) {
		const idx = name.indexOf("/");
		return { source: "mcp", mcpServer: name.slice(0, idx) };
	}
	return { source: "builtin", mcpServer: null };
}

export async function getToolsCatalog(): Promise<ToolsCatalog> {
	const cached = globalThis.__quilin_tools_catalog__;
	// Hot-reload during dev can leave a cache from a previous catalog
	// shape (e.g. before `rawTools` was added). Detect by presence of
	// the latest required field and rebuild rather than throwing later.
	if (cached != null && cached.rawTools != null) {
		return cached;
	}
	// Coalesce concurrent first-hit callers onto a single in-flight
	// build so we don't spawn duplicate MCP registries (one stdio
	// subprocess per server, per duplicate registry).
	const inflight = globalThis.__quilin_tools_catalog_inflight__;
	if (inflight != null) {
		return inflight;
	}
	const buildPromise = buildToolsCatalog();
	globalThis.__quilin_tools_catalog_inflight__ = buildPromise;
	try {
		const catalog = await buildPromise;
		return catalog;
	} finally {
		// Clear the in-flight handle regardless of outcome. On success
		// the cache is populated; on failure the next caller retries.
		if (globalThis.__quilin_tools_catalog_inflight__ === buildPromise) {
			globalThis.__quilin_tools_catalog_inflight__ = undefined;
		}
	}
}

async function buildToolsCatalog(): Promise<ToolsCatalog> {
	const mod = (await import(
		/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ "@quilin/agent-core"
	)) as AgentCoreModule;

	const workspaceRoot = process.cwd().replace(/\/apps\/web\/?$/, "");
	const envRoots = (process.env.QUILIN_WEB_ALLOWED_ROOTS ?? "")
		.split(":")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const allowedRoots =
		envRoots.length > 0 ? envRoots : [workspaceRoot, process.env.HOME ?? process.cwd()];

	const { manager: skillsManager } = await getSkillsManager();
	const builtins = mod.createBuiltinTools({
		fileRead: { allowedRoots },
		fileWrite: { allowedRoots },
		fileList: { allowedRoots },
		shellExec: { workingDirectory: workspaceRoot },
		skillsManager: skillsManager as unknown as SkillsManagerForCreateBuiltins,
	});

	let mcpTools: readonly AgentCoreToolMetadata[] = [];
	let mcpResults: readonly MCPServerResult[] = [];
	try {
		const { registry, results } = await loadMcpRegistry(
			mod as unknown as Parameters<typeof loadMcpRegistry>[0],
		);
		mcpTools = registry.getAllTools() as readonly AgentCoreToolMetadata[];
		mcpResults = results;
		const ok = results.filter((r) => r.error == null).length;
		console.log(
			`[TOOLS] catalog ready: ${builtins.length} builtin + ${mcpTools.length} mcp tools (${ok}/${results.length} servers)`,
		);
	} catch (e) {
		console.log(`[TOOLS] MCP loader failed: ${String(e)}`);
	}

	const allTools = [...builtins, ...mcpTools];
	const entries: ToolEntry[] = allTools.map((t) => {
		const { source, mcpServer } = classifyTool(t.name);
		return {
			publicName: sanitizeToolNameForOpenAI(t.name),
			originalName: t.name,
			description: t.description,
			source,
			mcpServer,
			inputShape: sniffInputShape(t.parameters),
		};
	});

	// The agent-core / MCP tools we receive at runtime do have `execute`,
	// but our metadata interface intentionally omits it (we only describe
	// the catalog shape). Cast via `unknown` to satisfy the adapter without
	// pretending these are two different runtime types.
	const adapted = adaptToolsForAiSdk(
		allTools as unknown as Parameters<typeof adaptToolsForAiSdk>[0],
	);
	const catalog: ToolsCatalog = {
		entries,
		mcpResults,
		adapted,
		rawTools: allTools as unknown as readonly AgentCoreToolExecutable[],
	};
	globalThis.__quilin_tools_catalog__ = catalog;
	return catalog;
}
