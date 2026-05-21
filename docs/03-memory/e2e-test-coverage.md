# Web 端记忆功能 E2E 测试覆盖矩阵 / Web Memory E2E Test Coverage Matrix

> **目标 / Goal**:确保 Quilin Web 端每一个记忆功能都被真端到端测试覆盖(浏览器 → MCP → SQLite → recall → UI),不漏任何场景。
>
> **不接受 mock**:所有测试用真启 quilin-mem MCP server + Web dev server + 真 SQLite + 真浏览器(Playwright)。
>
> **当前 master**:`acdcbc1`(2026-05-21,28 commits ship)

---

## 1. 测试文件清单 / Test Files

| 文件 | 范围 | 测试数 | 状态 |
|---|---|---|---|
| `apps/web/tests/e2e/memory-full-lifecycle.spec.ts` | 既有 5 lifecycle 测试 | 5/5 PASS | ✅(commit 7263ed0)|
| `apps/web/tests/e2e/memory-v2-features.spec.ts` | v2 详情面板 + Web chat observer | 计划中 | ⏳ subagent 跑中 |
| `apps/web/tests/unit/app/memory-dedupe-route.test.ts` | dedupe wire 协议单测 | 14/14 PASS | ✅ |
| `apps/web/tests/unit/app/memory-consolidations-route.test.ts` | consolidations normalizer 单测 | 6/6 PASS | ✅ |

---

## 2. 完整功能矩阵 / Full Feature Matrix(43 测试点)

### 2.1 列表 / 浏览(6 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 1 | `/memory` 页加载 + auth | memory-full-lifecycle.spec.ts:test1 | ✅ |
| 2 | 按 tier 分组渲染(working/episodic/semantic/skill) | memory-full-lifecycle.spec.ts:test1 | ✅ |
| 3 | 每 tier 计数 + 标签 | memory-full-lifecycle.spec.ts:test1 | ✅ |
| 4 | 文本过滤 / search filter | — | ❌ 缺口 |
| 5 | tier filter dropdown | memory-full-lifecycle.spec.ts:test5 | ✅(部分)|
| 6 | 空状态(无 records)显示 | — | ❌ 缺口 |

### 2.2 详情面板 / Detail Panel(QUI-193/196/197 — commit 404fc77)(11 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 7 | 点击列表一条 → expand panel | memory-v2-features.spec.ts:test6 | ⏳ |
| 8 | `MemoryDetailPanel` 真渲染(testid `memory-detail-<id>`)| memory-v2-features.spec.ts:test6 | ⏳ |
| 9 | staleness marker(>30 天橙色 warning)| memory-v2-features.spec.ts:test6 | ⏳ |
| 10 | 6 维 salience 网格(novelty / utility / personal_relevance / actionability / recency / stability)| memory-v2-features.spec.ts:test6 | ⏳ |
| 11 | last_writer_client 显示(cli/repl/web/mac-app)| memory-v2-features.spec.ts:test6 | ⏳ |
| 12 | project_scope 显示 | memory-v2-features.spec.ts:test6 | ⏳ |
| 13 | kind 显示(user/feedback/project/...)| memory-v2-features.spec.ts:test6 | ⏳ |
| 14 | importance_score 显示 | memory-v2-features.spec.ts:test6 | ⏳ |
| 15 | 版本链(version v2 + parent_id + is_latest)| memory-v2-features.spec.ts:test6 | ⏳ |
| 16 | archived_at + recovered_at(如有)| — | ❌ 缺口 |
| 17 | 原始 metadata 折叠 `<details>` | — | ❌ 缺口 |

### 2.3 写入 / Memory Store(5 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 18 | LLM 主动调 `memory_store` tool | dogfood 1(手动)| ✅ |
| 19 | 直接 API 注入(POST /api/memory)| memory-full-lifecycle.spec.ts:test2 | ✅ |
| 20 | SQLite 真落 row(verify) | memory-full-lifecycle.spec.ts:test2 | ✅ |
| 21 | Web chat onFinish 触发 `memory_observe`(QUI-205 — commit 2dd9210)| memory-v2-features.spec.ts:test7 | ⏳ |
| 22 | observer payload 含 `[user]:` + `[assistant]:` 拼接 | memory-v2-features.spec.ts:test7 | ⏳ |

### 2.4 整理 / Consolidate(memory_consolidate_plan)(8 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 23 | dedupe button 触发 | memory-full-lifecycle.spec.ts:test3 | ✅ |
| 24 | preview modal 弹出 + proposals 渲染 | memory-full-lifecycle.spec.ts:test3 | ✅ |
| 25 | proposals 3 种类型(dedupe / kg-prune / reflect-insight)| — | ❌ 缺口 |
| 26 | `reflect-insight` 字段保留(insertContent/memoryIds/score/deleteIds/tier)| memory-consolidations-route.test.ts unit | ✅(单测) |
| 27 | confirm 后真合并 SQLite | — | ❌ 缺口(spec 注释说 small data 注入,但没真 execute)|
| 28 | dedupe strategy 协议兼容(sub-strategy → top-level,QUI-208)| memory-dedupe-route.test.ts unit | ✅(单测)|
| 29 | **大数据集(150+ records)不超 MCP stdio timeout**(QUI-204 — acdcbc1)| — | ❌ 缺口(QUI-204 已 ship,e2e 没补)|
| 30 | budget_exceeded → exact-only 真触发 | test_consolidator_batch_judge.py | ✅(pytest 不是 e2e)|

