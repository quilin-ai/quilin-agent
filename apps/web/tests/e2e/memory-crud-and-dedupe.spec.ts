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
 *   §7.5  high-priority → large dataset, recover round trip, 9→3 execute
 *   §2.8  empty store    → "empty store shows empty placeholder, hides dedupe button"
 *   §2.9  MCP off        → "MCP not connected shows reason banner"
 *   §2.10 dedupe 503     → "dedupe backend missing surfaces preview-failed message"
 *
 * 不在本 spec 内 / Out of scope:
 *   §2.1 chat-triggered memory_store — 需要 live LLM + MCP,Live 手测
 *   §2.3 inline edit — 当前 UI 没有编辑入口(GAP-4 follow-up)
 */
import { expect, type Page, type Route, test } from "@playwright/test";

// ---------- wire fixtures ----------

interface FixtureRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly layer: string | null;
	readonly createdAt: string | null;
	readonly metadata: Record<string, unknown> | null;
	readonly version?: number | null;
	readonly parentId?: string | null;
	readonly isLatest?: boolean | null;
	readonly lastWriterClient?: string | null;
	readonly projectScope?: string | null;
	readonly salience?: Record<string, unknown> | null;
	readonly kind?: string | null;
	readonly importanceScore?: number | null;
	readonly archivedAt?: string | null;
	readonly recoveredAt?: string | null;
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

function buildMemoryWire(records: readonly FixtureRecord[]): MemoryWire {
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
	return buildMemoryWire(records);
}

function buildNineDuplicateFixture(): MemoryWire {
	const groups: ReadonlyArray<readonly [string, string, string[]]> = [
		[
			"meng",
			"老孟",
			[
				"老孟在凌晨 2 点处理紧急上线",
				"孟哥(老孟)昨晚 2am 处理 prod 故障",
				"老孟习惯凌晨工作,2 am 还在写代码",
			],
		],
		[
			"ming",
			"小明",
			["小明喜欢喝咖啡,下午 3 点必喝一杯", "小明每天下午都要喝咖啡", "小明咖啡成瘾,午后两点开始喝"],
		],
		["hua", "小花", ["小花喜欢加班到很晚", "小花经常 deep work 到深夜", "小花夜猫子,半夜还在干活"]],
	];
	const records = groups.flatMap(([slug, persona, contents]) =>
		contents.map((content, index) => ({
			id: `dedupe-${slug}-${index + 1}`,
			content: `语义层 · ${content}`,
			tier: "semantic",
			layer: "semantic",
			createdAt: `2026-05-18T03:0${index}:00Z`,
			metadata: { persona, fixture: "nine-duplicate-dedupe" },
			version: 1,
			isLatest: true,
			kind: "user",
		})),
	);
	return buildMemoryWire(records);
}

function buildLargeDedupeFixture(count = 160): MemoryWire {
	const records: FixtureRecord[] = [];
	for (let i = 0; i < count; i += 1) {
		const group = Math.floor(i / 4);
		records.push({
			id: `large-dedupe-${String(i + 1).padStart(3, "0")}`,
			content: `语义层 · 大数据集 dedupe fixture 第 ${group} 组重复记忆变体 ${i % 4}`,
			tier: "semantic",
			layer: "semantic",
			createdAt: `2026-05-18T04:${String(i % 60).padStart(2, "0")}:00Z`,
			metadata: { group, fixture: "large-dedupe" },
			version: 1,
			isLatest: true,
			kind: "user",
		});
	}
	return buildMemoryWire(records);
}

