/**
 * Tests for the AgentService bridge — Slice A (read-only wiring).
 *
 * Coverage strategy:
 *   - `getOrCreateAgentService` is a true singleton across calls
 *     (no double construction).
 *   - It reuses any pre-existing `globalThis.__quilin_agent_service__`
 *     instance instead of creating a fork.
 *   - `listAgentServiceSessions` returns the same data
 *     `AgentService.listSessions()` does (read-through).
 *   - `findAgentServiceSession` matches `getSession` behavior on
 *     hit/miss.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentService } from "../services/agent-service/index.js";
import {
	createTuiSession,
	findAgentServiceSession,
	getOrCreateAgentService,
	listAgentServiceSessions,
	markSessionStatus,
} from "./agent-service-bridge.js";

interface GlobalShape {
	__quilin_agent_service__: AgentService | undefined;
}

function resetGlobal(): void {
	(globalThis as unknown as GlobalShape).__quilin_agent_service__ = undefined;
}

beforeEach(() => {
	resetGlobal();
});

afterEach(() => {
	resetGlobal();
});

describe("getOrCreateAgentService", () => {
	it("constructs an AgentService on first call and caches it on globalThis", () => {
		const svc = getOrCreateAgentService();
		expect(svc).toBeInstanceOf(AgentService);
		const cached = (globalThis as unknown as GlobalShape)
			.__quilin_agent_service__;
		expect(cached).toBe(svc);
	});

	it("returns the same instance on subsequent calls (idempotent)", () => {
		const a = getOrCreateAgentService();
		const b = getOrCreateAgentService();
		const c = getOrCreateAgentService();
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("reuses an externally-set globalThis instance instead of constructing a fork", () => {
		// Simulate the web side having already constructed the service.
		const external = new AgentService();
		(globalThis as unknown as GlobalShape).__quilin_agent_service__ = external;
		const got = getOrCreateAgentService();
		expect(got).toBe(external);
	});

	it("constructs with the documented defaults (maxSessions=200, history=10000)", () => {
		const svc = getOrCreateAgentService();
		// Push 201 sessions; with maxSessions=200 + LRU, the oldest one
		// should be evicted after the 201st createSession.
		for (let i = 0; i < 201; i += 1) {
			svc.createSession({ origin: "web", id: `s-${i}` });
		}
		expect(svc.listSessions()).toHaveLength(200);
		expect(svc.getSession("s-0")).toBeNull(); // evicted
		expect(svc.getSession("s-200")).not.toBeNull(); // newest survived
	});
});

describe("listAgentServiceSessions", () => {
	it("returns the same data the underlying AgentService exposes", () => {
		const svc = getOrCreateAgentService();
		svc.createSession({ origin: "tui", id: "tui-1" });
		svc.createSession({ origin: "web", id: "web-1" });
		const sessions = listAgentServiceSessions(svc);
		expect(sessions).toHaveLength(2);
		const ids = sessions.map((s) => s.id).sort();
		expect(ids).toEqual(["tui-1", "web-1"]);
	});

	it("returns an empty array when no sessions exist", () => {
		const svc = getOrCreateAgentService();
		expect(listAgentServiceSessions(svc)).toEqual([]);
	});

	it("includes sessions of all origins (tui / web / api)", () => {
		const svc = getOrCreateAgentService();
		svc.createSession({ origin: "tui", id: "t" });
		svc.createSession({ origin: "web", id: "w" });
		svc.createSession({ origin: "api", id: "a" });
		const origins = listAgentServiceSessions(svc)
			.map((s) => s.origin)
			.sort();
		expect(origins).toEqual(["api", "tui", "web"]);
	});
});

describe("findAgentServiceSession", () => {
	it("returns the session when the id exists", () => {
		const svc = getOrCreateAgentService();
		svc.createSession({ origin: "tui", id: "exists", title: "X" });
		const found = findAgentServiceSession(svc, "exists");
		expect(found).not.toBeNull();
		expect(found?.id).toBe("exists");
		expect(found?.title).toBe("X");
	});

	it("returns null when the id is unknown", () => {
		const svc = getOrCreateAgentService();
		expect(findAgentServiceSession(svc, "nope")).toBeNull();
	});

	it("returns null after the session is evicted (LRU edge)", () => {
		const svc = getOrCreateAgentService();
		// Create one less than cap so the next push exactly evicts the oldest.
		for (let i = 0; i < 200; i += 1) {
			svc.createSession({ origin: "tui", id: `e-${i}` });
		}
		expect(findAgentServiceSession(svc, "e-0")).not.toBeNull();
		svc.createSession({ origin: "tui", id: "e-200" });
		expect(findAgentServiceSession(svc, "e-0")).toBeNull();
		expect(findAgentServiceSession(svc, "e-200")).not.toBeNull();
	});
});

describe("createTuiSession (Slice B write-side)", () => {
	it("creates a new session with origin=tui when id is unused", () => {
		const svc = getOrCreateAgentService();
		const sess = createTuiSession(svc, "tui-1", "First chat");
		expect(sess.id).toBe("tui-1");
		expect(sess.origin).toBe("tui");
		expect(sess.title).toBe("First chat");
	});

	it("is idempotent — reuses an existing session with the same id", () => {
		const svc = getOrCreateAgentService();
		const first = createTuiSession(svc, "tui-dup", "First");
		const second = createTuiSession(svc, "tui-dup", "Second-ignored");
		expect(second).toBe(first);
		// Title stays as the first (existing) — we don't patch on reuse.
		expect(second.title).toBe("First");
	});

	it("reuses a session created by another origin (e.g. web)", () => {
		const svc = getOrCreateAgentService();
		const webSession = svc.createSession({ origin: "web", id: "shared" });
		const tuiSession = createTuiSession(svc, "shared", "(ignored)");
		expect(tuiSession).toBe(webSession);
		expect(tuiSession.origin).toBe("web"); // unchanged
	});

	it("truncates titles longer than 80 characters", () => {
		const svc = getOrCreateAgentService();
		const long = "x".repeat(200);
		const sess = createTuiSession(svc, "tui-trim", long);
		expect(sess.title.length).toBeLessThanOrEqual(80);
		expect(sess.title).toBe(long.slice(0, 80));
	});

	it("falls back to the registry default title when title is omitted", () => {
		const svc = getOrCreateAgentService();
		const sess = createTuiSession(svc, "tui-default");
		expect(sess.title).toBe("(new session)");
	});

	it("treats empty-string title as omitted (uses default)", () => {
		const svc = getOrCreateAgentService();
		const sess = createTuiSession(svc, "tui-empty", "");
		expect(sess.title).toBe("(new session)");
	});
});

describe("markSessionStatus (Slice B write-side)", () => {
	it("transitions a known session to the requested status", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "ms-1");
		const updated = markSessionStatus(svc, "ms-1", "running");
		expect(updated).not.toBeNull();
		expect(updated?.status).toBe("running");
	});

	it("returns null without throwing for unknown session id (eviction race)", () => {
		const svc = getOrCreateAgentService();
		const got = markSessionStatus(svc, "ms-ghost", "running");
		expect(got).toBeNull();
	});

	it("supports the full status set: idle / running / completed / failed", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "ms-fsm");
		for (const status of ["running", "completed", "failed", "idle"] as const) {
			const got = markSessionStatus(svc, "ms-fsm", status);
			expect(got?.status).toBe(status);
		}
	});

	it("updates lastActiveAt as part of the status transition", async () => {
		const svc = getOrCreateAgentService();
		const original = createTuiSession(svc, "ms-time");
		// Force a small wall-clock gap so lastActiveAt actually changes.
		await new Promise((r) => setTimeout(r, 5));
		const updated = markSessionStatus(svc, "ms-time", "running");
		expect(updated?.lastActiveAt).not.toBe(original.lastActiveAt);
	});
});

describe("Slice A + Slice B integration", () => {
	it("createTuiSession-registered sessions are visible via listAgentServiceSessions", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "ab-1", "first");
		createTuiSession(svc, "ab-2", "second");
		const listed = listAgentServiceSessions(svc);
		const ids = listed.map((s) => s.id).sort();
		expect(ids).toEqual(["ab-1", "ab-2"]);
		// Status reflects markSessionStatus transitions, also visible.
		markSessionStatus(svc, "ab-1", "running");
		const after = listAgentServiceSessions(svc).find((s) => s.id === "ab-1");
		expect(after?.status).toBe("running");
	});
});
