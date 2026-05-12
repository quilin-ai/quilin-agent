/**
 * GET /api/config
 *
 * Runtime configuration snapshot — what the web process actually loaded,
 * with secrets redacted. Used by the /config page to give the operator
 * an honest picture of "what's running right now" without exposing API
 * keys, bearer tokens, or other credentials.
 *
 * Redaction rules:
 *   - Any env var whose name contains KEY / TOKEN / SECRET / PASSWORD /
 *     CREDENTIAL is shown as `<set:<length>chars>` instead of the value.
 *   - Other env values longer than 256 chars are truncated.
 *
 * 返回当前 web 进程的真实运行时配置:模型 / baseURL / allowedRoots / env / cwd
 * 等,**绝不**返回任何疑似 API key / token / secret 的环境变量原值。
 */

import { getAgentService } from "@/lib/agent-service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Match env var names that should be redacted. Covers credentials
 * (KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/BEARER/JWT/OAUTH), auth
 * artifacts (AUTH covers AUTHORIZATION), session/cookie identifiers,
 * and crypto material (SIGNING/PRIVATE/HMAC/SALT).
 *
 * Note `API_KEY` matches via the `KEY` clause; we deliberately do NOT
 * match a bare `API` substring because that would falsely redact
 * harmless env vars like `OPENAI_API_BASE_URL` or
 * `ANTHROPIC_API_VERSION`. If a value name contains "API" but no
 * credential suffix, we treat it as non-sensitive metadata.
 */
const SECRET_NAME_RX =
	/(API_KEY|API_TOKEN|API_SECRET|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|AUTH|SESSION|COOKIE|JWT|OAUTH|SIGNING|PRIVATE|HMAC|SALT)/i;
const MAX_ENV_VALUE_DISPLAY = 256;
const QUILIN_ENV_PREFIXES = ["QUILIN_", "DEEPSEEK_", "ANTHROPIC_", "OPENAI_"];

interface RedactedEnvEntry {
	readonly name: string;
	readonly value: string;
	readonly redacted: boolean;
}

function redactEnv(env: NodeJS.ProcessEnv): readonly RedactedEnvEntry[] {
	const out: RedactedEnvEntry[] = [];
	for (const [name, raw] of Object.entries(env)) {
		const matchesPrefix = QUILIN_ENV_PREFIXES.some((p) => name.startsWith(p));
		if (!matchesPrefix) continue;
		if (raw == null) continue;
		if (SECRET_NAME_RX.test(name)) {
			out.push({ name, value: `<set:${raw.length}chars>`, redacted: true });
			continue;
		}
		const value =
			raw.length > MAX_ENV_VALUE_DISPLAY
				? `${raw.slice(0, MAX_ENV_VALUE_DISPLAY)}…[truncated ${raw.length - MAX_ENV_VALUE_DISPLAY}]`
				: raw;
		out.push({ name, value, redacted: false });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getSessionStoreSnapshot(): Promise<{
	readonly activeSessions: number;
	readonly totalFrames: number;
	readonly byStatus: Record<string, number>;
}> {
	// Phase 4 of Task #22: read from AgentService instead of the legacy
	// `chat-session-store` globalThis map. The `frames` count now
	// reports buffered AgentEvents per session (not raw SSE frames),
	// summed across all sessions. byStatus reflects AgentService's
	// 4-status state machine (idle / running / completed / failed)
	// instead of chat-session-store's 3 (running / complete / failed).
	const service = await getAgentService();
	const sessions = service.listSessions();
	const byStatus: Record<string, number> = {};
	let totalFrames = 0;
	for (const session of sessions) {
		byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
		totalFrames += service.getEventCount(session.id);
	}
	return { activeSessions: sessions.length, totalFrames, byStatus };
}

export async function GET(): Promise<Response> {
	try {
		const workspaceRoot = process.cwd().replace(/\/apps\/web\/?$/, "");
		const home = process.env.HOME ?? null;
		const envRootsRaw = process.env.QUILIN_WEB_ALLOWED_ROOTS ?? "";
		const envRoots = envRootsRaw
			.split(":")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const allowedRoots = envRoots.length > 0 ? envRoots : [workspaceRoot, home ?? process.cwd()];

		const llm = {
			model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
			baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
			apiKeyPresent:
				(process.env.DEEPSEEK_API_KEY ?? "").length > 0 ||
				(process.env.OPENAI_API_KEY ?? "").length > 0,
			isReasoner: (process.env.DEEPSEEK_MODEL ?? "deepseek-chat").includes("reasoner"),
		};

		const sessionStore = await getSessionStoreSnapshot();

		return Response.json(
			{
				ok: true,
				data: {
					llm,
					filesystem: {
						cwd: process.cwd(),
						workspaceRoot,
						home,
						allowedRoots,
					},
					sessionStore,
					process: {
						pid: process.pid,
						nodeVersion: process.version,
						platform: process.platform,
						uptimeSec: Math.round(process.uptime()),
					},
					env: redactEnv(process.env),
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/config] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "config_load_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
