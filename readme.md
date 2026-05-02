# Quilin Agent — 麒麟

> **Quilin** = Quilt（拼布）+ Qilin（麒麟）
>
> 一个基于对主流 Agent 框架系统性研究、原生构建的自演进 Agent 平台

**愿景**：把 harness（包裹在 LLM 外面的一切）做到极致，让任何模型都能超水平发挥。我们从 Agent 工程的 **12 个关键维度** 深入研究领先框架的设计取舍，提炼跨方案的共性模式，形成统一的原生实现——每一次架构演进都走人工 review PR 流程，并优先用本地组件实证与交叉 review 验证。

## 一句话定位

**Quilin = 极简 Agent Loop + 12 领域 harness + 两语言运行时 + 研究驱动的持续演进**

不是 LangGraph 变体，不是 LangChain 上层封装，而是按 Harness Engineering 原则原生构建的、可被团队主导演进的 Agent 操作系统。

## 核心架构

- **自研极简 Agent Loop**（< 200 行 TS while-loop）—— 不依赖 LangGraph / LangChain / AutoGen 等外部 Agent 框架
- **两语言运行时（Iter A..C）** —— TypeScript（Agent 核心 + E-T-C-S-L-V 六组件）+ Python（ML Provider 封装为 MCP Server）。**Rust**（mesh / WASM 沙箱）在 Iter D 引入。
- **Harness Engineering 顶层组织原则** —— LLM 是发动机，12 领域是整辆车
- **E-T-C-S-L-V 六组件** —— Execution / Tools / Context / State / Lifecycle / Verification 作为可调用能力层暴露给 LLM，而非固定状态图节点
- **LLM 抽象** —— Vercel AI SDK v6（630M+ 周下载，25+ providers）
- **极简哲学** —— 约束悖论、Build to Delete、最小化然后迭代

详见 [Core Loop](docs/00-core-loop/README.md) 与 [Harness Engineering](docs/00-core-loop/harness-engineering.md)。

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
| 01 | LLM 接入 | Vercel AI SDK v6、ThinkingMode、InferenceConfig | A | [01](docs/01-llm-integration/README.md) |
| 02 | 上下文 | System prompt 组装、token 预算、KV-cache 优化、三层时间感知 | A | [02](docs/02-context/README.md) |
| 03 | 记忆 | OmniMem 4 层 + 向量+KG + 自反思 + User Profile Store | A-B | [03](docs/03-memory/README.md) |
| 04 | 规划 | 意图识别、任务分解、推理策略切换、动态重规划 | C | [04](docs/04-planning/README.md) |
| 05 | 工具 | 4 类混合动作空间、MCP 客户端、浏览器（Zoom-In）、CLI-Anything | B | [05](docs/05-tool/README.md) |
| 06 | 多 Agent | 同构 spawn + 异构 mesh + 非阻塞 Supervisor + 进度汇报协议 | D | [06](docs/06-multi-agent/README.md) |
| 07 | 安全护栏 | 4 层验证、**READ-ONLY 默认 + AUTO opt-in**、2-stage Classifier、Two-Strike Rule | B | [07](docs/07-safety-guardrails/README.md) |
| 08 | 可观测性 | OTel 追踪、指标、结构化日志、WebUI Dashboard、评估驱动开发 | B-C | [08](docs/08-observability/README.md) |
| 09 | 部署运行时 | CLI、配置管理、热更新 + 主动通知 | C | [09](docs/09-deployment-runtime/README.md) |
| 10 | 自进化 | 轨迹分析、**human-in-loop scaffold patch**、技能自创、User Insight Engine | D | [10](docs/10-self-evolution/README.md) |
| 11 | Agent Mesh | AgentMesh SDK 接入（Rust，Iter D） | D | [11](docs/11-agent-mesh/README.md) |
| 13 | 技能工程 | SKILL.md + YAML frontmatter、catalog 索引 + 按需加载、Skill ≠ Tool、M0/M1/M2+ 分层 | B | [13](docs/13-skills/README.md) |

> **Domain 12（Conversation Engineering / 对话工程）** —— 暂停到 Iter F+，保留为研究笔记。核心回路与依赖 runtime 组件有本地实证前，不投入"活人感"工程。

