import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentState, Checkpoint } from "./types.js";

interface SQLiteCheckpointOptions {
	readonly dbPath?: string;
	readonly sessionId?: string;
}

interface QueryResult<T> {
	all(...params: unknown[]): T[];
	get(...params: unknown[]): T | null;
	run(...params: unknown[]): unknown;
}

interface SQLiteDatabase {
	exec(sql: string): void;
	query<T>(sql: string): QueryResult<T>;
}

const DEFAULT_DB_PATH = join(homedir(), ".quilin", "sessions.db");

interface SessionRow {
	readonly session_id: string;
	readonly state_json: string;
}

export class SQLiteCheckpoint implements Checkpoint {
	private readonly currentSessionId: string;
	private readonly dbPath: string;
	private db: SQLiteDatabase | null = null;
	private dbPromise: Promise<SQLiteDatabase> | null = null;

	constructor(options: SQLiteCheckpointOptions = {}) {
		this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
		this.currentSessionId = options.sessionId ?? crypto.randomUUID();
	}

	private async getDb(): Promise<SQLiteDatabase> {
		if (this.db != null) {
			return this.db;
		}

		if (this.dbPromise != null) {
			return this.dbPromise;
		}

		this.dbPromise = (async () => {
			const { Database } = (await import(/* @vite-ignore */ "bun:sqlite")) as {
				Database: new (path: string) => SQLiteDatabase;
			};

			if (this.dbPath !== ":memory:" && !this.dbPath.startsWith("file:")) {
				mkdirSync(dirname(this.dbPath), { recursive: true });
			}

			const db = new Database(this.dbPath);
			db.exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					session_id TEXT PRIMARY KEY,
					state_json TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL
				)
			`);
			this.db = db;

			return db;
		})();

		return this.dbPromise;
	}

	async save(state: AgentState): Promise<void> {
		const db = await this.getDb();

		db.query<SessionRow>(`
				INSERT INTO sessions (
					session_id,
					state_json,
					created_at,
					last_active_at
				)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					state_json = excluded.state_json,
					created_at = excluded.created_at,
					last_active_at = excluded.last_active_at
			`).run(
			this.currentSessionId,
			JSON.stringify(state),
			state.createdAt,
			state.lastActiveAt,
		);
	}

	async load(sessionId: string): Promise<AgentState | null> {
		const db = await this.getDb();
		const row = db
			.query<SessionRow>(
				"SELECT session_id, state_json FROM sessions WHERE session_id = ?",
			)
			.get(sessionId);

		if (row == null) {
			return null;
		}

		return JSON.parse(row.state_json) as AgentState;
	}

	async list(): Promise<readonly string[]> {
		const db = await this.getDb();

		return db
			.query<SessionRow>(
				"SELECT session_id, state_json FROM sessions ORDER BY last_active_at DESC",
			)
			.all()
			.map((row) => row.session_id);
	}
}
