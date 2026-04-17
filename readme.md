# Quilin Agent — 麒麟

> **Quilin** = Quilt（拼布）+ Qilin（麒麟）
>
> 一个由精选上游项目滋养、长期演进的自研 Agent 框架

**愿景**：把 harness（包裹在 LLM 外面的一切）做到极致，让任何模型都能超水平发挥。我们在 **12 个工程领域** 内追踪一批精选上游项目，由 `sync-upstreams.py` 侦察 diff，由 AI 辅助人类 reviewer 生成融合 PR — **不做自动 scaffold 重写**，每一次变更都走标准 human-reviewed PR 流程。

## 一句话定位

**Quilin = 极简 Agent Loop + 12 领域 harness + 两语言运行时 + AI 辅助的人在回路融合工作流**

不是 LangGraph 变体，不是 LangChain 上层封装，而是按 Harness Engineering 原则自研的一个可被人类主导演进的 Agent 操作系统。

## 核心架构

- **自研极简 Agent Loop**（< 200 行 TS while-loop）—— 不依赖 LangGraph / LangChain / AutoGen 等外部 Agent 框架
- **两语言运行时（Iter A..C）** —— TypeScript（Agent 核心 + E-T-C-S-L-V 六组件）+ Python（ML Provider 封装为 MCP Server）。**Rust**（mesh / WASM 沙箱）延后到 **Iter D**，当前 `crates/` 目录不存在。
- **Harness Engineering 顶层组织原则** —— LLM 是发动机，12 领域是整辆车
- **E-T-C-S-L-V 六组件** —— Execution / Tools / Context / State / Lifecycle / Verification 作为可调用能力层暴露给 LLM，而非固定状态图节点
- **LLM 抽象** —— Vercel AI SDK v6（630M+ 周下载，25+ providers）
- **极简哲学** —— 约束悖论、Build to Delete、最小化然后迭代

详见 [架构总览](docs/architecture/overview.md) 与 [Harness Engineering](docs/architecture/harness-engineering.md)。

## 技术栈

| 层 | 运行时 | 包管理 | 测试 | 构建 |
|---|--------|-------|------|------|
| TS（Agent 核心） | Bun | pnpm | Vitest（80% 覆盖率） | Bun bundler |
| Python（ML Provider） | CPython 3.14 | uv（Astral） | pytest + pytest-asyncio | uv + hatchling |
| Rust（Iter D 再启用） | — | — | — | — |

**跨语言编排**：`just`（justfile）· **日志**：JSON schema 输出到 stdout · **开发环境**：本地裸机开发，`.devcontainer/` 留给 CI/CD

## 通信与 MCP 生态

- **MCP stdio**（TS↔Python，延迟 ~5ms）—— 跨语言调用主通道
- **code-review-graph MCP** —— Tree-sitter 增量知识图谱，token 高效的代码审查基座
- **AgentBridge MCP** —— Claude（规划 / review）↔ Codex（执行 / 实现）双 Agent 协作桥
- gRPC（Agent Mesh）/ HTTP SSE（前端流式）—— 跟随 Rust mesh-sdk 到 Iter D 再引入

## 12 个活跃工程领域

| # | 领域 | 关键设计 | Iter | Spec |
|---|------|---------|------|------|
| 01 | LLM 接入 | Vercel AI SDK v6、ThinkingMode、InferenceConfig | A | [01](docs/engineering/01-llm-integration/README.md) |
| 02 | 上下文 | System prompt 组装、token 预算、KV-cache 优化、三层时间感知 | A | [02](docs/engineering/02-context/README.md) |
| 03 | 记忆 | OmniMem 4 层 + 向量+KG + 自反思 + User Profile Store | A-B | [03](docs/engineering/03-memory/README.md) |
| 04 | 规划 | 意图识别、任务分解、推理策略切换、动态重规划 | C | [04](docs/engineering/04-planning/README.md) |
| 05 | 工具 | 4 类混合动作空间、MCP 客户端、浏览器（Zoom-In）、CLI-Anything | B | [05](docs/engineering/05-tool/README.md) |
| 06 | 多 Agent | 同构 spawn + 异构 mesh + 非阻塞 Supervisor + 进度汇报协议 | D | [06](docs/engineering/06-multi-agent/README.md) |
| 07 | 安全护栏 | 4 层验证、**READ-ONLY 默认 + AUTO opt-in**、2-stage Classifier、Two-Strike Rule | B | [07](docs/engineering/07-safety-guardrails/README.md) |
| 08 | 可观测性 | OTel 追踪、指标、结构化日志、WebUI Dashboard、评估驱动开发 | B-C | [08](docs/engineering/08-observability/README.md) |
| 09 | 部署运行时 | CLI、配置管理、热更新 + 主动通知 | C | [09](docs/engineering/09-deployment-runtime/README.md) |
| 10 | 自进化 | 轨迹分析、**human-in-loop scaffold patch**、技能自创、User Insight Engine | D | [10](docs/engineering/10-self-evolution/README.md) |
| 11 | Agent Mesh | AgentMesh SDK 接入（Rust，Iter D） | D | [11](docs/engineering/11-agent-mesh/README.md) |
| 13 | ★ 技能工程 | SKILL.md + YAML frontmatter、catalog 索引 + 按需加载、Skill ≠ Tool、M0/M1/M2+ 分层 | B | [13](docs/engineering/13-skills/README.md) |

