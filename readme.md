# Quilin Agent — 麒麟

> **Quilin** = Quilt（拼布/缝合）+ Qilin（麒麟，中华神话最早的缝合神兽）
>
> 融合全球最强 Agent 开源项目精华的自进化 Agent 框架

**愿景**：把 harness（包裹在 LLM 外面的一切）做到极致，让任何模型都能超水平发挥。实时监控 Agent 生态 **13 大工程领域**的 Top 10 最强开源项目，一旦上游有更新，就自动拉取 → Claude Code 智能分析 diff → 自动生成融合 patch → 缝合进核心代码 → 发布新版本。

最终产物是一个**活的、持续进化的 Agent 操作系统**，每一层都吸收了全生态最强思想，组合方式永远跟随最新 Agent Engineering 最佳实践。

## 一句话定位

**Quilin = 极简 Agent Loop + 13 领域 harness + 三语言架构 + 自进化缝合工作流**。

不是 LangGraph 的一种变体，不是 LangChain 的上层封装，而是按 Harness Engineering 原则自研的一个可自我改造的 Agent 操作系统。

## 核心架构

- **自研极简 Agent Loop**（< 200 行 TS while-loop）—— 不使用 LangGraph / LangChain / AutoGen 等任何外部 Agent 框架，四大标杆（Claude Code、Codex、OpenClaw、Hermes）的共同智慧
- **三语言架构** —— TypeScript（Agent 核心 + E-T-C-S-L-V 六组件）+ Python（ML Provider 封装为 MCP Server）+ Rust（Agent Mesh 网络层 + WASM 沙箱）
- **Harness Engineering 顶层组织原则** —— LLM 是发动机，13 领域是整辆车；harness 质量决定同一模型在不同场景表现天差地别（LangChain 仅改 harness 提升 13.7 pp，Opus 4.6 换 harness 从排名 #33 跳到 #5）
- **E-T-C-S-L-V 六组件 = LLM 可调用的能力层** —— Execution / Tools / Context / State / Lifecycle / Verification 不再是固定状态图节点，而是工具层暴露给 LLM，与 LangGraph 路线本质不同
- **LLM 抽象** —— Vercel AI SDK v6（630M+ 周下载，25+ providers），接入任意模型
- **极简哲学** —— 约束悖论（约束越多能力越强）、Build to Delete（为删除而构建）、仓库即真理之源、最小化然后迭代

详见 [架构总览](docs/architecture/overview.md) 与 [Harness Engineering](docs/architecture/harness-engineering.md)。

## 技术栈

| 层 | 运行时 | 包管理 | 测试 | 构建 |
|---|--------|-------|------|------|
| TS（Agent 核心） | Bun | pnpm | Vitest（80% 覆盖率） | Bun bundler |
| Python（ML Provider） | CPython 3.14 | uv（Astral） | pytest + pytest-asyncio | uv + hatchling |
| Rust（基础设施） | native + Tokio 1.94 | cargo | cargo test + insta | cargo |

**跨语言编排**：`just`（justfile）· **日志**：三语言统一 JSON schema 输出到 stdout · **开发环境**：本地裸机开发，`.devcontainer/` 留给 CI/CD

## 通信与 MCP 生态

- **MCP stdio**（~90%，TS↔Python，延迟 ~5ms）—— 大多数跨语言调用走这里
- **gRPC**（Agent Mesh P2P）—— Rust mesh-sdk 层
- **HTTP SSE**（前端流式）—— WebUI Dashboard 接入
- **code-review-graph MCP** —— Tree-sitter 增量知识图谱，token 高效的代码审查基座
- **AgentBridge MCP** —— Claude（规划/review）↔ Codex（执行/实现）双 Agent 协作桥

## 13 大工程领域

