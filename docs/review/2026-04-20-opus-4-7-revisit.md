# 2026-04-20 Opus 4.7 Architecture Revisit

**日期**：2026-04-20
**评审人**：Opus 4.7（用户升级后 re-review）
**承接**：[2026-04-17 Ultra-Review](./2026-04-17-ultra-review.md)（170 findings）+ [2026-04-20 Delta Audit](./2026-04-20-delta-audit.md)（10 NEW findings）

> 目的：借 Opus 4.7 升级机会对整个架构做一轮**跨层复查**。本报告记录在已修复 180 条 finding 之外**新发现的 6 条问题**，以及 7 条**外部调研验证**后对当前技术选型的确认 / 调整。

---

## 一、新发现的 6 条 finding（NEW-11..16）

| # | Severity | 问题 | 修复 | D-# 编号 |
|---|---------|------|------|---------|
| NEW-11 | 🔴 CRITICAL | 03-memory Layer 4 与 13-skills SKILL.md 双写冲突（skill body + trigger_pattern 两处并存） | Layer 4 改名 "Procedural Memory / Skill Usage Stats"，只存 usage counter；SKILL.md 为唯一真源 | **D-11** |
| NEW-12 | 🟠 HIGH | OmniMem tier 迁移（FIFO / Discard-all / Reflector）无 observability | 08-observability 新增 `memory_tier_transition` span + 3 metrics | **D-18** |
| NEW-13 | 🟠 HIGH | implementation-plan Iter D CI 矩阵自相矛盾（只跑 TS+Py vs 三语言全绿） | 统一为 "cargo check 强制 / cargo test noop" | **D-14** |
| NEW-14 | 🟡 MEDIUM | Iter E2 SWE-bench 前置依赖漏 03-memory | E2 deps 补 "03-memory Phase 0 FTS5 + per-task scratchpad"；声明 "不使用跨会话 4 层" 降级策略 | **D-15** |
| NEW-15 | 🟡 MEDIUM | Skill catalog 按 `recency × relevance` 排序破坏 KV-cache 前缀 | 拆"稳定前缀段 lex 排序"+"`<hot_skills>` 热门段 ≤10 条放前缀之后" | **D-13** |
| NEW-16 | ⚪ LOW | 05-tool §2.5 引用未定义术语 "Deferred Tools" | glossary.md 补术语定义 | — |

### NEW-11 细节（最高严重度）

**问题**：
- 13-skills §2.6 D-05 已明确声明 SKILL.md 是 SSoT，`skill_manage` 是唯一写入口
- 但 03-memory Layer 4 原文本定义 `SkillTemplate`（含 body / trigger_pattern / execution_steps / input_schema / output_schema）+ `SkillExtractor` 自动创建
- 10-self-evolution §5.2/5.3 数据流图也写 "SkillManager 直接写入 Skill Memory"
- 结果：启动后会并存两套 skill store — 文件系统 SKILL.md + OmniMem 表；CRUD race / 索引漂移 / 回滚不一致

**修复**：
1. 03-memory Layer 4 改名 "Procedural Memory / Skill Usage Stats"
2. 只保留 `SkillUsageStat {skill_id, success_count, invocation_count, last_used}`
3. 删除 `SkillTemplate` / `SkillExtractor` 自动创建
4. 10-self §5.2/5.3 数据流图改 "只更新 usage counter，不写 body"

---

## 二、外部调研采纳决策（A..G）

基于 Opus 4.7 spawn 的外部调研 agent（`best-practices-researcher`）对 2026-04 技术栈的核实：

