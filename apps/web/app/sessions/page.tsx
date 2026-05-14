"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { formatRelativeTime } from "@/lib/format";
import { listSessions, type PersistedSession } from "@/lib/session-store";

/**
 * Unified session row used by the list UI. Merges:
 *   - server (SQLite) sessions from GET /api/sessions
 *   - browser-local sessions from `session-store.ts`
 *
 * `source` indicates which side the row primarily came from; "server" wins
 * on conflict per spec §5.3.
 *
 * 统一 session 行,合并服务端 SQLite + 本地 localStorage;冲突时以 server
 * 为准并把 server 行 cache 回 localStorage(spec §5.3)。
 */
interface SessionRow {
	readonly id: string;
	readonly title: string;
	readonly preview: string;
	readonly messageCount: number;
	readonly updatedAt: string;
	readonly source: "server" | "local";
}

interface ServerSessionDto {
	readonly id: string;
	readonly title: string | null;
	readonly created_at: number;
	readonly updated_at: number;
	readonly message_count: number;
	readonly preview: string | null;
}

interface SessionsApiResponse {
	readonly sessions: readonly ServerSessionDto[];
	readonly persistenceEnabled: boolean;
}

function persistedToRow(s: PersistedSession): SessionRow {
	return {
		id: s.id,
		title: s.title,
		preview: s.preview,
		messageCount: s.messageCount,
		updatedAt: s.updatedAt,
		source: "local",
	};
}

function serverToRow(s: ServerSessionDto): SessionRow {
	return {
		id: s.id,
		title: s.title ?? "(untitled session)",
		preview: s.preview ?? "",
		messageCount: s.message_count,
		updatedAt: new Date(s.updated_at).toISOString(),
		source: "server",
	};
}

function mergeRows(
	serverSessions: readonly ServerSessionDto[],
	localSessions: readonly PersistedSession[],
): SessionRow[] {
	const merged = new Map<string, SessionRow>();
	for (const s of localSessions) merged.set(s.id, persistedToRow(s));
	for (const s of serverSessions) merged.set(s.id, serverToRow(s)); // server wins on conflict
	return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export default function SessionsPage() {
	const [rows, setRows] = useState<readonly SessionRow[]>([]);
	const [hydrated, setHydrated] = useState(false);
	const [persistenceOn, setPersistenceOn] = useState<boolean | null>(null);

	useEffect(() => {
		const local = listSessions();
		// Render local immediately for fast first-paint, then enrich with server.
		setRows(mergeRows([], local));
		setHydrated(true);

		void (async () => {
			try {
				const res = await fetch("/api/sessions", { cache: "no-store" });
				if (!res.ok) return; // surface nothing; local view is good enough
				const body = (await res.json()) as SessionsApiResponse;
				setPersistenceOn(body.persistenceEnabled);
				setRows(mergeRows(body.sessions, local));
			} catch {
				// Network failure / dev-server down — keep the local-only view.
			}
		})();
	}, []);

	const totalMessages = rows.reduce((sum, r) => sum + r.messageCount, 0);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="sessions-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Sessions<span className="cjk">会话</span>
						</h1>
						<p className="q-page-subtitle">
							所有历史对话 ·{" "}
							{persistenceOn === false
								? "本地缓存(后端持久化未启用)"
								: persistenceOn === true
									? "本地 + 服务端 SQLite 持久化合并"
									: "本地缓存"}{" "}
							· 点击任意会话可恢复上下文继续
						</p>
						<div className="q-page-stats">
							<span>
								<strong>{rows.length}</strong>总会话
							</span>
							<span>
								<strong>{totalMessages}</strong>累计消息
							</span>
							<Link
								href="/"
								className="q-page-action"
								data-testid="new-session-link"
								style={{
									marginLeft: "auto",
									padding: "5px 10px",
									border: "1px solid var(--accent-vermillion)",
									color: "var(--accent-vermillion)",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 11,
									letterSpacing: "0.02em",
									textDecoration: "none",
									cursor: "pointer",
								}}
							>
								＋ 新建会话
							</Link>
						</div>
					</div>

					{!hydrated ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : rows.length === 0 ? (
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
								<span className="right">{rows.length} sessions</span>
							</div>
							{rows.map((row) => (
								<Link
									key={row.id}
									href={{ pathname: "/", query: { session: row.id } }}
									className="q-resource-row"
									data-testid={`session-${row.id}`}
									data-source={row.source}
								>
									<span className="rn">
										{row.title}
										<span className="desc">{row.preview}</span>
									</span>
									<span className="rm">{formatRelativeTime(row.updatedAt)}</span>
									<span className="rs on">
										{row.messageCount} 条 · {row.source === "server" ? "云端" : "本地"}
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