| # | 领域 | 关键设计 | Phase | Spec |
|---|------|---------|-------|------|
| 01 | LLM 接入 | Vercel AI SDK v6、ThinkingMode、InferenceConfig | 0 | [01](docs/engineering/01-llm-integration/README.md) |
| 02 | 上下文 | System prompt 组装、token 预算、KV-cache 优化、三层时间感知 | 0 | [02](docs/engineering/02-context/README.md) |
| 03 | 记忆 | OmniMem 4 层（SHORT/MID/LONG/ULTRA）+ 向量+KG + 自反思 + User Profile Store | 0-1 | [03](docs/engineering/03-memory/README.md) |
| 04 | 规划 | 意图识别、任务分解、推理策略切换、动态重规划 | 1 | [04](docs/engineering/04-planning/README.md) |
| 05 | 工具 | 4 类混合动作空间、MCP 客户端、浏览器（Zoom-In 两段式）、CLI-Anything | 0-2 | [05](docs/engineering/05-tool/README.md) |
| 06 | 多 Agent | 同构 spawn + 异构 mesh + 非阻塞 Supervisor + 进度汇报协议 | 2 | [06](docs/engineering/06-multi-agent/README.md) |
| 07 | 安全护栏 | 4 层验证、默认 AUTO 权限、2-stage Classifier、Two-Strike Rule | 1 | [07](docs/engineering/07-safety-guardrails/README.md) |
| 08 | 可观测性 | OTel 追踪、指标、结构化日志、WebUI Dashboard、评估驱动开发 | 1 | [08](docs/engineering/08-observability/README.md) |
| 09 | 部署运行时 | CLI、配置管理、热更新 + 主动通知、空闲进化配置 | 1-2 | [09](docs/engineering/09-deployment-runtime/README.md) |
| 10 | 自进化 | 轨迹分析、scaffold 自修改、技能自创、User Insight Engine、空闲自进化经济学 | 2 | [10](docs/engineering/10-self-evolution/README.md) |
| 11 | Agent Mesh | 内置 AgentMesh SDK，启动即加入去中心化 Agent 网络 | 2 | [11](docs/engineering/11-agent-mesh/README.md) |
| 12 | 对话工程 | 6 层活人感架构、3 种风格模式（原版/自定义/活人感）、关系建模 | 2 | [12](docs/engineering/12-conversation-engineering/README.md) |
| ★ 13 | **技能工程 NEW** | **SKILL.md + YAML frontmatter、catalog 索引 + 按需加载、Skill ≠ Tool、M0/M1/M2+ 分层** | **1** | **[13](docs/engineering/13-skills/README.md)** |

> 第 13 领域于 2026-04-17 基于 [Claude Code / Hermes / OpenClaw / Codex CLI 四上游对比研究](docs/research/skill-loading-comparison.md) 新增。

## Quilin 独特优势

