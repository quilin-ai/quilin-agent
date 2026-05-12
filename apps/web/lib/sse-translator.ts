/**
 * SSE translator — AI SDK v6 ⇄ AgentService event bridge.
 *
 * Two directions:
 *   1. **Reverse** (`pumpFullStreamIntoAgentService`): drain a
 *      `streamText().fullStream` async iterable, translate each AI SDK
 *      chunk into `AgentEventPayload`, and push via
 *      `service.emitFromRunner(sessionId, payload, opts)`. Tracks
 *      active text/reasoning part ids in a small state machine so the
 *      paired `*_start` / `*` / `*_end` events arrive in order.
 *   2. **Forward** (`agentEventToSseChunk`): given an `AgentEvent`,
 *      render the AI SDK v6 UIMessage SSE chunk string the browser
 *      `useChat` hook expects. Returns `null` for events with no wire
 *      counterpart (`session.created` / `session.updated`).
 *
 * Why pure functions: the chat route's HTTP handler decides when to
 * pump and when to subscribe; the translator just does the mapping.
 * Same shape works for the admin probe in Phase 5 (forward only).
 *
 * SSE 翻译层(双向):
 *   - 反向: streamText.fullStream → AgentEventPayload(经状态机配对
 *     text/reasoning 起止)
 *   - 正向: AgentEvent → AI SDK v6 SSE chunk(useChat 能消费的字符串)
 *
 * Task #22 Phase 2.
 */

import type { AgentEvent, AgentEventPayload, AgentServiceLike } from "./agent-service-client.js";

/**
 * AI SDK v6 `fullStream` event shape. The SDK changes part-id field
 * names across point releases (some emit `id`, some `textId`); we
 * accept either and normalize. Tool-call fields likewise tolerate the
 * v5 (`args` / `result`) and v6 (`input` / `output`) shapes.
 *
 * AI SDK v6 fullStream 事件形状,字段命名跨版本有差异,这里全兼容。
 */
export interface AiSdkFullStreamChunk {
	readonly type: string;
	readonly id?: string;
	readonly textId?: string;
	readonly reasoningId?: string;
	readonly text?: string;
	readonly textDelta?: string;
	readonly delta?: string;
	readonly reasoning?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly input?: unknown;
	readonly args?: unknown;
	readonly output?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly finishReason?: string;
	readonly messageId?: string;
}

export interface PumpResult {
	readonly textDeltaCount: number;
	readonly toolCallCount: number;
	readonly stepCount: number;
	readonly finishReason: string | null;
	readonly assembledText: string;
}

/**
 * Tracks an in-progress text or reasoning part by id. We only need the
 * id (to emit on `_end` and `_delta` when the underlying chunk omits
 * it) — the actual text contents accumulate into the top-level
 * `assembledText` buffer.
 */
interface ActivePart {
	readonly id: string;
}

/**
 * Drain an AI SDK v6 `fullStream` iterator, translating each chunk into
 * `AgentEventPayload` and pushing to `service.emitFromRunner`. Returns
 * counters useful for logging/debug.
 *
 * Contract:
 *   - The caller already created the session and emitted
 *     `turn.started`. This function emits all sub-turn events plus a
 *     final `assistant.message` (carrying the accumulated text), then
 *     `turn.completed`. It does NOT emit `session.completed` /
 *     `session.failed` — the caller decides session-level termination
 *     based on whether the stream drained successfully or threw.
 *   - Token-delta events use `touchActivity: false` (default) so
 *     `lastActiveAt` doesn't churn per character; boundary events
 *     (`turn.step_completed`, `assistant.message`, `turn.completed`)
 *     use `touchActivity: true`.
 *
 * Stream chunks handled:
 *   - `start` (ignored — caller already emitted `turn.started`)
 *   - `start-step` → `turn.step_started`
 *   - `text-start` → `llm.text_start`
 *   - `text-delta` → `llm.text` (accumulates into `assembledText`)
 *   - `text-end` → `llm.text_end`
 *   - `reasoning-start` → `llm.reasoning_start`
 *   - `reasoning-delta` → `llm.reasoning`
 *   - `reasoning-end` → `llm.reasoning_end`
 *   - `tool-call` → `tool.call`
 *   - `tool-result` → `tool.result`
 *   - `tool-error` → `tool.result` with `isError: true`
 *   - `finish-step` → `turn.step_completed` + emits `assistant.message`
 *     if a text part closed in this step
 *   - `finish` → emits final `assistant.message` (if buffered) +
 *     `turn.completed`
 *   - `error` / `abort` → ignored at this level (caller decides what
 *     to do with the surrounding promise rejection)
 *   - Unknown chunk types → silently dropped (forward compat)
 *
 * 反向 pump:把 AI SDK v6 fullStream 翻译成 AgentEventPayload。
 * 调用方先 emit turn.started + 决定 session 终止,本函数管中间所有 event。
 */
