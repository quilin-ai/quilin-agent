import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

interface McpServerView {
	readonly id: string;
	readonly status: "connected" | "failed" | "skipped";
	readonly tools: readonly { readonly originalName: string }[];
}

interface MemoryApiRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly version?: number | null;
	readonly isLatest?: boolean | null;
	readonly lastWriterClient?: string | null;
	readonly salience?: Record<string, unknown> | null;
}

interface MemoryApiResponse {
	readonly ok: boolean;
	readonly data?: {
		readonly available?: boolean;
		readonly records?: readonly MemoryApiRecord[];
	};
}

interface DedupeResponse {
	readonly ok: boolean;
	readonly data?: {
		readonly executed: boolean;
		readonly totalDelete: number;
		readonly plan: {
			readonly proposals: readonly {
				readonly kind: string;
				readonly strategy?: string;
				readonly deleteIds: readonly string[];
			}[];
		};
	};
	readonly error?: { readonly code: string; readonly message: string };
}

const LIVE_E2E_ENABLED = process.env.QUILIN_LIVE_MCP_E2E === "1";
const DB_PATH = process.env.QUILIN_MEM_DB_PATH ?? "";
const HOME_MEMORY_DB = `${process.env.HOME ?? ""}/.quilin/memory.db`;
const SAFE_DB_PATH =
	DB_PATH.length > 0 && DB_PATH !== HOME_MEMORY_DB && DB_PATH.includes("quilin-live-e2e");
let mcpReady = false;

function openMemoryDb(): Database.Database {
	if (!SAFE_DB_PATH) {
		throw new Error("live memory e2e requires QUILIN_MEM_DB_PATH under /tmp/quilin-live-e2e");
	}
	return new Database(DB_PATH);
}

function scalarNumber(sql: string, params: readonly unknown[] = []): number {
	const db = openMemoryDb();
	try {
		const row = db.prepare(sql).get(...params) as { n?: number } | undefined;
		return Number(row?.n ?? 0);
	} finally {
		db.close();
	}
}

function scalarString(sql: string, params: readonly unknown[] = []): string | null {
	const db = openMemoryDb();
	try {
		const row = db.prepare(sql).get(...params) as { value?: string | null } | undefined;
		return row?.value ?? null;
	} finally {
		db.close();
	}
}

function seedMemoryRecord(content: string, tier = "working"): string {
	const id = `live-${randomUUID()}`;
	const now = new Date().toISOString();
	const db = openMemoryDb();
	try {
		db.prepare(
			`
			INSERT INTO memory_records (
				id,
				content,
				tier,
				content_type,
				metadata_json,
				created_at,
				last_accessed,
				last_written_at,
				deleted,
				is_latest,
				version,
				strength,
				importance_score,
				last_writer_client,
				last_writer_session_id,
				salience_json
			)
			VALUES (?, ?, ?, 'text', ?, ?, ?, ?, 0, 1, 1, 1.0, 0.72, 'live-e2e', 'live-chain', ?)
			`,
		).run(
			id,
			content,
			tier,
			JSON.stringify({ schema_version: 1, source: "live_memory_chain_e2e" }),
			now,
			now,
			now,
			JSON.stringify({
				user_intent: 0.82,
				recency: 0.91,
				frequency: 0.35,
				emotional_weight: 0.2,
				task_relevance: 0.75,
				source_authority: 0.88,
			}),
		);
		db.prepare("INSERT INTO memory_records_fts (id, content, keywords) VALUES (?, ?, ?)").run(
			id,
			content,
			"live memory chain e2e",
		);
		return id;
	} finally {
		db.close();
	}
}

async function waitForMcpReady(request: APIRequestContext): Promise<void> {
	if (!mcpReady) {
		await request.get("/api/mcp?refresh=1");
	}
	await expect
		.poll(
			async () => {
				const response = await request.get("/api/mcp");
				const json = (await response.json()) as {
					readonly ok: boolean;
					readonly data?: {
						readonly refreshing: boolean;
						readonly servers: readonly McpServerView[];
					};
				};
				const server = json.data?.servers.find((entry) => entry.id === "quilin-mem");
				if (server == null) return "missing";
				const toolNames = new Set(server.tools.map((tool) => tool.originalName));
				const ready =
					json.data?.refreshing === false &&
					server.status === "connected" &&
					toolNames.has("quilin-mem/memory_recall") &&
					toolNames.has("quilin-mem/memory_delete") &&
					toolNames.has("quilin-mem/memory_consolidate_plan");
				return ready ? "connected:ready" : `${server.status}:refreshing`;
			},
			{ timeout: 90_000, intervals: [500, 1_000, 2_000] },
		)
		.toBe("connected:ready");
	mcpReady = true;
}

async function getMemoryRecords(request: APIRequestContext): Promise<readonly MemoryApiRecord[]> {
	const response = await request.get("/api/memory");
	const json = (await response.json()) as MemoryApiResponse;
	expect(json.ok).toBe(true);
	expect(json.data?.available).toBe(true);
	return json.data?.records ?? [];
}

