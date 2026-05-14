"use client";

import { useCallback, useEffect, useState } from "react";

import { ProfileFilesSection } from "@/components/config/ProfileFilesSection";
import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

interface ConfigResponse {
	readonly ok: true;
	readonly data: {
		readonly llm: {
			readonly model: string;
			readonly baseURL: string;
			readonly apiKeyPresent: boolean;
			readonly isReasoner: boolean;
		};
		readonly filesystem: {
			readonly cwd: string;
			readonly workspaceRoot: string;
			readonly home: string | null;
			readonly allowedRoots: readonly string[];
		};
		readonly sessionStore: {
			readonly activeSessions: number;
			readonly totalFrames: number;
			readonly byStatus: Record<string, number>;
		};
		readonly process: {
			readonly pid: number;
			readonly nodeVersion: string;
			readonly platform: string;
			readonly uptimeSec: number;
		};
		readonly env: ReadonlyArray<{
			readonly name: string;
			readonly value: string;
			readonly redacted: boolean;
		}>;
	};
}

interface ConfigError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

function formatUptime(sec: number): string {
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${h}h ${m}m`;
}

function Section({
	title,
	titleEn,
	children,
}: {
	readonly title: string;
	readonly titleEn: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div style={{ marginBottom: 24 }}>
			<div className="q-section-title">
				<span className="cn">
					{title} · {titleEn}
				</span>
			</div>
			<div
				style={{
					padding: "10px 12px",
					border: "1px solid var(--border)",
					fontFamily: '"JetBrains Mono", monospace',
					fontSize: 11,
					color: "var(--fg)",
					lineHeight: 1.8,
				}}
			>
				{children}
			</div>
		</div>
	);
}

function KV({
	k,
	v,
	muted = false,
}: {
	readonly k: string;
	readonly v: React.ReactNode;
	readonly muted?: boolean;
}) {
	return (
		<div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
			<span
				style={{ color: "var(--fg-muted)", minWidth: 160, fontSize: 10, letterSpacing: "0.04em" }}
			>
				{k}
			</span>
			<span style={{ color: muted ? "var(--fg-muted)" : "var(--fg)", flex: 1 }}>{v}</span>
		</div>
	);
}

export default function ConfigPage() {
	const [config, setConfig] = useState<ConfigResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const loadConfig = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/config", { cache: "no-store" });
			const json = (await res.json()) as ConfigResponse | ConfigError;
			if (!json.ok) {
				setError(json.error.message);
				setConfig(null);
			} else {
				setConfig(json.data);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadConfig();
	}, [loadConfig]);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="config-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Config<span className="cjk">配置</span>
						</h1>
						<p className="q-page-subtitle">
							当前 web 进程实际加载的运行时配置 · API key / token 已脱敏
						</p>
						<div className="q-page-stats">
							{config == null ? null : (
								<>
									<span>
										<strong>{config.llm.model}</strong>模型
									</span>
									<span>
										<strong>{config.sessionStore.activeSessions}</strong>活跃会话
									</span>
									<span>
										<strong>{formatUptime(config.process.uptimeSec)}</strong>已运行
									</span>
								</>
							)}
							<button
								type="button"
								onClick={() => void loadConfig()}
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
								↻ 刷新
							</button>
						</div>
					</div>

					{loading && config == null ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : error != null ? (
						<p style={{ color: "var(--accent-vermillion)", marginTop: 24 }}>加载失败 · {error}</p>
					) : config == null ? null : (
						<div style={{ marginTop: 20 }}>
							<Section title="LLM 模型" titleEn="model">
								<KV k="model" v={config.llm.model} />
								<KV k="baseURL" v={config.llm.baseURL} />
								<KV
									k="api key"
									v={
										config.llm.apiKeyPresent ? (
											<span style={{ color: "var(--accent-vermillion)" }}>✓ 已配置(脱敏)</span>
										) : (
											<span style={{ color: "var(--fg-muted)" }}>✗ 未设置</span>
										)
									}
								/>
								<KV k="reasoner 模式" v={String(config.llm.isReasoner)} muted />
							</Section>

							<Section title="文件系统" titleEn="filesystem">
								<KV k="cwd" v={config.filesystem.cwd} />
								<KV k="workspace root" v={config.filesystem.workspaceRoot} />
								<KV k="home" v={config.filesystem.home ?? "(unset)"} muted />
								<KV
									k="allowed roots"
									v={
										<div>
											{config.filesystem.allowedRoots.map((r) => (
												<div key={r}>{r}</div>
											))}
										</div>
									}
								/>
							</Section>

							<Section title="会话存储" titleEn="session store">
								<KV k="active sessions" v={config.sessionStore.activeSessions} />
								<KV k="total frames" v={config.sessionStore.totalFrames} muted />
								{Object.keys(config.sessionStore.byStatus).length > 0 ? (
									<KV
										k="by status"
										v={Object.entries(config.sessionStore.byStatus)
											.map(([s, n]) => `${s}=${n}`)
											.join(" · ")}
										muted
									/>
								) : null}
							</Section>

							<Section title="进程" titleEn="process">
								<KV k="pid" v={config.process.pid} muted />
								<KV k="node version" v={config.process.nodeVersion} muted />
								<KV k="platform" v={config.process.platform} muted />
								<KV k="uptime" v={formatUptime(config.process.uptimeSec)} muted />
							</Section>

							{config.env.length > 0 ? (
								<Section
									title="环境变量"
									titleEn="env (QUILIN_ / DEEPSEEK_ / ANTHROPIC_ / OPENAI_)"
								>
									{config.env.map((e) => (
										<KV
											key={e.name}
											k={e.name}
											v={
												e.redacted ? (
													<span style={{ color: "var(--fg-muted)" }}>{e.value}</span>
												) : (
													e.value
												)
											}
											muted={e.redacted}
										/>
									))}
								</Section>
							) : null}

							<ProfileFilesSection />
						</div>
					)}
				</section>
			</main>
		</>
	);
}
