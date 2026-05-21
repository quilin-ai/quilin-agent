"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ConsolidationTimelineView } from "@/components/memory/ConsolidationTimelineView";
import { EvidenceGraphView } from "@/components/memory/EvidenceGraphView";
import { KnowledgeGraphView } from "@/components/memory/KnowledgeGraphView";
import { AppHeader } from "@/components/shell/AppHeader";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";

interface MemoryRecord {
	readonly id: string;
	readonly content: string;
	readonly tier: string;
	readonly layer: string | null;
	readonly createdAt: string | null;
	readonly metadata: Record<string, unknown> | null;
	// v2 字段(QUI-193/196/197 ship)— 详情面板渲染
	readonly version?: number | null;
	readonly parentId?: string | null;
	readonly isLatest?: boolean | null;
	readonly supersedesJson?: Record<string, unknown> | readonly unknown[] | string | null;
	readonly lastWriterClient?: string | null;
	readonly lastWriterSessionId?: string | null;
	readonly projectScope?: string | null;
	readonly salience?: Record<string, unknown> | null;
	readonly kind?: string | null;
	readonly importanceScore?: number | null;
	readonly archivedAt?: string | null;
	readonly recoveredAt?: string | null;
}

interface MemoryResponse {
	readonly ok: true;
	readonly data: {
		readonly available: boolean;
		readonly reason?: string;
		readonly records: readonly MemoryRecord[];
		readonly byTier: Record<string, readonly MemoryRecord[]>;
		readonly counts: Record<string, number>;
		readonly rawSamplePreview?: string;
	};
}

