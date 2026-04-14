# Quilin Agent — 拼布麒麟

> **Quilin** = Quilt（拼布/缝合）+ Qilin（麒麟，中华神话最早的缝合神兽）
>
> 融合全球最强 Agent 开源项目精华的自进化 Agent 框架

**愿景**：打造一个**永远站在 SOTA 最前沿的动态 Agent 框架**——实时监控 Agent 生态 12 大工程领域的 Top 10 最强开源项目，一旦上游有更新，就自动拉取 → Claude Code 智能分析 diff → 自动生成融合 patch → 缝合进核心代码 → 发布新版本。

最终产物是一个**活的、持续进化的 Agent 操作系统**（Quilin Agent），每一层都吸收了全生态最强思想，组合方式永远跟随最新 Agent Engineering 最佳实践。

## 核心架构

- **自研极简 Agent Loop**（< 200 行 TS while-loop），不使用 LangGraph 或任何外部 Agent 框架
- **三语言架构**：TypeScript（Agent 核心）+ Python（ML Provider，封装为 MCP Server）+ Rust（Agent Mesh 网络层 + WASM 沙箱）
- **E-T-C-S-L-V 六组件** = LLM 可调用的能力层，而非固定状态图节点
- **LLM 抽象**：Vercel AI SDK v6（630M+ 周下载，25+ providers），接入任意模型

## 技术栈

| 层 | 运行时 | 包管理 | 测试 | 构建 |
|---|--------|-------|------|------|
| TS（核心） | Bun | pnpm | Vitest | Bun bundler |
| Python（ML） | CPython 3.14 | uv (Astral) | pytest | uv + hatchling |
| Rust（基础设施） | native + Tokio | cargo | cargo test + insta | cargo |

**跨语言编排**：just | **通信**：MCP stdio (90%, TS↔Python), gRPC (Agent Mesh), HTTP SSE (前端) | **开发环境**：Docker Dev Container

## 12 大工程领域

| # | 领域 | 关键设计 | Phase |
|---|------|---------|-------|
| 01 | LLM 接入 | Vercel AI SDK v6、ThinkingMode、InferenceConfig | 0 |
| 02 | 上下文工程 | 系统提示组装、token 预算、KV-cache 优化、三层时间感知 | 0 |
| 03 | 记忆工程 | OmniMem 4 层分级（SHORT/MID/LONG/ULTRA）+ 向量+KG + 自反思 + User Profile Store | 0-1 |
| 04 | 规划工程 | 意图识别、任务分解、推理策略切换、动态重规划 | 1 |
| 05 | 工具工程 | 4 类混合动作空间、MCP 客户端、浏览器（Zoom-In 两段式）、CLI-Anything | 0-2 |
| 06 | 多 Agent | 同构 spawn + 异构 mesh + 非阻塞 Supervisor 默认架构 + 进度汇报协议 | 2 |
| 07 | 安全护栏 | 4 层验证、默认 AUTO 权限、2-stage Classifier、God Mode | 1 |
| 08 | 可观测性 | OTel 追踪、指标、结构化日志、WebUI Dashboard | 1 |
| 09 | 部署运行时 | CLI、配置管理、热更新 + 主动通知、空闲进化配置 | 1-2 |
| 10 | 自进化 | 轨迹分析、scaffold 自修改、技能自创、User Insight Engine、空闲自进化经济学 | 2 |
| 11 | Agent Mesh | 内置 AgentMesh SDK，启动即加入去中心化 Agent 网络 | 2 |
| 12 | 对话工程 | 6 层活人感架构、3 种风格模式（原版/自定义/活人感）、关系建模 | 2 |

详细 spec 见 [docs/engineering/](docs/engineering/)，架构总览见 [docs/architecture/overview.md](docs/architecture/overview.md)

## Quilin 独特优势

