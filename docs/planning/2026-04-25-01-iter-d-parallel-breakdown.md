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
| Day 0 | ADR-008 / ADR-009 / 本计划 | ✅ 完成 | `56b7a46` | 3 files / 619 insertions / TS 488 + Python 155 + AMB p95 0.261ms 不回归 |
| Day 0 | 25-01 §17 全部残余项归属 + 25-02 sweep plan + §15 状态回写 + 00-impl-plan 顶部更新 + Blocked 段 | ✅ 完成 | `5aeeaa2` | 4 files / +187/-15 / TS 488 + Python 155 不回归 |
| Day 0 | 25-01 §4-§5/§7/§8/§11 第一轮范围细化（Codex review 反馈：loop.ts 文件名修正 / S-wire 同步点 / Newton 第一轮钉死 TS-only / Kelvin 第一轮 owns index.ts / Curie 加 Cargo.lock + test-all 纳入 test-rs） | ✅ 完成 | `29c093d` | 1 file / +76/-30 |
| 第一轮 Kelvin（schema/loader/env） | `smol-toml` 1.6.1 + `user-config-schema.ts` (145 LOC) + `user-config.ts` (522 LOC) + `user-config.test.ts` (247 LOC, 21 tests) | ✅ 完成 | `630fce2` | tsc 0；biome 147 clean；`pnpm test` = 63 files / 509 passed；`index.ts` wire 留至 Kelvin tail |
| 第一轮 Newton（TS-only span provider） | `observability/span.ts` + `log.ts` + `context.ts`（AsyncLocalStorage）+ `loop.ts` 五层埋点 + `mcp-client.ts` `_meta.request_id` placeholder + 测试（5 文件新增，4 文件改动）| ✅ 完成 | `3cf2a9a` | tsc 0；biome 154 clean；`pnpm test` = 66 files / 518 passed（488 基线 + 21 Kelvin + 9 Newton）；`wc -l loop.ts` = 199（CC-01 < 200 守住）；无 `@opentelemetry` 依赖、无 exporter、无旧 `agent.node` 残留；语义修正：一次 `runAgentLoop` 只产生一个 `agent.turn` + `request_id` |
| 第一轮 Curie（Rust mesh-sdk stub + CI） | `Cargo.toml` workspace root + `Cargo.lock` + `crates/mesh-sdk/{Cargo.toml,src/lib.rs}` + `justfile`（build-rs/test-rs，test-all 含 Rust）+ `.github/workflows/ci.yml`（stable Rust + cargo check --workspace 强制）+ `quilin.md` Rust 措辞 | ✅ 完成 | `fd44e2d` | `just build-rs` 0；`just test-rs` = 1 passed；`just test-all` = TS 518 + Python 155 + Rust 1 全过；无外部 Rust crates 依赖 |
| 第一轮 Kelvin tail（index.ts wire） | `config/runtime.ts`（新，72 LOC：bootstrap + 单例 accessor）+ `config/runtime.test.ts`（新，6 tests）+ `index.ts` 顶部调 `bootstrapUserRuntime()` 把 user-config / OTelSpanProvider / StructuredLogger 串起来；启动日志附 `user_config` 段 | ✅ 完成 | `c4775d6` | tsc 0；biome 156 clean；`pnpm test` = 67 files / 524 passed；`just test-all` 三语言全过 |
| 第二轮 Kelvin CLI（slice-two）| `cli/config-cmd.ts`（新，356 LOC）+ `config-cmd.test.ts`（新，17 tests）+ `index.ts` `dispatchCli()` 拦截 `config` subcommand | ✅ 完成 | `ed8a39c` | tsc 0；biome 158 clean；`pnpm test` = 68 files / 541 passed（基线 524 + 17 CLI）；`quilin config show/--source/set` 实测路径覆盖 |
| 第二轮 Boyle B1（slice-two scratchpad core + TS client）| `omnimem/scratchpad.py`（新，独立 SQLite table + TTL + per-task LRU + 跨 task 隔离）+ `tests/test_scratchpad.py`（5 tests）+ `memory/scratchpad-client.ts`（新，MCP wrapper + runtime config consumer + Null fallback）+ `scratchpad-client.test.ts`（7 tests）。Executor 集成按共识降级第三轮（Plan/Step 类型未稳）| ✅ 完成 | `000ca33` | `pytest tests/test_scratchpad.py` = 5 passed；ruff clean；`pnpm test scratchpad-client.test.ts` = 7 passed；biome clean；server.py MCP method 集成留 N2 合并 |
| 第二轮 Newton N2（exporter + Python ingest + traceparent + M1.4 dual-emit）| `observability/exporters/`（json-file + composite + tests，新）+ `observability/context.ts` 加 W3C traceparent 序列化 + `mcp-client.ts` `_meta.traceparent/request_id` 携带 + `omnimem/event_log.py` 加 trace 列 + dual-emit + `omnimem/event_log_schema.py` 扩展 + `omnimem/server.py` 解析 traceparent + child span 回写 + `scratchpad_*` MCP methods 一并合并 | ✅ 完成 | `eef2e7a` | tsc 0；biome 164 clean；ruff clean；`pnpm test` = 71 files / 551 passed；`pytest` = 166 passed；`just test-all` = TS 551 + Python 166 + Rust 1；AMB 100k p95 = 16.577ms（≤ 300ms，后续复跑确认该值是 cold-cache 噪声）；`wc -l loop.ts` = 199 |
| 第二轮 review gate | 全套验证 + 写边界硬隔离实证 + 跨轨道契约一致性 + AMB 100k recall gate p95 ≤ 300ms（仅 recall 路径，**不作为** M1.4 dual-emit latency 证据；dual-emit 单独 smoke 是 follow-up）| ⏳ 待启动 | — | Newton N2 commit 后启动 |
| 第三轮 Boyle B2（Executor scratchpad 集成）| `types.ts` 加 `SubTaskScratchpad` 可选字段 + zod schema；`executor.ts` 加 `ExecutorScratchpadClient` 本地结构化接口 + optional scratchpadClient option + pre-tool-call 注入 readKey 值 + post-tool-call 写 writeKey + clearOnSuccess 清 writeKey??readKey + tool 失败不写 + scratchpad client 异常降级 local_repair；`executor.test.ts` 加 55 步长链 fixture + 边界（未声明不注入 / 失败不写 / schema optional 兼容）| ✅ 完成 | `0ebe7ec` | tsc 0；biome 164 clean；`pnpm test` = 71 files / 555 passed（基线 551 + 4 新增）；ADR-005 layer enum 未碰；observability/config/scratchpad.py/scratchpad-client.ts 未碰；state.ts 未碰；`just test-all` TS 555 + Python 166 + Rust 1；AMB 100k p95 ~0.237ms（与第一轮 0.261ms 持平，N2 commit message 的 16.577ms 是 cold-cache 噪声非回归）|
| 跨轨道交叉 review（R1）| Codex 派独立 subagent 跨 Newton + Kelvin + Curie + Boyle 四轨道 review，覆盖 7 commits（`630fce2` → `eef2e7a` 第二轮 + `0ebe7ec` 第三轮）；Plan §17 残余归属再核；Codex 主线复核 subagent 结论后完成 follow-up fix pass | ✅ 完成 | 报告 `d18daf5` + fix `eed0a00` | 报告：`docs/review/2026-04-25-01-iter-d-cross-track-review.md`；follow-up 修复 exporter REPL flush + Kelvin `config set` 0600 拒绝路径 + Python dual-emit attribute 命名 + `memory_store` traceparent + 真实 stdio trace 覆盖；残余风险：FastMCP response traceparent 暂走 JSON payload 而非 envelope metadata（SDK 不支持，文档化降级）；验证：tsc 0；biome clean；ruff clean；`pnpm test` = 71 files / 557 passed；`uv run pytest` = 167 passed；`just test-all` = TS 557 + Python 167 + Rust 1；AMB 100k p95 = 0.294ms |
| 95% 覆盖率门槛新约束（用户 2026-04-25 提出，凌驾 common/testing.md 80% 默认）| 装 `@vitest/coverage-v8` + `pytest-cov`；vitest config 加 thresholds 95；pyproject 加 cov-fail-under=95；按缺口补测试（TS Branches 79.88% → 95% + Python TOTAL 91% → 95%） | ⏳ 进行中 | — | 当前实证（HEAD `eed0a00` 前）：TS Statements 88.59% / Branches 79.88% / Functions 91.47% / Lines 88.83%；Python TOTAL 91% (2401/215)；短板：TS branches 是最大缺口；Python `__main__.py` 0% / `logging.py` 67% / `store_serialization.py` 78% / `store_filters.py` 79% / `server.py` 83% |
| R2 复核 + Iter D 主轴最终收口 | Codex 派第二个独立 subagent 复核 R1 全部 finding 已修；BLOCKING/HIGH 0；MEDIUM ≤ 1；测试覆盖率 ≥ 95%；plan §17 残余归属再核 | ⏳ 待启动 | — | 95% 覆盖率达成后启动 |
| 25-02 cleanup sweep（Iter D 收口后）| `kg.py` (530) / `retriever.py` (535) 拆分；S8 文档收口（如需要）| ⏳ 待启动 | — | Iter D R2 通过后启动 |

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

