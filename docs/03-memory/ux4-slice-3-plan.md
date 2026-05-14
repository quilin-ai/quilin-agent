# UX-4 KG Slice 3 实施计划 / Implementation plan

> 状态 / Status:**Plan(实施前)** · 下一 session 启动
> 写于 / Drafted:2026-05-15 autonomous run · Slice 1+2 落地后
> 关联 / Related:`docs/03-memory/ux4-kg-rebuild-plan.md` · Slice 1 commit `b1e4a6d` · Slice 2 commit `901e989`

---

## 现状 / Current state

English: Backend KG is fully ready — extractor (Slice 1) + backfill MCP tool (Slice 2). What's missing is the web surface that lets a user actually look at the graph.

中文:后端 KG 全 ready,extractor + backfill 都做完了。还差让用户在 web 上看到这张图。

## 目标 / Goal

- 新增 TS endpoint `GET /api/memory/graph` 把 `TemporalKnowledgeGraph` edges 转成 reactflow / cytoscape 友好 JSON
- `/memory` 页加 graph tab,渲染节点 + 边
- 节点点 click → 显示 `memory_id` 关联的原 memory record 内容
- 时间过滤滑块(可选,Slice 3 收尾时再决定)

## 切分 / Slicing

### 3.1 — TS endpoint `/api/memory/graph`(~10M)

**文件 / Files:**
- 新增 `apps/web/app/api/memory/graph/route.ts`
- 复用现有 quilin-mem MCP client 走 `query_graph` 或新增 `kg_dump` MCP tool 一次性导出

**逻辑 / Logic:**
```ts
// GET /api/memory/graph?limit=200&as_of=2026-05-15T00:00:00Z
// → { nodes: [{id, label, type}], edges: [{id, source, target, label, valid_from, valid_to, weight, memory_id}] }
```

需要决策:走 MCP tool 还是直接读 SQLite?MCP client 有 cross-process 开销但保持解耦;直读 SQLite 更快但 web 直接打 `~/.quilin/memory.db` 跨越组件边界。**推荐 MCP 路径**,代价可接受。

可能需要先在 quilin-mem 加一个 `kg_dump_for_viz(limit, as_of?) -> {nodes, edges}` MCP tool,因为现有 `kg_query` 是按 entity 查询不是 dump。

### 3.2 — 安装 reactflow + 节点渲染(~10M)

**包依赖 / Deps:**
```
pnpm --filter @quilin/web add @xyflow/react
```
(reactflow v12 已改名为 @xyflow/react)

**文件 / Files:**
- 新增 `apps/web/components/memory/KnowledgeGraphView.tsx`
- 修改 `apps/web/app/memory/page.tsx` 加 tab

**最小渲染:**
- 默认 force-directed layout(reactflow 自带)
- 节点 label = entity name
- 边 label = predicate
- 点击节点 → 展开 panel 显示该 entity 的所有相邻边

### 3.3 — 节点点击展示原 memory record(~5M)

**文件 / Files:**
- 新增 `apps/web/app/api/memory/records/[id]/route.ts`(GET 返回 memory record 内容)
- KnowledgeGraphView 接 onClick → fetch + display

### 3.4 — Playwright 实证(~5M)

UI 改动的硬要求(per `feedback_playwright_after_cross_review.md`):
- /memory 页能打开 graph tab
- 至少 1 个 node 渲染
- 点击 node 弹出 panel

## Token 预算 / Token budget

总计 ~30M(不含 cross-review)+ cross-review ~40-60M = ~70-90M。需要确认下一 session 起始 token 余量 ≥ 100M 再启动。

## 协议 / Protocol

- TypeScript:`pnpm --filter @quilin/web exec tsc --noEmit` + `pnpm --filter @quilin/web exec vitest run` 全过
- Python:`uv run pytest providers/memory/tests/test_kg*.py` 仍全过(本片不改 Python)
- Cross-review:per CLAUDE.md 硬规则,2 fresh reviewer 连续 0 REAL 才能 commit
- Playwright:Slice 3.2 / 3.3 收尾后强制一轮(per `feedback_playwright_after_cross_review.md`)

## 不在 scope / Out of scope

- KG schema 重写(用现有的)
- Real-time KG 更新(live extraction at chat session completion)→ 下个 Iter
- 多用户 / 权限隔离(单用户本地工具)
- Slice 4 consolidation log UI:**前置依赖缺失** — quilin-mem 的 consolidator 没有持久化的 consolidation log SQLite 表;先做一片"暴露 consolidator 内部状态"的工作再谈 UI

## 推荐顺序 / Recommended order

1. 先 3.1 (TS endpoint)+ 必要时新增 `kg_dump_for_viz` MCP tool
2. 再 3.2 (UI 渲染)
3. 然后 3.3 (节点点击)
4. 最后 3.4 (Playwright 实证)

每片单独 commit,避免一次性大改动 + 简化 cross-review 颗粒度。
