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
import type {
	AgentEvent,
	AgentEventPayload,
} from "../services/agent-service/types.js";
import {
	createTuiSession,
	createTurnEventPump,
	findAgentServiceSession,
	getOrCreateAgentService,
	listAgentServiceSessions,
	markSessionStatus,
	renderAgentEvent,
	runRenderSubscription,
} from "./agent-service-bridge.js";
import {
	createStreamRenderState,
	type ReplStreamRenderState,
} from "./render-shared.js";

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

// ─────────────────────────────────────────────────────────────────────
// Slice D — renderAgentEvent
//
// Coverage strategy:
//   - One case per visible payload type (llm.text, llm.reasoning in both
//     display modes, tool.call, tool.result, tool.result+isError,
//     assistant.message finalize)
//   - One case for each "lifecycle / framing" payload type to lock in
//     the no-op contract (regression-guard against accidental render
//     additions)
//   - State threading: hasEmittedText / lastTextEndedWithNewline /
//     thinkingShown survive across events
// ─────────────────────────────────────────────────────────────────────

interface FakeWriter {
	chunks: string[];
	write(chunk: string): void;
}

function makeWriter(): FakeWriter {
	const chunks: string[] = [];
	return {
		chunks,
		write(chunk: string): void {
			chunks.push(chunk);
		},
	};
}

function wrapPayload(
	payload: AgentEventPayload,
	overrides: { seq?: number; sessionId?: string } = {},
): AgentEvent {
	return {
		seq: overrides.seq ?? 1,
		sessionId: overrides.sessionId ?? "s",
		ts: new Date(0).toISOString(),
		payload,
		epoch: "epoch-test",
	};
}

interface RenderCtx {
	stdout: FakeWriter;
	stderr: FakeWriter;
	renderState: ReplStreamRenderState;
}

function makeCtx(
	displayMode: "collapsed" | "verbose" = "collapsed",
): RenderCtx & {
	full: {
		stdout: FakeWriter;
		stderr: FakeWriter;
		displayMode: "collapsed" | "verbose";
		renderState: ReplStreamRenderState;
	};
} {
	const stdout = makeWriter();
	const stderr = makeWriter();
	const renderState = createStreamRenderState();
	return {
		stdout,
		stderr,
		renderState,
		full: { stdout, stderr, displayMode, renderState },
	};
}

