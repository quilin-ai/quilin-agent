# Iter D 并行任务拆分

> **状态**: Draft（Day 0 待开工）
> **日期**: 2026-04-25
> **owner**: Quilin Agent 团队
> **前置**: Iter C / Iter M 主线 ✅（HEAD `94c5894`）；ADR-008 Observability Span Schema；ADR-009 Config Cascade

本文是 Iter D 启动的执行清单。规范源以 ADR-008 / ADR-009 为准；与本文档冲突时以 ADR 为准。

进度记录与实证只允许写到 §0；任务定义放在 §3-§7。本文遵循 `agent-bridge.md` 的状态声明实证纪律。

---

## 0. 实证基线

### 0.1 入场状态（HEAD `94c5894`）

- 分支：`master`
- 工作树：本计划 + ADR-008 + ADR-009 三份文档为 untracked，待本轮提交；其他文件 clean
- 测试基线：
  - `cd packages/agent-core && pnpm tsc --noEmit` exit `0`
  - `cd packages/agent-core && pnpm test` = `62 files / 488 passed`
  - `cd packages/agent-core && pnpm exec biome check src` = `144 files clean`
  - `cd providers/memory && uv run pytest -q` = `155 passed`
  - `cd providers/memory && uv run ruff check src tests` clean
- AMB 100k benchmark：p95 `0.261ms`（硬门槛 `300ms`，远低于门槛）
- ADR-008 / ADR-009 草案已起草，待本轮 commit 入库

### 0.2 进度记录区

> 后续每轮切片落地后回填 commit hash 与实证。本节按 `2026-04-23-01-iter-c-m-parallel-breakdown.md §0.1` 的表格风格记录。

| 轮次 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Day 0 | ADR-008 / ADR-009 / 本计划 | ⏳ 待 commit | — | — |

---

## 1. 当前共识

- Iter D 主轴是 **§08 Observability + §09-lite Config**；§03-memory Phase 0（per-task scratchpad）作为 Iter E1-c 前置并行推进；Rust 仅落 `crates/mesh-sdk/` stub + CI matrix。
- 不引入 LangGraph / DSPy / 任何外部 agent 框架。
- 不在 Iter D 启动 mesh-sdk 实质代码（留 Iter F），不实现 DockerSandbox / CloudSandbox（留 Iter D 后期或 Iter F），不实现 cost-router（C3.6 defer Iter E）。
- OTel exporter 本 Iter 只内置 `json_file` + `composite`；Langfuse / Jaeger / Prometheus 留 hook，不强制实现。
- TOML parser 选 `smol-toml`（user-level config）；capability YAML 仍按 §16.4 决议保留手写 mini parser（项目级），二者 namespace 隔离。
- ADR-006 已被 plan §1 第 168 行预留给 L3a 成本条件部署 qualifier，本 Iter 不占用；ADR-008 / ADR-009 是新编号。

---

## 2. 不做事项

- 不在本 Iter 实现 mesh-sdk 实质代码（仅 stub + CI matrix）。
- 不实现 sandbox 完整体（DockerSandbox / LocalSandbox / CloudSandbox）。
- 不实现完整的 §08 exporter 矩阵；仅 `json_file_exporter` + `composite_exporter` 必选。
- 不让 `~/.quilin/config.toml` 写入任何 API key；运行时只从 env 读取（ADR-009 §3.3）。
- 不破坏现有 capability YAML 加载（§16.4 决议保留）。
- 不在本 Iter 恢复 `iter-e-parked` 分支的 E1-c；Iter D 主轴稳定后再恢复。
- 不冻结完整 `config.toml` schema；只冻结顶层 namespace（ADR-009 §3.4），细则留实现轨道。
- 不实现 config 热更新 admin API（仅冻结边界，调用方式留 Iter D 后期）。

---

## 3. Day 0 契约冻结

Day 0 是单线串行步骤；契约未冻结前不允许并行轨道开工。

### 3.1 ADR-008 Observability Span Schema

冻结内容（详见 [ADR-008](../adr/adr-008-observability-span-schema.md)）：

