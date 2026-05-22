/**
 * POST /api/memory/dedupe
 *
 * 智能整理 / Smart consolidation preview + execute for the /memory page.
 *
 * QUI-187 (2026-05-20):升级为 Consolidator 三类提案统一入口。
 * 后端正在把 QUI-185 dedupe 迁进 Consolidator,新工具名 `memory_consolidate_plan`,
 * 返三类 proposal:
 *   - kind: "dedupe"           → 同 QUI-185,exact / embedding / llm 三策略
 *   - kind: "kg-prune"         → 过期知识图谱关系剪枝(deleteIds = edge ids)
 *   - kind: "reflect-insight"  → reflect insight 抽取(insertContent + 来源 memoryIds)
 *
 * 流程 / Flow:
 *   { execute: false } (default) → 调 memory_consolidate_plan 拿 preview proposals,UI 渲染 confirm
 *   { execute: true }            → 用 plan 调 memory_delete 真删(走 WriteAuthority gate)
 *                                  reflect-insight insert 暂时跳过(后端 memory_insert tool 还没接入,
 *                                  留到 QUI-187 follow-up)
 *
 * 过渡兼容 / Migration window:
 * Codex 还在 rename 后端 tool,主仓库可能同时存在新老 tool。本路由优先调
 * `memory_consolidate_plan`,fallback 到 `memory_dedupe_plan`(老接口只返 dedupe 类)。
 * 老接口的 groups 自动转成 kind:"dedupe" 的 proposals,前端无需特判。
 *
 * 老 exact-string-match `lib/memory-dedupe.ts` 路径保留 type 接口 + vitest 单测覆盖等价逻辑。
 */

import { getToolsCatalog } from "@/lib/tools-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DedupeStrategy = "exact" | "embedding" | "llm";
type ProposalKind = "dedupe" | "kg-prune" | "reflect-insight";

/**
 * Wire format for a single Consolidator proposal.
 *
 * 三种 kind 共用一个 shape,字段可选性按 kind 不同语义不同:
 * - dedupe:           keepId + deleteIds + strategy + score 必有
 * - kg-prune:         deleteIds 是 edge ids,keepId 可空
 * - reflect-insight:  insertContent 必有,memoryIds 是来源,deleteIds 通常空
 */
interface WireProposal {
	readonly kind: ProposalKind;
	readonly tier: string;
	readonly keepId?: string;
	readonly deleteIds: readonly string[];
	readonly insertContent?: string;
	readonly reason: string;
	readonly strategy?: DedupeStrategy;
	readonly score?: number;
	readonly memoryIds: readonly string[];
}

interface WireConsolidatePlan {
	readonly proposals: readonly WireProposal[];
	readonly totalDelete: number;
	readonly totalKeep: number;
	readonly totalInsert: number;
}

interface DedupeRequestBody {
	readonly execute?: boolean;
	readonly tier?: string;
	readonly strategy?: string;
}

function isDedupeRequestBody(value: unknown): value is DedupeRequestBody {
	if (value == null || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	if ("execute" in obj && typeof obj.execute !== "boolean") return false;
	if ("tier" in obj && obj.tier != null && typeof obj.tier !== "string") return false;
	if ("strategy" in obj && obj.strategy != null && typeof obj.strategy !== "string") return false;
	return true;
}

function asString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown, fallback = 0): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function asStrategy(v: unknown): DedupeStrategy | undefined {
	return v === "exact" || v === "embedding" || v === "llm" ? v : undefined;
}

function asKind(v: unknown): ProposalKind | null {
	return v === "dedupe" || v === "kg-prune" || v === "reflect-insight" ? v : null;
}

/**
 * Parse the new Consolidator wire shape (proposals[]).
 *
 * 接受同名 alias `groups` 防止老后端忘记 rename(等价 dedupe 列表)。
 * 每个 proposal 必须显式带 kind 字段;缺失 / 未知 kind 直接丢弃(防止旧 schema
 * 串到新前端导致渲染错乱)。
 */
