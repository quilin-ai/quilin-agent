/**
 * GET /api/admin/agent-service/sessions
 *
 * Admin-only probe that exposes the AgentService session registry to
 * cross-frontend consumers (TUI, future agent-mesh clients, debugging
 * curl). Returns the same `listSessions()` view the chat route uses
 * internally, plus the process-epoch UUID and aggregate counts.
 *
 * Phase 5 of Task #22 (AgentService migration). The route is gated by
 * `process.env.QUILIN_ADMIN_PROBE === "1"` so production deployments
 * that don't explicitly enable it return 403. There is no auth gate
 * beyond the env flag — this is intentionally a developer/admin tool,
 * not a public surface.
 *
 * Phase 5:admin probe,把 AgentService session 列表暴露给跨前端消费者
 * (TUI / agent-mesh / 调试 curl)。QUILIN_ADMIN_PROBE=1 开关,无 auth,
 * 仅 dev/admin 使用。
 */

import { getAgentService } from "@/lib/agent-service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check the admin-probe gate. Returns `true` when the env flag is set
 * to the literal string `"1"`. Any other value (including unset,
 * `"true"`, `"yes"`, or `"0"`) keeps the probe disabled. Strict matching
 * avoids accidental production exposure from a typo like
 * `QUILIN_ADMIN_PROBE=true` that might be assumed truthy elsewhere.
 *
 * QUILIN_ADMIN_PROBE 必须严格 === "1" 才打开,避免 "true"/"yes" 等
 * 拼写错误意外暴露 prod。
 */
function adminProbeEnabled(): boolean {
	return process.env.QUILIN_ADMIN_PROBE === "1";
}

export async function GET(): Promise<Response> {
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
	try {
		const service = await getAgentService();
		const sessions = service.listSessions();
		const counts: Record<string, number> = {};
		for (const session of sessions) {
			counts[session.status] = (counts[session.status] ?? 0) + 1;
		}
		return Response.json(
			{
				ok: true,
				data: {
					epoch: service.currentEpoch(),
					total: sessions.length,
					counts,
					sessions: sessions.map((s) => ({
						id: s.id,
						title: s.title,
						origin: s.origin,
						status: s.status,
						turnCount: s.turnCount,
						createdAt: s.createdAt,
						lastActiveAt: s.lastActiveAt,
						eventCount: service.getEventCount(s.id),
					})),
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/admin/agent-service/sessions] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "probe_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
