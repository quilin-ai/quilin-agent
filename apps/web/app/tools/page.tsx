import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import type { Tool } from "@/lib/schemas";

export const dynamic = "force-dynamic";

async function loadTools(): Promise<{
	readonly items: readonly Tool[];
	readonly error: string | null;
}> {
	try {
		return { items: await api.tools(), error: null };
	} catch (error) {
		if (error instanceof ApiHttpError) {
			return { items: [], error: `控制面返回 HTTP ${error.status}` };
		}
		if (error instanceof ApiEnvelopeError) {
			return { items: [], error: `[${error.code}] ${error.message}` };
		}
		return {
			items: [],
			error: `无法加载工具 · ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

const CATEGORY_ORDER: ReadonlyArray<Tool["category"]> = [
	"core",
	"orchestration",
	"network",
	"discovery",
	"multimodal",
];

const CATEGORY_LABEL: Record<Tool["category"], { cn: string; right: string }> = {
	core: { cn: "core · 核心", right: "file + shell" },
	orchestration: { cn: "orchestration · 编排", right: "subagents" },
	network: { cn: "network · 网络", right: "web access" },
	discovery: { cn: "discovery · 发现", right: "prompt-saving gateway" },
	multimodal: { cn: "multimodal · 多模态", right: "vision + audio" },
};

export default async function ToolsPage() {
	const { items, error } = await loadTools();
	const grouped = new Map<Tool["category"], Tool[]>();
	for (const tool of items) {
		const arr = grouped.get(tool.category) ?? [];
		arr.push(tool);
		grouped.set(tool.category, arr);
	}
	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip pinned />
			<main className="q-workspace no-composer">
				<section className="q-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Tools<span className="cjk">工具</span>
						</h1>
						<p className="q-page-subtitle">内置工具 · 经 tool_search 按需暴露,避免 prompt 膨胀</p>
						<div className="q-page-stats">
							<span>
								<strong>{items.length}</strong>总工具
							</span>
							{CATEGORY_ORDER.map((cat) => {
								const count = grouped.get(cat)?.length ?? 0;
								if (count === 0) return null;
								return (
									<span key={cat}>
										<strong>{count}</strong>
										{cat}
									</span>
								);
							})}
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

					{CATEGORY_ORDER.map((category) => {
						const bucket = grouped.get(category) ?? [];
						if (bucket.length === 0) return null;
						const label = CATEGORY_LABEL[category];
						return (
							<div key={category}>
								<div className="q-section-title">
									<span className="cn">{label.cn}</span>
									<span className="right">{label.right}</span>
								</div>
								{bucket.map((tool) => (
									<div className="q-resource-row" key={tool.name}>
										<span className="rn">
											{tool.name}
											<span className="desc">
												{tool.source} · used {tool.usedCount}×
												{tool.successRate != null
													? ` · ${Math.round(tool.successRate * 100)}% success`
													: ""}
											</span>
										</span>
										<span className="rm">
											{tool.avgLatencyMs != null ? `${Math.round(tool.avgLatencyMs)}ms avg` : "—"}
										</span>
										<span className="rs on">▢ ready</span>
									</div>
								))}
							</div>
						);
					})}
				</section>
			</main>
		</>
	);
}
