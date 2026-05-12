"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

interface SkillSummary {
	readonly name: string;
	readonly description: string;
	readonly source: "user" | "project" | "bundled" | "plugin";
	readonly path: string;
	readonly whenToUse: string | null;
	readonly trust: string | null;
	readonly mandatory: boolean;
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly version: string | null;
	readonly allowedTools: readonly string[] | null;
	readonly requiresTools: readonly string[] | null;
}

interface SkillsCatalogResponse {
	readonly ok: true;
	readonly data: {
		readonly roots: { readonly user: string | null; readonly project: string };
		readonly skills: readonly SkillSummary[];
		readonly counts: {
			readonly total: number;
			readonly user: number;
			readonly project: number;
			readonly bundled: number;
			readonly plugin: number;
		};
		readonly filesystem: {
			readonly userDirsWithSkillMd: number;
			readonly projectDirsWithSkillMd: number;
			readonly userFiltered: number;
			readonly projectFiltered: number;
		};
	};
}

interface SkillsCatalogError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

interface SkillDetailResponse {
	readonly ok: true;
	readonly data: {
		readonly descriptor: SkillSummary & { readonly frontmatter: Record<string, unknown> };
		readonly body: string;
		readonly tokenEstimate: number;
	};
}

type SourceFilter = "all" | "user" | "project" | "bundled" | "plugin";

const SOURCE_LABEL: Record<
	Exclude<SourceFilter, "all">,
	{ readonly cn: string; readonly en: string }
> = {
	user: { cn: "用户", en: "user" },
	project: { cn: "项目", en: "project" },
	bundled: { cn: "内置", en: "bundled" },
	plugin: { cn: "插件", en: "plugin" },
};