function buildConflictFixture(): MemoryWire {
	return buildMemoryWire([
		{
			id: "conflict-keep",
			content: "用户偏好英文详细解释。",
			tier: "semantic",
			layer: "semantic",
			createdAt: "2026-05-21T08:00:00Z",
			metadata: {
				conflict_resolution_pending: true,
				base_record: {
					id: "conflict-keep",
					version: 7,
					content: "用户偏好中文摘要。",
				},
				writes: [
					{
						client_id: "cli",
						base_version: 7,
						content: "用户偏好中文摘要和短回复。",
					},
					{
						client_id: "web",
						base_version: 7,
						content: "用户偏好英文详细解释。",
					},
				],
				conflict_with_client: "cli",
				conflict_token: "conflict-token-keep",
			},
			version: 8,
			isLatest: true,
			lastWriterClient: "web",
		},
		{
			id: "conflict-empty",
			content: "candidate from web",
			tier: "semantic",
			layer: "semantic",
			createdAt: "2026-05-21T08:03:00Z",
			metadata: {
				conflict_resolution_pending: true,
				conflict_current_content: "",
				conflict_candidate_content: "candidate from web",
				conflict_with_client: "cli",
				conflict_token: "conflict-token-empty",
			},
			version: 9,
			isLatest: true,
			lastWriterClient: "web",
		},
		{
			id: "conflict-merge",
			content: "项目计划要先做 Web UI。",
			tier: "semantic",
			layer: "semantic",
			createdAt: "2026-05-21T08:05:00Z",
			metadata: {
				conflict_resolution_pending: true,
				conflict: {
					base: { content: "项目计划要先做核心 loop。" },
					current: { content: "项目计划要先做后端 daemon。" },
					candidate: { content: "项目计划要先做 Web UI。" },
				},
				conflict_token: "conflict-token-merge",
			},
			version: 3,
			isLatest: true,
			lastWriterClient: "web",
		},
	]);
}

/**
 * Mutable in-memory fixture for tests that need to model delete side effects.
 * Tests share a fresh instance via `installMemoryRoutes(page, store)`.
 */
class FakeMemoryStore {
	private records: FixtureRecord[];
	private readonly archived = new Map<string, FixtureRecord>();

	constructor(seed: readonly FixtureRecord[]) {
		this.records = [...seed];
	}

	snapshot(): MemoryWire {
		return buildMemoryWire(this.records);
	}

	delete(ids: readonly string[]): { requested: number; deleted: number; failed: number } {
		const idSet = new Set(ids);
		let deleted = 0;
		this.records = this.records.filter((r) => {
			if (idSet.has(r.id)) {
				deleted += 1;
				this.archived.set(r.id, {
					...r,
					archivedAt: r.archivedAt ?? "2026-05-21T00:00:00Z",
					recoveredAt: null,
				});
				return false;
			}
			return true;
		});
		return { requested: ids.length, deleted, failed: ids.length - deleted };
	}