- 五层 span 命名：`agent.session` / `agent.turn` / `agent.state_node` / `llm.invoke` / `tool.invoke`
- Attribute key 命名规范（snake_case + 单位后缀 + 枚举显式）
- 必备 attributes 最小集（每层）
- Trace context 跨进程传递：MCP `metadata.traceparent` / `metadata.tracestate` / `metadata.request_id`
- Structured JSON log schema（`timestamp / level / component / event / trace_id / span_id / request_id`）
- Exporter 最低实现：`json_file_exporter` + `composite_exporter`

### 3.2 ADR-009 Config Cascade

冻结内容（详见 [ADR-009](../adr/adr-009-config-cascade.md)）：

- 路径：`~/.quilin/config.toml`，可由 `--config` 覆盖
- 格式：TOML 1.0；TS parser 用 `smol-toml`
- 四级合并：CLI > env > file > 内置默认
- env 前缀 `OMNI_`，路径分隔 `_`，API key 不走前缀
- 顶层 namespace：`llm / memory / observability / session / tools / idle_evolution / safety`
- 热更新边界：`llm.temperature` / `observability.log_level` / `tools.*` / `idle_evolution.*` / `safety.trust_mode`（仅收紧）允许；其他必须重启
- 安全约束：`0600` 权限、拒绝带 `*_api_key/*_token/*_secret` 字段名的 TOML 文件

### 3.3 跨契约共识

- ADR-008 `observability.*` 配置项 ↔ ADR-009 `observability` namespace：log_level、tracing endpoint、metrics port 由 Kelvin 轨道实现 loader，由 Newton 轨道实现 consumer。
- ADR-008 MCP `metadata.traceparent/request_id` ↔ ADR-005 已有 metadata 字段：traceparent / request_id 与 ADR-005 的 `schema_version / source / score / staleness` 共存于同一 metadata namespace，新字段不冲突。
- ADR-009 `memory.scratchpad.*` ↔ Boyle 轨道：scratchpad TTL / capacity 配置项由 Kelvin 提供 schema，由 Boyle 消费。
- ADR-008 trace context ↔ M1.4 event_log：`event_log.py` dual-emit OTel span event；SQLite 保持 reranker 训练真相源，OTel 只是从同一事件生产者并行导出，不替代。详见 §4 Newton 任务 `M1.4 event_log OTel bridge`。

---

## 4. Newton 轨道（Observability 主轴）

**写边界**：`packages/agent-core/src/observability/**` + `packages/agent-core/src/agent-loop.ts`（仅添加 span 埋点）+ `providers/memory/src/omnimem/event_log.py`（仅添加 trace 列）+ 对应 tests。

### 4.1 任务明细

| 任务 | 写文件 | DoD |
|---|---|---|
| `OTelSpanProvider` 骨架 | `packages/agent-core/src/observability/span.ts`（新） | Span 创建/嵌套/end；attribute key 验证；不依赖具体 SDK，先用内存实现，留 OTel SDK 接口 |
| 五层 span 埋点 | `agent-loop.ts` / `planning/executor.ts` / `llm/*.ts` / `tools/*.ts` | 按 ADR-008 §3.1 包裹；attribute 必填字段全部写入 |
| `request_id` 注入 | `agent-loop.ts` + `tools/mcp-client.ts` | 一轮 turn 内 `request_id` 唯一；MCP 调用 metadata 携带 |
| Structured JSON log | `packages/agent-core/src/observability/log.ts`（新） | 按 ADR-008 §3.5 schema；stdout 输出；level 由 `observability.log_level` 控制 |
| `json_file_exporter` | `packages/agent-core/src/observability/exporters/json-file.ts`（新） | 写 `.logs/traces-YYYY-MM-DD.jsonl`；append 模式；并发安全 |
| `composite_exporter` | `packages/agent-core/src/observability/exporters/composite.ts`（新） | 包装多个 exporter；任一失败不阻塞其他 |
| Python trace ingest | `providers/memory/src/omnimem/event_log.py` | 增加 `trace_id` / `request_id` / `span_id` 列；MCP request 入口解析 `metadata.traceparent` |
| Python span 写入 | `providers/memory/src/omnimem/server.py` | MCP request 处理时建本侧 span；response 回写 traceparent |
| **M1.4 event_log OTel bridge** | `providers/memory/src/omnimem/event_log.py`（dual-emit 模块） | 检索/引用样本 dual-emit 到 OTel span event（attribute key 遵循 ADR-008）；SQLite 仍是 reranker 训练真相源；OTel 失败不阻塞写库；放 Newton **后半段**（依赖 OTelSpanProvider + Python trace ingest 就绪后接入） |

