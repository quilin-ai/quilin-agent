/**
 * Memory CRUD + Dedupe — Playwright e2e (mocked).
 *
 * Verifies the /memory page wire-up against the documented testids in
 * `apps/web/app/memory/page.tsx` without booting the quilin-mem MCP backend.
 * Each test stubs `/api/memory` and/or `/api/memory/dedupe` so the run is
 * deterministic in CI and covers all branches of the UI state machine.
 *
 * 配套文档 / Companion doc:
 *   /Users/raysonmeng/repo/quilin-agent/E2E-test/memory-crud-and-dedupe.md
 *
 * 覆盖映射 / Case mapping(见文档 §4):
 *   §2.2  read           → "renders memory list with records grouped by tier"
 *   §2.4  single delete  → "single delete via checkbox + sticky bar + confirm dialog"
 *   §2.5  batch delete   → "batch delete via select-all"
 *   §2.6  dedupe preview → "dedupe preview shows three proposal kinds"
 *   §2.7  dedupe execute → "dedupe execute closes modal and refreshes list"
 *   §2.8  empty store    → "empty store shows empty placeholder, hides dedupe button"
 *   §2.9  MCP off        → "MCP not connected shows reason banner"
 *   §2.10 dedupe 503     → "dedupe backend missing surfaces preview-failed message"
 *
 * 不在本 spec 内 / Out of scope:
 *   §2.1 chat-triggered memory_store — 需要 live LLM + MCP,Live 手测
 *   §2.3 inline edit — 当前 UI 没有编辑入口(GAP-4 follow-up)
 */
import { type Page, type Route, expect, test } from "@playwright/test";

// ---------- wire fixtures ----------

interface FixtureRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly layer: string | null;
	readonly createdAt: string | null;
	readonly metadata: Record<string, unknown> | null;
}

interface MemoryWire {
	readonly ok: true;
	readonly data: {
		readonly available: boolean;
		readonly reason?: string;
		readonly records: readonly FixtureRecord[];
		readonly byTier: Record<string, readonly FixtureRecord[]>;
		readonly counts: Record<string, number>;
	};
}

/**
 * Five-record fixture covering working / episodic / semantic tiers.
 * Ids are stable so individual tests can target specific rows.
 */
function buildListFixture(): MemoryWire {
	const records: FixtureRecord[] = [
		{
			id: "rec-working-1",
			content: "工作层 · 当前任务:写 e2e 测试",
			tier: "working",
			layer: "working",
			createdAt: "2026-05-20T10:00:00Z",
			metadata: { origin: "user" },
		},
		{
			id: "rec-episodic-1",
			content: "情景层 · 老孟昨天 2am 处理 prod 故障",
			tier: "episodic",
			layer: "episodic",
			createdAt: "2026-05-19T02:00:00Z",
			metadata: { observer: "llm" },
		},
		{
			id: "rec-semantic-1",
			content: "语义层 · 老孟习惯凌晨工作",
			tier: "semantic",
			layer: "semantic",
			createdAt: "2026-05-18T03:00:00Z",
			metadata: null,
		},
		{
			id: "rec-semantic-2",
			content: "语义层 · 小明喜欢喝咖啡",
			tier: "semantic",
			layer: "semantic",
			createdAt: "2026-05-18T03:01:00Z",
			metadata: null,
		},
		{
			id: "rec-semantic-3",
			content: "语义层 · 小花夜猫子",
			tier: "semantic",
			layer: "semantic",
			createdAt: "2026-05-18T03:02:00Z",
			metadata: null,
		},
	];
	const byTier: Record<string, FixtureRecord[]> = {};
	for (const r of records) {
		const key = r.layer ?? r.tier;
		if (byTier[key] == null) byTier[key] = [];
		byTier[key].push(r);
	}
	const counts: Record<string, number> = { total: records.length };
	for (const [k, v] of Object.entries(byTier)) counts[k] = v.length;
	return { ok: true, data: { available: true, records, byTier, counts } };
}