	recover(id: string, recoveredAt = "2026-05-21T00:05:00Z"): boolean {
		const record = this.archived.get(id);
		if (record == null) return false;
		this.archived.delete(id);
		this.records.push({ ...record, recoveredAt });
		return true;
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

function buildNineToThreePlan(): ConsolidatePlan {
	const groups = ["meng", "ming", "hua"];
	return {
		proposals: groups.map((slug) => ({
			kind: "dedupe",
			tier: "semantic",
			keepId: `dedupe-${slug}-1`,
			deleteIds: [`dedupe-${slug}-2`, `dedupe-${slug}-3`],
			reason: "三条语义重复 · 保留规范记忆",
			strategy: "embedding",
			score: 0.94,
			memoryIds: [`dedupe-${slug}-1`, `dedupe-${slug}-2`, `dedupe-${slug}-3`],
		})),
		totalDelete: 6,
		totalKeep: 3,
		totalInsert: 0,
	};
}

function buildLargeDedupePlan(): ConsolidatePlan {
	const proposals: Array<ConsolidatePlan["proposals"][number]> = [];
	for (let group = 0; group < 40; group += 1) {
		const base = group * 4;
		const ids = [0, 1, 2, 3].map(
			(offset) => `large-dedupe-${String(base + offset + 1).padStart(3, "0")}`,
		);
		proposals.push({
			kind: "dedupe",
			tier: "semantic",
			keepId: ids[0],
			deleteIds: ids.slice(1),
			reason: "大数据集重复簇 · 保留第一条",
			strategy: "embedding",
			score: 0.91,
			memoryIds: ids,
		});
	}
	return {
		proposals,
		totalDelete: 120,
		totalKeep: 40,
		totalInsert: 0,
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

	test("dedupe preview handles 150+ records without timeout", async ({ page }) => {
		const store = new FakeMemoryStore(buildLargeDedupeFixture().data.records);
		await installMemoryRoutes(page, store);
		let previewCalls = 0;

		await page.route("**/api/memory/dedupe", async (route: Route) => {
			const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
			expect(body.execute).toBe(false);
			previewCalls += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: { executed: false, plan: buildLargeDedupePlan() },
				}),
			});
		});

		await page.goto("/memory");
		await expect(page.getByTestId("memory-filter")).toBeVisible();
		expect(store.count()).toBe(160);

		await page.getByTestId("memory-dedupe-button").click();

		const modal = page.getByTestId("memory-dedupe-preview");
		await expect(modal).toBeVisible({ timeout: 5_000 });
		await expect(modal.getByTestId("memory-dedupe-delete-count")).toHaveText("120");
		await expect(modal.getByTestId("memory-dedupe-keep-count")).toHaveText("40");
		await expect(modal.getByTestId("memory-dedupe-insert-count")).toHaveText("0");
		expect(previewCalls).toBe(1);
		expect(store.count()).toBe(160);
	});

	test("recover API round trip restores a soft-deleted memory within seven days", async ({
		page,
	}) => {
		const store = new FakeMemoryStore(buildListFixture().data.records);
		await installMemoryRoutes(page, store);
		const targetId = "rec-semantic-2";

		await page.route("**/api/memory/recover", async (route: Route) => {
			const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
			const memoryId =
				typeof body.memory_id === "string"
					? body.memory_id
					: typeof body.memoryId === "string"
						? body.memoryId
						: "";
			const recovered = store.recover(memoryId);
			await route.fulfill({
				status: recovered ? 200 : 404,
				contentType: "application/json",
				body: JSON.stringify(
					recovered
						? { ok: true, data: { memory_id: memoryId, recovered: true } }
						: {
								ok: false,
								error: { code: "memory_recover_failed", message: "memory not recoverable" },
							},
				),
			});
		});

		await page.goto("/memory");
		await expect(page.getByTestId(`memory-${targetId}`)).toBeVisible();

		await page.getByTestId(`memory-checkbox-${targetId}`).click();
		await page.getByTestId("memory-batch-delete").click();
		await page.getByTestId("memory-confirm-delete-confirm").click();
		await expect(page.getByTestId(`memory-${targetId}`)).toHaveCount(0);
		expect(store.count()).toBe(4);

		const recoverResult = await page.evaluate(async (memoryId) => {
			const res = await fetch("/api/memory/recover", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ memory_id: memoryId }),
			});
			return { status: res.status, body: await res.json() };
		}, targetId);

		expect(recoverResult).toMatchObject({
			status: 200,
			body: { ok: true, data: { memory_id: targetId, recovered: true } },
		});
		expect(store.count()).toBe(5);

		await page.reload();
		const restoredRow = page.getByTestId(`memory-${targetId}`);
		await expect(restoredRow).toBeVisible();
		await restoredRow.getByRole("button").click();
		await expect(page.getByTestId(`memory-detail-${targetId}`)).toContainText("已恢复");
	});

	test("dedupe execute merges nine duplicate memories into three canonical records", async ({
		page,
	}) => {
		const store = new FakeMemoryStore(buildNineDuplicateFixture().data.records);
		const plan = buildNineToThreePlan();
		await installMemoryRoutes(page, store);
		const executeValues: unknown[] = [];

		await page.route("**/api/memory/dedupe", async (route: Route) => {
			const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
			executeValues.push(body.execute);
			if (body.execute === true) {
				const deleteIds = plan.proposals.flatMap((proposal) => proposal.deleteIds);
				const result = store.delete(deleteIds);
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						ok: true,
						data: {
							executed: true,
							plan,
							deleted: result.deleted,
							failed: result.failed,
							skippedInsert: 0,
							results: deleteIds.map((id) => ({
								id,
								kind: "dedupe",
								ok: true,
								error: null,
							})),
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
					data: { executed: false, plan },
				}),
			});
		});

		await page.goto("/memory");
		await expect(page.getByTestId("memory-filter")).toBeVisible();
		expect(store.count()).toBe(9);

		await page.getByTestId("memory-dedupe-button").click();
		const modal = page.getByTestId("memory-dedupe-preview");
		await expect(modal).toBeVisible();
		await expect(modal.getByTestId("memory-dedupe-delete-count")).toHaveText("6");
		await expect(modal.getByTestId("memory-dedupe-keep-count")).toHaveText("3");

		await page.getByTestId("memory-dedupe-confirm").click();

		await expect(page.getByTestId("memory-dedupe-preview")).toHaveCount(0);
		await expect(page.getByTestId("memory-action-message")).toContainText("已删除 6 条");
		expect(store.count()).toBe(3);
		expect(executeValues).toEqual([false, true]);

		for (const id of ["dedupe-meng-1", "dedupe-ming-1", "dedupe-hua-1"]) {
			await expect(page.getByTestId(`memory-${id}`)).toBeVisible();
		}
		for (const id of [
			"dedupe-meng-2",
			"dedupe-meng-3",
			"dedupe-ming-2",
			"dedupe-ming-3",
			"dedupe-hua-2",
			"dedupe-hua-3",
		]) {
			await expect(page.getByTestId(`memory-${id}`)).toHaveCount(0);
		}
	});

	test("conflict modal resolves keep and manual merge choices", async ({ page }) => {
		const store = new FakeMemoryStore(buildConflictFixture().data.records);
		await installMemoryRoutes(page, store);
		const posts: unknown[] = [];

		await page.route("**/api/memory/resolve-conflict", async (route: Route) => {
			const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
			posts.push(body);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: {
						memoryId: body.memoryId ?? body.memory_id,
						choice: body.choice,
						resolved: true,
					},
				}),
			});
		});

		await page.goto("/memory");
		await page.getByTestId("memory-conflict-open-conflict-keep").click();
		const keepDialog = page.getByTestId("memory-conflict-dialog");
		await expect(keepDialog).toBeVisible();
		await expect(keepDialog).toContainText("用户偏好中文摘要和短回复。");
		await expect(keepDialog).toContainText("用户偏好英文详细解释。");

		await keepDialog.getByTestId("memory-conflict-keep-b").click();
		await expect(page.getByTestId("memory-conflict-dialog")).toHaveCount(0);
		await expect(page.getByTestId("memory-action-message")).toContainText("冲突已处理");

		await page.getByTestId("memory-conflict-open-conflict-empty").click();
		const emptyDialog = page.getByTestId("memory-conflict-dialog");
		await expect(emptyDialog.getByTestId("memory-conflict-version-a")).not.toContainText(
			"candidate from web",
		);
		await emptyDialog.getByTestId("memory-conflict-cancel").click();

		await page.getByTestId("memory-conflict-open-conflict-merge").click();
		const mergeDialog = page.getByTestId("memory-conflict-dialog");
		await expect(mergeDialog).toBeVisible();
		await expect(mergeDialog).toContainText("项目计划要先做后端 daemon。");
		await expect(mergeDialog).toContainText("项目计划要先做 Web UI。");

		await mergeDialog.getByTestId("memory-conflict-merge-manual").click();
		await mergeDialog
			.getByTestId("memory-conflict-manual-textarea")
			.fill("项目计划先交付 Web 冲突 UI,再补 daemon 收敛。");
		await mergeDialog.getByTestId("memory-conflict-submit-manual").click();
		await expect(page.getByTestId("memory-conflict-dialog")).toHaveCount(0);

		expect(posts).toEqual([
			{
				memoryId: "conflict-keep",
				choice: "keep_b",
				conflictToken: "conflict-token-keep",
			},
			{
				memoryId: "conflict-merge",
				choice: "merge_manual",
				mergedContent: "项目计划先交付 Web 冲突 UI,再补 daemon 收敛。",
				conflictToken: "conflict-token-merge",
			},
		]);
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
