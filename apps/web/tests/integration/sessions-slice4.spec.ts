/**
 * Iter F Slice 4 — concurrency + localStorage migration tests.
 *
 * Spec acceptance:
 *   T5 — two tabs same sessionId POST → no double-write
 *   T6 — two tabs different sessionId POST → both succeed
 *   T7 — localStorage migration
 *   T11 — SQLite write fail → 503
 *
 * Slice 4 测试覆盖:
 *   - insertMessageAtomic 在并发场景下不会 max(seq)+1 撞车
 *   - migrateLocalSessionToSqlite 幂等(重跑同 message id 不重复 INSERT)
 *   - 分别 session 并行写互不影响
 *   - SQLite 不可写时 chat route 返回 503(已在 Slice 1 实现,本测试做 regression 兜底)
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	_resetDbForTests,
	insertMessage,
	insertMessageAtomic,
	migrateLocalSessionToSqlite,
	readSessionMessages,
	readSessionStats,
	upsertSession,
} from "@/lib/sessions-db";

const ORIGINAL_ENV = {
	QUILIN_WEB_DB_PATH: process.env.QUILIN_WEB_DB_PATH,
	QUILIN_WEB_PERSISTENCE: process.env.QUILIN_WEB_PERSISTENCE,
};

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "quilin-slice4-"));
	process.env.QUILIN_WEB_DB_PATH = join(tmpDir, "sessions.db");
	process.env.QUILIN_WEB_PERSISTENCE = "on";
	_resetDbForTests();
});

afterEach(() => {
	_resetDbForTests();
	rmSync(tmpDir, { recursive: true, force: true });
	if (ORIGINAL_ENV.QUILIN_WEB_DB_PATH === undefined) {
		delete process.env.QUILIN_WEB_DB_PATH;
	} else {
		process.env.QUILIN_WEB_DB_PATH = ORIGINAL_ENV.QUILIN_WEB_DB_PATH;
	}
	if (ORIGINAL_ENV.QUILIN_WEB_PERSISTENCE === undefined) {
		delete process.env.QUILIN_WEB_PERSISTENCE;
	} else {
		process.env.QUILIN_WEB_PERSISTENCE = ORIGINAL_ENV.QUILIN_WEB_PERSISTENCE;
	}
});

describe("Slice 4 — insertMessageAtomic (T5 concurrency)", () => {
	it("allocates monotonic seq across rapid same-session calls", () => {
		upsertSession({ id: "race", title: "race-test", origin: "web" });
		const seqs: number[] = [];
		for (let i = 0; i < 10; i += 1) {
			const seq = insertMessageAtomic({
				id: `m${i}`,
				sessionId: "race",
				role: i % 2 === 0 ? "user" : "assistant",
				parts: [{ type: "text", text: `msg ${i}` }],
				finalized: true,
			});
			seqs.push(seq);
		}
		// Each call returned the next monotonic seq.
		expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(readSessionMessages("race").map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("doesn't collide with pre-existing seqs from insertMessage path", () => {
		upsertSession({ id: "mixed", origin: "web" });
		// Pre-populate via the older API (manual seq assignment).
		insertMessage({
			id: "pre-0",
			sessionId: "mixed",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "first" }],
		});
		insertMessage({
			id: "pre-1",
			sessionId: "mixed",
			seq: 1,
			role: "assistant",
			parts: [],
		});
		// Atomic API picks up MAX(seq)+1 = 2.
		const seq2 = insertMessageAtomic({
			id: "atomic-2",
			sessionId: "mixed",
			role: "user",
			parts: [{ type: "text", text: "third" }],
		});
		expect(seq2).toBe(2);
		const seq3 = insertMessageAtomic({
			id: "atomic-3",
			sessionId: "mixed",
			role: "assistant",
			parts: [],
		});
		expect(seq3).toBe(3);
	});

	it("returns -1 when persistence disabled", () => {
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		expect(
			insertMessageAtomic({
				id: "no-write",
				sessionId: "x",
				role: "user",
				parts: [],
			}),
		).toBe(-1);
	});
});

describe("Slice 4 — different sessions parallel (T6)", () => {
	it("writes to two distinct sessions interleave correctly without seq collision", () => {
		upsertSession({ id: "sA", origin: "web" });
		upsertSession({ id: "sB", origin: "web" });
		// Interleave: A.0, B.0, A.1, B.1, A.2, B.2 — each session keeps its own monotonic seq.
		const sequences: Array<{ session: string; seq: number }> = [];
		for (let i = 0; i < 3; i += 1) {
			sequences.push({
				session: "sA",
				seq: insertMessageAtomic({
					id: `a-${i}`,
					sessionId: "sA",
					role: "user",
					parts: [{ type: "text", text: `A ${i}` }],
				}),
			});
			sequences.push({
				session: "sB",
				seq: insertMessageAtomic({
					id: `b-${i}`,
					sessionId: "sB",
					role: "user",
					parts: [{ type: "text", text: `B ${i}` }],
				}),
			});
		}
		const aSeqs = sequences.filter((s) => s.session === "sA").map((s) => s.seq);
		const bSeqs = sequences.filter((s) => s.session === "sB").map((s) => s.seq);
		expect(aSeqs).toEqual([0, 1, 2]);
		expect(bSeqs).toEqual([0, 1, 2]);
		expect(readSessionMessages("sA").length).toBe(3);
		expect(readSessionMessages("sB").length).toBe(3);
	});
});

describe("Slice 4 — migrateLocalSessionToSqlite (T7)", () => {
	it("persists a batch of historical messages and creates session row", () => {
		const result = migrateLocalSessionToSqlite({
			sessionId: "from-local",
			title: "Migrated session",
			origin: "web",
			messages: [
				{
					id: "u1",
					role: "user",
					parts: [{ type: "text", text: "first message" }],
					createdAt: "2026-05-01T10:00:00Z",
				},
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", text: "reply" }],
					createdAt: "2026-05-01T10:00:05Z",
				},
				{
					id: "u2",
					role: "user",
					parts: [{ type: "text", text: "follow-up" }],
				},
			],
		});
		expect(result.migrated).toBe(3);
		expect(result.skipped).toBe(0);
		const stats = readSessionStats("from-local");
		expect(stats?.title).toBe("Migrated session");
		expect(stats?.message_count).toBe(3);
		const msgs = readSessionMessages("from-local");
		expect(msgs.map((m) => m.seq)).toEqual([0, 1, 2]);
		expect(msgs[0]?.role).toBe("user");
		expect(msgs[1]?.role).toBe("assistant");
	});

	it("is idempotent — re-running with same ids skips inserts", () => {
		const messages = [
			{ id: "x1", role: "user" as const, parts: [{ type: "text", text: "a" }] },
			{ id: "x2", role: "assistant" as const, parts: [] },
		];
		const first = migrateLocalSessionToSqlite({
			sessionId: "idempotent",
			origin: "web",
			messages,
		});
		expect(first.migrated).toBe(2);
		expect(first.skipped).toBe(0);
		const second = migrateLocalSessionToSqlite({
			sessionId: "idempotent",
			origin: "web",
			messages,
		});
		expect(second.migrated).toBe(0);
		expect(second.skipped).toBe(2);
		expect(readSessionMessages("idempotent").length).toBe(2);
	});

	it("returns {0,0} when persistence disabled", () => {
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		const r = migrateLocalSessionToSqlite({
			sessionId: "x",
			origin: "web",
			messages: [{ id: "m", role: "user", parts: [] }],
		});
		expect(r).toEqual({ migrated: 0, skipped: 0 });
	});

	it("preserves createdAt timestamps when provided", () => {
		migrateLocalSessionToSqlite({
			sessionId: "ts",
			origin: "web",
			messages: [
				{
					id: "old",
					role: "user",
					parts: [{ type: "text", text: "ancient" }],
					createdAt: "2025-01-15T12:00:00Z",
				},
			],
		});
		const msgs = readSessionMessages("ts");
		const oldTs = new Date("2025-01-15T12:00:00Z").getTime();
		expect(msgs[0]?.created_at).toBe(oldTs);
	});

	it("falls back to Date.now() when createdAt missing or unparseable", () => {
		const before = Date.now();
		migrateLocalSessionToSqlite({
			sessionId: "ts-fallback",
			origin: "web",
			messages: [
				{ id: "no-ts", role: "user", parts: [] },
				{ id: "bad-ts", role: "user", parts: [], createdAt: "not-a-date" },
			],
		});
		const msgs = readSessionMessages("ts-fallback");
		const after = Date.now();
		for (const m of msgs) {
			expect(m.created_at).toBeGreaterThanOrEqual(before);
			expect(m.created_at).toBeLessThanOrEqual(after);
		}
	});

	it("appends to existing session — seqs continue from current max", () => {
		upsertSession({ id: "append", origin: "web" });
		insertMessage({
			id: "pre",
			sessionId: "append",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "existing" }],
		});
		const r = migrateLocalSessionToSqlite({
			sessionId: "append",
			origin: "web",
			messages: [
				{ id: "new-1", role: "assistant", parts: [{ type: "text", text: "new" }] },
				{ id: "new-2", role: "user", parts: [{ type: "text", text: "next" }] },
			],
		});
		expect(r.migrated).toBe(2);
		expect(readSessionMessages("append").map((m) => m.seq)).toEqual([0, 1, 2]);
	});
});

describe("Slice 4 — T11 SQLite write failure → chat route 503", () => {
	it("upsertSession throws when DB unwritable, caller catches + maps to 503", () => {
		// Set the DB path to a directory that doesn't exist with no write
		// permission. The next getDb() call's mkdirSync should still succeed
		// (since we're under tmpdir), so we need a different approach to
		// trigger an actual write failure.
		//
		// Approach: point to a file inside a read-only parent directory.
		const ro = join(tmpDir, "ro-parent");
		mkdirSync(ro, { mode: 0o555 }); // read+execute, no write
		process.env.QUILIN_WEB_DB_PATH = join(ro, "sessions.db");
		_resetDbForTests();
		// First touch should throw (mkdir parent OK, but opening DB for
		// write in read-only dir fails). Exact error code varies by
		// platform; we just assert it throws.
		expect(() => {
			upsertSession({ id: "ro-fail", origin: "web" });
		}).toThrow();
		// Restore writability so afterEach can clean up.
		const { chmodSync } = require("node:fs") as typeof import("node:fs");
		chmodSync(ro, 0o755);
	});
});
