import { afterEach, describe, expect, it, vi } from "vitest";

const mockCatalog = vi.hoisted(() => ({
	rawTools: [] as Array<{
		name: string;
		execute: (args: unknown) => Promise<{
			content: string;
			isError: boolean;
			error?: { message: string; code?: string };
		}>;
	}>,
}));

vi.mock("@/lib/tools-loader", () => ({
	getToolsCatalog: () => Promise.resolve(mockCatalog),
}));

import { POST } from "@/app/api/memory/dedupe/route";

function buildPostRequest(body: unknown = {}, opts?: { rawBody?: string }): Request {
	return new Request("http://localhost/api/memory/dedupe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: opts?.rawBody ?? JSON.stringify(body),
	});
}

afterEach(() => {
	mockCatalog.rawTools = [];
});

const DUPE_RECORDS = [
	{ id: "a", content: "用户叫小明", tier: "working", created_at: "2026-05-10T10:00:00Z" },
	{ id: "b", content: "用户叫小明", tier: "working", created_at: "2026-05-05T10:00:00Z" },
	{ id: "c", content: "用户叫小明", tier: "working", created_at: "2026-05-12T10:00:00Z" },
	{ id: "d", content: "unique entry", tier: "working", created_at: "2026-05-10T10:00:00Z" },
];

describe("POST /api/memory/dedupe", () => {
	it("returns 400 when body is malformed JSON", async () => {
		const res = await POST(buildPostRequest(undefined, { rawBody: "not json" }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("invalid_body");
	});

	it("returns 400 when body has wrong shape", async () => {
		const res = await POST(buildPostRequest({ execute: "yes" }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("invalid_body");
	});

	it("returns 503 when quilin-mem/memory_recall tool is unavailable", async () => {
		const res = await POST(buildPostRequest());
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_unavailable");
	});

	it("returns 502 when memory_recall reports isError", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_recall",
				execute: async () => ({
					content: "store down",
					isError: true,
					error: { message: "store crashed" },
				}),
			},
		];
		const res = await POST(buildPostRequest());
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
		expect(body.error.code).toBe("memory_recall_failed");
		expect(body.error.message).toContain("store crashed");
	});

	it("returns preview plan (execute=false) without invoking memory_delete", async () => {
		const recallExecute = vi.fn(async () => ({
			content: JSON.stringify(DUPE_RECORDS),
			isError: false,
		}));
		const deleteExecute = vi.fn(async () => ({ content: "{}", isError: false }));
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_recall", execute: recallExecute },
			{ name: "quilin-mem/memory_delete", execute: deleteExecute },
		];

		const res = await POST(buildPostRequest({ execute: false }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				executed: boolean;
				plan: { totalDelete: number; totalKeep: number; groups: Array<{ deleteIds: string[] }> };
			};
		};
		expect(body.data.executed).toBe(false);
		expect(body.data.plan.totalDelete).toBe(2);
		expect(body.data.plan.totalKeep).toBe(1);
		expect(deleteExecute).not.toHaveBeenCalled();
		expect(recallExecute).toHaveBeenCalledTimes(1);
	});

	it("executes deletions when execute=true and reports per-id outcomes", async () => {
		const recallExecute = vi.fn(async () => ({
			content: JSON.stringify(DUPE_RECORDS),
			isError: false,
		}));
		const deleteExecute = vi.fn(async () => ({ content: "{}", isError: false }));
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_recall", execute: recallExecute },
			{ name: "quilin-mem/memory_delete", execute: deleteExecute },
		];

		const res = await POST(buildPostRequest({ execute: true }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				executed: boolean;
				deleted: number;
				failed: number;
				results: Array<{ id: string; ok: boolean }>;
			};
		};
		expect(body.data.executed).toBe(true);
		expect(body.data.deleted).toBe(2);
		expect(body.data.failed).toBe(0);
		expect(deleteExecute).toHaveBeenCalledTimes(2);
		// Earliest createdAt is `b`, so we keep `b` and delete `a` and `c`.
		const calledIds = (deleteExecute.mock.calls as unknown as Array<[{ memory_id: string }]>)
			.map((c) => c[0].memory_id)
			.sort();
		expect(calledIds).toEqual(["a", "c"]);
	});

	it("returns 503 when execute=true but memory_delete is missing", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_recall",
				execute: async () => ({ content: JSON.stringify(DUPE_RECORDS), isError: false }),
			},
		];
		const res = await POST(buildPostRequest({ execute: true }));
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_delete_unavailable");
	});

	it("skips records without an id (cannot be deleted safely)", async () => {
		const records = [
			{ content: "no id here", tier: "working", created_at: "2026-05-10T10:00:00Z" },
			{ id: "x", content: "no id here", tier: "working", created_at: "2026-05-11T10:00:00Z" },
		];
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_recall",
				execute: async () => ({ content: JSON.stringify(records), isError: false }),
			},
		];
		const res = await POST(buildPostRequest({ execute: false }));
		const body = (await res.json()) as {
			ok: true;
			data: { plan: { totalDelete: number; totalKeep: number } };
		};
		// Only one record has an id — no group of >=2 → no dedupe.
		expect(body.data.plan.totalDelete).toBe(0);
		expect(body.data.plan.totalKeep).toBe(0);
	});

	it("reports execution failures on the failed counter without aborting batch", async () => {
		const recallExecute = vi.fn(async () => ({
			content: JSON.stringify(DUPE_RECORDS),
			isError: false,
		}));
		const deleteExecute = vi.fn(async (args: unknown) => {
			const id = (args as { memory_id: string }).memory_id;
			if (id === "a") {
				return { content: "fail", isError: true, error: { message: "boom" } };
			}
			return { content: "{}", isError: false };
		});
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_recall", execute: recallExecute },
			{ name: "quilin-mem/memory_delete", execute: deleteExecute },
		];

		const res = await POST(buildPostRequest({ execute: true }));
		const body = (await res.json()) as {
			ok: true;
			data: {
				deleted: number;
				failed: number;
				results: Array<{ id: string; ok: boolean; error: string | null }>;
			};
		};
		expect(body.data.deleted).toBe(1);
		expect(body.data.failed).toBe(1);
		const failed = body.data.results.find((r) => !r.ok);
		expect(failed?.id).toBe("a");
		expect(failed?.error).toContain("boom");
	});
});
