/**
 * Tests for `agent-service-client.ts` (Task #22 Phase 2).
 *
 * Coverage strategy:
 *   - Pre-init: `getAgentServiceSync` throws.
 *   - First call: dynamic import resolves, AgentService is constructed
 *     and cached on globalThis; subsequent `getAgentServiceSync` works.
 *   - Concurrent calls: two simultaneous `getAgentService()` invocations
 *     share the same in-flight promise (no duplicate construction).
 *   - Cached path: third call returns the cached singleton without
 *     re-importing.
 *
 * We can't actually import `@quilin/agent-core` inside vitest (the dist
 * bundle has side-effects on require), so we install a fake module in
 * `vi.mock` and verify the construction path by counting how many times
 * the fake `AgentService` constructor runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `@quilin/agent-core` so the dynamic import inside
// `agent-service-client.ts` resolves to a tiny fake rather than the
// 3.5MB dist bundle (which runs the CLI bootstrap on require).
const ctorSpy = vi.fn();
vi.mock("@quilin/agent-core", () => {
	class AgentService {
		readonly options: unknown;
		constructor(options: unknown) {
			ctorSpy(options);
			this.options = options;
		}
		createSession() {
			throw new Error("fake");
		}
		getSession() {
			return null;
		}
		listSessions() {
			return [];
		}
		subscribe() {
			throw new Error("fake");
		}
		currentEpoch() {
			return "fake-epoch";
		}
		emitFromRunner() {
			/* noop */
		}
		setSessionStatus() {
			throw new Error("fake");
		}
		deleteSession() {
			return false;
		}
		getEventCount() {
			return 0;
		}
	}
	return { AgentService };
});

interface GlobalShape {
	__quilin_agent_service__: unknown;
	__quilin_agent_service_inflight__: unknown;
}

function resetGlobals(): void {
	const g = globalThis as unknown as GlobalShape;
	g.__quilin_agent_service__ = undefined;
	g.__quilin_agent_service_inflight__ = undefined;
}

beforeEach(() => {
	ctorSpy.mockClear();
	resetGlobals();
	vi.resetModules();
});

afterEach(() => {
	resetGlobals();
});

describe("getAgentServiceSync — pre-init", () => {
	it("throws when called before any getAgentService()", async () => {
		const { getAgentServiceSync } = await import("@/lib/agent-service-client");
		expect(() => getAgentServiceSync()).toThrow(/not yet initialized/i);
	});
});

describe("getAgentService — first call", () => {
	it("dynamic-imports agent-core and caches the singleton on globalThis", async () => {
		const { getAgentService } = await import("@/lib/agent-service-client");
		const svc = await getAgentService();
		expect(ctorSpy).toHaveBeenCalledTimes(1);
		expect(ctorSpy).toHaveBeenCalledWith({
			maxSessions: 200,
			eventBus: { historyCapacity: 10_000 },
		});
		const g = globalThis as unknown as GlobalShape;
		expect(g.__quilin_agent_service__).toBe(svc);
		// In-flight slot is cleared after construction completes.
		expect(g.__quilin_agent_service_inflight__).toBeUndefined();
	});

	it("makes getAgentServiceSync return the cached instance after first await", async () => {
		const { getAgentService, getAgentServiceSync } = await import("@/lib/agent-service-client");
		const awaited = await getAgentService();
		expect(getAgentServiceSync()).toBe(awaited);
	});
});

describe("getAgentService — concurrent first hits", () => {
	it("coalesces parallel calls onto a single construction", async () => {
		const { getAgentService } = await import("@/lib/agent-service-client");
		const [a, b, c] = await Promise.all([getAgentService(), getAgentService(), getAgentService()]);
		// All three callers see the same instance.
		expect(a).toBe(b);
		expect(b).toBe(c);
		// AgentService constructor ran exactly once.
		expect(ctorSpy).toHaveBeenCalledTimes(1);
	});

	it("subsequent post-cache calls skip the import path entirely", async () => {
		const { getAgentService } = await import("@/lib/agent-service-client");
		const first = await getAgentService();
		ctorSpy.mockClear();
		const second = await getAgentService();
		const third = await getAgentService();
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(ctorSpy).toHaveBeenCalledTimes(0); // no extra constructions
	});
});

describe("getAgentService — race protection across reconstructions", () => {
	it("does not stomp on a later in-flight promise during cleanup", async () => {
		const { getAgentService } = await import("@/lib/agent-service-client");
		// Drive one full cycle so the global is populated.
		await getAgentService();
		const g = globalThis as unknown as GlobalShape;
		// Simulate "globalThis cleared by external code" (e.g. an HMR
		// hook) and force a fresh in-flight cycle.
		g.__quilin_agent_service__ = undefined;
		ctorSpy.mockClear();
		const promiseA = getAgentService();
		const promiseB = getAgentService();
		const [a, b] = await Promise.all([promiseA, promiseB]);
		expect(a).toBe(b);
		// Both callers shared one in-flight construction; only one
		// AgentService ctor call.
		expect(ctorSpy).toHaveBeenCalledTimes(1);
	});
});
