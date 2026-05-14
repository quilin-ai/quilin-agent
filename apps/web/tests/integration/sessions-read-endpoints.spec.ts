/**
 * Slice 2 read endpoints + list helper + PersistedPart→UIPart translator.
 *
 * Spec acceptance:
 *   T7 — localStorage migration (deferred — Slice 4)
 *   T8 — cross-browser visibility (list endpoint returns SQLite rows)
 *   T10 — pagination + perf (100 sessions / 50 msg each < 200ms)
 *
 * 本测试覆盖 Slice 2 的:
 *   - listSessionsForReadEndpoint 分页 / 软删除排除 / preview 派生
 *   - extractFirstTextFromParts 双 shape(UIMessage.parts / PersistedPart)
 *   - persistedPartsToUIParts 各 kind 翻译往返
 *   - GET /api/sessions handler 业务逻辑(直接调 route function)
 *   - GET /api/sessions/[id] handler 业务逻辑
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	_resetDbForTests,
	deleteSession,
	extractFirstTextFromParts,
	insertMessage,
	insertMessageIfAbsent,
	listSessionsForReadEndpoint,
	readSessionMessages,
	readSessionStats,
	upsertSession,
} from "@/lib/sessions-db";
import { persistedPartsToUIParts, type UIPart } from "@/lib/sessions-db/persisted-to-ui";

const ORIGINAL_ENV = {
	QUILIN_WEB_DB_PATH: process.env.QUILIN_WEB_DB_PATH,
	QUILIN_WEB_PERSISTENCE: process.env.QUILIN_WEB_PERSISTENCE,
};

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "quilin-slice2-"));
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

describe("Slice 2 — listSessionsForReadEndpoint", () => {
	it("returns sessions ordered by updated_at DESC with preview from latest user message", async () => {
		upsertSession({ id: "s1", title: "Session 1", origin: "web" });
		insertMessageIfAbsent({
			id: "m1u",
			sessionId: "s1",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "你好 Quilin" }],
		});
		insertMessage({
			id: "m1a",
			sessionId: "s1",
			seq: 1,
			role: "assistant",
			parts: [],
		});

		// Sleep so updated_at differs.
		await new Promise((r) => setTimeout(r, 5));
		upsertSession({ id: "s2", title: null, origin: "web" });
		insertMessageIfAbsent({
			id: "m2u",
			sessionId: "s2",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "查最新的 AI 框架" }],
		});

		const rows = listSessionsForReadEndpoint();
		expect(rows.length).toBe(2);
		// Newest first.
		expect(rows[0]?.id).toBe("s2");
		expect(rows[1]?.id).toBe("s1");
		// Preview derived from user message text.
		expect(rows[0]?.preview).toBe("查最新的 AI 框架");
		expect(rows[1]?.preview).toBe("你好 Quilin");
		// Message count includes assistant rows.
		expect(rows[0]?.message_count).toBe(1);
		expect(rows[1]?.message_count).toBe(2);
		// Title can be null (passes through).
		expect(rows[0]?.title).toBeNull();
		expect(rows[1]?.title).toBe("Session 1");
	});

	it("respects limit + offset pagination", () => {
		for (let i = 0; i < 5; i += 1) {
			upsertSession({ id: `s${i}`, title: `t${i}`, origin: "web" });
			insertMessageIfAbsent({
				id: `m${i}`,
				sessionId: `s${i}`,
				seq: 0,
				role: "user",
				parts: [{ type: "text", text: `prompt ${i}` }],
			});
		}
		const page1 = listSessionsForReadEndpoint({ limit: 2 });
		const page2 = listSessionsForReadEndpoint({ limit: 2, offset: 2 });
		const page3 = listSessionsForReadEndpoint({ limit: 2, offset: 4 });
		expect(page1.length).toBe(2);
		expect(page2.length).toBe(2);
		expect(page3.length).toBe(1);
		// No overlap.
		const ids = [...page1, ...page2, ...page3].map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("clamps invalid limits to [1, 200]", () => {
		upsertSession({ id: "s", title: "x", origin: "web" });
		expect(listSessionsForReadEndpoint({ limit: 0 }).length).toBe(1);
		expect(listSessionsForReadEndpoint({ limit: -5 }).length).toBe(1);
		// limit=500 → clamped to 200, only 1 row exists so returns 1
		expect(listSessionsForReadEndpoint({ limit: 500 }).length).toBe(1);
		expect(listSessionsForReadEndpoint({ offset: -10 }).length).toBe(1);
	});

	it("returns null preview for sessions with no user messages", () => {
		upsertSession({ id: "empty", title: "no msg yet", origin: "web" });
		const rows = listSessionsForReadEndpoint();
		expect(rows[0]?.preview).toBeNull();
		expect(rows[0]?.message_count).toBe(0);
	});

	it("handles sessions where the latest user message has only non-text parts", () => {
		upsertSession({ id: "nontext", title: "attachment-only", origin: "web" });
		insertMessageIfAbsent({
			id: "m-att",
			sessionId: "nontext",
			seq: 0,
			role: "user",
			parts: [{ type: "file", url: "data:image/png;base64,..." }],
		});
		const rows = listSessionsForReadEndpoint();
		expect(rows[0]?.preview).toBeNull();
		expect(rows[0]?.message_count).toBe(1);
	});

	it("100 sessions × 50 messages each returns list in under 200ms", () => {
		for (let i = 0; i < 100; i += 1) {
			upsertSession({ id: `s${i}`, title: `Session ${i}`, origin: "web" });
			for (let j = 0; j < 50; j += 1) {
				insertMessage({
					id: `m-${i}-${j}`,
					sessionId: `s${i}`,
					seq: j,
					role: j % 2 === 0 ? "user" : "assistant",
					parts: [{ type: "text", text: `msg ${j}` }],
				});
			}
		}
		const t0 = performance.now();
		const rows = listSessionsForReadEndpoint();
		const elapsed = performance.now() - t0;
		expect(rows.length).toBe(100);
		expect(elapsed).toBeLessThan(200);
	});
});

describe("Slice 2 — extractFirstTextFromParts", () => {
	it("returns first text from UIMessage.parts shape", () => {
		const parts = [
			{ type: "file", url: "data:..." },
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		];
		expect(extractFirstTextFromParts(parts)).toBe("hello");
	});

	it("returns first text from PersistedPart shape", () => {
		const parts = [
			{ kind: "tool", toolCallId: "x", toolName: "y", state: "input-available" },
			{ kind: "text", partId: "p1", text: "hi there", state: "done" },
		];
		expect(extractFirstTextFromParts(parts)).toBe("hi there");
	});

	it("returns null when no text part exists in either shape", () => {
		expect(extractFirstTextFromParts([])).toBeNull();
		expect(extractFirstTextFromParts([{ type: "file" }])).toBeNull();
		expect(
			extractFirstTextFromParts([
				{ kind: "tool", toolCallId: "x", toolName: "y", state: "output-available" },
			]),
		).toBeNull();
	});

	it("skips non-object entries defensively", () => {
		expect(
			extractFirstTextFromParts([null, undefined, 42, "string", { type: "text", text: "ok" }]),
		).toBe("ok");
	});
});

describe("Slice 2 — persistedPartsToUIParts translator", () => {
	it("text PersistedPart → text UIPart with state passthrough", () => {
		const out = persistedPartsToUIParts([
			{ kind: "text", partId: "p1", text: "hello", state: "done" },
		]);
		expect(out).toEqual([{ type: "text", text: "hello", state: "done" }]);
	});

	it("reasoning PersistedPart → reasoning UIPart", () => {
		const out = persistedPartsToUIParts([
			{ kind: "reasoning", partId: "r1", text: "thinking...", state: "done" },
		]);
		expect(out).toEqual([{ type: "reasoning", text: "thinking...", state: "done" }]);
	});

	it("tool PersistedPart (output-available) → dynamic-tool UIPart", () => {
		const out = persistedPartsToUIParts([
			{
				kind: "tool",
				toolCallId: "tc-1",
				toolName: "web_fetch",
				state: "output-available",
				input: { url: "https://x.com" },
				output: { ok: true },
			},
		]);
		expect(out).toEqual([
			{
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "web_fetch",
				state: "output-available",
				input: { url: "https://x.com" },
				output: { ok: true },
			},
		]);
	});

	it("tool PersistedPart (output-error) → dynamic-tool with errorText", () => {
		const out = persistedPartsToUIParts([
			{
				kind: "tool",
				toolCallId: "tc-err",
				toolName: "broken",
				state: "output-error",
				input: { x: 1 },
				errorText: "fetch failed",
			},
		]);
		expect(out).toEqual([
			{
				type: "dynamic-tool",
				toolCallId: "tc-err",
				toolName: "broken",
				state: "output-error",
				input: { x: 1 },
				errorText: "fetch failed",
			},
		]);
	});

	it("tool PersistedPart (output-error) defaults errorText if missing", () => {
		const out = persistedPartsToUIParts([
			{
				kind: "tool",
				toolCallId: "tc",
				toolName: "x",
				state: "output-error",
			},
		]);
		const tool = out[0] as Extract<UIPart, { type: "dynamic-tool" }>;
		expect(tool.errorText).toBe("tool error");
	});

	it("input-available tool (still mid-stream) preserved as-is", () => {
		const out = persistedPartsToUIParts([
			{
				kind: "tool",
				toolCallId: "tc-mid",
				toolName: "thinking",
				state: "input-available",
				input: { query: "x" },
			},
		]);
		const tool = out[0] as Extract<UIPart, { type: "dynamic-tool" }>;
		expect(tool.state).toBe("input-available");
		expect(tool.output).toBeUndefined();
	});

	it("passes UIMessage.parts shape through with text + reasoning narrowing", () => {
		const out = persistedPartsToUIParts([
			{ type: "text", text: "raw user msg" },
			{ type: "reasoning", text: "raw reasoning" },
			{ type: "file", url: "data:..." }, // unknown — dropped defensively
		]);
		expect(out).toEqual([
			{ type: "text", text: "raw user msg" },
			{ type: "reasoning", text: "raw reasoning" },
		]);
	});

	it("filters non-object / malformed entries defensively", () => {
		const out = persistedPartsToUIParts([
			null,
			undefined,
			42,
			"text",
			{ kind: "unknown-kind" },
			{ kind: "text", partId: "p1", text: "good", state: "done" },
		]);
		expect(out).toEqual([{ type: "text", text: "good", state: "done" }]);
	});
});

describe("Slice 2 — GET /api/sessions handler", () => {
	it("returns sessions list when persistence enabled", async () => {
		upsertSession({ id: "api-test", title: "via API", origin: "web" });
		insertMessageIfAbsent({
			id: "api-msg",
			sessionId: "api-test",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "from API" }],
		});

		const { GET } = await import("@/app/api/sessions/route");
		const res = await GET(new Request("http://localhost/api/sessions"));
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.persistenceEnabled).toBe(true);
		expect(body.sessions.length).toBe(1);
		expect(body.sessions[0].id).toBe("api-test");
		expect(body.sessions[0].preview).toBe("from API");
	});

	it("returns empty list with flag=false when persistence disabled", async () => {
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		const { GET } = await import("@/app/api/sessions/route");
		const res = await GET(new Request("http://localhost/api/sessions"));
		const body = await res.json();
		expect(body.persistenceEnabled).toBe(false);
		expect(body.sessions).toEqual([]);
	});

	it("400 on invalid query params", async () => {
		const { GET } = await import("@/app/api/sessions/route");
		const res = await GET(new Request("http://localhost/api/sessions?limit=abc"));
		expect(res.status).toBe(400);
	});

	it("respects ?limit=N&offset=M query params", async () => {
		for (let i = 0; i < 3; i += 1) {
			upsertSession({ id: `q${i}`, title: `Q${i}`, origin: "web" });
		}
		const { GET } = await import("@/app/api/sessions/route");
		const res = await GET(new Request("http://localhost/api/sessions?limit=2&offset=1"));
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.sessions.length).toBe(2);
	});
});

describe("Slice 2 — GET /api/sessions/[id] handler", () => {
	it("returns session metadata + translated messages", async () => {
		upsertSession({ id: "detail-test", title: "Detail", origin: "web" });
		insertMessageIfAbsent({
			id: "u",
			sessionId: "detail-test",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "hi" }],
			finalized: true,
		});
		insertMessage({
			id: "a",
			sessionId: "detail-test",
			seq: 1,
			role: "assistant",
			parts: [
				{ kind: "text", partId: "t1", text: "hello back", state: "done" },
				{
					kind: "tool",
					toolCallId: "tc1",
					toolName: "web_fetch",
					state: "output-available",
					input: { url: "x" },
					output: { ok: true },
				},
			],
			finalized: true,
		});

		const { GET } = await import("@/app/api/sessions/[id]/route");
		const res = await GET(new Request("http://localhost/api/sessions/detail-test"), {
			params: Promise.resolve({ id: "detail-test" }),
		});
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.session.id).toBe("detail-test");
		expect(body.session.message_count).toBe(2);
		expect(body.messages.length).toBe(2);
		expect(body.messages[0].role).toBe("user");
		expect(body.messages[0].parts).toEqual([{ type: "text", text: "hi" }]);
		expect(body.messages[1].role).toBe("assistant");
		expect(body.messages[1].parts[0]).toEqual({
			type: "text",
			text: "hello back",
			state: "done",
		});
		expect(body.messages[1].parts[1]).toEqual({
			type: "dynamic-tool",
			toolCallId: "tc1",
			toolName: "web_fetch",
			state: "output-available",
			input: { url: "x" },
			output: { ok: true },
		});
	});

	it("404 when session not found", async () => {
		const { GET } = await import("@/app/api/sessions/[id]/route");
		const res = await GET(new Request("http://localhost/api/sessions/missing"), {
			params: Promise.resolve({ id: "missing" }),
		});
		expect(res.status).toBe(404);
	});

	it("404 when persistence disabled", async () => {
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		const { GET } = await import("@/app/api/sessions/[id]/route");
		const res = await GET(new Request("http://localhost/api/sessions/x"), {
			params: Promise.resolve({ id: "x" }),
		});
		expect(res.status).toBe(404);
	});

	it("400 on invalid session id (empty or oversized)", async () => {
		const { GET } = await import("@/app/api/sessions/[id]/route");
		const res1 = await GET(new Request("http://localhost/api/sessions/"), {
			params: Promise.resolve({ id: "" }),
		});
		expect(res1.status).toBe(400);
		const longId = "x".repeat(201);
		const res2 = await GET(new Request(`http://localhost/api/sessions/${longId}`), {
			params: Promise.resolve({ id: longId }),
		});
		expect(res2.status).toBe(400);
	});
});

describe("Slice 3 — deleteSession helper (spec T4)", () => {
	it("hard-deletes session + cascades messages", () => {
		upsertSession({ id: "to-delete", title: "x", origin: "web" });
		insertMessageIfAbsent({
			id: "m1",
			sessionId: "to-delete",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "kept until delete" }],
		});
		insertMessage({
			id: "m2",
			sessionId: "to-delete",
			seq: 1,
			role: "assistant",
			parts: [],
		});

		expect(readSessionStats("to-delete")).toBeDefined();
		expect(readSessionMessages("to-delete").length).toBe(2);

		const removed = deleteSession("to-delete");
		expect(removed).toBe(true);

		// Session row gone.
		expect(readSessionStats("to-delete")).toBeUndefined();
		// Messages CASCADE-deleted (FK in 0001_init.sql).
		expect(readSessionMessages("to-delete").length).toBe(0);
	});

	it("returns false when session does not exist (idempotent)", () => {
		expect(deleteSession("never-existed")).toBe(false);
	});

	it("respects persistence flag — no-op when disabled", () => {
		upsertSession({ id: "p-disabled", origin: "web" });
		expect(readSessionStats("p-disabled")).toBeDefined();
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		expect(deleteSession("p-disabled")).toBe(false);
		// Row not actually removed (flag check short-circuited).
		process.env.QUILIN_WEB_PERSISTENCE = "on";
		expect(readSessionStats("p-disabled")).toBeDefined();
	});
});

describe("Slice 3 — DELETE /api/sessions/[id] handler (spec T4 + T12)", () => {
	it("removes session + returns { deleted: true }", async () => {
		upsertSession({ id: "del-api", title: "via DELETE", origin: "web" });
		insertMessageIfAbsent({
			id: "del-msg",
			sessionId: "del-api",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "hi" }],
		});

		const { DELETE } = await import("@/app/api/sessions/[id]/route");
		const res = await DELETE(
			new Request("http://localhost/api/sessions/del-api", { method: "DELETE" }),
			{ params: Promise.resolve({ id: "del-api" }) },
		);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.deleted).toBe(true);
		expect(readSessionStats("del-api")).toBeUndefined();
	});

	it("404 when session does not exist", async () => {
		const { DELETE } = await import("@/app/api/sessions/[id]/route");
		const res = await DELETE(
			new Request("http://localhost/api/sessions/nope", { method: "DELETE" }),
			{ params: Promise.resolve({ id: "nope" }) },
		);
		expect(res.status).toBe(404);
	});

	it("404 when persistence disabled", async () => {
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		const { DELETE } = await import("@/app/api/sessions/[id]/route");
		const res = await DELETE(new Request("http://localhost/api/sessions/x", { method: "DELETE" }), {
			params: Promise.resolve({ id: "x" }),
		});
		expect(res.status).toBe(404);
	});

	it("400 on invalid id (empty or oversized)", async () => {
		const { DELETE } = await import("@/app/api/sessions/[id]/route");
		const r1 = await DELETE(new Request("http://localhost/api/sessions/", { method: "DELETE" }), {
			params: Promise.resolve({ id: "" }),
		});
		expect(r1.status).toBe(400);
		const longId = "x".repeat(201);
		const r2 = await DELETE(
			new Request(`http://localhost/api/sessions/${longId}`, { method: "DELETE" }),
			{ params: Promise.resolve({ id: longId }) },
		);
		expect(r2.status).toBe(400);
	});
});

describe("Slice 3 — T3 partial-parts persisted on mid-stream crash", () => {
	it("placeholder assistant row with empty parts visible in listing after row insert without finalize", () => {
		// Slice 1 recorder inserts a placeholder assistant row immediately when
		// the run starts. If the process crashes before any text-delta lands,
		// the row stays with parts_json='[]' and finalized_at=NULL. Spec T3
		// requires this row to remain visible via the list endpoint so the
		// /sessions page can render it as a "completed-but-truncated" turn.
		upsertSession({ id: "crash-mid", title: "stream crashed", origin: "web" });
		insertMessageIfAbsent({
			id: "user-prompt",
			sessionId: "crash-mid",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "first prompt" }],
			finalized: true,
		});
		insertMessage({
			id: "assistant-partial",
			sessionId: "crash-mid",
			seq: 1,
			role: "assistant",
			parts: [], // mid-stream crash — recorder never wrote any snapshot
			finalized: false,
		});

		const stats = readSessionStats("crash-mid");
		expect(stats?.message_count).toBe(2);

		const rows = listSessionsForReadEndpoint();
		const crashed = rows.find((r) => r.id === "crash-mid");
		expect(crashed).toBeDefined();
		expect(crashed?.message_count).toBe(2);
		// Preview comes from the last user message, not the empty assistant row.
		expect(crashed?.preview).toBe("first prompt");

		// /api/sessions/[id] still returns both rows; assistant row has empty
		// parts + null finalized_at.
		const msgs = readSessionMessages("crash-mid");
		const assistant = msgs.find((m) => m.id === "assistant-partial");
		expect(assistant?.parts).toEqual([]);
		expect(assistant?.finalized_at).toBeNull();
	});
});
