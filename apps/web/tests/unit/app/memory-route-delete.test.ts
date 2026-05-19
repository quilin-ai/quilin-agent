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

import { DELETE } from "@/app/api/memory/route";

function buildRequest(url: string): Request {
	return new Request(url, { method: "DELETE" });
}

afterEach(() => {
	mockCatalog.rawTools = [];
});

describe("DELETE /api/memory", () => {
	it("returns 400 when ids query param is missing", async () => {
		const res = await DELETE(buildRequest("http://localhost/api/memory"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe("invalid_query");
		expect(body.error.message).toMatch(/missing/i);
	});

	it("returns 400 when ids resolves to empty after trimming", async () => {
		const res = await DELETE(buildRequest("http://localhost/api/memory?ids=%20,%20,"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("invalid_query");
	});

	it("returns 400 when ids list exceeds MAX_BATCH_DELETE (501 ids)", async () => {
		const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`).join(",");
		const res = await DELETE(buildRequest(`http://localhost/api/memory?ids=${ids}`));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
		expect(body.error.message).toMatch(/limit/i);
	});

	it("returns 503 when quilin-mem/memory_delete tool is not available", async () => {
		const res = await DELETE(buildRequest("http://localhost/api/memory?ids=a,b"));
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_delete_unavailable");
	});

	it("successfully deletes ids by calling memory_delete for each", async () => {
		const execute = vi.fn(async (args: unknown) => ({
			content: JSON.stringify({ ok: true, memory_id: (args as { memory_id: string }).memory_id }),
			isError: false,
		}));
		mockCatalog.rawTools = [{ name: "quilin-mem/memory_delete", execute }];

		const res = await DELETE(buildRequest("http://localhost/api/memory?ids=a,b,c"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				requested: number;
				deleted: number;
				failed: number;
				results: Array<{ id: string; ok: boolean }>;
			};
		};
		expect(execute).toHaveBeenCalledTimes(3);
		expect(execute).toHaveBeenCalledWith({ memory_id: "a" });
		expect(execute).toHaveBeenCalledWith({ memory_id: "b" });
		expect(execute).toHaveBeenCalledWith({ memory_id: "c" });
		expect(body.data.requested).toBe(3);
		expect(body.data.deleted).toBe(3);
		expect(body.data.failed).toBe(0);
		expect(body.data.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
	});

	it("deduplicates ids so the same id is only sent once", async () => {
		const execute = vi.fn(async () => ({
			content: "{}",
			isError: false,
		}));
		mockCatalog.rawTools = [{ name: "quilin-mem/memory_delete", execute }];

		const res = await DELETE(buildRequest("http://localhost/api/memory?ids=a,a,a,b"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: true; data: { requested: number } };
		expect(execute).toHaveBeenCalledTimes(2);
		expect(body.data.requested).toBe(2);
	});

	it("reports per-id failures without aborting the rest of the batch", async () => {
		const execute = vi.fn(async (args: unknown) => {
			const id = (args as { memory_id: string }).memory_id;
			if (id === "boom") {
				return {
					content: "store error",
					isError: true,
					error: { message: "store crashed" },
				};
			}
			return { content: "{}", isError: false };
		});
		mockCatalog.rawTools = [{ name: "quilin-mem/memory_delete", execute }];

		const res = await DELETE(buildRequest("http://localhost/api/memory?ids=a,boom,c"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				deleted: number;
				failed: number;
				results: Array<{ id: string; ok: boolean; error: string | null }>;
			};
		};
		expect(body.data.deleted).toBe(2);
		expect(body.data.failed).toBe(1);
		const boom = body.data.results.find((r) => r.id === "boom");
		expect(boom?.ok).toBe(false);
		expect(boom?.error).toContain("store crashed");
	});

	it("catches thrown errors from execute and reports them per id", async () => {
		const execute = vi.fn(async () => {
			throw new Error("network blew up");
		});
		mockCatalog.rawTools = [{ name: "quilin-mem/memory_delete", execute }];

		const res = await DELETE(buildRequest("http://localhost/api/memory?ids=a"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				deleted: number;
				failed: number;
				results: Array<{ ok: boolean; error: string | null }>;
			};
		};
		expect(body.data.deleted).toBe(0);
		expect(body.data.failed).toBe(1);
		expect(body.data.results[0]?.error).toContain("network blew up");
	});
});
