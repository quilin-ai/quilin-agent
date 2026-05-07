import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import type { AgentState, Checkpoint, Message } from "./types.js";

export interface SessionSummary {
	readonly sessionId: string;
	readonly lastMessage: string;
	readonly messageCount: number;
	readonly lastActiveAt: string;
}

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

interface SessionSummaryRow {
	readonly session_id: string;
	readonly state_json: string;
	readonly last_active_at: string;
}

interface CheckpointEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly payload: AgentState;
}

interface CheckpointEnvelopeV2 {
	readonly schemaVersion: 2;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly payload: AgentState;
}

type CheckpointEnvelope = CheckpointEnvelopeV1 | CheckpointEnvelopeV2;

const CHECKPOINT_SCHEMA_VERSION = 2;

export class MigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MigrationError";
	}
}

function stripReasoningFromMessage(message: Message): Message {
	if (message.reasoning == null) {
		return message;
	}

	const { reasoning: _reasoning, ...sanitizedMessage } = message;
	return sanitizedMessage;
}

function sanitizeState(state: AgentState): AgentState {
	return {
		...state,
		messages: state.messages.map(stripReasoningFromMessage),
	};
}

function extractEnvelopePayload(payload: unknown, version: number): AgentState {
	if (!isPlainObject(payload)) {
		throw new MigrationError(`Checkpoint v${version} payload is invalid`);
	}

	return sanitizeState(payload as unknown as AgentState);
}

function createEnvelope(state: AgentState): CheckpointEnvelopeV2 {
	const sanitizedState = sanitizeState(state);

	return {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		createdAt: sanitizedState.createdAt,
		updatedAt: sanitizedState.lastActiveAt,
		payload: sanitizedState,
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
		return sanitizeState(parsed as unknown as AgentState);
	}

	const envelope = parsed as Partial<CheckpointEnvelope>;

	switch (envelope.schemaVersion) {
		case 1: {
			return extractEnvelopePayload(envelope.payload, 1);
		}
		case CHECKPOINT_SCHEMA_VERSION: {
			return extractEnvelopePayload(
				envelope.payload,
				CHECKPOINT_SCHEMA_VERSION,
			);
		}
		default:
			throw new MigrationError(
				`Unsupported checkpoint schemaVersion: ${String(envelope.schemaVersion)}`,
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

	async listSessions(): Promise<readonly SessionSummary[]> {
		const db = await this.getDb();

		const rows = db
			.query<SessionSummaryRow>(
				"SELECT session_id, state_json, last_active_at FROM sessions ORDER BY last_active_at DESC",
			)
			.all();

		return rows.map((row) => {
			let lastMessage = "";
			let messageCount = 0;

			try {
				const parsed: unknown = JSON.parse(row.state_json);
				const state = migrateEnvelope(parsed);
				messageCount = state.messages.length;

				const lastUserMessage = [...state.messages]
					.reverse()
					.find((message) => message.role === "user");
				if (lastUserMessage != null) {
					const singleLine = lastUserMessage.content
						.replace(/\s+/gu, " ")
						.trim();
					lastMessage =
						singleLine.length > 80
							? `${singleLine.slice(0, 80)}...`
							: singleLine;
				}
			} catch {
				// Ignore parsing errors; leave defaults
			}

			return {
				sessionId: row.session_id,
				lastMessage,
				messageCount,
				lastActiveAt: row.last_active_at,
			};
		});
	}
}
