/**
 * tests/unit/app/memory-dedupe-route.test.ts
 *
 * QUI-187(2026-05-20):覆盖 Consolidator 三类提案 wire(`memory_consolidate_plan`)
 * + 老 `memory_dedupe_plan` legacy fallback。
 *
 * QUI-185 之前的 `memory_recall + buildDedupePlan` 路径已弃用,etcd test 也跟着重写。
 * lib/memory-dedupe.test.ts 仍然测纯函数(legacy MVP 接口保留)。
 */

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

/**
 * Sample Consolidator wire plan covering all three kinds.
 * - dedupe:           keep b, delete a + c
 * - kg-prune:         delete edge ids e1 + e2
 * - reflect-insight:  insert new semantic abstraction from m1+m2
 */
const FULL_PLAN = {
	proposals: [
		{
			kind: "dedupe",
			tier: "working",
			keepId: "b",
			deleteIds: ["a", "c"],
			reason: "三条记忆语义重复 · 保留最早一条",
			strategy: "embedding",
			score: 0.92,
			memoryIds: ["a", "b", "c"],
		},
		{
			kind: "kg-prune",
			tier: "semantic",
			deleteIds: ["edge-1", "edge-2"],
			reason: "用户已离职原公司,旧任职边过期",
			memoryIds: ["m-employer"],
		},
		{
			kind: "reflect-insight",
			tier: "semantic",
			deleteIds: [],
			insertContent: "用户偏好凌晨工作 · 反复出现的时间模式",
			reason: "从最近 7 天 episodic 抽取的语义模式",
			memoryIds: ["m1", "m2", "m3"],
		},
	],
	totalDelete: 4,
	totalKeep: 1,
	totalInsert: 1,
};

describe("POST /api/memory/dedupe — Consolidator wire", () => {
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

	it("returns 503 when neither consolidate nor legacy dedupe tool is available", async () => {
		const res = await POST(buildPostRequest());
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_consolidate_plan_unavailable");
	});

	it("returns 502 when memory_consolidate_plan reports isError", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_consolidate_plan",
				execute: async () => ({
					content: "store down",
					isError: true,
					error: { message: "consolidator crashed" },
				}),
			},
		];
		const res = await POST(buildPostRequest());
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
		expect(body.error.code).toBe("memory_consolidate_plan_failed");
		expect(body.error.message).toContain("consolidator crashed");
	});

	it("returns 502 when wire content is unparseable", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_consolidate_plan",
				execute: async () => ({ content: "not json", isError: false }),
			},
		];
		const res = await POST(buildPostRequest());
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_consolidate_plan_parse_failed");
	});

	it("returns preview plan (execute=false) with all three kinds parsed", async () => {
		const planExecute = vi.fn(async () => ({
			content: JSON.stringify(FULL_PLAN),
			isError: false,
		}));
		const deleteExecute = vi.fn(async () => ({ content: "{}", isError: false }));
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_consolidate_plan", execute: planExecute },
			{ name: "quilin-mem/memory_delete", execute: deleteExecute },
		];

		const res = await POST(buildPostRequest({ execute: false }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				executed: boolean;
				plan: {
					proposals: Array<{ kind: string; deleteIds: string[]; insertContent?: string }>;
					totalDelete: number;
					totalKeep: number;
					totalInsert: number;
				};
			};
		};
		expect(body.data.executed).toBe(false);
		expect(body.data.plan.totalDelete).toBe(4);
		expect(body.data.plan.totalKeep).toBe(1);
		expect(body.data.plan.totalInsert).toBe(1);
		expect(body.data.plan.proposals.length).toBe(3);
		const kinds = body.data.plan.proposals.map((p) => p.kind).sort();
		expect(kinds).toEqual(["dedupe", "kg-prune", "reflect-insight"]);
		expect(deleteExecute).not.toHaveBeenCalled();
		expect(planExecute).toHaveBeenCalledTimes(1);
	});

	it("drops proposals with unknown kind to avoid stale schema corruption", async () => {
		const planWithJunk = {
			proposals: [
				{ kind: "dedupe", tier: "working", keepId: "b", deleteIds: ["a"], reason: "" },
				{ kind: "evil-future-kind", tier: "working", deleteIds: ["z"] },
				{ kind: "kg-prune", deleteIds: ["e1"] }, // missing tier → dropped
			],
			totalDelete: 2,
			totalKeep: 1,
			totalInsert: 0,
		};
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_consolidate_plan",
				execute: async () => ({ content: JSON.stringify(planWithJunk), isError: false }),
			},
		];
		const res = await POST(buildPostRequest({ execute: false }));
		const body = (await res.json()) as {
			ok: true;
			data: { plan: { proposals: Array<{ kind: string }> } };
		};
		expect(body.data.plan.proposals.length).toBe(1);
		expect(body.data.plan.proposals[0]?.kind).toBe("dedupe");
	});

	it("executes deletions across dedupe + kg-prune; skips reflect-insight inserts", async () => {
		const planExecute = vi.fn(async () => ({
			content: JSON.stringify(FULL_PLAN),
			isError: false,
		}));
		const deletedIds: string[] = [];
		const deleteExecute = vi.fn(async (args: unknown) => {
			const id = (args as { memory_id: string }).memory_id;
			deletedIds.push(id);
			return { content: "{}", isError: false };
		});
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_consolidate_plan", execute: planExecute },
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
				skippedInsert: number;
				results: Array<{ id: string; ok: boolean; kind: string }>;
			};
		};
		expect(body.data.executed).toBe(true);
		expect(body.data.deleted).toBe(4);
		expect(body.data.failed).toBe(0);
		expect(body.data.skippedInsert).toBe(1);
		// All four ids (a, c from dedupe + edge-1, edge-2 from kg-prune) should hit memory_delete.
		const sortedDeleted = [...deletedIds].sort();
		expect(sortedDeleted).toEqual(["a", "c", "edge-1", "edge-2"]);
		// Reflect-insight has empty deleteIds, so 4 calls total.
		expect(deleteExecute).toHaveBeenCalledTimes(4);
	});

	it("returns 503 when execute=true but memory_delete is missing", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_consolidate_plan",
				execute: async () => ({ content: JSON.stringify(FULL_PLAN), isError: false }),
			},
		];
		const res = await POST(buildPostRequest({ execute: true }));
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ok: false; error: { code: string } };
		expect(body.error.code).toBe("memory_delete_unavailable");
	});

	it("counts per-id failures without aborting batch", async () => {
		const planExecute = vi.fn(async () => ({
			content: JSON.stringify(FULL_PLAN),
			isError: false,
		}));
		const deleteExecute = vi.fn(async (args: unknown) => {
			const id = (args as { memory_id: string }).memory_id;
			if (id === "a") return { content: "fail", isError: true, error: { message: "boom" } };
			return { content: "{}", isError: false };
		});
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_consolidate_plan", execute: planExecute },
			{ name: "quilin-mem/memory_delete", execute: deleteExecute },
		];

		const res = await POST(buildPostRequest({ execute: true }));
		const body = (await res.json()) as {
			ok: true;
			data: {
				deleted: number;
				failed: number;
				results: Array<{ id: string; ok: boolean; error: string | null; kind: string }>;
			};
		};
		expect(body.data.deleted).toBe(3);
		expect(body.data.failed).toBe(1);
		const failed = body.data.results.find((r) => !r.ok);
		expect(failed?.id).toBe("a");
		expect(failed?.kind).toBe("dedupe");
		expect(failed?.error).toContain("boom");
	});

	it("forwards strategy + tier params to the consolidator tool", async () => {
		const planExecute = vi.fn(async () => ({
			content: JSON.stringify({ proposals: [], totalDelete: 0, totalKeep: 0, totalInsert: 0 }),
			isError: false,
		}));
		mockCatalog.rawTools = [{ name: "quilin-mem/memory_consolidate_plan", execute: planExecute }];
		await POST(buildPostRequest({ execute: false, tier: "semantic", strategy: "embedding" }));
		expect(planExecute).toHaveBeenCalledWith({ tier: "semantic", strategy: "embedding" });
	});
});

