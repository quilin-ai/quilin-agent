---
title: Iter E1 — Benchmark Harness Infra Bootstrap（planning-only）
status: planning
owner: Claude (plan) + Codex (impl when unblocked)
created: 2026-04-22
last_updated: 2026-04-22
reviewed_by: Codex  # 2026-04-22 cross-review，Q1/Q2/Q3 已达成 consensus，2 处纠错已采纳
predecessors:
  - docs/planning/00-implementation-plan.md  # §Iteration E §E1 列 5 项 deliverable
  - docs/planning/benchmark-roadmap.md  # Alive/Success/Aspirational 三档阈值 + E1 门禁清单
  - docs/planning/2026-04-22-09-ci-restoration.md  # master 稳态前置
threat_surface_delta:
  # 本 planning doc 本身是 planning-only（不落 code commit），所以零运行时 delta。
  # **实施阶段**（benchmarks/ 目录落地、runner 跑 real SWE-bench-lite task）引入的 delta
  # 会在该阶段的**独立 phase planning doc** 里重新审计、补完整 schema。此处**显式**列出
  # 预期的 delta 面，作为 E1 impl 开工前必须拦截的威胁面：
  #
  #   预期 new_ingress:
  #     - source: SWE-bench-lite 数据集（datasets/princeton-nlp/SWE-bench_lite）
  #       trust: untrusted
  #       mitigations: [checksum-verify, offline-cache, injection-scanner on issue text]
  #     - source: per-task GitHub repo clone（SWE-bench-lite fixtures 引用的真实 repo）
  #       trust: untrusted
  #       mitigations: [sandbox-exec, shallow-clone, network-deny-after-clone]
  #   预期 new_egress:
  #     - sink: cost tracker persistence file (.benchmarks/runs/<run-id>/cost.jsonl)
  #       trust: trusted  # 落本地磁盘
  #       mitigations: [no-secrets-in-payload, size-cap]
  #     - sink: evaluation-result payload（最终提交包 → submission pipeline E2）
  #       trust: trusted
  #       mitigations: [redact-secrets, schema-validate]
  #   预期 new_persistence:
  #     - location: .benchmarks/ 根目录 + runs/<run-id>/**（日志、patches、评分）
  #       sensitive: [task_patch（可能含 repo 路径）, llm_transcript（含用户/模型 token）]
  #       migration: 新目录、加 .gitignore、不入版本控制；子目录 schemaVersion=1
  new_ingress: []
  new_egress: []
  new_persistence: []
---

# Iter E1 — Benchmark Harness Infra Bootstrap

> **本文是 planning-only**。不开 code commit。实施阶段每个 phase 要开独立 tracking doc，届时补全 `threat_surface_delta` 子项。

## 目标

把 `00-implementation-plan.md` §E1 列的 5 项模糊 deliverable 拆成**可验证的最小切口**，让 Codex 开工时有明确 DoD 而不是 5 条 bullet。

**最小可执行切口（MVP）**：跑通 **SWE-bench Lite 10 题小样本** + **cost tracker 落盘**。这是 `benchmark-roadmap.md` 门禁清单中的第一条：

> [ ] 10 题小样本 run 过(E1 deliverable)
> [ ] cost tracking 数值已记录（每题 $x,每轮 tokens y）

**刻意不做**：
- 不做 500 题全量 SWE-bench Verified（那是 E2）
- 不做 GAIA / BFCL v4（E3）
- 不做 submission pipeline 正式提包（E2/E3 出口）
- 不做 dockerize / 完整沙箱（Iter F mesh/WASM 再谈）
- 不做 resume / retry / parallel run（E1 先线性单跑）

## 为什么是 SWE-bench **Lite** 不是 **Verified**（口径对齐）

**重要**：`readme.md` / `00-implementation-plan.md` / `benchmark-roadmap.md` 里 pinned leaderboard 口径**仍然是 SWE-bench Verified**，本 E1 用 Lite **不是改 pinned 口径**。Lite 在 E1 的身份是 **harness validation surrogate**（验证 harness 管道能跑通），**不是**参赛榜单替换。E2 正式冲榜时按 pinned 口径用 Verified 全量。

- **Lite = 300 题**（Verified 500 题），是 public 过滤子集，task definitions 一致、评分器相同
- Lite 环境更轻，跑 10 题成本 <$5，Verified 10 题可能 >$15
- `00-implementation-plan.md` 只写 "10 题 SWE-bench"，没指定 Lite/Verified；Lite 10 题等价于 Verified 10 题的 harness 测试，但成本 1/3
- **E1 出口闭合时**要在 closure doc 里显式声明 "Lite 只是 E1 surrogate，pinned=Verified 不变"，防止口径 drift

