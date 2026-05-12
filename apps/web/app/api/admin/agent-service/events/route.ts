/**
 * GET /api/admin/agent-service/events?session=<id>[&afterSeq=N][&epoch=<uuid>]
 *
 * Admin-only SSE stream of `AgentEvent` envelopes for a specific
 * session. Designed for cross-frontend consumers (TUI sanity probe,
 * agent-mesh listener, debugging curl). Unlike the user-facing
 * `/api/chat` SSE which translates events into AI SDK v6 wire chunks,
 * this endpoint serves the raw envelope so consumers can reconstruct
 * state with full fidelity (epoch, seq, ts, payload type tag).
 *
 * Wire format per event:
 *   data: {"seq":N,"sessionId":"...","ts":"...","payload":{...},"epoch":"..."}
 *
 * Terminates on `session.completed` / `session.failed` payloads with a
 * `data: [DONE]\n\n` frame, mirroring the chat route.
 *
 * Query params:
 *   session=<id>         — required; the AgentService session id
 *   afterSeq=<n>         — optional; replay only events with seq > n
 *   epoch=<uuid>         — optional; if provided and doesn't match the
 *                          server's current epoch, the subscription is
 *                          rejected with 409 (stale cursor protection)
 *
 * Phase 5 of Task #22. Gated by `QUILIN_ADMIN_PROBE === "1"`.
 *
 * 跨前端可观察的 AgentEvent SSE 原始流。QUILIN_ADMIN_PROBE=1 开关。
 */

import { getAgentService } from "@/lib/agent-service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function adminProbeEnabled(): boolean {
	return process.env.QUILIN_ADMIN_PROBE === "1";
}

export async function GET(req: Request): Promise<Response> {
	if (!adminProbeEnabled()) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "probe_disabled",
					message: "Admin probe is disabled. Set QUILIN_ADMIN_PROBE=1 to enable for local dev.",
				},
			},
			{ status: 403, headers: { "cache-control": "no-store" } },
		);
	}

	const url = new URL(req.url);
	const sessionId = url.searchParams.get("session");
	if (sessionId == null || sessionId.length === 0) {
		return Response.json(
			{ ok: false, error: { code: "missing_session", message: "session query param required" } },
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}
	const afterSeqRaw = url.searchParams.get("afterSeq");
	const afterSeqNum = afterSeqRaw == null ? 0 : Number(afterSeqRaw);
	if (!Number.isFinite(afterSeqNum) || afterSeqNum < 0 || !Number.isInteger(afterSeqNum)) {
		return Response.json(
			{
				ok: false,
				error: { code: "bad_afterSeq", message: "afterSeq must be a non-negative integer" },
			},
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}
	const expectedEpoch = url.searchParams.get("epoch");

	const service = await getAgentService();
	const serverEpoch = service.currentEpoch();

	// Pre-flight epoch check so callers get a clean 409 instead of an
	// immediately-closed SSE stream they then have to parse for
	// `info.epochMismatch`. Browser-style consumers and curl alike
	// can branch on the status code.
	if (expectedEpoch != null && expectedEpoch.length > 0 && expectedEpoch !== serverEpoch) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "epoch_mismatch",
					message:
						"Cursor epoch does not match server epoch. agent-core restarted; restart from a fresh session.",
				},
				data: { serverEpoch },
			},
			{ status: 409, headers: { "cache-control": "no-store" } },
		);
	}

	if (service.getSession(sessionId) == null) {
		return Response.json(
			{
				ok: false,
				error: {
					code: "session_not_found",
					message: `No AgentService session for id: ${sessionId}`,
				},
				data: { serverEpoch },
			},
			{ status: 404, headers: { "cache-control": "no-store" } },
		);
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const sub = service.subscribe({
				sessionId,
				afterSeq: afterSeqNum,
				expectedEpoch: serverEpoch,
			});
			try {
				for await (const event of sub) {
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
					} catch {
						sub.close();
						break;
					}
					if (
						event.payload.type === "session.completed" ||
						event.payload.type === "session.failed"
					) {
						try {
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						} catch {
							/* already closed */
						}
						sub.close();
						break;
					}
				}
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			} catch (e) {
				// Defensive close on the rare outer-catch path (e.g.,
				// EventBus internal throw inside `for await` after the
				// inner try). Subscriber.next() is sync-resolve-only in
				// the current implementation so this path isn't normally
				// reachable, but closing here avoids leaking a
				// reference in the EventBus subscriber set if it ever
				// becomes reachable.
				try {
					sub.close();
				} catch {
					/* already closed */
				}
				try {
					controller.error(e);
				} catch {
					/* already closed */
				}
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-quilin-epoch": serverEpoch,
		},
	});
}
