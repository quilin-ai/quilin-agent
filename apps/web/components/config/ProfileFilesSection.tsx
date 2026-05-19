"use client";

import { useCallback, useEffect, useState } from "react";
import { Streamdown } from "streamdown";

/**
 * UX-5 viewer + editor for user.md / soul.md / QUILIN.md.
 *
 * Renders three collapsible cards, each fetching its target file via
 * GET `/api/profile-files?which=...` on first expansion. Streamdown
 * handles bilingual markdown including code fences.
 *
 * Editing is now gated through a local approval step before PATCHing
 * `/api/profile-files`, because profile-file writes are CRITICAL
 * operations per `docs/07-safety-guardrails/README.md`.
 *
 * UX-5 viewer/editor:三张可折叠卡片,展开时按需 fetch 文件内容,Streamdown
 * 渲染。编辑保存前会弹出 approval gate,再 PATCH 回服务端。
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

interface ProfileFileSaveOk {
	readonly ok: true;
	readonly data: ProfileFile;
}

interface ProfileFileSaveError {
	readonly ok?: false;
	readonly error?: string;
	readonly code?: string;
}

/**
 * Split a markdown file into its YAML frontmatter section + the body
 * markdown. Supports both standard `---\n<yaml>\n---\n<body>` and the
 * variant where the body uses `---` as setext-heading underlines (which
 * Streamdown would otherwise render as a giant H1).
 *
 * Returns frontmatter as flat key/value pairs (rough heuristic — handles
 * the schema actually used in our profile files: scalar string/number
 * and short list of strings). For richer YAML we'd switch to a real
 * parser later.
 *
 * 拆分 markdown 的 YAML frontmatter 和正文。Streamdown 把 `---\n`
 * 误认为 setext H1 下划线 → 上一行被渲染成超大标题。这里识别两种
 * frontmatter 形态(标准 `---\n...\n---\n` 与裸 yaml + `---`)并把
 * frontmatter 抽出来用 KV 表格单独渲染,正文继续走 Streamdown。
 */
interface ParsedFrontmatter {
	readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
	readonly body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
	const lines = content.split(/\r?\n/);
	let yamlStart = 0;
	let yamlEnd = -1;

	// Case A: standard `---` fence at top.
	if (lines[0]?.trim() === "---") {
		yamlStart = 1;
		for (let i = 1; i < lines.length; i += 1) {
			if (lines[i]?.trim() === "---") {
				yamlEnd = i;
				break;
			}
		}
	} else {
		// Case B: bare YAML at top, closed by `---` line, then body.
		for (let i = 0; i < lines.length; i += 1) {
			const ln = lines[i] ?? "";
			if (ln.trim() === "---") {
				yamlEnd = i;
				break;
			}
			// First non-yaml-looking line aborts — treat whole file as body.
			if (ln.length > 0 && !/^\s*([a-zA-Z_][\w-]*):\s*/.test(ln) && !/^\s*-\s+/.test(ln)) {
				break;
			}
		}
	}

	if (yamlEnd < 0 || yamlEnd <= yamlStart) {
		return { entries: [], body: content };
	}

	const yamlLines = lines.slice(yamlStart, yamlEnd);
	const body = lines
		.slice(yamlEnd + 1)
		.join("\n")
		.replace(/^\n+/, "");