1. **Harness Engineering 顶层显式命名** —— 综合 18 篇行业文献（OpenAI/Anthropic/Martin Fowler/LangChain/Manus）的统一学科，把 13 领域组织成一等架构理念
2. **融合 6 大模型架构精华** —— 7 个跨模型设计模式（分层记忆、混合动作空间、自进化闭环、两段式定位、成本感知、思考模式、内建验证）内化进框架
3. **13 领域 × Top 10 上游监控 + 自动缝合** —— ~130 个 git submodule（--depth 1），持续进化，不是一次性开发
4. **OmniMem 4 层分级记忆** —— SHORT/MID/LONG/ULTRA + 向量检索 + 知识图谱 + 自反思 + User Profile Store + Departure Context
5. **✦ 技能工程（第 13 领域 NEW）** —— Skill ≠ Tool 严格分离；SKILL.md + frontmatter 目录化；catalog 先行 + 按需 `skill_view` 加载；路径 / 大小 / symlink 多层安全；M0（基本可用）→ M1（长对话+CRUD+安全扫描）→ M2+（插件+自进化+ToolSearch）分阶段落地
6. **内置 Agent Mesh** —— 通过 AgentMesh SDK adapter 启动即加入去中心化网络，可发现 / 通信 / 能力声明
7. **热更新 + 主动通知** —— 解决 OpenClaw / Hermes 更新断连痛点，更新后主动告知用户变更内容
8. **自进化带验证** —— 每次 scaffold 修改都有 eval，不盲目自信（区别于 Hermes 的盲目自进化）
9. **Agentic 人味 + 6 层活人感架构** —— 句子表面 / 话轮结构 / 观点判断 / 关系建模 / 时间连续性 / 元层面 + 3 种风格模式（原版 / 自定义 / 活人感）
10. **三层时间感知** —— 会话内间隔 + 绝对时间 + 跨 session 时间线，理解"沉默"本身是信息
11. **默认 AUTO 权限** —— 最大信任为默认，仅 CRITICAL 操作才问人（参考 Claude Code auto mode）
12. **CLI-Anything 工具全覆盖** —— GUI-only 工具自动生成 CLI wrapper（HKUDS/CLI-Anything），所有工具都可通过命令行调用
13. **WebUI Dashboard** —— 独立全局可视化面板（任务 / 记忆 / 指标 / Agent 拓扑）
14. **Benchmark 全量参赛** —— 8 大类 30+ 公开 benchmark（SWE-bench / GAIA / BFCL / WebArena / AgentHarm 等），目标进 Top 10 并争取 SOTA
15. **非阻塞 Supervisor 架构** —— 主 Agent 永不阻塞，所有任务委派 Sub-Agent，checkpoint + heartbeat 汇报；用户随时可交互
16. **空闲自进化经济学** —— 用户不在时用闲置订阅配额 / 每日 API 预算做记忆整合 / scaffold 改进 / 技能扩充 / 相关网页浏览，下次会话透明汇报
17. **God Mode（创始者实例）** —— 自动构建 / 更新 / 部署、自我开发（dogfooding），加速 harness 自身进化
18. **AgentBridge 双 Agent 协作** —— Claude（规划 / review / 架构决策）+ Codex（执行 / 实现 / 沙箱验证）分工，协作语言中文便于用户同步

## 融合缝合工作流

```
sync-upstreams.py  监控 ~130 个上游 submodule
        │
        ▼
  检测到新 commit → shallow pull
        │
        ▼
merge-with-claude.sh  Claude Code 智能分析 diff
        │
        ▼
  生成融合 patch（例："把 Hindsight 新 Reflect 机制接入 OmniMem Tier-2"）
        │
        ▼
  自动 apply → `just test-all` 全绿 → release.sh 打 tag 发布
```

## 目录结构

```
quilin-agent/
├── packages/                       # TS — pnpm workspace
│   └── agent-core/                 #   Agent Loop + LLM + Context + Tools + Skills（13）
├── providers/                      # Python — uv workspace
│   └── memory/                     #   OmniMem MCP Server（SQLite + FTS5 + 向量 + KG）
├── crates/                         # Rust — cargo workspace
│   └── mesh-sdk/                   #   Agent Mesh SDK（骨架）
├── upstreams/                      # ~130 git submodules（auto-synced, --depth 1）
├── docs/
│   ├── adr/                        # 架构决策（adr-001 core loop、adr-002 skeleton）
│   ├── architecture/               # 总览 + Harness Engineering + Fusion Index
│   ├── engineering/                # 13 个工程领域 spec
│   │   ├── 01-llm-integration/ ... 12-conversation-engineering/
│   │   └── 13-skills/              #   ★ 技能工程（新）
│   ├── research/                   # 深度调研（Claude Code / Codex / OpenClaw / Hermes / Skill Loading）
│   └── implementation-plan.md      # 迭代式实施路线图（A→F）
├── scripts/                        # 自动化脚本（sync-upstreams / merge-with-claude / release / setup-cron）
├── .github/workflows/ci.yml        # CI（三语言矩阵）
├── justfile                        # 跨语言编排
├── quilin.md                       # 共享指南（CLAUDE.md / AGENTS.md 符号链接指向它）
└── readme.md
```

