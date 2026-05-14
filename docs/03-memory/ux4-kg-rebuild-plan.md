# UX-4 KG-based 记忆重做实施计划 / Implementation plan

> 状态 / Status:**Plan(实施前)** · 下一 token 窗口启动
> 写于 / Drafted:2026-05-15 autonomous run · 现有基础设施实证后
> 关联 / Related:`docs/15-introspection/web-ux-backlog.md` UX-4 · `docs/03-memory/profile-pure-markdown-migration.md`(独立)

---

## 现状实证 / Audit of what's already there

English: I expected the KG layer to be empty per the UX-4 backlog entry, but a `git grep` reveals the heavy lifting is mostly done. The audit below pins what exists, what's mid-flight, and what's genuinely missing.

中文:我以为 KG 层是空的(按 UX-4 backlog 描述),实证发现重活基本干完了。下面盘点已有 / 半成品 / 真缺口。

### Already shipped ✅

| 模块 | 文件 | 状态 |
|---|---|---|
| TemporalKnowledgeGraph 类 (init/close/reset/add_edge/search/subgraph_search) | `providers/memory/src/quilin_mem/kg.py` | ✅ 222 行,WAL + BEGIN IMMEDIATE + busy_timeout |
| KG schema 版本化 + ensure_schema | `kg_validation.py` | ✅ schema_version 检查、迁移 |
| Entity extraction from query text | `kg_validation.py:extract_entity_terms` | ✅ 已被 search 调用 |
| 递归 subgraph 查询(多跳) | `kg_query.py:subgraph_search_sync` | ✅ |
| Temporal validity 窗口(valid_from / valid_to)| `kg.py:_add_edge_sync` | ✅ |
| KGRetrieverMixin 接入 retriever | `retriever_kg.py` | ✅ 已用 |
| 11+ 测试覆盖(schema / 多跳 / 时序 / 实体抽取)| `tests/test_kg.py` | ✅ 全过 |

### Genuinely missing ❌ → 这就是 UX-4 真实 scope

| 缺口 | 描述 |
|---|---|
| **kg_extractor.py** | 从一条新 memory 记录里抽 `(subject, predicate, object)` 三元组 + 时间锚,写入 TemporalKnowledgeGraph。需要 LLM 抽取 + 反幻觉过滤 + temporal dedup |
| **memory_backfill_kg MCP 工具** | 一次性遍历现有 ~53 条 `memory_records`,逐条调 extractor 写入 KG。MCP 工具暴露给 agent 让它显式触发 |
| **/api/memory/graph endpoint** | TS 侧 endpoint 读 KG edges,返 reactflow / cytoscape 友好 JSON |
| **/memory 页 KG 可视化** | 加 graph 视图 tab(reactflow 或 cytoscape),节点是 entity,边是 predicate;时序滑块过滤 valid_from/to |
| **consolidation log UI 暴露** | quilin-mem 已有 consolidation 流(reflection / decay / promotion),但 UI 没显。加 `/api/memory/consolidations` + /memory 页 timeline tab |

---

## 切片建议 / Slicing

### ~~Slice 1 — kg_extractor.py + 单元测试~~ ✅ 已完成 commit `b1e4a6d`

实际成果(超过原 plan 范围):
- LLM 抽取走 system+user 双消息,system 喂规则,user 包文本(防 prompt injection)
- 数据块用 `<MEMORY_TEXT_<random>>` 包,random 是 secrets.token_hex(8) 16 hex(防 attacker 拼闭合标签逃逸)
- SSRF guard:base_url 必须 https + host 在 `ALLOWED_LLM_HOSTS` allowlist 里(防内部端点跳转)
- 反幻觉:source_quote 必须是输入文本 verbatim 子串(strip 后)
- 反代词坍缩:subject/object 不能是 the user / they / 用户 / 他 等泛指
- per-field 长度 cap 500 chars
- DI seam:`llm_caller` / `boundary_token` / `generateAskId` 全可注入,28 个测试零网络

### ~~Slice 1 原文(供参考)~~

English: Pure Python module under `providers/memory/src/quilin_mem/kg_extractor.py`. Async function `extract_edges_from_memory(record, llm)` that:
1. Takes a `MemoryRecord` (text body + metadata)
2. Calls a cheap LLM with a tight prompt asking for `[{subject, predicate, object, valid_from, source_quote}]` JSON list
3. Validates each triple — drops ones where subject/object look like generic placeholders ("the user", "they", "it"), filters hallucinations by requiring `source_quote` to actually appear in the record text
4. Calls `kg.add_edge(...)` with `memory_id` linking back to source

