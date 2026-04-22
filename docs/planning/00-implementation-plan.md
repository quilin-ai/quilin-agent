# Quilin Agent 实现规划

> **状态（2026-04-22 实证更新）**：
> - Phase 0 ✅ v0.0.3 | Iter A ✅ v0.1.0-iter-a | **Iter B 进行中**
> - Iter B 当前落点：B1 ✅、B2 ✅、B3a ✅、**B3b ✅ Phase 0/1/2/3/4**。技能细节以 `docs/planning/2026-04-21-01-skills-b3b-activation.md` 和 `docs/engineering/13-skills/README.md` 为准。
> - `loop.ts` **191 LOC**（commit `776300e` 把 helpers 抽到 `loop-types.ts`，CC-01 <200 契约已守住；演进链 407 → 212 (`0464377`) → 191 (`776300e`)）
> - OmniMem L3a observer gate 仍失败（recall 21.4% / 中文 0%）；Iter D Sprint 0 决定 ML-first 或降级 opt-in
>
> **语言架构**：TS（核心）+ Python（ML Provider）。Rust（mesh / WASM / infra）延后到 Iter D，引入前以 [ADR-001](../adr/adr-001-core-loop-and-language.md) 为准。

## Context

旧 Python Harness 已删除（ADR-001 结论：不用 LangGraph，自研极简 Loop）。当前状态：

- **12 个活跃工程领域** spec 已完成（01..11 + 13-skills）；对话工程作为 **02-context 的 parked 子模块**，不计入活跃领域数
- ~100 个上游子模块已配置（精选，非全自动融合）
- 核心架构决策已定稿（ADR-001）
- Phase 0 已完成（v0.0.3）：Agent Loop + OmniMem MCP + REPL + 78 tests
- Iter A 已完成（v0.1.0-iter-a）：上下文工程 + 提示词工程（PromptBuilder, ContextAssembler, InjectionScanner, TemporalAwareness, MemoryBridge）+ 91 tests
- Iter B 进行中：B1 tool substrate ✅；B2 Safety Policy ✅（WriteAuthority + pre/post hooks + Two-Strike + classifier 均已合并）；B3a Skills Core ✅；B3b Activation 已完成 Phase 0/1/2/3/4（条件激活 + CRUD + skills_guard + post-compact 恢复 + file watcher 全部落地）

---

## 竞品核心能力对照

| 能力 | Claude Code | Codex | Manus | Hermes | OpenClaw | **Quilin 目标** |
|------|------------|-------|-------|--------|----------|----------------|
| Agent 循环 | TS→Rust, ~88 行 while-loop | Rust, Tokio async | 多 Agent 图编排 | Python 学习闭环 | TS, Pi agent RPC | 自研极简 Loop (< 200 行 TS) + E-T-C-S-L-V 能力层 |
| 工具系统 | 内置 8 种 + MCP | Shell + patch + MCP | Agent 专用工具 | 40+ 工具 + MCP | 插件 SDK + MCP | 内置 10+ + MCP 动态发现 + human-reviewed 自创工具 |
| 记忆 | CLAUDE.md + 会话内 | AGENTS.md + 会话内 | 无持久化 | 4 层 + 自进化 | Session + Context | 4 层分级 + 向量+KG + 自反思 |
| 浏览器 | 无（靠 MCP） | 无 | 全浏览器 + Computer Use | 无 | Canvas + A2UI | 5 种方案 + Zoom-In 两段式定位 |
| 沙箱 | 无 | OS 级隔离 | Docker | Docker/Daytona | K8s | Docker + 本地降级 |
| 自进化 | 无 | 无 | 无 | DSPy + GEPA | 无 | 轨迹分析 + **human-in-loop scaffold patch** + 技能自创 |
| 多 Agent | 并行 Sub-agent | 无 | 多角色 | 子 Agent | 多 Agent 路由 | 同构 + 异构（Iter D AgentMesh） |
| Mesh 互联 | 无 | 无 | 无 | 无 | 无 | Iter D 通过 AgentMesh SDK 接入 |
| 热更新 | 无 | 无 | 无 | 无 | 无（#1 投诉：更新不稳定） | 热更新 + 更新后主动告知 |
| Token 预估 | 无（断了才知道） | 无 | 无 | 无 | 无 | 任务前预估消耗 + 余量不足主动建议拆分 |
| 用户理解 | Auto Memory（被动） | 无 | 无 | Honcho 辩证式 | 无 | 主动画像收集 + 持续学习 + Aha Moment 引擎 |
| 时间感知 | 部分（凌晨提醒） | 无 | 无 | 无 | 无 | 三层时间感知 |
| 权限模式 | auto mode（手动开启） | Guardian AI | 无 | 预算隔离 | 工具审批 | **READ-ONLY 默认 + AUTO 需 opt-in + CRITICAL 强制确认** |
| 工具 CLI 覆盖 | 无 | 无 | 无 | 无 | 无 | CLI-Anything 集成 |
| Dashboard | 无 | 无 | 有（Web UI） | 无 | 有（Web Console） | 独立 WebUI Dashboard |
| Benchmark 验证 | 内部评测 | SWE-bench 参赛 | 内部 | 无 | 无 | **3 个 pinned：SWE-bench Verified / GAIA / BFCL v4** |
| 主线程不阻塞 | Sub-agent 并行 | 无 | 主线程会阻塞 | 无 | 无 | Supervisor 永不阻塞 + 进度汇报 |
| 空闲自进化 | 无 | 无 | 无 | 无 | 无 | **opt-in**：显式开启 + 日预算 + 透明汇报 |

