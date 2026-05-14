/**
 * Tests for `sse-translator.ts` (Task #22 Phase 2).
 *
 * Coverage strategy:
 *   1. `agentEventToSseChunk` — exhaustive per-payload-type assertion
 *      that the output matches the AI SDK v6 wire format chunk-by-chunk.
 *   2. `pumpFullStreamIntoAgentService` — drives the reverse direction
 *      against a fake `AgentServiceLike` that records every
 *      `emitFromRunner` call; asserts payload sequence + counters +
 *      tolerance for SDK field-name variants.
 *   3. Round trip — emit a hand-built `fullStream`, capture the
 *      emitted payloads, run each through `agentEventToSseChunk`, and
 *      verify the resulting SSE bytes match a reference fixture.
 */

import { describe, expect, it } from "vitest";

import type {
	AgentEvent,
	AgentEventPayload,
	AgentServiceLike,
	AgentSession,
	AgentSubscription,
	CreateSessionInput,
	EmitFromRunnerOptions,
	SessionStatus,
} from "@/lib/agent-service-client";
import {
	type AiSdkFullStreamChunk,
	agentEventToSseChunk,
	pumpFullStreamIntoAgentService,
	SSE_DONE_FRAME,
} from "@/lib/sse-translator";

interface RecordedEmit {
	readonly sessionId: string;
	readonly payload: AgentEventPayload;
	readonly options?: EmitFromRunnerOptions;
}

function makeFakeService(): {
	readonly service: AgentServiceLike;
	readonly emits: RecordedEmit[];
} {
	const emits: RecordedEmit[] = [];
	const service: AgentServiceLike = {
		createSession(_input: CreateSessionInput): AgentSession {
			throw new Error("not used in translator tests");
		},
		getSession(): AgentSession | null {
			return null;
		},
		listSessions() {
			return [];
		},
		subscribe(): AgentSubscription {
			throw new Error("not used in translator tests");
		},
		currentEpoch(): string {
			return "test-epoch";
		},
		currentSeq(): number {
			return 0;
		},
		emitFromRunner(
			sessionId: string,
			payload: AgentEventPayload,
			options?: EmitFromRunnerOptions,
		): void {
			emits.push({ sessionId, payload, ...(options == null ? {} : { options }) });
		},
		setSessionStatus(_id: string, _status: SessionStatus): AgentSession {
			throw new Error("not used");
		},
		deleteSession(): boolean {
			return false;
		},
		getEventCount(): number {
			return 0;
		},
	};
	return { service, emits };
}

function buildEvent(payload: AgentEventPayload, seq = 1): AgentEvent {
	return {
		seq,
		sessionId: "s1",
		ts: "2026-05-13T00:00:00.000Z",
		payload,
		epoch: "epoch-1",
	};
}

function parseChunkFromFrame(frame: string): Record<string, unknown> {
	// Strip `data: ` prefix and `\n\n` suffix, parse JSON.
	const trimmed = frame.replace(/^data:\s*/, "").replace(/\n\n$/, "");
	return JSON.parse(trimmed) as Record<string, unknown>;
}

async function* asyncIter<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

// ─────────────────────────────────────────────────────────────────────
// Forward: agentEventToSseChunk
// ─────────────────────────────────────────────────────────────────────

describe("agentEventToSseChunk — null returns (no wire counterpart)", () => {
	const session: AgentSession = {
		id: "s1",
		title: "t",
		origin: "web",
		status: "running",
		turnCount: 0,
		createdAt: "2026-05-13T00:00:00.000Z",
		lastActiveAt: "2026-05-13T00:00:00.000Z",
	};
	it("session.created → null", () => {
		expect(agentEventToSseChunk(buildEvent({ type: "session.created", session }))).toBeNull();
	});
	it("session.updated → null", () => {
		expect(agentEventToSseChunk(buildEvent({ type: "session.updated", session }))).toBeNull();
	});
	it("assistant.message → null (out-of-band)", () => {
		expect(
			agentEventToSseChunk(
				buildEvent({ type: "assistant.message", turnIndex: 1, content: "hello" }),
			),
		).toBeNull();
	});
	it("session.completed → null (terminator owned by caller)", () => {
		expect(agentEventToSseChunk(buildEvent({ type: "session.completed" }))).toBeNull();
	});
});

