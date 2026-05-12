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
	findAgentServiceSession,
	getOrCreateAgentService,
	listAgentServiceSessions,
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
