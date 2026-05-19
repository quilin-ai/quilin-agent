import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type McpCatalogState = {
	catalog: {
		entries: Array<{
			publicName: string;
			originalName: string;
			description: string;
			source: "builtin" | "inline" | "mcp";
			mcpServer: string | null;
			inputShape: Record<string, string> | null;
		}>;
		mcpResults: Array<{
			id: string;
			transport: "stdio" | "http";
			toolCount: number;
			error: string | null;
		}>;
		adapted: Record<string, never>;
		rawTools: readonly never[];
	} | null;
	refreshing: boolean;
	stale: boolean;
	refreshedAt: string | null;
	refreshError: string | null;
};

const mockState = vi.hoisted(() => ({
	config: {} as Record<
		string,
		{
			type?: string;
			command?: string;
			args?: readonly string[];
			cwd?: string;
			url?: string;
			headers?: Record<string, string>;
		}
	>,
	state: {
		catalog: null,
		refreshing: false,
		stale: false,
		refreshedAt: null,
		refreshError: null,
	} as McpCatalogState,
	refreshToolsCatalog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mcp-loader", () => ({
	readMcpConfig: () => mockState.config,
}));

vi.mock("@/lib/tools-loader", () => ({
	peekToolsCatalogState: () => mockState.state,
	refreshToolsCatalog: () => mockState.refreshToolsCatalog(),
}));

import { GET } from "@/app/api/mcp/route";

function buildRequest(url = "http://localhost/api/mcp"): Request {
	return new Request(url);
}

function resetState(): void {
	mockState.config = {
		exa: { type: "stdio", command: "exa", args: ["--mcp"] },
	};
	mockState.state = {
		catalog: null,
		refreshing: false,
		stale: false,
		refreshedAt: null,
		refreshError: null,
	};
	mockState.refreshToolsCatalog.mockReset();
	mockState.refreshToolsCatalog.mockImplementation(async () => {
		mockState.state = {
			...mockState.state,
			refreshing: true,
			stale: mockState.state.catalog != null,
		};
	});
}

beforeEach(() => {
	resetState();
});

afterEach(() => {
	resetState();
});

describe("GET /api/mcp", () => {
	it("returns a fast refreshing snapshot when the cache is cold", async () => {
		const start = performance.now();
		const res = await GET(buildRequest());
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(100);
		expect(mockState.refreshToolsCatalog).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			ok: true;
			data: {
				servers: Array<{ id: string; status: string; toolCount: number; error: string | null }>;
				counts: {
					total: number;
					connected: number;
					failed: number;
					skipped: number;
					totalTools: number;
				};
				refreshing: boolean;
				stale: boolean;
				refreshedAt: string | null;
				refreshError: string | null;
			};
		};
		expect(body.ok).toBe(true);
		expect(body.data.refreshing).toBe(true);
		expect(body.data.stale).toBe(false);
		expect(body.data.refreshedAt).toBeNull();
		expect(body.data.refreshError).toBeNull();
		expect(body.data.counts).toEqual({
			total: 1,
			connected: 0,
			failed: 0,
			skipped: 1,
			totalTools: 0,
		});
		expect(body.data.servers).toEqual([
			expect.objectContaining({
				id: "exa",
				status: "skipped",
				toolCount: 0,
				error: null,
			}),
		]);
	});

	it("returns cached status immediately while a manual refresh is in flight", async () => {
		mockState.state = {
			catalog: {
				entries: [
					{
						publicName: "exa__web_search",
						originalName: "exa/web_search",
						description: "Search the web",
						source: "mcp",
						mcpServer: "exa",
						inputShape: { query: "string" },
					},
				],
				mcpResults: [
					{ id: "exa", transport: "stdio", toolCount: 1, error: null },
					{ id: "broken", transport: "http", toolCount: 0, error: "socket timeout" },
				],
				adapted: {},
				rawTools: [],
			},
			refreshing: false,
			stale: false,
			refreshedAt: "2026-05-20T06:00:00.000Z",
			refreshError: null,
		};

		const start = performance.now();
		const res = await GET(buildRequest("http://localhost/api/mcp?refresh=1"));
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(100);
		expect(mockState.refreshToolsCatalog).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			ok: true;
			data: {
				servers: Array<{ id: string; status: string; toolCount: number; error: string | null }>;
				counts: {
					total: number;
					connected: number;
					failed: number;
					skipped: number;
					totalTools: number;
				};
				refreshing: boolean;
				stale: boolean;
				refreshedAt: string | null;
				refreshError: string | null;
			};
		};
		expect(body.data.refreshing).toBe(true);
		expect(body.data.stale).toBe(true);
		expect(body.data.refreshedAt).toBe("2026-05-20T06:00:00.000Z");
		expect(body.data.refreshError).toBeNull();
		expect(body.data.counts).toEqual({
			total: 1,
			connected: 1,
			failed: 0,
			skipped: 0,
			totalTools: 1,
		});
		expect(body.data.servers).toEqual([
			expect.objectContaining({
				id: "exa",
				status: "connected",
				toolCount: 1,
				error: null,
			}),
		]);
	});

	it("preserves the last snapshot plus refresh error details", async () => {
		mockState.state = {
			catalog: {
				entries: [],
				mcpResults: [],
				adapted: {},
				rawTools: [],
			},
			refreshing: false,
			stale: true,
			refreshedAt: "2026-05-20T05:50:00.000Z",
			refreshError: "MCP discovery timed out on exa",
		};

		const res = await GET(buildRequest());
		const body = (await res.json()) as {
			ok: true;
			data: {
				refreshing: boolean;
				stale: boolean;
				refreshedAt: string | null;
				refreshError: string | null;
			};
		};

		expect(res.status).toBe(200);
		expect(body.data.refreshing).toBe(false);
		expect(body.data.stale).toBe(true);
		expect(body.data.refreshedAt).toBe("2026-05-20T05:50:00.000Z");
		expect(body.data.refreshError).toBe("MCP discovery timed out on exa");
	});
});
