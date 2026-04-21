---
title: Skills B3b Phase 1 — 条件激活 + KV-cache friendly catalog (tracking)
status: completed
owner: Codex (impl) + Claude (plan + review)
created: 2026-04-22
last_updated: 2026-04-22
completed_at: 2026-04-22
closure_commits:
  - a9ef022  # P1-a 条件激活过滤管道
  - 86f4512  # P1-b stable prefix + hot_skills 双 section
  - 338c607  # P1-c assembler session-state 注入 + stable 收窄
predecessors:
  - docs/planning/2026-04-21-01-skills-b3b-activation.md  # Phase 1 总 spec(L110-129)
  - docs/planning/2026-04-22-03-handoff.md                # 本轮 handoff 提到的 P1
  - docs/engineering/13-skills/README.md                  # 领域 spec
threat_surface_delta:
  new_ingress:
    - source: turnContext.availableToolNames (ToolRouter 产出,trust=trusted)
      trust: trusted
      mitigations: [filter-pure-function, no-escape-lexsort, readonly-input]
    - source: skill metadata fields (requiresTools / requiresToolsets / platforms / trust)
      trust: untrusted (来自 skill frontmatter;Phase 0 已有 size-cap / depth-limit / unknown-field-ignore)
      mitigations: [inherit-phase-0-parser-guards, no-new-write-path, filter-read-only]
  new_egress: []
  new_persistence: []
---

# Skills B3b Phase 1 — 条件激活 + KV-cache friendly catalog

> **用途**:Phase 1 的可执行拆解 + 验证合同。Phase 1 spec 本身在 `2026-04-21-01-skills-b3b-activation.md §Phases L110-129`,本文件只把它落到**具体文件改动 + 测试矩阵 + D-13 约束守护**。

## 目标

把 `2026-04-21-01 §Phase 1` 的 3 条做什么落成可验证代码:

1. `CatalogRenderer.render()` 增 4 条过滤(requiresTools / requiresToolsets / platforms / trust)
2. **D-13 KV-cache 稳定性改造**:稳定前缀段 lex-sort + 可变段 `<hot_skills>` ≤10 条
3. Prompt session assembler 插入点对齐 02-context(稳定前缀 → `<hot_skills>` → per-turn decoration)

## 现状实证(2026-04-22 HEAD=`0ecfa16`)

| 文件 | LOC | 职责 |
|---|---:|---|
| `packages/agent-core/src/skills/catalog-renderer.ts` | TBD(Codex 接手后回填) | Phase 0 已就位,Phase 1 将改造 |
| `packages/agent-core/src/skills/catalog-renderer.test.ts` | TBD | Phase 1 新加过滤 + 稳定前缀 + hot_skills 断言 |
| `packages/agent-core/src/skills/frontmatter.ts` | 279 | Phase 0 ✅(`bc93f42`) |
| `packages/agent-core/src/skills/manager.ts` | 253 | Phase 0 ✅ |
| `packages/agent-core/src/skills/types.ts` | 35 | Phase 0 已定义 M1 字段 |

Phase 0 契约验证状态:
- `bunx tsc --noEmit` → exit 0(本轮 `0ecfa16` CI 启闸)
- `bunx vitest run` → 273/273(本轮 `e7374b7` 清掉最后 1 预存在失败)

## 拆分(3 个 sub-deliverable)

### P1-a:条件激活过滤管道

**现状实证(2026-04-22 HEAD=`7f8a797`):**
- `catalog-renderer.ts:21-23` `renderSkillsCatalog(descriptors)` **单参数**(我早前写"Phase 0 已有 turnContext"是错的,Codex cross-read 纠正)
- `context/skills-catalog-section.ts:23` 调用点也只传 `descriptors`,`updateFrequency: "per_session"`(L17)
- P1-a 必须同时:(a) 给 `renderSkillsCatalog` 加 `turnContext` 参数;(b) 在 `createSkillsCatalogSection` source 或 compute 闭包里把 turnContext 拿到并透传

