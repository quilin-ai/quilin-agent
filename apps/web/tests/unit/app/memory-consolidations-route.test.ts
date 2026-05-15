import { afterEach, describe, expect, it, vi } from "vitest";

const mockCatalog = vi.hoisted(() => ({
	rawTools: [] as Array<{
		name: string;
		execute: (args: unknown) => Promise<{
			content: unknown;
			isError: boolean;
			error?: { message: string };
		}>;
	}>,
}));

vi.mock("@/lib/tools-loader", () => ({
	getToolsCatalog: () => Promise.resolve(mockCatalog),
}));

import { GET } from "@/app/api/memory/consolidations/route";

function buildRequest(url = "http://localhost/api/memory/consolidations"): Request {
	return new Request(url);
}

afterEach(() => {
	mockCatalog.rawTools = [];
});

describe("GET /api/memory/consolidations", () => {
	it("returns unavailable payload when quilin-mem tool is missing", async () => {
		const res = await GET(buildRequest());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: { available: boolean; entries: unknown[]; total: number; reason: string };
		};
		expect(body.ok).toBe(true);
		expect(body.data.available).toBe(false);
		expect(body.data.entries).toEqual([]);
		expect(body.data.total).toBe(0);
		expect(body.data.reason).toContain("quilin-mem MCP server is not connected");
	});

	it("normalizes consolidation entries from the MCP tool", async () => {
		const execute = vi.fn(async () => ({
			isError: false,
			content: JSON.stringify({
				available: true,
				total: 2,
				entries: [
					{
						id: 7,
						task: "profile consolidation",
						dry_run: false,
						budget_decision: "allow",
						writes_performed: 1,
						created_at: "2026-05-15T05:00:00",
						schema_version: 1,
						actions: [
							{
								kind: "promote",
								target_layer: "semantic",
								reason: "stable preference",
								dry_run: false,
								writes_semantic: true,
								writes_skill: false,
								metadata: { source: "test" },
							},
							"bad action ignored",
						],
					},
					{ id: "bad", created_at: "ignored" },
				],
			}),
		}));
		mockCatalog.rawTools = [{ name: "quilin-mem/consolidation_log_recent", execute }];

		const res = await GET(buildRequest("http://localhost/api/memory/consolidations?limit=25"));
		expect(res.status).toBe(200);
		expect(execute).toHaveBeenCalledWith({ limit: 25 });
		const body = (await res.json()) as {
			ok: true;
			data: {
				available: boolean;
				total: number;
				entries: Array<{
					id: number;
					task: string;
					actions: Array<{ kind: string; metadata: Record<string, unknown> | null }>;
				}>;
			};
		};
		expect(body.data.available).toBe(true);
		expect(body.data.total).toBe(2);
		expect(body.data.entries).toHaveLength(1);
		expect(body.data.entries[0]?.id).toBe(7);
		expect(body.data.entries[0]?.task).toBe("profile consolidation");
		expect(body.data.entries[0]?.actions).toEqual([
			expect.objectContaining({ kind: "promote", metadata: { source: "test" } }),
		]);
	});

	it("rejects invalid limit query", async () => {
		const res = await GET(buildRequest("http://localhost/api/memory/consolidations?limit=0"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("invalid_query");
	});

	it("returns 502 with the MCP error message when the tool reports isError", async () => {
		const execute = vi.fn(async () => ({
			isError: true,
			content: "memory store unavailable",
			error: { message: "store crashed" },
		}));
		mockCatalog.rawTools = [{ name: "quilin-mem/consolidation_log_recent", execute }];

		const res = await GET(buildRequest());
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
		expect(body.error.code).toBe("consolidation_log_failed");
		expect(body.error.message).toBe("store crashed");
	});

	it("serializes non-string MCP error content without leaking [object Object]", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/consolidation_log_recent",
				execute: async () => ({
					isError: true,
					content: { message: "structured failure", code: "store_down" },
				}),
			},
		];

		const res = await GET(buildRequest());
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
		expect(body.error.code).toBe("consolidation_log_failed");
		expect(body.error.message).toContain("structured failure");
		expect(body.error.message).not.toBe("[object Object]");
	});

	it("returns 502 when MCP output cannot be parsed", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/consolidation_log_recent",
				execute: async () => ({ isError: false, content: "not json" }),
			},
		];
		const res = await GET(buildRequest());
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("consolidation_log_parse_failed");
	});
});
