/**
 * `request_approval` tool — Iter F 交互 primitives Slice 3b (path A).
 *
 * Companion to `ask_user_question`. Where ask collects an *answer*,
 * approval collects a *decision* (allow / deny / allow_always_low /
 * allow_always_medium). Wire flow is the same: tool emits a
 * `request_approval` event, awaits a `user_decision` reply via
 * `pending-asks`, then formats the decision into a string the LLM can
 * read to choose its next action.
 *
 * Architecture choice (path A): this is a parallel tool the LLM calls
 * BEFORE running a risky operation. It does not enforce anything — the
 * LLM must respect the returned decision. A future iter will wrap risky
 * tools server-side via `WriteAuthority` so this becomes structural
 * rather than advisory. See `interaction-primitives-slice-3-plan.md` §3b.
 *
 * 与 `ask_user_question` 配对。前者收答案,本工具收决定(allow / deny /
 * allow_always_low / allow_always_medium)。LLM 在跑敏感操作前主动调本工具
 * 拿到 user_decision,然后基于结果决定下一步。路径 A 是顾问式 — 不强制;
 * 路径 B(下个 Iter)会给敏感工具自动套 WriteAuthority,LLM 想跳也跳不掉。
 */

import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import type { AgentReplyPayload, AgentServiceLike } from "@/lib/agent-service-client";
import { registerAsk } from "@/lib/pending-asks";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TOOL_NAME_CHARS = 120;
const MAX_SUMMARY_CHARS = 1000;
const MAX_DETAIL_CHARS = 4000;

const approvalInputSchema = z.object({
	tool: z
		.string()
		.min(1)
		.max(MAX_TOOL_NAME_CHARS)
		.regex(/^[a-zA-Z0-9_-]+$/, "tool name must be alphanumeric / underscore / dash only"),
	riskLevel: z.enum(["low", "medium", "high", "critical"]),
	summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
	detail: z.string().max(MAX_DETAIL_CHARS).optional(),
	origin: z.enum(["user", "agent", "idle"]).default("agent"),
	timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
});

export type RequestApprovalInput = z.infer<typeof approvalInputSchema>;

export interface MakeRequestApprovalToolDeps {
	readonly sessionId: string;
	readonly service: AgentServiceLike;
	/** Override for tests; production uses {@link registerAsk}. */
	readonly awaitAsk?: typeof registerAsk;
	/** Override for tests; production uses crypto.randomUUID. */
	readonly generateAskId?: () => string;
}

export function makeRequestApprovalTool(deps: MakeRequestApprovalToolDeps) {
	const awaitAsk = deps.awaitAsk ?? registerAsk;
	const generateAskId = deps.generateAskId ?? randomUUID;
	return tool({
		description:
			"在执行敏感 / 不可逆 / 跨进程影响的操作前,先向用户请求一次性批准。" +
			"传入 tool(将要执行的工具或动作名)、riskLevel(low/medium/high/critical)、" +
			"summary(一句话讲清楚要做什么)、可选 detail(具体参数 / 影响范围)。" +
			"返回用户决定:allow(只批准这一次)、deny(拒绝)、allow_always_low / " +
			"allow_always_medium(批准 + 用户希望本 session 内同级别后续操作自动放行;" +
			"⚠️ 注意:目前是路径 A,服务端不强制执行白名单,你需要自己记住并遵守)。" +
			"5 分钟内未决定按 deny 处理。" +
			"使用场景:rm -rf、写入受保护文件、git push、调用付费 API、向外部发消息等。" +
			"普通 read 操作不要走本工具——只有真的可能伤到用户工作或预算的动作才用。",
		inputSchema: approvalInputSchema,
		execute: async (rawInput: unknown) => {
			// Defensive re-validation so the tool fails fast and predictably
			// even when called outside an AI-SDK runtime (test or direct
			// invocation). When called via AI SDK, the schema also runs
			// upstream; both paths produce the same error shape.
			const input = approvalInputSchema.parse(rawInput);
			const askId = generateAskId();
			const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			deps.service.emitFromRunner(deps.sessionId, {
				type: "request_approval",
				askId,
				tool: input.tool,
				riskLevel: input.riskLevel,
				summary: input.summary,
				detail: input.detail,
				origin: input.origin,
			});

			const reply: AgentReplyPayload = await awaitAsk({
				sessionId: deps.sessionId,
				askId,
				kind: "user_decision",
				timeoutMs,
			});

			return formatDecisionForLlm(reply, input);
		},
	});
}

/**
 * Format the user's decision into a compact, deterministic string the
 * LLM can read. Stable across decision modes so prompt engineering
 * around tool-result interpretation is reliable.
 *
 * @internal exported for tests
 */
export function formatDecisionForLlm(
	reply: AgentReplyPayload,
	input: RequestApprovalInput,
): string {
	if (reply.kind !== "user_decision") {
		return `user_decision status=unexpected kind=${reply.kind}`;
	}
	switch (reply.decision) {
		case "allow":
			return `user_decision decision=allow tool=${input.tool} risk=${input.riskLevel} note=一次性批准,执行后回报结果`;
		case "deny": {
			const reasonNote =
				reply.reason != null && reply.reason.length > 0
					? ` reason=${JSON.stringify(reply.reason)}`
					: "";
			return (
				`user_decision decision=deny tool=${input.tool} risk=${input.riskLevel}${reasonNote} ` +
				`note=不要执行该工具,告知用户已被拒绝并询问下一步`
			);
		}
		case "allow_always_low":
			return (
				`user_decision decision=allow_always_low tool=${input.tool} risk=${input.riskLevel} ` +
				`note=用户将本 session 内 low risk 全部加入白名单,后续 low risk 操作不需要再调 request_approval`
			);
		case "allow_always_medium":
			return (
				`user_decision decision=allow_always_medium tool=${input.tool} risk=${input.riskLevel} ` +
				`note=用户将本 session 内 low + medium risk 全部加入白名单,后续可直接执行`
			);
		default: {
			// Exhaustiveness — adding a new decision variant must fail compile,
			// not silently return undefined and corrupt the LLM context.
			const _unreachable: never = reply.decision;
			return `user_decision decision=unknown raw=${JSON.stringify(_unreachable)}`;
		}
	}
}