## Quilin 独特优势

1. **Harness Engineering 顶层显式命名** —— 综合 18 篇行业文献的统一学科，把 12 领域组织成一等架构理念
2. **融合 6 大模型架构精华** —— 7 个跨模型设计模式（分层记忆、混合动作空间、自进化闭环、两段式定位、成本感知、思考模式、内建验证）内化进框架
3. **研究驱动的架构演进** —— 持续跟踪 Agent 框架前沿，提炼跨方案的共性模式与工程取舍，由团队评估后以原生方式纳入设计
4. **OmniMem 4 层分级记忆** —— working/episodic/semantic/skill + 向量检索 + 知识图谱 + 自反思 + User Profile Store + Departure Context
5. **技能工程（第 13 领域）** —— Skill ≠ Tool 严格分离；SKILL.md + frontmatter 目录化；catalog 先行 + 按需 `skill_view` 加载；路径 / 大小 / symlink 多层安全；M0 → M1 → M2+ 分阶段落地
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

## 架构演进机制

Quilin 不是定版即止，而是持续演进的平台：

1. **研究** —— 跟踪 Agent 工程前沿（学术论文 + 主流框架的设计动向）
2. **提炼** —— 识别跨方案的共性模式与工程取舍
3. **设计** —— 结合自身架构约束，给出原生解决方案
4. **落地** —— 所有变更走人工 review PR，优先用本地组件实证、测试和交叉 review 验证

`scripts/sync-upstreams.py` 用作研究辅助——定时扫描领先框架的变更，生成摘要供 reviewer 参考。**不自动 apply 代码，不自动修改 scaffold**；所有架构变更必须经过团队 review 与本地实证验证。Benchmark 当前是全项目最低优先级，Iter E 已冻结；除非用户明确要求，任何 Iter 都不得新增或修改 Benchmark 代码。

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
│   ├── README.md                   # docs/ 写入/查阅约定
│   ├── STATUS.md                   # 当前全局状态
│   ├── 00-core-loop/               # 核心循环 / harness / glossary
│   ├── 01-llm-integration/ ... 11-agent-mesh/
│   ├── 02-context/
│   │   └── conversation-engineering/  # parked sub-module — Iter F+
│   ├── 13-skills/                  # 技能工程
│   └── 14-benchmark-harness/       # frozen/read-only unless user explicitly asks
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

## Benchmark 冻结

截至 2026-05-02，Benchmark 是全项目最低优先级。Iter E 已冻结并在 Linear 中取消；未完成的 Benchmark project / issue 已从活跃队列移出或降为低优先级。

仓库中已有的 `benchmarks/` 与 `providers/memory/benchmarks/` 代码保留为当前代码事实和历史证据。除非用户明确要求 Benchmark 工作，任何 Iter 都不得新增或修改 Benchmark 代码，也不得重开已取消的 Benchmark 任务。当前口径见 [Benchmark Harness](docs/14-benchmark-harness/README.md)。

## 多 Agent 协作

本项目使用 **AgentBridge** 协调两个 AI agent：

| 角色 | 职责 |
|------|------|
| **Claude Code** | Reviewer / Planner / Hypothesis Challenger — 架构设计、代码审查、任务分解、决策判断 |
| **Codex CLI** | Implementer / Executor / Reproducer — 代码编写、修改、重构、沙箱验证 |

协作语言中文，所有协作消息必须回复，避免单方面沉默。详见 [quilin.md](quilin.md) 的 AgentBridge 章节。

## 当前状态

- [全局状态](docs/STATUS.md)
- [Core Loop](docs/00-core-loop/README.md)
- 历史 ADR / research / review 不再作为 docs 入口；必要历史通过 git history 追溯。

## 为什么叫 Quilin？

**麒麟**汇聚百兽之灵——鹿角、牛尾、龙鳞、马蹄，集多种灵性于一身，却是一种独立而完整的祥瑞。

我们的 Agent 平台也是如此：工程团队主导研究 Agent 工程的最佳实践，提炼、设计、原生实现，最终构成一个完整统一的体系。名字本身即是这种精神——**Quilt**（拼布）+ **Qilin**（麒麟）= **Quilin**。

---

MIT License