describe("agentEventToSseChunk — boundary chunks", () => {
	it("turn.started → {type:'start'} without messageId", () => {
		const chunk = parseChunkFromFrame(
			agentEventToSseChunk(buildEvent({ type: "turn.started", turnIndex: 1, userText: "hi" })) ??
				"",
		);
		expect(chunk).toEqual({ type: "start" });
	});

	it("turn.started → {type:'start', messageId} when messageId is set", () => {
		const chunk = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "turn.started",
					turnIndex: 1,
					userText: "hi",
					messageId: "msg-1",
				}),
			) ?? "",
		);
		expect(chunk).toEqual({ type: "start", messageId: "msg-1" });
	});

	it("turn.step_started → {type:'start-step'}", () => {
		const chunk = parseChunkFromFrame(
			agentEventToSseChunk(buildEvent({ type: "turn.step_started", turnIndex: 1, stepIndex: 1 })) ??
				"",
		);
		expect(chunk).toEqual({ type: "start-step" });
	});

	it("turn.step_completed → {type:'finish-step', finishReason?}", () => {
		const withReason = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "turn.step_completed",
					turnIndex: 1,
					stepIndex: 1,
					finishReason: "stop",
				}),
			) ?? "",
		);
		expect(withReason).toEqual({ type: "finish-step", finishReason: "stop" });

		const noReason = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({ type: "turn.step_completed", turnIndex: 1, stepIndex: 1 }),
			) ?? "",
		);
		expect(noReason).toEqual({ type: "finish-step" });
	});

	it("turn.completed → {type:'finish', finishReason?}", () => {
		const withReason = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({ type: "turn.completed", turnIndex: 1, finishReason: "stop" }),
			) ?? "",
		);
		expect(withReason).toEqual({ type: "finish", finishReason: "stop" });

		const noReason = parseChunkFromFrame(
			agentEventToSseChunk(buildEvent({ type: "turn.completed", turnIndex: 1 })) ?? "",
		);
		expect(noReason).toEqual({ type: "finish" });
	});
});

describe("agentEventToSseChunk — text/reasoning", () => {
	it("llm.text_start → {type:'text-start', id}", () => {
		const c = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({ type: "llm.text_start", turnIndex: 1, textPartId: "txt-0" }),
			) ?? "",
		);
		expect(c).toEqual({ type: "text-start", id: "txt-0" });
	});

	it("llm.text (with partId) → {type:'text-delta', id, delta}", () => {
		const c = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "llm.text",
					turnIndex: 1,
					delta: "hello",
					textPartId: "txt-0",
				}),
			) ?? "",
		);
		expect(c).toEqual({ type: "text-delta", id: "txt-0", delta: "hello" });
	});

	it("llm.text (no partId) → {type:'text-delta', delta} (id omitted)", () => {
		const c = parseChunkFromFrame(
			agentEventToSseChunk(buildEvent({ type: "llm.text", turnIndex: 1, delta: "hello" })) ?? "",
		);
		expect(c).toEqual({ type: "text-delta", delta: "hello" });
	});

	it("llm.text_end → {type:'text-end', id}", () => {
		const c = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({ type: "llm.text_end", turnIndex: 1, textPartId: "txt-0" }),
			) ?? "",
		);
		expect(c).toEqual({ type: "text-end", id: "txt-0" });
	});

	it("llm.reasoning_start / reasoning / reasoning_end mirror text shapes", () => {
		const start = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "llm.reasoning_start",
					turnIndex: 1,
					reasoningPartId: "rsn-0",
				}),
			) ?? "",
		);
		expect(start).toEqual({ type: "reasoning-start", id: "rsn-0" });

		const delta = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "llm.reasoning",
					turnIndex: 1,
					delta: "thinking",
					reasoningPartId: "rsn-0",
				}),
			) ?? "",
		);
		expect(delta).toEqual({ type: "reasoning-delta", id: "rsn-0", delta: "thinking" });

		const end = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "llm.reasoning_end",
					turnIndex: 1,
					reasoningPartId: "rsn-0",
				}),
			) ?? "",
		);
		expect(end).toEqual({ type: "reasoning-end", id: "rsn-0" });
	});
});