| 领域 | 原决策 | 调研结论 | 采纳动作 |
|------|--------|---------|---------|
| **A. LLM SDK** | Vercel AI SDK v6 | ✅ 保留（v6 = Agent/ToolLoopAgent/@ai-sdk/mcp 稳定；Mastra 在其上层，不冲突） | 无需改（未来可通过 `LLMClient` facade 切 Mastra） |
| **B. MCP transport** | stdio 优先 | ✅ 保留 stdio（官方 roadmap 2026-06 仅保留 stdio + Streamable HTTP；SSE 废弃） | 11-agent-mesh 保持 stdio；未来 remote 场景用 Streamable HTTP |
| **B. Mesh 协议** | 自建 gRPC schema | ⚠️ 调整：A2A v1.0 已进 Linux Foundation，官方提供 gRPC binding + Signed Agent Cards | **ADR-003 新增**：A2A subset + Quilin extensions（Option C），Iter D 前必须定稿 |
| **C. Core loop** | 自建 <200 LOC | ✅ 保留；但**纳入 OpenHands SDK 的 event-sourced 模式作为 prior-art**（SWE-bench 72% / GAIA 67.9%） | research 笔记 + ADR-001 D-19 补充；Iter C spike |
| **D. Memory** | 4-tier 自建 KG | ⚠️ 调整：2026-04 SOTA 已迁移；Graphiti 71.2% 被 Mem0 v2 93.4% / Mastra OM 94.87% / MemPalace 96.6% 反超；Codex spike (#93) 证实 Graphiti embedded 路径不 zero-config | ~~**D-12**：默认 Graphiti~~ → **D-20 取代**：OmniMem v2 融合架构，吸收 5 家开源 SOTA 思想（Mastra OM / MemPalace / Mem0 / Graphiti / OpenViking），自写实现不做依赖；Letta 风格 `memory_replace / memory_append / archival_insert` 接口保留 |
| **E. Skills** | SKILL.md + frontmatter | ✅ 保留；Anthropic 官方 `anthropics/skills` 2025-10 已发布，设计一致 | **D-17**：13-skills frontmatter 解析器加 kebab-case 别名（`allowed-tools` ↔ `allowedTools`），支持社区 skill 零翻译落盘 |
| **F. Benchmark** | SWE-bench / GAIA / BFCL 3 pinned | ⚠️ 调整：Berkeley RDI 审计揭示前 3 榜可被 gaming | **D-16**：加 **τ2-bench** 第 4 pinned（Opus 4.6 telecom 99.3%，唯一多轮工具+用户交互榜单） |
| **G. Runtime** | Bun 1.x | ✅ 保留；但 `--inspect` debugger 阻塞 bug | Iter D Sprint 0 加 Node 22 CI job + CONTRIBUTING 记录 caveat |

---

## 三、D 编号表（D-11..D-20）

| D-# | 名称 | 落地位置 |
|----|------|---------|
| D-11 | Skill 单写方原则（Layer 4 重命名） | `03-memory/README.md`、`10-self-evolution/README.md` |
| ~~D-12~~ | ~~Graphiti 作为 KG 默认后端 + Letta self-editing 接口~~ **已被 D-20 取代** | ~~`03-memory/README.md`~~ |
| D-13 | Skill catalog KV-cache 稳定前缀约束 | `13-skills/README.md` |
| D-14 | Iter D CI 矩阵统一（cargo check 强制 / cargo test noop） | `implementation-plan.md` |
| D-15 | Iter E2 前置补 03-memory Phase 0 | `implementation-plan.md` |
| D-16 | benchmark 加 τ2-bench 第 4 pinned + Berkeley audit 警告 | `benchmark-roadmap.md` |
| D-17 | 13-skills frontmatter 官方 alias 支持 | `13-skills/README.md` |
| D-18 | `memory_tier_transition` span + 3 metrics | `08-observability/README.md` |
| D-19 | Event-sourced state 延后到 Iter C | `adr-001-core-loop-and-language.md` |
| **D-20** | **OmniMem v2 融合架构（5 流派思想吸收 + 转化升级，supersedes D-12）** | `03-memory/README.md`、`docs/research/memory-watchlist/` |
| **D-21** | **Rule-first Observer Tier-1 formal gate = NO（v2-r3 recall 21.4% / FPR 2.8% / p95 4.19 ms, 2026-04-20）**；v1 90% 为 inflated baseline，v2-r1 7.3% → v2-r2 26.1% → v2-r3 21.4%；zh recall 0%、Tier 2 escalation 仅 1.1%；M0 Sprint 1 前需扩为 bilingual + multi-pattern + escalation-aware | `03-memory/README.md` §L3a、`docs/research/rule-first-observer-spike-report.md` |

---

## 四、新增 ADR / Research note

| 路径 | 类型 | 作用 |
|-----|------|------|
| [`docs/adr/adr-003-a2a-vs-bespoke-grpc.md`](../adr/adr-003-a2a-vs-bespoke-grpc.md) | ADR Draft | Iter D Mesh 协议决策入口，倾向 Option C（A2A subset + Quilin extensions） |
| [`docs/research/openhands-sdk-event-sourced-loop.md`](../research/openhands-sdk-event-sourced-loop.md) | Research note | OpenHands SDK 的 event-sourced 模式对 Quilin agent-core 的启示；为 Iter C 重构提供 prior-art |

---

## 五、延后项（不在本轮修复）

| 项 | 延后到 | 理由 |
|----|-------|------|
| OpenHands event-sourced POC spike | Iter C Sprint 0 | 当前 <200 LOC loop 稳定，不急 |
| A2A `tonic + .proto` spike | Iter D Sprint 0 | 需在 Mesh 开工前拿到数据 |
| Node 22 CI job + Bun debugger caveat | Iter D Sprint 0 | 和 CI 矩阵对齐一起改 |
| Graphiti 代码 spike（Python 依赖验证） | Iter B 尾声 | 1-2 小时独立任务，派 Codex |

---

## 六、D-20 L3a rule-first spike 结果（Task #97 v2）

### 方法论修正（vs v1 70-sample spike）

v1 的 70-sample fixture 由实施方（Codex）自造自跑，规则设计与样本分布共变，**召回 90% / 误召 0%** 的数字存在 experimenter-author bias。

**v2 方法论（2026-04-20 用户纠正）**：
- 数据集由 **Claude** 独立造，Codex **只做规则 + 跑数**，禁止任何一方跨越职责
- 数据集规模 ≥ 1000，含 6 类 × 4 难度 × 中英双语；committed 至 `docs/research/fixtures/rule-first-observer/`
- 三次 run 渐进：r1 hand-only (288) → r2 +public data (719) → r3 +noise (1039)

### v2-r1 结果（hand-only 288 samples，Claude 独立造）

| 指标 | v1 (self-authored 70) | v2-r1 (hand 288) | Δ |
|------|----------------------|------------------|---|
| recall | 90.0% | **7.3%** | −82.7pp |
| precision | ~100% | 89.5% | −10.5pp |
| FPR | 0% | 3.6% | +3.6pp |
| F1 | ~95% | 13.5% | −81.5pp |
| Tier 2 escalation rate | — | 1.7% | — |

**按 language** — `en 12.2% / zh 0.0% / mixed 0.0%`（规则只能吃英文 explicit）
**按 difficulty** — `explicit 10.1% / implicit 3.2%`
**按 type** — `emotion 0.0% / entity 1.4% / preference 9.3% / time 13.6% / intent 16.7%`

### 架构级结论

1. **D-20 L3a Tier-1 gate（recall ≥ 40% / FPR ≤ 5% / p95 < 20ms）在 v2-r1 不满足** — recall 远低于 40%（7.3%）
2. 当前 prototype 只能识别 **English-explicit 单句 persona pattern**；对 zh 零命中，对 implicit 几乎零命中
3. 漏抽大多数是 **静默 miss**，Tier 2 escalation 仅 1.7% — 这比 low recall 更危险（系统不知道自己不知道）
4. v1 的"82%→90%" baseline 从此 **仅作对照组保留**，不再作为架构 gate evidence

### v2-r2 / v2-r3 结果（正式 gate 判定）

| 指标 | v2-r1 (hand 288) | v2-r2 (hand+public 719) | **v2-r3 (full 1039, gate)** |
|------|------------------|-------------------------|----------------------------|
| recall | 7.3% | 26.1% | **21.4%** |
| precision | 89.5% | 97.4% | **96.7%** |
| FPR | 3.6% | 2.9% | **2.8%** |
| p95 latency | 4.35 ms | 4.21 ms | **4.19 ms** |
| Tier 2 escalation | 1.7% | 1.1% | 1.1% |

**按 noise 模式（v2-r3）**: `short 0.0% / emoji 6.6% / typo 7.3% / code 8.2%` — 短截断是最致命的破坏源。
**按 language（v2-r3）**: `zh 0.0% / mixed 5.2%` — 双语支持仍是零。

**形式化 gate 判定**：recall 21.4% < 40% → **NO**。FPR 和 p95 通过。

### 下一步

- ✅ 正式报告 `docs/research/rule-first-observer-spike-report.md` 已 commit（88cbd33）
- **M0 Sprint 1 重新定义**：规则层必须扩展为 **bilingual + multi-pattern + escalation-aware**；当前 prototype 不能直接进生产
- D-20 的 L3a "rule-first 两级架构" 方向 **不推翻**，但 Tier-1 规则模板需大幅扩充；Tier-2 escalation heuristics 需重做（当前只有 1.1% escalation 意味着系统对自己不知道的东西几乎完全沉默）
- **D-21 finding** 正式开单，M0 Sprint 1 前闭合

### Methodology memory

本轮 spike 的 data/execution 职责分离已写入 Claude memory `feedback_spike_data_separation.md`，未来所有"验证技术假设"类 spike 默认按此 pattern 派工。

---

## 七、统计

- **2026-04-17 Ultra-Review**：170 findings（14 CRITICAL / 59 HIGH / 其余）
- **2026-04-20 Delta Audit**：10 NEW findings（2 CRITICAL / 8 HIGH）
- **2026-04-20 Opus 4.7 Revisit（本报告）**：6 NEW findings（1 CRITICAL / 2 HIGH / 2 MEDIUM / 1 LOW）+ 7 外部调研决策 + **D-21 spike finding**（rule-first ceiling 7.3% recall）
- **累计修复**：186 / 187（D-21 待 M0 Sprint 1 前闭合）

下次 review 建议触发条件：
- Iter B3a 收尾（Skills Core 实现完成后）
- Iter C 开工前（loop event-sourced 重构前）
- 或 3 个月一次定期巡检

---

**Last reviewed**：2026-04-20（Opus 4.7）