**写边界（第一轮 — TS only）**：`packages/agent-core/src/observability/**`（新） + `packages/agent-core/src/loop.ts` / `loop-tool-calls.ts` / `loop-types.ts`（仅添加 span 埋点；实证文件名为 `loop.ts` 而非 `agent-loop.ts`，CC-01 < 200 LOC 契约由本文件守住）+ `packages/agent-core/src/planning/executor.ts` / `llm/*.ts` / `tools/*.ts`（仅 wrap span）+ 对应 tests。

**写边界（第二轮 — exporter + Python + M1.4）**：上述 + `packages/agent-core/src/observability/exporters/**`（新）+ `providers/memory/src/omnimem/event_log.py`（trace 列 + dual-emit）+ `providers/memory/src/omnimem/server.py`（MCP traceparent 解析）+ 对应 tests。

**第一轮硬隔离**：Newton **不碰** `index.ts`（第一轮归 Kelvin owns，见 §5 写边界 + §8 S-wire）；Newton 第一轮 read-only `index.ts`。

### 4.1 任务明细（第一轮 — TS-only span/log API + 埋点）

> **第一轮范围钉死**：TS 内存 span provider + structured log API + `loop.ts` 五层埋点 + 测试。**不含** exporter / Python trace ingest / MCP traceparent 跨进程传递 / M1.4 dual-emit（这些全部留第二轮，见 §4.1b）。

