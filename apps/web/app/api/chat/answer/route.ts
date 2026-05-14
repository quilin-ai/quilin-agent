/**
 * POST /api/chat/answer — Iter F 交互 primitives wire skeleton.
 *
 * 收用户对 `ask_user_question` / `request_approval` 的回复,按
 * `(sessionId, askId)` 命中 pending-ask 注册表 + resolve 对应 Promise,
 * agent runtime 继续。
 *
 * Wire shape (per spec §3.3):
 * ```
 * POST /api/chat/answer
 * {
 *   sessionId: string,
 *   epoch?: string,        // optional — round-trips for strict-epoch handshake
 *   reply: AgentReplyPayload
 * }
 * → 200 { delivered: true }
 * → 410 { error: "ask expired" }     if no pending ask matches
 * → 400 { error: "invalid body" }     malformed
 * → 409 { error: "epoch mismatch" }   if epoch param doesn't match server
 * ```
 *
 * Iter F Slice 1 (wire skeleton):本 endpoint 落地 + 注册表 + 测试。
 * agent runtime 调用 `registerAsk` 的环节(`ask_user_question` 工具 + 改造
 * 后的 `WriteAuthority.confirm`)是 Slice 2 工作 — 直到那时,这个 endpoint
 * 始终返回 410(从来没有 pending ask 匹配)。这是预期行为,UI 端依旧可以
 * 按完整 wire 协议开发 InlineQuestion / InlineApproval。
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import type { AgentReplyPayload } from "@/lib/agent-service-client";
import { getAgentService } from "@/lib/agent-service-client";
import { resolveAsk } from "@/lib/pending-asks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `timeout` mode is intentionally absent here — it's a SERVER-side
// synthetic reply produced by the `pending-asks` setTimeout callback,
// never something a client can submit. Allowing clients to post
// `mode=timeout` would let a token-holding browser force the LLM to
// believe the user never answered, opening a self-DoS / signal-
// manipulation vector against the agent's own session.
const QuestionAnswerSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("single"), selectedId: z.string().min(1).max(120) }),
	z.object({
		mode: z.literal("multi"),
		selectedIds: z.array(z.string().min(1).max(120)).min(1).max(16),
	}),
	z.object({ mode: z.literal("free_text"), text: z.string().min(1).max(4000) }),
]);

const ReplyBodySchema = z.object({
	sessionId: z.string().min(1).max(200),
	epoch: z.string().min(1).max(200).optional(),
	/** Per-ask capability token. The agent emits this alongside the
	 *  ask event on the SSE stream; the client must echo it back here
	 *  to authorize the answer. 128-bit unguessable random token from
	 *  pending-asks.registerAsk (task #15). */
	askToken: z.string().regex(/^[a-f0-9]{32}$/),
	reply: z.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("user_answered_question"),
			askId: z.string().min(1).max(120),
			answer: QuestionAnswerSchema,
		}),
		z.object({
			kind: z.literal("user_decision"),
			askId: z.string().min(1).max(120),
			decision: z.enum(["allow", "deny", "allow_always_low", "allow_always_medium"]),
			reason: z.string().max(400).optional(),
		}),
	]),
});

export async function POST(req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "invalid json" }, { status: 400 });
	}
	const parsed = ReplyBodySchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const { sessionId, epoch, askToken, reply } = parsed.data;

	// Strict-epoch handshake (optional — caller may skip on first call).
	if (epoch != null) {
		try {
			const service = await getAgentService();
			const serverEpoch = service.currentEpoch();
			if (epoch !== serverEpoch) {
				return NextResponse.json({ error: "epoch mismatch", serverEpoch }, { status: 409 });
			}
		} catch {
			// AgentService not initialized → treat as no-mismatch and let
			// the askId lookup decide (likely 410).
		}
	}

	const askId = reply.askId;
	const delivered = resolveAsk(sessionId, askId, askToken, reply as AgentReplyPayload);
	if (!delivered) {
		// Three reasons (intentionally collapsed to one error code so
		// the server doesn't disclose which dimension failed — a token
		// mismatch is less informative to an attacker than a 401):
		//  - ask expired (5-min timeout already fired)
		//  - ask was never registered (browser racing / stale replay)
		//  - askToken mismatch (forgery attempt or stale token)
		return NextResponse.json({ error: "ask expired" }, { status: 410 });
	}
	return NextResponse.json({ delivered: true });
}
