/**
 * `wrapToolWithApproval` — Iter F interaction primitives Path B.
 *
 * Path A (already shipped, commit 74e9f1e) was advisory: the LLM
 * voluntarily called `request_approval` before dangerous operations
 * and respected the user's decision. Path B is structural: the
 * server wraps a risky tool's `execute()` so that an approval gate
 * fires AUTOMATICALLY before the wrapped logic runs, regardless of
 * whether the LLM remembered to ask first.
 *
 * Wrapped flow:
 *
 *   1. LLM calls `wrappedShellExec({ command: 'rm -rf …' })`
 *   2. Wrapper checks the per-session "always allow" whitelist
 *      (built up by past allow_always_low / allow_always_medium
 *      decisions). If `riskLevel` is whitelisted → skip ask.
 *   3. Otherwise: emit `request_approval` event → registerAsk →
 *      await user reply via /api/chat/answer.
 *   4. If `decision === "deny"` (or timeout) → return a structured
 *      tool result describing the denial without invoking the
 *      wrapped execute().
 *   5. If `decision === "allow"` → run wrapped execute() once.
 *   6. If `decision === "allow_always_low"` / `_medium` → update
 *      whitelist for the session and run wrapped execute().
 *
 * Path A vs Path B coexistence:
 *   - The LLM can still call `request_approval` voluntarily — that
 *     path is unchanged.
 *   - Path B fires on top of that for tools the operator wants
 *     hard-enforced (e.g. shell_exec). The LLM doesn't need to know
 *     about the wrapper; it just calls the tool.
 *   - Whitelist state is in-memory + per-session. Session restarts
 *     reset it. Persistent whitelist is its own future iter.
 *
 * 路径 B 服务端强制 approval gate。LLM 调被 wrap 的工具时,wrapper 自动
 * 走 ask 流程,LLM 自律的 request_approval 还在但不再是唯一闸门。
 *
 * Spec: docs/07-safety-guardrails/interaction-primitives-spec.md §4
 */

import { randomUUID } from "node:crypto";
import type { Tool as AiSdkTool } from "ai";
import type { AgentReplyPayload, AgentServiceLike } from "@/lib/agent-service-client";
import { registerAsk } from "@/lib/pending-asks";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Per-session approval whitelist. Keyed by sessionId. Values are
 * the set of risk levels that have been "always-allow"-ed in that
 * session. critical risk is NEVER eligible for always-allow.
 *
 * Lives on globalThis so an HMR rebuild in dev doesn't drop the
 * whitelist mid-session (matches the pattern used by pending-asks
 * and web-session-meta).
 */
interface SessionApprovalWhitelist {
	readonly bySession: Map<string, Set<Exclude<RiskLevel, "high" | "critical">>>;
}

declare global {
	var __quilin_session_approval_whitelist__: SessionApprovalWhitelist | undefined;
}

function getWhitelistStore(): SessionApprovalWhitelist {
	let store = globalThis.__quilin_session_approval_whitelist__;
	if (store == null) {
		store = { bySession: new Map() };
		globalThis.__quilin_session_approval_whitelist__ = store;
	}
	return store;
}

function isWhitelisted(sessionId: string, riskLevel: RiskLevel): boolean {
	if (riskLevel === "high" || riskLevel === "critical") return false;
	const store = getWhitelistStore();
	const bag = store.bySession.get(sessionId);
	return bag?.has(riskLevel) ?? false;
}

function addToWhitelist(sessionId: string, level: "low" | "medium"): void {
	const store = getWhitelistStore();
	let bag = store.bySession.get(sessionId);
	if (bag == null) {
		bag = new Set();
		store.bySession.set(sessionId, bag);
	}
	bag.add(level);
	// `allow_always_medium` implies low is also allowed (transitive trust).
	if (level === "medium") bag.add("low");
}

