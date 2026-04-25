# ADR-009: Config Cascade — `~/.quilin/config.toml` 四级合并契约

> **状态**: Proposed (Iter D Day 0 contract freeze)
> **日期**: 2026-04-25
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-002](./adr-002-project-skeleton.md)（Project Skeleton）

---

## 1. 状态

本文冻结 Quilin Agent 用户级运行配置 `~/.quilin/config.toml` 的位置、解析格式、合并优先级、环境变量映射与热更新边界，作为 Iter D §09-deployment-runtime lite 子集落地的规范源。

`docs/planning/2026-04-25-01-iter-d-parallel-breakdown.md` 是执行清单；与本文档冲突时，以本文档为准。

本文不冻结 sandbox / cloud provider 实现细节（属 §09 全集，留到 Iter D 后期或 Iter F），仅冻结配置格式与加载规则。

---

## 2. Context

Quilin 既需要项目级 capability 声明（B3a Skills / Tools 已用 YAML，§16.4 决议保留手写 mini parser），也需要用户级运行配置（默认模型、OTel endpoint、idle evolution 预算等）。两者混在同一格式会导致：

1. **Namespace 冲突**：capability YAML 与 user config 字段命名空间重叠（`tools.*` 在两边语义不同）。
2. **类型坑**：YAML 的隐式类型（`yes` → `true` / `NO` → `false` / `0123` → octal）在用户手写 user config 时容易出错；datetime 字段（如 `idle_evolution.allowed_hours`）需要原生支持。
3. **生态对齐**：`Cargo.toml` / `pyproject.toml` 已建立 user-facing config 用 TOML 的惯例。
4. **覆盖语义不清**：CLI / env / file / default 四级合并若不显式约定，调试时无法判断生效值的来源。

§09 spec 原文写的是 `config.yaml`，但 §00-impl-plan §288 与项目 CLAUDE.md 改写为 `config.toml`；本 ADR 把这次改写明确化。

---

## 3. Decision

### 3.1 文件位置与格式

