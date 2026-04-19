# Benchmark Roadmap — Quilin Agent

> **状态**：v0.1（2026-04-18 首次定稿，D-09 交付物）
> **决策锚点**：[implementation-plan.md](../implementation-plan.md) Iter E + CLAUDE.md "Benchmark Scope: 3 pinned + roadmap"
> **目的**：把"全量刷 30+ benchmark"这种模糊承诺显式拆成可调度的优先级队列，避免每次 planning 都重新讨论。

---

## 一、分级原则

| 级别 | 含义 | 承诺强度 | 对应 Iter |
|------|------|---------|----------|
| **Pinned**（钉榜） | 必须参赛，公开提交排名 | 🔴 硬承诺 | Iter E |
| **Roadmap**（路线图） | 已评估、计划参赛，但排期灵活 | 🟡 中承诺 | Iter F+ |
| **Aspirational**（远期） | 有参赛意愿、尚未评估投入/产出 | 🟢 软承诺 | 无日期 |
| **Rejected**（已否决） | 评估过但决定不参赛 | ⚫ 不投入 | —— |

**升级规则**：Roadmap → Pinned 必须走 ADR；Aspirational → Roadmap 需要一份 feasibility 纪要（harness 复杂度、数据许可、评估成本）。

---

## 二、Pinned（Iter E 硬承诺）

| Benchmark | 版本 | 范畴 | 首次目标 | SOTA（2026-04） | 评估成本 |
|-----------|------|------|---------|----------------|---------|
| **SWE-bench Verified** | Verified（500 题） | 真实 GitHub issue 修复 | 进入 top-10 | 74.4%（Claude Opus 4.5） | 🔴 高 |
| **GAIA** | v1 | 多步推理 + 工具使用（466 题） | ≥35% | 74.6%（Claude Sonnet 4.5） | 🟠 中 |
| **BFCL v4** | v4 | 工具调用准确率 | overall ≥85% | 70.9%（GLM-4.5 开源领先） | 🟡 中低 |
| **τ2-bench** ⭐**NEW** | v2（2025-12） | 多轮工具 + 用户交互（telecom / retail / airline） | telecom ≥85% | Opus 4.6 telecom 99.3% / retail 91.9% | 🟡 中 |

