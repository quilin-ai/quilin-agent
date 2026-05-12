"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Composer } from "@/components/shell/Composer";
import { Wordmark } from "@/components/shell/Wordmark";
import { formatRelativeTime } from "@/lib/format";
import type { SessionSummary } from "@/lib/schemas";

export interface IntroScreenProps {
	readonly recentSessions?: readonly SessionSummary[];
}

/**
 * Centered first-load layout (demo body class `intro`). Wordmark is scaled
 * 1.6×, the composer floats at vertical center, recent sessions list below.
 *
 * Submitting in intro mode navigates out of the intro stage to the regular
 * workspace shell with a stub session id. Phase 1c will replace this with a
 * real `POST /api/v2/sessions` flow once the V2Runtime adapter binds.
 */
export function IntroScreen({ recentSessions = [] }: IntroScreenProps) {
	const router = useRouter();
	const handleSubmit = (_text: string): void => {
		router.push(`/?session=draft-${Date.now().toString(36)}`);
	};
	return (
		<div className="q-intro-stage" data-testid="intro-screen">
			<Wordmark variant="intro" />
			<Composer agents={[]} currentAgentId="main" intro onSubmit={handleSubmit} />
			{recentSessions.length > 0 ? (
				<div className="q-intro-recent">
					<div className="head">最近 · recent sessions</div>
					{recentSessions.slice(0, 5).map((session) => (
						<Link
							key={session.id}
							href={{ pathname: "/", query: { session: session.id } }}
							className="q-recent-row"
							data-testid={`recent-${session.id}`}
						>
							<div className="title">{session.title}</div>
							<div className="meta">
								{formatRelativeTime(session.lastTurnAt)} · {session.turnsCount} 轮 ·{" "}
								{session.agentId}
							</div>
						</Link>
					))}
				</div>
			) : null}
		</div>
	);
}
