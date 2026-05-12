"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { formatRelativeTime } from "@/lib/format";
import { listSessions, type PersistedSession } from "@/lib/session-store";

export default function SessionsPage() {
	const [sessions, setSessions] = useState<readonly PersistedSession[]>([]);
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		setSessions(listSessions());
		setHydrated(true);
	}, []);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip pinned />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="sessions-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Sessions<span className="cjk">会话</span>
						</h1>
						<p className="q-page-subtitle">
							所有历史对话 · 来自浏览器本地存储 · 点击任意会话可恢复上下文继续
						</p>
						<div className="q-page-stats">
							<span>
								<strong>{sessions.length}</strong>总会话
							</span>
							<span>
								<strong>
									{sessions.reduce((sum, s) => sum + s.messageCount, 0)}
								</strong>
								累计消息
							</span>
						</div>
					</div>

					{!hydrated ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : sessions.length === 0 ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>
							还没有会话 · no sessions yet ·{" "}
							<Link
								href="/"
								style={{ color: "var(--accent-vermillion)", textDecoration: "underline" }}
							>
								去开始一个对话
							</Link>
						</p>
					) : (
						<div>
							<div className="q-section-title">
								<span className="cn">最近 · recent</span>
								<span className="right">{sessions.length} sessions</span>
							</div>
							{sessions.map((session) => (
								<Link
									key={session.id}
									href={{ pathname: "/", query: { session: session.id } }}
									className="q-resource-row"
									data-testid={`session-${session.id}`}
								>
									<span className="rn">
										{session.title}
										<span className="desc">{session.preview}</span>
									</span>
									<span className="rm">{formatRelativeTime(session.updatedAt)}</span>
									<span className="rs on">
										{session.messageCount} 条
									</span>
								</Link>
							))}
						</div>
					)}
				</section>
			</main>
		</>
	);
}