**为什么这四个**（D-16 2026-04-20 加入 τ2-bench）：
- **SWE-bench Verified**：覆盖核心用户场景（coding agent），有标准 harness，SOTA 分布已稳定。
- **GAIA**：检验多步规划 + tool use + web browsing 的综合能力，LLM-based evaluator 成本可控。
- **BFCL v4**：检验 Iter B（工具系统）+ Iter A（LLM 集成）底座，单题短，迭代快，能快速暴露回归。
- **τ2-bench**：Sierra Research 2025-12 发布，唯一专门测 **多轮工具 + 真实用户交互**的榜单；对 "single-shot information exchange" 攻击天然免疫，补齐前三榜单被 [Berkeley RDI audit](https://rdi.berkeley.edu/blog/trustworthy-benchmarks-cont/) 批评的 gaming 风险。

**Benchmark 整合性警告（D-16 同批添加）**：Berkeley RDI + 其他独立审计已证明 SWE-bench / WebArena / GAIA 的部分条目可以被"刷分"（如提前读 patch 解、通过 env var 泄漏答案）。我们的应对：
- 每次提交必附全量 trace，接受公开审查
- 不使用任何"用榜单数据 few-shot / fine-tune"的手段
- τ2-bench 作为 4 榜中最难 game 的锚定点

**不选**的常见 benchmark 原因见 §五。

---

## 三、Roadmap（Iter F+ 中等承诺）

| Benchmark | 类别 | 触发条件 | 预计 Iter |
|-----------|------|----------|----------|
| **WebArena** | Web 浏览 / 多步 UI 任务 | Iter E E4 之后，若 browser tool 稳定 | F1 |
| **OSWorld** | 跨应用桌面自动化 | WebArena 稳定 + GUI 工具包到位 | F2 |
| **AgentBench** | 综合 8 子任务 | SWE-bench + GAIA 进 top-10 后升级 | F2 |
| **MLE-bench** | ML 工程任务 | OmniMem vector + Skill Layer 4 就绪 | F3 |
| ~~tau-bench~~ | 已升级到 Pinned（τ2-bench）| — | — |
| **HumanEval+ / MBPP+** | 纯代码生成 | Iter A2 LLM 集成回归需要 | E4 尾声 |

**Roadmap 条目的共同要求**：
- 有官方 leaderboard + 可复现 harness
- 数据许可允许我们提交
- 失败场景有 trace 采集接口，能反哺 10-self-evolution

---

## 四、Aspirational（无日期，评估中）

| Benchmark | 未定原因 |
|-----------|---------|
| **AgentHarm** | 数据集访问需要白名单申请 |
| **Cybench / CyberSecEval** | 范围偏安全评测，需独立 threat model 配套 |
| **ScienceAgentBench** | 子任务分布偏科研域，短期 ROI 未验证 |
| **TheAgentCompany** | 模拟企业协作场景；harness 自建成本高 |
| **MultiBench (v2)** | 多模态评估；等 multi-modal 支持成熟 |
| **AndroidWorld / MobileAgent** | 移动端自动化；暂无 MVP 需求 |
| **TravelPlanner** | 单一垂类，信息价值低于 GAIA |
| **Competitive coding (CodeForces / ICPC 复现)** | 偏竞赛型，与产品形态不完全对齐 |

**升级到 Roadmap 的门槛**：写一页 feasibility 纪要，包括
1. harness 复现复杂度（1-5 档）
2. 估计的单次评估 API 成本（USD）
3. 期望 insight（对我们哪个子系统有诊断价值）
4. 是否有 SOTA 参照

---

## 五、Rejected（已否决）

| Benchmark | 否决原因 |
|-----------|---------|
| ~~MT-bench / AlpacaEval~~ | 纯 chat 评测，与 Agent 能力无关 |
| ~~MMLU / BIG-bench-hard~~ | 纯 LLM 知识评测，底模厂商问题，不考验 Agent |
| ~~Arena ELO（Human-preference）~~ | 依赖众包评委，Agent 框架层无法控制结果，投入产出低 |
| ~~自制 benchmark~~ | 2026-04-17 ultra-review D-09 否决；所有测评必须用公开榜单 |

---

## 六、Iter 排期摘要

```
Iter E1（harness infra）
  └─ benchmarks/ 目录 + generic runner + BFCL v4 小样本（10 题）走通
Iter E2（SWE-bench Verified）⭐
  └─ 500 题 harness + 首次正式提交
Iter E3（GAIA + BFCL v4 full）⭐
  └─ 两榜首次正式提交
Iter E4（aspirational pre-flight）
  └─ WebArena / tau-bench / HumanEval+ harness 草稿
Iter F1
  └─ WebArena + tau-bench 正式提交
Iter F2
  └─ OSWorld + AgentBench 正式提交
Iter F3
  └─ MLE-bench 正式提交；评估是否继续扩榜
```

---

## 七、资源估算原则

- 每个 pinned benchmark 分配**独立 API budget**，上限由 Iter retro 审批。
- 任何 benchmark 单次全量跑超过 **$200** API 成本前必须先做 10 题 smoke。
- Failure trajectory 自动入库 10-self-evolution，用于 skill 提取；不浪费跑分数据。
- 每次 benchmark 提交必须附带：
  1. 成绩数字 + 排名快照
  2. 全量 trace（可复现）
  3. 3 条代表性失败 case 分析
  4. 对比上次同 benchmark 的回归/进步

---

## 八、维护

- **审查节奏**：每个 Iter retro 必审；新 benchmark 提议走 PR 修本文档。
- **关联文档**：
  - [implementation-plan.md](../implementation-plan.md) Iter E 详细步骤
  - [docs/engineering/08-observability/README.md](../engineering/08-observability/README.md) trace 采集
  - [docs/engineering/10-self-evolution/README.md](../engineering/10-self-evolution/README.md) failure 复盘
- **不在本文档讨论**：具体 harness 实现（归 `benchmarks/` 子目录的 README）、prompt 工程（归每个 benchmark 自己的 `SYSTEM.md`）。
