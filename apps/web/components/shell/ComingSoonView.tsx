import type { ReactNode } from "react";

import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

export interface ComingSoonViewProps {
	readonly title: string;
	readonly titleCjk: string;
	readonly subtitle: string;
	readonly summary: string;
	readonly features: ReadonlyArray<{ readonly label: string; readonly desc: string }>;
	readonly specHref: string;
	readonly testId: string;
}

/**
 * Shared "正在开发中" placeholder used by Memory / Skills / MCP / Tools / Config.
 * Shows the spec excerpt instead of an "无法加载" error so the demo can walk
 * through the design narrative.
 */
export function ComingSoonView(props: ComingSoonViewProps) {
	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid={props.testId}>
					<div className="q-page-head">
						<h1 className="q-page-title">
							{props.title}
							<span className="cjk">{props.titleCjk}</span>
						</h1>
						<p className="q-page-subtitle">{props.subtitle}</p>
						<div className="q-page-stats">
							<span
								style={{
									padding: "3px 8px",
									border: "1px solid var(--accent-vermillion)",
									color: "var(--accent-vermillion)",
									fontFamily: '"JetBrains Mono", monospace',
									fontSize: 10,
									letterSpacing: "0.06em",
								}}
							>
								▪ WIP · 正在开发中
							</span>
							<a
								href={props.specHref}
								target="_blank"
								rel="noreferrer"
								style={{
									color: "var(--fg-muted)",
									textDecoration: "underline",
									fontSize: 11,
								}}
							>
								查看完整设计 · view spec
							</a>
						</div>
					</div>

					<div className="q-section-title">
						<span className="cn">愿景 · vision</span>
					</div>
					<p style={{ color: "var(--fg)", lineHeight: 1.7, marginBottom: 20 }}>{props.summary}</p>

					<div className="q-section-title">
						<span className="cn">能力清单 · capabilities</span>
						<span className="right">{props.features.length} planned</span>
					</div>
					<div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
						{props.features.map((f) => (
							<div key={f.label} className="q-resource-row" style={{ cursor: "default" }}>
								<span className="rn">
									{f.label}
									<span className="desc">{f.desc}</span>
								</span>
								<span className="rs" style={{ color: "var(--fg-muted)" }}>
									planned
								</span>
							</div>
						))}
					</div>
				</section>
			</main>
		</>
	);
}

export function specRender(children: ReactNode): ReactNode {
	return <div style={{ lineHeight: 1.7 }}>{children}</div>;
}