| 任务 | 写文件 | DoD |
|---|---|---|
| `OTelSpanProvider` 骨架（**内存实现**） | `packages/agent-core/src/observability/span.ts`（新） | Span 创建/嵌套/end；attribute key 验证（按 ADR-008 §3.2/§3.3 枚举）；trace/span id、attributes、events、parent-child 接口设计完整；**不引** `@opentelemetry/api` SDK（避免与 Kelvin 依赖叠加，留第二轮真 SDK 接入选择） |
| 五层 span 埋点 | `loop.ts` / `loop-tool-calls.ts` / `loop-types.ts` / `planning/executor.ts` / `llm/*.ts` / `tools/*.ts` | 按 ADR-008 §3.1 包裹五层（agent.session/turn/state_node/llm.invoke/tool.invoke）；attribute 必填字段全部写入；`loop.ts` 加埋点不得超过 CC-01 < 200 LOC 硬契约（当前 191 LOC，可写入预算 ≤ 9 行；超出必须把埋点抽到独立模块 import） |
| `request_id` 注入 | `loop.ts` + `tools/mcp-client.ts` | 一轮 turn 内 `request_id` 唯一；MCP 调用 metadata 携带 placeholder（第二轮接 traceparent 完整传递）；`loop.ts` 同上 LOC 预算约束 |
| Structured JSON log | `packages/agent-core/src/observability/log.ts`（新） | 按 ADR-008 §3.5 schema；stdout 输出；level 由 `observability.log_level` 控制（Kelvin 第一轮 schema 落地后 wire；第一轮可用默认 `INFO`）|

### 4.1b 任务明细（第二轮 — exporter + Python + M1.4）