## Phases

| # | 名称 | 状态 | Owner | Commit | 备注 |
|---|---|---|---|---|---|
| E1-a | `benchmarks/` 目录 + dataset 下载器 | pending | Codex | — | 纯 infra，无 LLM 调用 |
| E1-b | SWE-bench Lite task loader + golden patch loader | pending | Codex | — | 读 jsonl，parse，exposez iterator |
| E1-c | Runner + cost tracker + 10 题线性跑通 | pending | Codex | — | 本 E1 的 verification 出口 |
| E1-d | Evaluator adapter（调 SWE-bench 官方评分器，per-task pass/fail） | pending | Codex | — | 可选插件 — E2 开工前必备但 MVP 可留 stub |

### Phase E1-a — `benchmarks/` 目录 + dataset 下载器

- **做什么**：
  - 建 `benchmarks/` **TS pnpm workspace**（Q1 consensus：E1-a/b/c 走 TS，E1-d 才走 Python）
  - `benchmarks/swe-bench-lite/dataset.ts`：封装 `datasets/princeton-nlp/SWE-bench_lite` 加载（从 huggingface 或 github mirror 取 jsonl），落本地 `.benchmarks/datasets/swe-bench-lite/` 缓存
  - `.gitignore` 添加 `.benchmarks/`
  - `scripts/fetch-benchmark.ts`：一次性下载 + checksum 验证
  - **`runAgentLoop` 公共 export**（E1-a blocker）：`packages/agent-core/src/loop.ts:24` 有 `export async function runAgentLoop(...)` 但 `packages/agent-core/src/index.ts` 未 re-export。**默认方案**（采纳 Codex 2026-04-22 consensus）：补 public re-export 到 `index.ts`（加 `export * from "./loop.js"` 或显式 `export { runAgentLoop, type AgentLoopOptions }`），这样 `benchmarks/runner.ts` 可以直接 `import { runAgentLoop } from "@quilin/agent-core"`。**fallback**：允许 benchmarks/ 临时直连 `@quilin/agent-core/loop.js` 内部路径，但必须标注 tech debt（impl 时注释写清）
- **不做什么**：不跑任务，不调 LLM
- **威胁面 delta**（本 phase 独立填；在开工前 PR review 时加到 `frontmatter.threat_surface_delta`）：
  - 新增 ingress：dataset 下载（huggingface / github mirror, untrusted），缓解 = checksum-verify + offline-cache
  - 新增 egress：无
  - 新增 persistence：`.benchmarks/datasets/swe-bench-lite/*.jsonl`（trusted dataset），不入版本控制
- **依赖**：无（packaging 级 infra）
- **验证**：`bun run benchmarks/scripts/fetch-benchmark.ts --dataset=swe-bench-lite` 成功下载并落盘，jsonl 可 parse
- **产出**：`benchmarks/` + `.benchmarks/datasets/` + `scripts/fetch-benchmark.ts`

### Phase E1-b — Task loader + golden patch loader

- **做什么**：
  - `benchmarks/swe-bench-lite/task-loader.ts`：迭代 task，提供 `{ instance_id, problem_statement, repo, base_commit, golden_patch, test_patch }`
  - 单测覆盖 3-5 题的 parse 正确性
- **不做什么**：不 clone repo、不跑 harness
- **威胁面 delta**：沿用 E1-a 的 persistence，无新增
- **依赖**：E1-a
- **验证**：vitest 3-5 题 fixture 校验 loader 输出 schema
- **产出**：`benchmarks/swe-bench-lite/task-loader.ts` + `.test.ts`

### Phase E1-c — Runner + cost tracker + 10 题线性跑通（**E1 MVP 出口**）

- **做什么**：
  - `benchmarks/runner.ts`：
    - 接受 task iterator → 每题：shallow-clone repo 到 per-task `.benchmarks/runs/<run-id>/workspaces/<instance-id>/`，checkout base_commit
    - 喂 `problem_statement` 给 Quilin agent loop（走 `packages/agent-core` 的 `runAgentLoop`），让 agent 输出 patch
    - 落地 patch → `.benchmarks/runs/<run-id>/patches/<instance-id>.patch`
    - **先不评分**：只记录 agent 是否生成 patch + 调用 LLM 的 token/cost
  - `benchmarks/cost-tracker.ts`：
    - 订阅 agent-core 的 token usage 事件（Iter D08 observability 已落地），累积 per-task 成本
    - 落 `.benchmarks/runs/<run-id>/cost.jsonl`，schema: `{ instance_id, input_tokens, output_tokens, total_usd, wall_ms }`
  - `benchmarks/runner.test.ts`：mock 2 题，校验 cost tracker 输出 schema
