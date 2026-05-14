/**
 * 助手消息持久化录制器 / Assistant message persistence recorder.
 *
 * Subscribes to AgentService events for one assistant turn and snapshots
 * the in-flight `parts` array into the `messages` row at debounced
 * intervals + finalizes on terminal events. Runs in parallel with the
 * pump that emits AgentEvents into AgentService — both consume from the
 * same event bus independently.
 *
 * 订阅 AgentService 事件流(单个 assistant turn),把中流 parts 数组按
 * debounce 周期(500ms)snapshot 进 messages 行,终态事件触发 finalize。
 * 与 pump 并行跑,彼此独立。
 *
 * 持久化的 part 形状内部稳定但不直接等同于 AI SDK v6 UIMessage.parts —
 * Slice 2 的 read endpoint 会把它转回 UIMessage.parts。Slice 1 范围内只
 * 要 JSON 可往返就够支持 T2 验收(finalized_at + parts_json 非空)。
 *
 * Persisted part shape is internally stable but not byte-identical to
 * AI SDK v6's wire `UIMessage.parts`. Slice 2's read endpoint translates
 * the persisted form back into `UIMessage.parts`. For Slice 1, the only
 * acceptance check on parts_json is that it round-trips and is non-empty
 * after `turn.completed`.
 */

import type { AgentEvent, AgentServiceLike } from "../agent-service-client.js";
import { isPersistenceEnabled, updateAssistantParts } from "./index";

/**
 * Internal part shape stored in `messages.parts_json`. Stable wire for
 * the persistence layer; Slice 2 read endpoint maps to AI SDK v6 part
 * types before sending to the browser.
 *
 * 内部 part 形状(persistence 层稳定);Slice 2 读路径再映射到 AI SDK v6
 * wire part type。
 */
export type PersistedPart =
	| {
			readonly kind: "text";
			readonly partId: string;
			text: string;
			state: "streaming" | "done";
	  }
	| {
			readonly kind: "reasoning";
			readonly partId: string;
			text: string;
			state: "streaming" | "done";
	  }
	| {
			readonly kind: "tool";
			readonly toolCallId: string;
			readonly toolName: string;
			state: "input-available" | "output-available" | "output-error";
			input?: unknown;
			output?: unknown;
			errorText?: string;
	  };

/**
 * Debounce window for mid-stream snapshots. 500ms matches the spec §4.2
 * recommendation ("every ~500ms or on step-finish boundaries").
 *
 * Mid-stream 快照窗口,跟 spec §4.2 一致。
 */
const SNAPSHOT_DEBOUNCE_MS = 500;

/**
 * Subscribe to one assistant turn's events and persist the parts array.
 * Resolves after the matching terminal event (`turn.completed` /
 * `session.completed` / `session.failed`) lands and the final snapshot
 * is committed.
 *
 * **Single-turn scope (Slice 1).** The fresh-start path in
 * `app/api/chat/route.ts` invokes this once per HTTP POST, with
 * `turnIndex: 1`. Multi-turn within one session — second user message
 * landing on the same assistant runner — is out of scope here; Slice 3
 * (restart recovery) and Slice 4 (multi-tab concurrency) will revisit.
 * Treating `turn.completed` as terminal is correct for single-turn but
 * would prematurely close the subscription if we ever stream multiple
 * turns through one recorder.
 *
 * Caller already inserted a placeholder row at `messages(id=messageId,
 * session_id=sessionId, role='assistant', parts_json='[]')` — this
 * function only ever UPDATEs.
 *
 * 订阅一个 assistant turn 的事件流并持久化 parts。**仅支持单 turn**(Slice 1
 * 范围)。Slice 3 / Slice 4 才扩到多 turn。前置:caller 已经插入占位行
 * (role='assistant', parts_json='[]'),本函数只 UPDATE。
 */
export async function recordAssistantMessage(opts: {
	readonly service: AgentServiceLike;
	readonly sessionId: string;
	readonly messageId: string;
	readonly turnIndex: number;
	readonly afterSeq: number;
	readonly expectedEpoch?: string;
}): Promise<void> {
	if (!isPersistenceEnabled()) return;
	const sub = opts.service.subscribe({
		sessionId: opts.sessionId,
		afterSeq: opts.afterSeq,
		...(opts.expectedEpoch == null ? {} : { expectedEpoch: opts.expectedEpoch }),
	});
	if (sub.info.epochMismatch) {
		sub.close();
		return;
	}

	const parts: PersistedPart[] = [];
	// `parts` plus its index for the in-flight text / reasoning parts so
	// deltas can update the matching entry without an O(n) scan per
	// chunk. Tool parts get found via toolCallId.
	const activeTextByPartId = new Map<string, number>();
	const activeReasoningByPartId = new Map<string, number>();
	const toolIndexByCallId = new Map<string, number>();

	let dirty = false;
	// `lastWriteAt = 0` makes the first dirty event flush immediately
	// (elapsed = now − 0 is always ≥ SNAPSHOT_DEBOUNCE_MS). Intentional:
	// the user perceives the first persisted snapshot earlier, and the
	// stream of subsequent deltas still gets debounced via the timer
	// branch below.
	//
	// `lastWriteAt = 0` 让首个 dirty 事件立刻 flush(elapsed ≥ debounce 必然
	// 成立);后续 delta 走 timer 分支被合并。意图是让首屏快照尽早写盘。
	let lastWriteAt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = (finalized: boolean): void => {
		if (timer != null) {
			clearTimeout(timer);
			timer = null;
		}
		if (!dirty && !finalized) return;
		updateAssistantParts({
			id: opts.messageId,
			sessionId: opts.sessionId,
			parts,
			finalized,
		});
		dirty = false;
		lastWriteAt = Date.now();
	};

	const scheduleFlush = (): void => {
		dirty = true;
		const elapsed = Date.now() - lastWriteAt;
		if (elapsed >= SNAPSHOT_DEBOUNCE_MS) {
			flush(false);
			return;
		}
		if (timer != null) return;
		timer = setTimeout(() => {
			timer = null;
			flush(false);
		}, SNAPSHOT_DEBOUNCE_MS - elapsed);
	};

	try {
		for await (const event of sub) {
			if (event.payload.type === "session.created") continue;
			if (event.payload.type === "session.updated") continue;
			const finalized = handleEvent(event, parts, {
				activeTextByPartId,
				activeReasoningByPartId,
				toolIndexByCallId,
			});
			if (finalized === "terminal") {
				flush(true);
				sub.close();
				return;
			}
			scheduleFlush();
		}
		// Subscription drained without an explicit terminal event (e.g.,
		// session evicted out from under us). Persist whatever we have
		// and mark finalized so the row isn't left in a "pending"
		// state forever.
		flush(true);
	} catch (e) {
		// Subscription errors shouldn't propagate — persistence is best-
		// effort. Final snapshot still attempts to write whatever parts
		// have accumulated so the user doesn't lose mid-stream content.
		console.log(`[recorder ${opts.sessionId}] subscription error: ${String(e)}`);
		try {
			flush(true);
		} catch {
			/* DB closed or similar — give up */
		}
	} finally {
		sub.close();
	}
}

