# 术语表（Glossary）

> **D-10 / R-08（2026-04-18，2026-04-30 复核）**：本文件是 Quilin Agent 文档的**规范术语源**，由 `scripts/lint-glossary.py` 与 `markdown-link-check` 在 CI 中强制检查。新增/修改术语请先改本文件，再扫描全库对齐。

## 一、命名基准 / Naming Baseline

| 术语 | 规范写法 | 反模式（禁用） | 说明 |
|------|---------|---------------|------|
| 项目名 | **Quilin Agent** / **Quilin** | quilin-agent（code id 除外）、Qilin Agent、麒麟 Agent（非项目名） | 中文「麒麟」仅作文化释义；项目标识一律用 `Quilin` |
| 项目词源 | `Quilt` + `Qilin` = **Quilin** | — | readme §「命名由来」 |
| 核心记忆系统 | **quilin-mem** | OmniMem、Omni Memory、OmniMemory、omnimem、omni-mem | 对外 prose / docs / site 一律用 `quilin-mem`；legacy Python package/import、MCP module name、env prefix 兼容项留到 QUI-88 后续阶段迁移 |
| 记忆层级 | **working / episodic / semantic / skill**（小写） | short / mid / long / ultra、Working / Episodic / Semantic / Skill | FEA-04 收敛：quilin-mem tier 词表统一为 working/episodic/semantic/skill；config key 也用小写 |
| Skill 按需加载工具 | **`skill_view`** | `skill_load`、`skill_read`、`loadSkill` | C-02 收敛；Skill 通过名字触发加载 |
| Skill 管理工具 | **`skill_manage`** | `skill_cud`、`skills_guard` | `skills_guard` 专指 B3b 安全校验层，不是工具名 |
| Agent 间协作（异构） | **Agent Mesh** / **AgentMesh SDK** | agent-mesh-network、mesh-net | 11-agent-mesh 领域；Rust daemon 名 `meshd` |
| Agent 协作（同构） | **Sub-Agent** / **Multi-Agent** | sub agents（带空格）、child agent | 06-multi-agent 领域内部 spawn |
| Model Context Protocol | **MCP** | mcp、M.C.P. | 全大写；`MCPRegistry` 等类型名驼峰 |
| Harness 顶层概念 | **Harness Engineering**（英文）/ **脚手架工程**（中文直译） | 脚手架架构、Harness 框架 | [harness-engineering.md](./harness-engineering.md) |

## 二、范围计数 / Scope Counts

| 项 | 当前值 | 规划值 | 来源 |
|----|-------|-------|------|
| 活跃工程领域 | **12** | 12 | `01..11 + 13`（`12-conversation-engineering` 已 D-05 降级为 `02-context/conversation-engineering/` 子模块，parked） |
| Parked 子模块 | 1 | — | `02-context/conversation-engineering/` |
| `upstreams/` 子模块实际数量 | **21**（2026-04-30 复核） | `~100`（规划上限） | `git submodule status \| wc -l`；文档引用 `~100` 时必须注明为规划数而非当前数 |
| Benchmark 历史锚定榜单 | **3（冻结历史事实）** | — | Iter E 曾锚定 SWE-bench Verified / GAIA / BFCL v4；[14 Benchmark Harness](../14-benchmark-harness/README.md) 已冻结 Benchmark，不再作为活跃路线图口径 |
| Iter 阶段 | A..F | A..F | [STATUS.md](../STATUS.md) |
| Iter B 子阶段 | B1 / B2 / B3a / B3b | — | B3a = Skills Core 窄收口；B3b = Activation |

> **Writing convention**: when citing `~100`, write "planned ceiling ~100, actual 21" if the sentence describes current state; use "~100 (planned)" only for the long-term target.
>
> **写作约定**：引用 `~100` 时如果指当前状态应写 "规划上限 ~100，实际 21"；如果仅指长期目标可写 "~100 (planned)"。

## 三、容易漂移的专名 / Drift-Prone Names