function parseConsolidatePlan(raw: string): WireConsolidatePlan | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	const rawProposals = obj.proposals;
	if (!Array.isArray(rawProposals)) return null;

	const proposals: WireProposal[] = [];
	let computedDelete = 0;
	let computedInsert = 0;
	for (const p of rawProposals) {
		if (p == null || typeof p !== "object") continue;
		const po = p as Record<string, unknown>;
		const kind = asKind(po.kind);
		if (kind == null) continue;
		const tier = asString(po.tier);
		if (tier == null) continue;
		const proposal: WireProposal = {
			kind,
			tier,
			keepId: asString(po.keepId) ?? undefined,
			deleteIds: asStringArray(po.deleteIds),
			insertContent: asString(po.insertContent) ?? undefined,
			reason: asString(po.reason) ?? "",
			strategy: asStrategy(po.strategy),
			score: typeof po.score === "number" ? po.score : undefined,
			memoryIds: asStringArray(po.memoryIds),
		};
		proposals.push(proposal);
		computedDelete += proposal.deleteIds.length;
		if (proposal.insertContent != null) computedInsert += 1;
	}

	const totalKeep = proposals.filter((p) => p.keepId != null).length;
	return {
		proposals,
		totalDelete: asNumber(obj.totalDelete, computedDelete),
		totalKeep: asNumber(obj.totalKeep, totalKeep),
		totalInsert: asNumber(obj.totalInsert, computedInsert),
	};
}

/**
 * Parse the legacy `memory_dedupe_plan` wire shape (groups[]) and adapt it
 * to the new Consolidator wire format with kind:"dedupe" proposals.
 *
 * 过渡期专用:Codex 还没 rename 后端工具时,前端仍能拿到等价 dedupe 提案。
 * Reflect-insight / kg-prune 类型在老 wire 上不存在,直接缺失即可。
 */
function parseLegacyDedupePlan(raw: string): WireConsolidatePlan | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	const rawGroups = obj.groups;
	if (!Array.isArray(rawGroups)) return null;

	const proposals: WireProposal[] = [];
	for (const g of rawGroups) {
		if (g == null || typeof g !== "object") continue;
		const go = g as Record<string, unknown>;
		const tier = asString(go.tier);
		const keepId = asString(go.keepId);
		if (tier == null || keepId == null) continue;
		proposals.push({
			kind: "dedupe",
			tier,
			keepId,
			deleteIds: asStringArray(go.deleteIds),
			reason: asString(go.reason) ?? "",
			strategy: asStrategy(go.strategy) ?? "exact",
			score: typeof go.score === "number" ? go.score : undefined,
			memoryIds: asStringArray(go.memoryIds),
		});
	}
	return {
		proposals,
		totalDelete: asNumber(obj.totalDelete, 0),
		totalKeep: asNumber(obj.totalKeep, 0),
		totalInsert: 0,
	};
}

interface ExecuteResult {
	readonly id: string;
	readonly kind: ProposalKind;
	readonly ok: boolean;
	readonly error: string | null;
}

/**
 * Execute deletions for dedupe + kg-prune proposals.
 *
 * reflect-insight 类暂时跳过(insertContent 还需要后端 memory_insert MCP tool
 * 接入,留 follow-up issue)。Insert 路径不可执行时,UI 上对应 proposal
 * 仍能展示,但 confirm 后只走 delete,statusMessage 会标注 insert skipped。
 */
