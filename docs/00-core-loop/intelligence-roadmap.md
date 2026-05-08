# 智能感路线图 / Intelligence Roadmap

> Master index that maps the **10 puzzle pieces of "Claude-Code-level intelligence"** onto Quilin's 12 active engineering domains. For each piece: what's already done, what's missing, which iteration owns the gap, and which Linear project / source doc tracks it. Filed 2026-05-08 alongside the reactive-execution work, in response to the user's question "我想要我的 agent 有 Claude Code 你这样级别的智能".
>
> 主索引文档：把 **"Claude Code 级智能感"的 10 块拼图** 一一映射到 Quilin 12 个活跃工程领域。每块拼图记录：已完成的部分、缺失的部分、由哪个 iteration 负责、对应的 Linear project 和源文档。本文档于 2026-05-08 与 reactive-execution 一并落档，回应用户提问"我想要我的 agent 有 Claude Code 你这样级别的智能"。

---

## 一、核心论点 / Core Thesis

"Claude Code 级智能感" is **not** a single capability — it is a **bundled product feel** built from ten distinct pieces of harness engineering, each addressable as a separate iteration. The model itself contributes ~80 % of the perceived intelligence (and Quilin already lets you choose Claude Sonnet 4.6 / Opus 4.7, so this is settled). The remaining ~20 % comes from harness engineering, which is **fully in Quilin's control** and does not depend on model upgrades.

"Claude Code 级智能感"**不是**单一能力，而是十块独立的 harness engineering 拼图叠加出来的**整体产品感**，每一块都对应一个独立 iteration。模型本身贡献了感知智能的约 80%（Quilin 已经允许选 Claude Sonnet 4.6 / Opus 4.7，这部分已定型）。剩下约 20% 来自 harness engineering，**完全在 Quilin 可控范围内**，不依赖模型升级。

**Critical observation**: harness improvements that aren't measured will silently regress. Therefore **EDD (Eval-Driven Development) is a prerequisite**, not an optional luxury — it must land before any other harness change ships, otherwise we are flying blind. This roadmap places EDD as Iter L+0, immediately after the in-flight Iter L (Reactive Execution).

**关键观察**：harness 改动如果不评测，就会无声地退化。因此 **EDD（评测驱动开发）是先决条件**，不是可选项——它必须在所有其他 harness 改动合入之前先落地，否则后续都是盲改。本路线图把 EDD 放在 Iter L+0，紧接在进行中的 Iter L（反应式执行）之后。

---

## 二、10 块拼图全景表 / The Ten Pieces

