# Third-Slice Review — 2026-04-24

> 范围：§15 第三轮三路新代码：Halley `3b60904`、Hooke `77e399a`、Pascal `4496cb4`，外加 cross-cutting 反链闭合 `0b79520` 的状态核对。
> Reviewer：Codex（接手 Claude token exhausted 后的独立只读审计）。
> 方法：只读 git / 文件实证；不修改 `packages/` / `providers/`；本文件用于闭合 §16.6 Q2 follow-up gate。

## 总评

- 风险评分：**0.23（LOW）**。
- BLOCKING findings：**0**。
- HIGH findings：**0**。
- MEDIUM findings：**1（已修）**。
- LOW findings：**2（已修/已文档化）**。
- §16.6 gate：**可闭合**。三路功能声明与代码/测试基本一致；review 发现的问题已在后续补丁中处理。

## Findings

### [MEDIUM] Halley `writePlanReviewRecord()` 的 fallback logger 失败会继续向调用方抛出

**状态**：✅ 已修。`writeFallback()` 捕获 `eventLogger` 异常并返回 `logger_error_code`；新增 `eventLogger` reject 负测。

- **What**：`writePlanReviewRecord()` 在 memory client 缺失或 `client.store()` 失败时进入 fallback，但 `writeFallback()` 直接 `await options.eventLogger?.(fallback)`，没有捕获 logger 自身异常。只要 fallback hook 写本地 event log / telemetry 失败，调用方仍会收到异常。
- **Where**：`packages/agent-core/src/planning/memory-writer.ts:172` / `packages/agent-core/src/planning/memory-writer.ts:190`。
- **Why it matters**：commit message 声明 “Fallback paths for memory_unavailable / store_failed that never throw to caller（writer is advisory, not blocking）”。当前实现只吞 memory store 失败，不吞 fallback logger 失败；这和 ADR-005 advisory writer 边界不一致。
- **Evidence**：`packages/agent-core/src/planning/memory-writer.ts:186` 直接 await `eventLogger`；`packages/agent-core/src/planning/memory-writer.test.ts:100` 与 `packages/agent-core/src/planning/memory-writer.test.ts:119` 只覆盖 logger 成功路径，没有 logger reject 负测。
- **Suggested fix**：让 `writeFallback()` 捕获 `eventLogger` 异常并仍返回 `fallback`；可在 fallback record 上增可选 `logger_error_code`，但不要把 logger failure 抛给 planner 主路径。

### [LOW] Pascal 显式 config 路径跳过了旧 builtin REPL 的 eager MCP connect 语义

**状态**：✅ 已文档化。§16.6 明确 explicit config 使用 namespaced registry path，不等价于 builtin direct tools path。

- **What**：`source.kind === "builtin"` 仍走旧路径，在进入 REPL 前直接 `MCPClientManager.connect()` 并把 `tools` 传给 `startRepl()`；任何 CLI/env/project config 走 `mcpServers`，由 `startRepl()` 内部 `MCPRegistry.register()` 连接。
- **Where**：`packages/agent-core/src/index.ts:200` / `packages/agent-core/src/index.ts:223`；`packages/agent-core/src/repl.ts:311`。
- **Why it matters**：这是合理迁移路径，但“保留既有 REPL 行为”只对 builtin fallback 成立。显式配置即使只声明同一个 OmniMem server，也会进入新 registry path；错误日志、tool name namespace、connect timing 与旧路径不同。
- **Evidence**：`packages/agent-core/src/config/loader.integration.test.ts:121` 断言 config path 不直接 `mockConnect`，只把 `mcpServers` 传给 REPL；`packages/agent-core/src/tools/registry.ts:22` 会把 MCP 工具名改成 `namespace/tool`。
- **Suggested fix**：在 config loader docs / §16 follow-up 中明确“builtin preserves legacy direct tools; explicit config uses namespaced registry”。如果希望显式单 OmniMem 完全等价，需要补兼容模式测试和命名策略。

### [LOW] Hooke KG 递归查询未对 seed 列表去重，重复实体会浪费查询预算

**状态**：✅ 已修。`subgraph_search()` seed 归一为稳定去重列表；新增 repeated seed 测试。

