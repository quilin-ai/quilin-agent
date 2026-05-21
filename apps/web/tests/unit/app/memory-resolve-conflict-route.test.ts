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

import { POST } from "@/app/api/memory/resolve-conflict/route";

function buildPostRequest(body: unknown): Request {
	return new Request("http://localhost/api/memory/resolve-conflict", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

afterEach(() => {
	mockCatalog.rawTools = [];
});

describe("POST /api/memory/resolve-conflict", () => {
	it("forwards keep_b to memory_resolve_conflict and returns structured JSON", async () => {
		const execute = vi.fn(async () => ({
			content: JSON.stringify({ ok: true, memory_id: "conflict-1", resolved: true }),
			isError: false,
		}));
		mockCatalog.rawTools = [{ name: "quilin-mem/memory_resolve_conflict", execute }];

		const res = await POST(buildPostRequest({ memoryId: "conflict-1", choice: "keep_b" }));

		expect(res.status).toBe(200);
		expect(execute).toHaveBeenCalledWith({
			memory_id: "conflict-1",
			decision: "keep_b",
		});
		const body = (await res.json()) as {
			ok: true;
			data: { memoryId: string; choice: string; resolved: boolean; toolName: string };
		};
		expect(body).toMatchObject({
			ok: true,
			data: {
				memoryId: "conflict-1",
				choice: "keep_b",
				resolved: true,
				toolName: "quilin-mem/memory_resolve_conflict",
			},
		});
	});

	it("falls back to resolve_conflict during provider rename windows", async () => {
		const execute = vi.fn(async () => ({ content: "{}", isError: false }));
		mockCatalog.rawTools = [{ name: "quilin-mem/resolve_conflict", execute }];

		const res = await POST(
			buildPostRequest({
				memory_id: "conflict-2",
				choice: "merge_manual",
				mergedContent: "用户偏好中文摘要,但需要保留详细上下文。",
			}),
		);

		expect(res.status).toBe(200);
		expect(execute).toHaveBeenCalledWith({
			memory_id: "conflict-2",
			decision: "merge_manual",
			merged_content: "用户偏好中文摘要,但需要保留详细上下文。",
		});
		const body = (await res.json()) as {
			ok: true;
			data: { memoryId: string; choice: string; resolved: boolean; toolName: string };
		};
		expect(body.data.toolName).toBe("quilin-mem/resolve_conflict");
		expect(body.data.resolved).toBe(true);
	});

	it("requires manual merged content for merge_manual", async () => {
		const res = await POST(buildPostRequest({ memoryId: "conflict-3", choice: "merge_manual" }));

		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("invalid_body");
	});

	it("returns 503 when no conflict resolution tool is loaded", async () => {
		const res = await POST(buildPostRequest({ memoryId: "conflict-4", choice: "keep_a" }));

		expect(res.status).toBe(503);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_resolve_conflict_unavailable");
	});
});