/** @internal — used by tests. */
export function _resetApprovalWhitelistForTests(): void {
	const store = getWhitelistStore();
	store.bySession.clear();
}

export interface WrapToolWithApprovalOptions {
	readonly sessionId: string;
	readonly service: AgentServiceLike;
	readonly toolName: string;
	readonly riskLevel: RiskLevel;
	/** Default approval timeout in ms; 5min if unset. */
	readonly approvalTimeoutMs?: number;
	/** Override registerAsk for tests. */
	readonly awaitAsk?: typeof registerAsk;
	/** Override askId generator for tests. */
	readonly generateAskId?: () => string;
	/**
	 * Summarize the about-to-run tool call for the approval prompt.
	 * Receives the raw `execute` input args.
	 */
	readonly summarize: (input: unknown) => { readonly summary: string; readonly detail?: string };
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Wrap an AI-SDK tool so its `execute()` is gated by the approval flow.
 * Returns a new tool with the same external shape (name, description,
 * inputSchema) but a wrapped execute. Idempotent — applying the same
 * wrapper twice would double-gate; don't.
 */
export function wrapToolWithApproval(
	innerTool: AiSdkTool,
	options: WrapToolWithApprovalOptions,
): AiSdkTool {
	const inner = innerTool as AiSdkTool & {
		execute?: (args: unknown, ctx: unknown) => unknown;
	};
	const originalExecute = inner.execute;
	if (originalExecute == null) {
		// Tool has no execute (read-only metadata); pass through unchanged.
		return innerTool;
	}
	const generateAskId = options.generateAskId ?? randomUUID;
	const awaitAsk = options.awaitAsk ?? registerAsk;
	const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

	return {
		...innerTool,
		execute: async (args: unknown, ctx: unknown) => {
			// Whitelist short-circuit: if this risk level was always-allowed
			// in the session, skip the user prompt and run directly.
			if (isWhitelisted(options.sessionId, options.riskLevel)) {
				return originalExecute.call(inner, args, ctx);
			}

			const { summary, detail } = options.summarize(args);
			const askId = generateAskId();
			const { askToken, reply: replyPromise } = awaitAsk({
				sessionId: options.sessionId,
				askId,
				kind: "user_decision",
				timeoutMs: approvalTimeoutMs,
			});
			options.service.emitFromRunner(options.sessionId, {
				type: "request_approval",
				askId,
				askToken,
				tool: options.toolName,
				riskLevel: options.riskLevel,
				summary,
				...(detail === undefined ? {} : { detail }),
				origin: "agent",
			});

			let reply: AgentReplyPayload;
			try {
				reply = await replyPromise;
			} catch (e) {
				// Registry rejected (shouldn't happen unless something is
				// truly broken). Treat as deny.
				const msg = e instanceof Error ? e.message : String(e);
				return {
					toolCallId: askId,
					content: `tool_blocked reason=approval_error msg=${JSON.stringify(msg)}`,
					isError: true,
					error: { code: "approval_failed", message: msg },
				};
			}

			if (reply.kind !== "user_decision") {
				return {
					toolCallId: askId,
					content: `tool_blocked reason=unexpected_reply kind=${reply.kind}`,
					isError: true,
					error: { code: "approval_failed", message: "unexpected reply kind" },
				};
			}

			const decision = reply.decision;
			if (decision === "deny") {
				return {
					toolCallId: askId,
					content: `tool_blocked tool=${options.toolName} risk=${options.riskLevel} decision=deny reason=${JSON.stringify(reply.reason ?? "user denied")}`,
					isError: true,
					error: { code: "tool_denied", message: reply.reason ?? "user denied" },
				};
			}
			if (decision === "allow_always_low") {
				addToWhitelist(options.sessionId, "low");
			} else if (decision === "allow_always_medium") {
				addToWhitelist(options.sessionId, "medium");
			}
			// allow | allow_always_* → run.
			return originalExecute.call(inner, args, ctx);
		},
	};
}