- **不做什么**：
  - 不调 SWE-bench 官方评分器（那是 E1-d）
  - 不并行（线性 10 题 for-loop）
  - 不 retry（失败就记为 fail）
  - 不 dockerize（per-task dir 已经够隔离）
- **威胁面 delta**（实施时补完）：
  - 新增 ingress：target repo clone（untrusted），缓解 = shallow-clone + network-deny-after-clone + sandbox-exec（走 shell_exec 走 WriteAuthority gate）
  - 新增 egress：cost tracker 落盘（trusted local），缓解 = no-secrets-in-payload / size-cap
  - 新增 persistence：`.benchmarks/runs/<run-id>/**`，sensitive=[patch, transcript]，不入版本控制
- **依赖**：E1-a + E1-b + agent-core token usage emit（`packages/agent-core/src/llm/token-usage.ts` 已有）
- **验证（E1 MVP 硬门禁）**：
  - [ ] 跑完 10 题不崩（过 = CI-verified 小样本）
  - [ ] `.benchmarks/runs/<run-id>/cost.jsonl` 10 行，schema 齐全
  - [ ] 每题 wall 时间 < 10 min（cost ceiling 预估 < $1/题）
  - [ ] 总 cost < $10
  - [ ] patch 生成率 ≥ 50%（10 题至少 5 题能产出非空 patch；**不要求 patch 过 SWE-bench 评分器**，那是 E1-d/E2）
- **产出**：`benchmarks/runner.ts` + `benchmarks/cost-tracker.ts` + `.benchmarks/runs/<run-id>/` 样例

### Phase E1-d — Evaluator adapter（可留 stub）

- **做什么**：
  - 调 SWE-bench 官方 `swebench` Python 评分器（pip/uv 装）
  - 每题 patch → pass/fail
  - 补齐 `.benchmarks/runs/<run-id>/scores.jsonl`
- **不做什么**：不做 submission 包
- **威胁面 delta**：评分器是 untrusted 外部 code；沙箱隔离按 07-safety shell_exec gate 复用
- **依赖**：E1-c
- **验证**：10 题 scores.jsonl 齐全，人工核对 3 题
- **MVP 是否硬必须**：**否**。E1 MVP 可留 stub（placeholder score = null），到 E2 开工前必须补完
- **产出**：`benchmarks/evaluator.ts` + `.test.ts`

## E1 出口（验证标准）

> 闭合 E1 需要 **E1-a + E1-b + E1-c** 三段过 verification，**E1-d 可留 stub**。

- [ ] `benchmarks/` workspace 入 `justfile`（新 `just bench-fetch` / `just bench-run-10` 两条）
- [ ] CI 可选添加 `bench-smoke` job（nightly / manual-trigger，不入 push gate，避免把 master CI 时间拖长）
- [ ] `benchmark-roadmap.md` 门禁 "10 题小样本 run 过" 和 "cost tracking 数值已记录" 打 ✅
- [ ] 写 `2026-04-??-??-iter-e1-closure.md` 记录首批 10 题实测 cost（回馈 benchmark-roadmap §Open Questions）

## Resolved Decisions（2026-04-22 Claude↔Codex cross-review consensus）

> 原 Open Questions 已经通过 AgentBridge 对称异步 review 收敛。以下是 3 题的最终决策 + 理由。disagreements 以 Codex independent view 为准。

### Q1 — `benchmarks/` 语言选型 → **Hybrid，切分精确**

- **E1-a / E1-b / E1-c 走 TS**（`benchmarks/` pnpm workspace）：dataset fetch/cache、task loader、runner、cost tracker 都放 TS
- **E1-d 走 Python**（`providers/benchmark-eval/` uv workspace，或 `benchmarks/evaluator/` 下独立 python subdir 待 E1-d 实施时决）：只把 evaluator adapter 放 Python，调用官方 `swebench` 评分器
- **理由（Codex consensus）**：E1 MVP 的出口是 "10 题 no-crash + cost.jsonl + patch-gen≥50%"，核心复杂度在 **调 agent loop + 记 token/cost**，这部分离 TS runtime 最近；把 runner 放 Python 只会把 agent-core 调用又包一层进程边界，徒增 orchestration 成本
- **拦路虎实证**（Codex 2026-04-22 现场实证 + Claude 复核）：`packages/agent-core/src/loop.ts:24` 导出 `runAgentLoop`，但 `packages/agent-core/src/index.ts` 未 re-export —— **E1-a 必须先解决 public re-export**（见 E1-a section）

