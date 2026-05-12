import { IntroScreen } from "@/components/intro/IntroScreen";
import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import type { SessionSummary } from "@/lib/schemas";

interface HomePageProps {
	readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function loadRecentSessions(): Promise<readonly SessionSummary[]> {
	try {
		const list = await api.sessions();
		return list.items.slice(0, 5);
	} catch (error) {
		// Surface backend-unavailable as empty list — the intro still renders
		// the wordmark + composer; the user can still start a session.
		if (
			error instanceof ApiHttpError ||
			error instanceof ApiEnvelopeError ||
			error instanceof Error
		) {
			return [];
		}
		return [];
	}
}

export default async function HomePage({ searchParams }: HomePageProps) {
	const params = await searchParams;
	const sessionParam = params.session;
	const activeSessionId = Array.isArray(sessionParam) ? sessionParam[0] : sessionParam;

	const recent = await loadRecentSessions();
	const intro = !activeSessionId;

	if (intro) {
		return (
			<>
				<AppHeader sessionId={null} />
				<IntroScreen recentSessions={recent} />
			</>
		);
	}

	return (
		<>
			<Wordmark />
			<AppHeader sessionId={activeSessionId ?? null} />
			<RailStrip />
			<main className="q-workspace">
				<section className="q-view">
					<div className="q-back-banner">
						<span>会话 · session {activeSessionId}</span>
					</div>
					<p style={{ color: "var(--fg-muted)" }}>
						实时事件流将在 Phase 1b 接入 SSE · 当前 session id = <code>{activeSessionId}</code>。
					</p>
				</section>
			</main>
		</>
	);
}