| 术语 | 规范 | 注意 |
|------|------|------|
| Claude Code | **Claude Code** | Anthropic 官方 CLI；本项目 Claude 侧 runtime |
| Codex | **Codex** | OpenAI Codex agent runtime |
| Codex CLI | **Codex CLI** | 特指 Codex 的 CLI 表面；与 Codex runtime/agent 区分（C-14）。**叙述 runtime 能力用 "Codex"；叙述命令行表面用 "Codex CLI"。** |
| Gemini CLI | Gemini CLI | Google Gemini 的 CLI runtime |
| Hermes / OpenClaw | Hermes、OpenClaw | 大小写严格 |
| ACI | **ACI**（Agent-Computer Interface） | 首次出现要展开 |
| KG | **KG**（Knowledge Graph） | — |
| KV-cache | KV-cache | 全文连字符 |
| E-T-C-S-L-V | E-T-C-S-L-V | 历史六分类；当前组件映射见 [Core Loop](./README.md) |
| Harness-only 基准 | Harness-only 基准 | [harness-engineering.md §十](./harness-engineering.md#十核心度量) |
| Deferred Tools | **Deferred Tools** | Claude Code 风格的按需加载 tool schema 机制：system prompt 只暴露工具名 + 一句描述；具体 schema 由 agent 通过 `ToolSearch` 在需要时拉取。用于降低首轮 token 成本。见 [05-tool §2.5](../05-tool/README.md)。 |

## 四、实现状态标签 / Implementation Status Labels

| 标签 | 含义 | 证据口径 |
|------|------|------|
| ✅ 已实现 | 代码已合入 `packages/` 或 `providers/` | 以 `packages/agent-core/src/index.ts` 或 `providers/memory/src/omnimem/server.py` 等当前代码路径为准 |
| 🚧 进行中 | 有活跃 Iter 票据且代码部分落地 | 以 Linear `QUI-` 记录加当前代码路径为准 |
| 💭 未开始 | 仅 spec，无代码 | 以对应 `docs/<component>/README.md` 当前说明为准 |

Usage rule: every "unique advantage / capability / feature" list must label each item; unlabeled bare lists are forbidden.

使用规范：任何 "独特优势 / capability / feature" 列表都要逐条标注，禁止无标签裸列。

## 五、权限模型常用词 / Permission Model Terms

| 术语 | 规范 |
|------|------|
| READ-ONLY | 默认权限：只读 + 写前询问 |
| AUTO tier | `--trust auto` 显式开启的 session 级自动批准（非 CRITICAL）|
| CRITICAL / HIGH / MEDIUM / LOW | 4 级操作风险；CRITICAL 永远需要人类批准 |
| Two-Strike | 安全失败两次即升级人审（07-safety）|
| Human-in-loop | Scaffold patch / 融合 PR 必须走 |
| **`WriteAuthority`** | 07 §2.6.4 权限模式的**运行时执行器**；所有 agent-initiated writes（shell_exec / file_write / scaffold patch / skill_create / idle evolution）必须经其决策。规范写法：类型名 `WriteAuthority` / `WriteRequest` / `WriteDecision` / `AuthorityMode`。反模式禁用：`WriteGate`、`AuthorityGate`、`ExecutionGate`（§2.6 已有 ExecutionGate 概念词，指 Layer 2 的工具步骤验证，与 WriteAuthority 是**不同层**，不要混用）|
| `origin` 字段 | `WriteRequest.origin: "user" \| "agent" \| "idle"`——`idle` 发起的写在 `ask` 模式下强制 deny |

## 六、与 Fusion（上游融合）相关 / Fusion Terms

| 术语 | 规范 |
|------|------|
| 上游 / upstream | 指 `upstreams/*` 的 submodule |
| Fusion PR | 人审融合 PR（**不是**自动缝合 patch）|
| `sync-upstreams.py` | diff 侦察脚本；只生成报告，不改代码 |
| Self-Evolution | 10-self-evolution 的路径：轨迹分析 + scaffold 改进提议（默认 OFF，opt-in）|
| Idle Evolution | Self-Evolution 的空闲子集：每日预算、永远不自动 apply |

## 七、新增与变更流程 / Change Process

1. 修改本文件，PR 说明漂移点（引证 C-01..C-14 或文档 path）。
2. CI 运行 `scripts/lint-glossary.py` —— 本文件作为白名单，反模式（第二列"禁用"）在文档中出现即 fail。
3. CI 运行 `markdown-link-check`（R-08）—— 锚点 / 跨文件链接失效即 fail。
4. 本文件更新后，同步扫描全库修正对应漂移（通常 1 PR 内完成）。

---

**最后复核 / Last reviewed：** 2026-04-19（Opus 4.7 review，D-10 / R-08 landing + FEA-04 tier alignment）