interface PartIndexes {
	readonly activeTextByPartId: Map<string, number>;
	readonly activeReasoningByPartId: Map<string, number>;
	readonly toolIndexByCallId: Map<string, number>;
}

/**
 * Apply one event to the parts array in place. Returns `"terminal"` if
 * the event indicates the assistant turn has completed (caller should
 * flush + finalize), `"continue"` otherwise.
 *
 * 把一个事件应用到 parts 数组(in-place 修改);`terminal` 表示 turn 结束,
 * caller flush+finalize;`continue` 表示继续订阅。
 */
function handleEvent(
	event: AgentEvent,
	parts: PersistedPart[],
	idx: PartIndexes,
): "continue" | "terminal" {
	const p = event.payload;
	switch (p.type) {
		case "llm.text_start": {
			const part: PersistedPart = {
				kind: "text",
				partId: p.textPartId,
				text: "",
				state: "streaming",
			};
			parts.push(part);
			idx.activeTextByPartId.set(p.textPartId, parts.length - 1);
			return "continue";
		}
		case "llm.text": {
			const partIdx =
				p.textPartId != null ? idx.activeTextByPartId.get(p.textPartId) : findLastTextIndex(parts);
			if (partIdx == null) return "continue";
			const existing = parts[partIdx];
			if (existing == null || existing.kind !== "text") return "continue";
			existing.text += p.delta;
			return "continue";
		}
		case "llm.text_end": {
			const partIdx = idx.activeTextByPartId.get(p.textPartId);
			if (partIdx != null) {
				const existing = parts[partIdx];
				if (existing != null && existing.kind === "text") existing.state = "done";
				idx.activeTextByPartId.delete(p.textPartId);
			}
			return "continue";
		}
		case "llm.reasoning_start": {
			const part: PersistedPart = {
				kind: "reasoning",
				partId: p.reasoningPartId,
				text: "",
				state: "streaming",
			};
			parts.push(part);
			idx.activeReasoningByPartId.set(p.reasoningPartId, parts.length - 1);
			return "continue";
		}
		case "llm.reasoning": {
			const partIdx =
				p.reasoningPartId != null
					? idx.activeReasoningByPartId.get(p.reasoningPartId)
					: findLastReasoningIndex(parts);
			if (partIdx == null) return "continue";
			const existing = parts[partIdx];
			if (existing == null || existing.kind !== "reasoning") return "continue";
			existing.text += p.delta;
			return "continue";
		}
		case "llm.reasoning_end": {
			const partIdx = idx.activeReasoningByPartId.get(p.reasoningPartId);
			if (partIdx != null) {
				const existing = parts[partIdx];
				if (existing != null && existing.kind === "reasoning") existing.state = "done";
				idx.activeReasoningByPartId.delete(p.reasoningPartId);
			}
			return "continue";
		}
		case "tool.call": {
			const part: PersistedPart = {
				kind: "tool",
				toolCallId: p.toolCallId,
				toolName: p.toolName,
				state: "input-available",
				...(p.input === undefined ? {} : { input: p.input }),
			};
			parts.push(part);
			idx.toolIndexByCallId.set(p.toolCallId, parts.length - 1);
			return "continue";
		}
		case "tool.result": {
			const partIdx = idx.toolIndexByCallId.get(p.toolCallId);
			if (partIdx == null) return "continue";
			const existing = parts[partIdx];
			if (existing == null || existing.kind !== "tool") return "continue";
			if (p.isError === true) {
				existing.state = "output-error";
				existing.errorText = extractErrorText(p.output);
			} else {
				existing.state = "output-available";
				existing.output = p.output;
			}
			return "continue";
		}
		case "turn.completed":
		case "session.completed":
		case "session.failed":
			return "terminal";
		default:
			return "continue";
	}
}

function findLastTextIndex(parts: readonly PersistedPart[]): number | undefined {
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		const part = parts[i];
		if (part?.kind === "text" && part.state === "streaming") return i;
	}
	return undefined;
}

function findLastReasoningIndex(parts: readonly PersistedPart[]): number | undefined {
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		const part = parts[i];
		if (part?.kind === "reasoning" && part.state === "streaming") return i;
	}
	return undefined;
}

function extractErrorText(output: unknown): string {
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