## Quilin 独特优势

1. **融合 6 大模型架构精华** — 7 个跨模型设计模式内化进框架
2. **12 领域 × 精选上游 + AI 辅助融合 PR** — 持续进化，但每次融合都走 human-reviewed PR
3. **4 层分级记忆 + KG + 自反思** — 解决 OpenClaw 记忆失灵 + 跨项目污染
4. **Agent Mesh（Iter D）** — AgentMesh SDK 接入去中心化 Agent 通信
5. **热更新 + 主动通知** — 解决 OpenClaw/Hermes 更新断连痛点
6. **自进化带验证 + human-in-loop** — Scaffold 修改走 propose → review → apply，不自动 apply
7. **Agentic 人味（Iter F+ parked）** — 用户主动画像 + User Insight Engine，核心回路稳态后启动
8. **三层时间感知** — 理解"沉默"本身是信息
9. **显式权限分级** — READ-ONLY 默认；AUTO 仅在 `--trust auto` 显式开启后生效
10. **CLI-Anything 工具全覆盖** — GUI-only 工具自动生成 CLI wrapper
11. **WebUI Dashboard** — 独立全局可视化面板
12. **Benchmark 聚焦** — **3 个 pinned 榜单（SWE-bench Verified / GAIA / BFCL v4）**，其他作为 aspirational roadmap
13. **主 Agent 永不阻塞** — Supervisor 架构为默认
14. **空闲自进化（opt-in）** — 默认 OFF，显式开启后才使用闲置配额做记忆整合 / 浏览
15. **技能工程（编号 13 的活跃领域）** — SKILL.md + catalog + on-demand load，Skill ≠ Tool

> **早期宣传用词中的"God Mode"、"自动缝合发布"、"默认最大信任"、"每个榜单真实碾压"已在 2026-04-17 ultra-review 后收回** — 见 [review 报告](../review/2026-04-17-ultra-review.md)。

---

## 7 个跨模型设计模式

| # | 设计模式 | 来源 | 融入的组件 | 所在 Iter |
|---|---------|------|-----------|----------|
| 1 | 分层记忆 | UI-TARS-2, GLM-5.1 | OmniMem（4 层：working/episodic/semantic/skill） | F |
| 2 | 混合动作空间 | MAI-UI, UI-TARS-2 | ToolRouter（代码/浏览器/Shell/MCP 四类） | B |
| 3 | 自进化闭环 | MiniMax M2.7 | SelfEvolution（human-in-loop scaffold patch） | F |
| 4 | 两段式定位 | MAI-UI | BrowserProvider（Zoom-In 视觉模式） | F |
| 5 | 成本感知调用 | MAI-UI | InferenceConfig（按任务复杂度调参数） | C |
| 6 | 思考模式控制 | GLM-5.1 | ThinkingMode（thinking/non-thinking 动态切换） | C |
| 7 | 内建验证 | DeepSeek, UI-TARS-2 | Verifier（步骤验证 + 元验证） | C-D |

详见 [model-architecture-insights.md](../research/model-architecture-insights.md)

---

## 迭代路线图