### 4.2 Newton DoD

- `pnpm test` 覆盖 5 层 span 创建 + attribute 必填校验
- `pnpm test` 覆盖 `json_file_exporter` 并发写入
- `uv run pytest` 覆盖 `event_log` 新增列读写 + traceparent 解析
- 一次端到端 turn 在 `.logs/traces-*.jsonl` 中产出完整五层 span 链
- TS / Python 两侧产出的 log 行 `trace_id` 相同（实证：单元测试 + 集成测试）

---

## 5. Kelvin 轨道（Config 统一）

**写边界**：`packages/agent-core/src/config/user-config.ts`（新） + `packages/agent-core/src/cli/config-cmd.ts`（新） + `packages/agent-core/src/index.ts`（仅 wire）+ 对应 tests。**禁止**修改现有 `config/loader.ts`（capability YAML loader）。

### 5.1 任务明细

| 任务 | 写文件 | DoD |
|---|---|---|
| TOML parser 接入 | `package.json` + `pnpm-lock.yaml` | 引入 `smol-toml`；锁版本 |
| `UserConfigSchema` zod | `config/user-config-schema.ts`（新） | 顶层 namespace 全部覆盖（ADR-009 §3.4）；strict mode |
| 四级合并 loader | `config/user-config.ts`（新） | CLI > env > file > default 合并；schema 校验；返回 `{ config, sources }` |
| env var 映射 | 同上 | `OMNI_*` → 点路径；类型按 schema 解析；歧义按最长 prefix 匹配 |
| 文件权限校验 | 同上 | `0600` 校验；`*_api_key/*_token/*_secret` 字段名拒绝 |
| `quilin config show` CLI | `cli/config-cmd.ts`（新） | 输出当前生效值；`--source` 显示来源（CLI/env/file/default） |
| `quilin config set` CLI | 同上 | 写入 `~/.quilin/config.toml`；首次写入设 `0600`；schema 校验 |
| `--config` 覆盖支持 | 同上 + `index.ts` | 自定义路径加载；不存在时不报错（与 `~/.quilin/config.toml` 一致） |

### 5.2 Kelvin DoD

- `pnpm test` 覆盖：四级合并优先级、env var 映射、schema 校验、权限拒绝、敏感字段拒绝
- `quilin config show` 输出可消费 JSON
- `quilin config set llm.default_model claude-opus-4-7` 实测写入正确
- 现有 capability YAML loader 测试全部通过（无回归）

---

## 6. Boyle 轨道（Memory Phase 0 Scratchpad）

**写边界**：`providers/memory/src/omnimem/scratchpad.py`（新） + `providers/memory/src/omnimem/server.py`（仅添加 MCP method） + `packages/agent-core/src/memory/scratchpad-client.ts`（新） + `packages/agent-core/src/planning/executor.ts`（仅添加 wire）+ 对应 tests。

### 6.1 任务明细

| 任务 | 写文件 | DoD |
|---|---|---|
| `Scratchpad` 模型 | `omnimem/scratchpad.py`（新） | `task_id / session_id / key / value / created_at / ttl_sec` 字段；SQLite 表（独立 table，不复用 `memory_items`） |
| TTL / capacity 清理 | 同上 | 后台清理任务（与 `idle_budget` stub 复用调度）；超 capacity 时 LRU 驱逐 |
| MCP methods | `omnimem/server.py` | `scratchpad_write` / `scratchpad_read` / `scratchpad_clear`；遵循 ADR-008 trace 传递 |
| `ScratchpadClient` | `packages/agent-core/src/memory/scratchpad-client.ts`（新） | TS 客户端；`NullScratchpadClient` fallback |
| Executor 集成 | `packages/agent-core/src/planning/executor.ts` | step context 读写 scratchpad；step 结束按策略清理 |
| Config 消费 | `~/.quilin/config.toml` `memory.scratchpad.*` | 默认 `ttl_sec=3600` / `capacity_per_task=1024`（条数） |