describe("agentEventToSseChunk — tool events", () => {
	// AI SDK v6 UIMessage wire format requires `tool-input-available` /
	// `tool-output-available` / `tool-output-error` — NOT the legacy
	// `tool-call` / `tool-result` / `tool-error` names. useChat's
	// `processUIMessageStream` switch has no arm for the legacy names,
	// so emitting them silently abort-streams the message. See
	// `web-e2e-capability-assessment.md` Bug #3.
	it("tool.call → {type:'tool-input-available', toolCallId, toolName, input?}", () => {
		const withInput = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.call",
					turnIndex: 1,
					toolCallId: "tc-1",
					toolName: "file_read",
					input: { path: "/etc/hosts" },
				}),
			) ?? "",
		);
		expect(withInput).toEqual({
			type: "tool-input-available",
			toolCallId: "tc-1",
			toolName: "file_read",
			input: { path: "/etc/hosts" },
		});

		const noInput = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.call",
					turnIndex: 1,
					toolCallId: "tc-1",
					toolName: "file_read",
				}),
			) ?? "",
		);
		expect(noInput).toEqual({
			type: "tool-input-available",
			toolCallId: "tc-1",
			toolName: "file_read",
		});
	});

	it("tool.result (success) → {type:'tool-output-available', toolCallId, output}", () => {
		const c = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.result",
					turnIndex: 1,
					toolCallId: "tc-1",
					toolName: "file_read",
					output: "content here",
				}),
			) ?? "",
		);
		// AI SDK v6 wire chunk shape: only toolCallId + output (toolName
		// not echoed back; client looks it up via the prior
		// tool-input-available).
		expect(c).toEqual({
			type: "tool-output-available",
			toolCallId: "tc-1",
			output: "content here",
		});
	});

	it("tool.result (isError=true) → {type:'tool-output-error', errorText}", () => {
		const stringErr = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.result",
					turnIndex: 1,
					toolCallId: "tc-1",
					toolName: "file_read",
					output: "file not found",
					isError: true,
				}),
			) ?? "",
		);
		expect(stringErr).toEqual({
			type: "tool-output-error",
			toolCallId: "tc-1",
			errorText: "file not found",
		});

		const objErr = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.result",
					turnIndex: 1,
					toolCallId: "tc-1",
					toolName: "shell_exec",
					output: { error: "permission denied" },
					isError: true,
				}),
			) ?? "",
		);
		expect(objErr).toEqual({
			type: "tool-output-error",
			toolCallId: "tc-1",
			errorText: "permission denied",
		});

		const objMessage = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.result",
					turnIndex: 1,
					toolCallId: "tc-2",
					toolName: "x",
					output: { message: "bad input" },
					isError: true,
				}),
			) ?? "",
		);
		expect(objMessage).toMatchObject({
			type: "tool-output-error",
			errorText: "bad input",
		});

		// Fallback: stringifies unknown shapes.
		const fallback = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.result",
					turnIndex: 1,
					toolCallId: "tc-3",
					toolName: "y",
					output: { weird: "shape", code: 7 },
					isError: true,
				}),
			) ?? "",
		);
		expect(fallback.type).toBe("tool-output-error");
		expect(typeof fallback.errorText).toBe("string");
		expect(JSON.parse(fallback.errorText as string)).toEqual({
			weird: "shape",
			code: 7,
		});

		// Null output is acceptable on errors.
		const nullOut = parseChunkFromFrame(
			agentEventToSseChunk(
				buildEvent({
					type: "tool.result",
					turnIndex: 1,
					toolCallId: "tc-4",
					toolName: "z",
					output: null,
					isError: true,
				}),
			) ?? "",
		);
		expect(nullOut.errorText).toBe("tool error");
	});
});

describe("agentEventToSseChunk — failure", () => {
	it("session.failed → {type:'error', error}", () => {
		const c = parseChunkFromFrame(
			agentEventToSseChunk(buildEvent({ type: "session.failed", error: "boom" })) ?? "",
		);
		expect(c).toEqual({ type: "error", error: "boom" });
	});
});

describe("SSE_DONE_FRAME constant", () => {
	it("matches the AI SDK terminator format", () => {
		expect(SSE_DONE_FRAME).toBe("data: [DONE]\n\n");
	});
});

// ─────────────────────────────────────────────────────────────────────
// Reverse: pumpFullStreamIntoAgentService
// ─────────────────────────────────────────────────────────────────────

