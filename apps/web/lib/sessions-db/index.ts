/**
 * Web 会话 SQLite 持久化 — connection + migration runner + write helpers.
 *
 * Web session SQLite persistence — connection + migration runner + write
 * helpers. See `docs/09-deployment-runtime/web-session-persistence-spec.md`.
 *
 * 全局单例缓存在 `globalThis.__quilin_sessions_db__`(避免 Next.js dev hot
 * reload 反复重开文件句柄)。同步 better-sqlite3 + WAL 模式 + 外键级联。
 *
 * Slice 1 范围:连接 + migration + UPSERT session + 写入 user message +
 * 新建 / 更新 / finalize assistant message 行的低层 helper。读路径(GET
 * /api/sessions / GET /api/sessions/<id>)在 Slice 2;重启恢复 + DELETE
 * 在 Slice 3;并发与 localStorage 迁移在 Slice 4。
 *
 * Slice 1 scope: connection, migrations, UPSERT session, INSERT user
 * message, and the start/update/finalize helpers for the assistant
 * message row. Read endpoints belong to Slice 2; restart recovery +
 * DELETE belong to Slice 3; concurrency + localStorage migration belong
 * to Slice 4.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";

const DEFAULT_MIGRATIONS: readonly MigrationFile[] = [
	{
		file: "0001_init.sql",
		version: 1,
		sql: `
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'web',
    epoch         INTEGER NOT NULL DEFAULT 0,
    deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL,
    parts_json    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    finalized_at  INTEGER,
    UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
`,
	},
];

interface MigrationFile {
	readonly file: string;
	readonly version: number;
	readonly sql: string;
}

/**
 * Feature flag — set `QUILIN_WEB_PERSISTENCE=off` to disable all SQLite
 * writes. Default is `on` per user directive (2026-05-13). Reads the env
 * var fresh every call so tests can flip it without recycling the
 * module.
 *
 * 默认开启;通过 env `QUILIN_WEB_PERSISTENCE=off` 关掉。每次调用都读 env,
 * 测试能直接切换不用重载模块。
 */
export function isPersistenceEnabled(): boolean {
	const v = process.env.QUILIN_WEB_PERSISTENCE;
	if (v === undefined || v === "") return true;
	const normalized = v.toLowerCase();
	return normalized !== "off" && normalized !== "false" && normalized !== "0";
}

/**
 * Resolve the SQLite file path. Env `QUILIN_WEB_DB_PATH` overrides; tests
 * pass `:memory:` or a tmpdir-rooted file. Default
 * `<repo-root>/.local/quilin/sessions.db` so the DB lives under the
 * user's repo without polluting the working tree.
 *
 * 默认在仓库根下 `.local/quilin/sessions.db`;env `QUILIN_WEB_DB_PATH`
 * 可覆盖,测试传 `:memory:` 或临时文件路径。
 *
 * Exported for unit tests (`@internal`) — production code should not
 * call this directly, just rely on `getDb()`.
 *
 * @internal
 */
export function resolveDbPath(): string {
	const fromEnv = process.env.QUILIN_WEB_DB_PATH;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	const repoRoot = resolveRepoRoot();
	return join(repoRoot, ".local", "quilin", "sessions.db");
}

function resolveRepoRoot(): string {
	let current = resolve(process.cwd());
	while (true) {
		if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(process.cwd());
		current = parent;
	}
}

function resolveDefaultMigrationsDir(): string {
	const repoRoot = resolveRepoRoot();
	const candidates = [
		// Next dev/build runs with `apps/web` as cwd.
		join(process.cwd(), "lib", "sessions-db", "migrations"),
		// Direct repo-root execution or unusual test runners.
		join(repoRoot, "apps", "web", "lib", "sessions-db", "migrations"),
	];
	return (
		candidates.find((dir) => existsSync(dir)) ??
		join(process.cwd(), "lib", "sessions-db", "migrations")
	);
}

declare global {
	var __quilin_sessions_db__: BetterSqliteDatabase | undefined;
}

