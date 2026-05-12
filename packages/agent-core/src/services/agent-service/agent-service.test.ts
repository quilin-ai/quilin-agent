import { describe, expect, it } from "vitest";

import { AgentService } from "./index.js";
import type { AgentEvent } from "./types.js";

function fixedClock(start: number, stepMs = 1): () => Date {
	let current = start;
	return () => {
		const d = new Date(current);
		current += stepMs;
		return d;
	};
}

function makeService(): AgentService {
	let counter = 0;
	const idGen = (): string => {
		counter += 1;
		return `sess_${counter}`;
	};
	return new AgentService({
		sessionRegistry: {
			idGen,
			clock: fixedClock(1_700_000_000_000),
		},
		eventBus: {
			clock: fixedClock(1_700_000_000_000),
		},
	});
}

describe("AgentService.createSession", () => {
	it("registers the session and emits session.created", async () => {
		const svc = makeService();
		const subscription = svc.subscribe();
		const session = svc.createSession({ origin: "tui" });
		expect(svc.getSession(session.id)).toEqual(session);

		const first = await subscription.next();
		expect(first.done).toBe(false);
		if (first.done) {
			throw new Error("unreachable");
		}
		expect(first.value.payload.type).toBe("session.created");
		if (first.value.payload.type !== "session.created") {
			throw new Error("unreachable");
		}
		expect(first.value.payload.session.id).toBe(session.id);
		subscription.close();
	});

	it("respects a caller-provided title", () => {
		const svc = makeService();
		const session = svc.createSession({ origin: "web", title: "Hello" });
		expect(session.title).toBe("Hello");
	});
});

describe("AgentService session readers", () => {
	it("listSessions returns all created sessions", () => {
		const svc = makeService();
		svc.createSession({ origin: "tui" });
		svc.createSession({ origin: "web" });
		expect(svc.listSessions()).toHaveLength(2);
	});

	it("getSession returns null for unknown id", () => {
		const svc = makeService();
		expect(svc.getSession("nope")).toBeNull();
	});
});

describe("AgentService.subscribe", () => {
	it("delivers events for sessions created after subscribe()", async () => {
		const svc = makeService();
		const sub = svc.subscribe();
		const next = sub.next();
		svc.createSession({ origin: "tui" });
		const result = await next;
		expect(result.done).toBe(false);
		if (result.done) {
			throw new Error("unreachable");
		}
		expect(result.value.payload.type).toBe("session.created");
		sub.close();
	});

	it("filters by sessionId when provided", async () => {
		const svc = makeService();
		const a = svc.createSession({ origin: "tui" });
		const b = svc.createSession({ origin: "web" });
		const sub = svc.subscribe({ sessionId: b.id });

		// Two events into a (filtered out) and two into b (kept). The
		// for-await collects until it has seen both b events, then closes.
		// If the filter is wrong, a's events would appear in `collected`.
		const collected: AgentEvent[] = [];
		const target = 2;
		const collectPromise = (async () => {
			for await (const ev of sub) {
				collected.push(ev);
				if (collected.length === target) {
					sub.close();
				}
			}
		})();

		svc._emit(a.id, {
			type: "turn.started",
			turnIndex: 1,
			userText: "ignored-1",
		});
		svc._emit(b.id, {
			type: "turn.started",
			turnIndex: 1,
			userText: "kept-1",
		});
		svc._emit(a.id, {
			type: "turn.started",
			turnIndex: 2,
			userText: "ignored-2",
		});

		await collectPromise;
		// The buffered session.created for b lands first (from replay),
		// followed by turn.started seq=4 ("kept-1"). a's events never appear.
		expect(collected).toHaveLength(2);
		expect(collected.every((ev) => ev.sessionId === b.id)).toBe(true);
		expect(collected[0]?.payload.type).toBe("session.created");
		expect(collected[1]?.payload.type).toBe("turn.started");
	});
});

describe("AgentService._patchSession", () => {
	it("applies a patch and emits session.updated", async () => {
		const svc = makeService();
		const session = svc.createSession({ origin: "tui" });
		const sub = svc.subscribe({ sessionId: session.id });
		// Skip the buffered session.created so we land on session.updated.
		await sub.next();
		const nextPromise = sub.next();
		const updated = svc._patchSession(session.id, { status: "running" });
		expect(updated.status).toBe("running");
		const result = await nextPromise;
		expect(result.done).toBe(false);
		if (result.done) {
			throw new Error("unreachable");
		}
		expect(result.value.payload.type).toBe("session.updated");
		sub.close();
	});

	it("propagates registry errors for unknown ids", () => {
		const svc = makeService();
		expect(() => svc._patchSession("missing", { status: "running" })).toThrow(
			/unknown/,
		);
	});
});

describe("AgentService._emit", () => {
	it("emits the payload for a known session", async () => {
		const svc = makeService();
		const session = svc.createSession({ origin: "tui" });
		const sub = svc.subscribe({ sessionId: session.id });
		await sub.next(); // drop session.created
		const nextPromise = sub.next();
		svc._emit(session.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "hello",
		});
		const result = await nextPromise;
		expect(result.done).toBe(false);
		if (result.done) {
			throw new Error("unreachable");
		}
		expect(result.value.payload).toEqual({
			type: "llm.text",
			turnIndex: 1,
			delta: "hello",
		});
		sub.close();
	});

	it("throws on unknown session id", () => {
		const svc = makeService();
		expect(() => svc._emit("missing", { type: "session.completed" })).toThrow(
			/unknown session/,
		);
	});

	it("does not touch lastActiveAt (slice 2 callers must use _patchSession touch=true)", () => {
		// Use a stepped clock so any touch on lastActiveAt would advance the
		// timestamp. The registry clock and the bus clock are independent,
		// so _emit going through bus.emit advances the bus's clock but the
		// session's lastActiveAt (from registry's clock) must stay put.
		let registryNow = 1_700_000_000_000;
		const registryClock = (): Date => {
			const d = new Date(registryNow);
			registryNow += 60_000;
			return d;
		};
		const svc = new AgentService({
			sessionRegistry: { idGen: () => "stable", clock: registryClock },
			eventBus: { clock: () => new Date(1_700_000_000_000) },
		});
		const original = svc.createSession({ origin: "tui" });
		svc._emit(original.id, { type: "llm.text", turnIndex: 1, delta: "x" });
		svc._emit(original.id, { type: "llm.text", turnIndex: 1, delta: "y" });
		svc._emit(original.id, { type: "turn.completed", turnIndex: 1 });
		const after = svc.getSession(original.id);
		expect(after?.lastActiveAt).toBe(original.lastActiveAt);
	});
});

describe("AgentService accessors", () => {
	it("_getEventBus and _getSessionRegistry return the underlying instances", () => {
		const svc = makeService();
		const bus = svc._getEventBus();
		const registry = svc._getSessionRegistry();
		const session = svc.createSession({ origin: "tui" });
		expect(registry.get(session.id)).toEqual(session);
		expect(bus._peekNextSeq()).toBe(2); // one session.created event consumed seq=1
	});

	it("can be constructed with no options (covers defaults branch)", () => {
		const svc = new AgentService();
		const session = svc.createSession({ origin: "tui" });
		expect(session.id.startsWith("sess_")).toBe(true);
		expect(svc._getEventBus()._peekNextSeq()).toBe(2);
	});
});