### 6.2 Boyle DoD

- `uv run pytest` 覆盖：write/read/clear / TTL 过期 / capacity LRU / 跨 task 隔离
- `pnpm test` 覆盖：`ScratchpadClient` + `NullScratchpadClient` fallback + Executor 集成
- 一次端到端 long-running task 实测 scratchpad 工作（不污染 working/episodic memory）
- AMB 100k benchmark 不回归（p95 仍低于 `300ms`）

---

## 7. Curie 轨道（Rust stub + CI）

**写边界**：`crates/mesh-sdk/`（新） + `justfile` + `.github/workflows/ci.yml` + `Cargo.toml` workspace root（如需要）。**禁止**写任何 mesh 实质代码。

### 7.1 任务明细

| 任务 | 写文件 | DoD |
|---|---|---|
| Workspace 骨架 | `Cargo.toml` workspace root + `crates/mesh-sdk/Cargo.toml` + `crates/mesh-sdk/src/lib.rs` | 空 trait stub；`cargo check` 通过 |
| `justfile` 命令 | `justfile` | `just build-rs` / `just test-rs`（noop 测试套件可通过） |
| CI matrix | `.github/workflows/ci.yml` | Rust job 加入；`cargo check` 强制；`cargo test` 允许 noop（按 §00-impl-plan §310 D-14 NEW-13 对齐） |
| CLAUDE.md 调整 | `quilin.md` | "Rust 不存在"措辞改为"Rust mesh-sdk stub 已落地"；保留"实质代码留 Iter F"约束 |

### 7.2 Curie DoD

- 本地 `just build-rs` 通过；`just test-rs` 通过（noop）
- CI 全部 job 绿（TS / Python / Rust）
- `quilin.md` 文档与实际代码状态一致（git 实证）

---

## 8. 跨轨道同步点

| 同步点 | 触达轨道 | 内容 |
|---|---|---|
| S1：trace 字段 | Newton ↔ Boyle | MCP `metadata.traceparent / tracestate / request_id` 解析与回写一致；event_log 列名一致；M1.4 dual-emit OTel span event 但**不替代** SQLite（SQLite 仍是 reranker 训练真相源） |
| S2：config schema | Kelvin ↔ Newton/Boyle | `observability.*` 与 `memory.scratchpad.*` 字段名、默认值、热更新边界对齐 |
| S3：log schema | Newton ↔ Kelvin | `observability.log_level` 控制 structured log level 阈值 |
| S4：CI 矩阵 | Curie | TS / Python / Rust 三 job 共存；任一失败阻塞 merge |

每轮收口前必须跑：`pnpm tsc --noEmit` + `pnpm test` + `pnpm exec biome check src` + `uv run pytest -q` + `uv run ruff check` + `cargo check`（Curie 落地后）。

---

## 9. 依赖拓扑

```
Day 0 契约（ADR-008 + ADR-009）
   │
   ├─→ Newton（Observability）─┐
   │                           ├─→ S1（trace）─→ Boyle
   ├─→ Kelvin（Config）────────┤
   │                           └─→ S2（config schema）─→ Newton + Boyle
   ├─→ Boyle（Scratchpad）─────→ S2
   │
   └─→ Curie（Rust stub + CI）（独立，与其他轨道无依赖）
```

Curie 可与任意轨道并行；Newton 与 Boyle 在 S1 同步点对齐 trace 字段；Kelvin 与 Newton/Boyle 在 S2 同步点对齐 config schema。

---

## 11. 建议执行顺序

### 11.1 第 0 天（契约冻结）

`smol-toml` 依赖入 lockfile + ADR-008 + ADR-009 + 本计划提交（一个 commit 或紧邻三个 commit）。

### 11.2 第一轮并行切片

- **Newton 起步**：`OTelSpanProvider` 骨架 + 五层 span 埋点 + structured log（不含 exporter）
- **Kelvin 起步**：`UserConfigSchema` + 四级合并 loader + env 映射（不含 CLI）
- **Curie 一次过**：workspace 骨架 + `justfile` + CI matrix（量小）