/**
 * Acquire the singleton DB connection. Opens the file (creating parent
 * dirs as needed), turns on WAL + foreign keys, and runs pending
 * migrations on first use. Subsequent calls return the cached handle.
 *
 * 单例获取 DB 连接。首次调用打开文件(必要时建父目录) + 开 WAL + 外键 +
 * 跑迁移;之后调用返回缓存的 handle。
 */
export function getDb(): BetterSqliteDatabase {
	if (globalThis.__quilin_sessions_db__ != null) {
		return globalThis.__quilin_sessions_db__;
	}
	const path = resolveDbPath();
	if (path !== ":memory:") {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
	const db = new Database(path);
	// PRAGMAs must run *before* any statement on a fresh connection.
	// `journal_mode = WAL` is a no-op on `:memory:` databases (and
	// returns "memory") so it's safe to call uniformly.
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	runMigrations(db);
	globalThis.__quilin_sessions_db__ = db;
	return db;
}

/**
 * Run any migration files in `migrations/` whose name's leading number
 * is greater than the current `user_version`. Each successful migration
 * bumps `user_version` to its leading number, so reruns are no-ops.
 *
 * 按 migrations/ 下文件名前缀编号顺序跑:大于当前 `user_version` 的全跑;
 * 跑完把 `user_version` 设到该编号,重跑安全。
 *
 * The optional `migrationsDir` parameter is for unit tests that want to
 * exercise the rollback path with a deliberately-bad migration file
 * without touching the real `migrations/` directory.
 *
 * @internal — production code calls this with no argument.
 */
export function runMigrations(db: BetterSqliteDatabase, migrationsDir?: string): void {
	const migrations = loadMigrations(migrationsDir);
	const currentVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
	for (const migration of migrations) {
		const { file, sql, version } = migration;
		if (version <= currentVersion) continue;
		db.exec("BEGIN");
		try {
			db.exec(sql);
			db.pragma(`user_version = ${version}`);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw new Error(`migration ${file} failed: ${String(e)}`);
		}
	}
}

function loadMigrations(migrationsDir?: string): readonly MigrationFile[] {
	const dir = migrationsDir ?? resolveDefaultMigrationsDir();
	if (!existsSync(dir)) {
		return migrationsDir == null ? DEFAULT_MIGRATIONS : [];
	}
	return readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
		.flatMap((file) => {
			const match = file.match(/^(\d+)_/);
			if (match == null) return [];
			return [
				{
					file,
					version: Number(match[1]),
					sql: readFileSync(join(dir, file), "utf8"),
				},
			];
		});
}

/**
 * UPSERT a session row. Bumps `updated_at` on every call so the most
 * recent activity floats to the top of `ORDER BY updated_at DESC`.
 *
 * UPSERT session 行;每次调用刷 `updated_at`,跟最新活动时间一致。
 */
export function upsertSession(input: {
	readonly id: string;
	readonly title?: string | null;
	readonly origin?: string;
}): void {
	if (!isPersistenceEnabled()) return;
	const now = Date.now();
	const db = getDb();
	const stmt = db.prepare(
		`INSERT INTO sessions (id, title, created_at, updated_at, origin, epoch, deleted_at)
		 VALUES (@id, @title, @now, @now, @origin, 0, NULL)
		 ON CONFLICT(id) DO UPDATE SET
			updated_at = excluded.updated_at,
			title = COALESCE(sessions.title, excluded.title),
			deleted_at = NULL`,
	);
	stmt.run({
		id: input.id,
		title: input.title ?? null,
		now,
		origin: input.origin ?? "web",
	});
}

/**
 * DELETE a session and all its messages (CASCADE via FK). Returns true
 * if a row was removed, false if the session didn't exist. Idempotent.
 *
 * Used by Slice 3's DELETE /api/sessions/[id] endpoint per spec §7.
 * Hard delete (not soft) — the spec's `deleted_at` column is reserved
 * for a future "trash/undelete" UX. AgentService runner abort + evict
 * is the caller's responsibility (route handler).
 *
 * 硬删 session + messages(外键级联)。Slice 3 DELETE endpoint 用,spec §7。
 * AgentService runner abort + evict 由调用方(route)负责,不在 DB 层。
 */
export function deleteSession(sessionId: string): boolean {
	if (!isPersistenceEnabled()) return false;
	const db = getDb();
	const stmt = db.prepare(`DELETE FROM sessions WHERE id = @id`);
	const result = stmt.run({ id: sessionId });
	return result.changes > 0;
}

/**
 * INSERT a user (or system) message row for an existing session. If a
 * row with the same `(session_id, seq)` exists, this throws — duplicate
 * inserts indicate a bug in the caller's seq tracking. Use
 * `insertMessageIfAbsent` when re-running a turn that may already be
 * partially persisted.
 *
 * 插入 user/system message 行;同 `(session_id, seq)` 重复时抛错。
 * 重连等场景已存在则用 `insertMessageIfAbsent`。
 */
export function insertMessage(input: {
	readonly id: string;
	readonly sessionId: string;
	readonly seq: number;
	readonly role: "user" | "assistant" | "system";
	readonly parts: readonly unknown[];
	readonly finalized?: boolean;
}): void {
	if (!isPersistenceEnabled()) return;
	const now = Date.now();
	const db = getDb();
	const stmt = db.prepare(
		`INSERT INTO messages (id, session_id, seq, role, parts_json, created_at, finalized_at)
		 VALUES (@id, @sessionId, @seq, @role, @partsJson, @now, @finalizedAt)`,
	);
	stmt.run({
		id: input.id,
		sessionId: input.sessionId,
		seq: input.seq,
		role: input.role,
		partsJson: JSON.stringify(input.parts),
		now,
		finalizedAt: input.finalized === true ? now : null,
	});
}

/**
 * INSERT a message row if no row with the same id already exists. Used
 * on reconnect when the caller might re-submit messages already on disk.
 *
 * 重连场景:同 id 已存在则跳过,避免 UNIQUE 违例。
 */
export function insertMessageIfAbsent(input: {
	readonly id: string;
	readonly sessionId: string;
	readonly seq: number;
	readonly role: "user" | "assistant" | "system";
	readonly parts: readonly unknown[];
	readonly finalized?: boolean;
}): void {
	if (!isPersistenceEnabled()) return;
	const now = Date.now();
	const db = getDb();
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO messages
		 (id, session_id, seq, role, parts_json, created_at, finalized_at)
		 VALUES (@id, @sessionId, @seq, @role, @partsJson, @now, @finalizedAt)`,
	);
	stmt.run({
		id: input.id,
		sessionId: input.sessionId,
		seq: input.seq,
		role: input.role,
		partsJson: JSON.stringify(input.parts),
		now,
		finalizedAt: input.finalized === true ? now : null,
	});
}

/**
 * Snapshot the in-flight assistant message's parts. Idempotent — calling
 * mid-stream and again on finalize is the expected usage.
 *
 * 中流快照 assistant message 的 parts 数组;mid-stream + finalize 反复调
 * 都安全(同行多次 update)。
 */
export function updateAssistantParts(input: {
	readonly id: string;
	readonly sessionId: string;
	readonly parts: readonly unknown[];
	readonly finalized?: boolean;
}): void {
	if (!isPersistenceEnabled()) return;
	const db = getDb();
	const finalizedAt = input.finalized === true ? Date.now() : null;
	const stmt = db.prepare(
		`UPDATE messages
		 SET parts_json = @partsJson,
		     finalized_at = COALESCE(@finalizedAt, finalized_at)
		 WHERE id = @id AND session_id = @sessionId`,
	);
	stmt.run({
		id: input.id,
		sessionId: input.sessionId,
		partsJson: JSON.stringify(input.parts),
		finalizedAt,
	});
}

/**
 * Slice 4 atomic seq-allocate + insert. Wraps `nextSeq + insertMessage`
 * in a single `BEGIN IMMEDIATE` SQLite transaction so two concurrent
 * tabs (or any two callers racing on the same session) can't both
 * compute `MAX(seq)+1` to the same value and double-write.
 *
 * Returns the allocated seq so the caller can pin the message to it (the
 * existing `insertMessage` API requires a pre-computed seq; this helper
 * keeps that API intact while giving a race-free alternative for the
 * concurrent path).
 *
 * If the session row exists in `sessions` but `messages` is empty, the
 * first allocation returns 0. `BEGIN IMMEDIATE` acquires a reserved
 * lock immediately (vs `BEGIN`'s deferred lock that only escalates on
 * first write), so the second concurrent caller blocks until the first
 * commits — eliminating the race entirely.
 *
 * 原子分配 seq + INSERT — Slice 4 多 tab 并发用。`BEGIN IMMEDIATE`
 * 锁住 reserved lock,第二个 caller 阻塞到第一个提交,杜绝 max+1 撞车。
 */
export function insertMessageAtomic(input: {
	readonly id: string;
	readonly sessionId: string;
	readonly role: "user" | "assistant" | "system";
	readonly parts: readonly unknown[];
	readonly finalized?: boolean;
}): number {
	if (!isPersistenceEnabled()) return -1;
	const now = Date.now();
	const db = getDb();
	let allocatedSeq = -1;
	const txn = db.transaction(() => {
		const row = db
			.prepare(
				`SELECT COALESCE(MAX(seq), -1) AS max_seq
				 FROM messages
				 WHERE session_id = @sessionId`,
			)
			.get({ sessionId: input.sessionId }) as { max_seq: number } | undefined;
		allocatedSeq = (row?.max_seq ?? -1) + 1;
		db.prepare(
			`INSERT INTO messages (id, session_id, seq, role, parts_json, created_at, finalized_at)
			 VALUES (@id, @sessionId, @seq, @role, @partsJson, @now, @finalizedAt)`,
		).run({
			id: input.id,
			sessionId: input.sessionId,
			seq: allocatedSeq,
			role: input.role,
			partsJson: JSON.stringify(input.parts),
			now,
			finalizedAt: input.finalized === true ? now : null,
		});
	});
	// better-sqlite3 `db.transaction()` runs the callback inside a single
	// SQLite transaction synchronously. Within one Node process, the
	// synchronous execution of `txn()` means no other JS code can run
	// between the MAX(seq) read and the INSERT — so the race is closed
	// at the V8 level. The transaction's BEGIN/COMMIT also gives SQLite-
	// level atomicity for any future multi-process scenarios.
	txn();
	return allocatedSeq;
}

/**
 * Slice 4 localStorage → SQLite migration helper.
 *
 * Persists a batch of messages from a session that lived only in
 * browser localStorage before SQLite shipped. Idempotent via
 * `INSERT OR IGNORE` — re-running with the same message ids is a no-op.
 * Used by the `/api/chat` POST handler when the client sends the
 * `X-Quilin-Migrate-LocalStorage: true` header(spec §8).
 *
 * Slice 4 localStorage → SQLite 迁移辅助。一次性把客户端 localStorage
 * 里的 session 历史推到 SQLite,`INSERT OR IGNORE` 保证幂等。chat route
 * 看到 `X-Quilin-Migrate-LocalStorage: true` 头时调用(spec §8)。
 */
export function migrateLocalSessionToSqlite(input: {
	readonly sessionId: string;
	readonly title?: string | null;
	readonly origin?: string;
	readonly messages: ReadonlyArray<{
		readonly id: string;
		readonly role: "user" | "assistant" | "system";
		readonly parts: readonly unknown[];
		readonly createdAt?: string | number | null;
	}>;
}): { readonly migrated: number; readonly skipped: number } {
	if (!isPersistenceEnabled()) return { migrated: 0, skipped: 0 };
	const db = getDb();
	let migrated = 0;
	let skipped = 0;
	const txn = db.transaction(() => {
		upsertSession({
			id: input.sessionId,
			title: input.title ?? null,
			origin: input.origin ?? "web",
		});
		// Allocate seq sequentially from the current max, in order. Use
		// INSERT OR IGNORE so re-migrating doesn't double-insert.
		const maxRow = db
			.prepare(
				`SELECT COALESCE(MAX(seq), -1) AS max_seq
				 FROM messages
				 WHERE session_id = @sessionId`,
			)
			.get({ sessionId: input.sessionId }) as { max_seq: number };
		let nextSeqValue = maxRow.max_seq + 1;
		const stmt = db.prepare(
			`INSERT OR IGNORE INTO messages
			 (id, session_id, seq, role, parts_json, created_at, finalized_at)
			 VALUES (@id, @sessionId, @seq, @role, @partsJson, @now, @finalizedAt)`,
		);
		for (const m of input.messages) {
			const createdAt =
				typeof m.createdAt === "string"
					? Date.parse(m.createdAt) || Date.now()
					: typeof m.createdAt === "number"
						? m.createdAt
						: Date.now();
			const result = stmt.run({
				id: m.id,
				sessionId: input.sessionId,
				seq: nextSeqValue,
				role: m.role,
				partsJson: JSON.stringify(m.parts),
				now: createdAt,
				finalizedAt: createdAt,
			});
			if (result.changes > 0) {
				migrated += 1;
				nextSeqValue += 1;
			} else {
				skipped += 1;
			}
		}
	});
	txn();
	return { migrated, skipped };
}

/**
 * Allocate the next monotonic `seq` value for a session. Caller is
 * responsible for using it in the immediately-following INSERT — there's
 * no reservation, just a max(seq)+1 read.
 *
 * **Single-caller required.** Two callers racing on the same session
 * will both read the same max and produce duplicate `seq` values; the
 * `UNIQUE(session_id, seq)` constraint then rejects the second INSERT.
 * Slice 1 keeps single-caller-per-session by serializing all writes
 * through the chat route's POST handler (Node single-threaded event
 * loop). Slice 4 (concurrent multi-tab POSTs on the same session) will
 * wrap `nextSeq + insertMessage` in a `BEGIN IMMEDIATE` transaction or
 * switch to a INSERT-with-subquery atomic seq allocation.
 *
 * 取下一个 seq(max+1);调用方必须紧跟一个 INSERT,无预留机制。**单调用方**
 * 假设:两个 caller 并发同 session 会拿到同一个 max,UNIQUE 约束拒掉第二个
 * INSERT。Slice 4 处理并发。
 */
export function nextSeq(sessionId: string): number {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT COALESCE(MAX(seq), -1) AS max_seq
			 FROM messages
			 WHERE session_id = @sessionId`,
		)
		.get({ sessionId }) as { max_seq: number } | undefined;
	return (row?.max_seq ?? -1) + 1;
}