### Q2 — agent 喂什么 prompt → **C-lite（非 bare，非全开）**

- **C-lite 协议**：
  - 输入 = issue `problem_statement` + 隔离 repo 工作目录 + **允许 agent 自主 grep/read**
  - **工具白名单限 read-only 子集**：`file_read` / `file_list` / `shell_exec`（仅 git/rg/sed/cat 等只读命令） / patch 产出路径约束
  - **关闭**：`web_fetch`（benchmark 隔离面禁对外网络）、`file_write`（只允许 patch 产出路径）、 `skill_create` / `shell_exec`（write 类子命令）
  - **system prompt 硬约束**（实施时写死）：
    1. "你在一个隔离 repo 工作目录中"
    2. "你可以自行读文件和运行只读命令定位问题"
    3. "最终必须通过生成 git patch 作为结果"
    4. "不要求自跑完整评分，只要求留下有效 patch"
- **为什么不是 A (bare issue)**：agent 不知道交付格式，E1 失败时分不清 "loop 不行" vs "agent 没被告知要产 patch"
- **为什么不是 B (预处理 grep context)**：烘焙上下文会作弊，测不到 agent loop 真实能力
- **为什么不是 C (全开 tool-use)**：会测到 tool policy 的影响（比如网络抓 Stack Overflow），不是 loop baseline；$10 ceiling 也会很快失真
- **Codex 独立判断理由（已采纳）**：E1 要的是 loop baseline，不是 tool-policy 研究面，所以必须把工具面锁死到 benchmark-safe read-only

### Q3 — 10 题怎么选 → **SWE-bench Lite 前 10 题**（不是 seed=42 随机，不是手选）

- **决策**：取 Lite dataset 按官方顺序前 10 题（可用 `.slice(0, 10)`）
- **理由（Codex consensus）**：E1 不是能力评估，是 harness bootstrap。最重要的是 **零设计摩擦 + 可复现 + 比较面固定**。随机 seed=42 看似科学，实际上会平白引入"为什么是这 10 题"的讨论面
- **对长尾风险的处理**：如果前 10 题真撞到某个 repo 全打不过，那是 E1 的**有价值发现**（说明 harness 没问题，但 agent 在某类问题上有系统性短板），不是缺点。E2 扩到 Verified 再解决代表性问题
- **不做**：seed-based 随机 sampling、手选"好对付"的题（会扭曲 cost/pass-rate baseline）

## 不写进本文的东西（Codex cross-review 强调别稀释因果链）

- 不在本 doc 做 **submission pipeline** 设计（E2 scope）
- 不在本 doc 做 **dockerize** 设计（Iter F WASM sandbox）
- 不在本 doc 讨论 **GAIA / BFCL harness 差异**（E3 scope）
- 不在本 doc 讨论 **Memory 降级策略**（00-plan §E2 已记录，E2 开工时再展开）

## Blockers

- **无**。2026-04-22 Codex cross-review 后 3 题 consensus 达成，2 处纠错（Lite=surrogate / `runAgentLoop` export）已回填，Docs Lint + CI 全绿（HEAD `22e5b2f`），E1-a 可以开工。

## Next Action

**本 planning doc 到此收口。** 后续执行分工：

1. ✅ Claude push 本 doc（planning only） — done `a38f2a6`
2. ✅ Codex 答 3 条 Open Questions + 2 处纠错 — done（2026-04-22 AgentBridge）
3. ✅ Claude 回填 consensus 到本 doc + push — done（本次 commit）
4. **→ Codex 起 `2026-04-??-??-iter-e1-a-benchmarks-workspace.md` tracking doc，进入 E1-a 实施**（benchmarks/ workspace + dataset fetch + `runAgentLoop` public re-export）
5. E1-a / -b / -c 顺次跑，每 phase 独立 closure doc，Claude 负责 cross-review
6. E1-c 跑通 10 题后，回填 `benchmark-roadmap.md` "首批实测 cost" 数据点，写 `iter-e1-closure.md`