> **Domain 12（Conversation Engineering / 对话工程）** —— 暂停到 Iter F+，保留为研究笔记。核心回路未在 benchmark 上稳态之前不投入"活人感"工程（[为什么](docs/review/2026-04-17-ultra-review.md#d-02)）。

> 第 13 领域于 2026-04-17 基于 [Claude Code / Hermes / OpenClaw / Codex CLI 四上游对比研究](docs/research/skill-loading-comparison.md) 新增。

## Quilin 独特优势

1. **Harness Engineering 顶层显式命名** —— 综合 18 篇行业文献的统一学科，把 12 领域组织成一等架构理念
2. **融合 6 大模型架构精华** —— 7 个跨模型设计模式（分层记忆、混合动作空间、自进化闭环、两段式定位、成本感知、思考模式、内建验证）内化进框架
3. **精选上游 + AI 辅助融合 PR** —— ~100 个 git submodule（--depth 1）被持续追踪，diff 通过 `sync-upstreams.py` 侦察后由人类 reviewer 决定是否融合
4. **OmniMem 4 层分级记忆** —— SHORT/MID/LONG/ULTRA + 向量检索 + 知识图谱 + 自反思 + User Profile Store + Departure Context
5. **✦ 技能工程（第 13 领域 NEW）** —— Skill ≠ Tool 严格分离；SKILL.md + frontmatter 目录化；catalog 先行 + 按需 `skill_view` 加载；路径 / 大小 / symlink 多层安全；M0 → M1 → M2+ 分阶段落地
6. **Agent Mesh 能力**（Iter D） —— AgentMesh SDK adapter 提供去中心化 Agent 通信
7. **热更新 + 主动通知** —— 解决 OpenClaw / Hermes 更新断连痛点
8. **自进化带验证 + 人在回路** —— Scaffold 修改走 propose-patch → human review → apply 流程，不盲目自信也不自动 apply
9. **三层时间感知** —— 会话内间隔 + 绝对时间 + 跨 session 时间线，理解"沉默"本身是信息
10. **显式权限分级** —— READ-ONLY 默认，AUTO 是 `--trust auto` opt-in；敏感操作（文件写、子进程 spawn、网络出站）始终可审计
11. **CLI-Anything 工具全覆盖** —— GUI-only 工具自动生成 CLI wrapper（HKUDS/CLI-Anything）
12. **WebUI Dashboard** —— 独立全局可视化面板（任务 / 记忆 / 指标 / Agent 拓扑）
13. **非阻塞 Supervisor 架构** —— 主 Agent 永不阻塞，所有任务委派 Sub-Agent，checkpoint + heartbeat 汇报
14. **Idle Evolution（opt-in）** —— 显式开启后才用闲置配额做记忆整合 / 浏览；默认 OFF，任何写入动作都需审批
15. **AgentBridge 双 Agent 协作** —— Claude + Codex 分工，协作语言中文便于用户同步

> **早期版本中的 "God Mode" / "自动缝合发布"  / "默认最大信任" / "每个榜单都上"** 叙述已在 2026-04-17 ultra-review 后收回，见 [review 报告](docs/review/2026-04-17-ultra-review.md)。

## 融合工作流（human-in-loop）

```
sync-upstreams.py  监控 ~100 个上游 submodule
        │
        ▼
  检测到新 commit → shallow pull
        │
        ▼
merge-with-claude.sh  Claude Code 生成 diff 分析 + 建议 patch
        │
        ▼
  人类 reviewer 在 PR 中评审（"Hindsight 新 Reflect 机制是否值得接入 OmniMem Tier-2？"）
        │
        ▼
  合并 PR → `just test-all` 全绿 → release.sh 打 tag 发布
```

**不做的事**：上游任意 commit 自动 apply；AI 在无 human review 情况下修改 `packages/` / `providers/` 代码；scaffold 自动重写。

## 目录结构

```
quilin-agent/
├── packages/                       # TS — pnpm workspace
│   └── agent-core/                 #   Agent Loop + LLM + Context + Tools
├── providers/                      # Python — uv workspace
│   └── memory/                     #   OmniMem MCP Server（SQLite + FTS5 + 向量 + KG）
# crates/                          # Rust — Iter D 引入（mesh-sdk）
├── upstreams/                      # ~100 git submodules（tracked, --depth 1）
├── docs/
│   ├── adr/                        # 架构决策（adr-001 core loop、adr-002 skeleton）
│   ├── architecture/               # 总览 + Harness Engineering + Fusion Index
│   ├── engineering/                # 12 个活跃工程领域 spec + 12-conversation（parked）
│   │   ├── 01-llm-integration/ ... 11-agent-mesh/
│   │   ├── 12-conversation-engineering/  # parked — Iter F+
│   │   └── 13-skills/              #   ★ 技能工程（新）
│   ├── review/                     # 架构 review 报告（2026-04-17 ultra-review）
│   ├── research/                   # 深度调研（Claude Code / Codex / OpenClaw / Hermes / Skill Loading）
│   └── implementation-plan.md      # 迭代式实施路线图（A→F）
├── scripts/                        # 自动化脚本（sync-upstreams / merge-with-claude / release / setup-cron）
├── .github/workflows/ci.yml        # CI（TS + Python 矩阵；Rust 在 Iter D 加入）
├── justfile                        # 跨语言编排
├── quilin.md                       # 共享指南（CLAUDE.md / AGENTS.md 符号链接指向它）
└── readme.md
```

## 快速启动

```bash
# ===== 一键开发（推荐） =====
just init          # 安装全部依赖（pnpm + uv）
just start         # 启动全部服务（agent-core + omnimem）
just dev           # TS 开发模式（前台 + watch）
just dev-memory    # Python OmniMem 开发模式
just test-all      # 一键测试（TS + Python）
just check         # 一键 lint + format
just build         # TS 构建

# ===== 上游同步（侦察 diff；融合走 PR） =====
python scripts/sync-upstreams.py              # 单次上游检查
python scripts/sync-upstreams.py --daemon     # daemon 模式，每 5 分钟
bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]  # 生成融合 patch 建议
bash scripts/release.sh --dry-run             # 预览发布
bash scripts/init-all-submodules.sh           # 首次初始化 submodule
```

## Benchmark 目标

**Iter E 聚焦 3 个核心 leaderboard**（不做"每一个榜单都参赛"的承诺）：

| 榜单 | 阶段 | 覆盖能力 |
|------|------|---------|
| **SWE-bench Verified** | Iter E2 | 代码 Agent 核心能力（500 真实 GitHub issue） |
| **GAIA** | Iter E3 | 通用推理 + 工具调用 |
| **BFCL v4** | Iter E3 | Function calling 准确率 |

其余 benchmark（τ-bench / Terminal-Bench / LiveCodeBench / WebArena / OSWorld / ARC-AGI / AgentHarm / InjecAgent / ScienceAgentBench 等）作为 **aspirational roadmap**，Iter E4+ 视 baseline harness 稳定性再启动。

完整 benchmark 矩阵与阶段划分见 [implementation-plan.md](docs/implementation-plan.md)。

## 当前状态

**Iter A 完成** + **Iter B 进行中**：

已交付：
- 自研 Agent Loop（TS，< 200 行）
- OmniMem MCP Server（Python + SQLite + FTS5）
- ToolRouter + MCP Client Bridge
- PromptBuilder + ContextAssembler + InjectionScanner + TemporalAwareness
- REPL + session restore
- 91 TS tests + 31 Python tests

正在推进：
- Iter B2：Safety Policy spec（审核中）
- Iter B3a：Skills Core（SKILL.md + catalog + on-demand load，紧随 B2）
- P0 修复批：TS-03 maxOutputTokens / PY-03 ghost deps / MCP spawn 沙箱 / MCPRegistry 原子化（见 [2026-04-17 ultra-review](docs/review/2026-04-17-ultra-review.md)）

详见 [implementation-plan.md](docs/implementation-plan.md) 迭代路线图。

## 多 Agent 协作

本项目使用 **AgentBridge** 协调两个 AI agent：

| 角色 | 职责 |
|------|------|
| **Claude Code** | Reviewer / Planner / Hypothesis Challenger — 架构设计、代码审查、任务分解、决策判断 |
| **Codex CLI** | Implementer / Executor / Reproducer — 代码编写、修改、重构、沙箱验证 |

协作语言中文，所有协作消息必须回复，避免单方面沉默。详见 [quilin.md](quilin.md) 的 AgentBridge 章节。

## 架构决策记录

- [ADR-001 Core Loop and Language](docs/adr/adr-001-core-loop-and-language.md) — 不用 LangGraph，自研极简 Loop；TS（核心）+ Python（ML）。Rust 在 Iter D 引入。
- [ADR-002 Project Skeleton](docs/adr/adr-002-project-skeleton.md) — 骨架蓝图、目录布局、日志 JSON schema
- [2026-04-17 Ultra-Review](docs/review/2026-04-17-ultra-review.md) — Opus 4.7 全面复查报告，170 findings

## 为什么叫 Quilin？

**麒麟**是中华神话中最早的「缝合神兽」—— 鹿角、牛尾、龙鳞、马蹄，融合多种生物的精华于一身。

我们的 Agent 框架也是如此：人类主导从 ~100 个精选开源项目中挑选、融合、发布。名字本身也是在「缝合」—— **Quilt**（拼布）+ **Qilin**（麒麟）= **Quilin**。

---

MIT License