async function consumeChatTurn(request: APIRequestContext, userText: string): Promise<void> {
	const sessionId = `live-observer-${randomUUID()}`;
	const response = await request.post("/api/chat", {
		data: {
			id: sessionId,
			messages: [
				{
					id: `msg-${sessionId}`,
					role: "user",
					parts: [{ type: "text", text: userText }],
				},
			],
		},
		timeout: 90_000,
	});
	expect(response.ok()).toBe(true);
	await response.body();
}

async function deleteViaMemoryPage(page: Page, recordId: string): Promise<void> {
	await page.goto("/memory");
	await expect(page.getByTestId("memory-view")).toBeVisible();
	await expect(page.getByTestId("memory-filter")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId(`memory-${recordId}`)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId(`memory-checkbox-${recordId}`).click();
	await expect(page.getByTestId("memory-selected-count")).toHaveText("1");
	await page.getByTestId("memory-batch-delete").click();
	await expect(page.getByTestId("memory-confirm-delete")).toBeVisible();
	await page.getByTestId("memory-confirm-delete-confirm").click();
	await expect(page.getByTestId(`memory-${recordId}`)).toHaveCount(0, { timeout: 30_000 });
}

test.describe("Memory live chain — Web API + MCP + temp SQLite", () => {
	test.skip(!LIVE_E2E_ENABLED, "set QUILIN_LIVE_MCP_E2E=1 to run isolated live MCP e2e");
	test.skip(!SAFE_DB_PATH, "refusing to run live MCP e2e outside an isolated temp DB");

	test.beforeEach(async ({ request }) => {
		await waitForMcpReady(request);
	});

	test("recall and delete flow uses Web UI → /api/memory → quilin-mem → SQLite", async ({
		page,
		request,
	}) => {
		const t0 = Date.now();
		const content = `live chain delete sentinel ${Date.now()}`;
		const recordId = seedMemoryRecord(content, "semantic");

		const apiRecords = await getMemoryRecords(request);
		const apiRecord = apiRecords.find((record) => record.id === recordId);
		expect(apiRecord).toBeDefined();
		expect(apiRecord?.content).toBe(content);
		expect(apiRecord?.version).toBe(1);
		expect(apiRecord?.isLatest).toBe(true);
		expect(apiRecord?.lastWriterClient).toBe("live-e2e");
		expect(apiRecord?.salience?.user_intent).toBe(0.82);

		await deleteViaMemoryPage(page, recordId);

		expect(
			scalarNumber("SELECT COUNT(*) AS n FROM memory_records WHERE id = ? AND deleted = 1", [
				recordId,
			]),
		).toBe(1);
		expect(
			scalarString("SELECT archived_at AS value FROM memory_records WHERE id = ?", [recordId]),
		).toBeTruthy();
		console.info(`live recall/delete chain completed in ${Date.now() - t0}ms`);
	});

	test("chat completion records raw memory_observations through internal memory_observe", async ({
		request,
	}) => {
		const t0 = Date.now();
		const userText = `live observer sentinel ${Date.now()}`;
		const before = scalarNumber("SELECT COUNT(*) AS n FROM memory_observations");

		await consumeChatTurn(request, userText);

		await expect
			.poll(
				() =>
					scalarNumber("SELECT COUNT(*) AS n FROM memory_observations WHERE content LIKE ?", [
						`%${userText}%`,
					]),
				{ timeout: 30_000, intervals: [250, 500, 1_000] },
			)
			.toBeGreaterThan(0);
		expect(scalarNumber("SELECT COUNT(*) AS n FROM memory_observations")).toBeGreaterThan(before);
		console.info(`live chat observer chain completed in ${Date.now() - t0}ms`);
	});

	test("large dedupe preview returns exact-only proposals instead of timing out", async ({
		request,
	}) => {
		test.setTimeout(90_000);
		const t0 = Date.now();
		const duplicateContent = `live large dedupe duplicate ${Date.now()}`;
		seedMemoryRecord(duplicateContent, "semantic");
		seedMemoryRecord(duplicateContent, "semantic");
		for (let index = 0; index < 151; index += 1) {
			seedMemoryRecord(`live large dedupe unique ${Date.now()} ${index}`, "semantic");
		}

		const response = await request.post("/api/memory/dedupe", {
			data: { execute: false, strategy: "dedupe", tier: "semantic" },
			timeout: 75_000,
		});
		const elapsed = Date.now() - t0;
		expect(response.ok()).toBe(true);
		expect(elapsed).toBeLessThan(60_000);

		const json = (await response.json()) as DedupeResponse;
		expect(json.ok).toBe(true);
		expect(json.data?.executed).toBe(false);
		expect(json.data?.totalDelete).toBeGreaterThanOrEqual(1);
		expect(
			json.data?.plan.proposals.some(
				(proposal) =>
					proposal.kind === "dedupe" &&
					proposal.strategy === "exact" &&
					proposal.deleteIds.length >= 1,
			),
		).toBe(true);
		console.info(`live large dedupe preview completed in ${elapsed}ms`);
	});
});
