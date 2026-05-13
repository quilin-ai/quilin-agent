/**
 * Shared rendering helpers for both the inline live-render path in
 * `repl.ts` (which renders `LLMStreamEvent`s as they fire from
 * `StreamingLLMClient`) and the subscription-driven replay path in
 * `agent-service-bridge.ts` (which renders `AgentEvent`s pulled from
 * the in-process AgentService).
 *
 * Extracted here in Candidate 1 Slice D so the two render paths share
 * a single source of truth for the render state shape, the trailing-
 * newline finalize semantics, and the inline-summary truncation rules.
 * Drift between live render and replay render would manifest as
 * subtle visual mismatches (different ellipsis length, different
 * thinking dot, different `\n` placement), which is exactly the class
 * of regression Slice D's "TUI 视觉外观与 Slice C 之前一致(回归)"
 * DoD aims to prevent.
 *
 * Slice D 抽出的渲染共享模块。live render(repl.ts 内联)与 replay render
 * (agent-service-bridge.ts subscription)共用同一份 state 形状 + finalize
 * 语义 + 截断规则,避免两条路径视觉漂移。
 */

/** Reasoning rendering mode. / 推理可视化模式。 */
export type ReasoningDisplayMode = "verbose" | "collapsed";

/**
 * Mutable bookkeeping for a render session. The live path mutates one
 * instance through a turn; the replay path mutates a freshly-created
 * instance during a /sessions <id> dump so its state does not
 * contaminate the live instance. Both paths reset their instance on
 * turn / replay boundaries.
 *
 * 渲染状态。live 路径每 turn 一份,replay 路径每次 /sessions <id> 新建一份,
 * 互不污染。
 */
export interface ReplStreamRenderState {
	thinkingShown: boolean;
	toolInputs: Map<string, string>;
	lastTextEndedWithNewline: boolean;
	hasEmittedText: boolean;
}

/** Factory for a fresh render state. / 新建空白渲染状态。 */
export function createStreamRenderState(): ReplStreamRenderState {
	return {
		thinkingShown: false,
		toolInputs: new Map(),
		lastTextEndedWithNewline: false,
		hasEmittedText: false,
	};
}

/**
 * JSON-stringify a value with two fallbacks:
 *   1. `undefined` return (functions, symbols, raw `undefined`) →
 *      `String(value)`.
 *   2. `JSON.stringify` throwing on a circular structure → a stable
 *      `"[Circular]"` placeholder rather than crashing the caller.
 *
 * The replay path (`renderAgentEvent` / `/sessions <id>`) calls
 * `summarizeToolOutput` synchronously inside a for-loop with no
 * surrounding try/catch; an uncaught cycle would tear the loop down
 * mid-stream and skip the closing replay banner. Tool outputs that
 * cross MCP stdio are JSON-safe by construction, but in-process
 * builtin tools could in principle return cyclic structures (none
 * currently do — defensive fix flagged by Slice D Reviewer B SUSPECT).
 *
 * 安全 JSON.stringify:undefined 回退到 String,循环结构回退到
 * `"[Circular]"` 占位,避免重放循环里的同步抛错带垮整个 replay。
 */
export function stringifyJson(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized ?? String(value);
	} catch {
		return "[Circular]";
	}
}

/** Narrow `unknown` to a plain record. / 把 unknown 收窄成普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

/**
 * Collapse a text into a single inline line and truncate with an
 * ellipsis if it exceeds `maxLength`. Used to render tool-call inputs
 * and tool-result outputs as compact single-line icons.
 *
 * 把文本压成单行,过长加省略号。tool-call/result 的紧凑展示用。
 */
export function summarizeInlineText(text: string, maxLength = 120): string {
	const singleLine = text.replace(/\s+/gu, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}

	return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Pick the most user-meaningful field out of a tool result and return
 * a single-line summary. Falls back to JSON serialization on shapes we
 * don't recognize.
 *
 * 优先从 tool result 里挑 `result`/`content` 字段做摘要,无则 JSON。
 */
export function summarizeToolOutput(output: unknown): string {
	if (isRecord(output)) {
		const result = output.result;
		if (typeof result === "string") {
			return summarizeInlineText(result);
		}

		const content = output.content;
		if (typeof content === "string") {
			return summarizeInlineText(content.split(/\r?\n/u, 1)[0] ?? content);
		}
	}

	const raw =
		typeof output === "string" ? output : stringifyJson(output ?? "undefined");
	return summarizeInlineText(raw.split(/\r?\n/u, 1)[0] ?? raw);
}
