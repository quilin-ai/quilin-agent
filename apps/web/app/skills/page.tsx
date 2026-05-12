import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import type { Skill } from "@/lib/schemas";

export const dynamic = "force-dynamic";

async function loadSkills(): Promise<{
	readonly items: readonly Skill[];
	readonly error: string | null;
}> {
	try {
		const items = await api.skills();
		return { items, error: null };
	} catch (error) {
		if (error instanceof ApiHttpError) {
			return { items: [], error: `控制面返回 HTTP ${error.status}` };
		}
		if (error instanceof ApiEnvelopeError) {
			return { items: [], error: `[${error.code}] ${error.message}` };
		}
		return {
			items: [],
			error: `无法加载技能 · ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

const MATURITY_ORDER: ReadonlyArray<Skill["maturity"]> = ["M2", "M1", "M0"];
const MATURITY_LABEL: Record<Skill["maturity"], string> = {
	M2: "M2 · 已熟练 mastered",
	M1: "M1 · 已激活 activated",
	M0: "M0 · 已注册 registered",
};

export default async function SkillsPage() {
	const { items, error } = await loadSkills();
	const grouped = new Map<Skill["maturity"], Skill[]>();
	for (const skill of items) {
		const arr = grouped.get(skill.maturity) ?? [];
		arr.push(skill);
		grouped.set(skill.maturity, arr);
	}
	const totalUsed = items.reduce((sum, s) => sum + s.usedCount, 0);
	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip pinned />
			<main className="q-workspace no-composer">
				<section className="q-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Skills<span className="cjk">技能</span>
						</h1>
						<p className="q-page-subtitle">
							SKILL.md + frontmatter · catalog + on-demand load · M0 已注册 / M1 已激活 / M2 已熟练
						</p>
						<div className="q-page-stats">
							<span>
								<strong>{items.length}</strong>总技能
							</span>
							<span>
								<strong>{grouped.get("M2")?.length ?? 0}</strong>M2 熟练
							</span>
							<span>
								<strong>{grouped.get("M1")?.length ?? 0}</strong>M1 激活
							</span>
							<span>
								<strong>{grouped.get("M0")?.length ?? 0}</strong>M0 注册
							</span>
							<span>
								<strong>{totalUsed}</strong>累计调用
							</span>
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

					{MATURITY_ORDER.map((maturity) => {
						const bucket = grouped.get(maturity) ?? [];
						if (bucket.length === 0) return null;
						return (
							<div key={maturity}>
								<div className="q-section-title">
									<span className="cn">{MATURITY_LABEL[maturity]}</span>
									<span className="right">{bucket.length} skills</span>
								</div>
								{bucket.map((skill) => (
									<div className="q-resource-row" key={skill.name}>
										<span className="rn">
											{skill.name}
											<span className="desc">{skill.description}</span>
										</span>
										<span className="rm">used {skill.usedCount}×</span>
										<span className={`rs ${maturity === "M0" ? "off" : "on"}`}>
											{maturity === "M0" ? "▪ idle" : "▢ active"}
										</span>
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
