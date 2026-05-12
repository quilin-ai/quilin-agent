import Link from "next/link";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import { bucketByDate, formatRelativeTime, formatTokens, type SessionBucket } from "@/lib/format";
import type { SessionStatus, SessionSummary } from "@/lib/schemas";

export const dynamic = "force-dynamic";

interface SessionsLoadResult {
	readonly items: readonly SessionSummary[];
	readonly error: string | null;
}

async function loadSessions(): Promise<SessionsLoadResult> {
	try {
		const list = await api.sessions();
		return { items: list.items, error: null };
	} catch (error) {
		if (error instanceof ApiHttpError) {
			return {
				items: [],
				error: `控制面 / control-plane 返回 HTTP ${error.status} · ${error.bodySnippet || "no body"}`,
			};
		}
		if (error instanceof ApiEnvelopeError) {
			return { items: [], error: `[${error.code}] ${error.message}` };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			items: [],
			error: `无法连接控制面 · cannot reach control-plane: ${message}`,
		};
	}
}

const BUCKET_ORDER: ReadonlyArray<SessionBucket["key"]> = [
	"today",
	"yesterday",
	"this-week",
	"earlier",
];

const BUCKET_LABEL: Record<SessionBucket["key"], string> = {
	today: "今天 · today",
	yesterday: "昨天 · yesterday",
	"this-week": "本周 · this week",
	earlier: "更早 · earlier",
};

function groupByDate(
	items: readonly SessionSummary[],
): ReadonlyMap<SessionBucket["key"], readonly SessionSummary[]> {
	const now = new Date();
	const map = new Map<SessionBucket["key"], SessionSummary[]>();
	for (const session of items) {
		const bucket = bucketByDate(session.lastTurnAt, now);
		const arr = map.get(bucket.key) ?? [];
		arr.push(session);
		map.set(bucket.key, arr);
	}
	for (const arr of map.values()) {
		arr.sort((a, b) => {
			const ta = new Date(a.lastTurnAt).getTime();
			const tb = new Date(b.lastTurnAt).getTime();
			return tb - ta;
		});
	}
	return map;
}

function statusChip(status: SessionStatus): { className: string; label: string } {
	switch (status) {
		case "active":
			return { className: "on", label: "▪ active" };
		case "closed":
			return { className: "on", label: "▢ closed" };
		case "archived":
			return { className: "off", label: "▫ archived" };
		case "blocked":
			return { className: "err", label: "✕ blocked" };
	}
}

function StatRow({ items }: { readonly items: readonly SessionSummary[] }) {
	const total = items.length;
	const totalTokens = items.reduce((sum, item) => sum + item.tokensTotal, 0);
	const active = items.filter((s) => s.status === "active").length;
	const today = items.filter((s) => bucketByDate(s.lastTurnAt).key === "today").length;
	return (
		<div className="q-page-stats">
			<span>
				<strong>{total}</strong>总会话
			</span>
			<span>
				<strong>{today}</strong>今天
			</span>
			<span>
				<strong>{active}</strong>active
			</span>
			<span>
				<strong>{formatTokens(totalTokens)}</strong>累计 tokens
			</span>
		</div>
	);
}

export default async function SessionsPage() {
	const { items, error } = await loadSessions();
	const grouped = groupByDate(items);

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
							所有历史对话 · 按日期分组 · 点击任意会话可恢复上下文继续
						</p>
						<StatRow items={items} />
					</div>

					{error ? (
						<div
							style={{
								padding: 16,
								border: "1px solid var(--destructive)",
								color: "var(--destructive)",
								fontFamily: '"JetBrains Mono", monospace',
								fontSize: 12,
								marginBottom: 24,
							}}
							role="alert"
							data-testid="sessions-error"
						>
							{error}
						</div>
					) : null}

					{BUCKET_ORDER.map((bucketKey) => {
						const bucketItems = grouped.get(bucketKey) ?? [];
						if (bucketItems.length === 0) return null;
						return (
							<div key={bucketKey}>
								<div className="q-section-title">
									<span className="cn">{BUCKET_LABEL[bucketKey]}</span>
									<span className="right">{bucketItems.length} sessions</span>
								</div>
								{bucketItems.map((session) => {
									const chip = statusChip(session.status);
									return (
										<Link
											key={session.id}
											href={{ pathname: "/", query: { session: session.id } }}
											className="q-resource-row"
											data-testid={`session-${session.id}`}
										>
											<span className="rn">
												{session.title}
												<span className="desc">
													{session.agentId} · {session.turnsCount} 轮 ·{" "}
													{formatTokens(session.tokensTotal)} tokens
												</span>
											</span>
											<span className="rm">{formatRelativeTime(session.lastTurnAt)}</span>
											<span className={`rs ${chip.className}`}>{chip.label}</span>
										</Link>
									);
								})}
							</div>
						);
					})}

					{!error && items.length === 0 ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>还没有会话 · no sessions yet</p>
					) : null}
				</section>
			</main>
		</>
	);
}