export async function pumpFullStreamIntoAgentService(
	fullStream: AsyncIterable<unknown>,
	service: AgentServiceLike,
	sessionId: string,
	turnIndex: number,
): Promise<PumpResult> {
	let textDeltaCount = 0;
	let toolCallCount = 0;
	let stepCount = 0;
	let finishReason: string | null = null;
	let activeText: ActivePart | null = null;
	let activeReasoning: ActivePart | null = null;
	let assembledText = "";

	function emit(payload: AgentEventPayload, touchActivity = false): void {
		service.emitFromRunner(sessionId, payload, { touchActivity });
	}

	function pickPartId(chunk: AiSdkFullStreamChunk, fallback: string): string {
		return chunk.id ?? chunk.textId ?? chunk.reasoningId ?? fallback;
	}

	function pickDelta(chunk: AiSdkFullStreamChunk): string {
		return chunk.delta ?? chunk.text ?? chunk.textDelta ?? chunk.reasoning ?? "";
	}

	for await (const raw of fullStream) {
		const chunk = raw as AiSdkFullStreamChunk;
		switch (chunk.type) {
			case "start":
				// `turn.started` already emitted by caller; ignore.
				break;
			case "start-step": {
				stepCount += 1;
				emit({ type: "turn.step_started", turnIndex, stepIndex: stepCount });
				break;
			}
			case "text-start": {
				const id = pickPartId(chunk, `text-${turnIndex}-${stepCount}`);
				activeText = { id };
				emit({ type: "llm.text_start", turnIndex, textPartId: id });
				break;
			}
			case "text-delta": {
				const delta = pickDelta(chunk);
				if (delta.length === 0) break;
				textDeltaCount += 1;
				assembledText += delta;
				const textPartId = activeText?.id;
				emit({
					type: "llm.text",
					turnIndex,
					delta,
					...(textPartId == null ? {} : { textPartId }),
				});
				break;
			}
			case "text-end": {
				const id = pickPartId(chunk, activeText?.id ?? `text-${turnIndex}-${stepCount}`);
				emit({ type: "llm.text_end", turnIndex, textPartId: id });
				activeText = null;
				break;
			}
			case "reasoning-start": {
				const id = pickPartId(chunk, `reasoning-${turnIndex}-${stepCount}`);
				activeReasoning = { id };
				emit({ type: "llm.reasoning_start", turnIndex, reasoningPartId: id });
				break;
			}
			case "reasoning-delta": {
				const delta = pickDelta(chunk);
				if (delta.length === 0) break;
				const reasoningPartId = activeReasoning?.id;
				emit({
					type: "llm.reasoning",
					turnIndex,
					delta,
					...(reasoningPartId == null ? {} : { reasoningPartId }),
				});
				break;
			}
			case "reasoning-end": {
				const id = pickPartId(chunk, activeReasoning?.id ?? `reasoning-${turnIndex}-${stepCount}`);
				emit({ type: "llm.reasoning_end", turnIndex, reasoningPartId: id });
				activeReasoning = null;
				break;
			}
			case "tool-call": {
				toolCallCount += 1;
				const toolCallId = String(chunk.toolCallId ?? "");
				const toolName = String(chunk.toolName ?? "tool");
				const input = chunk.input ?? chunk.args;
				emit({
					type: "tool.call",
					turnIndex,
					toolCallId,
					toolName,
					...(input === undefined ? {} : { input }),
				});
				break;
			}
			case "tool-result": {
				const toolCallId = String(chunk.toolCallId ?? "");
				const toolName = String(chunk.toolName ?? "tool");
				const output = chunk.output ?? chunk.result;
				emit({
					type: "tool.result",
					turnIndex,
					toolCallId,
					toolName,
					output,
				});
				break;
			}
			case "tool-error": {
				const toolCallId = String(chunk.toolCallId ?? "");
				const toolName = String(chunk.toolName ?? "tool");
				emit({
					type: "tool.result",
					turnIndex,
					toolCallId,
					toolName,
					output: { error: String(chunk.error ?? "") },
					isError: true,
				});
				break;
			}
			case "finish-step": {
				const reason = chunk.finishReason;
				emit(
					{
						type: "turn.step_completed",
						turnIndex,
						stepIndex: stepCount,
						...(reason == null ? {} : { finishReason: reason }),
					},
					true,
				);
				break;
			}
			case "finish": {
				if (chunk.finishReason != null) finishReason = chunk.finishReason;
				if (assembledText.length > 0) {
					emit({ type: "assistant.message", turnIndex, content: assembledText }, true);
				}
				emit(
					{
						type: "turn.completed",
						turnIndex,
						...(finishReason == null ? {} : { finishReason }),
					},
					true,
				);
				break;
			}
			default:
				// Unknown chunk type — silently drop for forward-compat. The
				// SDK regularly adds new chunk types; logging here would be
				// noisy. Tests cover known types explicitly.
				break;
		}
	}

	return { textDeltaCount, toolCallCount, stepCount, finishReason, assembledText };
}

