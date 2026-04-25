import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { logger } from "../logger.js";
import { MigrationError, SQLiteCheckpoint } from "./checkpoint.js";
import type { AgentState, ReasoningPart } from "./types.js";

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

				const existing = this.sessions.get(sessionId);
				const nextCreatedAt =
					existing != null && !sql.includes("created_at = excluded.created_at")
						? existing.createdAt
						: createdAt;

				this.sessions.set(sessionId, {
					stateJson,
					createdAt: nextCreatedAt,
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

function getStoredStateJson(dbPath: string, sessionId: string): string {
	const stored = databases.get(dbPath)?.get(sessionId);
	expect(stored).toBeDefined();

	return stored?.stateJson ?? "";
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

	it("shares an in-flight database open and creates parent directories for file paths", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quilin-checkpoint-db-"));
		const dbPath = join(tempDir, "nested", "sessions.db");
		try {
			const checkpoint = new SQLiteCheckpoint({
				sessionId: "concurrent-session",
				dbPath,
			});
			const state = makeState();

			await Promise.all([checkpoint.save(state), checkpoint.list()]);

			await expect(checkpoint.load("concurrent-session")).resolves.toEqual(
				state,
			);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
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

	it("serializes v2 checkpoints without persisting reasoning secrets", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-strips-reasoning");
		const checkpoint = new SQLiteCheckpoint({
			sessionId: "session-with-reasoning",
			dbPath,
		});
		const state = makeState({
			messages: [
				{ role: "system", content: "system prompt" },
				{
					role: "assistant",
					content: "answer",
					reasoning: [
						{
							provider: "anthropic",
							text: "private chain",
							signature: "sig-secret",
						},
						{
							provider: "openai-responses",
							itemId: "resp-item-1",
							encryptedContent: "ciphertext-secret",
							text: "summary",
						},
					],
				},
			],
		});

		await checkpoint.save(state);

		const stateJson = getStoredStateJson(dbPath, "session-with-reasoning");
		const parsed = JSON.parse(stateJson) as {
			readonly schemaVersion: number;
			readonly payload: AgentState;
		};

		expect(parsed.schemaVersion).toBe(2);
		expect(stateJson).not.toContain("reasoning");
		expect(stateJson).not.toContain("sig-secret");
		expect(stateJson).not.toContain("ciphertext-secret");
		expect(parsed.payload.messages).toEqual([
			{ role: "system", content: "system prompt" },
			{ role: "assistant", content: "answer" },
		]);
	});

	it("preserves createdAt when saving an existing session", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-preserve-created-at");
		const checkpoint = new SQLiteCheckpoint({
			sessionId: "stable-session",
			dbPath,
		});

		await checkpoint.save(
			makeState({
				createdAt: "2026-04-15T00:00:00.000Z",
				lastActiveAt: "2026-04-15T00:01:00.000Z",
			}),
		);
		await checkpoint.save(
			makeState({
				createdAt: "2026-04-15T00:02:00.000Z",
				lastActiveAt: "2026-04-15T00:03:00.000Z",
			}),
		);

		expect(databases.get(dbPath)?.get("stable-session")).toEqual(
			expect.objectContaining({
				createdAt: "2026-04-15T00:00:00.000Z",
				lastActiveAt: "2026-04-15T00:03:00.000Z",
			}),
		);
	});

	it("loads v1 checkpoints by migrating away stored reasoning", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-v1-migration");
		const v1State = makeState({
			messages: [
				{ role: "system", content: "system prompt" },
				{
					role: "assistant",
					content: "legacy answer",
					reasoning: [
						{
							provider: "deepseek",
							text: "old stored reasoning",
						},
					],
				},
			],
		});

		seedSession(
			dbPath,
			"legacy-v1-session",
			JSON.stringify({
				schemaVersion: 1,
				createdAt: v1State.createdAt,
				updatedAt: v1State.lastActiveAt,
				payload: v1State,
			}),
		);
		const checkpoint = new SQLiteCheckpoint({ dbPath });

		await expect(checkpoint.load("legacy-v1-session")).resolves.toEqual(
			makeState({
				messages: [
					{ role: "system", content: "system prompt" },
					{ role: "assistant", content: "legacy answer" },
				],
			}),
		);
	});

	it("loads v2 checkpoints and sanitizes any persisted reasoning fields", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-v2-migration");
		const v2State = makeState({
			messages: [
				{ role: "system", content: "system prompt" },
				{
					role: "assistant",
					content: "resume answer",
					reasoning: [
						{
							provider: "anthropic",
							text: "should be stripped",
							signature: "legacy-signature",
						},
					],
				},
			],
		});

		seedSession(
			dbPath,
			"legacy-v2-session",
			JSON.stringify({
				schemaVersion: 2,
				createdAt: v2State.createdAt,
				updatedAt: v2State.lastActiveAt,
				payload: v2State,
			}),
		);
		const checkpoint = new SQLiteCheckpoint({ dbPath });

		await expect(checkpoint.load("legacy-v2-session")).resolves.toEqual(
			makeState({
				messages: [
					{ role: "system", content: "system prompt" },
					{ role: "assistant", content: "resume answer" },
				],
			}),
		);
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

	it("defines provider-specific reasoning part shapes", () => {
		const anthropicPart = {
			provider: "anthropic",
			text: "thinking",
			signature: "sig",
		} satisfies ReasoningPart;
		const responsesPart = {
			provider: "openai-responses",
			itemId: "resp-item-1",
			encryptedContent: "cipher",
			text: "summary",
		} satisfies ReasoningPart;
		const deepseekPart = {
			provider: "deepseek",
			text: "step one",
		} satisfies ReasoningPart;

		expectTypeOf(anthropicPart.signature).toEqualTypeOf<string>();
		expectTypeOf(responsesPart.itemId).toEqualTypeOf<string>();
		expectTypeOf(responsesPart.encryptedContent).toEqualTypeOf<string>();
		expect(deepseekPart).toEqual({
			provider: "deepseek",
			text: "step one",
		});
		expect(anthropicPart.signature).toBe("sig");
		expect(responsesPart.encryptedContent).toBe("cipher");
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

	it("loads legacy raw state payloads and strips persisted reasoning", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-legacy-raw-state");
		seedSession(
			dbPath,
			"raw-session",
			JSON.stringify(
				makeState({
					messages: [
						{ role: "system", content: "system prompt" },
						{
							role: "assistant",
							content: "legacy answer",
							reasoning: [
								{ provider: "deepseek", text: "stored private data" },
							],
						},
					],
				}),
			),
		);
		const checkpoint = new SQLiteCheckpoint({ dbPath });

		await expect(checkpoint.load("raw-session")).resolves.toEqual(
			makeState({
				messages: [
					{ role: "system", content: "system prompt" },
					{ role: "assistant", content: "legacy answer" },
				],
			}),
		);
	});

	it("throws MigrationError for non-object checkpoints and invalid envelopes", async () => {
		const dbPath = makeMemoryDbPath("checkpoint-invalid-envelope");
		seedSession(dbPath, "primitive-session", "null");
		seedSession(
			dbPath,
			"bad-payload-session",
			JSON.stringify({
				schemaVersion: 2,
				createdAt: "2026-04-15T00:00:00.000Z",
				updatedAt: "2026-04-15T00:00:00.000Z",
				payload: null,
			}),
		);
		const checkpoint = new SQLiteCheckpoint({ dbPath });

		await expect(checkpoint.load("primitive-session")).rejects.toThrow(
			/Checkpoint payload is not an object/,
		);
		await expect(checkpoint.load("bad-payload-session")).rejects.toThrow(
			/Checkpoint v2 payload is invalid/,
		);
	});
});