1. **融合 6 大模型架构精华** — 7 个跨模型设计模式内化进框架
2. **12 领域 × Top 10 上游监控 + 自动缝合** — 持续进化，不是一次性开发
3. **4 层分级记忆 + KG + 自反思** — 解决 OpenClaw 记忆失灵 + 跨项目污染
4. **内置 Agent Mesh** — 天然接入去中心化 Agent 通信网络
5. **热更新 + 主动通知** — 解决 OpenClaw/Hermes 更新断连痛点
6. **自进化带验证** — 每次 scaffold 修改都有评估，不盲目自信
7. **Agentic 人味** — 6 层活人感架构 + User Insight Engine 产生 Aha Moment
8. **三层时间感知** — 会话内间隔 + 绝对时间 + 跨 session 时间线
9. **默认最大信任** — AUTO 权限模式为默认，只有 CRITICAL 操作才问人
10. **CLI-Anything 工具全覆盖** — GUI-only 工具自动生成 CLI wrapper
11. **WebUI Dashboard** — 独立全局可视化面板
12. **Benchmark 实证** — 8 大类 30+ 公开 benchmark 全量参赛
13. **主 Agent 永不阻塞** — Supervisor 架构为默认 + Sub-Agent 进度汇报
14. **空闲自进化经济学** — 用户不在时自动利用闲置配额做记忆整合、scaffold 改进
15. **对话工程** — 让 Agent 不像工具而像一个有个性的真人

## 项目目录结构

```
quilin-agent/
├── upstreams/                  # ~100 个 git submodule（实时同步，--depth 1）
│   ├── memory-*/               # Domain: Memory
│   ├── llm-*/                  # Domain: LLM Brain / Inference
│   └── ...                     # Domains 3-12
├── docs/
│   ├── adr/                    # 架构决策记录
│   │   └── adr-001-core-loop-and-language.md
│   ├── architecture/           # 架构总览 + Harness 工程 + 融合索引
│   ├── engineering/            # 12 大工程领域详细 spec
│   │   ├── 01-llm-integration/
│   │   ├── ...
│   │   └── 12-conversation-engineering/
│   ├── research/               # 深度调研（Claude Code / Codex / OpenClaw / Hermes）
│   └── implementation-plan.md  # 三阶段迁移计划
├── scripts/
│   ├── init-all-submodules.sh  # 首次初始化全部 submodule
│   ├── sync-upstreams.py       # 监控上游 + 自动 pull
│   ├── merge-with-claude.sh    # Claude-powered 智能缝合
│   ├── release.sh              # 自动 commit / tag / push
│   └── setup-cron.sh           # 安装/管理 crontab
└── readme.md
```

## 快速启动

```bash
# 初始化 submodule
bash scripts/init-all-submodules.sh
git submodule update --init --recursive

# 同步上游（单次检查）
python scripts/sync-upstreams.py

# 同步上游（daemon 模式，每 5 分钟）
python scripts/sync-upstreams.py --daemon

# Claude-powered 智能缝合
bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]

# 发布新版本
bash scripts/release.sh              # auto patch bump
bash scripts/release.sh --minor      # minor version
bash scripts/release.sh --dry-run    # preview only
```

## 工作流程

1. `sync-upstreams.py` 检测到任意 upstream 有新 commit → pull 最新代码
2. `merge-with-claude.sh` 触发 → 把变更 diff + 当前 Quilin 代码一起发给 Claude Code
3. Claude 生成融合 patch（例如"把 Hindsight 新 Reflect 机制无缝接入 OmniMem Tier-2 记忆层"）
4. 自动 apply → 测试通过 → `release.sh` 打 tag 发布新版本

## Benchmark 竞赛计划

8 大类 30+ 个公开 benchmark，分三阶段逐步攻克：

- **Phase 0**：SWE-bench Verified / Pro — 代码 Agent 核心能力验证
- **Phase 1**：GAIA / BFCL v4 / τ-bench — 通用推理 + 工具调用
- **Phase 2+**：WebArena / OSWorld / ARC-AGI / AgentHarm 等 — 全面铺开

目标：在每个公开榜单上真实碾压所有 Agent。

## 当前状态

**规划阶段** — 12 个工程领域的设计 spec 已完成，核心架构决策已定稿（[ADR-001](docs/adr/adr-001-core-loop-and-language.md)）。代码 = 0 行，规划完成后才写代码。

## 为什么叫 Quilin？

**麒麟**是中华神话中最早的「缝合神兽」—— 鹿角、牛尾、龙鳞、马蹄，融合多种生物的精华于一身，却和谐统一、自成一体。

我们的 Agent 框架也是如此：融合 100+ 顶级开源项目的精华，通过智能缝合形成一个有机的整体。名字本身就是在「缝合」—— **Quilt**（拼布）+ **Qilin**（麒麟）= **Quilin**。

---

MIT License