describe("pumpFullStreamIntoAgentService — empty + unknown", () => {
	it("empty stream produces no emits, zero counters", async () => {
		const { service, emits } = makeFakeService();
		const result = await pumpFullStreamIntoAgentService(asyncIter([]), service, "s1", 1);
		expect(emits).toEqual([]);
		expect(result).toEqual({
			textDeltaCount: 0,
			toolCallCount: 0,
			stepCount: 0,
			finishReason: null,
			assembledText: "",
		});
	});

	it("ignores unknown chunk types without emitting", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "future-chunk-1" },
				{ type: "future-chunk-2", arbitrary: "field" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		expect(emits).toEqual([]);
	});

	it("ignores `start` chunks (caller already emitted turn.started)", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([{ type: "start" }] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		expect(emits).toEqual([]);
	});
});

describe("pumpFullStreamIntoAgentService — text-only stream", () => {
	it("text-start / text-delta / text-end emit paired part ids + assembled text", async () => {
		const { service, emits } = makeFakeService();
		const result = await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "start-step" },
				{ type: "text-start", id: "txt-0" },
				{ type: "text-delta", id: "txt-0", delta: "Hello" },
				{ type: "text-delta", id: "txt-0", delta: ", world" },
				{ type: "text-end", id: "txt-0" },
				{ type: "finish-step", finishReason: "stop" },
				{ type: "finish", finishReason: "stop" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const types = emits.map((e) => e.payload.type);
		expect(types).toEqual([
			"turn.step_started",
			"llm.text_start",
			"llm.text",
			"llm.text",
			"llm.text_end",
			"turn.step_completed",
			"assistant.message",
			"turn.completed",
		]);
		expect(result.textDeltaCount).toBe(2);
		expect(result.assembledText).toBe("Hello, world");
		expect(result.finishReason).toBe("stop");

		// assistant.message and turn.completed should be touchActivity: true.
		const assistant = emits.find((e) => e.payload.type === "assistant.message");
		expect(assistant?.options?.touchActivity).toBe(true);
		const turnDone = emits.find((e) => e.payload.type === "turn.completed");
		expect(turnDone?.options?.touchActivity).toBe(true);

		// text-delta events should NOT touchActivity.
		const deltas = emits.filter((e) => e.payload.type === "llm.text");
		for (const d of deltas) {
			expect(d.options?.touchActivity ?? false).toBe(false);
		}
	});

	it("tolerates SDK v5 textDelta field naming", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", textDelta: "v5-style" },
				{ type: "text-end", id: "t" },
				{ type: "finish" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const delta = emits.find((e) => e.payload.type === "llm.text");
		// pickPartId now suffixes `-s${stepCount}` to disambiguate the
		// same LLM-supplied id across multi-step streams (DeepSeek
		// reuses `txt-0` per step → previously dropped the second-step
		// text part in useChat). With no `start-step` chunk in this
		// test, stepCount stays at 0 and the id becomes `t-s0`.
		expect(delta?.payload).toMatchObject({
			type: "llm.text",
			delta: "v5-style",
			textPartId: "t-s0",
		});
	});

	it("tolerates SDK textId field naming on part boundaries", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "text-start", textId: "t-alt" },
				{ type: "text-delta", textId: "t-alt", delta: "x" },
				{ type: "text-end", textId: "t-alt" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const start = emits.find((e) => e.payload.type === "llm.text_start");
		// `-s0` suffix because no `start-step` precedes this fixture.
		// See `pickPartId` docstring for the multi-step disambiguation
		// rationale.
		expect(start?.payload).toMatchObject({ textPartId: "t-alt-s0" });
	});

	it("disambiguates text-part ids across multiple steps (multi-tool turn regression)", async () => {
		// Regression: LLMs like DeepSeek reuse `txt-0` at the start of
		// every step. Without per-step suffixing, AI SDK v6 `useChat`
		// dedupes the second-step text-start against the first-step
		// text part and silently drops all step-2/3 output. We
		// reproduce a two-step turn where both steps' text-start carry
		// `id: "txt-0"` and assert that the emitted textPartIds are
		// distinct (`txt-0-s1` vs `txt-0-s2`).
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "start-step" },
				{ type: "text-start", id: "txt-0" },
				{ type: "text-delta", id: "txt-0", delta: "step-one-text" },
				{ type: "text-end", id: "txt-0" },
				{ type: "tool-call", toolCallId: "tc-1", toolName: "f", input: {} },
				{ type: "tool-result", toolCallId: "tc-1", toolName: "f", output: "ok" },
				{ type: "finish-step", finishReason: "tool-calls" },
				{ type: "start-step" },
				{ type: "text-start", id: "txt-0" },
				{ type: "text-delta", id: "txt-0", delta: "step-two-text" },
				{ type: "text-end", id: "txt-0" },
				{ type: "finish-step", finishReason: "stop" },
				{ type: "finish", finishReason: "stop" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const startIds = emits
			.filter((e) => e.payload.type === "llm.text_start")
			.map((e) => (e.payload as Extract<typeof e.payload, { type: "llm.text_start" }>).textPartId);
		// First step's text-start gets `-s1`, second step's gets `-s2`.
		expect(startIds).toEqual(["txt-0-s1", "txt-0-s2"]);
		// Deltas must reference the in-step id, never collapsing into the
		// other step's id.
		const textPayloads = emits
			.filter((e) => e.payload.type === "llm.text")
			.map((e) => e.payload as Extract<typeof e.payload, { type: "llm.text" }>);
		expect(textPayloads[0]?.textPartId).toBe("txt-0-s1");
		expect(textPayloads[0]?.delta).toBe("step-one-text");
		expect(textPayloads[1]?.textPartId).toBe("txt-0-s2");
		expect(textPayloads[1]?.delta).toBe("step-two-text");
	});

	it("emits assistant.message only when text was accumulated", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([{ type: "finish", finishReason: "stop" }] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const types = emits.map((e) => e.payload.type);
		expect(types).toEqual(["turn.completed"]);
	});

	it("skips empty deltas without incrementing the counter", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", delta: "" },
				{ type: "text-delta", id: "t", delta: "real" },
				{ type: "text-end", id: "t" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const deltas = emits.filter((e) => e.payload.type === "llm.text");
		expect(deltas).toHaveLength(1);
	});
});

