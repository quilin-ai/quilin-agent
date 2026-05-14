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

const QuestionAnswerSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("single"), selectedId: z.string().min(1).max(120) }),
	z.object({
		mode: z.literal("multi"),
		selectedIds: z.array(z.string().min(1).max(120)).min(1).max(16),
	}),
	z.object({ mode: z.literal("free_text"), text: z.string().min(1).max(4000) }),
	z.object({ mode: z.literal("timeout") }),
]);

const ReplyBodySchema = z.object({
	sessionId: z.string().min(1).max(200),
	epoch: z.string().min(1).max(200).optional(),
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
	const { sessionId, epoch, reply } = parsed.data;

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
	const delivered = resolveAsk(sessionId, askId, reply as AgentReplyPayload);
	if (!delivered) {
		// Two reasons:
		//  - ask expired (5-min timeout already fired) — agent runtime
		//    resolved with synthetic timeout reply
		//  - ask was never registered (browser racing — shouldn't happen
		//    unless someone replays a stale request)
		return NextResponse.json({ error: "ask expired" }, { status: 410 });
	}
	return NextResponse.json({ delivered: true });
}