describe("POST /api/memory/dedupe — legacy memory_dedupe_plan fallback", () => {
	const LEGACY_PLAN = {
		groups: [
			{
				tier: "working",
				keepId: "b",
				deleteIds: ["a", "c"],
				reason: "exact-string-match",
				strategy: "exact",
				score: 1.0,
				memoryIds: ["a", "b", "c"],
			},
		],
		totalDelete: 2,
		totalKeep: 1,
	};

	it("adapts legacy `groups[]` wire into dedupe-kind proposals", async () => {
		mockCatalog.rawTools = [
			{
				name: "quilin-mem/memory_dedupe_plan",
				execute: async () => ({ content: JSON.stringify(LEGACY_PLAN), isError: false }),
			},
		];
		const res = await POST(buildPostRequest({ execute: false }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: true;
			data: {
				plan: {
					proposals: Array<{ kind: string; keepId?: string; deleteIds: string[] }>;
					totalDelete: number;
					totalKeep: number;
					totalInsert: number;
				};
			};
		};
		expect(body.data.plan.totalDelete).toBe(2);
		expect(body.data.plan.totalKeep).toBe(1);
		expect(body.data.plan.totalInsert).toBe(0);
		expect(body.data.plan.proposals.length).toBe(1);
		const first = body.data.plan.proposals[0];
		expect(first?.kind).toBe("dedupe");
		expect(first?.keepId).toBe("b");
		expect([...(first?.deleteIds ?? [])].sort()).toEqual(["a", "c"]);
	});

	it("prefers the new consolidate tool when both are present", async () => {
		const newExecute = vi.fn(async () => ({
			content: JSON.stringify({ proposals: [], totalDelete: 0, totalKeep: 0, totalInsert: 0 }),
			isError: false,
		}));
		const legacyExecute = vi.fn(async () => ({
			content: JSON.stringify(LEGACY_PLAN),
			isError: false,
		}));
		mockCatalog.rawTools = [
			{ name: "quilin-mem/memory_consolidate_plan", execute: newExecute },
			{ name: "quilin-mem/memory_dedupe_plan", execute: legacyExecute },
		];
		const res = await POST(buildPostRequest({ execute: false }));
		expect(res.status).toBe(200);
		expect(newExecute).toHaveBeenCalledTimes(1);
		expect(legacyExecute).not.toHaveBeenCalled();
	});
});
