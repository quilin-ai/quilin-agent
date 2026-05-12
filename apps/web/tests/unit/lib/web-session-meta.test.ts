/**
 * Tests for `web-session-meta.ts` (Task #22 Phase 3).
 *
 * Coverage:
 *   - `hashMessages` deterministic + user-only.
 *   - `setMeta` registers, returns the new entry, kicks off LRU
 *     enforcement.
 *   - `getMeta` / `touchMeta` round trip.
 *   - `evictSession` aborts the controller, emits session.failed,
 *     deletes from AgentService, and is no-op for unknown ids.
 *   - LRU eviction kicks in at `MAX_WEB_SESSION_META + 1`, picks the
 *     oldest `lastActivityMs`, and propagates eviction to AgentService.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEventPayload,
	AgentServiceLike,
	AgentSession,
	AgentSubscription,
	CreateSessionInput,
	EmitFromRunnerOptions,
	SessionStatus,
	SubscribeOptions,
} from "@/lib/agent-service-client";
import {
	_resetWebSessionMetaForTests,
	evictSession,
	getMeta,
	hashMessages,
	MAX_WEB_SESSION_META,
	setMeta,
	touchMeta,
} from "@/lib/web-session-meta";

interface RecordedEmit {
	readonly sessionId: string;
	readonly payload: AgentEventPayload;
	readonly options?: EmitFromRunnerOptions;
}

function makeFakeService(): {
	readonly service: AgentServiceLike;
	readonly emits: RecordedEmit[];
	readonly sessions: Map<string, AgentSession>;
} {
	const emits: RecordedEmit[] = [];
	const sessions = new Map<string, AgentSession>();
	let counter = 0;
	const service: AgentServiceLike = {
		createSession(input: CreateSessionInput): AgentSession {
			const id = input.id ?? `sess_${++counter}`;
			if (sessions.has(id)) {
				throw new Error(`collision: ${id}`);
			}
			const now = new Date().toISOString();
			const s: AgentSession = {
				id,
				title: input.title ?? "(new session)",
				origin: input.origin,
				status: "idle",
				turnCount: 0,
				createdAt: now,
				lastActiveAt: now,
			};
			sessions.set(id, s);
			return s;
		},
		getSession(id: string): AgentSession | null {
			return sessions.get(id) ?? null;
		},
		listSessions() {
			return [...sessions.values()];
		},
		subscribe(_options?: SubscribeOptions): AgentSubscription {
			throw new Error("not used");
		},
		currentEpoch(): string {
			return "test-epoch";
		},
		currentSeq(): number {
			return 1;
		},
		emitFromRunner(
			sessionId: string,
			payload: AgentEventPayload,
			options?: EmitFromRunnerOptions,
		): void {
			emits.push({ sessionId, payload, ...(options == null ? {} : { options }) });
		},
		setSessionStatus(id: string, status: SessionStatus): AgentSession {
			const s = sessions.get(id);
			if (s == null) throw new Error(`unknown: ${id}`);
			const next: AgentSession = { ...s, status };
			sessions.set(id, next);
			return next;
		},
		deleteSession(id: string): boolean {
			return sessions.delete(id);
		},
		getEventCount(_sessionId: string): number {
			return 0;
		},
	};
	return { service, emits, sessions };
}

beforeEach(() => {
	_resetWebSessionMetaForTests();
});

afterEach(() => {
	_resetWebSessionMetaForTests();
});

describe("hashMessages", () => {
	it("is deterministic for the same input", () => {
		const msgs = [{ role: "user", parts: [{ type: "text", text: "hello" }] }];
		expect(hashMessages(msgs)).toBe(hashMessages(msgs));
	});

	it("ignores assistant messages (so reconnect with partial assistant matches)", () => {
		const userOnly = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
		const withPartialAssistant = [
			{ role: "user", parts: [{ type: "text", text: "hi" }] },
			{ role: "assistant", parts: [{ type: "text", text: "partial..." }] },
		];
		expect(hashMessages(userOnly)).toBe(hashMessages(withPartialAssistant));
	});

	it("differs for different user text", () => {
		const a = [{ role: "user", parts: [{ type: "text", text: "one" }] }];
		const b = [{ role: "user", parts: [{ type: "text", text: "two" }] }];
		expect(hashMessages(a)).not.toBe(hashMessages(b));
	});

	it("returns 8-hex-char output", () => {
		const h = hashMessages([{ role: "user", parts: [{ type: "text", text: "x" }] }]);
		expect(h).toMatch(/^[0-9a-f]{8}$/);
	});

	it("handles empty / missing parts safely", () => {
		expect(hashMessages([{ role: "user" }])).toMatch(/^[0-9a-f]{8}$/);
		expect(hashMessages([{ role: "user", parts: [] }])).toMatch(/^[0-9a-f]{8}$/);
		expect(
			hashMessages([{ role: "user", parts: [{ type: "image", url: "x" } as unknown] }]),
		).toMatch(/^[0-9a-f]{8}$/);
	});

	it("returns the same hash for empty user-only input", () => {
		expect(hashMessages([])).toBe(hashMessages([{ role: "assistant", parts: [] }]));
	});
});

describe("setMeta / getMeta / touchMeta", () => {
	it("registers and reads back the metadata", () => {
		const { service } = makeFakeService();
		const meta = setMeta("s1", "hash-1", service, 1);
		expect(meta.sessionId).toBe("s1");
		expect(meta.hash).toBe("hash-1");
		expect(meta.abort.signal.aborted).toBe(false);
		const fetched = getMeta("s1");
		expect(fetched).toBe(meta);
	});

	it("getMeta returns undefined for unknown id", () => {
		expect(getMeta("nope")).toBeUndefined();
	});

	it("touchMeta updates lastActivityMs without changing the entry identity", async () => {
		const { service } = makeFakeService();
		const meta = setMeta("s1", "h", service, 1);
		const before = meta.lastActivityMs;
		await new Promise((r) => setTimeout(r, 5));
		touchMeta("s1");
		const after = getMeta("s1")?.lastActivityMs ?? 0;
		expect(after).toBeGreaterThanOrEqual(before);
	});

	it("touchMeta is a no-op for unknown id", () => {
		expect(() => touchMeta("missing")).not.toThrow();
	});
});

describe("evictSession", () => {
	it("aborts the controller, emits session.failed, and deletes from AgentService", () => {
		const { service, emits, sessions } = makeFakeService();
		service.createSession({ origin: "web", id: "s1" });
		const meta = setMeta("s1", "h", service, 1);
		evictSession("s1", service, "test reason");
		expect(meta.abort.signal.aborted).toBe(true);
		expect(emits).toHaveLength(1);
		expect(emits[0]?.payload).toEqual({ type: "session.failed", error: "test reason" });
		expect(emits[0]?.options?.touchActivity).toBe(true);
		expect(sessions.has("s1")).toBe(false);
		expect(getMeta("s1")).toBeUndefined();
	});

	it("is a no-op when the sessionId is not tracked", () => {
		const { service, emits } = makeFakeService();
		evictSession("ghost", service, "anything");
		expect(emits).toHaveLength(0);
	});

	it("survives the case where AgentService session was already deleted", () => {
		const { service, emits } = makeFakeService();
		// Set meta but never create the AgentService session.
		setMeta("s1", "h", service, 1);
		evictSession("s1", service, "no agent session");
		// Abort still happened on the controller; no emit because
		// `getSession` returned null.
		expect(emits).toHaveLength(0);
		expect(getMeta("s1")).toBeUndefined();
	});
});

describe("LRU enforcement", () => {
	it(`evicts oldest sessions when size exceeds MAX_WEB_SESSION_META (${MAX_WEB_SESSION_META})`, () => {
		const { service, sessions } = makeFakeService();
		const ids: string[] = [];
		for (let i = 0; i < MAX_WEB_SESSION_META + 5; i += 1) {
			const id = `sess-${i.toString().padStart(4, "0")}`;
			ids.push(id);
			service.createSession({ origin: "web", id });
			setMeta(id, `h-${i}`, service, 1);
		}
		// After all inserts, only MAX_WEB_SESSION_META entries should
		// remain in the meta map.
		const remaining = ids.filter((id) => getMeta(id) != null).length;
		expect(remaining).toBe(MAX_WEB_SESSION_META);
		// The 5 oldest (sess-0000..sess-0004) should have been evicted
		// from BOTH the meta map and AgentService.
		for (let i = 0; i < 5; i += 1) {
			expect(getMeta(ids[i] as string)).toBeUndefined();
			expect(sessions.has(ids[i] as string)).toBe(false);
		}
		// The 5 newest should still be there.
		for (let i = MAX_WEB_SESSION_META; i < MAX_WEB_SESSION_META + 5; i += 1) {
			expect(getMeta(ids[i] as string)).not.toBeUndefined();
		}
	});

	it("does not evict anything when size is exactly at the cap", () => {
		const { service } = makeFakeService();
		for (let i = 0; i < MAX_WEB_SESSION_META; i += 1) {
			const id = `cap-${i}`;
			service.createSession({ origin: "web", id });
			setMeta(id, `h-${i}`, service, 1);
		}
		// Every one of the MAX_WEB_SESSION_META should still be present.
		for (let i = 0; i < MAX_WEB_SESSION_META; i += 1) {
			expect(getMeta(`cap-${i}`)).not.toBeUndefined();
		}
	});

	it("uses lastActivityMs (not createdAtMs) for eviction order", async () => {
		const { service } = makeFakeService();
		// Create one extra session over the cap so eviction runs.
		for (let i = 0; i < MAX_WEB_SESSION_META; i += 1) {
			const id = `s-${i}`;
			service.createSession({ origin: "web", id });
			setMeta(id, `h-${i}`, service, 1);
		}
		// Touch s-0 so it becomes newest by lastActivityMs.
		await new Promise((r) => setTimeout(r, 5));
		touchMeta("s-0");
		// Insert one more — should evict s-1 (now the oldest), not s-0.
		service.createSession({ origin: "web", id: "new" });
		setMeta("new", "h-new", service, 1);
		expect(getMeta("s-0")).not.toBeUndefined();
		expect(getMeta("s-1")).toBeUndefined();
		expect(getMeta("new")).not.toBeUndefined();
	});
});
