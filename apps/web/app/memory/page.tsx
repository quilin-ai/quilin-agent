import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import type { MemoryEntry, MemoryTier } from "@/lib/schemas";

export const dynamic = "force-dynamic";

interface MemoryLoadResult {
	readonly tiers: readonly MemoryTier[];
	readonly recent: readonly MemoryEntry[];
	readonly error: string | null;
}

async function loadMemory(): Promise<MemoryLoadResult> {
	try {
		const [tiers, recent] = await Promise.all([api.memoryTiers(), api.memoryRecent()]);
		return { tiers, recent: recent.items, error: null };
	} catch (error) {
		if (error instanceof ApiHttpError) {
			return {
				tiers: [],
				recent: [],
				error: `控制面返回 HTTP ${error.status}`,
			};
		}
		if (error instanceof ApiEnvelopeError) {
			return {
				tiers: [],
				recent: [],
				error: `[${error.code}] ${error.message}`,
			};
		}
		return {
			tiers: [],
			recent: [],
			error: `无法加载记忆 · ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

const TIER_DESC: Record<MemoryTier["tier"], string> = {
	working: "当前任务上下文,session 关闭即清",
	episodic: "具体事件,带时间戳 · 30 天 TTL",
	semantic: "抽象偏好与事实 · 永久保留",
	skill: "可复用的程序性技能",
};

export default async function MemoryPage() {
	const { tiers, recent, error } = await loadMemory();
	const totalCount = tiers.reduce((sum, tier) => sum + tier.count, 0);
	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip pinned />
			<main className="q-workspace no-composer">
				<section className="q-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Memory<span className="cjk">记忆</span>
						</h1>
						<p className="q-page-subtitle">
							四层分级 · 工作记忆与长期演化的中枢 · 每次对话后自动反思写入
						</p>
						<div className="q-page-stats">
							<span>
								<strong>{totalCount}</strong>items total
							</span>
							{tiers.map((tier) => (
								<span key={tier.tier}>
									<strong>{tier.count}</strong>
									{tier.tier}
								</span>
							))}
						</div>
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
						>
							{error}
						</div>
					) : null}

					<div className="q-section-title">
						<span className="cn">四层 · tiers</span>
						<span className="right">{formatBytes(tiers.reduce((sum, t) => sum + t.bytes, 0))}</span>
					</div>
					{tiers.map((tier) => (
						<div className="q-memory-tier-full" key={tier.tier}>
							<div className="tn">
								{tier.tier}
								<span className="desc">{TIER_DESC[tier.tier]}</span>
							</div>
							<div className="tc">{tier.count}</div>
							<div className="tp">
								{tier.latestPreview ?? "—"}
								{tier.latestAt ? (
									<span
										style={{
											display: "block",
											fontFamily: '"JetBrains Mono", monospace',
											fontSize: 10,
											color: "var(--fg-subtle)",
											letterSpacing: "0.04em",
											marginTop: 4,
										}}
									>
										latest · {formatRelativeTime(tier.latestAt)}
									</span>
								) : null}
							</div>
						</div>
					))}

					{recent.length > 0 ? (
						<>
							<div className="q-section-title">
								<span className="cn">最近写入 · recent writes</span>
								<span className="right">last {recent.length}</span>
							</div>
							{recent.map((entry) => (
								<div className="q-resource-row" key={entry.id}>
									<span className="rn">
										{entry.content.slice(0, 80)}
										<span className="desc">
											{entry.tier} · {entry.source} · {entry.agentId}
										</span>
									</span>
									<span className="rm">{formatRelativeTime(entry.createdAt)}</span>
									<span className="rs on">{entry.tier}</span>
								</div>
							))}
						</>
					) : null}
				</section>
			</main>
		</>
	);
}
