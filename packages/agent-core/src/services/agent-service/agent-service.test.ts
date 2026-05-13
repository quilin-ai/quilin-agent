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

describe("AgentService.currentSeq", () => {
	it("returns 1 for a fresh service (no events emitted yet)", () => {
		const svc = makeService();
		expect(svc.currentSeq()).toBe(1);
	});

	it("returns 2 after one event (the session.created from createSession)", () => {
		const svc = makeService();
		svc.createSession({ origin: "web" });
		expect(svc.currentSeq()).toBe(2);
	});

	it("advances with each emit", () => {
		const svc = makeService();
		const s = svc.createSession({ origin: "web" });
		expect(svc.currentSeq()).toBe(2);
		svc.emitFromRunner(s.id, { type: "llm.text", turnIndex: 1, delta: "a" });
		expect(svc.currentSeq()).toBe(3);
		svc.emitFromRunner(s.id, { type: "llm.text", turnIndex: 1, delta: "b" });
		expect(svc.currentSeq()).toBe(4);
	});

	it("is usable as a per-session 'from now on' cursor", async () => {
		const svc = makeService();
		const s = svc.createSession({ origin: "web", id: "scoped" });
		// Emit a few events BEFORE capturing the cursor.
		svc.emitFromRunner(s.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "before-1",
		});
		svc.emitFromRunner(s.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "before-2",
		});
		const cursor = svc.currentSeq();
		svc.emitFromRunner(s.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "after-1",
		});
		svc.emitFromRunner(s.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "after-2",
		});
		const sub = svc.subscribe({ sessionId: s.id, afterSeq: cursor - 1 });
		const events: AgentEvent[] = [];
		// Pull from the queue until exhausted.
		for (let i = 0; i < 2; i += 1) {
			const r = await sub.next();
			if (r.done) break;
			events.push(r.value);
		}
		sub.close();
		const deltas = events.map((e) => {
			const p = e.payload;
			return p.type === "llm.text" ? p.delta : null;
		});
		expect(deltas).toEqual(["after-1", "after-2"]);
	});
});

describe("AgentService.currentEpoch", () => {
	it("returns a stable non-empty epoch UUID for the instance lifetime", () => {
		const svc = makeService();
		const e1 = svc.currentEpoch();
		const e2 = svc.currentEpoch();
		expect(e1).toBe(e2);
		expect(e1.length).toBeGreaterThan(0);
	});

	it("two services have distinct epochs", () => {
		const a = new AgentService();
		const b = new AgentService();
		expect(a.currentEpoch()).not.toBe(b.currentEpoch());
	});

	it("matches the epoch stamped on emitted events", () => {
		const svc = makeService();
		const session = svc.createSession({ origin: "web" });
		svc.emitFromRunner(session.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "hi",
		});
		const events = svc
			._getEventBus()
			.historySnapshot({ sessionId: session.id });
		for (const event of events) {
			expect(event.epoch).toBe(svc.currentEpoch());
		}
	});

	it("honors a caller-supplied epoch via eventBus option", () => {
		const svc = new AgentService({ eventBus: { epoch: "fixed-X" } });
		expect(svc.currentEpoch()).toBe("fixed-X");
	});
});

describe("AgentService.emitFromRunner", () => {
	it("emits the payload without touching lastActiveAt by default", () => {
		let registryNow = 1_700_000_000_000;
		const registryClock = (): Date => {
			const d = new Date(registryNow);
			registryNow += 60_000;
			return d;
		};
		const svc = new AgentService({
			sessionRegistry: { idGen: () => "s1", clock: registryClock },
			eventBus: { clock: () => new Date(1_700_000_000_000) },
		});
		const original = svc.createSession({ origin: "web" });
		svc.emitFromRunner(original.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "a",
		});
		svc.emitFromRunner(original.id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "b",
		});
		const after = svc.getSession(original.id);
		expect(after?.lastActiveAt).toBe(original.lastActiveAt);
	});

	it("touches lastActiveAt and emits session.updated when touchActivity=true", async () => {
		let registryNow = 1_700_000_000_000;
		const registryClock = (): Date => {
			const d = new Date(registryNow);
			registryNow += 60_000;
			return d;
		};
		const svc = new AgentService({
			sessionRegistry: { idGen: () => "s2", clock: registryClock },
			eventBus: { clock: () => new Date(1_700_000_000_000) },
		});
		const sub = svc.subscribe();
		const original = svc.createSession({ origin: "web" });
		// Drain session.created.
		await sub.next();
		svc.emitFromRunner(
			original.id,
			{ type: "assistant.message", turnIndex: 1, content: "done" },
			{ touchActivity: true },
		);
		const seen: AgentEvent[] = [];
		const first = await sub.next();
		if (!first.done) seen.push(first.value);
		const second = await sub.next();
		if (!second.done) seen.push(second.value);
		const types = seen.map((e) => e.payload.type);
		expect(types).toEqual(["assistant.message", "session.updated"]);
		expect(svc.getSession(original.id)?.lastActiveAt).not.toBe(
			original.lastActiveAt,
		);
		sub.close();
	});

	it("throws on unknown session id", () => {
		const svc = makeService();
		expect(() =>
			svc.emitFromRunner("missing", { type: "session.completed" }),
		).toThrow(/unknown session/);
	});
});