/**
 * Mutable in-memory fixture for tests that need to model delete side effects.
 * Tests share a fresh instance via `installMemoryRoutes(page, store)`.
 */
class FakeMemoryStore {
	private records: FixtureRecord[];

	constructor(seed: readonly FixtureRecord[]) {
		this.records = [...seed];
	}

	snapshot(): MemoryWire {
		const byTier: Record<string, FixtureRecord[]> = {};
		for (const r of this.records) {
			const key = r.layer ?? r.tier;
			if (byTier[key] == null) byTier[key] = [];
			byTier[key].push(r);
		}
		const counts: Record<string, number> = { total: this.records.length };
		for (const [k, v] of Object.entries(byTier)) counts[k] = v.length;
		return { ok: true, data: { available: true, records: this.records, byTier, counts } };
	}

	delete(ids: readonly string[]): { requested: number; deleted: number; failed: number } {
		const idSet = new Set(ids);
		let deleted = 0;
		this.records = this.records.filter((r) => {
			if (idSet.has(r.id)) {
				deleted += 1;
				return false;
			}
			return true;
		});
		return { requested: ids.length, deleted, failed: ids.length - deleted };
	}

	count(): number {
		return this.records.length;
	}
}

/**
 * Install `GET /api/memory` and `DELETE /api/memory?ids=` routes that
 * proxy to the in-memory `FakeMemoryStore`. Keeps test bodies focused
 * on UI assertions rather than wire bookkeeping.
 */
async function installMemoryRoutes(page: Page, store: FakeMemoryStore): Promise<void> {
	await page.route(/\/api\/memory($|\?)/, async (route: Route) => {
		const request = route.request();
		const method = request.method();
		if (method === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(store.snapshot()),
			});
			return;
		}
		if (method === "DELETE") {
			const url = new URL(request.url());
			const idsParam = url.searchParams.get("ids") ?? "";
			const ids = idsParam
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			const result = store.delete(ids);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true, data: result }),
			});
			return;
		}
		await route.fallback();
	});
}

// ---------- dedupe fixture ----------

interface ConsolidatePlan {
	readonly proposals: ReadonlyArray<{
		readonly kind: "dedupe" | "kg-prune" | "reflect-insight";
		readonly tier: string;
		readonly keepId?: string;
		readonly deleteIds: readonly string[];
		readonly insertContent?: string;
		readonly reason: string;
		readonly strategy?: "exact" | "embedding" | "llm";
		readonly score?: number;
		readonly memoryIds: readonly string[];
	}>;
	readonly totalDelete: number;
	readonly totalKeep: number;
	readonly totalInsert: number;
}

function buildConsolidatePlan(): ConsolidatePlan {
	return {
		proposals: [
			{
				kind: "dedupe",
				tier: "semantic",
				keepId: "rec-semantic-1",
				deleteIds: ["rec-semantic-2", "rec-semantic-3"],
				reason: "三条语义重复 · 保留最早一条",
				strategy: "embedding",
				score: 0.92,
				memoryIds: ["rec-semantic-1", "rec-semantic-2", "rec-semantic-3"],
			},
			{
				kind: "kg-prune",
				tier: "semantic",
				deleteIds: ["edge-1"],
				reason: "过期任职边",
				memoryIds: ["rec-semantic-1"],
			},
			{
				kind: "reflect-insight",
				tier: "semantic",
				deleteIds: [],
				insertContent: "用户偏好凌晨工作 · 反复出现的时间模式",
				reason: "最近 7 天 episodic 抽取的语义模式",
				memoryIds: ["rec-episodic-1"],
			},
		],
		totalDelete: 3,
		totalKeep: 1,
		totalInsert: 1,
	};
}

// ---------- tests ----------

