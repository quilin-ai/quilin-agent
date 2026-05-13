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
import type { AgentEvent } from "../services/agent-service/types.js";
import {
	createTuiSession,
	createTurnEventPump,
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

// ─────────────────────────────────────────────────────────────────────
// Slice C — createTurnEventPump
// ─────────────────────────────────────────────────────────────────────

function captureEvents(
	svc: ReturnType<typeof getOrCreateAgentService>,
	sessionId: string,
): readonly AgentEvent[] {
	return svc._getEventBus().historySnapshot({ sessionId });
}

function payloadTypes(events: readonly AgentEvent[]): readonly string[] {
	return events.map((e) => e.payload.type);
}

describe("createTurnEventPump (Slice C event pump)", () => {
	it("text-only stream produces start/delta/end + assistant.message", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-text");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-text",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "text", delta: "Hello" });
		pump.onLLMStreamEvent({ type: "text", delta: " world" });
		pump.onAssistantMessage({ role: "assistant", content: "Hello world" });
		const events = captureEvents(svc, "cp-text");
		// session.created + text_start + text(×2) + text_end + assistant.message
		// session.updated for assistant.message touchActivity:true
		const types = payloadTypes(events);
		// Drop session.created prefix to compare turn-level payload sequence.
		const turnSeq = types.filter(
			(t) => t !== "session.created" && t !== "session.updated",
		);
		expect(turnSeq).toEqual([
			"llm.text_start",
			"llm.text",
			"llm.text",
			"llm.text_end",
			"assistant.message",
		]);
	});

	it("reasoning stream emits reasoning_start/delta/end before assistant.message", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-rsn");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-rsn",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "reasoning", delta: "let me think" });
		pump.onLLMStreamEvent({ type: "reasoning", delta: " about it" });
		pump.onAssistantMessage({ role: "assistant", content: "done" });
		const turnSeq = payloadTypes(captureEvents(svc, "cp-rsn")).filter(
			(t) => t !== "session.created" && t !== "session.updated",
		);
		expect(turnSeq).toEqual([
			"llm.reasoning_start",
			"llm.reasoning",
			"llm.reasoning",
			"llm.reasoning_end",
			"assistant.message",
		]);
	});

	it("tool-call-start / tool-call-args-delta are dropped (per spec)", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-tool-buffered");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-tool-buffered",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({
			type: "tool-call-start",
			toolCallId: "tc-1",
			toolName: "file_read",
		});
		pump.onLLMStreamEvent({
			type: "tool-call-args-delta",
			toolCallId: "tc-1",
			toolName: "file_read",
			delta: '{"path":',
		});
		pump.onLLMStreamEvent({
			type: "tool-call-args-delta",
			toolCallId: "tc-1",
			toolName: "file_read",
			delta: ' "/etc/hosts"}',
		});
		const turnSeq = payloadTypes(captureEvents(svc, "cp-tool-buffered")).filter(
			(t) => t !== "session.created" && t !== "session.updated",
		);
		expect(turnSeq).toEqual([]);
	});

	it("tool-call-end emits tool.call with assembled input", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-tool-call");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-tool-call",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({
			type: "tool-call-end",
			toolCallId: "tc-1",
			toolName: "file_read",
			inputText: '{"path":"/etc/hosts"}',
			input: { path: "/etc/hosts" },
		});
		const events = captureEvents(svc, "cp-tool-call");
		const tc = events.find((e) => e.payload.type === "tool.call");
		expect(tc).toBeDefined();
		if (tc != null && tc.payload.type === "tool.call") {
			expect(tc.payload.toolCallId).toBe("tc-1");
			expect(tc.payload.toolName).toBe("file_read");
			expect(tc.payload.input).toEqual({ path: "/etc/hosts" });
		}
	});

	it("tool-result emits tool.result and propagates isError", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-tool-result");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-tool-result",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({
			type: "tool-result",
			toolCallId: "tc-1",
			toolName: "file_read",
			output: "content",
		});
		pump.onLLMStreamEvent({
			type: "tool-result",
			toolCallId: "tc-2",
			toolName: "file_read",
			output: "perm denied",
			isError: true,
		});
		const results = captureEvents(svc, "cp-tool-result").filter(
			(e) => e.payload.type === "tool.result",
		);
		expect(results).toHaveLength(2);
		const r1 = results[0];
		const r2 = results[1];
		if (r1?.payload.type === "tool.result") {
			expect(r1.payload.output).toBe("content");
			expect(r1.payload.isError).toBeUndefined();
		}
		if (r2?.payload.type === "tool.result") {
			expect(r2.payload.isError).toBe(true);
		}
	});

	it("tool-call-end auto-closes any open text/reasoning part", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-mixed");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-mixed",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "text", delta: "partial" });
		// No explicit text_end — pump must auto-close on tool-call.
		pump.onLLMStreamEvent({
			type: "tool-call-end",
			toolCallId: "tc-x",
			toolName: "x",
			inputText: "{}",
			input: {},
		});
		const turnSeq = payloadTypes(captureEvents(svc, "cp-mixed")).filter(
			(t) => t !== "session.created" && t !== "session.updated",
		);
		expect(turnSeq).toEqual([
			"llm.text_start",
			"llm.text",
			"llm.text_end",
			"tool.call",
		]);
	});

	it("onAssistantMessage auto-closes any open text/reasoning part", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-assistant-close");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-assistant-close",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "reasoning", delta: "thinking..." });
		// No explicit reasoning_end — pump must auto-close.
		pump.onAssistantMessage({ role: "assistant", content: "hello" });
		const turnSeq = payloadTypes(
			captureEvents(svc, "cp-assistant-close"),
		).filter((t) => t !== "session.created" && t !== "session.updated");
		expect(turnSeq).toEqual([
			"llm.reasoning_start",
			"llm.reasoning",
			"llm.reasoning_end",
			"assistant.message",
		]);
	});

	it("closePendingParts (called from turn finally) closes both text + reasoning idempotently", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-close");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-close",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "text", delta: "x" });
		pump.onLLMStreamEvent({ type: "reasoning", delta: "y" });
		// No assistant.message — partial turn (e.g., user interrupt).
		pump.closePendingParts();
		// Second call must be a no-op.
		pump.closePendingParts();
		const turnSeq = payloadTypes(captureEvents(svc, "cp-close")).filter(
			(t) => t !== "session.created" && t !== "session.updated",
		);
		// One start/end for each kind; no duplicates from the second close.
		expect(turnSeq).toEqual([
			"llm.text_start",
			"llm.text",
			"llm.reasoning_start",
			"llm.reasoning",
			"llm.text_end",
			"llm.reasoning_end",
		]);
	});

	it("uses unique part ids per turn (textPartId scoped by turnIndex + segment)", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-ids");
		const pump1 = createTurnEventPump({
			service: svc,
			sessionId: "cp-ids",
			turnIndex: 1,
		});
		const pump2 = createTurnEventPump({
			service: svc,
			sessionId: "cp-ids",
			turnIndex: 2,
		});
		pump1.onLLMStreamEvent({ type: "text", delta: "turn1" });
		pump1.closePendingParts();
		pump2.onLLMStreamEvent({ type: "text", delta: "turn2" });
		pump2.closePendingParts();
		const events = captureEvents(svc, "cp-ids");
		const textPartIds = events
			.map((e) => e.payload)
			.filter(
				(p): p is Extract<typeof p, { type: "llm.text" }> =>
					p.type === "llm.text",
			)
			.map((p) => p.textPartId);
		// Segment 0 for the first (and only) part within each turn.
		expect(textPartIds).toEqual(["text-1-0", "text-2-0"]);
	});

	it("re-opening text within one turn (after tool-call) uses a FRESH part id", () => {
		// Regression test for the close-reopen part-id collision
		// flagged by Slice C Reviewer B: when a text part is closed
		// by tool-call-end and a subsequent LLM step emits more text
		// in the same turn, the pump must allocate a new textPartId
		// so consumers rebuilding AI SDK SSE see distinct
		// text-start/text-end brackets per segment.
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-reopen");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-reopen",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "text", delta: "first" });
		pump.onLLMStreamEvent({
			type: "tool-call-end",
			toolCallId: "tc-1",
			toolName: "x",
			inputText: "{}",
			input: {},
		});
		pump.onLLMStreamEvent({ type: "text", delta: "second" });
		pump.closePendingParts();
		const events = captureEvents(svc, "cp-reopen");
		const startIds = events
			.map((e) => e.payload)
			.filter(
				(p): p is Extract<typeof p, { type: "llm.text_start" }> =>
					p.type === "llm.text_start",
			)
			.map((p) => p.textPartId);
		expect(startIds).toEqual(["text-1-0", "text-1-1"]);
		// Deltas line up with their respective segment ids.
		const deltaIds = events
			.map((e) => e.payload)
			.filter(
				(p): p is Extract<typeof p, { type: "llm.text" }> =>
					p.type === "llm.text",
			)
			.map((p) => p.textPartId);
		expect(deltaIds).toEqual(["text-1-0", "text-1-1"]);
	});

	it("re-opening reasoning within one turn also uses a FRESH part id", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-rsn-reopen");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-rsn-reopen",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "reasoning", delta: "first" });
		pump.onLLMStreamEvent({
			type: "tool-call-end",
			toolCallId: "tc-r",
			toolName: "x",
			inputText: "{}",
			input: {},
		});
		pump.onLLMStreamEvent({ type: "reasoning", delta: "second" });
		pump.closePendingParts();
		const events = captureEvents(svc, "cp-rsn-reopen");
		const startIds = events
			.map((e) => e.payload)
			.filter(
				(p): p is Extract<typeof p, { type: "llm.reasoning_start" }> =>
					p.type === "llm.reasoning_start",
			)
			.map((p) => p.reasoningPartId);
		expect(startIds).toEqual(["reasoning-1-0", "reasoning-1-1"]);
	});

	it("swallows LRU-evicted session errors silently (does not throw)", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "cp-evict");
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "cp-evict",
			turnIndex: 1,
		});
		// Evict before the pump emits anything.
		svc.deleteSession("cp-evict");
		expect(() => {
			pump.onLLMStreamEvent({ type: "text", delta: "x" });
			pump.onLLMStreamEvent({
				type: "tool-call-end",
				toolCallId: "tc",
				toolName: "x",
				inputText: "{}",
				input: {},
			});
			pump.onAssistantMessage({ role: "assistant", content: "y" });
			pump.closePendingParts();
		}).not.toThrow();
	});
});
