/**
 * Iter F 交互 primitives — Slice 1 wire skeleton tests.
 *
 * 覆盖:
 *   - pending-asks 注册 + resolve(包括超时合成回复)
 *   - SSE translator 把 3 个新 AgentEventPayload 转成 data-* chunk
 *   - POST /api/chat/answer 校验 + 命中/未命中路径
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §3.2 + §3.3.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent, AgentEventPayload, AgentReplyPayload } from "@/lib/agent-service-client";
import {
	_resetPendingAsksForTests,
	registerAsk,
	resolveAsk,
	snapshotPendingAsks,
} from "@/lib/pending-asks";
import { agentEventToSseChunk } from "@/lib/sse-translator";

beforeEach(() => {
	_resetPendingAsksForTests();
});

afterEach(() => {
	_resetPendingAsksForTests();
});

describe("Slice 1 — pending-asks registry", () => {
	it("registerAsk + resolveAsk round-trip (with askToken)", async () => {
		const { askToken, reply: promise } = registerAsk({
			sessionId: "s1",
			askId: "ask-1",
			kind: "user_answered_question",
		});
		expect(snapshotPendingAsks().length).toBe(1);
		expect(askToken).toMatch(/^[a-f0-9]{32}$/);
		const reply: AgentReplyPayload = {
			kind: "user_answered_question",
			askId: "ask-1",
			answer: { mode: "single", selectedId: "yes" },
		};
		const delivered = resolveAsk("s1", "ask-1", askToken, reply);
		expect(delivered).toBe(true);
		expect(await promise).toEqual(reply);
		expect(snapshotPendingAsks().length).toBe(0);
	});

	it("resolveAsk returns false when askToken mismatches", async () => {
		registerAsk({
			sessionId: "s1b",
			askId: "ask-x",
			kind: "user_answered_question",
		});
		const delivered = resolveAsk("s1b", "ask-x", "00000000000000000000000000000000", {
			kind: "user_answered_question",
			askId: "ask-x",
			answer: { mode: "free_text", text: "spoofed" },
		});
		expect(delivered).toBe(false);
		// The legitimate ask is still pending.
		expect(snapshotPendingAsks().length).toBe(1);
	});

	it("resolveAsk returns false when no matching ask", () => {
		const delivered = resolveAsk("nope", "missing", "any-token", {
			kind: "user_answered_question",
			askId: "missing",
			answer: { mode: "timeout" },
		});
		expect(delivered).toBe(false);
	});

	it("timeout auto-resolves with synthetic timeout reply (question)", async () => {
		const { reply: promise } = registerAsk({
			sessionId: "s2",
			askId: "ask-timeout",
			kind: "user_answered_question",
			timeoutMs: 50,
		});
		const reply = await promise;
		expect(reply).toEqual({
			kind: "user_answered_question",
			askId: "ask-timeout",
			answer: { mode: "timeout" },
		});
		expect(snapshotPendingAsks().length).toBe(0);
	});

	it("timeout auto-resolves with synthetic deny reply (decision)", async () => {
		const { reply: promise } = registerAsk({
			sessionId: "s3",
			askId: "ask-deny-timeout",
			kind: "user_decision",
			timeoutMs: 50,
		});
		const reply = await promise;
		expect(reply).toEqual({
			kind: "user_decision",
			askId: "ask-deny-timeout",
			decision: "deny",
			reason: "timeout",
		});
	});

	it("clears timeout when manually resolved before deadline", async () => {
		const { askToken, reply: promise } = registerAsk({
			sessionId: "s4",
			askId: "ask-quick",
			kind: "user_answered_question",
			timeoutMs: 5000,
		});
		resolveAsk("s4", "ask-quick", askToken, {
			kind: "user_answered_question",
			askId: "ask-quick",
			answer: { mode: "single", selectedId: "fast" },
		});
		const reply = await promise;
		expect((reply as { answer: { mode: string } }).answer.mode).toBe("single");
		expect(snapshotPendingAsks().length).toBe(0);
	});

	it("eviction-on-cap preserves the evicted ask's own kind in the synthetic timeout reply", async () => {
		// Regression test for the bug where eviction used the incoming
		// ask's `kind` instead of the evicted ask's own `kind`, producing
		// the wrong reply shape (a `user_decision` Promise getting a
		// `user_answered_question` payload).
		const decisionAsk = registerAsk({
			sessionId: "s-cap",
			askId: "decision-victim",
			kind: "user_decision",
			timeoutMs: 60_000,
		});
		// Simulate cap pressure by stuffing MAX-1 more registrations of
		// the question kind, then one more triggers eviction of the
		// oldest (decisionAsk). Use long timeouts so they don't auto-fire.
		const filler: { askToken: string; reply: Promise<unknown> }[] = [];
		// 999 to take total to MAX_PENDING_ASKS; then one more to trigger eviction.
		for (let i = 0; i < 999; i += 1) {
			filler.push(
				registerAsk({
					sessionId: "s-cap",
					askId: `f-${i}`,
					kind: "user_answered_question",
					timeoutMs: 60_000,
				}),
			);
		}
		// This trigger registration evicts decisionAsk (the oldest).
		registerAsk({
			sessionId: "s-cap",
			askId: "trigger",
			kind: "user_answered_question",
			timeoutMs: 60_000,
		});
		const evicted = await decisionAsk.reply;
		// MUST be the user_decision shape (deny + reason=timeout), NOT
		// a user_answered_question payload.
		expect(evicted).toEqual({
			kind: "user_decision",
			askId: "decision-victim",
			decision: "deny",
			reason: "timeout",
		});
	});

	it("two asks on same session different askId both register independently", async () => {
		const r1 = registerAsk({ sessionId: "s5", askId: "a1", kind: "user_answered_question" });
		const r2 = registerAsk({ sessionId: "s5", askId: "a2", kind: "user_decision" });
		expect(snapshotPendingAsks().length).toBe(2);
		resolveAsk("s5", "a1", r1.askToken, {
			kind: "user_answered_question",
			askId: "a1",
			answer: { mode: "free_text", text: "ok" },
		});
		resolveAsk("s5", "a2", r2.askToken, {
			kind: "user_decision",
			askId: "a2",
			decision: "allow",
		});
		const [reply1, reply2] = await Promise.all([r1.reply, r2.reply]);
		expect(reply1.askId).toBe("a1");
		expect(reply2.askId).toBe("a2");
	});
});

function event(payload: AgentEventPayload): AgentEvent {
	return {
		seq: 1,
		sessionId: "x",
		ts: new Date().toISOString(),
		payload,
		epoch: "epoch-1",
	};
}

describe("Slice 1 — SSE translator for interaction events", () => {
	it("ask_user_question → data-ask chunk", () => {
		const chunk = agentEventToSseChunk(
			event({
				type: "ask_user_question",
				askId: "ask-1",
				askToken: "test-token-ask1",
				question: "选哪个方案?",
				mode: "single",
				options: [
					{ id: "a", label: "A 方案" },
					{ id: "b", label: "B 方案" },
				],
				timeoutMs: 60_000,
			}),
		);
		expect(chunk).not.toBeNull();
		const parsed = JSON.parse(chunk!.replace(/^data: /, "").replace(/\n\n$/, ""));
		expect(parsed.type).toBe("data-ask");
		expect(parsed.data.askId).toBe("ask-1");
		expect(parsed.data.mode).toBe("single");
		expect(parsed.data.options).toHaveLength(2);
		expect(parsed.data.timeoutMs).toBe(60_000);
	});

	it("ask_user_question free_text omits options correctly", () => {
		const chunk = agentEventToSseChunk(
			event({
				type: "ask_user_question",
				askId: "ask-2",
				askToken: "test-token-ask2",
				question: "请输入年份",
				mode: "free_text",
			}),
		);
		const parsed = JSON.parse(chunk!.replace(/^data: /, "").replace(/\n\n$/, ""));
		expect(parsed.type).toBe("data-ask");
		expect(parsed.data.options).toBeUndefined();
	});

	it("request_approval → data-approval chunk", () => {
		const chunk = agentEventToSseChunk(
			event({
				type: "request_approval",
				askId: "ap-1",
				askToken: "test-token-ap1",
				tool: "shell_exec",
				riskLevel: "medium",
				summary: "rm -rf .next/cache",
				detail: "argv: [...]",
				origin: "agent",
			}),
		);
		const parsed = JSON.parse(chunk!.replace(/^data: /, "").replace(/\n\n$/, ""));
		expect(parsed.type).toBe("data-approval");
		expect(parsed.data.riskLevel).toBe("medium");
		expect(parsed.data.origin).toBe("agent");
		expect(parsed.data.detail).toBe("argv: [...]");
	});

	it("aside → data-aside chunk preserves weight", () => {
		const chunk = agentEventToSseChunk(
			event({
				type: "aside",
				text: "我正在权衡两个选项",
				weight: "low",
			}),
		);
		const parsed = JSON.parse(chunk!.replace(/^data: /, "").replace(/\n\n$/, ""));
		expect(parsed.type).toBe("data-aside");
		expect(parsed.data.text).toContain("权衡");
		expect(parsed.data.weight).toBe("low");
	});

	it("aside without weight defaults gracefully (no weight field)", () => {
		const chunk = agentEventToSseChunk(event({ type: "aside", text: "短旁白" }));
		const parsed = JSON.parse(chunk!.replace(/^data: /, "").replace(/\n\n$/, ""));
		expect(parsed.type).toBe("data-aside");
		expect(parsed.data.weight).toBeUndefined();
	});
});

describe("Slice 1 — POST /api/chat/answer handler", () => {
	it("400 on missing/invalid body", async () => {
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: "not-json",
			}),
		);
		expect(res.status).toBe(400);
	});

	it("400 when reply.kind is invalid", async () => {
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s",
					askToken: "0".repeat(32),
					reply: { kind: "wrong", askId: "a", answer: { mode: "timeout" } },
				}),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("400 when askToken is missing", async () => {
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s-no-token",
					reply: {
						kind: "user_answered_question",
						askId: "a",
						answer: { mode: "free_text", text: "hi" },
					},
				}),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("400 when askToken is malformed (not 32 hex chars)", async () => {
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s-bad-tok",
					askToken: "not-hex",
					reply: {
						kind: "user_answered_question",
						askId: "a",
						answer: { mode: "free_text", text: "hi" },
					},
				}),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("410 when no pending ask matches (Slice 1 expected behavior — no runtime caller yet)", async () => {
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s-no-ask",
					askToken: "0".repeat(32),
					reply: {
						kind: "user_answered_question",
						askId: "non-existent",
						answer: { mode: "single", selectedId: "yes" },
					},
				}),
			}),
		);
		expect(res.status).toBe(410);
	});

	it("200 + {delivered:true} when matching ask is pending", async () => {
		const { askToken, reply: replyPromise } = registerAsk({
			sessionId: "s-good",
			askId: "ask-ok",
			kind: "user_answered_question",
			timeoutMs: 5000,
		});
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s-good",
					askToken,
					reply: {
						kind: "user_answered_question",
						askId: "ask-ok",
						answer: { mode: "free_text", text: "我选 B" },
					},
				}),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.delivered).toBe(true);
		const reply = await replyPromise;
		expect((reply as { answer: { text: string } }).answer.text).toBe("我选 B");
	});

	it("multi mode round-trip via endpoint", async () => {
		const { askToken, reply: replyPromise } = registerAsk({
			sessionId: "s-multi",
			askId: "m-1",
			kind: "user_answered_question",
			timeoutMs: 5000,
		});
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s-multi",
					askToken,
					reply: {
						kind: "user_answered_question",
						askId: "m-1",
						answer: { mode: "multi", selectedIds: ["x", "y"] },
					},
				}),
			}),
		);
		expect(res.status).toBe(200);
		const reply = (await replyPromise) as unknown as {
			answer: { mode: "multi"; selectedIds: string[] };
		};
		expect(reply.answer.selectedIds).toEqual(["x", "y"]);
	});

	it("user_decision allow_always_medium delivers correctly", async () => {
		const { askToken, reply: replyPromise } = registerAsk({
			sessionId: "s-dec",
			askId: "dec-1",
			kind: "user_decision",
			timeoutMs: 5000,
		});
		const { POST } = await import("@/app/api/chat/answer/route");
		const res = await POST(
			new Request("http://localhost/api/chat/answer", {
				method: "POST",
				body: JSON.stringify({
					sessionId: "s-dec",
					askToken,
					reply: {
						kind: "user_decision",
						askId: "dec-1",
						decision: "allow_always_medium",
						reason: "trusted",
					},
				}),
			}),
		);
		expect(res.status).toBe(200);
		const reply = (await replyPromise) as { decision: string; reason?: string };
		expect(reply.decision).toBe("allow_always_medium");
		expect(reply.reason).toBe("trusted");
	});
});
