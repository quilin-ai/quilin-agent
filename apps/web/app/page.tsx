import { ConversationView } from "@/components/chat/ConversationView";
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
	const initialParam = params.initial;
	const fromParam = params.from;
	const activeSessionId = Array.isArray(sessionParam) ? sessionParam[0] : sessionParam;
	const initialMessage = Array.isArray(initialParam) ? initialParam[0] : initialParam;
	const parentSessionId = Array.isArray(fromParam) ? fromParam[0] : fromParam;

	const recent = await loadRecentSessions();
	const intro = !activeSessionId;

	if (intro) {
		return (
			<>
				<AppHeader sessionId={null} />
				<RailStrip />
				<IntroScreen recentSessions={recent} />
			</>
		);
	}

	return (
		<>
			<Wordmark />
			<AppHeader sessionId={activeSessionId ?? null} />
			<RailStrip />
			<ConversationView
				sessionId={activeSessionId}
				initialMessage={initialMessage}
				parentSessionId={parentSessionId}
			/>
		</>
	);
}