> 对应 [ADR-001 迁移路径](../adr/adr-001-core-loop-and-language.md#5-迁移路径)。
>
> **核心原则**：先把单 Agent 做强，再做大。不按领域数量平铺推进，而按产品价值和依赖关系分 **A..F 六个迭代**递进。**Benchmark Ascent 被显式独立为 Iter E（拆 E1-E4）**，取代早期"贯穿各迭代、能力就绪即提交"的模糊承诺。

```
Phase 0 (PoC) ✅ — v0.0.3
    │
    ▼
Iter A: Grounded Context ✅ — v0.1.0-iter-a
    │  （02-Context 主轴 + 03-light 集成）
    │
    ▼
Iter B: Useful Tools + Skills + Safety（进行中）
    │  B1 工具基座 ✅ / B2 安全策略 ✅ / B3a Skills Core ✅ M0 / B3b Phase 0-4 ✅
    │
    ▼
Iter C: Planning Core
    │  04-Planning + 01-动态 InferenceConfig + 07-内建验证
    │
    ▼
Iter D: Operability + Rust 基础设施
    │  08-Observability + 09-lite 配置 + CI/CD
    │  + 引入 crates/mesh-sdk 骨架
    │
    ▼
Iter E: Benchmark Ascent （拆 E1 → E4） ⭐ NEW
    │  E1 Harness Infra / E2 SWE-bench Verified
    │  E3 GAIA + BFCL v4 / E4 Aspirational
    │
    ▼
Iter F: Scale-Out + Memory Depth + Self-Evolution
    │  06-MultiAgent + 11-AgentMesh + 10-SelfEvolution
    │  + 03-advanced（4 层 OmniMem 深化）
    │  + 12-Conversation Engineering（解冻，跟随 benchmark 稳定度）
    │
    ▼
（长期）持续融合精选上游 → human-reviewed PR 合入
```

**相对旧版（2026-04-17 之前）关键改动**：

| 旧 | 新 |
|----|----|
| Iter E = Memory Depth & Personality | Iter E = Benchmark Ascent（E1-E4） |
| Memory Depth 放 Iter E | 合并进 Iter F（与 Scale-Out / Self-Evolution 同期） |
| 12-Conversation Engineering 放 Iter E | Parked → Iter F+（core loop benchmark 稳后解冻） |
| Iter D CI 矩阵含 Rust | Iter D 引入 `crates/` 骨架 + Rust CI job（`cargo check` 强制通过；`cargo test` 允许 noop 套件） |
| Benchmark 贯穿各 iter | Iter E 为独立 benchmark iter |
| "全量 30+ benchmark 参赛" | 3 pinned + roadmap aspirational |

---

### Phase 0: 概念验证 (PoC) ✅ 已完成

**完成标记**：v0.0.3（2026-04-15）

已交付：
- TS 项目骨架（pnpm + tsconfig）
- 极简 Agent Loop（< 200 行 TS while-loop，LLM + tool dispatch + streaming + checkpoint）
- OmniMem Python MCP Server（store + recall + reset）
- TS Loop 通过 MCP stdio 调用 Python OmniMem
- OmniMem SQLite + FTS5 中文模糊检索
- REPL 交互界面 + session restore
- ToolRouter + MCP Client Bridge
- 47 TS tests + 31 Python tests 全绿

**涉及工程领域**：01-LLM 接入、02-上下文、05-工具（基础）

**关键架构决策（ADR-001 已定）**：
| 决策 | 选择 | 理由 |
|------|------|------|
| Agent 框架 | 不用 LangGraph，自研 | 四大标杆一致选择 |
| 核心语言 | TypeScript | Streaming 生态 + 前端同构 + MCP SDK 最成熟 |
| ML Provider | Python MCP Server | ML 库生态无可替代 |
| 跨语言通信 | MCP stdio | 90% 场景适用，~5ms 延迟 |
| 状态管理 | 消息数组 + SQLite checkpoint | "the only state is a message array" |
| LLM 抽象 | Vercel AI SDK v6 | 630M+ 周下载，25+ providers |
| Rust 引入时机 | Iter D | mesh / WASM 沙箱到位时再加 |

---

### Iteration A: Grounded Context ✅

**主轴**：`02-Context`　**搭配**：`03-light` 集成、`12-light` 基础

**完成标记**：v0.1.0-iter-a

**已交付**：
- System prompt 由多个 `ContextSource` 动态组装（identity / memory / session / environment / temporal / tool-hints / user-instructions）
- Token budget 管理（按 priority 填充 + 超限截断）
- Lost-in-the-Middle aware 排布
- memory recall 结果自动注入 context
- Temporal awareness 注入
- 91 TS tests 全绿

**涉及工程领域**：02-Context（主）、03-Memory（recall 集成）、01-LLM（context window 感知）

---

### Iteration B: Useful Tools + Skills + Safety（进行中）

**主轴**：`05-Tool` + `13-Skills`　**搭配**：`07-Safety-lite`

**为什么绑定推进**：工具和安全必须一起推——更强的工具没有安全分层 = 风险放大器。Skills（编号 13 的活跃领域）借用 05 的 ToolRouter 作为 host（但 Skill ≠ Tool），B3a 已在 B2 合并后紧跟落地。

**子阶段**：

#### B1 — Tool Substrate ✅（已合并）
- 多 MCP Server 连接管理（动态注册 / 发现 / 断线重连，工具名冲突 namespace 前缀）
- 内置工具：`file_read` / `file_write` / `file_list` / `shell_exec` / `web_fetch`
- 工具分类体系：`read` / `write` / `exec` / `high-risk`
- Tool 描述符注入 context 系统

#### B2 — Safety Policy ✅（已合并，持续加固）
- ✅ 权限分级：**READ-ONLY 默认 / AUTO opt-in（`--trust auto`）/ CRITICAL 强制确认**
- ✅ 工具执行前 pre-hook（检查分类 + 决定是否确认）
- ✅ 工具执行后 post-hook（记录执行结果 + 异常检测）
- ✅ 超时保护 + 错误恢复
- ✅ Two-Strike Rule（连续失败升级确认）
- ✅ 2-stage Classifier（意图识别层 + 影响评估层）
- ✅ WriteAuthority 单入口（shell_exec / file_write / scaffold patch / skill_create / idle evolution 统一路由；`85b898a` / `dc2e611` / `35f4c8d`）
- **⚠️ D-01 约束**：不建"God Mode 超级权限通道"；所有账号走同一条授权链路
- 🧪 Tiny-classifier spike：因 Codex 额度 blocker 降级到 Iter D 研究实验（`docs/research/tiny-llm-baseline/` 保留 baseline）

#### B3a — Skills Core ✅

- 已完成：M0 catalog 注入（`16f3868` / `d617e32`）与 M0.5 `skill_view` on-demand load（`0464377`）
- 当前仅保留状态摘要；M0 / M0.5 的细项与测试证据以 `docs/engineering/13-skills/README.md` 为准
- 契约缺口仍在：`skill_view` 返回 body 后的 outbound decoration 已由 B3b Phase 1-3 全面收口（条件激活 + CRUD + skills_guard 落在 read/write 两个边界）

#### B3b — Skills Activation(M1) ✅ Phase 0/1/2/3/4

**状态真相源**：`docs/planning/2026-04-21-01-skills-b3b-activation.md`。

| Phase | 范围 | 状态 |
|-------|------|------|
| **0** | Frontmatter schema v2 reader(`requiresTools` / `requiresToolsets` / `platforms` / `trust` + D-17 kebab-case 双向 alias + `metadata.quilin.*` 嵌套) | ✅ `bc93f42` |
| **1** | 条件激活 + KV-cache friendly catalog(稳定前缀 lex-sort + `<hot_skills>` ≤10 可变段,D-13) | ✅ `a9ef022` / `86f4512` / `338c607` |
| **2** | `skill_manage` CRUD + WriteAuthority 集成(R-01 critical,落盘单一 gate) | ✅ `b5a9474` / `a5140da` / `29d6c18` |
| **3** | skills_guard 内容扫描 + 4 级信任策略(builtin/trusted/community/agent-created) | ✅ `c2954f6` / `35886f3` / `0fae827` |
| **4** | Post-compact 恢复(保留最近 5 个 ≤25K token) + file watcher 热发现 | ⏳ pending(tracking doc `2026-04-22-07-skills-b3b-phase-4.md` 规划中) |

**Phase 0-4 已完成**：frontmatter schema v2 reader、条件激活 + stable prefix / hot_skills、`skill_manage` CRUD + WriteAuthority、skills_guard + 4 级信任策略 × 4 级严重度矩阵、post-compact 恢复（≤5/≤5K/≤25K）+ file watcher 生命周期（200ms debounce + catalog diff + cache eviction）全部落地。reader / trust 分层 / CRUD / guard / restore / watcher 细节留在对应 tracking doc，不在本计划文档重复展开。

**验证标准**：
- [x] B1 同时连接 ≥2 个 MCP Server
- [x] B1 内置工具 file_read / shell_exec / web_fetch 可用
- [x] B1 工具按 read/write/exec/high-risk 分类
- [x] B2 READ-ONLY 默认下 write 工具触发确认；`--trust auto` opt-in 后自动放行
- [x] B2 工具超时后 agent loop 正常恢复
- [x] B2 MCP spawn 命令白名单 + argv sanitization + cwd 沙箱（`e574338` / `1fe0cc1`）
- [x] B3a catalog 启动期建成 + `skill_view` 按需加载生效
- [x] B3a 恶意 symlink / oversize skill 被安全栈拒绝
- [x] B3b 条件激活 (Phase 1 ✅) + skills_guard (Phase 3 ✅)
- [x] B3b post-compact 恢复 + file watcher (Phase 4 ✅ `1f74adb` + `93141c5`)

**涉及工程领域**：05-Tool（主）、13-Skills（主）、07-Safety（基础）

**参考 spec**：[05-tool](../engineering/05-tool/README.md)、[13-skills](../engineering/13-skills/README.md)、[07-safety-guardrails](../engineering/07-safety-guardrails/README.md)

---

### Iteration C: Planning Core

**主轴**：`04-Planning`　**搭配**：`01-dynamic`（InferenceConfig 动态调整）+ `07-内建验证`

**为什么第三**：Planning 的价值建立在 context（A）和 tool space（B）之上。

> **Spec v1.1（2026-04-20）**：见 [04-planning/README.md](../engineering/04-planning/README.md)。核心变更：放弃三段式 L1/L2/L3 默认方案，改为 **Main LLM Direct 推理 + Gateway Skills descriptor + 可选 structured audit layer**；`IntentClassifier.dispatch()` 从 LLM response shape 推导 intent；local tiny classifier 降级为 Iter D 研究实验。

**范围**：

规划引擎（04）：
- 意图识别：Main LLM direct（response shape → structural dispatch）；Gateway Skills 按需展开
- 任务分解：将复杂任务拆成可执行的 step 序列（event-sourced PlanningState）
- Step / Retry budget
- 进度跟踪：每步执行后更新 state，支持中断恢复

动态推理配置（01-dynamic）：
- 按任务复杂度自动调整 InferenceConfig（temperature / maxOutputTokens）
- ThinkingMode 动态切换
- 成本感知：预估 token 消耗 + 余量不足建议拆分

内建验证（07）：
- 步骤验证器（每步 output 做基本合规检查）
- 元验证（整体 plan 执行完毕后的一致性校验）

**验证标准**：
- [ ] 简单问答不触发 planning，多步任务自动分解
- [ ] Step budget 生效
- [ ] 工具调用失败后自动重试（≤ retry budget）
- [ ] InferenceConfig 按任务类型动态切换
- [ ] Token 预估：任务前给出消耗预估

**涉及工程领域**：04-Planning（主）、01-LLM（动态配置）、07-Safety（步骤验证）

---

### Iteration D: Operability + Rust 基础设施

**主轴**：`08-Observability` + `09-lite` + **Rust 基础设施登场**

**为什么在这**：前三个迭代把单 Agent 做强后，扩展层（多 Agent / 自进化）没有 observability 不可调。Rust 在这一阶段引入，因为要开始考虑 mesh/WASM 沙箱的系统能力。

**范围**：

可观测性（08）：
- OTel 集成：每次 LLM 调用 / 工具调用 / agent loop 一个 span/trace
- Request ID 贯穿整个处理链路
- 结构化 metrics（token / 工具调用 / 延迟分布）

配置管理（09-lite）：
- 统一配置文件：`~/.quilin/config.toml`
- 环境变量覆盖
- `quilin config show` / `quilin config set` CLI 命令

CI/CD（工程保障）：
- GitHub Actions workflow：`.github/workflows/ci.yml`
  - TS：`bun run vitest run`（packages/agent-core）
  - Python：`uv run pytest`（providers/memory）
  - **Rust：`cargo check` 强制通过；`cargo test` 允许 noop 套件（crates/ 本 Iter 引入；D-14 2026-04-20 NEW-13 对齐）**
- Lint：Biome（TS）+ Ruff（Python）+ Clippy（Rust）

Rust 基础设施骨架：
- 新建 `crates/mesh-sdk/`（仍是 stub，但 workspace/justfile/ci 都接入）
- `justfile` 补 `just build-rs` / `just test-rs`
- CI 矩阵加 Rust job

Memory Sprint 0 Pre-Work（D-21 follow-up，**与 Iter D 主轴并行但不 block**）：
- **背景**：2026-04-20 spike v2-r3 结果 recall 21.4% / FPR 2.8% / p95 4.19ms（中文 recall 0%），未达 L3a 门槛（recall ≥ 40% / FPR < 5% / p95 < 10ms），详见 `docs/engineering/03-memory/README.md` §L3a 与 `docs/review/2026-04-20-opus-4-7-revisit.md` D-21
- **状态**：🚨 **gate failed, go/no-go pending**（Opus 4.7 Round 3 AA-01 升级为 CRITICAL）
- **本 Iter 允许动作**：用不超过 1 周 spike 验证 tier-1 rule-first observer（bilingual + multi-pattern + escalation-aware）能否过 40% recall 门槛
- **分支决策**：
  - 过 40% → 按 OmniMem v2 roadmap 进入 Iter F 记忆深度
  - 过不了 → 起草 `ADR-004`，二选一：(a) 切 ML-first（tier-2 tiny LLM 分类器提前到 Iter C 或并行）；(b) L3a 降级为 opt-in（用户主动开 observer 才跑）
- **不做**：任何 Iter F Memory Depth 的 4-tier 扩展代码；先拿到 L3a go/no-go

**验证标准**：
- [ ] LLM 调用和工具调用有 OTel span
- [ ] Request ID 贯穿完整调用链
- [ ] `~/.quilin/config.toml` 可配置 provider / model / 权限模式
- [ ] CI 在 GitHub Actions 上：TS + Python 测试全绿；Rust `cargo check` 强制通过，`cargo test` 允许 noop（D-14 2026-04-20 NEW-13 对齐）
- [ ] `cargo check` 通过，mesh-sdk workspace 结构可编译

**涉及工程领域**：08-Observability（主）、09-Deployment、11-Agent Mesh（骨架）

---

### Iteration E: Benchmark Ascent（拆 E1 → E4） ⭐

**定位**：把 benchmark 从"贯穿各 iter"这个模糊承诺显式化为一个独立迭代，拆成 4 步。

**为什么独立为一个 Iter**：
- 否则 benchmark 总被推迟
- Harness 工程的本质竞争力是在 **公开榜单**上可验证；不参赛等于没验证
- 3 个 pinned 榜单的 harness 配置差异很大，需要专门的基建

#### E1 — Benchmark Harness Infra
- `benchmarks/` 目录结构 + 通用 runner
- 任务加载器 + 评分器 + 结果收集器
- Submission pipeline（生成 leaderboard 提交包）
- Cost / latency tracking（每次 eval 记成本）
- 环境隔离（dockerize 或 per-task sandbox）

#### E2 — SWE-bench Verified ⭐ Pinned
- SWE-bench Verified harness 专项（500 真实 GitHub issue）
- 依赖：Iter B 文件/shell 工具 + Iter C planning + Iter D observability + **03-memory Phase 0 FTS5 + per-task scratchpad（D-15 2026-04-20 NEW-14 补）**
- **Memory 降级策略**：E2 baseline **不使用**跨会话 OmniMem 4 层（完整 4 层要到 Iter F）；仅依赖 per-task working set + SQLite FTS5；长轨迹溢出时用 episodic 摘要 stub
- 首次目标：**Top 20（≥75% 解决率）**；长期目标：Top 10（≥78%）
- 现状参考：2026-04 前 10 名在 77.8-80.9%

#### E3 — GAIA + BFCL v4 ⭐ Pinned
- **GAIA**：466 个多步推理 + 工具使用任务；首次目标 ≥35%（2026-04 第一名 44.8%）
- **BFCL v4**：工具调用准确率（单/多工具、多轮）；首次目标 overall ≥85%
- 两个榜单共享大部分 harness infra（E1 交付）

#### E4 — Aspirational Roadmap
- 视 E2/E3 稳定度决定启动哪些：
  - τ-bench / Terminal-Bench 2.0 / LiveCodeBench
  - WebArena / VisualWebArena（需 05-浏览器工具，依赖 Iter F）
  - AgentHarm / InjecAgent（需 07-Safety 完整体，Iter C 完成后）
  - OSWorld / Windows Agent Arena（需 desktop control，依赖 Iter F+）
- **E4 不承诺覆盖全部**；"每个榜单参赛"不是 planning-level 合约

**验证标准**：
- [ ] E1 benchmark runner 可跑通至少一个小样本（10 题 SWE-bench）
- [ ] E2 SWE-bench Verified 首次正式提交（不论排名）
- [ ] E3 GAIA 首次正式提交 + BFCL v4 首次正式提交
- [ ] E4 至少 1 个 aspirational benchmark 有 harness 草稿

**涉及工程领域**：所有 Iter A..D 的能力 + 08-Observability（cost/latency tracking）

---

### Iteration F: Scale-Out + Memory Depth + Self-Evolution

**主轴**：`06-MultiAgent` + `11-AgentMesh` + `10-SelfEvolution` + `03-advanced`　**搭配**：`12-Conversation`（解冻）

**前提条件**：单 Agent 已强（A/B/C）、稳（D）、有 benchmark 基线（E）。

**范围**：

多 Agent 编排（06）：
- 同构 spawn + 异构协作
- 非阻塞 Supervisor（主 Agent 永不阻塞，所有执行委派 Sub-Agent）
- Sub-Agent 进度汇报协议（Checkpoint + Heartbeat）
- WebUI 实时进度 + IM 主动推送

Agent Mesh 接入（11）：
- `crates/mesh-sdk/` 实现（Iter D 骨架 → Iter F 填肉）
- mesh.discover() / mesh.send() / mesh.receive()
- 能力声明与查询

记忆深度（03-advanced）：
- OmniMem 4 层分级（short → mid → long → ultra）
- 向量检索 + KG 三元组
- User Profile Store + auto-reflect
- 记忆去重 / 冲突检测 / 遗忘策略

自进化（10，**human-in-loop**）：
- 轨迹分析
- Scaffold patch proposal（**生成 patch 而非 auto apply**）
- 技能自创（自动封装重复模式 → Skill Memory，走 SkillManager.extract）
- User Insight Engine（基于积累数据产生洞察）
- **Idle Evolution（opt-in）**：显式 `--idle-evolve on` + 日预算上限 + 透明汇报；默认 OFF

对话工程（12，解冻于 Iter F）：
- 6 层活人感架构
- 3 种风格模式（native / custom / alive）
- 配置开关

**验证标准**：
- [ ] 主 Agent 派生 Sub-Agent 并行执行，主线程不阻塞
- [ ] mesh.discover() 能看到其他 agent
- [ ] 自进化运行 10+ 次，scaffold patch proposal 质量可评估；**人类 reviewer 决定是否 merge**
- [ ] User Insight Engine 产生用户洞察
- [ ] Idle Evolution 开启后运行，预算内完成，下次会话透明汇报
- [ ] 记忆自动从 short 提升到 mid；向量检索命中语义相似的历史记忆

**涉及工程领域**：06-MultiAgent、11-AgentMesh、10-SelfEvolution、03-Memory、12-Conversation、08-Observability（Dashboard）、09-Deployment（热更新）

---

## 模块依赖图

```
已具备底座（Phase 0）
├── 01-lite: Vercel AI SDK + StreamingLLMClient
├── 03-lite: SQLite + FTS5 OmniMem
├── 05-lite: ToolRouter + MCP Client Bridge
└── REPL / checkpoint / justfile / pino JSON 日志

核心智能层（Iter A → B → C，有依赖顺序）
├── 02-Context 是最中心的上游
│   ├── 消费 03-Memory（recall 结果注入 context）
│   ├── 直接影响 04-Planning（context 质量决定 plan 质量）
│   └── 也是 12-ConversationEng 的地基（Iter F 解冻）
├── 05-Tool + 13-Skills + 07-Safety 是三元绑定
│   └── 更强工具没 safety = 风险放大器；skills 借 ToolRouter 作 host
├── 04-Planning 依赖 02 + 05
└── 01-dynamic（InferenceConfig）横切并入 04

工程保障层（Iter D，含 Rust 基础设施首次引入）
├── 08-Observability 是 06/10/11 的前置
├── 09-Deployment 依赖一定程度的 08
├── CI 工程保障（Iter A 并行启动 TS+Py；Iter D 加入 Rust）
└── crates/mesh-sdk 骨架（Iter F 填肉）

Benchmark 验证层（Iter E 独立 iter）
├── E1 Harness Infra（依赖 08 cost tracking）
├── E2 SWE-bench（依赖 B 工具 + C planning + D obs）
├── E3 GAIA + BFCL（依赖 E1 + B + C）
└── E4 Aspirational（视 E2/E3 决定）

扩展层（Iter F，依赖单 Agent 已强+稳+可观测+有 benchmark 基线）
├── 06-MultiAgent 依赖 02/04/05/07/08
├── 11-AgentMesh 依赖 06 + 08 + 09 + D 阶段 crates/
├── 03-advanced 依赖 02（context 使用层先就位）
├── 10-SelfEvolution 依赖 07 + 08 + 09 + E（benchmark 做 eval 信号）
└── 12-ConversationEng 解冻（依赖 02 + 03 稳态）
```

---

## 12 活跃工程领域 × 迭代映射

| # | 领域 | Phase 0 ✅ | Iter A ✅ | Iter B 🚧 | Iter C | Iter D | Iter E | Iter F |
|---|------|-----------|--------|--------|--------|--------|--------|--------|
| 01 | LLM 接入 | LLMClient + Streaming | — | — | 动态 InferenceConfig + ThinkingMode | — | cost tracking 集成 | — |
| 02 | 上下文 | BasicContextManager（单源） | **多源组装 + budget + temporal** | tool descriptor 注入 | planning context 注入 | — | — | memory context 增强 |
| 03 | 记忆 | SQLite + FTS5 recall | recall 集成到 context | — | — | — | — | **4 层 + 向量 + KG + Profile** |
| 04 | 规划 | — | — | — | **意图识别 + 任务分解 + budget** | — | — | 动态重规划 |
| 05 | 工具 | ToolRouter + MCP Client | — | **B1 多 MCP + 内置工具 + 分类** | — | — | — | 浏览器 + CLI-Anything |
| 06 | 多 Agent | — | — | — | — | — | — | **同构 spawn + Supervisor** |
| 07 | 安全护栏 | — | — | **B2 ✅ READ-ONLY 默认 + hook + classifier + WriteAuthority 单入口** | 步骤验证器 | — | — | 红队自动化 |
| 08 | 可观测性 | pino JSON 日志 | — | — | — | **OTel + metrics + request ID** | cost/latency tracking | Dashboard + 进度面板 |
| 09 | 部署运行时 | justfile + REPL CLI | — | — | — | **配置管理 + CI 三语言** | — | 热更新 + 主动通知 |
| 10 | 自进化 | — | — | — | — | — | — | **轨迹分析 + human-in-loop patch + Insight + Idle(opt-in)** |
| 11 | Agent Mesh | — | — | — | — | **crates/ 骨架** | — | **mesh-sdk 填肉 + discover/send/receive** |
| 13 | 技能工程 ★ | — | — | **B3a ✅**：M0 + M0.5 已完成，细节见 `13-skills/README.md` | **B3b ✅ Phase 0-4**：条件激活 + CRUD + skills_guard + post-compact 恢复 + file watcher 全部落地（closure:`1f74adb` + `93141c5`） | — | — | M2+: plugin + background nudge（默认 OFF） |

### Parked (sub-module under 02-context)

| # | 领域 | 状态 |
|---|------|------|
| 02.x | 对话工程（原 12-） | **降级为 02-context 子模块**（2026-04-18 D-05）→ Iter F 解冻。核心回路在 Iter E benchmark 上稳态之前不启动"活人感"工程。spec 保留为研究笔记，见 [02-context/conversation-engineering](../engineering/02-context/conversation-engineering/README.md)。 |

> **★ 13-技能工程**：2026-04-17 新增领域；Iter B3 分成 **B3a Skills Core**（5 个窄收口能力）+ **B3b Activation**（条件激活 / post-compact），B3a 依赖 B2 安全契约冻结。详见 [13-skills/README.md](../engineering/13-skills/README.md)，四上游调研见 [skill-loading-comparison.md](../research/skill-loading-comparison.md)。

---

## Benchmark 参赛策略

**原则**：3 个 pinned 榜单是 Iter E 的 planning-level 合约；aspirational 榜单随 Iter F+ 能力解锁逐个启动，**不做"每一个榜单都参赛"的承诺**。

| Benchmark | 状态 | 前置能力 | 最早可参赛 |
|-----------|------|---------|-----------|
| **SWE-bench Verified** | ⭐ Pinned | 05-Tool（文件+命令）+ 04-Planning + 08-Obs | Iter E2 |
| **GAIA** | ⭐ Pinned | 02 + 04 + 05（完整 harness）+ 08-Obs | Iter E3 |
| **BFCL v4** | ⭐ Pinned | 05-Tool（多工具调用）+ 01-LLM | Iter E3 |
| τ-bench | Aspirational | 05-Tool | Iter E4 |
| Terminal-Bench 2.0 | Aspirational | 05-Tool（shell）| Iter E4 |
| LiveCodeBench | Aspirational | 05-Tool + 04-Planning | Iter E4 |
| AgentHarm | Aspirational | 07-Safety | Iter E4（Iter C 完成后） |
| InjecAgent | Aspirational | 07-Safety | Iter E4（Iter C 完成后） |
| WebArena | Aspirational | 05-Tool（浏览器）| Iter F |
| VisualWebArena | Aspirational | 05-Tool（浏览器 + 视觉） | Iter F |
| OSWorld | Aspirational | Desktop control | Iter F+ |
| ARC-AGI | Aspirational | 04-Planning（深度推理）| Iter F+ |
| HLE | Aspirational | 完整 harness | Iter F+ |
| ScienceAgentBench | Aspirational | 科研工具链 | Iter F+ |

**现状参考（2026-04）**：
- SWE-bench Verified：前 10 名 77.8-80.9%（Mythos 93.9% 为异常值）；首次 Top 10 门槛 ~78%+
- GAIA：第一名 44.8%；目标首次提交 ≥35%
- BFCL v4：SOTA overall ~90%+；目标首次提交 ≥85%

**综合/元 Leaderboard**（Iter F+ 同步追踪）：Epoch AI Capabilities Index, Scale SEAL, HELM, LMSys Arena, Vellum, Artificial Analysis, Onyx AI