中文:核心是 LLM 抽取 + 反幻觉 source_quote check + temporal dedup。

依赖 / Deps:DEEPSEEK_API_KEY(已有),`generateText` from `ai` SDK 或 python httpx 直接打 deepseek。Python 这边推荐 httpx 同步 + asyncio.to_thread。

测试:
- 抽 1 条 record → ≥ 1 个 edge
- 幻觉过滤:source_quote 不在原文 → drop
- temporal dedup:同 (s,p,o) 已存在且 valid_from 重合 → 不重复 INSERT

### ~~Slice 2 — memory_backfill_kg MCP 工具~~ ✅ 已完成 commit `901e989`

成果:
- `kg_backfill.py` 纯编排模块 + Protocol contracts(StoreLike / KGLike / MemoryRecordLike),12 tests 零网络
- `server.py` 新增 `memory_backfill_kg(batch_size, max_records, dry_run)` MCP tool
- 走 4 个 memory layer(working / episodic / semantic / skill),逐条调 kg_extractor
- 默认 dry_run=True 安全 inspection 模式
- per-triple error isolation,单条失败不阻塞整个 walk
- 硬上限:batch 1-200(默认 50),max_records 1-10000

### Slice 2 原文(供参考)

English: `providers/memory/src/quilin_mem/server.py` 注册新 tool `memory_backfill_kg`,接收 `{batch_size, max_records, dry_run}`。遍历 `memory_records` 表,对每条调 Slice 1 的 extractor。返回 `{processed, edges_added, errors}`。

测试:dry_run=True 返回 plan 不写 KG;真 run 后 edges 表行数 > 0。

### Slice 3 — TS /api/memory/graph + 可视化(~25M)

- TS endpoint `apps/web/app/api/memory/graph/route.ts` GET handler,通过现有 MCP client 调 KG 查询,返回 reactflow JSON shape `{ nodes: [{id, label, type}], edges: [{id, source, target, label, valid_from, valid_to}] }`
- 装 `reactflow`(npm i react-flow)
- `/memory` 页加 graph tab(已有 page,在 `apps/web/app/memory/page.tsx`)
- 节点点击 → /api/memory/records/[id] (该 endpoint 已有还是新加,待确认)显示原 memory record

测试:e2e 跑 /memory → 切到 graph tab → ≥ 1 个 node 渲染 + 可点击。

### Slice 4 — consolidation log UI(~10M)

- TS endpoint `/api/memory/consolidations` GET 读 consolidation log(已有 SQLite 表,quilin-mem 那边定义)
- /memory 页加 timeline tab,显示 reflection / decay / promotion 历史
- 每条 entry 显时间 + 触发原因 + before/after diff

---

## 真实总 token 估算 / Total token estimate

~60M token 全部 4 slice 干完。本来 backlog 上写 ~7 人天,实际因为后端基础已经在,小 2/3 的工作量。

---

## 哪些不在 scope / Out of scope

- 不重写 TemporalKnowledgeGraph(已经够好,不动)
- 不引入新的 graph DB(neo4j 等)—— SQLite + edges 表足够用 53 条 + 未来 1000 条规模
- 不做实时增量(每次会话 turn 触发 extractor 写一次 KG)—— Slice 1 默认全是 manual `memory_backfill_kg` 触发;实时模式可以下一个 Iter 加
- 不动现有 `retriever_kg.py` API,只确保它能查到 backfill 后的新 edges

---

## 协议 / Protocol

每个 slice 收尾前:
1. Python:`uv run pytest providers/memory/tests/test_kg*.py` 全过
2. TS:`pnpm --filter @quilin/web exec vitest run` 全过
3. Cross-review:1-2 个新 subagent reviewer(per CLAUDE.md 硬规则)
4. UI Slice 3/4:Playwright 实证轮(per `feedback_playwright_after_cross_review.md`)
5. Commit + push;更新本 plan 文档把已 ship 行从 ❌ 改 ✅

---

## 与其他 backlog 的优先级 / Priority vs other backlog

按价值密度排序(token / 影响):

1. **profile_updater.py 纯 markdown 输出** ←先做,因为用户已经 ask 过两次,~15M
2. **交互 primitives Slice 3 agent-core hook** ←关闭 wire 闭环,~30M
3. **UX-4 KG Slice 1+2 (backend)** ←~25M,可与 #1/#2 并行
4. **UX-4 KG Slice 3+4 (UI)** ←~35M,依赖 backend 落地
5. **交互 primitives Slice 4 TUI** ←~15M,可后置