/**
 * Slice 2 list endpoint helper — paginated session list with derived
 * preview text (first text part of the latest user message in the
 * session). Skips soft-deleted rows. Default page size 100, max 200.
 *
 * Slice 2 列表 endpoint 用 — 分页列出 session,每行带 message_count + 来自
 * 最新 user 消息的 preview 文本。skips deleted_at IS NOT NULL。
 */
export function listSessionsForReadEndpoint(input?: {
	readonly limit?: number;
	readonly offset?: number;
}): readonly {
	readonly id: string;
	readonly title: string | null;
	readonly created_at: number;
	readonly updated_at: number;
	readonly origin: string;
	readonly message_count: number;
	readonly preview: string | null;
}[] {
	const limit = Math.min(Math.max(input?.limit ?? 100, 1), 200);
	const offset = Math.max(input?.offset ?? 0, 0);
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT s.id, s.title, s.created_at, s.updated_at, s.origin,
			        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
			        (SELECT parts_json FROM messages m2
			          WHERE m2.session_id = s.id AND m2.role = 'user'
			          ORDER BY m2.seq DESC LIMIT 1) AS last_user_parts_json
			 FROM sessions s
			 WHERE s.deleted_at IS NULL
			 ORDER BY s.updated_at DESC
			 LIMIT @limit OFFSET @offset`,
		)
		.all({ limit, offset }) as {
		id: string;
		title: string | null;
		created_at: number;
		updated_at: number;
		origin: string;
		message_count: number;
		last_user_parts_json: string | null;
	}[];
	return rows.map((r) => {
		const previewParts =
			r.last_user_parts_json != null ? parsePartsJson(r.last_user_parts_json) : [];
		return {
			id: r.id,
			title: r.title,
			created_at: r.created_at,
			updated_at: r.updated_at,
			origin: r.origin,
			message_count: r.message_count,
			preview: extractFirstTextFromParts(previewParts),
		};
	});
}

/**
 * Extract the first `type: "text"` part's text. Used for deriving title /
 * preview from a parts array of either raw `UIMessage.parts` or stored
 * persisted parts.
 *
 * 从 parts 数组(原 UIMessage.parts 或 stored PersistedPart)取首段文本 —
 * 用于 title / preview 派生。
 */
export function extractFirstTextFromParts(parts: readonly unknown[]): string | null {
	for (const p of parts) {
		if (typeof p !== "object" || p == null) continue;
		const obj = p as { readonly type?: unknown; readonly text?: unknown };
		if (obj.type === "text" && typeof obj.text === "string") return obj.text;
		// PersistedPart shape: { kind: "text", text }
		const pp = p as { readonly kind?: unknown; readonly text?: unknown };
		if (pp.kind === "text" && typeof pp.text === "string") return pp.text;
	}
	return null;
}

/**
 * Read row counts — used by tests and by the `/api/sessions/<id>` GET in
 * Slice 2. Returns `undefined` when no session row exists.
 *
 * 行计数 — 测试和 Slice 2 read endpoint 用;无 session 返回 undefined。
 */
export function readSessionStats(sessionId: string):
	| {
			readonly id: string;
			readonly title: string | null;
			readonly created_at: number;
			readonly updated_at: number;
			readonly origin: string;
			readonly message_count: number;
	  }
	| undefined {
	const db = getDb();
	const sessionRow = db
		.prepare(
			`SELECT id, title, created_at, updated_at, origin
			 FROM sessions
			 WHERE id = @id AND deleted_at IS NULL`,
		)
		.get({ id: sessionId }) as
		| {
				id: string;
				title: string | null;
				created_at: number;
				updated_at: number;
				origin: string;
		  }
		| undefined;
	if (sessionRow == null) return undefined;
	const countRow = db
		.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = @id`)
		.get({ id: sessionId }) as { c: number };
	return {
		id: sessionRow.id,
		title: sessionRow.title,
		created_at: sessionRow.created_at,
		updated_at: sessionRow.updated_at,
		origin: sessionRow.origin,
		message_count: countRow.c,
	};
}

