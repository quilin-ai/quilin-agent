"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { formatRelativeTime } from "@/lib/format";
import {
	deleteSession as deleteLocalSession,
	listSessions,
	type PersistedSession,
} from "@/lib/session-store";

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

interface ToastState {
	readonly kind: "info" | "error";
	readonly text: string;
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

function truncateTitle(title: string, max = 30): string {
	if (title.length <= max) return title;
	return `${title.slice(0, max)}…`;
}

export default function SessionsPage() {
	const [rows, setRows] = useState<readonly SessionRow[]>([]);
	const [hydrated, setHydrated] = useState(false);
	const [persistenceOn, setPersistenceOn] = useState<boolean | null>(null);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const [toast, setToast] = useState<ToastState | null>(null);
	// D.13 fix: 117 sessions 无 search/filter — user 找不到东西。
	// Add client-side substring filter on session id + title + preview.
	const [searchQuery, setSearchQuery] = useState("");

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

	// Auto-dismiss toast after 4s.
	useEffect(() => {
		if (toast == null) return;
		const handle = setTimeout(() => setToast(null), 4000);
		return () => clearTimeout(handle);
	}, [toast]);

	const handleDelete = useCallback(
		async (row: SessionRow, event: React.MouseEvent<HTMLButtonElement>) => {
			event.preventDefault();
			event.stopPropagation();
			if (pendingDeleteId != null) return; // guard against double-click

			const confirmed = window.confirm(
				`确定删除会话「${truncateTitle(row.title)}」吗?此操作不可撤销。\n\nDelete this session? This cannot be undone.`,
			);
			if (!confirmed) return;

			setPendingDeleteId(row.id);
			// Snapshot for rollback.
			const snapshot = rows;
			// Optimistic update: remove from UI immediately.
			setRows((current) => current.filter((r) => r.id !== row.id));

			// Always evict the local cache so the row doesn't reappear on next mount.
			try {
				deleteLocalSession(row.id);
			} catch {
				// localStorage may be unavailable (SSR / private mode); non-fatal.
			}

			if (row.source === "local") {
				setToast({ kind: "info", text: `已删除本地会话「${truncateTitle(row.title)}」` });
				setPendingDeleteId(null);
				return;
			}

			try {
				const res = await fetch(`/api/sessions/${encodeURIComponent(row.id)}`, {
					method: "DELETE",
				});
				if (!res.ok && res.status !== 404) {
					throw new Error(`DELETE failed: ${res.status}`);
				}
				setToast({ kind: "info", text: `已删除会话「${truncateTitle(row.title)}」` });
			} catch (e) {
				// Rollback the UI.
				setRows(snapshot);
				setToast({
					kind: "error",
					text: `删除失败 · delete failed: ${e instanceof Error ? e.message : String(e)}`,
				});
			} finally {
				setPendingDeleteId(null);
			}
		},
		[pendingDeleteId, rows],
	);

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
							{/* D.13 fix: 117 sessions 无搜索 → 加 client-side filter */}
							<input
								type="text"
								data-testid="sessions-search-input"
								placeholder="搜索 · search by id/title/preview…"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								style={{
									marginLeft: 16,
									padding: "5px 10px",
									fontSize: 12,
									fontFamily: '"JetBrains Mono", monospace',
									border: "1px solid var(--border)",
									background: "var(--bg)",
									color: "var(--fg)",
									borderRadius: 4,
									width: 260,
								}}
							/>
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

					{toast != null && (
						<div
							data-testid="sessions-toast"
							role="status"
							style={{
								marginTop: 12,
								padding: "8px 12px",
								fontFamily: '"JetBrains Mono", monospace',
								fontSize: 11,
								letterSpacing: "0.04em",
								border: `1px solid ${toast.kind === "error" ? "var(--destructive)" : "var(--border)"}`,
								color: toast.kind === "error" ? "var(--destructive)" : "var(--fg-muted)",
								background: "var(--bg)",
							}}
						>
							{toast.text}
						</div>
					)}

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
								<span className="right">
									{searchQuery.trim().length === 0
										? `${rows.length} sessions`
										: (() => {
												const q = searchQuery.trim().toLowerCase();
												const n = rows.filter(
													(r) =>
														r.id.toLowerCase().includes(q) ||
														r.title.toLowerCase().includes(q) ||
														(r.preview ?? "").toLowerCase().includes(q),
												).length;
												return `${n} / ${rows.length} sessions`;
											})()}
								</span>
							</div>
							{rows
								.filter((row) => {
									const q = searchQuery.trim().toLowerCase();
									if (q.length === 0) return true;
									return (
										row.id.toLowerCase().includes(q) ||
										row.title.toLowerCase().includes(q) ||
										(row.preview ?? "").toLowerCase().includes(q)
									);
								})
								.map((row) => {
									const isDeleting = pendingDeleteId === row.id;
									return (
										<div
											key={row.id}
											className="q-resource-row q-session-row"
											data-testid={`session-${row.id}`}
											data-source={row.source}
											style={{ opacity: isDeleting ? 0.5 : 1 }}
										>
											<Link
												href={{ pathname: "/", query: { session: row.id } }}
												className="q-session-link"
												data-testid={`session-link-${row.id}`}
												style={{
													display: "contents",
													color: "inherit",
													textDecoration: "none",
												}}
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
											<button
												type="button"
												className="q-session-delete-btn"
												data-testid={`session-delete-${row.id}`}
												aria-label={`删除会话 ${row.title}`}
												disabled={isDeleting}
												onClick={(e) => {
													void handleDelete(row, e);
												}}
											>
												{isDeleting ? "删除中…" : "🗑 删除"}
											</button>
										</div>
									);
								})}
						</div>
					)}
				</section>
			</main>
		</>
	);
}
