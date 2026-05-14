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