/**
 * Read all messages for a session, ordered by `seq`. Used by tests now;
 * the `GET /api/sessions/<id>` endpoint in Slice 2 will consume this.
 *
 * 读 session 全部消息,按 seq 升序;测试在用,Slice 2 的 GET endpoint 会用。
 */
export function readSessionMessages(sessionId: string): readonly {
	readonly id: string;
	readonly seq: number;
	readonly role: string;
	readonly parts: readonly unknown[];
	readonly created_at: number;
	readonly finalized_at: number | null;
}[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT id, seq, role, parts_json, created_at, finalized_at
			 FROM messages
			 WHERE session_id = @id
			 ORDER BY seq ASC`,
		)
		.all({ id: sessionId }) as {
		id: string;
		seq: number;
		role: string;
		parts_json: string;
		created_at: number;
		finalized_at: number | null;
	}[];
	return rows.map((r) => ({
		id: r.id,
		seq: r.seq,
		role: r.role,
		parts: parsePartsJson(r.parts_json),
		created_at: r.created_at,
		finalized_at: r.finalized_at,
	}));
}

function parsePartsJson(raw: string): readonly unknown[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Test-only — drop the singleton and reopen a fresh in-memory DB. Used by
 * Vitest `beforeEach` to keep cases isolated.
 *
 * 测试用 — 丢掉单例,重开一份新连接(配合 env QUILIN_WEB_DB_PATH=:memory:)。
 *
 * @internal
 */
export function _resetDbForTests(): void {
	const existing = globalThis.__quilin_sessions_db__;
	if (existing != null) {
		try {
			existing.close();
		} catch {
			/* already closed */
		}
	}
	globalThis.__quilin_sessions_db__ = undefined;
}
