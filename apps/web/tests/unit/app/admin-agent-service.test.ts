/**
 * Integration tests for the admin AgentService probe routes (Task #22
 * Phase 5).
 *
 * The routes are gated by `process.env.QUILIN_ADMIN_PROBE === "1"`.
 * We exercise both states:
 *   - Probe disabled → 403 with `probe_disabled` code on every method.
 *   - Probe enabled → JSON listing for sessions, SSE stream for events,
 *     proper error envelopes for malformed inputs (`missing_session`,
 *     `bad_afterSeq`, `epoch_mismatch`, `session_not_found`).
 *
 * The AgentService singleton lives on globalThis; we install a fake
 * via `vi.mock("@/lib/agent-service-client")` and assert the route
 * threads our service into its return value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AgentEventPayload,
	AgentServiceLike,
	AgentSession,
	AgentSubscription,
	CreateSessionInput,
	SessionStatus,
	SubscribeOptions,
	SubscriptionInfo,
} from "@/lib/agent-service-client";

// Build a fake AgentService that the routes can read. We construct it
// in module scope so the `vi.mock` factory captures the same instance
// each route call sees.

function makeMockSubscription(events: readonly AgentEvent[]): AgentSubscription {
	let idx = 0;
	let closed = false;
	const info: SubscriptionInfo = { replayTruncated: false, epochMismatch: false };
	const iter: AgentSubscription = {
		async next() {
			if (closed) return { value: undefined, done: true };
			if (idx < events.length) {
				const value = events[idx];
				idx += 1;
				if (value == null) return { value: undefined, done: true };
				return { value, done: false };
			}
			return { value: undefined, done: true };
		},
		async return() {
			closed = true;
			return { value: undefined, done: true };
		},
		[Symbol.asyncIterator]() {
			return this;
		},
		close() {
			closed = true;
		},
		info,
	};
	return iter;
}

interface FakeServiceState {
	sessions: AgentSession[];
	events: AgentEvent[];
	epoch: string;
}

const state: FakeServiceState = {
	sessions: [],
	events: [],
	epoch: "test-epoch-1",
};

const fakeService: AgentServiceLike = {
	createSession(_input: CreateSessionInput): AgentSession {
		throw new Error("not used in admin probe tests");
	},
	getSession(id: string): AgentSession | null {
		return state.sessions.find((s) => s.id === id) ?? null;
	},
	listSessions() {
		return state.sessions;
	},
	subscribe(options: SubscribeOptions = {}): AgentSubscription {
		if (options.expectedEpoch != null && options.expectedEpoch !== state.epoch) {
			const sub = makeMockSubscription([]);
			(sub.info as { epochMismatch: boolean }).epochMismatch = true;
			return sub;
		}
		const afterSeq = options.afterSeq ?? 0;
		const filtered = state.events.filter(
			(e) => e.sessionId === options.sessionId && e.seq > afterSeq,
		);
		return makeMockSubscription(filtered);
	},
	currentEpoch() {
		return state.epoch;
	},
	currentSeq() {
		return state.events.length + 1;
	},
	emitFromRunner() {
		/* not used */
	},
	setSessionStatus(_id: string, _status: SessionStatus): AgentSession {
		throw new Error("not used");
	},
	deleteSession() {
		return false;
	},
	getEventCount(sessionId: string) {
		return state.events.filter((e) => e.sessionId === sessionId).length;
	},
};

vi.mock("@/lib/agent-service-client", () => ({
	getAgentService: () => Promise.resolve(fakeService),
}));

import { GET as eventsGET } from "@/app/api/admin/agent-service/events/route";
import { GET as sessionsGET } from "@/app/api/admin/agent-service/sessions/route";

function buildRequest(url: string): Request {
	return new Request(url);
}

function makeSession(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: "sess-1",
		title: "(new session)",
		origin: "web",
		status: "running",
		turnCount: 0,
		createdAt: new Date(0).toISOString(),
		lastActiveAt: new Date(0).toISOString(),
		...overrides,
	};
}

function makeEvent(seq: number, sessionId: string, payload: AgentEventPayload): AgentEvent {
	return {
		seq,
		sessionId,
		ts: new Date(seq * 1000).toISOString(),
		payload,
		epoch: state.epoch,
	};
}

beforeEach(() => {
	state.sessions = [];
	state.events = [];
	state.epoch = "test-epoch-1";
});

afterEach(() => {
	process.env.QUILIN_ADMIN_PROBE = "";
});

