"use client";

import { useCallback, useEffect, useState } from "react";
import { Streamdown } from "streamdown";

/**
 * UX-5 read-only viewer for user.md / soul.md / QUILIN.md.
 *
 * Renders three collapsible cards, each fetching its target file via
 * GET `/api/profile-files?which=...` on first expansion. Streamdown
 * handles bilingual markdown including code fences.
 *
 * Edit path is intentionally out of scope here — UX-5 ships the viewer
 * first; editing UX comes after the interaction primitives spec lands
 * (approval gate + ask channel), since profile-file writes are
 * CRITICAL operations per `docs/07-safety-guardrails/README.md`.
 *
 * UX-5 只读 viewer:三张可折叠卡片,展开时按需 fetch 文件内容,Streamdown
 * 渲染。编辑路径暂未实现 —— 等交互 primitives(approval gate)落地后再做,
 * 因为写 profile 文件按 07-safety §2.6 是 CRITICAL 操作。
 */

type Which = "user" | "soul" | "project";

interface ProfileFile {
	readonly which: Which;
	readonly path: string;
	readonly exists: boolean;
	readonly content: string | null;
	readonly size: number;
	readonly modifiedAt: string | null;
}

const FILES: ReadonlyArray<{
	readonly which: Which;
	readonly cn: string;
	readonly en: string;
	readonly hint: string;
}> = [
	{
		which: "user",
		cn: "用户画像",
		en: "user.md",
		hint: "~/.quilin/user.md · 跨项目持久的用户偏好与背景",
	},
	{
		which: "soul",
		cn: "灵魂档案",
		en: "soul.md",
		hint: "~/.quilin/soul.md · 跨项目持久的人格 / 风格 / 价值观",
	},
	{
		which: "project",
		cn: "项目记忆",
		en: "QUILIN.md",
		hint: "<repo>/QUILIN.md · 当前项目的协作上下文 / 偏好",
	},
];

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatModifiedAt(iso: string | null): string {
	if (iso == null) return "—";
	try {
		const dt = new Date(iso);
		return dt.toLocaleString("zh-CN", { hour12: false });
	} catch {
		return iso;
	}
}

function ProfileFileCard({
	which,
	cn,
	en,
	hint,
}: {
	which: Which;
	cn: string;
	en: string;
	hint: string;
}) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState<ProfileFile | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchFile = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/profile-files?which=${which}`, { cache: "no-store" });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as ProfileFile;
			setData(body);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [which]);

	useEffect(() => {
		if (open && data == null && !loading && error == null) {
			void fetchFile();
		}
	}, [open, data, loading, error, fetchFile]);

	return (
		<div
			className="q-profile-card"
			data-testid={`profile-file-${which}`}
			style={{
				border: "1px solid var(--border)",
				borderRadius: 6,
				marginTop: 12,
				background: "var(--bg-soft)",
			}}
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				data-testid={`profile-toggle-${which}`}
				style={{
					width: "100%",
					padding: "12px 16px",
					display: "flex",
					alignItems: "center",
					gap: 10,
					background: "none",
					border: "none",
					textAlign: "left",
					cursor: "pointer",
					color: "var(--fg)",
				}}
			>
				<span style={{ flex: "0 0 auto", fontSize: 11, color: "var(--fg-muted)" }}>
					{open ? "▾" : "▸"}
				</span>
				<span
					style={{
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 14,
						fontWeight: 500,
					}}
				>
					{cn}
				</span>
				<span
					style={{
						fontFamily: '"JetBrains Mono", monospace',
						fontSize: 11,
						color: "var(--fg-muted)",
						letterSpacing: "0.05em",
					}}
				>
					{en}
				</span>
				{data != null ? (
					<span
						style={{
							marginLeft: "auto",
							fontFamily: '"JetBrains Mono", monospace',
							fontSize: 10,
							color: data.exists ? "var(--fg-muted)" : "var(--fg-subtle)",
						}}
					>
						{data.exists
							? `${formatSize(data.size)} · ${formatModifiedAt(data.modifiedAt)}`
							: "不存在 · not found"}
					</span>
				) : null}
			</button>

			<div
				style={{
					padding: "0 16px 14px 16px",
					fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
					fontStyle: "italic",
					fontSize: 12,
					color: "var(--fg-subtle)",
				}}
			>
				{hint}
			</div>

			{open ? (
				<div style={{ padding: "0 16px 16px 16px", borderTop: "1px solid var(--border)" }}>
					{loading ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 12 }}>加载中 · loading…</p>
					) : error != null ? (
						<p style={{ color: "var(--destructive)", marginTop: 12 }}>读取失败:{error}</p>
					) : data?.exists === false ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 12 }}>
							文件不存在 · 路径:<code style={{ fontSize: 11 }}>{data.path}</code>
						</p>
					) : data?.content != null ? (
						<div
							className="q-streamdown"
							data-testid={`profile-content-${which}`}
							style={{ marginTop: 12 }}
						>
							<Streamdown>{data.content}</Streamdown>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function ProfileFilesSection() {
	return (
		<div data-testid="profile-files-section" style={{ marginTop: 28 }}>
			<div
				className="q-section-title"
				style={{
					display: "flex",
					alignItems: "baseline",
					gap: 8,
					marginBottom: 4,
				}}
			>
				<span
					className="cn"
					style={{
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 13,
						fontWeight: 500,
						color: "var(--fg)",
					}}
				>
					灵魂与画像
				</span>
				<span
					className="en"
					style={{
						fontFamily: '"JetBrains Mono", monospace',
						fontSize: 11,
						color: "var(--fg-muted)",
						letterSpacing: "0.05em",
					}}
				>
					profile · persona · project context
				</span>
			</div>
			<p
				style={{
					marginTop: 6,
					fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
					fontStyle: "italic",
					fontSize: 12,
					color: "var(--fg-subtle)",
				}}
			>
				只读 viewer · read-only · 编辑路径等交互 primitives(approval gate)落地后开放
			</p>
			{FILES.map((f) => (
				<ProfileFileCard key={f.which} {...f} />
			))}
		</div>
	);
}