export default function SkillsPage() {
	const [catalog, setCatalog] = useState<SkillsCatalogResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [detail, setDetail] = useState<SkillDetailResponse["data"] | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);

	const loadCatalog = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/skills", { cache: "no-store" });
			const json = (await res.json()) as SkillsCatalogResponse | SkillsCatalogError;
			if (!json.ok) {
				setError(json.error.message);
				setCatalog(null);
			} else {
				setCatalog(json.data);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	useEffect(() => {
		if (selectedName == null) {
			setDetail(null);
			setDetailError(null);
			return;
		}
		let cancelled = false;
		setDetailLoading(true);
		setDetailError(null);
		setDetail(null);
		void (async () => {
			try {
				const res = await fetch(`/api/skills/${encodeURIComponent(selectedName)}`, {
					cache: "no-store",
				});
				const json = (await res.json()) as SkillDetailResponse | SkillsCatalogError;
				if (cancelled) return;
				if (!json.ok) {
					setDetailError(json.error.message);
				} else {
					setDetail(json.data);
				}
			} catch (e) {
				if (cancelled) return;
				setDetailError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setDetailLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [selectedName]);

	const visibleSkills = useMemo(() => {
		if (catalog == null) return [];
		const needle = filter.trim().toLowerCase();
		return catalog.skills.filter((s) => {
			if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
			if (needle.length === 0) return true;
			return (
				s.name.toLowerCase().includes(needle) ||
				s.description.toLowerCase().includes(needle) ||
				(s.whenToUse?.toLowerCase().includes(needle) ?? false)
			);
		});
	}, [catalog, filter, sourceFilter]);

	const groupedSkills = useMemo(() => {
		const groups: Record<string, SkillSummary[]> = {};
		for (const skill of visibleSkills) {
			const key = skill.source;
			if (groups[key] == null) groups[key] = [];
			groups[key].push(skill);
		}
		return groups;
	}, [visibleSkills]);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="skills-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Skills<span className="cjk">技能</span>
						</h1>
						<p className="q-page-subtitle">
							SKILL.md + frontmatter · 按需加载 · 主代理只看 catalog,命中触发条件才完整加载
						</p>
						<div className="q-page-stats">
							{catalog == null ? null : (
								<>
									<span>
										<strong>{catalog.counts.total}</strong>个技能
									</span>
									<span>
										<strong>{catalog.counts.user}</strong>用户级
									</span>
									<span>
										<strong>{catalog.counts.project}</strong>项目级
									</span>
									{catalog.counts.bundled > 0 ? (
										<span>
											<strong>{catalog.counts.bundled}</strong>内置
										</span>
									) : null}
									{catalog.filesystem.userFiltered + catalog.filesystem.projectFiltered > 0 ? (
										<span
											title={`磁盘上找到 ${catalog.filesystem.userDirsWithSkillMd + catalog.filesystem.projectDirsWithSkillMd} 个含 SKILL.md 的目录,${catalog.filesystem.userFiltered + catalog.filesystem.projectFiltered} 个被 SkillsManager 过滤(frontmatter 解析失败,如 description 用了 YAML 多行块标量 \`description: |\` —— 当前解析器不支持)`}
											style={{
												color: "var(--accent-vermillion)",
												borderLeft: "1px solid var(--accent-vermillion)",
												paddingLeft: 10,
												marginLeft: 4,
												cursor: "help",
											}}
										>
											⚠{" "}
											<strong>
												{catalog.filesystem.userFiltered + catalog.filesystem.projectFiltered}
											</strong>
											未加载
										</span>
									) : null}
								</>
							)}
							<button
								type="button"
								onClick={() => void loadCatalog()}
								className="q-page-action"
								style={{
									marginLeft: "auto",
									padding: "5px 10px",
									border: "1px solid var(--accent-vermillion)",
									color: "var(--accent-vermillion)",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 11,
									letterSpacing: "0.02em",
									background: "transparent",
									cursor: "pointer",
								}}
							>
								↻ 重新扫描
							</button>
						</div>
					</div>

					{loading && catalog == null ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : error != null ? (
						<p style={{ color: "var(--accent-vermillion)", marginTop: 24 }}>加载失败 · {error}</p>
					) : catalog == null ? null : (
						<>
							<div
								style={{
									display: "flex",
									gap: 8,
									alignItems: "center",
									marginTop: 20,
									marginBottom: 12,
									flexWrap: "wrap",
								}}
							>
								<input
									type="text"
									placeholder="筛选 · filter by name, description, or trigger…"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									data-testid="skills-filter"
									style={{
										flex: 1,
										minWidth: 240,
										padding: "6px 10px",
										border: "1px solid var(--border)",
										background: "transparent",
										color: "var(--fg)",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 12,
									}}
								/>
								{(["all", "user", "project", "bundled"] as const).map((src) => {
									const active = sourceFilter === src;
									const count =
										src === "all"
											? catalog.counts.total
											: catalog.counts[src as keyof typeof catalog.counts];
									if (src !== "all" && count === 0) return null;
									return (
										<button
											key={src}
											type="button"
											onClick={() => setSourceFilter(src)}
											style={{
												padding: "5px 10px",
												border: `1px solid ${active ? "var(--accent-vermillion)" : "var(--border)"}`,
												color: active ? "var(--accent-vermillion)" : "var(--fg-muted)",
												background: "transparent",
												fontFamily: '"JetBrains Mono", monospace',
												fontSize: 11,
												letterSpacing: "0.04em",
												cursor: "pointer",
											}}
										>
											{src === "all" ? "全部" : SOURCE_LABEL[src].cn}
											<span style={{ marginLeft: 6, opacity: 0.6 }}>{count}</span>
										</button>
									);
								})}
							</div>

							<div
								style={{
									display: "grid",
									gridTemplateColumns:
										selectedName != null ? "minmax(280px, 1fr) minmax(0, 2fr)" : "1fr",
									gap: 20,
									marginTop: 8,
								}}
							>
								<div
									style={{
										maxHeight: selectedName != null ? "calc(100vh - 280px)" : undefined,
										overflowY: selectedName != null ? "auto" : undefined,
									}}
								>
									{visibleSkills.length === 0 ? (
										<p style={{ color: "var(--fg-muted)", marginTop: 16 }}>
											{filter.length > 0 || sourceFilter !== "all"
												? "没有匹配的技能 · no matches"
												: "还没有可用的技能 · no skills installed"}
										</p>
									) : (
										(["project", "user", "bundled", "plugin"] as const)
											.filter((src) => (groupedSkills[src]?.length ?? 0) > 0)
											.map((src) => (
												<div key={src} style={{ marginBottom: 18 }}>
													<div className="q-section-title">
														<span className="cn">
															{SOURCE_LABEL[src].cn} · {SOURCE_LABEL[src].en}
														</span>
														<span className="right">{groupedSkills[src]?.length ?? 0} skills</span>
													</div>
													{(groupedSkills[src] ?? []).map((skill) => {
														const active = selectedName === skill.name;
														return (
															<button
																key={skill.name}
																type="button"
																onClick={() => setSelectedName(skill.name)}
																className="q-resource-row"
																data-testid={`skill-${skill.name}`}
																style={{
																	textAlign: "left",
																	width: "100%",
																	background: active ? "var(--bg-elev)" : "transparent",
																	border: "none",
																	borderBottom: "1px solid var(--border)",
																	cursor: "pointer",
																	padding: "10px 12px",
																	display: "flex",
																	gap: 10,
																	alignItems: "baseline",
																}}
															>
																<span className="rn" style={{ flex: 1 }}>
																	{skill.name}
																	{skill.mandatory ? (
																		<span
																			style={{
																				marginLeft: 6,
																				color: "var(--accent-vermillion)",
																				fontSize: 10,
																			}}
																		>
																			★
																		</span>
																	) : null}
																	<span className="desc">{skill.description}</span>
																</span>
																{skill.trust != null ? (
																	<span
																		className="rs"
																		style={{
																			color:
																				skill.trust === "builtin" || skill.trust === "trusted"
																					? "var(--fg-muted)"
																					: "var(--fg)",
																		}}
																	>
																		{skill.trust}
																	</span>
																) : null}
															</button>
														);
													})}
												</div>
											))
									)}
								</div>

								{selectedName != null ? (
									<aside
										style={{
											border: "1px solid var(--border)",
											padding: "16px 18px",
											maxHeight: "calc(100vh - 280px)",
											overflowY: "auto",
											position: "sticky",
											top: 12,
										}}
										data-testid="skill-detail"
									>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												marginBottom: 12,
												borderBottom: "1px solid var(--border)",
												paddingBottom: 10,
											}}
										>
											<h2
												style={{
													fontFamily: '"Source Han Serif SC", serif',
													fontSize: 16,
													fontWeight: 600,
													margin: 0,
												}}
											>
												{selectedName}
											</h2>
											<button
												type="button"
												onClick={() => setSelectedName(null)}
												style={{
													background: "transparent",
													border: "1px solid var(--border)",
													color: "var(--fg-muted)",
													padding: "3px 8px",
													fontFamily: '"JetBrains Mono", monospace',
													fontSize: 11,
													cursor: "pointer",
												}}
											>
												× 关闭
											</button>
										</div>
										{detailLoading ? (
											<p style={{ color: "var(--fg-muted)" }}>加载中 · loading…</p>
										) : detailError != null ? (
											<p style={{ color: "var(--accent-vermillion)" }}>加载失败 · {detailError}</p>
										) : detail == null ? null : (
											<>
												<div
													style={{
														fontFamily: '"JetBrains Mono", monospace',
														fontSize: 10,
														color: "var(--fg-muted)",
														marginBottom: 16,
														lineHeight: 1.7,
													}}
												>
													<div>
														<span style={{ opacity: 0.6 }}>path:</span> {detail.descriptor.path}
													</div>
													<div>
														<span style={{ opacity: 0.6 }}>source:</span> {detail.descriptor.source}
														{detail.descriptor.frontmatter.trust != null
															? ` · trust=${String(detail.descriptor.frontmatter.trust)}`
															: ""}
														{" · "}
														<span style={{ opacity: 0.6 }}>tokens≈</span>
														{detail.tokenEstimate}
													</div>
													{detail.descriptor.frontmatter.whenToUse != null &&
													typeof detail.descriptor.frontmatter.whenToUse === "string" ? (
														<div style={{ marginTop: 6 }}>
															<span style={{ opacity: 0.6 }}>when to use:</span>{" "}
															{detail.descriptor.frontmatter.whenToUse}
														</div>
													) : null}
												</div>
												<div className="q-md">
													<Streamdown
														mode="static"
														controls={{ table: false, code: false, mermaid: false }}
													>
														{detail.body}
													</Streamdown>
												</div>
											</>
										)}
									</aside>
								) : null}
							</div>
						</>
					)}
				</section>
			</main>
		</>
	);
}
