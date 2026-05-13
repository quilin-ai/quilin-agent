/**
 * Coverage tests for `mcp-marketplace.ts` — pushes the file from
 * baseline ~10% toward the project's 95% coverage gate (Task #31 item
 * 5). Covers:
 *   - `McpMarketplace.search`: success, multi-source merge with dedup,
 *     failed source skip-and-continue, envelope vs array shapes,
 *     missing-name filter, alternate url-field fallbacks
 *   - `McpMarketplace.install`: success path with default + explicit
 *     targetDir, fetch failure, non-OK HTTP, malformed JSON body,
 *     EEXIST collision, generic write error, file-name fallback when
 *     URL has no path
 *   - `createMcpSearchTool`: parameter schema validation, category
 *     filter, limit clamp, default + max-limit overrides, error path
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMcpSearchTool,
	McpMarketplace,
	type McpServerEntry,
} from "./mcp-marketplace.js";

function jsonResponse(body: unknown, init?: { status?: number }): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "Content-Type": "application/json" },
	});
}

function malformedJsonResponse(): Response {
	return new Response("not-json", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("McpMarketplace.search", () => {
	it("returns parsed entries from an array-shaped response", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse([
				{
					name: "search-server",
					description: "queries",
					url: "https://example.com/srv.json",
					category: "search",
				},
			]),
		);
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("query");
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe("search-server");
		expect(results[0]?.category).toBe("search");
		expect(fetchFn).toHaveBeenCalledWith(
			"https://api.example.com/search?q=query",
		);
	});

	it("returns entries from an envelope-shaped `{ results: [...] }` response", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				results: [
					{
						name: "wrapped-server",
						description: "wrap",
						url: "https://example.com/wrap.json",
					},
				],
			}),
		);
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("any");
		expect(results.map((r) => r.name)).toEqual(["wrapped-server"]);
	});

	it("merges and deduplicates across multiple sources by url key", async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.startsWith("https://a.example.com")) {
				return jsonResponse([
					{ name: "dup", description: "x", url: "https://shared.example.com" },
					{
						name: "uniq-a",
						description: "x",
						url: "https://a-only.example.com",
					},
				]);
			}
			return jsonResponse([
				{
					name: "dup-renamed",
					description: "x",
					url: "https://shared.example.com",
				},
				{ name: "uniq-b", description: "x", url: "https://b-only.example.com" },
			]);
		});
		const market = new McpMarketplace({
			searchUrls: ["https://a.example.com", "https://b.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("q");
		// 3 entries: dup (from a), uniq-a (from a), uniq-b (from b).
		// dup-renamed from b is dropped (same url as dup).
		expect(results.map((r) => r.url).sort()).toEqual([
			"https://a-only.example.com",
			"https://b-only.example.com",
			"https://shared.example.com",
		]);
	});

	it("falls back to name as dedup key when url is missing", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse([
				{ name: "no-url", description: "n1" },
				{ name: "no-url", description: "n2" },
			]),
		);
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("any");
		expect(results).toHaveLength(1);
	});

	it("skips sources that throw and continues with the rest", async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.startsWith("https://broken")) {
				throw new Error("network down");
			}
			return jsonResponse([
				{ name: "ok", description: "x", url: "https://ok.example.com" },
			]);
		});
		const market = new McpMarketplace({
			searchUrls: ["https://broken.example.com", "https://good.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("q");
		expect(results.map((r) => r.name)).toEqual(["ok"]);
	});

	it("skips non-OK HTTP responses", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({}, { status: 503 }));
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(await market.search("q")).toEqual([]);
	});

	it("returns [] for unsupported response shapes", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ unexpected: "shape" }));
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		expect(await market.search("q")).toEqual([]);
	});

	it("filters entries with empty name", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse([
				{ name: "", description: "no-name", url: "https://a.example.com" },
				{ name: "  ", description: "blank", url: "https://b.example.com" },
				{ name: "kept", description: "k", url: "https://c.example.com" },
			]),
		);
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("q");
		expect(results.map((r) => r.name)).toEqual(["kept"]);
	});

	it("falls back to homepage / repository when url field is absent", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse([
				{
					name: "via-homepage",
					description: "h",
					homepage: "https://homepage.example.com",
				},
				{
					name: "via-repo",
					description: "r",
					repository: "https://github.com/example/repo",
				},
			]),
		);
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("any");
		const byName = new Map(results.map((r) => [r.name, r] as const));
		expect(byName.get("via-homepage")?.url).toBe(
			"https://homepage.example.com",
		);
		expect(byName.get("via-repo")?.url).toBe("https://github.com/example/repo");
	});

	it("uses name as description when description is missing", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse([{ name: "no-desc", url: "https://a.example.com" }]),
		);
		const market = new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const results = await market.search("q");
		expect(results[0]?.description).toBe("no-desc");
	});
});

describe("McpMarketplace.install", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mcp-marketplace-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("downloads and saves the config to the explicit targetDir", async () => {
		const config = { name: "test", endpoint: "https://example.com" };
		const fetchFn = vi.fn(async () => jsonResponse(config));
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const result = await market.install(
			"https://example.com/path/config.json",
			tmpDir,
		);
		expect(result.ok).toBe(true);
		expect(result.configPath).toBe(join(tmpDir, "config.json"));
		const saved = JSON.parse(
			await readFile(result.configPath as string, "utf8"),
		);
		expect(saved).toEqual(config);
	});

	it("uses a timestamped fallback filename when the URL has no last segment", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const result = await market.install("https://example.com/", tmpDir);
		expect(result.ok).toBe(true);
		expect(result.configPath).toMatch(/mcp-server-\d+\.json$/);
	});

	it("sanitizes unsafe characters in extracted file names", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const result = await market.install(
			"https://example.com/a%20b!@/uns@fe%20name.json",
			tmpDir,
		);
		expect(result.ok).toBe(true);
		// `unsafe%20name.json` → only alphanumeric, dot, dash, underscore
		// survive — `%`, `@`, etc. become `_`.
		expect(result.configPath).toMatch(/uns_fe_20name\.json$/);
	});

	it("returns ok=false when fetch throws", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("network unreachable");
		});
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const result = await market.install("https://example.com/x.json", tmpDir);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("network unreachable");
	});

	it("returns ok=false on non-OK HTTP", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({}, { status: 404 }));
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const result = await market.install("https://example.com/x.json", tmpDir);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("HTTP 404");
	});

	it("returns ok=false when the response body is not valid JSON", async () => {
		const fetchFn = vi.fn(async () => malformedJsonResponse());
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const result = await market.install("https://example.com/x.json", tmpDir);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Failed to parse MCP config JSON");
	});

	it("returns EEXIST-mapped error when the target file already exists", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const first = await market.install("https://example.com/dup.json", tmpDir);
		expect(first.ok).toBe(true);
		const second = await market.install("https://example.com/dup.json", tmpDir);
		expect(second.ok).toBe(false);
		expect(second.error).toMatch(/already exists/);
	});

	it("returns ok=false when the body is not serializable (e.g. non-JSON)", async () => {
		// Force a write error by handing install a config path inside a
		// non-writable directory. We can't easily make the OS layer fail
		// in CI; instead, simulate by using a path that exists as a file
		// (so `mkdir` succeeds on parent but the eventual write conflicts
		// with EEXIST — already covered above). Instead, use targetDir
		// pointing at a regular file to force a write error.
		const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));
		const market = new McpMarketplace({
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		// Create a file we can't recurse into.
		const filePath = join(tmpDir, "not-a-dir");
		await (await import("node:fs/promises")).writeFile(filePath, "x");
		const result = await market.install(
			"https://example.com/x.json",
			join(filePath, "child"),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Failed to write|Config file/);
	});
});

describe("createMcpSearchTool", () => {
	function makeMarket(entries: readonly McpServerEntry[]): McpMarketplace {
		return new McpMarketplace({
			searchUrls: ["https://api.example.com"],
			fetchFn: (async () => jsonResponse(entries)) as unknown as typeof fetch,
		});
	}

	it("returns a tool with the correct metadata shape", () => {
		const tool = createMcpSearchTool();
		expect(tool.name).toBe("mcp_search");
		expect(tool.category).toBe("programmatic");
		expect(tool.riskLevel).toBe("read");
		expect(typeof tool.description).toBe("string");
	});

	it("executes a default search and returns a JSON result", async () => {
		const tool = createMcpSearchTool({
			marketplace: makeMarket([
				{
					name: "alpha",
					description: "a",
					url: "https://a.example.com",
				},
			]),
		});
		const result = await tool.execute({ query: "alpha" });
		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content);
		expect(parsed.total).toBe(1);
		expect(parsed.results[0].name).toBe("alpha");
	});

	it("filters by category when category arg is provided", async () => {
		const tool = createMcpSearchTool({
			marketplace: makeMarket([
				{
					name: "alpha",
					description: "a",
					url: "https://a.example.com",
					category: "search",
				},
				{
					name: "beta",
					description: "b",
					url: "https://b.example.com",
					category: "memory",
				},
			]),
		});
		const result = await tool.execute({ query: "", category: "memory" });
		const parsed = JSON.parse(result.content);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0].name).toBe("beta");
		expect(parsed.category).toBe("memory");
	});

	it("respects the explicit limit arg", async () => {
		const entries: McpServerEntry[] = Array.from({ length: 5 }, (_, i) => ({
			name: `n-${i}`,
			description: "x",
			url: `https://${i}.example.com`,
		}));
		const tool = createMcpSearchTool({
			marketplace: makeMarket(entries),
		});
		const result = await tool.execute({ query: "*", limit: 2 });
		const parsed = JSON.parse(result.content);
		expect(parsed.results).toHaveLength(2);
		expect(parsed.total).toBe(5);
	});

	it("clamps defaultLimit by maxLimit at construction time", async () => {
		const tool = createMcpSearchTool({
			marketplace: makeMarket([
				{ name: "a", description: "", url: "https://a.example.com" },
				{ name: "b", description: "", url: "https://b.example.com" },
				{ name: "c", description: "", url: "https://c.example.com" },
			]),
			defaultLimit: 10,
			maxLimit: 2,
		});
		const result = await tool.execute({ query: "" });
		const parsed = JSON.parse(result.content);
		expect(parsed.results).toHaveLength(2);
	});

	it("returns isError=true when args don't match the schema", async () => {
		const tool = createMcpSearchTool({
			marketplace: makeMarket([]),
		});
		const result = await tool.execute({ query: 123 }); // wrong type
		expect(result.isError).toBe(true);
		const parsed = JSON.parse(result.content);
		expect(parsed.error).toBeDefined();
	});
});