| 任务 | 写文件 | DoD |
|---|---|---|
| `json_file_exporter` | `packages/agent-core/src/observability/exporters/json-file.ts`（新） | 写 `.logs/traces-YYYY-MM-DD.jsonl`；append 模式；并发安全 |
| `composite_exporter` | `packages/agent-core/src/observability/exporters/composite.ts`（新） | 包装多个 exporter；任一失败不阻塞其他 |
| Python trace ingest | `providers/memory/src/omnimem/event_log.py` | 增加 `trace_id` / `request_id` / `span_id` 列；MCP request 入口解析 `metadata.traceparent` |
| Python span 写入 | `providers/memory/src/omnimem/server.py` | MCP request 处理时建本侧 span；response 回写 traceparent |
| **M1.4 event_log OTel bridge** | `providers/memory/src/omnimem/event_log.py`（dual-emit 模块） | 检索/引用样本 dual-emit 到 OTel span event（attribute key 遵循 ADR-008）；SQLite 仍是 reranker 训练真相源；OTel 失败不阻塞写库；放第二轮**末尾**（依赖 OTelSpanProvider + Python trace ingest 就绪后接入）；AMB 100k 仅作为 recall gate p95 ≤ 300ms，不证明 dual-emit latency |

### 4.2 Newton DoD

**第一轮 DoD（TS-only）**：

- `pnpm test` 覆盖 5 层 span 创建 + attribute 必填校验 + parent-child 嵌套 + events 写入
- `pnpm test` 覆盖 structured JSON log schema 必填字段 + level 阈值
- `pnpm tsc --noEmit` exit 0；`pnpm exec biome check src` 0
- `loop.ts` LOC 实证 `wc -l` ≤ 200（CC-01 硬契约）；超出必须 abort 并把埋点抽到 helper 模块
- `request_id` 在一轮 turn 内唯一性测试

**第二轮 DoD（exporter + Python + M1.4）**：

- `pnpm test` 覆盖 `json_file_exporter` 并发写入 + `composite_exporter` 部分失败不阻塞
- `uv run pytest` 覆盖 `event_log` 新增列读写 + `metadata.traceparent` 解析
- 一次端到端 turn 在 `.logs/traces-*.jsonl` 中产出完整五层 span 链
- TS / Python 两侧产出的 log 行 `trace_id` 相同（实证：单元测试 + 集成测试）
- AMB 100k benchmark p95 ≤ 300ms（recall gate；不作为 M1.4 dual-emit latency 证据，dual-emit latency 由 event_log targeted test / 后续 smoke 覆盖）

---

## 5. Kelvin 轨道（Config 统一）

**写边界（第一轮 — schema/loader/env/wire）**：`packages/agent-core/src/config/user-config.ts`（新） + `packages/agent-core/src/config/user-config-schema.ts`（新） + `packages/agent-core/src/index.ts`（**Kelvin owns 第一轮**：wire user-config + Newton OTelSpanProvider + Newton structured log）+ 对应 tests。**禁止**修改现有 `config/loader.ts`（capability YAML loader 已 §16.4 闭合）。

**写边界（第二轮 — CLI）**：上述 + `packages/agent-core/src/cli/config-cmd.ts`（新）+ `--config` 入口 + 对应 tests。

**第一轮硬隔离**：Kelvin 第一轮**不接** CLI 参数（capability loader 已用 `--config`，避免冲突；CLI 留第二轮）；Newton 第一轮 read-only `index.ts`，wire 由 Kelvin 写。

### 5.1 任务明细（第一轮 — schema/loader/env + index.ts wire）

> **第一轮范围钉死**：smol-toml 接入 + UserConfigSchema zod + 四级合并 loader（CLI/env/file/default）+ env 映射 + 权限校验 + `index.ts` wire（含 Newton OTelSpanProvider + structured log consumer）。**不含** CLI 命令（`quilin config show/set` 留第二轮）。