test.describe("Memory · CRUD + dedupe (mocked)", () => {
	test("renders memory list with records grouped by tier", async ({ page }) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);

		await page.goto("/memory");
		await expect(page.getByTestId("memory-view")).toBeVisible();
		// Top stats — total count uses bold text; assert via getByText fallback
		// since stats numbers live inside <strong> children.
		await expect(page.getByTestId("memory-filter")).toBeVisible();

		// Each fixture record should render its row.
		for (const id of [
			"rec-working-1",
			"rec-episodic-1",
			"rec-semantic-1",
			"rec-semantic-2",
			"rec-semantic-3",
		]) {
			await expect(page.getByTestId(`memory-${id}`)).toBeVisible();
		}

		// Tier section titles render (working / episodic / semantic).
		await expect(page.getByText(/工作 · working/)).toBeVisible();
		await expect(page.getByText(/情景 · episodic/)).toBeVisible();
		await expect(page.getByText(/语义 · semantic/)).toBeVisible();
	});

	test("single delete via checkbox + sticky bar + confirm dialog", async ({ page }) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);
		await page.goto("/memory");

		const targetId = "rec-semantic-2";
		await expect(page.getByTestId(`memory-${targetId}`)).toBeVisible();

		// Selection toggles sticky action bar.
		await page.getByTestId(`memory-checkbox-${targetId}`).click();
		await expect(page.getByTestId("memory-action-bar")).toBeVisible();
		await expect(page.getByTestId("memory-selected-count")).toHaveText("1");

		// Trigger confirm dialog.
		await page.getByTestId("memory-batch-delete").click();
		await expect(page.getByTestId("memory-confirm-delete")).toBeVisible();

		// Confirm deletion.
		await page.getByTestId("memory-confirm-delete-confirm").click();

		// Action message reflects deletion; sticky bar closes; row gone.
		await expect(page.getByTestId("memory-action-message")).toContainText("已删除 1 条");
		await expect(page.getByTestId(`memory-${targetId}`)).toHaveCount(0);
		// Store mutated: count dropped from 5 to 4.
		expect(store.count()).toBe(4);
	});

	test("batch delete via select-all", async ({ page }) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);
		await page.goto("/memory");

		// Filter to semantic tier so select-all picks 3 records, not 5.
		await page.getByRole("button", { name: /语义/ }).click();
		await page.getByTestId("memory-select-all").click();
		await expect(page.getByTestId("memory-selected-count")).toHaveText("3");

		await page.getByTestId("memory-batch-delete").click();
		await page.getByTestId("memory-confirm-delete-confirm").click();

		await expect(page.getByTestId("memory-action-message")).toContainText("已删除 3 条");
		// All three semantic rows gone.
		for (const id of ["rec-semantic-1", "rec-semantic-2", "rec-semantic-3"]) {
			await expect(page.getByTestId(`memory-${id}`)).toHaveCount(0);
		}
		expect(store.count()).toBe(2);
	});

	test("dedupe preview shows three proposal kinds", async ({ page }) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);

		await page.route("**/api/memory/dedupe", async (route: Route) => {
			const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
			// Preview path — execute=false (or undefined).
			if (body?.execute !== true) {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						ok: true,
						data: { executed: false, plan: buildConsolidatePlan() },
					}),
				});
				return;
			}
			await route.fallback();
		});

		await page.goto("/memory");
		await page.getByTestId("memory-dedupe-button").click();

		const modal = page.getByTestId("memory-dedupe-preview");
		await expect(modal).toBeVisible();
		await expect(modal.getByTestId("memory-dedupe-delete-count")).toHaveText("3");
		await expect(modal.getByTestId("memory-dedupe-keep-count")).toHaveText("1");
		await expect(modal.getByTestId("memory-dedupe-insert-count")).toHaveText("1");

		// All three proposal kinds rendered with distinct testids.
		await expect(modal.getByTestId("memory-dedupe-proposal-dedupe")).toHaveCount(1);
		await expect(modal.getByTestId("memory-dedupe-proposal-kg-prune")).toHaveCount(1);
		await expect(modal.getByTestId("memory-dedupe-proposal-reflect-insight")).toHaveCount(1);

		// Reflect-insight surfaces the new insight content body.
		await expect(modal.getByText("用户偏好凌晨工作 · 反复出现的时间模式")).toBeVisible();

		// Cancel closes the modal without mutating the store.
		await page.getByTestId("memory-dedupe-cancel").click();
		await expect(page.getByTestId("memory-dedupe-preview")).toHaveCount(0);
		expect(store.count()).toBe(5);
	});

	test("dedupe execute closes modal and refreshes list", async ({ page }) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);

		await page.route("**/api/memory/dedupe", async (route: Route) => {
			const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
			if (body?.execute === true) {
				// Mirror executePlan: dedupe deleteIds removed from store, kg-prune
				// edge ids reported deleted but don't actually live in the record
				// list, reflect-insight inserts are skipped.
				store.delete(["rec-semantic-2", "rec-semantic-3"]);
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						ok: true,
						data: {
							executed: true,
							plan: buildConsolidatePlan(),
							deleted: 3, // 2 dedupe + 1 kg-prune edge
							failed: 0,
							skippedInsert: 1,
							results: [
								{ id: "rec-semantic-2", kind: "dedupe", ok: true, error: null },
								{ id: "rec-semantic-3", kind: "dedupe", ok: true, error: null },
								{ id: "edge-1", kind: "kg-prune", ok: true, error: null },
							],
						},
					}),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: { executed: false, plan: buildConsolidatePlan() },
				}),
			});
		});

		await page.goto("/memory");
		await page.getByTestId("memory-dedupe-button").click();
		await expect(page.getByTestId("memory-dedupe-preview")).toBeVisible();

		await page.getByTestId("memory-dedupe-confirm").click();

		// Modal closes, action message reflects delete + skipped insert hint.
		await expect(page.getByTestId("memory-dedupe-preview")).toHaveCount(0);
		await expect(page.getByTestId("memory-action-message")).toContainText("已删除 3 条");
		await expect(page.getByTestId("memory-action-message")).toContainText(
			"新增 insight 1 条已跳过",
		);

		// List refreshed — two duplicates gone.
		await expect(page.getByTestId("memory-rec-semantic-2")).toHaveCount(0);
		await expect(page.getByTestId("memory-rec-semantic-3")).toHaveCount(0);
		await expect(page.getByTestId("memory-rec-semantic-1")).toBeVisible();
	});

	test("empty store shows empty placeholder, hides dedupe button", async ({ page }) => {
		await page.route("**/api/memory", async (route: Route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: { available: true, records: [], byTier: {}, counts: { total: 0 } },
				}),
			});
		});
		await page.goto("/memory");
		await expect(page.getByText("还没有任何记忆条目")).toBeVisible();
		// Dedupe button only renders inside the populated branch.
		await expect(page.getByTestId("memory-dedupe-button")).toHaveCount(0);
	});

	test("MCP not connected shows reason banner", async ({ page }) => {
		await page.route("**/api/memory", async (route: Route) => {
			if (route.request().method() !== "GET") {
				await route.fallback();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: {
						available: false,
						reason:
							"quilin-mem MCP server is not connected. Memory dashboard is unavailable. Check /mcp for connection status.",
						records: [],
						byTier: {},
						counts: { total: 0 },
					},
				}),
			});
		});
		await page.goto("/memory");
		await expect(page.getByText("quilin-mem 未连接")).toBeVisible();
		await expect(page.getByText(/MCP server is not connected/)).toBeVisible();
	});

	test("dedupe backend missing surfaces preview-failed message", async ({ page }) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);
		await page.route("**/api/memory/dedupe", async (route: Route) => {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({
					ok: false,
					error: {
						code: "memory_consolidate_plan_unavailable",
						message:
							"quilin-mem MCP server is not connected, or memory_consolidate_plan/memory_dedupe_plan tool is missing.",
					},
				}),
			});
		});

		await page.goto("/memory");
		await page.getByTestId("memory-dedupe-button").click();
		await expect(page.getByTestId("memory-action-message")).toContainText("智能整理预览失败");
		// Preview modal never appeared.
		await expect(page.getByTestId("memory-dedupe-preview")).toHaveCount(0);
	});
});
