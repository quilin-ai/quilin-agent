import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { MigrationError, SQLiteCheckpoint } from "./checkpoint.js";
import type { AgentState } from "./types.js";

interface StoredSession {
	readonly stateJson: string;
	readonly createdAt: string;
	readonly lastActiveAt: string;
}

const databases = new Map<string, Map<string, StoredSession>>();

class MockDatabase {
	private readonly sessions: Map<string, StoredSession>;

	constructor(path: string) {
		let sessions = databases.get(path);

		if (sessions == null) {
			sessions = new Map<string, StoredSession>();
			databases.set(path, sessions);
		}

		this.sessions = sessions;
	}

	exec(_sql: string): void {}

	query<T>(sql: string) {
		return {
			all: (..._params: unknown[]) => {
				if (!sql.includes("ORDER BY last_active_at DESC")) {
					return [] as T[];
				}

				return [...this.sessions.entries()]
					.sort((left, right) =>
						right[1].lastActiveAt.localeCompare(left[1].lastActiveAt),
					)
					.map(([sessionId, row]) => ({
						session_id: sessionId,
						state_json: row.stateJson,
					})) as T[];
			},
			get: (...params: unknown[]) => {
				if (!sql.includes("WHERE session_id = ?")) {
					return null as T | null;
				}

				const sessionId = params[0];
				const row =
					typeof sessionId === "string"
						? this.sessions.get(sessionId)
						: undefined;

				if (row == null || typeof sessionId !== "string") {
					return null as T | null;
				}

				return {
					session_id: sessionId,
					state_json: row.stateJson,
				} as T;
			},
			run: (...params: unknown[]) => {
				if (!sql.includes("INSERT INTO sessions")) {
					return undefined;
				}

				const [sessionId, stateJson, createdAt, lastActiveAt] = params;

				if (
					typeof sessionId !== "string" ||
					typeof stateJson !== "string" ||
					typeof createdAt !== "string" ||
					typeof lastActiveAt !== "string"
				) {
					throw new TypeError("Invalid session row");
				}

				this.sessions.set(sessionId, {
					stateJson,
					createdAt,
					lastActiveAt,
				});

				return undefined;
			},
		};
	}
}

vi.mock("bun:sqlite", () => ({
	Database: MockDatabase,
}));

vi.mock("../logger.js", () => ({
	logger: {
		warn: vi.fn(),
	},
}));

function makeMemoryDbPath(name: string): string {
	return `file:${name}?mode=memory&cache=shared`;
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
	return {
		messages: [{ role: "system", content: "system prompt" }],
		isTerminal: false,
		turnCount: 1,
		createdAt: "2026-04-15T00:00:00.000Z",
		lastActiveAt: "2026-04-15T00:00:00.000Z",
		...overrides,
	};
}

function seedSession(
	dbPath: string,
	sessionId: string,
	stateJson: string,
): void {
	let sessions = databases.get(dbPath);
	if (sessions == null) {
		sessions = new Map<string, StoredSession>();
		databases.set(dbPath, sessions);
	}

	sessions.set(sessionId, {
		stateJson,
		createdAt: "2026-04-15T00:00:00.000Z",
		lastActiveAt: "2026-04-15T00:00:00.000Z",
	});
}