describe("GET /api/admin/agent-service/sessions — gate", () => {
	it("returns 403 with probe_disabled when QUILIN_ADMIN_PROBE is unset", async () => {
		process.env.QUILIN_ADMIN_PROBE = "";
		const res = await sessionsGET();
		expect(res.status).toBe(403);
		const body = (await res.json()) as { ok: boolean; error: { code: string } };
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe("probe_disabled");
	});

	it("returns 403 when QUILIN_ADMIN_PROBE has a non-'1' value (strict matching)", async () => {
		for (const val of ["true", "yes", "0", "on"]) {
			process.env.QUILIN_ADMIN_PROBE = val;
			const res = await sessionsGET();
			expect(res.status).toBe(403);
		}
	});

	it("returns 200 with the session list when QUILIN_ADMIN_PROBE === '1'", async () => {
		process.env.QUILIN_ADMIN_PROBE = "1";
		state.sessions.push(makeSession({ id: "a", status: "running" }));
		state.sessions.push(makeSession({ id: "b", status: "completed" }));
		state.events.push(makeEvent(1, "a", { type: "session.completed" }));
		state.events.push(makeEvent(2, "b", { type: "session.completed" }));
		state.events.push(makeEvent(3, "b", { type: "llm.text", turnIndex: 1, delta: "x" }));
		const res = await sessionsGET();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			data: {
				epoch: string;
				total: number;
				counts: Record<string, number>;
				sessions: ReadonlyArray<{ id: string; eventCount: number }>;
			};
		};
		expect(body.ok).toBe(true);
		expect(body.data.epoch).toBe("test-epoch-1");
		expect(body.data.total).toBe(2);
		expect(body.data.counts).toEqual({ running: 1, completed: 1 });
		const ids = body.data.sessions.map((s) => s.id).sort();
		expect(ids).toEqual(["a", "b"]);
		const eventCounts = Object.fromEntries(body.data.sessions.map((s) => [s.id, s.eventCount]));
		expect(eventCounts).toEqual({ a: 1, b: 2 });
	});

	it("returns 200 with empty session list when AgentService has no sessions", async () => {
		process.env.QUILIN_ADMIN_PROBE = "1";
		const res = await sessionsGET();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { total: number; sessions: unknown[] } };
		expect(body.data.total).toBe(0);
		expect(body.data.sessions).toEqual([]);
	});
});

describe("GET /api/admin/agent-service/events — gate + input validation", () => {
	beforeEach(() => {
		process.env.QUILIN_ADMIN_PROBE = "1";
	});

	it("returns 403 when probe is disabled", async () => {
		process.env.QUILIN_ADMIN_PROBE = "";
		const res = await eventsGET(buildRequest("http://t.invalid/api/admin/agent-service/events"));
		expect(res.status).toBe(403);
	});

	it("returns 400 when session query param is missing", async () => {
		const res = await eventsGET(buildRequest("http://t.invalid/api/admin/agent-service/events"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("missing_session");
	});

	it("returns 400 when afterSeq is not a non-negative integer", async () => {
		for (const bad of ["abc", "-1", "1.5", "NaN"]) {
			const res = await eventsGET(
				buildRequest(`http://t.invalid/api/admin/agent-service/events?session=s&afterSeq=${bad}`),
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("bad_afterSeq");
		}
	});

	it("returns 409 when caller-supplied epoch mismatches", async () => {
		state.sessions.push(makeSession({ id: "s" }));
		const res = await eventsGET(
			buildRequest("http://t.invalid/api/admin/agent-service/events?session=s&epoch=stale"),
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string }; data: { serverEpoch: string } };
		expect(body.error.code).toBe("epoch_mismatch");
		expect(body.data.serverEpoch).toBe("test-epoch-1");
	});

	it("returns 404 when sessionId is not registered in AgentService", async () => {
		const res = await eventsGET(
			buildRequest("http://t.invalid/api/admin/agent-service/events?session=ghost"),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("session_not_found");
	});
});

describe("GET /api/admin/agent-service/events — SSE happy path", () => {
	beforeEach(() => {
		process.env.QUILIN_ADMIN_PROBE = "1";
	});

	it("streams session events as SSE frames and terminates with [DONE]", async () => {
		state.sessions.push(makeSession({ id: "s" }));
		state.events.push(makeEvent(1, "s", { type: "llm.text", turnIndex: 1, delta: "hi" }));
		state.events.push(makeEvent(2, "s", { type: "session.completed" }));

		const res = await eventsGET(
			buildRequest("http://t.invalid/api/admin/agent-service/events?session=s"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-quilin-epoch")).toBe("test-epoch-1");
		const text = await res.text();
		// Expect one llm.text frame + one session.completed frame + [DONE].
		const lines = text.split("\n").filter((l) => l.startsWith("data:"));
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("data: [DONE]");
		const firstEvent = JSON.parse(lines[0]?.slice(6) ?? "{}") as AgentEvent;
		expect(firstEvent.payload.type).toBe("llm.text");
		const secondEvent = JSON.parse(lines[1]?.slice(6) ?? "{}") as AgentEvent;
		expect(secondEvent.payload.type).toBe("session.completed");
	});

	it("respects afterSeq, skipping replayed events", async () => {
		state.sessions.push(makeSession({ id: "s" }));
		state.events.push(makeEvent(1, "s", { type: "llm.text", turnIndex: 1, delta: "a" }));
		state.events.push(makeEvent(2, "s", { type: "llm.text", turnIndex: 1, delta: "b" }));
		state.events.push(makeEvent(3, "s", { type: "session.completed" }));

		const res = await eventsGET(
			buildRequest("http://t.invalid/api/admin/agent-service/events?session=s&afterSeq=1"),
		);
		const text = await res.text();
		const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
		// Expect: seq=2 llm.text + seq=3 session.completed + [DONE]
		expect(dataLines).toHaveLength(3);
		const first = JSON.parse(dataLines[0]?.slice(6) ?? "{}") as AgentEvent;
		expect(first.seq).toBe(2);
	});
});