| 任务 | 写文件 | DoD |
|---|---|---|
| TOML parser 接入 | `packages/agent-core/package.json` + `pnpm-lock.yaml` | 引入 `smol-toml`；锁版本 |
| `UserConfigSchema` zod | `config/user-config-schema.ts`（新） | 顶层 namespace 全部覆盖（ADR-009 §3.4）；strict mode；`observability.log_level` 默认 `INFO` |
| 四级合并 loader | `config/user-config.ts`（新） | CLI > env > file > default 合并；schema 校验；返回 `{ config, sources }` |
| env var 映射 | 同上 | `OMNI_*` → 点路径；类型按 schema 解析；歧义按最长 prefix 匹配 |
| 文件权限校验 | 同上 | `0600` 校验；`*_api_key/*_token/*_secret` 字段名拒绝 |
| `index.ts` wire | `packages/agent-core/src/index.ts` | `main()` 顶部 load user-config；按 `observability.log_level` 初始化 Newton structured log；按需 wire OTelSpanProvider；不破坏现有 capability loader / SkillsManager / MCPClient 实例化路径 |

### 5.1b 任务明细（第二轮 — CLI）

| 任务 | 写文件 | DoD |
|---|---|---|
| `quilin config show` CLI | `cli/config-cmd.ts`（新） | 输出当前生效值；`--source` 显示来源（CLI/env/file/default） |
| `quilin config set` CLI | 同上 | 写入 `~/.quilin/config.toml`；首次写入设 `0600`；schema 校验 |
| `--config` 覆盖支持 | 同上 + `index.ts` | 自定义路径加载；不存在时不报错（与 `~/.quilin/config.toml` 一致） |

### 5.2 Kelvin DoD

**第一轮 DoD（schema/loader/env/wire）**：

- `pnpm test` 覆盖：四级合并优先级、env var 映射、schema 校验、权限拒绝、敏感字段拒绝
- `pnpm tsc --noEmit` exit 0；`pnpm exec biome check src` 0
- `index.ts` wire 不破坏现有 488 TS 测试基线
- 现有 capability YAML loader 测试全部通过（无回归）

**第二轮 DoD（CLI）**：

- `quilin config show` 输出可消费 JSON + `--source` 标注来源
- `quilin config set llm.default_model claude-opus-4-7` 实测写入正确
- `--config <path>` 覆盖路径生效

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
| Executor 集成 | `packages/agent-core/src/planning/executor.ts` | step context 读写 scratchpad；step 结束按策略清理。**降级为 concern 留第三轮**（Codex 第二轮发现：当前 Plan/Step 类型没有 scratchpad key/value 语义，强 wire 会固定一个不稳的契约；先把 scratchpad 核心 + MCP + TS client 做稳，第三轮再扩 Plan step 字段做 executor 集成） |
| Config 消费 | `~/.quilin/config.toml` `memory.scratchpad.*` | 默认 `ttl_sec=3600` / `capacity_per_task=1024`（条数） |

### 6.2 Boyle DoD

- `uv run pytest` 覆盖：write/read/clear / TTL 过期 / capacity LRU / 跨 task 隔离
- `pnpm test` 覆盖：`ScratchpadClient` + `NullScratchpadClient` fallback + Executor 集成
- 一次端到端 long-running task 实测 scratchpad 工作（不污染 working/episodic memory）
- AMB 100k benchmark 不回归（p95 仍低于 `300ms`）

---

## 7. Curie 轨道（Rust stub + CI）

**写边界**：`crates/mesh-sdk/`（新） + `justfile` + `.github/workflows/ci.yml` + `Cargo.toml` workspace root（如需要）+ `quilin.md`（Rust 措辞同步）。**禁止**写任何 mesh 实质代码。

### 7.1 任务明细

| 任务 | 写文件 | DoD |
|---|---|---|
| Workspace 骨架 | `Cargo.toml` workspace root + `Cargo.lock` + `crates/mesh-sdk/Cargo.toml` + `crates/mesh-sdk/src/lib.rs` | 空 trait stub；**保持无外部 crates 依赖**；`cargo check --workspace` 通过；`Cargo.lock` 同 commit 落地 |
| `justfile` 命令 | `justfile` | `just build-rs` / `just test-rs`（noop 测试套件可通过）；`just test-all` **必须纳入** `test-rs`（Rust 从 Iter D 起正式进 workspace）|
| CI matrix | `.github/workflows/ci.yml` | stable Rust job 加入；`cargo check --workspace` 强制通过；`cargo test --workspace` 允许 noop（按 §00-impl-plan §310 D-14 NEW-13 对齐） |
| CLAUDE.md 调整 | `quilin.md` | "Rust 不存在"措辞改为"Rust mesh-sdk stub 已落地"；保留"实质代码留 Iter F"约束 |

