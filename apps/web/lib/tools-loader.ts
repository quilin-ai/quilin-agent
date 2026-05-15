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

interface AutoReloadWatcher {
	readonly close: () => void;
}

declare global {
	var __quilin_mcp_source_watcher__: AutoReloadWatcher | undefined;
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
	/**
	 * Active MCPRegistry instance. Stored separately so `invalidateToolsCatalog`
	 * can call `disconnectAll()` on it to terminate stdio subprocesses
	 * before respawning, ensuring new tool registrations (e.g. agent-core
	 * commits that add MCP tools) take effect without a full dev server
	 * restart.
	 */
	var __quilin_mcp_registry__: { disconnectAll: () => Promise<void> } | undefined;
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

/**
 * Force a full reload of the tools catalog. Tears down active MCP
 * stdio subprocesses (so new `@server.tool` registrations in
 * providers/memory/src/quilin_mem/server.py take effect), clears
 * both the globalThis cache and the in-flight promise, and lets
 * the next `getToolsCatalog()` rebuild from scratch.
 *
 * Wired to `GET /api/mcp?refresh=1` (and `/api/tools?refresh=1`)
 * so the operator can hit the "↻ 重新加载" button on /mcp to pick
 * up newly-added MCP tools without restarting the whole `pnpm dev`
 * stack. Idempotent — safe to call twice in a row.
 *
 * 强制重建 tools catalog:先把现有 MCPRegistry 的 stdio 子进程全部断开,
 * 再清掉 globalThis cache + in-flight promise。下次 getToolsCatalog
 * 调用会重新 spawn 所有 MCP 子进程,从而拿到最新的 @server.tool 注册。
 * 解决用户痛点:改了 quilin-mem 的 MCP tool 后必须重启整个 dev server 才能见效。
 */
/**
 * Auto-watch MCP server source dirs in dev mode and trigger
 * `invalidateToolsCatalog()` on any `.py` change. Idempotent — only
 * the first call attaches a watcher; subsequent calls are no-ops.
 * Disabled outside `NODE_ENV !== "production"` and opt-out via
 * `QUILIN_MCP_HOT_RELOAD=off`.
 *
 * The watcher debounces 300ms so a multi-file save (e.g. a single
 * commit touching 4 files) triggers exactly one invalidate. Uses
 * Node's native `fs.watch({recursive: true})` which is supported on
 * macOS and Windows (both common dev targets). Linux without
 * recursive support falls back to a top-level-only watch — still
 * better than nothing, since most edits land at the package root.
 *
 * 在 dev 模式下监视 providers/memory/src 下的 .py 文件变动 → 自动调
 * invalidateToolsCatalog,做到「改完文件立即生效,不用点重新加载也
 * 不用重启 pnpm dev」。生产模式 / 显式 QUILIN_MCP_HOT_RELOAD=off 时
 * 不开启。
 */
async function ensureMcpSourceWatcher(): Promise<void> {
	if (globalThis.__quilin_mcp_source_watcher__ != null) return;
	if (process.env.NODE_ENV === "production") return;
	if (process.env.QUILIN_MCP_HOT_RELOAD === "off") return;
	const fsModule = await import("node:fs");
	const path = await import("node:path");
	const os = await import("node:os");
	const workspaceRoot = process.cwd().replace(/\/apps\/web\/?$/, "");
	const watchDirs = [
		path.join(workspaceRoot, "providers", "memory", "src"),
		path.join(workspaceRoot, "providers", "web", "src"),
	];
	// Config files we ALSO watch: editing ~/.claude.json to add / remove
	// an MCP server should propagate without a dev-server restart. The
	// `QUILIN_CLAUDE_CONFIG` env var lets users override the path so the
	// watcher follows that override too.
	const claudeConfig = process.env.QUILIN_CLAUDE_CONFIG ?? path.join(os.homedir(), ".claude.json");
	let debounceTimer: NodeJS.Timeout | null = null;
	const trigger = (source: string, filename: string | null) => {
		// .py for Python MCP servers; .json for config; ignore anything else.
		if (filename != null) {
			const skip = !(filename.endsWith(".py") || filename.endsWith(".json") || source === "config");
			if (skip) return;
		}
		if (debounceTimer != null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			console.log(
				`[MCP hot-reload] ${source} change detected (${filename ?? "?"}) → invalidating catalog`,
			);
			void invalidateToolsCatalog();
		}, 300);
	};
	const fsWatchers: import("node:fs").FSWatcher[] = [];
	for (const dir of watchDirs) {
		try {
			const w = fsModule.watch(dir, { recursive: true }, (_event, filename) =>
				trigger("source", filename),
			);
			fsWatchers.push(w);
		} catch {
			// Directory missing or fs.watch unsupported — non-fatal, the
			// manual "↻ 重新加载" button on /mcp is still available.
		}
	}
	// Watch the .claude.json config file. Best-effort: if it doesn't exist
	// yet we just skip (user can edit later but won't get hot-reload until
	// the next server start).
	try {
		const cfgWatcher = fsModule.watch(claudeConfig, () => trigger("config", claudeConfig));
		fsWatchers.push(cfgWatcher);
	} catch {
		// File missing → no watch. The /mcp page reload button still works.
	}
	if (fsWatchers.length === 0) return;
	globalThis.__quilin_mcp_source_watcher__ = {
		close: () => {
			for (const w of fsWatchers) {
				try {
					w.close();
				} catch {
					/* ignore */
				}
			}
			if (debounceTimer != null) clearTimeout(debounceTimer);
		},
	};
	console.log(
		`[MCP hot-reload] watching ${fsWatchers.length} target(s): ${watchDirs.length} src dir(s) + .claude.json`,
	);
}