| 项 | 决策 |
|---|---|
| 路径 | `~/.quilin/config.toml`（默认）；可由 `--config <path>` CLI 参数覆盖 |
| 格式 | TOML 1.0（[toml.io](https://toml.io)） |
| Parser（TS） | `smol-toml`（轻量、ESM 原生、TOML 1.0 完整） |
| 文件不存在时行为 | 不报错；只用 env + CLI + 内置默认 |

不引入 YAML / JSON / Markdown 作为 user-level 配置格式。capability YAML（§16.4）与本文件互不影响：capability YAML 描述项目内 skills/tools 注册，user config 描述运行时偏好，二者 namespace 隔离。

### 3.2 四级合并优先级

加载顺序从高到低：

1. **CLI 参数**（如 `--model claude-opus-4-7`）
2. **环境变量**（如 `OMNI_LLM_DEFAULT_MODEL=claude-opus-4-7`）
3. **`~/.quilin/config.toml`**（或 `--config` 指向的文件）
4. **代码内置默认**

合并规则：

- 标量字段直接覆盖。
- 数组字段直接覆盖（不做 deep merge）；如需追加，必须显式重写完整数组。
- Inline table / nested table 字段做**浅合并**：父 key 存在时合并子 key，子 key 冲突时高优先级覆盖。
- 缺失字段沉降到下一级。

### 3.3 环境变量映射

环境变量映射规则：

| 项 | 决策 |
|---|---|
| 前缀 | `OMNI_`（与 §09 spec 第 385-390 行保持一致） |
| 路径分隔 | `_`（`OMNI_LLM_DEFAULT_MODEL` → `llm.default_model`） |
| 大小写 | env 全大写；映射时全部转 lower |
| 嵌套层级 | 按 `_` 拆分，按现有 schema 树匹配；歧义时按 schema 中已有的最长 prefix 优先 |
| 类型解析 | 按 schema 声明类型解析；`true/false/yes/no/on/off` → boolean；`123` → int；`1.5` → float；其他 → string |

API key 不走 `OMNI_` 前缀，遵循各 provider 自身约定：

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- 其他 provider 自定义 key 名称

API key 永远不写入 `config.toml`，运行时只从 env 读取；写入文件视为安全违规。

### 3.4 Schema 与必填字段

本 ADR 不冻结完整 schema（属于 Newton/Kelvin/Boyle 轨道实现细节），但冻结以下顶层 namespace：

| Namespace | 用途 |
|---|---|
| `llm` | 默认模型、温度、thinking 配置 |
| `memory` | scratchpad TTL/capacity、archive 策略；细则见 §03-memory |
| `observability` | log_level、tracing endpoint、metrics port；细则见 ADR-008 |
| `session` | session db 路径、history token 上限 |
| `tools` | enabled/disabled 工具白/黑名单 |
| `idle_evolution` | 自进化开关、daily token budget、allowed_hours；默认 `enabled=false` |
| `safety` | WriteAuthority 模式、AUTO trust 选项；默认最严 |

新增顶层 namespace 必须修订本 ADR。

**不在本 ADR 预留的 namespace**：

- `mcp` / `skills`：当前仍归项目级 capability config（B3a Skills + MCP server registry），由项目内 YAML/registry 描述，不属于 user runtime config。在 `~/.quilin/config.toml` 增加同名/近名 namespace 会与 capability 层产生双写语义冲突。如未来确需 user-level 默认（例如默认启用的 skills 集合），通过新增 namespace 而非占坑实现——新增是兼容演进，不破坏既有配置。
- `multi_agent`：留到 Iter F supervisor / sub-agent 设计冻结后再加。本 Iter 不实现 multi-agent 运行时，过早预留会诱导 over-spec。

### 3.5 热更新边界

允许运行时热更新（无需重启）：

- `llm.temperature`（每轮调用可临时覆盖）
- `observability.log_level`
- `tools.enabled` / `tools.disabled`（会话级临时调整）
- `idle_evolution.enabled` / `idle_evolution.daily_budget_tokens`
- `safety.trust_mode`（仅允许从宽松收紧，不允许从严放宽——后者必须用户显式确认）

不允许热更新（必须重启）：

- `llm.default_model`（变更会破坏 cost 累计与 trace 一致性）
- `memory.*`（会破坏运行中的 scratchpad / archive 一致性）
- `session.*`（绑定 SQLite 连接）
- `observability.tracing.endpoint`（绑定 exporter 进程）

热更新接口由 §08 OTel + Iter D 后期 admin endpoint 提供；本 ADR 不规定具体调用方式。

### 3.6 安全约束

- `~/.quilin/config.toml` 文件权限默认 `0600`（用户可读写）；首次写入时必须 `chmod 0600`。
- 加载器拒绝读取权限 `> 0600` 的文件，提示用户修复权限后重试。
- 任何 `*_api_key` / `*_token` / `*_secret` 字段名出现在 TOML 里时，加载器必须报错并拒绝启动。
- `config show` CLI 输出时，对未来可能引入的敏感字段使用 `***REDACTED***` 占位（本 ADR 内置字段不含敏感字段，但保留机制）。

---

## 4. Consequences

### 正向后果

- 用户级配置与项目级 capability 配置格式完全分离，namespace 不冲突。
- TOML 显式类型避免 YAML 隐式类型踩坑，user 手写体验更稳。
- 四级合并规则显式可推导；调试时可通过 `quilin config show --source` 查询每个生效值的来源。
- API key 永不落盘，降低意外提交风险。

### 约束

- 引入 1 个新运行时依赖 `smol-toml`（agent-core）；CI / lockfile 必须固定版本。
- TOML schema 顶层 namespace 是硬契约，新增必须升级本 ADR。
- 热更新边界是硬约束，破坏性变更（如把 `llm.default_model` 改为可热更新）必须升级本 ADR 并补迁移路径。

### 后续工作

- Kelvin 轨道：`packages/agent-core/src/config/user-config.ts`（新建，与现有 `config/loader.ts` 的 capability loader 隔离）。
- Kelvin 轨道：`quilin config show` / `quilin config set` CLI 入口；`config show --source` 显示生效值来源。
- Kelvin 轨道：env var 映射器与类型转换器；权限校验。
- Boyle 轨道：scratchpad 配置项加入 `memory.scratchpad.*`。
- Newton 轨道：observability 配置项加入 `observability.*`，引用 ADR-008。

---

## 5. References

- [Iter D 并行任务拆分](../planning/2026-04-25-01-iter-d-parallel-breakdown.md) — Kelvin 轨道任务明细
- [ADR-002 Project Skeleton](./adr-002-project-skeleton.md) — §7 三语言运行时与日志约定
- [ADR-008 Observability Span Schema](./adr-008-observability-span-schema.md) — `observability.*` 配置消费方
- [09-deployment-runtime](../engineering/09-deployment-runtime/README.md) — §2.5 配置管理设计原型（spec 原文为 `config.yaml`，本 ADR 改写为 `config.toml`）
- [00-implementation-plan](../planning/00-implementation-plan.md) — Iter D 范围
- [`docs/planning/2026-04-23-01-iter-c-m-parallel-breakdown.md`](../planning/2026-04-23-01-iter-c-m-parallel-breakdown.md) — §16.4 capability YAML parser 决议（与本 ADR 互不影响）