describe("pumpFullStreamIntoAgentService — reasoning", () => {
	it("reasoning chunks emit paired start/delta/end with reasoningPartId", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "reasoning-start", id: "rsn-0" },
				{ type: "reasoning-delta", id: "rsn-0", delta: "thinking" },
				{ type: "reasoning-end", id: "rsn-0" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const types = emits.map((e) => e.payload.type);
		expect(types).toEqual(["llm.reasoning_start", "llm.reasoning", "llm.reasoning_end"]);
		const delta = emits[1]?.payload;
		// `-s0` suffix because no `start-step` precedes this fixture.
		expect(delta).toMatchObject({ reasoningPartId: "rsn-0-s0", delta: "thinking" });
	});

	it("accepts `reasoning` field alias for delta value", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "reasoning-start", id: "r" },
				{ type: "reasoning-delta", id: "r", reasoning: "via-alias" },
				{ type: "reasoning-end", id: "r" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const delta = emits.find((e) => e.payload.type === "llm.reasoning");
		expect(delta?.payload).toMatchObject({ delta: "via-alias" });
	});
});

describe("pumpFullStreamIntoAgentService — tool events", () => {
	it("tool-call v6 (input) + tool-result v6 (output)", async () => {
		const { service, emits } = makeFakeService();
		const result = await pumpFullStreamIntoAgentService(
			asyncIter([
				{
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "file_read",
					input: { path: "/tmp" },
				},
				{
					type: "tool-result",
					toolCallId: "tc-1",
					toolName: "file_read",
					output: "ok",
				},
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		expect(result.toolCallCount).toBe(1);
		expect(emits.map((e) => e.payload.type)).toEqual(["tool.call", "tool.result"]);
		const call = emits[0]?.payload;
		expect(call).toMatchObject({
			type: "tool.call",
			toolCallId: "tc-1",
			toolName: "file_read",
			input: { path: "/tmp" },
		});
		const res = emits[1]?.payload;
		expect(res).toMatchObject({
			type: "tool.result",
			toolCallId: "tc-1",
			toolName: "file_read",
			output: "ok",
		});
	});

	it("tool-call v5 (args) + tool-result v5 (result)", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "x",
					args: { v5: true },
				},
				{
					type: "tool-result",
					toolCallId: "tc-1",
					toolName: "x",
					result: { ok: true },
				},
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		expect(emits[0]?.payload).toMatchObject({ input: { v5: true } });
		expect(emits[1]?.payload).toMatchObject({ output: { ok: true } });
	});

	it("tool-error chunk becomes tool.result with isError=true", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{
					type: "tool-error",
					toolCallId: "tc-1",
					toolName: "fail",
					error: "boom",
				},
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const res = emits[0]?.payload;
		expect(res).toMatchObject({
			type: "tool.result",
			toolCallId: "tc-1",
			toolName: "fail",
			isError: true,
		});
	});
});