interface MemoryError {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

const TIER_ORDER: readonly string[] = ["working", "episodic", "semantic", "skill"];

const TIER_LABELS: Record<string, { readonly cn: string; readonly en: string }> = {
	working: { cn: "工作", en: "working" },
	episodic: { cn: "情景", en: "episodic" },
	semantic: { cn: "语义", en: "semantic" },
	skill: { cn: "技能", en: "skill" },
};

/**
 * 每个 tier 的概念说明,作为 info icon tooltip 显示。
 * User 要求:让用户直观看到 4 层负责的部分和概念。
 */
const TIER_DESCRIPTIONS: Record<string, string> = {
	working:
		"工作层 / Working Memory\n刚刚发生的临时记忆,LLM 在对话当下直接用。容量小、易失,几分钟到几天后被 Reflector 升级到情景层或清理掉。\n\n类比:你脑子里『我刚才说了啥』的短期缓存。",
	episodic:
		"情景层 / Episodic Memory\n具体时间地点发生过的事件片段。Reflector 从工作层自动升级(比如对话超过 N 轮 + 信息量足够)。容量中等、半永久。\n\n类比:你能回忆『上周三跟谁吃了什么饭』的具体经历。",
	semantic:
		"语义层 / Semantic Memory\n反思后稳定下来的事实和概念,不绑时间。Consolidator 从情景层抽取共性(比如多次见面提到的偏好)。容量大、永久。\n\n类比:你知道『我喜欢用 Vim 编辑器』这种抽象事实,不需要记得哪天告诉过别人。",
	skill:
		"技能层 / Skill Memory\n可复用的流程和工作方法。Consolidator 从重复成功任务提取(QUI-198 trajectory_compressor),或者灵魂导入时填充(QUI-81)。\n\n类比:你的『骑车 / 编程 / 烹饪』这种程序性记忆 —— 不是事实,是怎么做的步骤。",
};

function formatTimestamp(iso: string | null): string {
	if (iso == null) return "—";
	try {
		const d = new Date(iso);
		return d.toLocaleString("zh-CN", { hour12: false });
	} catch {
		return iso;
	}
}

/**
 * QUI-187(2026-05-20):升级到 Consolidator 三类提案 wire。
 *
 * Three kinds of proposals returned by `memory_consolidate_plan`:
 *   - dedupe          → 同 QUI-185,去重(keep + delete)
 *   - kg-prune        → 知识图谱过期关系剪枝(deleteIds = edge ids)
 *   - reflect-insight → reflect 抽取语义 insight(insertContent + memoryIds 来源)
 *
 * Each kind 在 UI 上用不同颜色 / icon 区分,方便用户一眼看清"删什么、留什么、新增什么"。
 */
type ProposalKind = "dedupe" | "kg-prune" | "reflect-insight";
type ConsolidateStrategy = "exact" | "embedding" | "llm";

interface ConsolidateProposal {
	readonly kind: ProposalKind;
	readonly tier: string;
	readonly keepId?: string;
	readonly deleteIds: readonly string[];
	readonly insertContent?: string;
	readonly reason: string;
	readonly strategy?: ConsolidateStrategy;
	readonly score?: number;
	readonly memoryIds: readonly string[];
}

interface ConsolidatePreview {
	readonly proposals: readonly ConsolidateProposal[];
	readonly totalDelete: number;
	readonly totalKeep: number;
	readonly totalInsert: number;
}

interface DedupeResponse {
	readonly ok: true;
	readonly data: {
		readonly executed: boolean;
		readonly plan: ConsolidatePreview;
		readonly totalDelete?: number;
		readonly totalKeep?: number;
		readonly totalInsert?: number;
		readonly deleted?: number;
		readonly failed?: number;
		readonly skippedInsert?: number;
	};
}

interface DedupeErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

type ConflictChoice = "keep_a" | "keep_b" | "merge_manual";

interface ResolveConflictResponse {
	readonly ok: true;
	readonly data: {
		readonly memoryId: string;
		readonly choice: ConflictChoice;
		readonly resolved: boolean;
		readonly toolName?: string;
	};
}

interface ResolveConflictErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

interface ConflictVersion {
	readonly label: string;
	readonly content: string;
}

interface ConflictDraft {
	readonly memoryId: string;
	readonly conflictToken: string | null;
	readonly baseContent: string | null;
	readonly versionA: ConflictVersion;
	readonly versionB: ConflictVersion;
	readonly mergeSeed: string;
}

interface BatchDeleteResponse {
	readonly ok: true;
	readonly data: {
		readonly requested: number;
		readonly deleted: number;
		readonly failed: number;
	};
}

interface BatchDeleteErrorResponse {
	readonly ok: false;
	readonly error: { readonly code: string; readonly message: string };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function pickStringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function pickNonEmptyStringValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function pickContentFromUnknown(value: unknown): string | null {
	const direct = pickStringValue(value);
	if (direct != null) return direct;
	if (!isPlainObject(value)) return null;
	for (const key of [
		"content",
		"text",
		"body",
		"value",
		"current_content",
		"candidate_content",
		"merged_content",
	]) {
		const found = pickStringValue(value[key]);
		if (found != null) return found;
	}
	return null;
}

function pickLabelFromUnknown(value: unknown): string | null {
	if (!isPlainObject(value)) return null;
	for (const key of ["label", "client_id", "client", "writer", "source", "role"]) {
		const found = pickNonEmptyStringValue(value[key]);
		if (found != null) return found;
	}
	return null;
}

function pickObject(value: unknown): Record<string, unknown> | null {
	return isPlainObject(value) ? value : null;
}

function pickArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function hasPendingConflict(record: MemoryRecord): boolean {
	return record.metadata?.conflict_resolution_pending === true;
}

function extractConflictDraft(record: MemoryRecord): ConflictDraft {
	const metadata = record.metadata ?? {};
	const conflict = pickObject(metadata.conflict);
	const writes =
		pickArray(metadata.writes).length > 0
			? pickArray(metadata.writes)
			: pickArray(conflict?.writes);
	const writeA = writes[0] ?? null;
	const writeB = writes[1] ?? null;

	const baseSource =
		conflict?.base ??
		conflict?.base_record ??
		conflict?.baseRecord ??
		metadata.base ??
		metadata.base_record ??
		metadata.baseRecord ??
		null;
	const sourceA =
		conflict?.current ??
		conflict?.a ??
		conflict?.left ??
		metadata.current ??
		metadata.current_record ??
		metadata.currentRecord ??
		metadata.conflict_current ??
		writeA;
	const sourceB =
		conflict?.candidate ??
		conflict?.b ??
		conflict?.right ??
		metadata.candidate ??
		metadata.candidate_record ??
		metadata.candidateRecord ??
		metadata.conflict_candidate ??
		writeB;

	const versionAContent =
		pickContentFromUnknown(sourceA) ??
		pickContentFromUnknown(metadata.current_content) ??
		pickContentFromUnknown(metadata.conflict_current_content) ??
		pickContentFromUnknown(writeA) ??
		record.content;
	const versionBContent =
		pickContentFromUnknown(sourceB) ??
		pickContentFromUnknown(metadata.candidate_content) ??
		pickContentFromUnknown(metadata.conflict_candidate_content) ??
		pickContentFromUnknown(writeB) ??
		record.content;
	const baseContent =
		pickContentFromUnknown(baseSource) ??
		pickContentFromUnknown(metadata.base_content) ??
		pickContentFromUnknown(metadata.conflict_base_content);

	return {
		memoryId: record.id,
		conflictToken:
			typeof metadata.conflict_token === "string"
				? metadata.conflict_token
				: typeof metadata.conflictToken === "string"
					? metadata.conflictToken
					: null,
		baseContent,
		versionA: {
			label: pickLabelFromUnknown(sourceA) ?? "A · current",
			content: versionAContent,
		},
		versionB: {
			label: pickLabelFromUnknown(sourceB) ?? "B · candidate",
			content: versionBContent,
		},
		mergeSeed:
			versionAContent === versionBContent
				? versionAContent
				: `${versionAContent}\n\n${versionBContent}`,
	};
}

export default function MemoryPage() {
	const [memory, setMemory] = useState<MemoryResponse["data"] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("");
	const [tierFilter, setTierFilter] = useState<string>("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [view, setView] = useState<"list" | "graph" | "timeline" | "evidence">("list");
	// Selection lives outside the records loop so it survives re-renders;
	// using a Set gives us O(1) membership checks for the checkbox state.
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [actionMessage, setActionMessage] = useState<string | null>(null);
	const [dedupePreview, setDedupePreview] = useState<ConsolidatePreview | null>(null);
	const [conflictRecord, setConflictRecord] = useState<MemoryRecord | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const loadMemory = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/memory", { cache: "no-store" });
			const json = (await res.json()) as MemoryResponse | MemoryError;
			if (!json.ok) {
				setError(json.error.message);
				setMemory(null);
			} else {
				setMemory(json.data);
				// Drop any stale selections that referred to records that
				// no longer exist after the reload.
				setSelectedIds((prev) => {
					if (prev.size === 0) return prev;
					const idSet = new Set(json.data.records.map((r) => r.id));
					const next = new Set<string>();
					for (const id of prev) if (idSet.has(id)) next.add(id);
					return next;
				});
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadMemory();
	}, [loadMemory]);

	const visibleTiers = useMemo(() => {
		if (memory == null) return [];
		// QUI dogfood fix(2026-05-21):始终显示 4 层(working/episodic/semantic/skill),
		// 即使某层 0 记录也要 listed —— 让 user 直观看到 4 层架构。空层显示 "暂无"。
		const dbKeys = new Set(Object.keys(memory.byTier));
		const merged = new Set<string>([...TIER_ORDER, ...dbKeys]);
		return Array.from(merged).sort((a, b) => {
			const ia = TIER_ORDER.indexOf(a);
			const ib = TIER_ORDER.indexOf(b);
			if (ia === -1 && ib === -1) return a.localeCompare(b);
			if (ia === -1) return 1;
			if (ib === -1) return -1;
			return ia - ib;
		});
	}, [memory]);

	const visibleRecords = useMemo(() => {
		if (memory == null) return new Map<string, MemoryRecord[]>();
		const needle = filter.trim().toLowerCase();
		const out = new Map<string, MemoryRecord[]>();
		for (const tier of visibleTiers) {
			if (tierFilter !== "all" && tier !== tierFilter) continue;
			const all = memory.byTier[tier] ?? [];
			const filtered =
				needle.length === 0
					? [...all]
					: all.filter((r) => r.content.toLowerCase().includes(needle));
			// 关键:即使 filtered 为空也加入 map,让空层显示 "暂无" 而不是消失。
			// 但有过滤词时(needle.length > 0)空层就不显示,避免噪音。
			if (filtered.length > 0 || (needle.length === 0 && TIER_ORDER.includes(tier))) {
				out.set(tier, filtered);
			}
		}
		return out;
	}, [memory, visibleTiers, filter, tierFilter]);

	const visibleIds = useMemo(() => {
		const ids: string[] = [];
		for (const records of visibleRecords.values()) {
			for (const r of records) ids.push(r.id);
		}
		return ids;
	}, [visibleRecords]);

	const allVisibleSelected = useMemo(() => {
		if (visibleIds.length === 0) return false;
		return visibleIds.every((id) => selectedIds.has(id));
	}, [visibleIds, selectedIds]);

	const toggleSelection = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	const selectAllVisible = useCallback(() => {
		setSelectedIds((prev) => {
			// If everything visible is already selected, clear them; otherwise
			// extend the selection to include every visible id.
			if (visibleIds.length === 0) return prev;
			const allSelected = visibleIds.every((id) => prev.has(id));
			if (allSelected) {
				const next = new Set(prev);
				for (const id of visibleIds) next.delete(id);
				return next;
			}
			const next = new Set(prev);
			for (const id of visibleIds) next.add(id);
			return next;
		});
	}, [visibleIds]);

	const handleBatchDelete = useCallback(async () => {
		if (selectedIds.size === 0) return;
		setPendingAction("delete");
		setActionMessage(null);
		try {
			const ids = Array.from(selectedIds);
			const res = await fetch(`/api/memory?ids=${encodeURIComponent(ids.join(","))}`, {
				method: "DELETE",
				cache: "no-store",
			});
			const json = (await res.json()) as BatchDeleteResponse | BatchDeleteErrorResponse;
			if (!json.ok) {
				setActionMessage(`删除失败 · ${json.error.message}`);
			} else {
				setActionMessage(
					`已删除 ${json.data.deleted} 条${json.data.failed > 0 ? ` · 失败 ${json.data.failed} 条` : ""}`,
				);
				setSelectedIds(new Set());
				setConfirmDelete(false);
				await loadMemory();
			}
		} catch (e) {
			setActionMessage(`删除失败 · ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setPendingAction(null);
		}
	}, [selectedIds, loadMemory]);

	const handleDedupePreview = useCallback(async () => {
		setPendingAction("dedupe-preview");
		setActionMessage(null);
		try {
			const res = await fetch("/api/memory/dedupe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ execute: false }),
				cache: "no-store",
			});
			const json = (await res.json()) as DedupeResponse | DedupeErrorResponse;
			if (!json.ok) {
				setActionMessage(`智能整理预览失败 · ${json.error.message}`);
				setDedupePreview(null);
			} else {
				setDedupePreview(json.data.plan);
			}
		} catch (e) {
			setActionMessage(`智能整理预览失败 · ${e instanceof Error ? e.message : String(e)}`);
			setDedupePreview(null);
		} finally {
			setPendingAction(null);
		}
	}, []);

	const handleDedupeExecute = useCallback(async () => {
		setPendingAction("dedupe-execute");
		setActionMessage(null);
		try {
			const res = await fetch("/api/memory/dedupe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ execute: true }),
				cache: "no-store",
			});
			const json = (await res.json()) as DedupeResponse | DedupeErrorResponse;
			if (!json.ok) {
				setActionMessage(`智能整理失败 · ${json.error.message}`);
			} else {
				// reflect-insight 类 proposal 的 insertContent 暂时跳过(后端 memory_insert
				// MCP tool 还没接入,留 follow-up issue),消息里显式告知用户。
				const skipped = json.data.skippedInsert ?? 0;
				const parts = [`已删除 ${json.data.deleted ?? 0} 条`];
				if ((json.data.failed ?? 0) > 0) parts.push(`失败 ${json.data.failed} 条`);
				if (skipped > 0) parts.push(`新增 insight ${skipped} 条已跳过(后端待接入)`);
				setActionMessage(`智能整理完成 · ${parts.join(" · ")}`);
				setDedupePreview(null);
				setSelectedIds(new Set());
				await loadMemory();
			}
		} catch (e) {
			setActionMessage(`智能整理失败 · ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setPendingAction(null);
		}
	}, [loadMemory]);

	const handleResolveConflict = useCallback(
		async (record: MemoryRecord, choice: ConflictChoice, mergedContent?: string) => {
			setPendingAction("resolve-conflict");
			setActionMessage(null);
			try {
				const body: {
					memoryId: string;
					choice: ConflictChoice;
					mergedContent?: string;
					conflictToken?: string;
				} = {
					memoryId: record.id,
					choice,
				};
				if (mergedContent != null) body.mergedContent = mergedContent;
				const token = extractConflictDraft(record).conflictToken;
				if (token != null) body.conflictToken = token;
				const res = await fetch("/api/memory/resolve-conflict", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					cache: "no-store",
				});
				const json = (await res.json()) as ResolveConflictResponse | ResolveConflictErrorResponse;
				if (!json.ok) {
					setActionMessage(`冲突处理失败 · ${json.error.message}`);
				} else {
					setActionMessage(`冲突已处理 · ${json.data.choice}`);
					setConflictRecord(null);
					await loadMemory();
				}
			} catch (e) {
				setActionMessage(`冲突处理失败 · ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				setPendingAction(null);
			}
		},
		[loadMemory],
	);

	return (
		<>
			<Wordmark />
			<AppHeader />
			<RailStrip />
			<main className="q-workspace no-composer">
				<section className="q-view" data-testid="memory-view">
					<div className="q-page-head">
						<h1 className="q-page-title">
							Memory<span className="cjk">记忆</span>
						</h1>
						<p className="q-page-subtitle">
							通过 quilin-mem MCP 拉取的全部记忆 · 按层级分组(工作 / 情景 / 语义 / 技能)
						</p>
						<div className="q-page-stats">
							{memory == null ? null : memory.available ? (
								<>
									<span>
										<strong>{memory.counts.total ?? 0}</strong>条记忆
									</span>
									{visibleTiers.map((tier) => (
										<span key={tier}>
											<strong>{memory.counts[tier] ?? 0}</strong>
											{TIER_LABELS[tier]?.cn ?? tier}
										</span>
									))}
								</>
							) : (
								<span style={{ color: "var(--fg-muted)" }}>quilin-mem 未连接</span>
							)}
							<button
								type="button"
								onClick={() => void loadMemory()}
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

						<div
							style={{
								display: "flex",
								gap: 4,
								marginTop: 12,
								borderBottom: "1px solid var(--border)",
							}}
							role="tablist"
							aria-label="Memory view"
						>
							<button
								type="button"
								role="tab"
								aria-selected={view === "list"}
								data-testid="memory-tab-list"
								onClick={() => setView("list")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "list"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "list" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								列表 · list
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={view === "graph"}
								data-testid="memory-tab-graph"
								onClick={() => setView("graph")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "graph"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "graph" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								知识图谱 · graph
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={view === "timeline"}
								data-testid="memory-tab-timeline"
								onClick={() => setView("timeline")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "timeline"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "timeline" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								整合时间线 · timeline
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={view === "evidence"}
								data-testid="memory-tab-evidence"
								onClick={() => setView("evidence")}
								style={{
									padding: "8px 16px",
									background: "transparent",
									border: "none",
									borderBottom:
										view === "evidence"
											? "2px solid var(--accent-vermillion)"
											: "2px solid transparent",
									color: view === "evidence" ? "var(--fg)" : "var(--fg-muted)",
									cursor: "pointer",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 13,
								}}
							>
								证据图 · evidence
							</button>
						</div>
					</div>

					{view === "graph" ? (
						<div style={{ marginTop: 20 }}>
							<KnowledgeGraphView />
						</div>
					) : view === "timeline" ? (
						<div style={{ marginTop: 20 }}>
							<ConsolidationTimelineView />
						</div>
					) : view === "evidence" ? (
						<div style={{ marginTop: 20 }}>
							<EvidenceGraphView memoryId={expandedId} />
						</div>
					) : loading && memory == null ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>加载中 · loading…</p>
					) : error != null ? (
						<p style={{ color: "var(--accent-vermillion)", marginTop: 24 }}>加载失败 · {error}</p>
					) : memory == null ? null : !memory.available ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>{memory.reason}</p>
					) : memory.records.length === 0 ? (
						<p style={{ color: "var(--fg-muted)", marginTop: 24 }}>
							还没有任何记忆条目 · agent 写入后会显示在这里
						</p>
					) : (
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
									placeholder="筛选 · filter by content…"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									data-testid="memory-filter"
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
								<button
									type="button"
									onClick={() => setTierFilter("all")}
									style={{
										padding: "5px 10px",
										border: `1px solid ${tierFilter === "all" ? "var(--accent-vermillion)" : "var(--border)"}`,
										color: tierFilter === "all" ? "var(--accent-vermillion)" : "var(--fg-muted)",
										background: "transparent",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 11,
										cursor: "pointer",
									}}
								>
									全部
									<span style={{ marginLeft: 6, opacity: 0.6 }}>{memory.counts.total ?? 0}</span>
								</button>
								{visibleTiers.map((tier) => {
									const active = tierFilter === tier;
									return (
										<button
											key={tier}
											type="button"
											onClick={() => setTierFilter(tier)}
											style={{
												padding: "5px 10px",
												border: `1px solid ${active ? "var(--accent-vermillion)" : "var(--border)"}`,
												color: active ? "var(--accent-vermillion)" : "var(--fg-muted)",
												background: "transparent",
												fontFamily: '"JetBrains Mono", monospace',
												fontSize: 11,
												cursor: "pointer",
											}}
										>
											{TIER_LABELS[tier]?.cn ?? tier}
											<span style={{ marginLeft: 6, opacity: 0.6 }}>
												{memory.counts[tier] ?? 0}
											</span>
										</button>
									);
								})}
							</div>

							{/* Sticky action bar — shows up the moment the user picks
								anything, so they don't have to hunt for a button after
								selecting. Keeps the affordance discoverable without
								eating header space when nothing's selected. */}
							{selectedIds.size > 0 ? (
								<div
									data-testid="memory-action-bar"
									style={{
										position: "sticky",
										top: 0,
										zIndex: 10,
										background: "var(--bg-elev)",
										border: "1px solid var(--accent-vermillion)",
										padding: "8px 12px",
										marginBottom: 12,
										display: "flex",
										gap: 8,
										alignItems: "center",
										flexWrap: "wrap",
									}}
								>
									<span
										style={{
											fontFamily: '"Noto Sans SC", sans-serif',
											fontSize: 12,
											color: "var(--fg)",
										}}
									>
										已选 <strong data-testid="memory-selected-count">{selectedIds.size}</strong> 条
									</span>
									<button
										type="button"
										onClick={() => setConfirmDelete(true)}
										disabled={pendingAction != null}
										data-testid="memory-batch-delete"
										style={{
											padding: "5px 10px",
											border: "1px solid var(--accent-vermillion)",
											background: "var(--accent-vermillion)",
											color: "var(--bg)",
											fontFamily: '"Noto Sans SC", sans-serif',
											fontSize: 11,
											cursor: pendingAction != null ? "not-allowed" : "pointer",
											opacity: pendingAction != null ? 0.6 : 1,
										}}
									>
										删除选中
									</button>
									<button
										type="button"
										onClick={clearSelection}
										disabled={pendingAction != null}
										data-testid="memory-clear-selection"
										style={{
											padding: "5px 10px",
											border: "1px solid var(--border)",
											background: "transparent",
											color: "var(--fg-muted)",
											fontFamily: '"Noto Sans SC", sans-serif',
											fontSize: 11,
											cursor: pendingAction != null ? "not-allowed" : "pointer",
										}}
									>
										取消选中
									</button>
								</div>
							) : null}

							{/* Selection / dedupe toolbar lives below the filter row so
								it's always discoverable, not just after selection. */}
							<div
								style={{
									display: "flex",
									gap: 8,
									alignItems: "center",
									marginBottom: 12,
									flexWrap: "wrap",
								}}
							>
								<label
									style={{
										display: "inline-flex",
										gap: 6,
										alignItems: "center",
										fontFamily: '"JetBrains Mono", monospace',
										fontSize: 11,
										color: "var(--fg-muted)",
										cursor: visibleIds.length === 0 ? "not-allowed" : "pointer",
									}}
								>
									<input
										type="checkbox"
										checked={allVisibleSelected}
										onChange={selectAllVisible}
										disabled={visibleIds.length === 0 || pendingAction != null}
										data-testid="memory-select-all"
									/>
									全选当前
								</label>
								<button
									type="button"
									onClick={() => void handleDedupePreview()}
									disabled={pendingAction != null || memory == null}
									data-testid="memory-dedupe-button"
									style={{
										padding: "5px 10px",
										border: "1px solid var(--accent-vermillion)",
										background: "transparent",
										color: "var(--accent-vermillion)",
										fontFamily: '"Noto Sans SC", sans-serif',
										fontSize: 11,
										cursor: pendingAction != null ? "not-allowed" : "pointer",
										opacity: pendingAction != null ? 0.6 : 1,
									}}
								>
									✨ 智能整理
								</button>
								{actionMessage != null ? (
									<span
										data-testid="memory-action-message"
										style={{
											fontFamily: '"JetBrains Mono", monospace',
											fontSize: 11,
											color: "var(--fg-muted)",
										}}
									>
										{actionMessage}
									</span>
								) : null}
							</div>

							{visibleRecords.size === 0 ? (
								<p style={{ color: "var(--fg-muted)", marginTop: 16 }}>
									没有匹配的记忆 · no matches
								</p>
							) : (
								Array.from(visibleRecords.entries()).map(([tier, records]) => (
									<div key={tier} style={{ marginBottom: 18 }}>
										<div className="q-section-title">
											<span className="cn">
												{TIER_LABELS[tier]?.cn ?? tier} · {TIER_LABELS[tier]?.en ?? tier}
												{TIER_DESCRIPTIONS[tier] != null ? (
													<TierInfoIcon tier={tier} description={TIER_DESCRIPTIONS[tier]} />
												) : null}
											</span>
											<span className="right">{records.length} 条</span>
										</div>
										{records.length === 0 ? (
											<div
												data-testid={`memory-tier-empty-${tier}`}
												style={{
													padding: "12px 10px",
													color: "var(--fg-muted)",
													fontStyle: "italic",
													fontSize: 12,
													borderBottom: "1px dashed var(--border)",
												}}
											>
												暂无{TIER_LABELS[tier]?.cn ?? tier}层记忆。
												{tier === "skill"
													? "技能层用于沉淀可复用流程,Consolidator 升级或灵魂导入会写入。"
													: tier === "semantic"
														? "语义层是反思后稳定下来的事实,LLM 会在合适时机升级写入。"
														: tier === "episodic"
															? "情景层是具体对话片段,Reflector 自动从工作层升级。"
															: ""}
											</div>
										) : null}
										{records.map((record) => {
											const expanded = expandedId === record.id;
											const contentToShow =
												!expanded && record.content.length > 220
													? `${record.content.slice(0, 220)}…`
													: record.content;
											const checked = selectedIds.has(record.id);
											return (
												<div
													key={record.id}
													data-testid={`memory-${record.id}`}
													className="q-resource-row"
													style={{
														background: expanded ? "var(--bg-elev)" : "transparent",
														borderBottom: "1px solid var(--border)",
														padding: "10px 12px",
														display: "flex",
														gap: 10,
														alignItems: "flex-start",
													}}
												>
													<input
														type="checkbox"
														checked={checked}
														onChange={(e) => {
															e.stopPropagation();
															toggleSelection(record.id);
														}}
														onClick={(e) => e.stopPropagation()}
														data-testid={`memory-checkbox-${record.id}`}
														aria-label={`选中 ${record.id.slice(0, 8)}`}
														style={{ marginTop: 2, flexShrink: 0 }}
													/>
													<button
														type="button"
														onClick={() => setExpandedId(expanded ? null : record.id)}
														style={{
															flex: 1,
															textAlign: "left",
															background: "transparent",
															border: "none",
															padding: 0,
															cursor: "pointer",
															display: "block",
														}}
														aria-expanded={expanded}
														aria-label={`查看记忆 ${record.id.slice(0, 8)}`}
													>
														<div
															style={{
																whiteSpace: "pre-wrap",
																color: "var(--fg)",
																fontSize: 12,
																lineHeight: 1.6,
															}}
														>
															{contentToShow}
														</div>
														<div
															style={{
																marginTop: 6,
																fontFamily: '"JetBrains Mono", monospace',
																fontSize: 10,
																color: "var(--fg-muted)",
															}}
														>
															{formatTimestamp(record.createdAt)} · id={record.id.slice(0, 8)}
														</div>
														{expanded ? <MemoryDetailPanel record={record} /> : null}
													</button>
													{hasPendingConflict(record) ? (
														<button
															type="button"
															onClick={(e) => {
																e.stopPropagation();
																setConflictRecord(record);
															}}
															disabled={pendingAction != null}
															data-testid={`memory-conflict-open-${record.id}`}
															style={{
																flexShrink: 0,
																marginTop: 2,
																padding: "4px 8px",
																border: "1px solid #cf7e1f",
																background: "rgba(207, 126, 31, 0.08)",
																color: "#cf7e1f",
																fontFamily: '"Noto Sans SC", sans-serif',
																fontSize: 11,
																cursor: pendingAction != null ? "not-allowed" : "pointer",
																opacity: pendingAction != null ? 0.6 : 1,
															}}
														>
															处理冲突
														</button>
													) : null}
												</div>
											);
										})}
									</div>
								))
							)}

							{confirmDelete ? (
								<div
									data-testid="memory-confirm-delete"
									role="dialog"
									aria-modal="true"
									aria-label="确认删除选中记忆"
									style={{
										position: "fixed",
										inset: 0,
										background: "rgba(0,0,0,0.5)",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										zIndex: 100,
									}}
								>
									<div
										style={{
											background: "var(--bg)",
											border: "1px solid var(--accent-vermillion)",
											padding: "20px 24px",
											maxWidth: 480,
											minWidth: 320,
										}}
									>
										<h2
											style={{
												margin: 0,
												marginBottom: 12,
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 16,
												color: "var(--fg)",
											}}
										>
											确认删除
										</h2>
										<p
											style={{
												color: "var(--fg-muted)",
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 13,
												lineHeight: 1.6,
											}}
										>
											将永久删除 <strong>{selectedIds.size}</strong> 条记忆, 此操作不可撤销。
										</p>
										<div
											style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}
										>
											<button
												type="button"
												onClick={() => setConfirmDelete(false)}
												disabled={pendingAction != null}
												data-testid="memory-confirm-delete-cancel"
												style={{
													padding: "6px 12px",
													border: "1px solid var(--border)",
													background: "transparent",
													color: "var(--fg-muted)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													cursor: "pointer",
												}}
											>
												取消
											</button>
											<button
												type="button"
												onClick={() => void handleBatchDelete()}
												disabled={pendingAction != null}
												data-testid="memory-confirm-delete-confirm"
												style={{
													padding: "6px 12px",
													border: "1px solid var(--accent-vermillion)",
													background: "var(--accent-vermillion)",
													color: "var(--bg)",
													fontFamily: '"Noto Sans SC", sans-serif',
													fontSize: 12,
													cursor: "pointer",
												}}
											>
												{pendingAction === "delete" ? "删除中…" : "确认删除"}
											</button>
										</div>
									</div>
								</div>
							) : null}

							{dedupePreview != null ? (
								<ConsolidatePreviewModal
									preview={dedupePreview}
									pendingAction={pendingAction}
									onCancel={() => setDedupePreview(null)}
									onConfirm={() => void handleDedupeExecute()}
								/>
							) : null}

							{conflictRecord != null ? (
								<ConflictDialog
									key={conflictRecord.id}
									record={conflictRecord}
									pendingAction={pendingAction}
									onCancel={() => setConflictRecord(null)}
									onResolve={(choice, mergedContent) =>
										void handleResolveConflict(conflictRecord, choice, mergedContent)
									}
								/>
							) : null}
						</>
					)}
				</section>
			</main>
		</>
	);
}

/**
 * 三类提案的视觉风格 / Visual palette for the three proposal kinds.
 *
 * 选色逻辑:
 *   - dedupe          → 绿色 🗑  → 减法、清理废品
 *   - kg-prune        → 橙色 ✂   → 剪除过期连接,警示意味
 *   - reflect-insight → 蓝色 ✨   → 加法、新增智慧
 *
 * 颜色直接走 hex(非 token),因为现在还没在 globals.css 里建 success/warning/info
 * 三色 token;QUI-187 follow-up 可以把这套色阶迁到 CSS 变量。
 */
const KIND_STYLES: Record<
	ProposalKind,
	{ readonly icon: string; readonly color: string; readonly label: string }
> = {
	dedupe: { icon: "🗑", color: "#2da44e", label: "去重" },
	"kg-prune": { icon: "✂", color: "#cf7e1f", label: "图谱剪枝" },
	"reflect-insight": { icon: "✨", color: "#3a8dde", label: "语义抽取" },
};

interface ConsolidatePreviewModalProps {
	readonly preview: ConsolidatePreview;
	readonly pendingAction: string | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}

/**
 * 智能整理 preview modal — 渲染 Consolidator 返的三类 proposal。
 *
 * 每个 proposal 用 kind 对应的颜色 + icon 标识,然后展开 reason / strategy /
 * 影响 id 列表。最多展示 20 条,超出折叠提示。Confirm 调 dedupe execute
 * (后端用同一个 plan 删 deleteIds);reflect-insight insert 暂时跳过(后端
 * memory_insert tool 还没接入)。
 */
function ConsolidatePreviewModal({
	preview,
	pendingAction,
	onCancel,
	onConfirm,
}: ConsolidatePreviewModalProps) {
	const hasAnyDelete = preview.totalDelete > 0;
	const visibleProposals = preview.proposals.slice(0, 20);
	const overflow = preview.proposals.length - visibleProposals.length;
	return (
		<div
			data-testid="memory-dedupe-preview"
			role="dialog"
			aria-modal="true"
			aria-label="智能整理预览"
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.5)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 100,
			}}
		>
			<div
				style={{
					background: "var(--bg)",
					border: "1px solid var(--accent-vermillion)",
					padding: "20px 24px",
					maxWidth: 680,
					minWidth: 360,
					maxHeight: "80vh",
					overflowY: "auto",
				}}
			>
				<h2
					style={{
						margin: 0,
						marginBottom: 12,
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 16,
						color: "var(--fg)",
					}}
				>
					✨ 智能整理预览
				</h2>
				<p
					style={{
						color: "var(--fg-muted)",
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 13,
						lineHeight: 1.6,
					}}
				>
					将删除 <strong data-testid="memory-dedupe-delete-count">{preview.totalDelete}</strong> 条
					· 保留 <strong data-testid="memory-dedupe-keep-count">{preview.totalKeep}</strong> 条 ·
					新增 <strong data-testid="memory-dedupe-insert-count">{preview.totalInsert}</strong> 条
					insight
					{preview.totalInsert > 0 ? "(后端 insert 待接入,confirm 后会跳过)" : ""}
				</p>
				{preview.proposals.length === 0 ? (
					<p
						style={{
							color: "var(--fg-muted)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
						}}
					>
						没有发现需要整理的条目。
					</p>
				) : (
					<ul
						data-testid="memory-dedupe-proposals"
						style={{
							listStyle: "none",
							padding: 0,
							margin: "12px 0",
							maxHeight: 360,
							overflowY: "auto",
						}}
					>
						{visibleProposals.map((proposal, idx) => {
							const style = KIND_STYLES[proposal.kind];
							// Compose a stable key — keepId / first deleteId / insert hash fallback.
							const key = proposal.keepId ?? proposal.deleteIds[0] ?? `${proposal.kind}-${idx}`;
							return (
								<li
									key={key}
									data-testid={`memory-dedupe-proposal-${proposal.kind}`}
									style={{
										padding: "8px 0 10px",
										borderBottom: "1px solid var(--border)",
										fontSize: 11,
										color: "var(--fg-muted)",
										fontFamily: '"JetBrains Mono", monospace',
									}}
								>
									<div
										style={{
											display: "flex",
											gap: 8,
											alignItems: "center",
											marginBottom: 4,
										}}
									>
										<span
											style={{
												display: "inline-flex",
												alignItems: "center",
												gap: 4,
												padding: "2px 8px",
												border: `1px solid ${style.color}`,
												color: style.color,
												fontSize: 10,
												fontFamily: '"Noto Sans SC", sans-serif',
												borderRadius: 2,
											}}
										>
											<span aria-hidden="true">{style.icon}</span>
											<span>{style.label}</span>
										</span>
										<span style={{ color: "var(--fg-muted)", fontSize: 10 }}>
											tier={proposal.tier}
											{proposal.strategy != null ? ` · strategy=${proposal.strategy}` : ""}
											{proposal.score != null ? ` · score=${proposal.score.toFixed(2)}` : ""}
										</span>
									</div>
									{proposal.reason.length > 0 ? (
										<div
											style={{
												color: "var(--fg)",
												marginBottom: 4,
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 12,
												lineHeight: 1.5,
											}}
										>
											{proposal.reason}
										</div>
									) : null}
									{proposal.kind === "reflect-insight" && proposal.insertContent != null ? (
										<div
											style={{
												color: style.color,
												padding: "4px 8px",
												border: `1px dashed ${style.color}`,
												marginBottom: 4,
												fontFamily: '"Noto Sans SC", sans-serif',
												fontSize: 11,
												lineHeight: 1.5,
											}}
										>
											新 insight: {proposal.insertContent}
										</div>
									) : null}
									<div>
										{proposal.keepId != null ? (
											<>
												保留{" "}
												<span style={{ color: "var(--fg)" }}>{proposal.keepId.slice(0, 8)}</span>
												{" · "}
											</>
										) : null}
										{proposal.deleteIds.length > 0 ? (
											<>
												{proposal.kind === "kg-prune" ? "剪除边" : "删除"}{" "}
												{proposal.deleteIds.length} 条
											</>
										) : null}
										{proposal.memoryIds.length > 0 ? (
											<>
												{proposal.deleteIds.length > 0 || proposal.keepId != null ? " · " : ""}
												来源 {proposal.memoryIds.length} 条
											</>
										) : null}
									</div>
								</li>
							);
						})}
						{overflow > 0 ? (
							<li
								style={{
									padding: "6px 0",
									fontSize: 11,
									color: "var(--fg-muted)",
								}}
							>
								…还有 {overflow} 条提案未显示
							</li>
						) : null}
					</ul>
				)}
				<div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
					<button
						type="button"
						onClick={onCancel}
						disabled={pendingAction != null}
						data-testid="memory-dedupe-cancel"
						style={{
							padding: "6px 12px",
							border: "1px solid var(--border)",
							background: "transparent",
							color: "var(--fg-muted)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							cursor: "pointer",
						}}
					>
						取消
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={pendingAction != null || !hasAnyDelete}
						data-testid="memory-dedupe-confirm"
						style={{
							padding: "6px 12px",
							border: "1px solid var(--accent-vermillion)",
							background: "var(--accent-vermillion)",
							color: "var(--bg)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							cursor: pendingAction != null || !hasAnyDelete ? "not-allowed" : "pointer",
							opacity: pendingAction != null || !hasAnyDelete ? 0.5 : 1,
						}}
					>
						{pendingAction === "dedupe-execute" ? "整理中…" : "执行整理"}
					</button>
				</div>
			</div>
		</div>
	);
}

interface ConflictDialogProps {
	readonly record: MemoryRecord;
	readonly pendingAction: string | null;
	readonly onCancel: () => void;
	readonly onResolve: (choice: ConflictChoice, mergedContent?: string) => void;
}

function ConflictDialog({
	record,
	pendingAction,
	onCancel,
	onResolve,
}: ConflictDialogProps): React.ReactElement {
	const draft = useMemo(() => extractConflictDraft(record), [record]);
	const [manualMode, setManualMode] = useState(false);
	const [manualContent, setManualContent] = useState(draft.mergeSeed);
	const resolving = pendingAction === "resolve-conflict";
	const manualReady = manualContent.trim().length > 0;
	return (
		<div
			data-testid="memory-conflict-dialog"
			role="dialog"
			aria-modal="true"
			aria-label="处理记忆冲突"
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.5)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 100,
			}}
		>
			<div
				style={{
					background: "var(--bg)",
					border: "1px solid #cf7e1f",
					padding: "20px 24px",
					width: "min(760px, calc(100vw - 32px))",
					maxHeight: "84vh",
					overflowY: "auto",
				}}
			>
				<h2
					style={{
						margin: 0,
						marginBottom: 12,
						fontFamily: '"Noto Sans SC", sans-serif',
						fontSize: 16,
						color: "var(--fg)",
					}}
				>
					处理记忆冲突
				</h2>
				<p
					style={{
						marginTop: 0,
						color: "var(--fg-muted)",
						fontFamily: '"JetBrains Mono", monospace',
						fontSize: 11,
						lineHeight: 1.6,
					}}
				>
					id={draft.memoryId.slice(0, 16)} · 选择 keep_a / keep_b,或手动合并后提交
				</p>

				{draft.baseContent != null ? (
					<div
						data-testid="memory-conflict-base"
						style={{
							marginBottom: 12,
							padding: "8px 10px",
							border: "1px dashed var(--border)",
							color: "var(--fg-muted)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							lineHeight: 1.6,
							whiteSpace: "pre-wrap",
						}}
					>
						<strong style={{ color: "var(--fg)" }}>base</strong>
						<br />
						{draft.baseContent}
					</div>
				) : null}

				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
						gap: 12,
					}}
				>
					<div
						data-testid="memory-conflict-version-a"
						style={{
							border: "1px solid var(--border)",
							padding: "10px 12px",
						}}
					>
						<div
							style={{
								marginBottom: 6,
								color: "var(--fg-muted)",
								fontFamily: '"JetBrains Mono", monospace',
								fontSize: 11,
							}}
						>
							A · {draft.versionA.label}
						</div>
						<div
							style={{
								whiteSpace: "pre-wrap",
								color: "var(--fg)",
								fontFamily: '"Noto Sans SC", sans-serif',
								fontSize: 12,
								lineHeight: 1.6,
							}}
						>
							{draft.versionA.content}
						</div>
					</div>

					<div
						data-testid="memory-conflict-version-b"
						style={{
							border: "1px solid var(--border)",
							padding: "10px 12px",
						}}
					>
						<div
							style={{
								marginBottom: 6,
								color: "var(--fg-muted)",
								fontFamily: '"JetBrains Mono", monospace',
								fontSize: 11,
							}}
						>
							B · {draft.versionB.label}
						</div>
						<div
							style={{
								whiteSpace: "pre-wrap",
								color: "var(--fg)",
								fontFamily: '"Noto Sans SC", sans-serif',
								fontSize: 12,
								lineHeight: 1.6,
							}}
						>
							{draft.versionB.content}
						</div>
					</div>
				</div>

				<div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
					<button
						type="button"
						onClick={() => onResolve("keep_a")}
						disabled={pendingAction != null}
						data-testid="memory-conflict-keep-a"
						style={{
							padding: "6px 12px",
							border: "1px solid var(--border)",
							background: "transparent",
							color: "var(--fg)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							cursor: pendingAction != null ? "not-allowed" : "pointer",
						}}
					>
						保留 A · keep_a
					</button>
					<button
						type="button"
						onClick={() => onResolve("keep_b")}
						disabled={pendingAction != null}
						data-testid="memory-conflict-keep-b"
						style={{
							padding: "6px 12px",
							border: "1px solid var(--accent-vermillion)",
							background: "var(--accent-vermillion)",
							color: "var(--bg)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							cursor: pendingAction != null ? "not-allowed" : "pointer",
						}}
					>
						保留 B · keep_b
					</button>
					<button
						type="button"
						onClick={() => setManualMode(true)}
						disabled={pendingAction != null}
						data-testid="memory-conflict-merge-manual"
						style={{
							padding: "6px 12px",
							border: "1px solid #cf7e1f",
							background: manualMode ? "rgba(207, 126, 31, 0.1)" : "transparent",
							color: "#cf7e1f",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							cursor: pendingAction != null ? "not-allowed" : "pointer",
						}}
					>
						手动合并 · merge_manual
					</button>
				</div>

				{manualMode ? (
					<div style={{ marginTop: 12 }}>
						<textarea
							value={manualContent}
							onChange={(e) => setManualContent(e.target.value)}
							disabled={pendingAction != null}
							data-testid="memory-conflict-manual-textarea"
							style={{
								width: "100%",
								minHeight: 140,
								padding: "8px 10px",
								border: "1px solid var(--border)",
								background: "transparent",
								color: "var(--fg)",
								fontFamily: '"Noto Sans SC", sans-serif',
								fontSize: 12,
								lineHeight: 1.6,
								resize: "vertical",
							}}
						/>
						<div
							style={{
								display: "flex",
								justifyContent: "flex-end",
								marginTop: 8,
							}}
						>
							<button
								type="button"
								onClick={() => onResolve("merge_manual", manualContent.trim())}
								disabled={pendingAction != null || !manualReady}
								data-testid="memory-conflict-submit-manual"
								style={{
									padding: "6px 12px",
									border: "1px solid #cf7e1f",
									background: "#cf7e1f",
									color: "var(--bg)",
									fontFamily: '"Noto Sans SC", sans-serif',
									fontSize: 12,
									cursor: pendingAction != null || !manualReady ? "not-allowed" : "pointer",
									opacity: pendingAction != null || !manualReady ? 0.5 : 1,
								}}
							>
								{resolving ? "提交中…" : "提交合并"}
							</button>
						</div>
					</div>
				) : null}

				<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
					<button
						type="button"
						onClick={onCancel}
						disabled={pendingAction != null}
						data-testid="memory-conflict-cancel"
						style={{
							padding: "6px 12px",
							border: "1px solid var(--border)",
							background: "transparent",
							color: "var(--fg-muted)",
							fontFamily: '"Noto Sans SC", sans-serif',
							fontSize: 12,
							cursor: pendingAction != null ? "not-allowed" : "pointer",
						}}
					>
						取消
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * 详情面板:展开一条记忆时,把 v2 字段(QUI-193 supersede 链 / QUI-196
 * last_writer_client / QUI-197 salience + kind + staleness)按字段渲染,
 * 不是把 metadata JSON 整团 dump。让用户能直观看到 v2 的语义维度。
 */
interface MemoryDetailPanelProps {
	readonly record: MemoryRecord;
}

function MemoryDetailPanel({ record }: MemoryDetailPanelProps): React.ReactElement {
	const stalenessDays = computeStalenessDays(record.createdAt);
	const stalenessMarker = stalenessDays != null && stalenessDays >= 30;
	return (
		<div
			data-testid={`memory-detail-${record.id}`}
			style={{
				marginTop: 8,
				padding: "10px 12px",
				border: "1px solid var(--border)",
				background: "var(--bg)",
				fontSize: 11,
				color: "var(--fg)",
				lineHeight: 1.6,
				display: "grid",
				gap: 6,
			}}
		>
			{stalenessMarker ? (
				<div
					data-testid="memory-detail-staleness"
					style={{
						padding: "4px 8px",
						background: "rgba(255, 165, 0, 0.1)",
						border: "1px solid rgba(255, 165, 0, 0.3)",
						color: "var(--accent-orange, #d97706)",
						fontSize: 10,
					}}
				>
					⚠️ 这条记忆是 <strong>{stalenessDays} 天前</strong> 的(staleness marker · 历史可能已变化)
				</div>
			) : null}

			<DetailRow label="ID" value={record.id} mono />
			<DetailRow label="层级 / tier" value={record.tier} />
			{record.kind != null ? <DetailRow label="类型 / kind" value={record.kind} /> : null}
			{record.importanceScore != null ? (
				<DetailRow label="重要性 / importance" value={record.importanceScore.toFixed(3)} />
			) : null}

			{record.version != null && record.version > 1 ? (
				<DetailRow
					label="版本 / version"
					value={`v${record.version}${record.isLatest === false ? "(已被覆盖)" : "(最新)"}`}
				/>
			) : null}
			{record.parentId != null ? (
				<DetailRow label="父版本 / parent_id" value={record.parentId.slice(0, 16)} mono />
			) : null}

			{record.lastWriterClient != null ? (
				<DetailRow label="最后写入端 / writer" value={record.lastWriterClient} />
			) : null}
			{record.projectScope != null ? (
				<DetailRow label="项目范围 / project_scope" value={record.projectScope} mono />
			) : null}

			{record.salience != null && Object.keys(record.salience).length > 0 ? (
				<div data-testid="memory-detail-salience">
					<div
						style={{
							marginBottom: 4,
							fontSize: 10,
							color: "var(--fg-muted)",
							fontWeight: 600,
						}}
					>
						6 维显著度 / salience(按 intent 加权)
					</div>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
						{Object.entries(record.salience).map(([dim, raw]) => {
							const val = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
							const display = Number.isFinite(val) ? val.toFixed(2) : "—";
							return (
								<div
									key={dim}
									style={{
										fontSize: 10,
										color: "var(--fg-muted)",
										fontFamily: '"JetBrains Mono", monospace',
									}}
								>
									{dim}: <strong style={{ color: "var(--fg)" }}>{display}</strong>
								</div>
							);
						})}
					</div>
				</div>
			) : null}

			{record.archivedAt != null ? (
				<DetailRow
					label="归档时间 / archived_at"
					value={`${formatTimestamp(record.archivedAt)}${
						record.recoveredAt != null ? ` · 已恢复 ${formatTimestamp(record.recoveredAt)}` : ""
					}`}
				/>
			) : null}

			{record.metadata != null && Object.keys(record.metadata).length > 0 ? (
				<details style={{ marginTop: 4 }}>
					<summary
						style={{
							cursor: "pointer",
							color: "var(--fg-muted)",
							fontSize: 10,
						}}
					>
						原始 metadata(raw JSON)
					</summary>
					<pre
						style={{
							marginTop: 4,
							padding: "6px 8px",
							border: "1px solid var(--border)",
							fontFamily: '"JetBrains Mono", monospace',
							fontSize: 10,
							color: "var(--fg-muted)",
							lineHeight: 1.5,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
						}}
					>
						{JSON.stringify(record.metadata, null, 2)}
					</pre>
				</details>
			) : null}
		</div>
	);
}

interface DetailRowProps {
	readonly label: string;
	readonly value: string;
	readonly mono?: boolean;
}

function DetailRow({ label, value, mono = false }: DetailRowProps): React.ReactElement {
	return (
		<div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
			<span
				style={{
					minWidth: 140,
					color: "var(--fg-muted)",
					fontSize: 10,
				}}
			>
				{label}
			</span>
			<span
				style={{
					color: "var(--fg)",
					fontSize: 11,
					fontFamily: mono ? '"JetBrains Mono", monospace' : undefined,
				}}
			>
				{value}
			</span>
		</div>
	);
}

function computeStalenessDays(createdAt: string | null): number | null {
	if (createdAt == null) return null;
	try {
		const created = new Date(createdAt).getTime();
		if (!Number.isFinite(created)) return null;
		const now = Date.now();
		return Math.floor((now - created) / (1000 * 60 * 60 * 24));
	} catch {
		return null;
	}
}

/**
 * 4 个 tier 标题旁的圆圈叹号 info icon。点击或 hover 弹出 popover 显示
 * tier 的概念说明。比 native title 属性显眼得多,移动端 click 也能用。
 */
interface TierInfoIconProps {
	readonly tier: string;
	readonly description: string;
}

function TierInfoIcon({ tier, description }: TierInfoIconProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover-only wrapper,纯展示 popover,内部叹号也只是 visual。
		<span
			data-testid={`tier-info-${tier}`}
			style={{
				display: "inline-block",
				position: "relative",
				marginLeft: 6,
				verticalAlign: "middle",
			}}
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<span
				aria-hidden
				style={{
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 18,
					height: 18,
					borderRadius: "50%",
					border: "1px solid var(--fg-muted)",
					background: open ? "var(--accent-vermillion)" : "var(--bg)",
					color: open ? "var(--bg)" : "var(--fg-muted)",
					fontSize: 11,
					fontFamily: "serif",
					fontStyle: "italic",
					fontWeight: 700,
					cursor: "help",
					lineHeight: 1,
					transition: "background 120ms, color 120ms",
				}}
			>
				!
			</span>
			{open ? (
				<div
					role="tooltip"
					data-testid={`tier-info-${tier}-popover`}
					style={{
						position: "absolute",
						top: "calc(100% + 6px)",
						left: 0,
						zIndex: 50,
						minWidth: 320,
						maxWidth: 420,
						padding: "12px 14px",
						background: "var(--bg)",
						border: "1px solid var(--border)",
						borderRadius: 6,
						boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
						fontSize: 12,
						lineHeight: 1.6,
						color: "var(--fg)",
						whiteSpace: "pre-wrap",
						fontFamily: '"Noto Sans SC", sans-serif',
					}}
				>
					{description}
				</div>
			) : null}
		</span>
	);
}