**改 `catalog-renderer.ts` 拟签名:** `renderSkillsCatalog(descriptors, turnContext)`,内部加 4 条 pre-filter + 1 条 mandatory source 限制:

```
filtered = descriptors
  .filter(d => covers(turnContext.availableToolNames, d.requiresTools))
  .filter(d => covers(turnContext.availableToolsets, d.requiresToolsets))
  .filter(d => matchesPlatform(d.platforms, process.platform))
  .filter(d => meetsTrust(d.trust, turnContext.minTrustLevel))
  // mandatory 源限制:只有 bundled/user 声明的 mandatory 保留;community skill 自声明被降级
  .map(d => d.frontmatter.mandatory && !["bundled", "user"].includes(d.source)
    ? { ...d, frontmatter: { ...d.frontmatter, mandatory: false } }
    : d)
```

**source 透传机制:** `SkillsCatalogSectionSource` 要么把 `list()` 扩成 `list(turnContext)`,要么在 `createSkillsCatalogSection(source, turnContextProvider)` 处注入。Codex 实现时选最小改动面,回填到本文件 Decisions 里。

**不做:**
- 任何 I/O(pure function)
- 任何 persistence
- 任何 CRUD

**验证(`catalog-renderer.test.ts` 新增):**
- [ ] requiresTools 缺一个 → 被过滤
- [ ] requiresToolsets 缺一个 → 被过滤
- [ ] platforms 不含当前 → 被过滤
- [ ] trust 低于 `minTrustLevel` → 被过滤
- [ ] 4 条全满足 → 保留

### P1-b:D-13 KV-cache 稳定前缀 + hot_skills

**稳定前缀段:**
- 条件:`d.mandatory === true` **或** 来自 `bundled` / `user` source
- 排序:`skill_id` lexicographic(**字节级稳定**)
- 位置:system prompt 最前的固定区域

**可变段 `<hot_skills>`:**
- 条件:稳定前缀段以外的 descriptors
- 排序:`recency (last_used_at) × 0.6 + relevance (keyword match) × 0.4`
- 上限:**≤10 条**(硬上限,超过截断)
- 位置:稳定前缀之后,独立 XML 块

**验证(`catalog-renderer.test.ts` 新增):**
- [ ] 稳定前缀 lex-sort 正确性(两轮不同 recency 下稳定前缀字节级一致)
- [ ] hot_skills 限 10 条:输入 15 个 non-stable → 输出 ≤10
- [ ] hot_skills 排序正确性:recency 高 × relevance 高 排第一
- [ ] 稳定前缀 hash(SHA256 前 8 字节)两轮一致(KV-cache 命中率佐证)

### P1-c:Prompt session assembler 对齐

**改 `02-context` 相关 PromptSessionAssembler(如 Phase 0 已对接则只核对):**
- 稳定前缀占位顺序:`<system_prompt>` → stable skill prefix → `<hot_skills>` → `<memory>` → per-turn decoration

**验证:**
- [ ] 02-context 集成测试:3 轮对话里稳定前缀 hash 保持 100% 一致

## D-13 约束守护(Phase 0 已 approve,Phase 1 不漂移)

| 约束 | 守护机制 | 违反后果 |
|---|---|---|
| 稳定前缀字节级一致 | 单元测试对比 SHA256 | KV-cache 命中率掉;LLM 每轮重读 system prompt |
| hot_skills ≤10 | 硬截断 + 单元断言 `.length <= 10` | catalog 无限增长,system prompt 预算爆 |
| lex-sort 唯一 | 显式 `.sort()` + 测试对比 | 不同机器 / 不同 Node 版本顺序漂移 |

## 不做(scope 外,明令)

- ❌ hot_skills 的机器学习 relevance(embedding / cross-encoder 留给 M2+)
- ❌ CRUD / skill_manage(Phase 2 才做)
- ❌ 内容扫描 / skills_guard(Phase 3 才做)
- ❌ Post-compact 恢复(Phase 4 才做)