/**
 * Forward translation: render an `AgentEvent` as the SSE wire-format
 * string the AI SDK v6 `useChat` hook expects. Returns `null` for
 * events that don't have a wire counterpart (session lifecycle is
 * out-of-band metadata for SSE clients).
 *
 * Output is the full SSE frame: `data: <json>\n\n`. Caller writes
 * directly to the response without further wrapping.
 *
 * 正向翻译:AgentEvent → AI SDK v6 SSE 字符串(`data: <json>\n\n`)。
 * 无 wire 对应的 event(session.created/updated)返回 null。
 */
export function agentEventToSseChunk(event: AgentEvent): string | null {
	const p = event.payload;
	const chunk = payloadToChunk(p);
	if (chunk == null) return null;
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

function payloadToChunk(payload: AgentEventPayload): Record<string, unknown> | null {
	switch (payload.type) {
		case "session.created":
		case "session.updated":
			return null;
		case "turn.started":
			return {
				type: "start",
				...(payload.messageId == null ? {} : { messageId: payload.messageId }),
			};
		case "turn.step_started":
			return { type: "start-step" };
		case "turn.step_completed":
			return {
				type: "finish-step",
				...(payload.finishReason == null ? {} : { finishReason: payload.finishReason }),
			};
		case "llm.text_start":
			return { type: "text-start", id: payload.textPartId };
		case "llm.text":
			return {
				type: "text-delta",
				...(payload.textPartId == null ? {} : { id: payload.textPartId }),
				delta: payload.delta,
			};
		case "llm.text_end":
			return { type: "text-end", id: payload.textPartId };
		case "llm.reasoning_start":
			return { type: "reasoning-start", id: payload.reasoningPartId };
		case "llm.reasoning":
			return {
				type: "reasoning-delta",
				...(payload.reasoningPartId == null ? {} : { id: payload.reasoningPartId }),
				delta: payload.delta,
			};
		case "llm.reasoning_end":
			return { type: "reasoning-end", id: payload.reasoningPartId };
		case "tool.call":
			return {
				type: "tool-call",
				toolCallId: payload.toolCallId,
				toolName: payload.toolName,
				...(payload.input === undefined ? {} : { input: payload.input }),
			};
		case "tool.result":
			return {
				type: payload.isError === true ? "tool-error" : "tool-result",
				toolCallId: payload.toolCallId,
				toolName: payload.toolName,
				...(payload.isError === true
					? { error: extractErrorMessage(payload.output) }
					: { output: payload.output }),
			};
		case "assistant.message":
			// Out-of-band: the assembled text is already streamed via
			// text-delta. assistant.message is for non-SSE consumers
			// (TUI / API) that want the final text without reassembling.
			return null;
		case "turn.completed":
			return {
				type: "finish",
				...(payload.finishReason == null ? {} : { finishReason: payload.finishReason }),
			};
		case "session.completed":
			// `useChat` reads `[DONE]` as the SSE terminator; the route
			// handler appends that separately. This branch returns null so
			// the caller's stream-close logic owns the terminator format.
			return null;
		case "session.failed":
			// The route handler MUST also write `SSE_DONE_FRAME` after
			// flushing this error chunk — `useChat` expects the
			// `data: [DONE]\n\n` terminator to close the stream cleanly
			// even on the failure path. Without it the client hangs
			// waiting for more chunks until its socket times out.
			return { type: "error", error: payload.error };
	}
}

function extractErrorMessage(output: unknown): string {
	if (output == null) return "tool error";
	if (typeof output === "string") return output;
	if (typeof output === "object") {
		const obj = output as { error?: unknown; message?: unknown };
		if (typeof obj.error === "string") return obj.error;
		if (typeof obj.message === "string") return obj.message;
		try {
			return JSON.stringify(output);
		} catch {
			return "tool error";
		}
	}
	return String(output);
}

/**
 * SSE terminator frame. `useChat` looks for `data: [DONE]\n\n` to
 * close the stream cleanly. The chat route writes this when the
 * AgentService subscription drains to a `session.completed` /
 * `session.failed` event.
 */
export const SSE_DONE_FRAME = "data: [DONE]\n\n";