### 11.3 第二轮并行切片

- **Newton 收尾**：`json_file_exporter` + `composite_exporter` + Python trace ingest + **M1.4 event_log OTel bridge dual-emit** + S1 同步实证
- **Kelvin 收尾**：`config show/set` CLI + 权限校验 + S2 同步实证
- **Boyle 起步**：`Scratchpad` 模型 + MCP methods + TS client + Executor 集成

### 11.4 Review gate

参照 §16.6 / §16.7 风格：每轨道独立 review；contract 违反 BLOCKING；attribute key 漂移 HIGH；测试缺口 MEDIUM；其他 LOW。

---

## 12. 验收

### Iter D 主轴硬验收

- [ ] 一次端到端 turn 产出完整五层 span 到 `.logs/traces-*.jsonl`，TS / Python 两侧 `trace_id` 一致
- [ ] `quilin config show` 显示四级合并后的生效值与来源
- [ ] `quilin config set llm.default_model X` 写入 `~/.quilin/config.toml` 并被下次启动消费
- [ ] Scratchpad 在 long-running task 中工作，不污染 working/episodic memory
- [ ] AMB 100k benchmark 不回归（p95 < `300ms`）
- [ ] `cargo check` 在 CI 通过；`just build-rs` / `just test-rs` 本地通过
- [ ] 所有现有 TS / Python 测试基线（HEAD `94c5894` 实证）不回归

### 软验收

- [ ] structured log 与 OTel span 双向 lookup 验证（任一边都能找到对方）
- [ ] config 权限拒绝、敏感字段拒绝、env 映射歧义均有测试覆盖
- [ ] CI Rust job 平均运行时间 < 60s（避免拖慢主流程）

---

## 13. Blocked / Deferred

- **L3a 生产 observer（M1.1 / M0.9b）**：资源 blocked（`ANTHROPIC_API_KEY` unset / `ollama` absent / `:11434` 拒连接）；与 Iter D 无依赖。
- **DockerSandbox / LocalSandbox / CloudSandbox**：留 Iter D 后期或 Iter F；本计划不覆盖。
- **mesh-sdk 实质代码**：留 Iter F；ADR-011 / ADR-012 时再写。
- **Track D 残余大文件拆分**（实证 `kg.py` 530 / `retriever.py` 535；`store.py` 已 §16.1 拆分降至 491，闭合无需再拆）：归 **Iter D 收口后 C+M cleanup sweep**（`docs/planning/2026-04-25-02-c-m-cleanup-sweep.md`），避免 Newton 加 trace 列后再次变动。
- **Iter E1-c 恢复**：等 Newton + Boyle 收口后从 `iter-e-parked` 分支恢复。

---

## 14. 协作

按 `agent-bridge.md`：

- Codex 写代码：每轨道一组 commit-ready 摘要 + 测试实证；主线 commit 附 `Co-authored-by`
- Claude 主线 commit + planning 维护 + review gate
- 协作语言中文；状态声明必须实证；派 subagent 默认 `run_in_background`
- 长任务（预期 > 5 分钟）必须 subagent

---

## 15. References

- [ADR-008 Observability Span Schema](../adr/adr-008-observability-span-schema.md)
- [ADR-009 Config Cascade](../adr/adr-009-config-cascade.md)
- [ADR-005 Memory Contracts](../adr/adr-005-memory-contracts.md)（trace metadata 共存）
- [ADR-002 Project Skeleton](../adr/adr-002-project-skeleton.md)（§7 三语言运行时）
- [Iter C × Iter M 并行任务拆分](./2026-04-23-01-iter-c-m-parallel-breakdown.md)（§16.4 capability YAML 决议）
- [00-implementation-plan](./00-implementation-plan.md)（Iter D 范围）
- [08-observability](../engineering/08-observability/README.md)
- [09-deployment-runtime](../engineering/09-deployment-runtime/README.md)
- [03-memory](../engineering/03-memory/README.md)（Phase 0 / scratchpad）
- [`agent-bridge.md`](../../agent-bridge.md)（协作协议）