// Reference counter for in-flight tool calls. While > 0, file-watcher-
// triggered invalidates are DEFERRED so we don't kill stdio subprocesses
// that a running shell_exec / memory_recall / etc. is waiting on. The
// counter is exported so chat route can wrap its tool-call section in
// `markToolCallInFlight()` ... `markToolCallDone()`. When the counter
// drops to 0 and a deferred invalidate is queued, it fires.
//
// (Iter F iter-close cross-review HIGH 2026-05-15 — mid-flight invalidate
// would orphan tool-call promises against a torn-down subprocess.)
let inFlightToolCalls = 0;
let pendingInvalidate = false;

export function markToolCallInFlight(): void {
	inFlightToolCalls += 1;
}

export function markToolCallDone(): void {
	inFlightToolCalls = Math.max(0, inFlightToolCalls - 1);
	if (inFlightToolCalls === 0 && pendingInvalidate) {
		pendingInvalidate = false;
		void invalidateToolsCatalog();
	}
}

export async function invalidateToolsCatalog(): Promise<void> {
	// If a tool call is currently mid-flight, defer the invalidate until
	// it completes. Otherwise `disconnectAll()` would terminate the
	// underlying stdio subprocess and orphan that promise. The pending
	// flag is checked by `markToolCallDone()`.
	if (inFlightToolCalls > 0) {
		pendingInvalidate = true;
		console.log(`[MCP hot-reload] defer invalidate (${inFlightToolCalls} tool call(s) in flight)`);
		return;
	}
	const oldRegistry = globalThis.__quilin_mcp_registry__;
	globalThis.__quilin_mcp_registry__ = undefined;
	globalThis.__quilin_tools_catalog__ = undefined;
	// Best-effort wait for an in-flight build so the next caller doesn't
	// receive a half-built catalog. If it's still pending we can't cancel,
	// but clearing the cache + handle means the *next* call (after this
	// one) rebuilds; we just accept that the current in-flight one finishes
	// against the now-stale state.
	globalThis.__quilin_tools_catalog_inflight__ = undefined;
	if (oldRegistry != null) {
		try {
			await oldRegistry.disconnectAll();
		} catch {
			// Subprocess teardown failures are non-fatal — the new spawn
			// will overwrite any stale fds; reaping is the OS's job.
		}
	}
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
		// Park the live registry on globalThis so `invalidateToolsCatalog()`
		// can call `disconnectAll()` on it before the next build cycle.
		globalThis.__quilin_mcp_registry__ = registry as unknown as {
			disconnectAll: () => Promise<void>;
		};
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
	// First-build moment is the right place to attach the auto-watcher:
	// we know paths exist, dev server is up, and the user has just
	// kicked the catalog into life. `ensureMcpSourceWatcher` is
	// idempotent so repeat builds (after invalidate) are no-ops.
	void ensureMcpSourceWatcher();
	return catalog;
}