### 7.2 Curie DoD

- 本地 `just build-rs` 通过；`just test-rs` 通过（noop）
- CI 全部 job 绿（TS / Python / Rust）
- `quilin.md` 文档与实际代码状态一致（git 实证）

---

## 8. 跨轨道同步点

| 同步点 | 触达轨道 | 内容 |
|---|---|---|
| S1：trace 字段 | Newton ↔ Boyle | MCP `metadata.traceparent / tracestate / request_id` 解析与回写一致；event_log 列名一致；M1.4 dual-emit OTel span event 但**不替代** SQLite（SQLite 仍是 reranker 训练真相源）；**第二轮闭合** |
| S2：config schema | Kelvin ↔ Newton/Boyle | `observability.*` 与 `memory.scratchpad.*` 字段名、默认值、热更新边界对齐；**第一轮 Kelvin schema 落地后 Newton/Boyle consume** |
| S3：log schema | Newton ↔ Kelvin | `observability.log_level` 控制 structured log level 阈值；**第一轮**：Kelvin schema → `index.ts` wire → Newton consumer |
| **S-wire：`index.ts` 写权** | Kelvin ↔ Newton | **第一轮 `index.ts` 由 Kelvin owns**；Newton read-only；wire user-config + OTelSpanProvider + structured log 由 Kelvin 写；Newton 第一轮**不碰** `index.ts` |
| S4：CI 矩阵 | Curie | TS / Python / Rust 三 job 共存；`cargo check --workspace` 强制；任一失败阻塞 merge；**第一轮闭合** |

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

> 范围钉死：三路并行；Newton 与 Kelvin 在 `index.ts` 上 S-wire 同步（Kelvin owns）；Curie 完全独立。

- **Newton 起步（TS-only）**：`OTelSpanProvider` 内存实现 + 五层 span 埋点（loop.ts/loop-tool-calls.ts/loop-types.ts/planning/llm/tools）+ structured log API + `request_id` placeholder。**不含** exporter / Python ingest / MCP traceparent / M1.4 dual-emit。
- **Kelvin 起步（schema/loader/env + wire）**：`UserConfigSchema` zod + 四级合并 loader + env 映射 + 权限校验 + `index.ts` wire（含 Newton consumer）。**不含** CLI 命令。
- **Curie 一次过（量小）**：`crates/mesh-sdk/` workspace + `Cargo.lock` + `justfile`（含 `test-all` 纳入 `test-rs`）+ CI matrix + `quilin.md` Rust 措辞同步。**保持无外部 Rust crates**。

### 11.3 第二轮并行切片

> Newton 第一轮 land 后才能开始第二轮（exporter 依赖 span provider）；Kelvin 第二轮独立于 Newton 推进。

- **Newton 收尾（exporter + Python + M1.4）**：`json_file_exporter` + `composite_exporter` + Python `event_log.py` trace ingest + Python `server.py` traceparent 解析 + **M1.4 event_log OTel bridge dual-emit**（末尾接入）+ S1 同步实证（端到端 turn `.logs/traces-*.jsonl` + AMB 100k recall gate p95 ≤ 300ms 不回归；AMB 不作为 dual-emit latency 证据）
- **Kelvin 收尾（CLI）**：`quilin config show/set` CLI + `--config` 覆盖支持 + S2 同步实证
- **Boyle 起步**：`Scratchpad` 模型 + MCP methods + TS client（依赖 Newton 第一轮 trace 上下文 + Kelvin 第一轮 `memory.scratchpad.*` schema）；**Executor 集成降级为 concern**，留第三轮（Codex 判断：当前 Plan/Step 类型没有 scratchpad key/value 语义，第二轮强 wire 会固定不稳契约）

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
