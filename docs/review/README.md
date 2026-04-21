# Review Index

> Timeline + cross-reference 索引,补齐 round-3 PB-02 指出的缺口。每份 review 的 finding 主体仍在各自文件,本索引只提供**入口** + **继承链**,不重复正文。

## 按时间线

从旧到新,每份 review 记录在什么前提下产生、解决了什么、被哪一份继承:

| 日期 | 文件 | 聚焦 | 产出 | 状态(2026-04-22) |
|---|---|---|---|---|
| 2026-04-17 | [2026-04-17-ultra-review.md](./2026-04-17-ultra-review.md) | **Round 1** — 整体架构 + 已写代码(11 并行 subagent,5 文档 + 6 代码) | **~170 findings**(14 CRIT / 59 HIGH / 62 MED / 35 LOW) | **partially-outdated**(13→12 领域口径 banner + 术语漂移注记已加) |
| 2026-04-20 | [2026-04-20-delta-audit.md](./2026-04-20-delta-audit.md) | Batch 2 / FEA-01 修复后差分审查(基线 `6959e28`) | **10 NEW findings**(1 CRIT / 4 HIGH / 5 MED),其中 NEW-01 数字 IP SSRF 最危险 | 已被 round-2 (`opus-4-7-revisit`) 吸收 |
| 2026-04-20 | [2026-04-20-code-ultra-review.md](./2026-04-20-code-ultra-review.md) | **代码层 Round 1** — 只审非 test 源文件(~3.5k LOC) | **26 findings**(3 CRIT / 10 HIGH / 8 MED / 5 LOW) | active(作为 phase-2 / round-3 的 predecessors) |
| 2026-04-20 | [2026-04-20-coverage-matrix.md](./2026-04-20-coverage-matrix.md) | 把 round-1 170 findings 逐条映射到 task | **14 CRITICAL 全覆盖**,19 HIGH 派工,MEDIUM 大部分 P2 backlog | active(task #ID 仍是索引真相源) |
| 2026-04-20 | [2026-04-20-opus-4-7-revisit.md](./2026-04-20-opus-4-7-revisit.md) | **Round 2** — 跨层复查 + 外部调研验证 | **6 NEW findings**(NEW-11..16)+ 7 外部调研 → 落地为 **D-11..21** 决策 | active(D-11..21 已陆续闭合,decision log 仍需索引) |
| 2026-04-21 | [2026-04-21-phase-2-review.md](./2026-04-21-phase-2-review.md) | Phase 2 reasoning lifecycle 代码 review(3 并行 subagent) | **18 findings**(3 CRIT / 7 HIGH / 5 MED / 3 LOW),3 CRIT 阻塞合并 | active(phase-2 合并前的契约证据) |
| 2026-04-21 | [2026-04-21-prompt-cache-architecture-spec.md](./2026-04-21-prompt-cache-architecture-spec.md) | Prompt Cache 架构 spec(非 finding,为设计草案) | `PromptSessionAssembler` + cache-adapter + single sliding breakpoint 方案 | draft for review(注:本文是 spec 不是 finding list,归入 review 目录因为定稿前走了 review 流程) |
| 2026-04-21 | [2026-04-21-post-push-graph-review.md](./2026-04-21-post-push-graph-review.md) | 3 commit(`b967d1c` / `0464377` / `117b879`)post-push graph review,基线 `6fdda11` | risk_score 0.60,核心声明 C.2 89 errors | **partially-outdated**(residual 已收敛到 61,见 `docs/planning/2026-04-22-01-tsc-hard-gate.md`) |
| 2026-04-21 | [2026-04-21-opus-4-7-round-3.md](./2026-04-21-opus-4-7-round-3.md) | **Round 3** — 架构 + 代码交叉复查(基线 `0464377` 合入前快照) | **14 findings**(CC-01..03 / SD-06..08 / AA-01..05 / PB-01..03)+ 4 维度差异化价值 | **partially-outdated**(CC-01/02/03 已实证更正,详见文档 banner;VERIFIED 表 2026-04-22 更新) |
| 2026-04-22 | (多 commit 收尾,无单独 review 文件) | **Track C 收尾** — round-3 4 条遗留 + PB-02 索引 + AA-04 heuristic 重构 | 6 commits(`776300e` CC-01 / `a6c7cab` SD-08 / `106448d` PB-03 / `9dec6e1` AA-04 / `3dc62e7` PB-02 / `9211db4` AA-04 重构) | active(round-3 主体 findings 已闭合,残余为 Iter B3b 跨 session 跟踪) |

## 按继承链

```
2026-04-17  Round 1 Ultra-Review (170 findings)
    │
    ├─→ 2026-04-20  Delta Audit (batch 2 验收 + 10 NEW)  ─┐
    │                                                     │
    ├─→ 2026-04-20  Coverage Matrix (170 → task 映射)     │
    │                                                     │
    ├─→ 2026-04-20  Code Ultra-Review (代码 26 findings)  │
    │                                                     │
    └─→ 2026-04-20  Opus 4.7 Revisit (Round 2) ←──────────┘
             │
             ├─→ D-11..D-21 决策落地
             │
             ├─→ 2026-04-21  Phase 2 Code Review (18 findings, phase-2 合并门)
             │
             ├─→ 2026-04-21  Prompt Cache Spec (设计草案)
             │
             ├─→ 2026-04-21  Post-push Graph Review (3 commit 风险扫描)
             │
             └─→ 2026-04-21  Round 3 (14 findings)
                      │
                      └─→ 2026-04-22  Track C 收尾(6 commits 776300e..9211db4)
                             闭合:CC-01 / SD-08 / PB-03 / AA-04 / PB-02
                             残余:Iter B3b 跨 session 跟踪(非 round-3 主线)
```

## 按"我想找 X"

| 目标 | 去哪里 |
|---|---|
| 找一条特定 finding 的状态 / 闭合证据 | 先看 [coverage-matrix](./2026-04-20-coverage-matrix.md) 的 task 映射,再看对应 `docs/planning/YYYY-MM-DD-NN-*.md` tracking doc |
| 找 D-## 决策(D-11..D-21)源头 | [2026-04-20-opus-4-7-revisit.md](./2026-04-20-opus-4-7-revisit.md) |
| 找 CC-## / SD-## / AA-## / PB-## finding | [2026-04-21-opus-4-7-round-3.md](./2026-04-21-opus-4-7-round-3.md) |
| 找 CRIT / HIGH 代码漏洞的当前状态 | 先 [code-ultra-review](./2026-04-20-code-ultra-review.md) + [delta-audit](./2026-04-20-delta-audit.md) 两篇对照,代码已 FIXED 部分在 [coverage-matrix](./2026-04-20-coverage-matrix.md) |
| 找 Phase N 合并前的代码 review | `docs/review/YYYY-MM-DD-phase-N-review.md`(目前有 phase-2);Phase 3+ 在 Iter B3b 中会陆续产出 |
| 找某个 commit 的 post-push 风险评分 | 搜索 `docs/review/*post-push*.md`;目前只有 `2026-04-21-post-push-graph-review.md`(partially-outdated) |
| 找术语漂移 / 口径统一 | `docs/architecture/glossary.md` + 各 review 内 banner(旧 review 保留历史字样,当前 spec 为准) |

## 失效标记约定

旧 review 不会被删除,也不会被回改正文。当后续实证推翻某条声明时,在文件头部加 banner:

- `partially-outdated-YYYY-MM-DD`:**大部分**声明过时或被继任者覆盖,仍保留作历史记录(如 round-3 / round-1 / post-push-graph-review)
- `superseded-by: <path>`:**整篇**被取代(目前 review 目录无该状态)
- 无 banner = 声明仍成立

## 本索引的维护约定

- 新增 review 文件时:在**按时间线**表尾追加一行 + 在**按继承链**图里接到最近的 predecessor
- review 内任一 finding 被闭合:更新**按"我想找 X"**表格中对应路径(如果有新 tracking doc)
- review 变成 partially-outdated:更新**按时间线**表的状态列
- **不在本文件重复 finding 正文** —— 只做入口