async function executePlan(
	plan: WireConsolidatePlan,
	deleteTool: {
		readonly execute: (args: unknown) => Promise<{
			readonly content: string;
			readonly isError: boolean;
			readonly error?: { readonly message: string; readonly code?: string };
		}>;
	},
): Promise<{
	readonly results: readonly ExecuteResult[];
	readonly deleted: number;
	readonly failed: number;
	readonly skippedInsert: number;
}> {
	const results: ExecuteResult[] = [];
	let skippedInsert = 0;
	for (const proposal of plan.proposals) {
		if (proposal.kind === "reflect-insight" && proposal.insertContent != null) {
			skippedInsert += 1;
		}
		for (const id of proposal.deleteIds) {
			try {
				const out = await deleteTool.execute({ memory_id: id });
				if (out.isError) {
					results.push({
						id,
						kind: proposal.kind,
						ok: false,
						error: out.error?.message ?? out.content,
					});
				} else {
					results.push({ id, kind: proposal.kind, ok: true, error: null });
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				results.push({ id, kind: proposal.kind, ok: false, error: msg });
			}
		}
	}
	const deleted = results.filter((r) => r.ok).length;
	return { results, deleted, failed: results.length - deleted, skippedInsert };
}

export async function POST(request: Request): Promise<Response> {
	try {
		let body: unknown = {};
		try {
			const text = await request.text();
			if (text.length > 0) body = JSON.parse(text);
		} catch {
			return Response.json(
				{
					ok: false,
					error: { code: "invalid_body", message: "request body must be JSON or empty" },
				},
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}
		if (!isDedupeRequestBody(body)) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "invalid_body",
						message: "expected `{ execute?: boolean, tier?: string, strategy?: string }`",
					},
				},
				{ status: 400, headers: { "cache-control": "no-store" } },
			);
		}
		const execute = body.execute === true;
		const tier = body.tier;
		// QUI-208 dogfood fix (2026-05-21):前端历史上传过两类 strategy:
		// - top-level ConsolidationStrategy: `dedupe | reflect | kg-prune | all`
		// - dedupe sub-strategy: `exact | embedding | llm`
		// 后端 memory_consolidate_plan 只认 top-level,sub-strategy 会触发
		// Pydantic literal_error → 502。这里做兼容映射:sub-strategy 视为
		// 隐含 `dedupe` 顶层,直接传给后端不会爆。
		const SUB_STRATEGIES = new Set(["exact", "embedding", "llm"]);
		const TOP_STRATEGIES = new Set(["dedupe", "reflect", "kg-prune", "all"]);
		let strategy = body.strategy;
		if (strategy != null && SUB_STRATEGIES.has(strategy)) {
			// dedupe sub-strategy → 隐含 top-level=dedupe
			strategy = "dedupe";
		} else if (strategy != null && !TOP_STRATEGIES.has(strategy)) {
			// 未知 strategy → 不透传(let backend default to "all")
			strategy = undefined;
		}

		const catalog = await getToolsCatalog();
		// Prefer the new Consolidator tool. During the migration window we
		// still recognise the legacy `memory_dedupe_plan` name and adapt it.
		const consolidateTool = catalog.rawTools.find(
			(t) => t.name === "quilin-mem/memory_consolidate_plan",
		);
		const legacyDedupeTool = catalog.rawTools.find(
			(t) => t.name === "quilin-mem/memory_dedupe_plan",
		);
		const activeTool = consolidateTool ?? legacyDedupeTool;
		if (activeTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_consolidate_plan_unavailable",
						message:
							"quilin-mem MCP server is not connected, or memory_consolidate_plan/memory_dedupe_plan tool is missing.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const planArgs: Record<string, string> = {};
		if (tier != null) planArgs.tier = tier;
		if (strategy != null) planArgs.strategy = strategy;
		const planResult = await activeTool.execute(planArgs);
		if (planResult.isError) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_consolidate_plan_failed",
						message: planResult.error?.message ?? planResult.content,
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		// Pick parser based on which tool we ended up calling. New tool may
		// also include legacy `groups` field — try new parser first, then
		// fall through to legacy if the new shape didn't materialise.
		const plan =
			consolidateTool != null
				? (parseConsolidatePlan(planResult.content) ?? parseLegacyDedupePlan(planResult.content))
				: parseLegacyDedupePlan(planResult.content);
		if (plan == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_consolidate_plan_parse_failed",
						message: "memory_consolidate_plan returned unparseable JSON",
					},
				},
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
		}

		if (!execute) {
			return Response.json(
				{
					ok: true,
					data: {
						executed: false,
						plan,
						totalDelete: plan.totalDelete,
						totalKeep: plan.totalKeep,
						totalInsert: plan.totalInsert,
					},
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const deleteTool = catalog.rawTools.find((t) => t.name === "quilin-mem/memory_delete");
		if (deleteTool == null) {
			return Response.json(
				{
					ok: false,
					error: {
						code: "memory_delete_unavailable",
						message: "quilin-mem MCP server is connected but memory_delete tool is missing.",
					},
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		const { results, deleted, failed, skippedInsert } = await executePlan(plan, deleteTool);

		// D.1 fix: append an EXECUTE-stage consolidation_log entry so the
		// /memory timeline truly reflects writes_performed = N. Without
		// this the plan stage logs `dry_run=1, writes_performed=0` and
		// no subsequent execute entry is ever written — UI reported
		// "0 条 实际写入" while DB had truly deleted N rows. Best-effort:
		// failure to record the execute log MUST NOT roll back the
		// deletion (data integrity > observability).
		const recordTool = catalog.rawTools.find(
			(t) => t.name === "quilin-mem/consolidation_log_record_execute",
		);
		if (recordTool != null && deleted > 0) {
			try {
				await recordTool.execute({
					task: "web.memory_dedupe.execute",
					writes_performed: deleted,
					actions: results
						.filter((r) => r.ok)
						.map((r) => ({ id: r.id, kind: r.kind })),
				});
			} catch (recordErr) {
				console.log(
					`[/api/memory/dedupe] consolidation_log_record_execute failed: ${
						recordErr instanceof Error ? recordErr.message : String(recordErr)
					}`,
				);
			}
		}

		return Response.json(
			{
				ok: true,
				data: {
					executed: true,
					plan,
					deleted,
					failed,
					skippedInsert,
					results,
				},
			},
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`[/api/memory/dedupe] failed: ${msg}`);
		return Response.json(
			{ ok: false, error: { code: "memory_consolidate_failed", message: msg } },
			{ status: 500, headers: { "cache-control": "no-store" } },
		);
	}
}