describe("pumpFullStreamIntoAgentService — multi-step", () => {
	it("multiple start-step / finish-step pairs increment stepCount", async () => {
		const { service, emits } = makeFakeService();
		const result = await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "start-step" },
				{ type: "finish-step", finishReason: "tool-calls" },
				{ type: "start-step" },
				{ type: "finish-step", finishReason: "stop" },
				{ type: "finish", finishReason: "stop" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		expect(result.stepCount).toBe(2);
		const stepStarts = emits.filter((e) => e.payload.type === "turn.step_started");
		expect(stepStarts).toHaveLength(2);
		expect(stepStarts[0]?.payload).toMatchObject({ stepIndex: 1 });
		expect(stepStarts[1]?.payload).toMatchObject({ stepIndex: 2 });
	});
});

// ─────────────────────────────────────────────────────────────────────
// Round trip
// ─────────────────────────────────────────────────────────────────────

describe("Round trip: forward → reverse → forward", () => {
	it("text-only conversation produces consistent SSE bytes", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "start-step" },
				{ type: "text-start", id: "txt-0" },
				{ type: "text-delta", id: "txt-0", delta: "Hi" },
				{ type: "text-delta", id: "txt-0", delta: " there" },
				{ type: "text-end", id: "txt-0" },
				{ type: "finish-step", finishReason: "stop" },
				{ type: "finish", finishReason: "stop" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);

		const sseFrames: string[] = [];
		let seq = 1;
		for (const e of emits) {
			const frame = agentEventToSseChunk(buildEvent(e.payload, seq));
			seq += 1;
			if (frame != null) sseFrames.push(frame);
		}

		// Expect: start-step, text-start, text-delta×2, text-end, finish-step, finish
		// (assistant.message and turn.started are null-mapped, so omitted)
		const wireTypes = sseFrames.map((f) => parseChunkFromFrame(f).type);
		expect(wireTypes).toEqual([
			"start-step",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"finish-step",
			"finish",
		]);

		// Deltas concatenated should match original text.
		const deltas = sseFrames
			.map((f) => parseChunkFromFrame(f))
			.filter((c) => c.type === "text-delta")
			.map((c) => c.delta as string)
			.join("");
		expect(deltas).toBe("Hi there");
	});

	it("tool-call sequence round-trips with input + output preserved", async () => {
		const { service, emits } = makeFakeService();
		await pumpFullStreamIntoAgentService(
			asyncIter([
				{ type: "start-step" },
				{
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "x",
					input: { k: "v" },
				},
				{
					type: "tool-result",
					toolCallId: "tc-1",
					toolName: "x",
					output: { ok: 1 },
				},
				{ type: "finish-step", finishReason: "tool-calls" },
				{ type: "finish", finishReason: "tool-calls" },
			] as AiSdkFullStreamChunk[]),
			service,
			"s1",
			1,
		);
		const sseFrames: string[] = [];
		let seq = 1;
		for (const e of emits) {
			const frame = agentEventToSseChunk(buildEvent(e.payload, seq));
			seq += 1;
			if (frame != null) sseFrames.push(frame);
		}
		const parsed = sseFrames.map(parseChunkFromFrame);
		// AI SDK v6 wire names: `tool-input-available` /
		// `tool-output-available`. Legacy `tool-call` / `tool-result`
		// names abort useChat's stream silently.
		const call = parsed.find((c) => c.type === "tool-input-available");
		const result = parsed.find((c) => c.type === "tool-output-available");
		expect(call).toEqual({
			type: "tool-input-available",
			toolCallId: "tc-1",
			toolName: "x",
			input: { k: "v" },
		});
		expect(result).toEqual({
			type: "tool-output-available",
			toolCallId: "tc-1",
			output: { ok: 1 },
		});
	});
});