describe("renderAgentEvent (Slice D — replay translator)", () => {
	it("llm.text writes the delta to stdout and tracks the trailing-newline flag", () => {
		const ctx = makeCtx();
		renderAgentEvent(
			wrapPayload({ type: "llm.text", turnIndex: 1, delta: "Hello" }),
			ctx.full,
		);
		expect(ctx.stdout.chunks).toEqual(["Hello"]);
		expect(ctx.renderState.hasEmittedText).toBe(true);
		expect(ctx.renderState.lastTextEndedWithNewline).toBe(false);

		renderAgentEvent(
			wrapPayload({ type: "llm.text", turnIndex: 1, delta: "world\n" }),
			ctx.full,
		);
		expect(ctx.stdout.chunks).toEqual(["Hello", "world\n"]);
		expect(ctx.renderState.lastTextEndedWithNewline).toBe(true);
	});

	it("llm.text with an empty delta does not clobber the trailing-newline flag", () => {
		const ctx = makeCtx();
		renderAgentEvent(
			wrapPayload({ type: "llm.text", turnIndex: 1, delta: "done\n" }),
			ctx.full,
		);
		expect(ctx.renderState.lastTextEndedWithNewline).toBe(true);
		// Provider final empty flush — must not flip the flag.
		renderAgentEvent(
			wrapPayload({ type: "llm.text", turnIndex: 1, delta: "" }),
			ctx.full,
		);
		expect(ctx.renderState.lastTextEndedWithNewline).toBe(true);
	});

	it("llm.reasoning in collapsed mode renders the thinking line once per turn", () => {
		const ctx = makeCtx("collapsed");
		renderAgentEvent(
			wrapPayload({
				type: "llm.reasoning",
				turnIndex: 1,
				delta: "let me think",
			}),
			ctx.full,
		);
		renderAgentEvent(
			wrapPayload({
				type: "llm.reasoning",
				turnIndex: 1,
				delta: " about it",
			}),
			ctx.full,
		);
		// One thinking line total (state.thinkingShown latches after the
		// first reasoning event).
		expect(ctx.stderr.chunks).toEqual(["💭 [thinking...]\n"]);
		expect(ctx.renderState.thinkingShown).toBe(true);
	});

	it("llm.reasoning in verbose mode streams the raw delta to stderr", () => {
		const ctx = makeCtx("verbose");
		renderAgentEvent(
			wrapPayload({
				type: "llm.reasoning",
				turnIndex: 1,
				delta: "let me think",
			}),
			ctx.full,
		);
		renderAgentEvent(
			wrapPayload({
				type: "llm.reasoning",
				turnIndex: 1,
				delta: " about it",
			}),
			ctx.full,
		);
		expect(ctx.stderr.chunks).toEqual(["let me think", " about it"]);
		// thinkingShown stays false in verbose mode — we stream deltas
		// directly without the 💭 latch.
		expect(ctx.renderState.thinkingShown).toBe(false);
	});

	it("tool.call writes the 🔧 calling line with a summarized JSON input", () => {
		const ctx = makeCtx();
		renderAgentEvent(
			wrapPayload({
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "tc-1",
				toolName: "file_read",
				input: { path: "/etc/hosts" },
			}),
			ctx.full,
		);
		expect(ctx.stderr.chunks).toEqual([
			'\n🔧 calling file_read({"path":"/etc/hosts"})\n',
		]);
	});

	it("tool.result emits ✅ for success and ⚠️ for isError", () => {
		const ctx = makeCtx();
		renderAgentEvent(
			wrapPayload({
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "tc-1",
				toolName: "file_read",
				output: "content",
			}),
			ctx.full,
		);
		renderAgentEvent(
			wrapPayload({
				type: "tool.result",
				turnIndex: 1,
				toolCallId: "tc-2",
				toolName: "file_read",
				output: "perm denied",
				isError: true,
			}),
			ctx.full,
		);
		expect(ctx.stderr.chunks).toEqual([
			"\n✅ file_read → content\n",
			"\n⚠️ file_read → perm denied\n",
		]);
	});

	it("assistant.message appends a finalize newline only when text ended without one", () => {
		// Case 1: emitted text without trailing \n → finalize writes \n.
		const ctx1 = makeCtx();
		renderAgentEvent(
			wrapPayload({ type: "llm.text", turnIndex: 1, delta: "Hello" }),
			ctx1.full,
		);
		renderAgentEvent(
			wrapPayload({
				type: "assistant.message",
				turnIndex: 1,
				content: "Hello",
			}),
			ctx1.full,
		);
		expect(ctx1.stdout.chunks).toEqual(["Hello", "\n"]);
		expect(ctx1.renderState.hasEmittedText).toBe(false);

		// Case 2: text already ended on \n → no extra \n.
		const ctx2 = makeCtx();
		renderAgentEvent(
			wrapPayload({ type: "llm.text", turnIndex: 1, delta: "Hi\n" }),
			ctx2.full,
		);
		renderAgentEvent(
			wrapPayload({
				type: "assistant.message",
				turnIndex: 1,
				content: "Hi",
			}),
			ctx2.full,
		);
		expect(ctx2.stdout.chunks).toEqual(["Hi\n"]);

		// Case 3: tool-only turn (no text deltas) → no finalize \n.
		const ctx3 = makeCtx();
		renderAgentEvent(
			wrapPayload({
				type: "assistant.message",
				turnIndex: 1,
				content: "",
			}),
			ctx3.full,
		);
		expect(ctx3.stdout.chunks).toEqual([]);
	});

	it("lifecycle / framing events are no-ops (regression guard)", () => {
		const ctx = makeCtx();
		const someSession = {
			id: "g",
			title: "x",
			origin: "tui" as const,
			status: "idle" as const,
			turnCount: 0,
			createdAt: new Date(0).toISOString(),
			lastActiveAt: new Date(0).toISOString(),
		};
		const framing: AgentEventPayload[] = [
			{ type: "llm.text_start", turnIndex: 1, textPartId: "text-1-0" },
			{ type: "llm.text_end", turnIndex: 1, textPartId: "text-1-0" },
			{
				type: "llm.reasoning_start",
				turnIndex: 1,
				reasoningPartId: "reasoning-1-0",
			},
			{
				type: "llm.reasoning_end",
				turnIndex: 1,
				reasoningPartId: "reasoning-1-0",
			},
			{ type: "turn.started", turnIndex: 1, userText: "hi" },
			{ type: "turn.step_started", turnIndex: 1, stepIndex: 0 },
			{ type: "turn.step_completed", turnIndex: 1, stepIndex: 0 },
			{ type: "turn.completed", turnIndex: 1 },
			// `session.created` + `session.updated` carry an `AgentSession`
			// payload — must also be no-op. Slice D Reviewer A SUSPECT.
			{ type: "session.created", session: someSession },
			{ type: "session.updated", session: someSession },
			{ type: "session.completed" },
			{ type: "session.failed", error: "boom" },
		];
		for (const payload of framing) {
			renderAgentEvent(wrapPayload(payload), ctx.full);
		}
		expect(ctx.stdout.chunks).toEqual([]);
		expect(ctx.stderr.chunks).toEqual([]);
	});

	it("tool.call with undefined input renders the toolname with an empty argument list", () => {
		// Slice D Reviewer A MEDIUM #3 — exercises the `payload.input ==
		// null ? "" : stringifyJson(...)` branch.
		const ctx = makeCtx();
		renderAgentEvent(
			wrapPayload({
				type: "tool.call",
				turnIndex: 1,
				toolCallId: "tc-empty",
				toolName: "no_args_tool",
			}),
			ctx.full,
		);
		expect(ctx.stderr.chunks).toEqual(["\n🔧 calling no_args_tool()\n"]);
	});

	it("assistant.message resets thinkingShown so subsequent turns re-render the thinking line", () => {
		// Slice D Reviewer A MEDIUM #1 — multi-turn replay must reset
		// `thinkingShown` at the turn boundary so each turn's reasoning
		// produces its own `💭 [thinking...]` indicator in collapsed
		// mode.
		const ctx = makeCtx("collapsed");
		renderAgentEvent(
			wrapPayload({ type: "llm.reasoning", turnIndex: 1, delta: "t1" }),
			ctx.full,
		);
		renderAgentEvent(
			wrapPayload({ type: "assistant.message", turnIndex: 1, content: "" }),
			ctx.full,
		);
		expect(ctx.renderState.thinkingShown).toBe(false);
		renderAgentEvent(
			wrapPayload({ type: "llm.reasoning", turnIndex: 2, delta: "t2" }),
			ctx.full,
		);
		// Both turns' first reasoning event produced a thinking line.
		expect(
			ctx.stderr.chunks.filter((c) => c === "💭 [thinking...]\n"),
		).toHaveLength(2);
	});
});