## 完成定义(Phase 1 done)

- [ ] P1-a / P1-b / P1-c 代码合入 master,无 tsc error
- [ ] `catalog-renderer.test.ts` 新增至少 7 条测试断言(4 过滤 + 3 稳定性/排序/上限)
- [ ] `bunx vitest run` 全绿(≥273 + 新加)
- [ ] CI tsc hard gate(`0ecfa16`)通过
- [ ] 本文件 status:`planning` → `in-progress`(Codex 接手时) → `completed`(合入时)

## 风险

- **R-01:** hot_skills 排序算法过于简单,误把相关但 last_used_at 老的 skill 沉底 —— Phase 1 接受这个风险,M2+ 再 upgrade
- **R-02:** 稳定前缀 hash 计算选型错(string concat vs canonical JSON)影响 KV-cache 命中率 —— 验证里强制两轮一致性对比,暴露后再调
- **R-03:** turnContext.availableToolNames 动态变化导致同一 skill 时有时无出现在 hot_skills —— 这是预期行为(条件激活语义),但要在 spec 里注明给用户感知

## Next Action

- **Codex:** 接手时把本文件 status 切 `in-progress`,按 P1-a → P1-b → P1-c 顺序开工(a 最小 scope,先 land 建立节奏)
- **Claude:** P1 过程中做 cross-review;监督 D-13 约束不漂移;P1 完成时把 `2026-04-21-01-skills-b3b-activation.md §Phases L82` 的 ⏳ pending → ✅ completed

## Open Questions

- [x] hot_skills 的 `relevance` 计算:keyword match 对 skill name + description **都跑**,且 **name 权重 > description**(Codex 2026-04-22 定:短名精确命中信号最强)
- [x] `mandatory: true` **只允许 bundled / user 声明**,community skill 自声明 mandatory 被忽略(Codex 2026-04-22 定:防第三方 skill 反向劫持 catalog 注入权,与 D-13 宿主控制原则一致)

## Blockers

- 无

## Decisions(随 Phase 推进补充)

### 2026-04-22 — hot_skills relevance 算双字段 + name 高权重

- **Before:** Phase 1 spec 里 `relevance = keyword match × 0.4` 没说对哪个字段
- **After:** 对 `skill.name` + `skill.description` 都跑 keyword match,权重固定为 `name=0.7` / `description=0.3`
- **理由:** 短名精确命中是最强信号;只看 description 会漏掉用户用 skill 名直呼的命中
- **Source:** Codex cross-review on `a66dc02` tracking doc

### 2026-04-22 — P1-b 的 recency 先读 sessionState.skills.recentSkillNames

- **Before:** spec 写 `recency (last_used_at) × 0.6`,但当前代码面尚无持久化 `last_used_at`
- **After:** P1-b 先用 `BuildContext.sessionState.skills.recentSkillNames` 作为 recency 信号,约定为 newest-first 名称列表;命中越靠前得分越高。排序总分仍为 `recency×0.6 + relevance×0.4`
- **理由:** 不阻塞 D-13 稳定前缀 / hot_skills 分流先落地;P1-c 再决定是否把该信号上提成显式 BuildContext 字段或接真实 usage telemetry
- **Source:** Codex P1-b implementation checkpoint 2026-04-22

### 2026-04-22 — mandatory: true 只允许 bundled / user

- **Before:** Phase 1 spec 没明令 mandatory 的 source 约束
- **After:** `frontmatter.mandatory === true` 只在 `source ∈ {bundled, user}` 时生效;community skill 自声明 mandatory 被过滤器忽略
- **理由:** 防第三方 skill 反向劫持 catalog 注入权;与 D-13 "宿主控制稳定前缀"原则一致
- **Source:** Codex cross-review on `a66dc02` tracking doc
- **守护位置:** P1-a 过滤管道里就应加这条(和 trust 过滤并列),测试需覆盖 "community skill claim mandatory → 仍进 hot_skills 而非 stable prefix"