## 快速启动

```bash
# ===== 一键开发（推荐） =====
just init          # 安装全部依赖（pnpm + uv + cargo）
just start         # 启动全部服务（agent-core + omnimem）
just dev           # TS 开发模式（前台 + watch）
just dev-memory    # Python OmniMem 开发模式
just test-all      # 一键测试（TS + Python + Rust）
just check         # 一键 lint + format
just build         # TS 构建

# ===== 缝合与上游同步 =====
python scripts/sync-upstreams.py              # 单次上游检查
python scripts/sync-upstreams.py --daemon     # daemon 模式，每 5 分钟
bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]
bash scripts/release.sh --dry-run             # 预览发布
bash scripts/init-all-submodules.sh           # 首次初始化 submodule
```

## Benchmark 竞赛计划

8 大类 30+ 个公开 benchmark，分三阶段逐步攻克：

| 阶段 | 重点 Benchmark | 覆盖能力 |
|------|---------------|---------|
| Phase 0（已完成） | SWE-bench Verified / Pro | 代码 Agent 核心能力（500 真实 GitHub issue） |
| Phase 1 | GAIA · BFCL v4 · τ-bench · Terminal-Bench 2.0 · LiveCodeBench | 通用推理 + 工具调用 |
| Phase 2+ | WebArena · OSWorld · ARC-AGI · AgentHarm · InjecAgent · ScienceAgentBench | 浏览器 / OS / 抽象推理 / 安全 |

目标：在每个公开榜单上参赛并冲击 Top 10 / SOTA（SWE-bench Verified 现 Top 10 ~78%+；GAIA 首名 44.8%）。完整 benchmark 矩阵见 [implementation-plan.md](docs/implementation-plan.md)。

## 当前状态

**Phase 0 已完成（v0.0.3）** + **Iter A 已完成（v0.1.0-iter-a，上下文/提示词工程）** + **Iter B 进行中（工具系统 + 13-skills 技能工程）**。

已交付：自研 Agent Loop（TS）· OmniMem MCP Server（Python + SQLite + FTS5）· ToolRouter + MCP Client Bridge · PromptBuilder + ContextAssembler + InjectionScanner + TemporalAwareness · REPL + session restore · 78 TS tests + 31 Python tests 全绿（Iter A 增至 91 TS tests）。

正在推进：Iter B（工具系统 + 安全基础 + 13-skills Skill Loading 首期 M0），详见 [implementation-plan.md](docs/implementation-plan.md) 迭代路线图。

## 多 Agent 协作

本项目使用 **AgentBridge** 协调两个 AI agent：

| 角色 | 职责 |
|------|------|
| **Claude Code** | Reviewer / Planner / Hypothesis Challenger — 架构设计、代码审查、任务分解、决策判断 |
| **Codex CLI** | Implementer / Executor / Reproducer — 代码编写、修改、重构、沙箱验证 |

协作语言中文，所有协作消息必须回复，避免单方面沉默。详见 [quilin.md](quilin.md) 的 AgentBridge 章节。

## 架构决策记录

- [ADR-001 Core Loop and Language](docs/adr/adr-001-core-loop-and-language.md) — 不用 LangGraph，自研极简 Loop；TS（核心）+ Python（ML）+ Rust（基础设施）
- [ADR-002 Project Skeleton](docs/adr/adr-002-project-skeleton.md) — Phase 0 骨架蓝图、三语言目录布局、日志 JSON schema

## 为什么叫 Quilin？

**麒麟**是中华神话中最早的「缝合神兽」—— 鹿角、牛尾、龙鳞、马蹄，融合多种生物的精华于一身，却和谐统一、自成一体。

我们的 Agent 框架也是如此：融合 ~130 个顶级开源项目的精华，通过智能缝合形成一个有机的整体。名字本身就是在「缝合」—— **Quilt**（拼布）+ **Qilin**（麒麟）= **Quilin**。

---

MIT License
