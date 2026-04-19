import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
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

interface CheckpointEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly payload: AgentState;
}

export class MigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MigrationError";
	}
}

function createEnvelope(state: AgentState): CheckpointEnvelopeV1 {
	return {
		schemaVersion: 1,
		createdAt: state.createdAt,
		updatedAt: state.lastActiveAt,
		payload: state,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

function migrateEnvelope(parsed: unknown): AgentState {
	if (!isPlainObject(parsed)) {
		throw new MigrationError("Checkpoint payload is not an object");
	}

	if (!("schemaVersion" in parsed)) {
		return parsed as AgentState;
	}

	switch (parsed.schemaVersion) {
		case 1: {
			const payload = parsed.payload;
			if (!isPlainObject(payload)) {
				throw new MigrationError("Checkpoint v1 payload is invalid");
			}

			return payload as AgentState;
		}
		default:
			throw new MigrationError(
				`Unsupported checkpoint schemaVersion: ${String(parsed.schemaVersion)}`,
			);
	}
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
				await mkdir(dirname(this.dbPath), { recursive: true });
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
					last_active_at = excluded.last_active_at
			`).run(
			this.currentSessionId,
			JSON.stringify(createEnvelope(state)),
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

		let parsed: unknown;
		try {
			parsed = JSON.parse(row.state_json);
		} catch (err) {
			logger.warn(
				{
					sessionId,
					err,
				},
				"Checkpoint load skipped invalid JSON payload",
			);
			return null;
		}

		return migrateEnvelope(parsed);
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
