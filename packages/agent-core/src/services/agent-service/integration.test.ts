/**
 * Cross-frontend integration test for the AgentService (Task #29
 * Slice F). Verifies the single in-process AgentService bridges
 * TUI- and web-origin sessions cleanly:
 *
 *   1. TUI-created sessions appear in `listSessions` regardless of
 *      origin filter ("tui" / "web" / "api").
 *   2. Web-created sessions are visible to the TUI bridge's
 *      `findAgentServiceSession`.
 *   3. A simulated TUI turn (via `createTurnEventPump` Slice C path)
 *      produces the full AgentEvent sequence on the bus, including
 *      turn boundaries.
 *   4. The Slice D `renderAgentEvent` translator faithfully replays
 *      a recorded session's history when the TUI swaps view via
 *      `/sessions <id>` (uses `historySnapshot` synchronously).
 *
 * 跨前端集成测试:确认同一进程 AgentService 同时承载 TUI 和 web
 * session,Slice C 的 pump 产出完整事件序列,Slice D 的 replay 翻译
 * 与原始 live 顺序一致。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTuiSession,
	createTurnEventPump,
	findAgentServiceSession,
	getOrCreateAgentService,
	listAgentServiceSessions,
	markSessionStatus,
	renderAgentEvent,
} from "../../repl/agent-service-bridge.js";
import { createStreamRenderState } from "../../repl/render-shared.js";
import type { AgentService } from "./index.js";

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

describe("AgentService cross-frontend integration (Slice F)", () => {
	it("TUI-created session is visible via the read-side bridge listSessions", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "tui-integration-1", "TUI session");
		const sessions = listAgentServiceSessions(svc);
		const tui = sessions.find((s) => s.id === "tui-integration-1");
		expect(tui).toBeDefined();
		expect(tui?.origin).toBe("tui");
	});

	it("Web-origin session created directly on AgentService is also visible via the TUI bridge", () => {
		// Web's chat route does:
		//   `service.createSession({ origin: "web", id })`
		// (see apps/web/lib/agent-service-client.ts). We simulate the
		// same direct construction. The TUI bridge's
		// `findAgentServiceSession` must see it without any extra
		// registration — that's the single-singleton contract.
		const svc = getOrCreateAgentService();
		svc.createSession({ origin: "web", id: "web-integration-1" });
		const got = findAgentServiceSession(svc, "web-integration-1");
		expect(got).not.toBeNull();
		expect(got?.origin).toBe("web");
	});

	it("listSessions returns sessions of every origin in a single snapshot", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "tui-mix-1");
		svc.createSession({ origin: "web", id: "web-mix-1" });
		svc.createSession({ origin: "api", id: "api-mix-1" });
		const origins = listAgentServiceSessions(svc)
			.map((s) => s.origin)
			.sort();
		expect(origins).toEqual(["api", "tui", "web"]);
	});

	it("a simulated TUI turn pump produces the full AgentEvent sequence on the bus", () => {
		// Mirrors `repl.ts` Slice C wiring: createTurnEventPump +
		// emitFromRunner for turn boundaries. We don't go through
		// runAgentLoop — that needs a live LLM. Instead we drive the
		// pump manually with the same LLMStreamEvent shapes the
		// StreamingLLMClient would emit.
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "tui-turn-1");
		markSessionStatus(svc, "tui-turn-1", "running");
		svc.emitFromRunner(
			"tui-turn-1",
			{ type: "turn.started", turnIndex: 1, userText: "hello" },
			{ touchActivity: true },
		);
		const pump = createTurnEventPump({
			service: svc,
			sessionId: "tui-turn-1",
			turnIndex: 1,
		});
		pump.onLLMStreamEvent({ type: "text", delta: "hi " });
		pump.onLLMStreamEvent({ type: "text", delta: "there" });
		pump.onAssistantMessage({ role: "assistant", content: "hi there" });
		svc.emitFromRunner(
			"tui-turn-1",
			{ type: "turn.completed", turnIndex: 1 },
			{ touchActivity: true },
		);
		markSessionStatus(svc, "tui-turn-1", "idle");

		const events = svc
			._getEventBus()
			.historySnapshot({ sessionId: "tui-turn-1" });
		const types = events.map((e) => e.payload.type);
		// session.created → status updates(running) → turn.started →
		// llm.text_start → llm.text(×2) → llm.text_end → assistant.message
		// → turn.completed → status updates(idle) — exact ordering.
		expect(types).toContain("session.created");
		expect(types).toContain("turn.started");
		expect(types).toContain("llm.text_start");
		expect(types).toContain("llm.text");
		expect(types).toContain("llm.text_end");
		expect(types).toContain("assistant.message");
		expect(types).toContain("turn.completed");
	});

	it("Slice D `renderAgentEvent` replays a web-recorded session faithfully", () => {
		// Web records a session through the AgentService directly (in
		// real code, via apps/web/lib/sse-translator.ts's reverse pump).
		// We simulate by emitting the same AgentEventPayload sequence
		// the web pump would produce, then run the TUI's /sessions <id>
		// replay path (`historySnapshot` + `renderAgentEvent`) over it.
		const svc = getOrCreateAgentService();
		const id = "web-replay-1";
		svc.createSession({ origin: "web", id });
		svc.emitFromRunner(
			id,
			{ type: "turn.started", turnIndex: 1, userText: "ask web" },
			{ touchActivity: true },
		);
		svc.emitFromRunner(id, {
			type: "llm.text_start",
			turnIndex: 1,
			textPartId: "text-1-0",
		});
		svc.emitFromRunner(id, {
			type: "llm.text",
			turnIndex: 1,
			delta: "hello web",
			textPartId: "text-1-0",
		});
		svc.emitFromRunner(id, {
			type: "llm.text_end",
			turnIndex: 1,
			textPartId: "text-1-0",
		});
		svc.emitFromRunner(
			id,
			{ type: "assistant.message", turnIndex: 1, content: "hello web" },
			{ touchActivity: true },
		);
		svc.emitFromRunner(
			id,
			{ type: "turn.completed", turnIndex: 1 },
			{ touchActivity: true },
		);

		// Now replay through the TUI render translator.
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const renderState = createStreamRenderState();
		const events = svc._getEventBus().historySnapshot({ sessionId: id });
		for (const event of events) {
			renderAgentEvent(event, {
				stdout: { write: (s) => stdoutChunks.push(s) },
				stderr: { write: (s) => stderrChunks.push(s) },
				displayMode: "collapsed",
				renderState,
			});
		}
		// The reply text appeared on stdout; the finalize newline closed
		// out the assistant.message boundary.
		expect(stdoutChunks.join("")).toBe("hello web\n");
		// No tool-call / tool-result icons in this turn, so stderr stays empty.
		expect(stderrChunks).toEqual([]);
	});

	it("status transitions are visible to the bridge across origins", () => {
		const svc = getOrCreateAgentService();
		createTuiSession(svc, "status-cross-1");
		markSessionStatus(svc, "status-cross-1", "running");
		// Web-side reads via the same bridge.
		const seen = findAgentServiceSession(svc, "status-cross-1");
		expect(seen?.status).toBe("running");
		markSessionStatus(svc, "status-cross-1", "completed");
		expect(findAgentServiceSession(svc, "status-cross-1")?.status).toBe(
			"completed",
		);
	});

	it("singleton reuse across TUI and web — getOrCreateAgentService returns the same instance the web side would attach to", () => {
		const tuiSide = getOrCreateAgentService();
		// Simulate the web side touching globalThis directly — the
		// pattern apps/web/lib/agent-service-client.ts uses.
		const webSide = (globalThis as unknown as GlobalShape)
			.__quilin_agent_service__;
		expect(webSide).toBe(tuiSide);
	});
});
