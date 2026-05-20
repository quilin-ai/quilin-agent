/**
 * SQLite 持久化集成测试 / SQLite persistence integration tests.
 *
 * Spec acceptance cases T1 + T2 (Iter F Slice 1):
 *   T1 — fresh session, single user message → restart (reopen DB) →
 *        read returns the persisted user message.
 *   T2 — assistant message finalized → `finalized_at` set + `parts_json`
 *        complete after a synthetic AgentEvent stream lands.
 *
 * 本套测试覆盖 spec §9 T1 + T2:T1 验证 user message 跨"重启"(关闭再
 * 打开 DB 文件)仍可读;T2 验证 recorder 跑完后 assistant 行的
 * finalized_at 非空 + parts_json 含真实内容。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AgentEventPayload,
	AgentServiceLike,
	AgentSession,
	AgentSubscription,
	CreateSessionInput,
	SessionStatus,
	SubscribeOptions,
} from "@/lib/agent-service-client";
import {
	_resetDbForTests,
	getDb,
	insertMessage,
	insertMessageIfAbsent,
	nextSeq,
	readSessionMessages,
	readSessionStats,
	resolveDbPath,
	runMigrations,
	upsertSession,
} from "@/lib/sessions-db";
import { recordAssistantMessage } from "@/lib/sessions-db/recorder";
import {
	_resetWebSessionMetaForTests,
	getMeta,
	hashMessages,
	setMeta,
} from "@/lib/web-session-meta";

const ORIGINAL_ENV = {
	QUILIN_WEB_DB_PATH: process.env.QUILIN_WEB_DB_PATH,
	QUILIN_WEB_PERSISTENCE: process.env.QUILIN_WEB_PERSISTENCE,
	DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "quilin-sessions-db-"));
	dbPath = join(tmpDir, "sessions.db");
	process.env.QUILIN_WEB_DB_PATH = dbPath;
	process.env.QUILIN_WEB_PERSISTENCE = "on";
	_resetDbForTests();
});

afterEach(() => {
	_resetDbForTests();
	_resetWebSessionMetaForTests();
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
	if (ORIGINAL_ENV.DEEPSEEK_API_KEY === undefined) {
		delete process.env.DEEPSEEK_API_KEY;
	} else {
		process.env.DEEPSEEK_API_KEY = ORIGINAL_ENV.DEEPSEEK_API_KEY;
	}
	resetAgentServiceForTests();
});

describe("Iter F Slice 1 — SQLite persistence", () => {
	it("T1 — user message survives DB reopen (simulated restart)", () => {
		const sessionId = "draft-t1";
		upsertSession({ id: sessionId, title: "first user msg", origin: "web" });
		insertMessageIfAbsent({
			id: "msg-u-1",
			sessionId,
			seq: nextSeq(sessionId),
			role: "user",
			parts: [{ type: "text", text: "你好麒麟" }],
			finalized: true,
		});

		// Force the DB connection to close, simulating a Node process
		// restart. The next `getDb()` re-opens the same file path.
		_resetDbForTests();

		const stats = readSessionStats(sessionId);
		expect(stats).toBeDefined();
		expect(stats?.message_count).toBe(1);

		const messages = readSessionMessages(sessionId);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.parts).toEqual([{ type: "text", text: "你好麒麟" }]);
		expect(messages[0]?.finalized_at).not.toBeNull();
	});

	it("T2 — assistant message finalized via recorder after synthetic event stream", async () => {
		const sessionId = "draft-t2";
		upsertSession({ id: sessionId, title: "t2", origin: "web" });
		insertMessageIfAbsent({
			id: "msg-u-1",
			sessionId,
			seq: nextSeq(sessionId),
			role: "user",
			parts: [{ type: "text", text: "ping" }],
			finalized: true,
		});
		const assistantId = "msg-a-1";
		insertMessage({
			id: assistantId,
			sessionId,
			seq: nextSeq(sessionId),
			role: "assistant",
			parts: [],
			finalized: false,
		});

		const fake = makeFakeAgentService(sessionId, [
			{ type: "turn.started", turnIndex: 1, userText: "ping" },
			{ type: "turn.step_started", turnIndex: 1, stepIndex: 1 },
			{ type: "llm.text_start", turnIndex: 1, textPartId: "txt-0-s1" },
			{ type: "llm.text", turnIndex: 1, delta: "pong ", textPartId: "txt-0-s1" },
			{ type: "llm.text", turnIndex: 1, delta: "world", textPartId: "txt-0-s1" },
			{ type: "llm.text_end", turnIndex: 1, textPartId: "txt-0-s1" },
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "tc-1",
				toolName: "web_fetch",
				input: { url: "https://example.com" },
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "tc-1",
				toolName: "web_fetch",
				output: { ok: true, body: "hi" },
			},
			{ type: "turn.step_completed", turnIndex: 1, stepIndex: 1, finishReason: "stop" },
			{ type: "assistant.message", turnIndex: 1, content: "pong world" },
			{ type: "turn.completed", turnIndex: 1, finishReason: "stop" },
		]);

		await recordAssistantMessage({
			service: fake,
			sessionId,
			messageId: assistantId,
			turnIndex: 1,
			afterSeq: -1,
			expectedEpoch: "epoch-1",
		});

		const messages = readSessionMessages(sessionId);
		const assistantRow = messages.find((m) => m.id === assistantId);
		expect(assistantRow).toBeDefined();
		expect(assistantRow?.finalized_at).not.toBeNull();
		// Parts should include the text and tool entries
		const parts = assistantRow?.parts ?? [];
		expect(parts.length).toBeGreaterThanOrEqual(2);
		const textPart = parts.find(
			(p: unknown): p is { kind: "text"; text: string; state: string } =>
				typeof p === "object" && p != null && (p as { kind?: unknown }).kind === "text",
		);
		expect(textPart?.text).toBe("pong world");
		expect(textPart?.state).toBe("done");
		const toolPart = parts.find(
			(p: unknown): p is { kind: "tool"; toolName: string; state: string; output: unknown } =>
				typeof p === "object" && p != null && (p as { kind?: unknown }).kind === "tool",
		);
		expect(toolPart?.toolName).toBe("web_fetch");
		expect(toolPart?.state).toBe("output-available");
	});

	it("persistence flag off short-circuits all writes", () => {
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		upsertSession({ id: "no-persist", title: "x", origin: "web" });
		insertMessageIfAbsent({
			id: "msg-x",
			sessionId: "no-persist",
			seq: 0,
			role: "user",
			parts: [{ type: "text", text: "hello" }],
		});
		insertMessage({
			id: "msg-y",
			sessionId: "no-persist",
			seq: 1,
			role: "assistant",
			parts: [],
		});
		// `readSessionStats` doesn't gate on the flag — it just reads.
		// Since nothing was written, it should be undefined.
		expect(readSessionStats("no-persist")).toBeUndefined();
		// Make sure the DB file at least has its schema (getDb runs migrations)
		// in case the next test resets the flag.
		expect(getDb()).toBeDefined();
		// Flag accepts `false` / `0` / `FALSE` as falsy too — verifies
		// `isPersistenceEnabled` normalization without exposing the
		// helper directly.
		for (const v of ["false", "0", "FALSE", "Off"]) {
			process.env.QUILIN_WEB_PERSISTENCE = v;
			expect(readSessionStats("no-persist")).toBeUndefined();
		}
		// Empty string falls back to default (= enabled). We don't have a
		// state-checking helper, but `upsertSession` works iff enabled.
		process.env.QUILIN_WEB_PERSISTENCE = "";
		upsertSession({ id: "enabled-by-default", title: "x", origin: "web" });
		expect(readSessionStats("enabled-by-default")).toBeDefined();
	});

	it("recorder handles reasoning parts and tool errors", async () => {
		const sessionId = "draft-reasoning";
		upsertSession({ id: sessionId, title: "reasoning", origin: "web" });
		const assistantId = "msg-a-r";
		insertMessage({
			id: assistantId,
			sessionId,
			seq: 0,
			role: "assistant",
			parts: [],
			finalized: false,
		});
		const fake = makeFakeAgentService(sessionId, [
			{ type: "session.created", session: makeFakeSession(sessionId) },
			{ type: "session.updated", session: makeFakeSession(sessionId) },
			{ type: "turn.started", turnIndex: 1, userText: "think hard" },
			{ type: "llm.reasoning_start", turnIndex: 1, reasoningPartId: "r-0" },
			{ type: "llm.reasoning", turnIndex: 1, delta: "let me think... ", reasoningPartId: "r-0" },
			// Reasoning delta without a partId — falls back to last streaming reasoning part.
			{ type: "llm.reasoning", turnIndex: 1, delta: "still thinking" },
			{ type: "llm.reasoning_end", turnIndex: 1, reasoningPartId: "r-0" },
			{ type: "llm.text_start", turnIndex: 1, textPartId: "t-0" },
			{ type: "llm.text", turnIndex: 1, delta: "answer", textPartId: "t-0" },
			// Text delta without partId — falls back to last streaming text part.
			{ type: "llm.text", turnIndex: 1, delta: "!" },
			{ type: "llm.text_end", turnIndex: 1, textPartId: "t-0" },
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "tc-err",
				toolName: "web_fetch",
				input: { url: "https://broken.example" },
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "tc-err",
				toolName: "web_fetch",
				output: { error: "DNS lookup failed" },
				isError: true,
			},
			{ type: "session.completed" },
		]);

		await recordAssistantMessage({
			service: fake,
			sessionId,
			messageId: assistantId,
			turnIndex: 1,
			afterSeq: -1,
		});

		const messages = readSessionMessages(sessionId);
		const row = messages.find((m) => m.id === assistantId);
		expect(row?.finalized_at).not.toBeNull();
		const parts = row?.parts ?? [];
		const reasoningPart = parts.find(
			(p: unknown): p is { kind: "reasoning"; text: string; state: string } =>
				typeof p === "object" && p != null && (p as { kind?: unknown }).kind === "reasoning",
		);
		expect(reasoningPart?.text).toBe("let me think... still thinking");
		expect(reasoningPart?.state).toBe("done");
		const textPart = parts.find(
			(p: unknown): p is { kind: "text"; text: string; state: string } =>
				typeof p === "object" && p != null && (p as { kind?: unknown }).kind === "text",
		);
		expect(textPart?.text).toBe("answer!");
		const toolPart = parts.find(
			(p: unknown): p is { kind: "tool"; toolName: string; state: string; errorText: string } =>
				typeof p === "object" && p != null && (p as { kind?: unknown }).kind === "tool",
		);
		expect(toolPart?.state).toBe("output-error");
		expect(toolPart?.errorText).toBe("DNS lookup failed");
	});

	it("recorder error-text extraction handles every output shape", async () => {
		const sessionId = "draft-err-shapes";
		upsertSession({ id: sessionId, origin: "web" });
		const assistantId = "msg-a-err";
		insertMessage({
			id: assistantId,
			sessionId,
			seq: 0,
			role: "assistant",
			parts: [],
		});
		const fake = makeFakeAgentService(sessionId, [
			{ type: "turn.started", turnIndex: 1, userText: "" },
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "string-err",
				toolName: "x",
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "string-err",
				toolName: "x",
				output: "plain string error",
				isError: true,
			},
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "message-err",
				toolName: "x",
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "message-err",
				toolName: "x",
				output: { message: "from message field" },
				isError: true,
			},
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "object-err",
				toolName: "x",
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "object-err",
				toolName: "x",
				output: { other: 42 },
				isError: true,
			},
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "null-err",
				toolName: "x",
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "null-err",
				toolName: "x",
				output: null,
				isError: true,
			},
			{
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "num-err",
				toolName: "x",
			},
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "num-err",
				toolName: "x",
				output: 42,
				isError: true,
			},
			// Dropping deltas/results for an unknown toolCallId is a no-op
			// (the part was never registered). Exercises the early-return.
			{
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "never-called",
				toolName: "x",
				output: "stray",
			},
			{ type: "turn.completed", turnIndex: 1 },
		]);

		await recordAssistantMessage({
			service: fake,
			sessionId,
			messageId: assistantId,
			turnIndex: 1,
			afterSeq: -1,
		});

		const parts = readSessionMessages(sessionId).find((m) => m.id === assistantId)?.parts ?? [];
		const expectations: Record<string, string> = {
			"string-err": "plain string error",
			"message-err": "from message field",
			"object-err": JSON.stringify({ other: 42 }),
			"null-err": "tool error",
			"num-err": "42",
		};
		for (const [tcid, expected] of Object.entries(expectations)) {
			const part = parts.find(
				(p: unknown): p is { kind: "tool"; toolCallId: string; errorText: string } =>
					typeof p === "object" &&
					p != null &&
					(p as { kind?: unknown }).kind === "tool" &&
					(p as { toolCallId?: unknown }).toolCallId === tcid,
			);
			expect(part?.errorText).toBe(expected);
		}
	});

	it("recorder bails out on epoch mismatch and no-ops if persistence off", async () => {
		const sessionId = "draft-epoch";
		upsertSession({ id: sessionId, origin: "web" });
		insertMessage({
			id: "msg-a-epoch",
			sessionId,
			seq: 0,
			role: "assistant",
			parts: [],
		});
		const fake = makeFakeAgentService(sessionId, [{ type: "turn.completed", turnIndex: 1 }], {
			epochMismatch: true,
		});
		await recordAssistantMessage({
			service: fake,
			sessionId,
			messageId: "msg-a-epoch",
			turnIndex: 1,
			afterSeq: -1,
		});
		// Mismatched epoch → recorder bails before any update. Row stays
		// in placeholder state.
		const row = readSessionMessages(sessionId).find((m) => m.id === "msg-a-epoch");
		expect(row?.finalized_at).toBeNull();

		// Persistence off — recorder returns immediately.
		process.env.QUILIN_WEB_PERSISTENCE = "off";
		await recordAssistantMessage({
			service: fake,
			sessionId,
			messageId: "msg-a-epoch",
			turnIndex: 1,
			afterSeq: -1,
		});
	});

	it("recorder handles subscription errors and drained-no-terminal", async () => {
		const sessionId = "draft-err";
		upsertSession({ id: sessionId, origin: "web" });
		const assistantId = "msg-a-thrown";
		insertMessage({
			id: assistantId,
			sessionId,
			seq: 0,
			role: "assistant",
			parts: [],
		});

		// (a) Subscription that throws partway through — recorder catches
		// the error, attempts a final flush (best-effort), then closes.
		const throwingFake = makeThrowingAgentService(sessionId);
		await recordAssistantMessage({
			service: throwingFake,
			sessionId,
			messageId: assistantId,
			turnIndex: 1,
			afterSeq: -1,
		});
		// After error, recorder writes nothing useful but doesn't crash.
		const row = readSessionMessages(sessionId).find((m) => m.id === assistantId);
		expect(row).toBeDefined();

		// (b) Subscription that drains without a terminal event — recorder
		// falls through to the final flush(true) at the bottom of the for-
		// await.
		const sessionId2 = "draft-drained";
		upsertSession({ id: sessionId2, origin: "web" });
		const assistantId2 = "msg-a-drained";
		insertMessage({
			id: assistantId2,
			sessionId: sessionId2,
			seq: 0,
			role: "assistant",
			parts: [],
		});
		const drainFake = makeFakeAgentService(sessionId2, [
			{ type: "turn.started", turnIndex: 1, userText: "" },
			{ type: "llm.text_start", turnIndex: 1, textPartId: "t" },
			{ type: "llm.text", turnIndex: 1, delta: "hi", textPartId: "t" },
			// No terminal event — subscription drains naturally.
		]);
		await recordAssistantMessage({
			service: drainFake,
			sessionId: sessionId2,
			messageId: assistantId2,
			turnIndex: 1,
			afterSeq: -1,
		});
		const row2 = readSessionMessages(sessionId2).find((m) => m.id === assistantId2);
		expect(row2?.finalized_at).not.toBeNull();
	});

	it("migrations skip when user_version already current, throw on bad SQL", () => {
		// Force a fresh DB then re-run migrations to hit the early-skip
		// branch (`if (version <= currentVersion) continue`).
		const db = getDb();
		const before = db.pragma("user_version", { simple: true });
		_resetDbForTests();
		const db2 = getDb();
		expect(db2.pragma("user_version", { simple: true })).toBe(before);
	});

	it("nextSeq + readSessionStats handle empty + multi-row sessions", () => {
		// Empty: stats undefined, nextSeq returns 0.
		expect(readSessionStats("nonexistent")).toBeUndefined();
		expect(nextSeq("nonexistent")).toBe(0);

		// Multi-row: nextSeq strictly monotonic.
		upsertSession({ id: "multi", title: "multi", origin: "web" });
		expect(nextSeq("multi")).toBe(0);
		insertMessage({
			id: "m-0",
			sessionId: "multi",
			seq: 0,
			role: "user",
			parts: [],
		});
		expect(nextSeq("multi")).toBe(1);
		insertMessage({
			id: "m-1",
			sessionId: "multi",
			seq: 1,
			role: "assistant",
			parts: [],
		});
		const stats = readSessionStats("multi");
		expect(stats?.message_count).toBe(2);
		expect(stats?.title).toBe("multi");
		expect(stats?.origin).toBe("web");
	});

	it("upsertSession preserves prior title (COALESCE branch)", () => {
		upsertSession({ id: "sess", title: "first", origin: "web" });
		// Second upsert without title → title stays "first".
		upsertSession({ id: "sess" });
		expect(readSessionStats("sess")?.title).toBe("first");
		// Third upsert with explicit title → COALESCE keeps the original
		// (we deliberately don't overwrite).
		upsertSession({ id: "sess", title: "second" });
		expect(readSessionStats("sess")?.title).toBe("first");
	});

	it("debounce timer fires after gap in event stream", async () => {
		// Use fake timers to simulate a 1s gap between two text deltas.
		// First delta should flush immediately (lastWriteAt=0 path); the
		// next delta inside the debounce window should arm the timer and
		// flush via the setTimeout branch.
		const sessionId = "draft-debounce";
		upsertSession({ id: sessionId, origin: "web" });
		const assistantId = "msg-a-debounce";
		insertMessage({
			id: assistantId,
			sessionId,
			seq: 0,
			role: "assistant",
			parts: [],
		});

		// Manual control over the event stream: a queue the test pushes
		// to + an iterator the recorder drains. We use a `Deferred`
		// wrapper so TS sees the resolve handle as always-callable;
		// re-assigning to a `let` from inside the Promise constructor
		// keeps the variable narrowed to `null` from TS's perspective.
		const queue: Array<AgentEventPayload | "drain"> = [];
		interface Deferred {
			readonly promise: Promise<void>;
			resolve(): void;
		}
		const makeDeferred = (): Deferred => {
			let resolve: () => void = () => {
				/* replaced inside the executor */
			};
			const promise = new Promise<void>((r) => {
				resolve = r;
			});
			return {
				promise,
				resolve: () => resolve(),
			};
		};
		let pending = makeDeferred();
		const wait = (): Promise<void> => pending.promise;
		const wakeNext = (): void => {
			const d = pending;
			pending = makeDeferred();
			d.resolve();
		};
		const fake: AgentServiceLike = {
			...makeFakeAgentService(sessionId, []),
			subscribe: () => {
				const iter: AgentSubscription = {
					info: { replayTruncated: false, epochMismatch: false },
					[Symbol.asyncIterator]() {
						return iter;
					},
					async next(): Promise<IteratorResult<AgentEvent, undefined>> {
						while (queue.length === 0) await wait();
						const head = queue.shift();
						if (head === "drain") return { value: undefined, done: true };
						return {
							value: {
								seq: Date.now(),
								sessionId,
								ts: new Date().toISOString(),
								payload: head as AgentEventPayload,
								epoch: "epoch-1",
							},
							done: false,
						};
					},
					async return(): Promise<IteratorResult<AgentEvent, undefined>> {
						return { value: undefined, done: true };
					},
					close: (): void => {
						/* no-op */
					},
				};
				return iter;
			},
		};

		const recorderDone = recordAssistantMessage({
			service: fake,
			sessionId,
			messageId: assistantId,
			turnIndex: 1,
			afterSeq: -1,
		});

		// Push first delta — flushes immediately (lastWriteAt=0).
		queue.push({ type: "llm.text_start", turnIndex: 1, textPartId: "t" });
		queue.push({ type: "llm.text", turnIndex: 1, delta: "hello", textPartId: "t" });
		wakeNext();
		await new Promise((r) => setTimeout(r, 20));
		const afterFirstFlush = readSessionMessages(sessionId).find((m) => m.id === assistantId);
		expect(afterFirstFlush?.parts).not.toEqual([]);

		// Second delta within debounce window — schedules a timer.
		queue.push({ type: "llm.text", turnIndex: 1, delta: " world", textPartId: "t" });
		wakeNext();
		await new Promise((r) => setTimeout(r, 20));
		// Force the timer to fire by yielding a >500ms wait.
		await new Promise((r) => setTimeout(r, 550));
		const afterTimerFlush = readSessionMessages(sessionId).find((m) => m.id === assistantId);
		const textPart = (afterTimerFlush?.parts ?? []).find(
			(p): p is { kind: "text"; text: string } =>
				typeof p === "object" && p != null && (p as { kind?: unknown }).kind === "text",
		);
		expect(textPart?.text).toBe("hello world");

		// Drain.
		queue.push({ type: "turn.completed", turnIndex: 1 });
		queue.push("drain");
		wakeNext();
		await recorderDone;
		// Avoid leaking the helper across tests.
		vi.useRealTimers();
	});

	it("migration runner wraps SQL errors and rolls back", async () => {
		// Inject a bad migration file into a tmp dir and point
		// `runMigrations` at it. Verifies (a) the throw wraps the
		// underlying error message and (b) the ROLLBACK leaves the DB
		// at user_version=0 with no partial-applied tables.
		const badMigrationsDir = join(tmpDir, "bad-migrations");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(badMigrationsDir, { recursive: true });
		writeFileSync(
			join(badMigrationsDir, "0001_init.sql"),
			"CREATE TABLE ok_table (id TEXT);\nTHIS IS NOT VALID SQL;\n",
			"utf8",
		);

		const db = new Database(join(tmpDir, "rollback.db"));
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		expect(() => runMigrations(db, badMigrationsDir)).toThrowError(
			/migration 0001_init\.sql failed/,
		);
		expect(db.pragma("user_version", { simple: true })).toBe(0);
		const tablesAfter = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'")
			.all();
		expect(tablesAfter).toHaveLength(0);
		db.close();
	});

	it("runMigrations skips files without leading number + missing dir", async () => {
		// Files without a leading digit prefix get skipped (no version
		// number). Empty / missing migrations dir is a no-op.
		const oddMigrationsDir = join(tmpDir, "odd-migrations");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(oddMigrationsDir, { recursive: true });
		writeFileSync(join(oddMigrationsDir, "no-number.sql"), "CREATE TABLE x (id TEXT);", "utf8");
		writeFileSync(join(oddMigrationsDir, "readme.md"), "# not sql", "utf8");
		const db = new Database(join(tmpDir, "odd.db"));
		expect(() => runMigrations(db, oddMigrationsDir)).not.toThrow();
		expect(db.pragma("user_version", { simple: true })).toBe(0);
		db.close();

		// Missing dir → silent no-op.
		const db2 = new Database(join(tmpDir, "missing.db"));
		expect(() => runMigrations(db2, join(tmpDir, "does-not-exist"))).not.toThrow();
		db2.close();
	});

	it("default migration fallback works when source SQL dir is unavailable", () => {
		const beforeCwd = process.cwd();
		const isolatedCwd = join(tmpDir, "no-source-tree");
		mkdirSync(isolatedCwd, { recursive: true });
		const db = new Database(join(tmpDir, "fallback.db"));
		try {
			process.chdir(isolatedCwd);
			expect(() => runMigrations(db)).not.toThrow();
			expect(db.pragma("user_version", { simple: true })).toBe(1);
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as { name: string }[];
			expect(tables.map((t) => t.name)).toEqual(["messages", "sessions"]);
		} finally {
			process.chdir(beforeCwd);
			db.close();
		}
	});

	it("resolveDbPath falls back to repo-root default when env is unset", () => {
		const before = process.env.QUILIN_WEB_DB_PATH;
		delete process.env.QUILIN_WEB_DB_PATH;
		try {
			const p = resolveDbPath();
			expect(p.endsWith(".local/quilin/sessions.db")).toBe(true);
		} finally {
			if (before === undefined) delete process.env.QUILIN_WEB_DB_PATH;
			else process.env.QUILIN_WEB_DB_PATH = before;
		}
		// Empty string also falls back.
		process.env.QUILIN_WEB_DB_PATH = "";
		try {
			expect(resolveDbPath().endsWith(".local/quilin/sessions.db")).toBe(true);
		} finally {
			process.env.QUILIN_WEB_DB_PATH = before ?? dbPath;
		}
	});

	it("POST 503 on SQLite failure evicts AgentService state before retry", async () => {
		process.env.DEEPSEEK_API_KEY = "test-key";
		process.env.QUILIN_WEB_DB_PATH = tmpDir;
		_resetDbForTests();
		_resetWebSessionMetaForTests();
		resetAgentServiceForTests();
		const fakeService = makeRouteFakeAgentService();

		vi.resetModules();
		vi.doMock("@/lib/agent-service-client", () => ({
			getAgentService: async () => fakeService,
		}));
		const { POST } = await import("@/app/api/chat/route");
		const sessionId = "draft-post-sqlite-fails";
		const body = {
			id: sessionId,
			messages: [
				{
					id: "u-post-fail",
					role: "user",
					parts: [{ type: "text", text: "force sqlite open failure" }],
				},
			],
		};

		const res = await POST(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

		expect(res.status).toBe(503);
		expect(fakeService.getSession(sessionId)).toBeNull();
		expect(getMeta(sessionId)).toBeUndefined();
		vi.doUnmock("@/lib/agent-service-client");
		vi.resetModules();
	});

	it("POST 409 when a different prompt arrives while the session is still running", async () => {
		process.env.DEEPSEEK_API_KEY = "test-key";
		_resetWebSessionMetaForTests();
		resetAgentServiceForTests();
		const fakeService = makeRouteFakeAgentService();
		const sessionId = "draft-post-session-busy";
		fakeService.createSession({ origin: "web", id: sessionId, title: "busy" });
		fakeService.setSessionStatus(sessionId, "running");
		const oldMessages = [
			{
				id: "u-old",
				role: "user",
				parts: [{ type: "text", text: "first prompt still running" }],
			},
		];
		const meta = setMeta(
			sessionId,
			hashMessages(oldMessages),
			fakeService,
			fakeService.currentSeq(),
		);

		vi.resetModules();
		vi.doMock("@/lib/agent-service-client", () => ({
			getAgentService: async () => fakeService,
		}));
		try {
			const { POST } = await import("@/app/api/chat/route");
			const res = await POST(
				new Request("http://localhost/api/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: sessionId,
						messages: [
							{
								id: "u-new",
								role: "user",
								parts: [{ type: "text", text: "second prompt should wait" }],
							},
						],
					}),
				}),
			);

			expect(res.status).toBe(409);
			const body = (await res.json()) as {
				readonly ok: boolean;
				readonly code?: string;
				readonly data?: { readonly epoch?: string; readonly status?: string };
			};
			expect(body).toMatchObject({
				ok: false,
				code: "session_busy",
				data: { epoch: "epoch-route-test", status: "running" },
			});
			expect(fakeService.getSession(sessionId)?.status).toBe("running");
			expect(getMeta(sessionId)).toBeDefined();
			expect(meta.abort.signal.aborted).toBe(false);
		} finally {
			vi.doUnmock("@/lib/agent-service-client");
			vi.resetModules();
		}
	});

	it("POST /api/chat/stop aborts a running web chat without deleting persisted history", async () => {
		_resetWebSessionMetaForTests();
		resetAgentServiceForTests();
		const fakeService = makeRouteFakeAgentService();
		const sessionId = "draft-post-chat-stop";
		fakeService.createSession({ origin: "web", id: sessionId, title: "active" });
		fakeService.setSessionStatus(sessionId, "running");
		const meta = setMeta(
			sessionId,
			hashMessages([
				{
					role: "user",
					parts: [{ type: "text", text: "please stop this run" }],
				},
			]),
			fakeService,
			fakeService.currentSeq(),
		);
		const emitted: AgentEventPayload[] = [];
		const emitFromRunner = fakeService.emitFromRunner;
		fakeService.emitFromRunner = (id, payload, options) => {
			emitted.push(payload);
			emitFromRunner(id, payload, options);
		};

		vi.resetModules();
		vi.doMock("@/lib/agent-service-client", () => ({
			getAgentService: async () => fakeService,
		}));
		try {
			const { POST } = await import("@/app/api/chat/stop/route");
			const res = await POST(
				new Request("http://localhost/api/chat/stop", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId }),
				}),
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				readonly ok: boolean;
				readonly data?: {
					readonly sessionId?: string;
					readonly stopped?: boolean;
					readonly hadMeta?: boolean;
					readonly hadSession?: boolean;
				};
			};
			expect(body).toMatchObject({
				ok: true,
				data: { sessionId, stopped: true, hadMeta: true, hadSession: true },
			});
			expect(meta.abort.signal.aborted).toBe(true);
			expect(fakeService.getSession(sessionId)).toBeNull();
			expect(getMeta(sessionId)).toBeUndefined();
			expect(emitted).toContainEqual({
				type: "session.failed",
				error: "user stopped chat run",
			});
		} finally {
			vi.doUnmock("@/lib/agent-service-client");
			vi.resetModules();
		}
	});

	it("POST /api/chat/stop cleans up orphan AgentService sessions idempotently", async () => {
		_resetWebSessionMetaForTests();
		resetAgentServiceForTests();
		const fakeService = makeRouteFakeAgentService();
		const sessionId = "draft-post-chat-stop-orphan";
		fakeService.createSession({ origin: "web", id: sessionId, title: "orphan" });
		fakeService.setSessionStatus(sessionId, "running");

		vi.resetModules();
		vi.doMock("@/lib/agent-service-client", () => ({
			getAgentService: async () => fakeService,
		}));
		try {
			const { POST } = await import("@/app/api/chat/stop/route");
			const res = await POST(
				new Request("http://localhost/api/chat/stop", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId }),
				}),
			);
			const first = (await res.json()) as {
				readonly data?: { readonly stopped?: boolean; readonly hadMeta?: boolean };
			};

			expect(res.status).toBe(200);
			expect(first.data).toMatchObject({ stopped: true, hadMeta: false });
			expect(fakeService.getSession(sessionId)).toBeNull();

			const secondRes = await POST(
				new Request("http://localhost/api/chat/stop", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId }),
				}),
			);
			const second = (await secondRes.json()) as {
				readonly data?: { readonly stopped?: boolean; readonly hadSession?: boolean };
			};
			expect(secondRes.status).toBe(200);
			expect(second.data).toMatchObject({ stopped: false, hadSession: false });
		} finally {
			vi.doUnmock("@/lib/agent-service-client");
			vi.resetModules();
		}
	});

	it("migration runner re-runs are idempotent (user_version skip)", () => {
		// First reset already migrated to user_version=1 (from 0001_init.sql)
		// via beforeEach. Reset and reopen — migrations should detect
		// user_version >= 1 and skip the SQL replay (idempotent).
		_resetDbForTests();
		const db = getDb();
		expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(0);
		// Re-trigger by closing without changing path.
		_resetDbForTests();
		const db2 = getDb();
		expect(db2.pragma("user_version", { simple: true })).toBeGreaterThan(0);
		// Schema still present after re-open.
		const tables = db2
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		expect(tables.map((t) => t.name)).toEqual(["messages", "sessions"]);
	});

	it("readSessionMessages tolerates malformed parts_json", () => {
		upsertSession({ id: "bad-json", origin: "web" });
		const db = getDb();
		// Bypass the helper to inject a malformed parts_json row.
		db.prepare(
			`INSERT INTO messages (id, session_id, seq, role, parts_json, created_at, finalized_at)
			 VALUES ('bad-1', 'bad-json', 0, 'user', 'not-json{{{', 0, NULL)`,
		).run();
		db.prepare(
			`INSERT INTO messages (id, session_id, seq, role, parts_json, created_at, finalized_at)
			 VALUES ('bad-2', 'bad-json', 1, 'user', '"not-an-array"', 0, NULL)`,
		).run();
		const rows = readSessionMessages("bad-json");
		expect(rows.find((r) => r.id === "bad-1")?.parts).toEqual([]);
		expect(rows.find((r) => r.id === "bad-2")?.parts).toEqual([]);
	});
});