describe("AgentService.setSessionStatus", () => {
	it("updates status, touches lastActiveAt, and emits session.updated", async () => {
		let registryNow = 1_700_000_000_000;
		const registryClock = (): Date => {
			const d = new Date(registryNow);
			registryNow += 60_000;
			return d;
		};
		const svc = new AgentService({
			sessionRegistry: { idGen: () => "ss1", clock: registryClock },
			eventBus: { clock: () => new Date(1_700_000_000_000) },
		});
		const sub = svc.subscribe();
		const session = svc.createSession({ origin: "web" });
		await sub.next(); // drain session.created
		const updated = svc.setSessionStatus(session.id, "running");
		expect(updated.status).toBe("running");
		expect(updated.lastActiveAt).not.toBe(session.lastActiveAt);
		const next = await sub.next();
		expect(next.done).toBe(false);
		if (next.done) throw new Error("unreachable");
		expect(next.value.payload).toEqual({
			type: "session.updated",
			session: updated,
		});
		sub.close();
	});

	it("throws on unknown session id", () => {
		const svc = makeService();
		expect(() => svc.setSessionStatus("missing", "completed")).toThrow(
			/unknown session/,
		);
	});
});

describe("AgentService.deleteSession", () => {
	it("returns true when the session existed and removes it", () => {
		const svc = makeService();
		const session = svc.createSession({ origin: "web" });
		expect(svc.deleteSession(session.id)).toBe(true);
		expect(svc.getSession(session.id)).toBeNull();
	});

	it("returns false for unknown session id", () => {
		const svc = makeService();
		expect(svc.deleteSession("nope")).toBe(false);
	});
});

describe("AgentService.getEventCount", () => {
	it("counts only events for the requested session", () => {
		const svc = makeService();
		const a = svc.createSession({ origin: "web" });
		const b = svc.createSession({ origin: "web" });
		svc.emitFromRunner(a.id, { type: "llm.text", turnIndex: 1, delta: "1" });
		svc.emitFromRunner(a.id, { type: "llm.text", turnIndex: 1, delta: "2" });
		svc.emitFromRunner(b.id, { type: "llm.text", turnIndex: 1, delta: "x" });
		// session.created is also an event for each session, so a has 3 (created + 2 deltas).
		expect(svc.getEventCount(a.id)).toBe(3);
		expect(svc.getEventCount(b.id)).toBe(2);
	});

	it("returns 0 for unknown session id", () => {
		const svc = makeService();
		expect(svc.getEventCount("nobody")).toBe(0);
	});
});

describe("AgentService.maxSessions", () => {
	it("evicts the oldest-by-lastActiveAt session after createSession exceeds the cap", () => {
		let counter = 0;
		const svc = new AgentService({
			maxSessions: 2,
			sessionRegistry: {
				idGen: () => `cap${++counter}`,
				clock: fixedClock(1_700_000_000_000, 60_000),
			},
		});
		const a = svc.createSession({ origin: "web" });
		const b = svc.createSession({ origin: "web" });
		expect(svc.listSessions()).toHaveLength(2);
		const c = svc.createSession({ origin: "web" });
		// `a` should be evicted: it's the oldest after `c` creates.
		expect(
			svc
				.listSessions()
				.map((s) => s.id)
				.sort(),
		).toEqual([b.id, c.id].sort());
		expect(svc.getSession(a.id)).toBeNull();
	});

	it("does not evict when cap is not exceeded", () => {
		let counter = 0;
		const svc = new AgentService({
			maxSessions: 5,
			sessionRegistry: {
				idGen: () => `cap${++counter}`,
				clock: fixedClock(1_700_000_000_000, 60_000),
			},
		});
		svc.createSession({ origin: "web" });
		svc.createSession({ origin: "web" });
		expect(svc.listSessions()).toHaveLength(2);
	});

	it("omitting maxSessions disables eviction entirely", () => {
		let counter = 0;
		const svc = new AgentService({
			sessionRegistry: {
				idGen: () => `nocap${++counter}`,
				clock: fixedClock(1_700_000_000_000, 60_000),
			},
		});
		for (let i = 0; i < 50; i += 1) svc.createSession({ origin: "web" });
		expect(svc.listSessions()).toHaveLength(50);
	});
});