describe("render-shared helpers (Slice D regression — Reviewer A MEDIUM #4)", () => {
	it("summarizeToolOutput prefers the `result` string field when present", async () => {
		const { summarizeToolOutput } = await import("./render-shared.js");
		expect(summarizeToolOutput({ result: "the answer is 42" })).toBe(
			"the answer is 42",
		);
	});

	it("summarizeToolOutput falls back to the first line of `content` when no `result` string", async () => {
		const { summarizeToolOutput } = await import("./render-shared.js");
		expect(summarizeToolOutput({ content: "first line\nsecond line\n" })).toBe(
			"first line",
		);
	});

	it("summarizeToolOutput falls back to JSON when output is a plain non-record value", async () => {
		const { summarizeToolOutput } = await import("./render-shared.js");
		expect(summarizeToolOutput(42)).toBe("42");
		expect(summarizeToolOutput(true)).toBe("true");
	});

	it("summarizeToolOutput uses raw string output as-is (first line)", async () => {
		const { summarizeToolOutput } = await import("./render-shared.js");
		expect(summarizeToolOutput("line one\nline two")).toBe("line one");
	});

	it("summarizeToolOutput handles undefined output with the 'undefined' fallback", async () => {
		const { summarizeToolOutput } = await import("./render-shared.js");
		// `output ?? "undefined"` short-circuits to the string "undefined"
		// when output is null/undefined; then JSON-encoded.
		const got = summarizeToolOutput(undefined);
		expect(got).toBe('"undefined"');
	});

	it("stringifyJson returns String(value) when JSON.stringify yields undefined", async () => {
		const { stringifyJson } = await import("./render-shared.js");
		// JSON.stringify(undefined) returns undefined, so the fallback
		// to `String(value)` kicks in.
		expect(stringifyJson(undefined)).toBe("undefined");
		// Functions also stringify to undefined.
		const noop = () => undefined;
		expect(stringifyJson(noop)).toBe(String(noop));
	});

	it("stringifyJson returns '[Circular]' on cyclic structures (Reviewer B SUSPECT defense)", async () => {
		const { stringifyJson } = await import("./render-shared.js");
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(stringifyJson(cycle)).toBe("[Circular]");
	});

	it("summarizeInlineText collapses whitespace and truncates with ellipsis", async () => {
		const { summarizeInlineText } = await import("./render-shared.js");
		expect(summarizeInlineText("a   b\nc\t d")).toBe("a b c d");
		// At-boundary: length === maxLength (no truncation)
		const at = "x".repeat(120);
		expect(summarizeInlineText(at)).toBe(at);
		expect(summarizeInlineText(at).length).toBe(120);
		// Over-boundary: triggers `...` suffix
		const over = "x".repeat(125);
		const summarized = summarizeInlineText(over);
		expect(summarized.endsWith("...")).toBe(true);
		expect(summarized.length).toBe(120);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Slice D — runRenderSubscription
// ─────────────────────────────────────────────────────────────────────

async function waitForCondition(
	predicate: () => boolean,
	timeoutMs = 1000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitForCondition: timed out after ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 1));
	}
}

describe("runRenderSubscription (Slice D — subscription primitive)", () => {
	it("delivers events emitted after subscription start to onEvent", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-live");
		const seen: AgentEvent[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-live",
			onEvent: (event) => seen.push(event),
		});
		svc.emitFromRunner("rs-live", {
			type: "llm.text",
			turnIndex: 1,
			delta: "hi",
		});
		svc.emitFromRunner("rs-live", {
			type: "llm.text",
			turnIndex: 1,
			delta: " there",
		});
		await waitForCondition(
			() => seen.filter((e) => e.payload.type === "llm.text").length >= 2,
		);
		await handle.close();
		const textDeltas = seen.filter((e) => e.payload.type === "llm.text");
		expect(textDeltas).toHaveLength(2);
	});

	it("replays history when afterSeq is omitted (default: subscribe()'s history fan-out)", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-history");
		// Pre-load history before any subscription is established.
		svc.emitFromRunner("rs-history", {
			type: "llm.text",
			turnIndex: 1,
			delta: "past",
		});
		const seen: AgentEvent[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-history",
			onEvent: (event) => seen.push(event),
		});
		await waitForCondition(() =>
			seen.some(
				(e) => e.payload.type === "llm.text" && e.payload.delta === "past",
			),
		);
		await handle.close();
		expect(
			seen.some(
				(e) => e.payload.type === "llm.text" && e.payload.delta === "past",
			),
		).toBe(true);
	});

	it("afterSeq option suppresses replay of events at or before the cursor", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-cursor");
		// Drive the bus to seq=3.
		svc.emitFromRunner("rs-cursor", {
			type: "llm.text",
			turnIndex: 1,
			delta: "a",
		});
		svc.emitFromRunner("rs-cursor", {
			type: "llm.text",
			turnIndex: 1,
			delta: "b",
		});
		const cursorSeq = svc.currentSeq() - 1;
		const seen: AgentEvent[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-cursor",
			afterSeq: cursorSeq,
			onEvent: (event) => seen.push(event),
		});
		// Allow drain ticks; with afterSeq at the latest seq, nothing
		// should fire — earlier events are filtered out, no live events
		// emitted yet.
		for (let i = 0; i < 16; i += 1) {
			await Promise.resolve();
		}
		expect(seen.filter((e) => e.payload.type === "llm.text")).toEqual([]);
		// Now emit a fresh event; it should arrive.
		svc.emitFromRunner("rs-cursor", {
			type: "llm.text",
			turnIndex: 1,
			delta: "c",
		});
		await waitForCondition(() =>
			seen.some(
				(e) => e.payload.type === "llm.text" && e.payload.delta === "c",
			),
		);
		await handle.close();
	});

	it("close() stops further event delivery and is idempotent", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-close");
		const seen: AgentEvent[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-close",
			onEvent: (event) => seen.push(event),
		});
		await handle.close();
		await handle.close(); // idempotent
		svc.emitFromRunner("rs-close", {
			type: "llm.text",
			turnIndex: 1,
			delta: "post-close",
		});
		// Give the bus a few ticks to dispatch (or not, since we're closed).
		for (let i = 0; i < 16; i += 1) {
			await Promise.resolve();
		}
		expect(seen.filter((e) => e.payload.type === "llm.text")).toEqual([]);
	});

	it("abortSignal already-aborted at construction prevents any delivery", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-abort-pre");
		const ac = new AbortController();
		ac.abort();
		const seen: AgentEvent[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-abort-pre",
			abortSignal: ac.signal,
			onEvent: (event) => seen.push(event),
		});
		svc.emitFromRunner("rs-abort-pre", {
			type: "llm.text",
			turnIndex: 1,
			delta: "ignored",
		});
		for (let i = 0; i < 16; i += 1) {
			await Promise.resolve();
		}
		await handle.close();
		expect(seen.filter((e) => e.payload.type === "llm.text")).toEqual([]);
	});

	it("abortSignal fired after construction stops live delivery", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-abort-post");
		const ac = new AbortController();
		const seen: AgentEvent[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-abort-post",
			abortSignal: ac.signal,
			onEvent: (event) => seen.push(event),
		});
		svc.emitFromRunner("rs-abort-post", {
			type: "llm.text",
			turnIndex: 1,
			delta: "before",
		});
		await waitForCondition(
			() =>
				seen.filter(
					(e) => e.payload.type === "llm.text" && e.payload.delta === "before",
				).length === 1,
		);
		ac.abort();
		// Give the subscription a beat to react to the abort.
		for (let i = 0; i < 16; i += 1) {
			await Promise.resolve();
		}
		svc.emitFromRunner("rs-abort-post", {
			type: "llm.text",
			turnIndex: 1,
			delta: "after",
		});
		for (let i = 0; i < 16; i += 1) {
			await Promise.resolve();
		}
		await handle.close();
		expect(
			seen.filter(
				(e) => e.payload.type === "llm.text" && e.payload.delta === "after",
			),
		).toEqual([]);
	});

	it("onEvent throwing for one event does not break the subscription", async () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rs-throw");
		const seen: string[] = [];
		const handle = runRenderSubscription({
			service: svc,
			sessionId: "rs-throw",
			onEvent: (event) => {
				if (event.payload.type === "llm.text" && event.payload.delta === "b") {
					throw new Error("simulated render failure");
				}
				if (event.payload.type === "llm.text") {
					seen.push(event.payload.delta);
				}
			},
		});
		svc.emitFromRunner("rs-throw", {
			type: "llm.text",
			turnIndex: 1,
			delta: "a",
		});
		svc.emitFromRunner("rs-throw", {
			type: "llm.text",
			turnIndex: 1,
			delta: "b",
		});
		svc.emitFromRunner("rs-throw", {
			type: "llm.text",
			turnIndex: 1,
			delta: "c",
		});
		await waitForCondition(() => seen.length >= 2);
		await handle.close();
		expect(seen).toEqual(["a", "c"]);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Slice D — `/sessions <id>` end-to-end semantics
//
// Verifies the full pipeline:
//   live turn pump → AgentService history → renderAgentEvent → stdout/stderr
// without standing up the REPL. Mirrors what the TUI does when a user
// types `/sessions <id>`.
// ─────────────────────────────────────────────────────────────────────

describe("/sessions <id> replay pipeline (Slice D)", () => {
	it("renders a recorded turn's history identically to the live path", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rep-1");
		// Drive a Slice C turn pump as the source — same translation as
		// real TUI turns produce.
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "rep-1",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "text", delta: "Hello " });
		pump.onLLMStreamEvent({ type: "text", delta: "world" });
		pump.onLLMStreamEvent({
			type: "tool-call-end",
			toolCallId: "tc-1",
			toolName: "search",
			inputText: '{"q":"foo"}',
			input: { q: "foo" },
		});
		pump.onLLMStreamEvent({
			type: "tool-result",
			toolCallId: "tc-1",
			toolName: "search",
			output: "ok",
		});
		pump.onAssistantMessage({ role: "assistant", content: "Hello world" });
		// Now replay via the /sessions <id> path: historySnapshot +
		// renderAgentEvent.
		const stdout = makeWriter();
		const stderr = makeWriter();
		const renderState = createStreamRenderState();
		const events = svc._getEventBus().historySnapshot({ sessionId: "rep-1" });
		for (const event of events) {
			renderAgentEvent(event, {
				stdout,
				stderr,
				displayMode: "collapsed",
				renderState,
			});
		}
		// Reply text ended up on stdout (with the assistant.message
		// finalize newline).
		expect(stdout.chunks.join("")).toBe("Hello world\n");
		// Tool icon + result went to stderr.
		expect(stderr.chunks.join("")).toContain("🔧 calling search");
		expect(stderr.chunks.join("")).toContain("✅ search → ok");
	});

	it("replay survives circular tool outputs without throwing (defensive against JSON.stringify cycles)", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rep-circular");
		// Construct a circular object — exactly the failure mode flagged
		// by Slice D Reviewer B SUSPECT. Without the stringifyJson cycle
		// guard, summarizeToolOutput → JSON.stringify would throw and the
		// replay for-loop would tear down mid-stream.
		const circular: { self?: unknown } = {};
		circular.self = circular;
		svc.emitFromRunner("rep-circular", {
			type: "tool.result",
			turnIndex: 1,
			toolCallId: "tc-cycle",
			toolName: "weird_tool",
			output: circular,
		});
		const stdout = makeWriter();
		const stderr = makeWriter();
		const renderState = createStreamRenderState();
		const events = svc
			._getEventBus()
			.historySnapshot({ sessionId: "rep-circular" });
		expect(() => {
			for (const event of events) {
				renderAgentEvent(event, {
					stdout,
					stderr,
					displayMode: "collapsed",
					renderState,
				});
			}
		}).not.toThrow();
		// The output placeholder shows up in the rendered icon line.
		expect(stderr.chunks.join("")).toContain("✅ weird_tool");
	});

	it("replays nothing when the session has no buffered events (just lifecycle)", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "rep-empty");
		const stdout = makeWriter();
		const stderr = makeWriter();
		const renderState = createStreamRenderState();
		const events = svc
			._getEventBus()
			.historySnapshot({ sessionId: "rep-empty" });
		// session.created is the only event; renderAgentEvent treats it
		// as a no-op.
		for (const event of events) {
			renderAgentEvent(event, {
				stdout,
				stderr,
				displayMode: "collapsed",
				renderState,
			});
		}
		expect(stdout.chunks).toEqual([]);
		expect(stderr.chunks).toEqual([]);
	});
});