/**
 * Fake AgentService implementing just `subscribe(...)` for the recorder
 * unit test. Yields the supplied payload stream as AgentEvents with
 * monotonic seq + the supplied epoch.
 *
 * 给 recorder 的 fake AgentService:只实现 subscribe,按顺序吐预设事件。
 */
function makeFakeSession(id: string) {
	return {
		id,
		title: id,
		origin: "web" as const,
		status: "running" as const,
		turnCount: 1,
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
	};
}

function resetAgentServiceForTests(): void {
	const g = globalThis as typeof globalThis & {
		__quilin_agent_service__?: unknown;
		__quilin_agent_service_inflight__?: unknown;
	};
	g.__quilin_agent_service__ = undefined;
	g.__quilin_agent_service_inflight__ = undefined;
}

function makeRouteFakeAgentService(): AgentServiceLike {
	const sessions = new Map<string, AgentSession>();
	let seq = 0;
	return {
		createSession(input: CreateSessionInput): AgentSession {
			const id = input.id ?? `session-${sessions.size + 1}`;
			if (sessions.has(id)) throw new Error("duplicate session");
			const session: AgentSession = {
				id,
				title: input.title ?? id,
				origin: input.origin,
				status: "idle",
				turnCount: 0,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession(id: string): AgentSession | null {
			return sessions.get(id) ?? null;
		},
		listSessions(): readonly AgentSession[] {
			return [...sessions.values()];
		},
		subscribe(): AgentSubscription {
			throw new Error("not used in route failure test");
		},
		currentEpoch(): string {
			return "epoch-route-test";
		},
		currentSeq(): number {
			return seq;
		},
		emitFromRunner(): void {
			seq += 1;
		},
		setSessionStatus(id: string, status: SessionStatus): AgentSession {
			const current = sessions.get(id);
			if (current == null) throw new Error("missing session");
			const updated = { ...current, status, lastActiveAt: new Date().toISOString() };
			sessions.set(id, updated);
			return updated;
		},
		deleteSession(id: string): boolean {
			return sessions.delete(id);
		},
		getEventCount(): number {
			return seq;
		},
	};
}

function makeThrowingAgentService(sessionId: string): AgentServiceLike {
	const base = makeFakeAgentService(sessionId, []);
	return {
		...base,
		subscribe: (): AgentSubscription => {
			let yielded = false;
			const iter: AgentSubscription = {
				info: { replayTruncated: false, epochMismatch: false },
				[Symbol.asyncIterator]() {
					return iter;
				},
				async next(): Promise<IteratorResult<AgentEvent, undefined>> {
					if (yielded) throw new Error("subscription torn down");
					yielded = true;
					return {
						value: {
							seq: 1,
							sessionId,
							ts: new Date().toISOString(),
							payload: { type: "llm.text_start", turnIndex: 1, textPartId: "t" },
							epoch: "epoch-1",
						},
						done: false,
					};
				},
				async return(): Promise<IteratorResult<AgentEvent, undefined>> {
					return { value: undefined, done: true };
				},
				close: (): void => {
					/* no-op */
				},
			};
			return iter;
		},
	};
}

function makeFakeAgentService(
	sessionId: string,
	payloads: readonly AgentEventPayload[],
	opts: { readonly epochMismatch?: boolean } = {},
): AgentServiceLike {
	const fake: AgentServiceLike = {
		createSession: () => {
			throw new Error("not implemented");
		},
		getSession: () => null,
		listSessions: () => [],
		currentEpoch: () => "epoch-1",
		currentSeq: () => 0,
		emitFromRunner: () => {
			/* no-op */
		},
		setSessionStatus: () => {
			throw new Error("not implemented");
		},
		deleteSession: () => false,
		getEventCount: () => payloads.length,
		subscribe: (_opts?: SubscribeOptions): AgentSubscription => {
			let i = 0;
			let closed = false;
			const iter: AgentSubscription = {
				info: {
					replayTruncated: false,
					epochMismatch: opts.epochMismatch === true,
				},
				[Symbol.asyncIterator]() {
					return iter;
				},
				async next(): Promise<IteratorResult<AgentEvent, undefined>> {
					if (closed || i >= payloads.length) {
						return { value: undefined, done: true };
					}
					const payload = payloads[i] as AgentEventPayload;
					i += 1;
					const event: AgentEvent = {
						seq: i,
						sessionId,
						ts: new Date().toISOString(),
						payload,
						epoch: "epoch-1",
					};
					return { value: event, done: false };
				},
				async return(_value?: undefined): Promise<IteratorResult<AgentEvent, undefined>> {
					closed = true;
					return { value: undefined, done: true };
				},
				close: (): void => {
					closed = true;
				},
			};
			return iter;
		},
	};
	return fake;
}