	const entries: Array<{ key: string; value: string }> = [];
	let currentKey: string | null = null;
	let currentList: string[] = [];
	const flushList = () => {
		if (currentKey != null && currentList.length > 0) {
			entries.push({ key: currentKey, value: currentList.join(", ") });
		}
		currentKey = null;
		currentList = [];
	};
	for (const raw of yamlLines) {
		const ln = raw.trim();
		if (ln.length === 0) continue;
		const listMatch = ln.match(/^-\s+(.+)$/);
		if (listMatch != null && currentKey != null) {
			const listItem = listMatch[1] ?? "";
			currentList.push(listItem.replace(/^["']|["']$/g, ""));
			continue;
		}
		flushList();
		const kvMatch = raw.match(/^\s*([a-zA-Z_][\w-]*):\s*(.*)$/);
		if (kvMatch == null) continue;
		const key = kvMatch[1] ?? "";
		const valuePart = kvMatch[2] ?? "";
		if (key.length === 0) continue;
		const trimmed = valuePart.trim();
		if (trimmed.length === 0) {
			// May be start of a multiline list — defer.
			currentKey = key;
			currentList = [];
			continue;
		}
		entries.push({
			key,
			value: trimmed.replace(/^["']|["']$/g, ""),
		});
	}
	flushList();
	return { entries, body };
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
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [approvalOpen, setApprovalOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveNotice, setSaveNotice] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);

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
			setDraft(body.content ?? "");
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

	const beginEdit = useCallback(() => {
		setDraft(data?.content ?? "");
		setEditing(true);
		setApprovalOpen(false);
		setSaveNotice(null);
		setSaveError(null);
	}, [data]);

	const cancelEdit = useCallback(() => {
		setDraft(data?.content ?? "");
		setEditing(false);
		setApprovalOpen(false);
		setSaveError(null);
	}, [data]);

	const saveFile = useCallback(async () => {
		if (data == null) return;
		setSaving(true);
		setSaveError(null);
		setSaveNotice(null);
		try {
			const res = await fetch("/api/profile-files", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					which,
					content: draft,
					baseModifiedAt: data.modifiedAt,
					confirmed: true,
				}),
			});
			const body = (await res.json().catch(() => ({}))) as ProfileFileSaveOk | ProfileFileSaveError;
			if (!res.ok || body.ok !== true) {
				const msg =
					"error" in body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
				throw new Error(msg);
			}
			setData(body.data);
			setDraft(body.data.content ?? "");
			setEditing(false);
			setApprovalOpen(false);
			setSaveNotice("已保存 · WriteAuthority 已批准并写入磁盘");
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [which, draft, data]);

	const dirty = data != null && draft !== (data.content ?? "");

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
					) : data != null ? (
						<>
							<div
								style={{
									display: "flex",
									gap: 8,
									flexWrap: "wrap",
									alignItems: "center",
									marginTop: 12,
									marginBottom: 12,
								}}
							>
								<span
									style={{
										flex: "1 1 220px",
										minWidth: 0,
										color: "var(--fg-muted)",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 10,
										overflowWrap: "anywhere",
									}}
								>
									{data.exists ? data.path : `将创建 · ${data.path}`}
								</span>
								{editing ? (
									<>
										<button
											type="button"
											onClick={cancelEdit}
											disabled={saving}
											style={{
												padding: "6px 10px",
												border: "1px solid var(--border)",
												background: "transparent",
												color: "var(--fg-muted)",
												cursor: saving ? "not-allowed" : "pointer",
											}}
										>
											取消
										</button>
										<button
											type="button"
											onClick={() => setApprovalOpen(true)}
											disabled={!dirty || saving}
											data-testid={`profile-save-${which}`}
											style={{
												padding: "6px 10px",
												border: "1px solid var(--accent-vermillion)",
												background: dirty ? "var(--accent-vermillion)" : "transparent",
												color: dirty ? "var(--bg)" : "var(--fg-muted)",
												cursor: dirty && !saving ? "pointer" : "not-allowed",
											}}
										>
											保存
										</button>
									</>
								) : (
									<button
										type="button"
										onClick={beginEdit}
										data-testid={`profile-edit-${which}`}
										style={{
											padding: "6px 10px",
											border: "1px solid var(--accent-vermillion)",
											background: "transparent",
											color: "var(--accent-vermillion)",
											cursor: "pointer",
										}}
									>
										编辑
									</button>
								)}
							</div>
							{saveNotice != null ? (
								<p style={{ color: "var(--accent-vermillion)", marginTop: 0 }}>{saveNotice}</p>
							) : null}
							{saveError != null ? (
								<p style={{ color: "var(--destructive)", marginTop: 0 }}>保存失败:{saveError}</p>
							) : null}
							{editing ? (
								<>
									<textarea
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										data-testid={`profile-editor-${which}`}
										style={{
											width: "100%",
											minHeight: 280,
											resize: "vertical",
											padding: 12,
											border: "1px solid var(--border)",
											borderRadius: 4,
											background: "var(--bg)",
											color: "var(--fg)",
											fontFamily: '"JetBrains Mono", monospace',
											fontSize: 12,
											lineHeight: 1.7,
										}}
									/>
									{approvalOpen ? (
										<div
											data-testid={`profile-approval-${which}`}
											style={{
												marginTop: 10,
												padding: 12,
												border: "1px solid var(--destructive)",
												borderLeft: "3px solid var(--destructive)",
												borderRadius: 4,
												background: "var(--bg-soft)",
											}}
										>
											<div
												style={{
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													color: "var(--fg)",
													marginBottom: 8,
												}}
											>
												WriteAuthority(写入授权中心)需要确认 CRITICAL 写入: {data.path}
											</div>
											<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
												<button
													type="button"
													onClick={() => void saveFile()}
													disabled={saving}
													data-testid={`profile-approve-${which}`}
													style={{
														padding: "6px 12px",
														border: "none",
														background: "var(--accent-vermillion)",
														color: "var(--bg)",
														cursor: saving ? "not-allowed" : "pointer",
													}}
												>
													{saving ? "写入中" : "批准并写入"}
												</button>
												<button
													type="button"
													onClick={() => setApprovalOpen(false)}
													disabled={saving}
													style={{
														padding: "6px 12px",
														border: "1px solid var(--border)",
														background: "transparent",
														color: "var(--fg-muted)",
														cursor: saving ? "not-allowed" : "pointer",
													}}
												>
													返回编辑
												</button>
											</div>
										</div>
									) : null}
								</>
							) : data.exists === false ? (
								<p style={{ color: "var(--fg-muted)", marginTop: 12 }}>
									文件不存在 · 点击编辑可创建
								</p>
							) : data.content != null ? (
								(() => {
									const { entries, body } = parseFrontmatter(data.content);
									return (
										<div
											className="q-streamdown"
											data-testid={`profile-content-${which}`}
											style={{ marginTop: 12 }}
										>
											{entries.length > 0 ? (
												<div
													style={{
														marginBottom: 14,
														padding: "8px 12px",
														borderLeft: "2px solid var(--accent-vermillion)",
														background: "var(--bg)",
														borderRadius: 4,
													}}
												>
													<div
														style={{
															fontFamily: '"JetBrains Mono", monospace',
															fontSize: 10,
															color: "var(--fg-muted)",
															letterSpacing: "0.05em",
															marginBottom: 6,
															textTransform: "uppercase",
														}}
													>
														schema · frontmatter
													</div>
													<table
														style={{
															borderCollapse: "collapse",
															width: "100%",
															fontSize: 12,
														}}
													>
														<tbody>
															{entries.map((e) => (
																<tr key={e.key}>
																	<td
																		style={{
																			padding: "2px 12px 2px 0",
																			color: "var(--fg-muted)",
																			fontFamily: '"JetBrains Mono", monospace',
																			verticalAlign: "top",
																			whiteSpace: "nowrap",
																		}}
																	>
																		{e.key}
																	</td>
																	<td
																		style={{
																			padding: "2px 0",
																			fontFamily: '"Noto Sans SC", sans-serif',
																			color: "var(--fg)",
																			wordBreak: "break-word",
																		}}
																	>
																		{e.value || (
																			<span style={{ color: "var(--fg-subtle)" }}>—</span>
																		)}
																	</td>
																</tr>
															))}
														</tbody>
													</table>
												</div>
											) : null}
											{body.length > 0 ? (
												<Streamdown>{body}</Streamdown>
											) : entries.length === 0 ? (
												// Neither frontmatter nor body — show raw to be helpful.
												<Streamdown>{data.content}</Streamdown>
											) : (
												<p style={{ color: "var(--fg-subtle)", fontSize: 12, fontStyle: "italic" }}>
													frontmatter 之外暂无正文 · no body content yet
												</p>
											)}
										</div>
									);
								})()
							) : null}
						</>
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
				可查看并编辑三份 profile 文件;保存前由 WriteAuthority(写入授权中心)确认 CRITICAL 写入
			</p>
			{FILES.map((f) => (
				<ProfileFileCard key={f.which} {...f} />
			))}
		</div>
	);
}