| # | 用户感知 / User Perception | 内核机制 / Internal Mechanism | Quilin 现状 / Current State | 缺失 / Gap | 归属 / Iteration | 状态 / Status |
|---|---|---|---|---|---|---|
| 1 | "它知道这件事会跑很久，自己转后台"<br>"It knows this will take a while and backgrounds it" | 反应式执行（dispatch / 异常检测 / 降级）<br>Reactive execution (dispatch / anomaly detection / fallback) | 主 Loop 非阻塞 ✓<br>Main Loop non-blocking ✓ | tool metadata 三字段 + execution expectation tracking<br>Three tool metadata fields + execution expectation tracking | **Iter L** | ✅ project + tracker QUI-132 + source doc landed 2026-05-08 |
| 2 | "它选对了 grep 还是 spawn agent"<br>"It picks `grep` vs `spawn agent` correctly" | 工具品味（descriptor 质量 + 网关式 catalog）<br>Tool taste (descriptor quality + gateway catalog) | tool_search / skill_search / mcp_search 网关 ✓ (commit a3c683c) | descriptor "卖货式" 规范 + tool selection trace + lint<br>Marketing-style descriptor schema + tool selection trace + lint | **Iter L+1** | ✅ project + tracker QUI-136 + source doc landed 2026-05-08 |
| 3 | "它只拉刚刚够的上下文，不灌满"<br>"It pulls just enough context, doesn't flood" | 上下文裁剪 + token 预算 + descriptor 目录<br>Context trimming + token budget + descriptor catalog | PromptSessionAssembler / ContextManager / TokenBudgetAllocator ✓ | "什么时候自动 load 哪个 CLAUDE.md / 哪条 memory / 哪个 skill" 策略表<br>Policy table for "when to auto-load which CLAUDE.md / memory / skill" | **Iter L+2** | ✅ project + tracker QUI-137 + source doc landed 2026-05-08 |
| 4 | "该问就问、该自己定就自己定"<br>"It asks when needed, decides when not" | 对话工程（6 层活人感 + 风格开关）<br>Conversation engineering (6-layer alive-feel + style switches) | 02.x parked spec ✓ + ContextAssembler 注入 conversation-style ✓ | runtime 实现，把 plan_sketch + clarification 做成主 LLM 一等分支<br>Runtime impl: plan_sketch + clarification as first-class branches in main LLM | **Iter K** | ✅ project exists in Linear backlog |
| 5 | "记得我上次说过的偏好"<br>"Remembers my preferences from last time" | 记忆 + 用户画像 + 自动 memory<br>Memory + user profile + auto-memory | quilin-mem 4-tier ✓ + auto-memory 已用 ✓ | observer 自动写 user.md + memory.db 开箱即用 + BM25 全文检索<br>Observer auto-writes user.md + out-of-the-box memory.db + BM25 full-text | **Iter H** | ✅ project exists in Linear backlog |
| 6 | "做完会自己验证再说 done"<br>"Verifies before claiming done" | 实证纪律（git / 测试 / coverage）<br>Evidence discipline (git / tests / coverage) | CLAUDE.md "状态声明实证纪律" ✓<br>CLAUDE.md "evidence discipline" rule ✓ | PreCommit hook 自动 enforce 实证（commit message 缺 LOC / coverage / tsc 退出码即拒）<br>PreCommit hook auto-enforces evidence (rejects commit msgs missing LOC / coverage / tsc exit code) | 挂 Iter F1：[QUI-138](https://linear.app/quilin-agent/issue/QUI-138/precommit-evidence-enforcement-hook-status-evidence-discipline)<br>Parented to Iter F1: QUI-138 | ✅ filed 2026-05-08 |
| 7 | "TaskCreate 颗粒度刚好，能随时关再开"<br>"TaskCreate granularity is right; can close & resume" | 工作流塑形（plan ↔ execute ↔ task list）<br>Workflow shaping (plan ↔ execute ↔ task list) | TaskCreate / TaskUpdate 已用 ✓<br>TaskCreate / TaskUpdate in use ✓ | TaskList 跨 session 持久化 + subagent task 透传到主线程<br>TaskList cross-session persistence + subagent task surface to main thread | 挂 Iter G2：[QUI-139](https://linear.app/quilin-agent/issue/QUI-139/tasklist-cross-session-persistence-subagent-task-surface-to-main)<br>Parented to Iter G2: QUI-139 | ✅ filed 2026-05-08 |
| 8 | "需要的能力它会现学（skill load）"<br>"It learns capabilities on demand (skill load)" | Skills 系统<br>Skills system | 13 SKILL.md + catalog + 按需加载 ✓<br>13 SKILL.md + catalog + on-demand load ✓ | proactive skill suggestion（agent 主动提"该 load 这个 skill"）<br>Proactive skill suggestion (agent flags "should load this skill now") | **Iter I + 13 联动**<br>**Iter I × 13 cross-cut** | ✅ Iter I exists in backlog |
| 9 | "复杂任务它会派 subagent 并行"<br>"Spawns subagents in parallel for complex tasks" | 多 agent 编排（非阻塞 supervisor + heterogeneous mesh）<br>Multi-agent orchestration (non-blocking supervisor + heterogeneous mesh) | 06 + non-blocking supervisor ✓ | typed handoff、heterogeneous mesh runtime、checkpoint 透传<br>Typed handoff, heterogeneous mesh runtime, checkpoint propagation | **Iter F1** | ✅ project exists in Linear backlog |
| 10 | "用得越久它越懂我"<br>"Gets to know me the more I use it" | 自进化（trajectory mining → skill / patch）<br>Self-evolution (trajectory mining → skill / patch) | 10 + Iter I 已规划 ✓<br>10 + Iter I planned ✓ | Offline Optimizer 从 noop 升级为 DSPy/GEPA、idle_evolution 真激活、人工审核 TUI<br>Upgrade Offline Optimizer from noop to DSPy/GEPA, activate idle_evolution runtime, human-review TUI | **Iter I** | ✅ project exists in Linear backlog |

✅ = 已落地 / shipped；🚧 = 缺口待新建 issue / gap pending issue creation；⏳ = project 已建但 tracker issue 未建 / project landed, tracker issue pending.

---

## 三、推荐的 12 个月路线 / Recommended 12-month Sequence

| 月 / Month | 重点 / Focus | 预期产出 / Expected Output |
|---|---|---|
| 1-2 | **Iter L 反应式执行** (in flight) | 4 块原语落地（dispatch / non-blocking / observation / fallback） — "卡死能自救" 的 baseline.<br>Four primitives land — "self-recovery from stuck" baseline. |
| 2-3 | **Iter L+0 EDD 评测层** (NEW, P0 prerequisite) | 100-300 条真实 trace + EDD runner + CI hook + 6 个核心指标曲线.<br>100–300 real traces + EDD runner + CI hook + 6 core metrics curves. |
| 3-5 | **Iter L+1 工具品味** + **Iter L+2 上下文自动装配** | descriptor 卖货式重写 + auto-load 策略表 — "选工具/拉上下文不再靠运气".<br>Marketing-style descriptor rewrite + auto-load policy table — "tool / context selection no longer luck-based". |
| 5-7 | **Iter K 对话工程重启** | 6 层活人感 runtime + 7 风格预设 — "回话有人味".<br>6-layer alive-feel runtime + 7 style presets — "responses feel human". |
| 7-9 | **Iter H 记忆深化** + **Iter I 自进化** | 跨 session 偏好持久化 + skill 真自动产出 — "用得越久越懂我".<br>Cross-session preference persistence + actual skill auto-generation — "knows me better the more I use it". |
| 9-12 | **Iter F1 运行时规模化** + Iter G1/G2 完善 | 多 agent 并行 + 控制台 — "全栈 agent 体验".<br>Multi-agent parallelism + dashboard — "full-stack agent experience". |

EDD（Iter L+0）作为底座存在于整个 12 个月：每个新 iteration 合入前都必须跑 EDD 看 6 个指标不退步。

EDD (Iter L+0) underlies the whole 12 months: every iteration before merge must run EDD and show no regression on the six metrics.

---

## 四、为什么不是其他路线 / Why Not Other Paths

### 为什么不先做 Iter K / H / I 而做 L+0？/ Why L+0 before Iter K / H / I?

Iter K / H / I 都是"功能加深"型 iteration（对话风格、记忆深化、自进化）。它们的本质是改变 agent 的行为，**而行为改动如果不评测就是盲改**。先把 EDD 建起来，后续每个功能改动都能量化效果，否则用户会"感觉变好了但说不出来"或"感觉变差了但找不到原因"。

Iter K / H / I are all "feature deepening" iterations (conversation style, memory depth, self-evolution). They fundamentally change agent behavior. **Behavior changes without evaluation are blind changes.** Build EDD first; then every feature change can be quantified — otherwise the user will "feel it improved but can't say how" or "feel it regressed but can't find the cause".

### 为什么不直接做 14-Benchmark？/ Why not just do 14-Benchmark?

14-Benchmark 已被用户冻结（2026-05-02），原因是 SWE-bench / GAIA / BFCL 这种 leaderboard 投入产出比对自托管 agent 团队不合算。EDD 本质不同：

* **目标不同** — EDD 是内部回归追踪，不追外部排名
* **成本不同** — EDD 跑 100-300 条 trace，不跑 2000+ 任务
* **更新频率不同** — EDD 每 PR 跑一次，benchmark 每月跑一次
* **指标不同** — EDD 看 "这次改动是否让 agent 变笨"，benchmark 看 "我们在 SOTA 排第几"

14-Benchmark is frozen by user directive (2026-05-02) because the SWE-bench / GAIA / BFCL leaderboard ROI is poor for a self-hosted agent team. EDD is fundamentally different:

* **Different goal** — EDD tracks internal regression, not external ranking.
* **Different cost** — EDD runs 100–300 traces, not 2,000+ tasks.
* **Different cadence** — EDD runs every PR; benchmark runs monthly.
* **Different metric** — EDD answers "did this change make the agent dumber"; benchmark answers "where do we rank vs SOTA".

### 为什么 #6 / #7 不开独立 iteration？/ Why no dedicated iteration for #6 / #7?

#6（验证自动化）和 #7（工作流塑形）的范围都很窄，做成"散布在已有 iteration 里的若干小 issue"比建独立 iteration 性价比更高。具体：#6 挂在 09-Deployment（hook 系统是它的家），#7 挂在 06-Multi-Agent + Iter G2（task list runtime + UI）。

#6 (verification automation) and #7 (workflow shaping) are narrow in scope. Filing them as a handful of issues spread across existing iterations beats creating a dedicated iteration. Specifically: #6 belongs under 09-Deployment (hooks are its home); #7 belongs under 06-Multi-Agent + Iter G2 (task list runtime + UI).

---

## 五、关联 / Cross-References

### Linear Projects (本路线图涉及的全部 / all touched by this roadmap)

| 拼图 # / Piece # | Linear Project | 状态 / Status |
|---|---|---|
| 1 | [Iter L：反应式执行 / Reactive Execution](https://linear.app/quilin-agent/project/iter-l反应式执行-reactive-execution-891dc157a8d5) | 🚀 Active |
| 2 | [Iter L+1：工具品味 / Tool Taste](https://linear.app/quilin-agent/project/iter-l1工具品味-tool-taste-60e80c4db043) | 📥 Backlog (new 2026-05-08) |
| 3 | [Iter L+2：上下文自动装配 / Auto-context Curation](https://linear.app/quilin-agent/project/iter-l2上下文自动装配-auto-context-curation-c79d1abf1143) | 📥 Backlog (new 2026-05-08) |
| 4 | [Iter K：对话工程重启 / Conversation Engineering Restart](https://linear.app/quilin-agent/project/iter-k对话工程重启-conversation-engineering-restart-a34fc2e56393) | 📥 Backlog |
| 5 | [Iter H：记忆与感知深度化 / Memory and Perception Deepening](https://linear.app/quilin-agent/project/iter-h记忆与感知深度化-memory-and-perception-deepening-2c428c730964) | 📥 Backlog |
| EDD | [Iter L+0：评测驱动开发 / Eval-Driven Development](https://linear.app/quilin-agent/project/iter-l0评测驱动开发-eval-driven-development-b5b29b157f46) | 📥 Backlog (new 2026-05-08) |
| 8 + 10 | [Iter I：自主进化闭环 / Autonomous Self-Evolution Loop](https://linear.app/quilin-agent/project/iter-i自主进化闭环-autonomous-self-evolution-loop-e9c3f4400afa) | 📥 Backlog |
| 9 | [Iter F1：运行时规模化实现 / Runtime Scale-Out Implementation](https://linear.app/quilin-agent/project/iter-f1运行时规模化实现-runtime-scale-out-implementation-adfc62164654) | 📥 Backlog |

### Source Docs

| 文档 / Doc | 范围 / Scope |
|---|---|
| [`reactive-execution.md`](./reactive-execution.md) | Piece #1 — Iter L 完整设计 / full Iter L design |
| [`eval-driven-development.md`](./eval-driven-development.md) | EDD layer — Iter L+0 完整设计 / full Iter L+0 design |
| [`../05-tool/tool-taste.md`](../05-tool/tool-taste.md) | Piece #2 — Iter L+1 完整设计 / full Iter L+1 design |
| [`../02-context/auto-context-curation.md`](../02-context/auto-context-curation.md) | Piece #3 — Iter L+2 完整设计 / full Iter L+2 design |
| [`../02-context/conversation-engineering/`](../02-context/conversation-engineering/) | Piece #4 — parked Conversation Engineering spec / parked spec |
| [`../03-memory/README.md`](../03-memory/README.md) | Piece #5 — Memory layer current state / 记忆层当前状态 |
| [`../05-tool/README.md`](../05-tool/README.md) | Piece #2 + #6 — Tool engineering current state |
| [`../06-multi-agent/README.md`](../06-multi-agent/README.md) | Piece #7 + #9 — Multi-agent + workflow current state |
| [`../09-deployment-runtime/README.md`](../09-deployment-runtime/README.md) | Piece #6 — Deployment / hooks home |
| [`../10-self-evolution/README.md`](../10-self-evolution/README.md) | Piece #10 — Self-evolution current state |
| [`../13-skills/README.md`](../13-skills/README.md) | Piece #8 — Skills system current state |