- **What**：`_subgraph_search_sync()` 用 `seeds = [entity.casefold() for entity in entities if entity]` 保留重复 seed；recursive CTE 会为重复 seed 重跑同一子图，再由 Python 侧 `(edge_id, seed_entity)` 去重。
- **Where**：`providers/memory/src/omnimem/kg.py:288` / `providers/memory/src/omnimem/kg.py:393`。
- **Why it matters**：正确性影响低，但 `extract_entity_terms()` 已排序去重，直接调用 `subgraph_search()` 时重复 seed 会放大 SQL 工作量，且 `query_limit` 与 `len(seeds)` 成正比。
- **Evidence**：`providers/memory/src/omnimem/kg.py:300` 用 seed 数生成 `VALUES`；`providers/memory/src/omnimem/kg.py:389` 参数完整带入；`providers/memory/tests/test_kg.py:22` / `providers/memory/tests/test_kg.py:39` 未覆盖重复 seed。
- **Suggested fix**：把 seeds 归一为稳定去重列表，例如 `seeds = sorted({entity.casefold() for entity in entities if entity})`。

## §16.6 检查矩阵

| 路线 | 检查项 | 实证 | 结论 |
|---|---|---|---|
| Halley | `memory-writer.ts` 6 禁字段 | `hasForbiddenTransientFields()` 检查 `events/checkpoints/phase/budget/currentLeafId/plan`；测试覆盖 `events` 与 raw `PlanningState` | ✅ 主体通过；见 MEDIUM logger gap |
| Halley | sha256 stable id | `createHash("sha256").update(JSON.stringify({ createdAt, record })).slice(0, 12)`；固定 `now` 测试断言 id prefix | ✅ |
| Halley | MCP/store fallback | `client.store()` error 被转为 `fallback_logged`；logger failure 被记录为 `logger_error_code` 并不再抛给主路径 | ✅ |
| Halley | audit/goal-drift/replan 阈值 | `DEFAULT_GOAL_DRIFT_THRESHOLD = 0.65` 对齐 04-planning；ADR-004 的 Arm L `60/3/50` 是 L3a observer gate，不是 goal drift 阈值 | ✅ 无混用 |
| Halley | state reducer 纯性 | `applyEvent()` clone `events`，`checkpoint_saved` clone `checkpoints`，`goal_drift_detected` 只追加事件 | ✅ |
| Hooke | RRF 融合 | `_fuse_candidates()` 按 id 累加 RRF，working 优先拼接，BM25/vector/KG 去重 | ✅ |
| Hooke | KG recursive CTE | `graph.depth < ?`、visited string 防环、temporal `as_of` 条件覆盖 anchor + recursive 两段；重复 seed 已去重 | ✅ |
| Hooke | semantic guard | `planning_review` 强制 semantic/json/schema_version/run_id/payload 对齐；`planning_state` 禁 semantic；递归查 forbidden keys | ✅ |
| Hooke | §16.1 split 前状态 | `store.py` = `1036` LOC，已超过 800 soft line，状态声明正确 | ✅ follow-up 保留 |
| Pascal | 四级优先级 | `--config` > `QUILIN_CONFIG_PATH` > `.quilin/capabilities.yaml/json` > builtin；测试覆盖 CLI/env/project/builtin | ✅ |
| Pascal | REPL fallback | builtin path 保留旧 direct MCP connect；explicit config 使用 registry/mcpServers | ✅，LOW 记录语义差异 |

## 实证诚信专项

| 声明 | 实测 | 结果 |
|---|---|---|
| Halley commit exists | `git show --name-only 3b60904` 命中 12 个 planning 文件 | ✅ |
| Hooke commit exists | `git show --name-only 77e399a` 命中 7 个 src + 7 个 test 文件 | ✅ |
| Pascal commit exists | `git show --name-only 4496cb4` 命中 config loader/schema/types/index + fixtures/tests | ✅ |
| Cross-cutting HIGH-1 closed | `git show --name-only 0b79520` 命中 `03-memory/README.md` + `00-implementation-plan.md` | ✅ |
| LOC 表 | `wc -l` 得到：memory-writer 223 / audit 99 / goal-drift 152 / replan 233 / decompose 273 / state 242 / loader 398 / retriever 493 / kg 477 / server 186 / store 1036 / planning_integration 121 | ✅ |

## 后续建议

- Halley fallback logger 与 Hooke duplicate seed 已修复；Pascal explicit config 的 namespaced MCP registry 行为已记录。
- 后续仍可把 Pascal 行为补进 config loader 用户文档；当前 planning/review 文档已足够关闭本轮 finding。

§16.6 可以关闭；不要把这些 follow-up 作为进入下一轮切片的硬 blocker。
