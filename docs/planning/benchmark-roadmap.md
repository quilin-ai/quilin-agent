---
title: Benchmark Roadmap — Alive / Success Baselines (Iter E)
status: planning
owner: Claude (plan) + Codex (harness impl 待 Iter E 启动)
created: 2026-04-22
last_updated: 2026-04-22
precedes:
  - docs/planning/00-implementation-plan.md  # Iter E §E1..E4
predecessors:
  - docs/review/2026-04-21-opus-4-7-round-3.md  # AA-04
  - docs/architecture/overview.md              # benchmark 定位
threat_surface_delta:
  new_ingress: []        # 纯 planning 文档,零运行时入口
  new_egress: []         # 无 outbound payload(真正的 submission pipeline 在 E1 实现时再审)
  new_persistence: []    # 无落盘(benchmark 产物由 Iter E harness 落 `.benchmarks/` 时单独审)
---

# Benchmark Roadmap — Alive / Success Baselines

## 目标

把"Iter E 要过多少才叫有意义"从隐式默认变成**显式阈值**。round-3 AA-04 指出:`overview.md` / `00-implementation-plan.md` 声明了 3 pinned 榜单(SWE-bench Verified / GAIA / BFCL v4),但没有回答"跑到 30% 是活着还是失败"。本文补上这个缺口。

> **范围**:本文只定义**每个 benchmark 的通过/失败阈值**和**反推的能力缺口**。harness 实现、submission pipeline、cost tracking 在 `00-implementation-plan.md` §Iter E(E1..E4)中落地,不在本文重复。

## 核心定义

| 术语 | 含义 | 触发动作 |
|---|---|---|
| **Alive baseline** | "项目跑起来了"的最低门槛;过不了 = 不上榜、不声称参赛 | 低于 alive → 回到 Iter A..D 复盘单 Agent 能力;不算 Iter E 失败,但必须发 blocker report |
| **Success baseline** | "项目交付价值"的默认宣传线;过得了 = Iter E **正式收官** | 到达 success → declare Iter E done,后续 benchmark 提升归入 Iter F 的 Self-Evolution |
| **Aspirational target** | 行业顶线参照(SOTA 或前三);**不是** planning 合约,不阻塞收官 | 只作为 Self-Evolution / Multi-Agent Mesh 的长期靶心 |

**默认取"成功"解读的阈值是 Success baseline**。Alive 是**不翻车的底线**,不是胜利条件。

## 阈值表(反推自当前能力 + 行业 SOTA)

| Benchmark | Alive(下限) | Success(默认宣传线) | Aspirational(SOTA 参照 / 前 3) | 能力依赖 |
|---|---|---|---|---|
| **SWE-bench Verified** ⭐ Pinned | ≥ **30%** | ≥ **50%** | Top 3 ≈ 77.8-80.9%(2026-04) | Iter B 文件/shell 工具 + Iter C planning + Iter D obs + 03-memory Phase 0 FTS5 + per-task scratchpad(D-15) |
| **GAIA** ⭐ Pinned | ≥ **40%** | ≥ **55%** | 第一名 44.8%(2026-04);长尾 60%+(Manus 67.9% historical) | Iter B tool use + Iter C 多步推理 + 07-safety injection guard |
| **BFCL v4** ⭐ Pinned | ≥ **70%** | ≥ **80%** | 前 3 波动在 ~85-90%,不稳定 | Iter B tool schema routing + Iter C tool-call planning + 01-LLM parallel tool call |
| τ2-bench / τ-bench | ≥ 80%(aspirational) | ≥ 90%(aspirational) | Opus 4.6 telecom 99.3% | **Aspirational only** — 不是 pinned,Iter E4 按 harness 预算决定是否跑 |

**阈值反推原则**(给后继 review 可追溯):
- Alive = 当前"最笨 baseline agent"(LLM + 浅层工具调用,无 memory)理论可达数字的 1.2x。**低于此** = 说明我们的设计层没给 LLM 加分 → Iter A..D 有设计缺陷,不是调参问题。
- Success = Alive × 1.5-1.8,位于"SOTA 中位"区间。**超过此** = Quilin 在单 Agent 单模型前提下有显著增量价值,值得对外宣称"Iter E 收官"。
- Aspirational = 当前 SOTA 或前 3 水平,**多 Agent mesh / idle evolution / user-tuned skills 才有望触及**;留给 Iter F 及以后。

**τ2-bench 为什么是 aspirational 而非 pinned**:
- `quilin.md` 已明确"3 pinned + roadmap"(SWE-bench / GAIA / BFCL v4);τ2 属于 Iter E4 aspirational roadmap
- 99.3% 的 Opus 4.6 telecom 数字是单 domain(telecom)特化,不代表跨 domain 能力;作为参照保留,不作合约

## 过 / 不过的判定流程

```
submission 完成
   ├─ 分数 ≥ Success → 宣布"Iter E 收官",Aspirational 进 Iter F roadmap
   ├─ Alive ≤ 分数 < Success → 记录"Iter E MVP",发 learnings note;可选择继续调 or 进 Iter F
   └─ 分数 < Alive → 停止上榜,发 blocker report 标明失败类型:
                    - capability_gap(工具/memory/planning 缺件) → 回 Iter A..D
                    - harness_bug(分数被环境/评分器扭曲) → 回 E1 修 harness
                    - data_leakage / overfitting → 回 E1 隔离数据
```

**任何 benchmark 提交前的前置**(E2/E3 开工门禁):
- [ ] 10 题小样本 run 过(E1 deliverable)
- [ ] cost tracking 数值已记录(每题 $x,每轮 tokens y)
- [ ] 至少 1 次内部 dry-run 过 Alive 线
- [ ] 抽样 3 题人工核对评分器正确

## Iter E 收官 vs Iter F 起点

- **Iter E 收官**:3 个 pinned 都到 Success baseline,τ2 至少 Alive,harness 通用化完成(支持新 benchmark 用 ≤200 LOC 接入)
- **Iter F 起点**:Iter E 收官基础上叠加 multi-Agent mesh / idle evolution / user-insight engine,把 aspirational 目标推到 SOTA Top 10

## Decisions

### 2026-04-22 — 阈值首次定稿(由本文建立)

- **Before**:阈值分散在 round-3 review 正文 + implementation-plan 的"首次目标"字段,无统一 Alive/Success 语义
- **After**:本文为阈值**唯一真相源**;`00-implementation-plan.md` §Iter E 的数字在下次更新时指向本文
- **证据**:`docs/review/2026-04-21-opus-4-7-round-3.md` §AA-04 行 194-195 给出初始建议值;本文吸收 + 补 τ2 的 aspirational 定位

## Open Questions

- [ ] Alive 线是否太保守?等 E1 harness 跑出第一批真实数字后(预计 Iter E1 完成时)回看一次
- [ ] τ2 保持 aspirational 还是升为第 4 pinned?依赖 Iter F multi-Agent mesh 成熟度
- [ ] 多模型 ensemble(Claude + GPT)下的阈值是否单独定?现阶段默认"单模型 Quilin"口径
- [ ] 失败重试策略:分数低于 Alive 时允许重跑几轮?(防止单次环境抖动误判)

## Blockers

- 无(planning-only,Iter E 启动前不阻塞任何并行 track)

## Next Action

- **本文首版落地**:提交后等 Iter E1 harness infra 建成,补一次"实测基线 vs 阈值"的复盘
- **同步点**:下次改 `00-implementation-plan.md` §Iter E 时,把其中"首次目标"字段替换为指向本文的链接
