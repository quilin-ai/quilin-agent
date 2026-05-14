/**
 * PersistedPart → AI SDK v6 UIMessage.parts 翻译器 / translator.
 *
 * Slice 1 recorder 把 assistant 消息存成内部稳定的 PersistedPart 形状
 * ({ kind: "text" | "reasoning" | "tool" })。Slice 2 read endpoint(GET
 * `/api/sessions/[id]`)把它转回 AI SDK v6 `UIMessage.parts` 形状,这样
 * `useChat({ messages: ... })` rehydrate 时不需要 per-part 转换。
 *
 * Slice 1 stores assistant messages as the internal stable PersistedPart
 * shape ({ kind }). Slice 2's read endpoint translates them back to AI
 * SDK v6 `UIMessage.parts` shape so `useChat` can rehydrate without
 * per-part transformation.
 *
 * User messages are stored as the raw `UIMessage.parts` (already in the
 * right shape from `body.messages[last].parts`), so this translator only
 * runs over assistant rows.
 *
 * User 消息存的就是原 `UIMessage.parts`(直接来自 `body.messages[last].parts`),
 * 不需要翻译。本翻译器只对 assistant 行跑。
 */

import type { PersistedPart } from "./recorder.js";

/**
 * AI SDK v6 part shape returned to the client. Stable subset of the SDK's
 * UIMessage part union — we explicitly model only the kinds we persist.
 *
 * 返给客户端的 wire 形状,只包含我们真持久化的 part kind。
 */
export type UIPart =
	| { readonly type: "text"; readonly text: string; readonly state?: "streaming" | "done" }
	| { readonly type: "reasoning"; readonly text: string; readonly state?: "streaming" | "done" }
	| {
			readonly type: "dynamic-tool";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly state: "input-available" | "output-available" | "output-error";
			readonly input?: unknown;
			readonly output?: unknown;
			readonly errorText?: string;
	  };

/**
 * Translate a single PersistedPart into a UIMessage part. Tool parts
 * use AI SDK v6's `dynamic-tool` shape (consumed by `transcript-blocks.ts`'s
 * `isToolPart`, which treats `type === "dynamic-tool"` as a tool kind).
 */
function persistedPartToUIPart(part: PersistedPart): UIPart {
	switch (part.kind) {
		case "text":
			return { type: "text", text: part.text, state: part.state };
		case "reasoning":
			return { type: "reasoning", text: part.text, state: part.state };
		case "tool":
			if (part.state === "output-error") {
				return {
					type: "dynamic-tool",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					state: "output-error",
					...(part.input === undefined ? {} : { input: part.input }),
					errorText: part.errorText ?? "tool error",
				};
			}
			return {
				type: "dynamic-tool",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				state: part.state,
				...(part.input === undefined ? {} : { input: part.input }),
				...(part.output === undefined ? {} : { output: part.output }),
			};
	}
}

/**
 * Detect whether `parts` already looks like AI SDK v6 `UIMessage.parts`
 * (each entry has a `type` field) vs persisted form (each entry has a
 * `kind` field). User messages persist as the raw `UIMessage.parts` shape,
 * assistant messages persist as `PersistedPart`. The read endpoint runs
 * this discriminator per-row to decide whether to translate.
 *
 * 判别 parts 数组是原 UIMessage.parts(每项有 `type`)还是 PersistedPart
 * (每项有 `kind`)。User 行 store 原 parts → 不译,assistant 行 store
 * PersistedPart → 译。
 */
function isPersistedPartArray(parts: readonly unknown[]): parts is readonly PersistedPart[] {
	for (const p of parts) {
		if (typeof p !== "object" || p == null) continue;
		const obj = p as { readonly kind?: unknown };
		if (obj.kind === "text" || obj.kind === "reasoning" || obj.kind === "tool") return true;
		const ui = p as { readonly type?: unknown };
		if (typeof ui.type === "string") return false;
	}
	return false;
}

/**
 * Translate a persisted parts array. If the array is already in UIMessage
 * wire shape (user rows), return as-is. If it's PersistedPart shape
 * (assistant rows), translate each entry. Non-translatable entries get
 * filtered out (defensive — should not happen in well-formed data).
 *
 * 翻译已持久化的 parts 数组。user 行已是 UIMessage wire 形状直接返回;
 * assistant 行的 PersistedPart 逐项翻译。
 */
export function persistedPartsToUIParts(parts: readonly unknown[]): readonly UIPart[] {
	if (!isPersistedPartArray(parts)) {
		// Raw UIMessage.parts shape — pass through, narrowing only known types.
		const out: UIPart[] = [];
		for (const p of parts) {
			if (typeof p !== "object" || p == null) continue;
			const obj = p as { readonly type?: unknown };
			if (obj.type === "text" && typeof (p as { text?: unknown }).text === "string") {
				out.push({ type: "text", text: (p as { text: string }).text });
			} else if (obj.type === "reasoning" && typeof (p as { text?: unknown }).text === "string") {
				out.push({ type: "reasoning", text: (p as { text: string }).text });
			}
			// Other UIMessage part types (file / attachment / etc.) not yet
			// persisted; skip until we extend PersistedPart.
		}
		return out;
	}
	const out: UIPart[] = [];
	for (const p of parts) {
		if (typeof p !== "object" || p == null) continue;
		const pp = p as PersistedPart;
		if (pp.kind === "text" || pp.kind === "reasoning" || pp.kind === "tool") {
			out.push(persistedPartToUIPart(pp));
		}
	}
	return out;
}
