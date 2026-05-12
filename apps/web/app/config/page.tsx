import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import { ApiEnvelopeError, ApiHttpError, api } from "@/lib/api";
import type { Config } from "@/lib/schemas";

export const dynamic = "force-dynamic";

async function loadConfig(): Promise<{
	readonly config: Config | null;
	readonly error: string | null;
}> {
	try {
		return { config: await api.config(), error: null };
	} catch (error) {
		if (error instanceof ApiHttpError) {
			return { config: null, error: `控制面返回 HTTP ${error.status}` };
		}
		if (error instanceof ApiEnvelopeError) {
			return { config: null, error: `[${error.code}] ${error.message}` };
		}
		return {
			config: null,
			error: `无法加载配置 · ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

interface FieldRowProps {
	readonly label: string;
	readonly desc: string;
	readonly value: string;
	readonly hint?: string;
}

function FieldRow({ label, desc, value, hint }: FieldRowProps) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "220px 1fr auto",
				gap: 24,
				alignItems: "baseline",
				padding: "16px 0",
				borderBottom: "1px solid var(--border)",
			}}
		>
			<div
				style={{
					fontFamily: '"JetBrains Mono", monospace',
					fontSize: 12,
					letterSpacing: "0.04em",
					color: "var(--fg)",
				}}
			>
				{label}
				<span
					style={{
						display: "block",
						fontFamily: '"Cormorant Garamond", serif',
						fontStyle: "italic",
						color: "var(--fg-subtle)",
						fontSize: 12,
						marginTop: 4,
						lineHeight: 1.5,
						letterSpacing: 0,
					}}
				>
					{desc}
				</span>
			</div>
			<div
				style={{
					fontFamily: '"JetBrains Mono", monospace',
					fontSize: 14,
					color: "var(--fg)",
					borderBottom: "1px solid var(--border)",
					padding: "4px 0",
				}}
			>
				{value}
			</div>
			<div
				style={{
					fontFamily: '"JetBrains Mono", monospace',
					fontSize: 10,
					letterSpacing: "0.06em",
					color: "var(--fg-subtle)",
				}}
			>
				{hint ?? "—"}
			</div>
		</div>
	);
}

export default async function ConfigPage() {
	const { config, error } = await loadConfig();
	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip pinned />
			<main className="q-workspace no-composer">
				<section className="q-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Config<span className="cjk">配置</span>
						</h1>
						<p className="q-page-subtitle">用户配置 · Phase 1c 接入热更新写入回路 · 当前只读</p>
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

					{config ? (
						<>
							<div className="q-section-title">
								<span className="cn">安全 · safety</span>
								<span className="right">CRITICAL gate</span>
							</div>
							<FieldRow
								label="trust_mode"
								desc="auto = 非 CRITICAL 自动放行;ask = 全部询问"
								value={config.trustMode}
								hint="default · auto"
							/>
							<FieldRow
								label="redaction.policy"
								desc="敏感字段脱敏级别 · minimal / standard / strict"
								value={config.redactionPolicy}
								hint="default · standard"
							/>

							<div className="q-section-title">
								<span className="cn">演化 · evolution</span>
								<span className="right">idle-time loops</span>
							</div>
							<FieldRow
								label="idle_evolution"
								desc="空闲时自动跑反思/优化 · 默认 OFF"
								value={config.idleEvolution ? "enabled" : "disabled"}
								hint="default · disabled"
							/>
							<FieldRow
								label="auto_reflect"
								desc="每轮对话后自动反思写入 episodic memory"
								value={config.autoReflect ? "enabled" : "disabled"}
								hint="default · enabled"
							/>

							<div className="q-section-title">
								<span className="cn">预算 · budget</span>
								<span className="right">token guardrail</span>
							</div>
							<FieldRow
								label="token_budget.daily"
								desc="单日 token 上限"
								value={config.tokenBudgetDaily.toLocaleString()}
								hint="default · 80,000"
							/>
							<FieldRow
								label="token_budget.warn_at"
								desc="用尽 N% 时弹提示"
								value={`${Math.round(config.tokenBudgetWarnAt * 100)}%`}
								hint="default · 80%"
							/>

							<div className="q-section-title">
								<span className="cn">模型 · model</span>
								<span className="right">two-tier routing</span>
							</div>
							<FieldRow
								label="model.default"
								desc="主对话模型 · 高质量"
								value={config.modelDefault}
								hint="—"
							/>
							<FieldRow
								label="model.cheap"
								desc="子代理、内部分类等便宜任务用"
								value={config.modelCheap}
								hint="—"
							/>
						</>
					) : null}
				</section>
			</main>
		</>
	);
}