describe("SQLiteCheckpoint", () => {
	beforeEach(() => {
		databases.clear();
	});

	it("supports a bun:sqlite-backed in-memory roundtrip", async () => {
		const checkpoint = new SQLiteCheckpoint({
			sessionId: "smoke-session",
			dbPath: ":memory:",
		});
		const state = makeState();

		await checkpoint.save(state);

		await expect(checkpoint.load("smoke-session")).resolves.toEqual(state);
	});

	it("save + load roundtrip returns the same state", async () => {
		const checkpoint = new SQLiteCheckpoint({
			sessionId: "session-roundtrip",
			dbPath: makeMemoryDbPath("checkpoint-roundtrip"),
		});
		const state = makeState({
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "world" },
			],
			turnCount: 2,
			lastActiveAt: "2026-04-15T00:01:00.000Z",
		});

		await checkpoint.save(state);

		await expect(checkpoint.load("session-roundtrip")).resolves.toEqual(state);
	});

	it("returns null for a missing sessionId", async () => {
		const checkpoint = new SQLiteCheckpoint({
			dbPath: makeMemoryDbPath("checkpoint-missing"),
		});

		await expect(checkpoint.load("missing-session")).resolves.toBeNull();
	});

	it("lists sessionIds ordered by lastActiveAt descending", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-list-order");
		const older = new SQLiteCheckpoint({ sessionId: "older", dbPath });
		const newer = new SQLiteCheckpoint({ sessionId: "newer", dbPath });

		await older.save(
			makeState({ lastActiveAt: "2026-04-15T00:01:00.000Z", turnCount: 1 }),
		);
		await newer.save(
			makeState({ lastActiveAt: "2026-04-15T00:02:00.000Z", turnCount: 2 }),
		);

		await expect(older.list()).resolves.toEqual(["newer", "older"]);
	});

	it("upserts the latest state for the same sessionId", async () => {
		const checkpoint = new SQLiteCheckpoint({
			sessionId: "session-upsert",
			dbPath: makeMemoryDbPath("checkpoint-upsert"),
		});
		const first = makeState({
			turnCount: 1,
			lastActiveAt: "2026-04-15T00:01:00.000Z",
		});
		const second = makeState({
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "updated" },
			],
			turnCount: 2,
			lastActiveAt: "2026-04-15T00:03:00.000Z",
		});

		await checkpoint.save(first);
		await checkpoint.save(second);

		await expect(checkpoint.load("session-upsert")).resolves.toEqual(second);
	});

	it("lists all saved sessionIds across multiple sessions", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-multi-session");

		await new SQLiteCheckpoint({ sessionId: "session-a", dbPath }).save(
			makeState({ lastActiveAt: "2026-04-15T00:01:00.000Z" }),
		);
		await new SQLiteCheckpoint({ sessionId: "session-b", dbPath }).save(
			makeState({ lastActiveAt: "2026-04-15T00:02:00.000Z" }),
		);
		await new SQLiteCheckpoint({ sessionId: "session-c", dbPath }).save(
			makeState({ lastActiveAt: "2026-04-15T00:03:00.000Z" }),
		);

		await expect(
			new SQLiteCheckpoint({ sessionId: "session-a", dbPath }).list(),
		).resolves.toEqual(["session-c", "session-b", "session-a"]);
	});

	it("auto-generates a UUID when sessionId is not provided", async () => {
		const checkpoint = new SQLiteCheckpoint({
			dbPath: makeMemoryDbPath("checkpoint-auto-id"),
		});
		const state = makeState();

		await checkpoint.save(state);

		const sessionIds = await checkpoint.list();
		expect(sessionIds).toHaveLength(1);
		expect(sessionIds[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		await expect(checkpoint.load(sessionIds[0] ?? "")).resolves.toEqual(state);
	});

	it("reuses a specified sessionId when restoring and saving again", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-restore");
		const initial = new SQLiteCheckpoint({
			sessionId: "resume-session",
			dbPath,
		});
		const resumed = new SQLiteCheckpoint({
			sessionId: "resume-session",
			dbPath,
		});
		const state = makeState({
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "assistant", content: "restored" },
			],
			lastActiveAt: "2026-04-15T00:04:00.000Z",
		});

		await initial.save(makeState());
		await resumed.save(state);

		await expect(resumed.load("resume-session")).resolves.toEqual(state);
	});

	it("returns null and warns when a stored checkpoint contains invalid JSON", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-invalid-json");
		seedSession(dbPath, "broken-session", "{not valid json");
		const checkpoint = new SQLiteCheckpoint({ dbPath });

		await expect(checkpoint.load("broken-session")).resolves.toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "broken-session",
				err: expect.any(SyntaxError),
			}),
			"Checkpoint load skipped invalid JSON payload",
		);
	});

	it("throws MigrationError for unsupported schemaVersion values", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-unknown-schema");
		seedSession(
			dbPath,
			"future-session",
			JSON.stringify({
				schemaVersion: 99,
				createdAt: "2026-04-15T00:00:00.000Z",
				updatedAt: "2026-04-15T00:00:00.000Z",
				payload: makeState(),
			}),
		);
		const checkpoint = new SQLiteCheckpoint({ dbPath });

		await expect(checkpoint.load("future-session")).rejects.toThrow(
			MigrationError,
		);
	});
});