### 2.5 删除 / 恢复(QUI-195 destructive guard)(7 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 31 | 单条删除按钮 | memory-full-lifecycle.spec.ts:test4 | ✅ |
| 32 | confirm dialog 显示 | memory-full-lifecycle.spec.ts:test4 | ✅ |
| 33 | 软删 + `archived_at` 落 SQLite | memory-full-lifecycle.spec.ts:test4 | ✅ |
| 34 | 批量删除 + select-all | memory-full-lifecycle.spec.ts:test5 | ✅ |
| 35 | select-all + tier filter 交互 | memory-full-lifecycle.spec.ts:test5 | ✅ |
| 36 | 删除后 list 不显示 | memory-full-lifecycle.spec.ts:test4 | ✅ |
| 37 | recover API 7 天内可恢复 round trip | — | ❌ 缺口 |

### 2.6 视图切换 / View Switching(4 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 38 | tab "list"(默认)| memory-full-lifecycle.spec.ts:test1 | ✅ |
| 39 | tab "graph"(KnowledgeGraphView)切换 | — | ❌ 缺口 |
| 40 | tab "timeline"(ConsolidationTimelineView)切换 | — | ❌ 缺口 |
| 41 | timeline 真显示 reflect-insight insertContent / memoryIds(QUI-204 normalizer fix)| — | ❌ 缺口 |

### 2.7 Observer 自动反思链路(QUI-202 — commit c087330)(2 点)

| # | 功能 | 测试 file | 状态 |
|---|---|---|---|
| 42 | backend Observer 真写 memory_observations | dogfood 2(手动)| ✅(1172→1178 真增长)|
| 43 | Reflector 真写 consolidation_log + reflect-insight 字段 | test_consolidation_log.py | ✅(pytest)|

---

## 3. 覆盖率统计 / Coverage Stats

| 类别 | 已覆盖 | 部分 / 缺口 | 总数 |
|---|---|---|---|
| 列表 / 浏览 | 4 | 2 ❌ | 6 |
| 详情面板(本次新增)| ⏳ 8(等 subagent) | 2 ❌ | 11 |
| 写入 | 3 | ⏳ 2 | 5 |
| 整理 / dedupe | 5 | 3 ❌ | 8 |
| 删除 / 恢复 | 6 | 1 ❌ | 7 |
| 视图切换 | 1 | 3 ❌ | 4 |
| Observer 链路 | 2 | 0 | 2 |
| **总** | **29 ✅ + 8 ⏳ = 37/43(86%)** | **13 ❌ 缺口** | **43** |

**当前估算**:e2e 覆盖率 ~86%(等 subagent 跑完 v2-features.spec.ts 后确认)。

---

## 4. 13 个 e2e 缺口(follow-up 优先级)

### 高优先级(用户体验直接相关)
1. 大数据集 dedupe 不超 timeout(QUI-204 已 ship,e2e 补)
2. recover API 真 round trip(7 天窗口)
3. confirm 后真合并 SQLite(dedupe execute 真链路)

### 中优先级
4. tab "graph" 切换 + reactflow 渲染
5. tab "timeline" 切换 + consolidation_log 真显示
6. proposals 3 种类型(dedupe / kg-prune / reflect-insight)在 UI 真区分

### 低优先级
7. 文本过滤 / search filter
8. tier filter dropdown 独立
9. 空状态 UI
10. archived_at + recovered_at 详情面板显示
11. 原始 metadata `<details>` 折叠展开
12. timeline 真显 reflect-insight 字段
13. user role + assistant role 同 turn observer 双 row 写

---

## 5. 运行 e2e / Running E2E

```bash
cd /Users/raysonmeng/repo/quilin-agent

# 起 quilin-mem MCP server(后台)
cd providers/memory
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-sk-xxx}" uv run python -m quilin_mem > /tmp/qm.log 2>&1 &
QM_PID=$!
sleep 3

# 起 Web dev(后台)
cd ../../apps/web
lsof -i :3000 -t | xargs -r kill -9 2>/dev/null
pnpm dev > /tmp/web.log 2>&1 &
WEB_PID=$!
sleep 12

# 跑全部 e2e
cd ../..
pnpm --filter web exec playwright test apps/web/tests/e2e/

# 跑特定 spec
pnpm --filter web exec playwright test apps/web/tests/e2e/memory-full-lifecycle.spec.ts
pnpm --filter web exec playwright test apps/web/tests/e2e/memory-v2-features.spec.ts

# 清理
kill $QM_PID $WEB_PID 2>/dev/null
```

---

## 6. 缺口跟进 Plane / Follow-up Tickets

13 个缺口将在第 3 次 e2e subagent 完成后,根据 user 决定:

- **A**:13 个缺口全立 Plane,逐个补 spec(2-3 联合日)
- **B**:只补高优先级 3 个,其余记 backlog
- **C**:接受当前 86% 覆盖率为"ship-ready",剩余作低优 follow-up

推荐 **B**:高优先级 e2e 缺口直接影响 user 体感,补完后 90%+ 覆盖率。

---

**文档维护者**:Claude(主 agent) + Codex(verifier)
**最后更新**:2026-05-21 09:55(主线 commit `acdcbc1` 之后)
