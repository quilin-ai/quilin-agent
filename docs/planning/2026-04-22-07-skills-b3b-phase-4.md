---
title: Skills B3b Phase 4 — Post-compact 恢复 + file watcher (tracking)
status: completed
owner: Codex (impl) + Claude (review / §8.1 commit)
created: 2026-04-22
last_updated: 2026-04-22
completed_at: 2026-04-22
closure_commits: [1f74adb, 93141c5]
predecessors:
  - docs/planning/2026-04-21-01-skills-b3b-activation.md  # Phase 4 总 spec (§Phases L179-199)
  - docs/planning/2026-04-22-04-skills-b3b-phase-1.md     # hot_skills / stable prefix / P1 closure
  - docs/planning/2026-04-22-05-skills-b3b-phase-2.md     # skill_manage / discover rebuild / P2 closure
  - docs/planning/2026-04-22-06-skills-b3b-phase-3.md     # skills_guard / trust policy / P3 closure
  - docs/engineering/13-skills/README.md                  # 领域 spec §1.1 维度 6 / §2.6
  - docs/engineering/02-context/README.md                 # system prompt assembly / compact 边界
threat_surface_delta:
  new_ingress:
    - source: compact 后恢复候选(skill body + last-viewed recency)
      trust: mixed (descriptor 来源可信度沿用 builtin / trusted / community / agent-created)
      mitigations:
        - independent-dynamic-block-after-hot-skills
        - per-skill-max-5k-token-cap
        - total-restore-budget-25k-cap
        - reuse-skills-guard-result-from-load-boundary
        - token-budget-check-before-append
    - source: file system events on ~/.quilin/skills/ + .quilin/skills/
      trust: untrusted
      mitigations:
        - debounce-200ms
        - root-containment-via-existing-realpath-guard
        - discover-rebuild-single-path
        - ignore-bundled-roots
        - no-event-triggered-auto-load
  new_egress:
    - channel: REPL inline event hints
      trust: user-visible informational only
      mitigations:
        - catalog-change-only
        - no-skill-body-render-in-event
  new_defensive_surface:
    - surface: post-compact restore dynamic block
      coverage:
        - compact 后 skill 上下文丢失时,按 recency 恢复最近查看过的 skill 正文
        - restore block 与 stable prefix 解耦,避免 cache 污染
      mitigations:
        - single-source-recentSkillNames
        - independent-dynamic-block-after-hot-skills
        - per-skill-max-5k-token-cap
        - total-restore-budget-25k-cap
        - mock-triggered-until-02-context-compact-exists
  new_persistence:
    - target: sessionState.skills.recentSkillNames (Phase 4 baseline)
      durability: session-only unless caller snapshots externally
      mitigations:
        - bounded-list-max-5
        - dedupe-by-skill-name
        - newest-first-order
---

# Skills B3b Phase 4 — Post-compact 恢复 + file watcher

> **用途**:把 `2026-04-21-01-skills-b3b-activation.md §Phases L179-199` 落成可执行的 Phase 4 tracking。Phase 4 分为两条线：`P4-a` 先做 **post-compact 恢复** 的纯逻辑与 02-context 接线，`P4-b` 再做 **file watcher** 的热发现与 REPL 提示，不把 watcher 依赖和恢复逻辑捆绑到同一个 commit。

## 目标

把 Phase 4 的两项能力落成可验证代码:

1. `SkillsManager.postCompactRestore(ctx)` 返回**最近 5 个被 `skill_view` 加载过的 skill**，单 skill ≤5K token，总预算 ≤25K token
2. 恢复结果作为**独立可变块**放在 `<hot_skills>` 之后，不污染稳定前缀 / `staticPrefix`
3. 监听 `~/.quilin/skills/` + `.quilin/skills/` 的文件变更，经过 debounce 后触发 `discover()`，让 catalog 热更新
4. REPL 在 watcher 触发 catalog 变化时输出最小提示，如 `📥 New skill discovered: ...` / `🗑 Skill removed: ...`

## 现状实证(2026-04-22 HEAD=`8270997`)

| 文件 / 事实 | 实证 | 状态 |
|---|---:|---|
| `packages/agent-core/src/skills/manager.ts` | 253 LOC | 只有 `discover()` / `load()` / `findByName()` / `onCatalogChange()`，**无** recent-view ledger / postCompactRestore / watcher |
| `packages/agent-core/src/context/prompt-session-assembler.ts` | 132 LOC | 已支持 `getSessionState()` 注入，但**无** compact 后 skills restore 块 |
| `packages/agent-core/src/context/skills-catalog-section.ts` | 64 LOC | 已有 `recentSkillNames` → `<hot_skills>` 排序线，但**无** post-compact restore section |
| `packages/agent-core/src/repl.ts` | 480 LOC | 已消费 `skillsManager.onCatalogChange()` 并 `invalidateSessionPrefix("skills-catalog-changed")`，可复用为 watcher 接线 |
| `packages/agent-core/package.json` | runtime deps | **无 `chokidar`**，当前 watcher 不能假设外部依赖已存在 |
| `rg "postCompactRestore|fs.watch|chokidar"` | 0 命中 | Phase 4 功能尚未开工 |
| `packages/agent-core/src/context/prompt-types.ts` | `BuildContext.sessionState: Record<string, unknown>` | `sessionState` 是开放式 bag，`sessionState.compaction` 可按 namespace 模式新增 |
| `rg "compact|Compact" packages/agent-core/src` | 0 命中 | **整个 agent-core/src 无 compact 实现**，Phase 4 不能假设已有 compact 触发器 |
| `rg "\\.recentSkillNames\\s*=|recentSkillNames:\\s*\\[" packages/agent-core/src` | 仅 test fixtures 命中 | 生产代码里 `recentSkillNames` **当前无生产者** |
| `bunx vitest run` | 345/345 | Phase 3 closure baseline |
| `bunx tsc --noEmit --pretty false` | exit 0 | Phase 3 closure baseline |

## 关键合同

```typescript
interface PostCompactRestoreEntry {
  readonly name: string
  readonly source: SkillSource
  readonly body: string
  readonly tokenEstimate: number
}

interface PostCompactRestoreResult {
  readonly entries: readonly PostCompactRestoreEntry[]
  readonly totalTokens: number
}

interface PostCompactRestoreOptions {
  readonly maxSkills?: number        // default 5
  readonly maxSkillTokens?: number   // default 5_000
  readonly maxTotalTokens?: number   // default 25_000
  readonly estimateTokens?: (text: string) => number
}
```

**Phase 4 合同:**

- `entries.length <= 5`
- 任一 `entry.tokenEstimate <= 5_000`
- `totalTokens <= 25_000`
- 恢复块进入 **dynamic suffix**，不得改变 `staticPrefix` hash
- watcher 只作用于 `userRoots` / `projectRoots`，不监听 `bundledRoots`

## 拆分(2 个 sub-deliverable)

### P4-a:postCompactRestore + dynamic restore section

**做什么:**

1. 在 Phase 4 明确把 `sessionState.skills.recentSkillNames` 升格为**唯一真相源**:
   - `skill_view` 成功读取后更新 `recentSkillNames`
   - newest-first、按 skill name 去重
   - 上限受控(建议保留 >5 的小窗口，但 restore 最终最多取 5)
2. 在 `SkillsManager` 增加 `postCompactRestore(options)`:
   - 输入直接消费 `recentSkillNames`
   - 遍历最近查看列表，按 newest-first 尝试 `load()`
   - 跳过单 skill tokenEstimate > 5_000 的项
   - 累加预算，超 25_000 即停止
   - 返回 `entries + totalTokens`
3. 在 `skill_view` 成功路径上接 `recentSkillNames` 更新，让 `<hot_skills>` 与 restore 共享数据来源
4. 在 02-context 新增独立 section，例如 `post-compact-skills`:
   - `order` 在 `hot-skills` 之后
   - `updateFrequency: "per_turn"` 或明确的动态频率
   - **Phase 4 选项 A**: 仅在 mock/外部注入的 `sessionState.compaction?.justCompacted === true` 或等价信号下输出
   - Phase 4 **不实现 compact 机制本身**；当前 `agent-core/src` 无 compact 生产者,此信号由 02-context 后续补齐
   - 输出独立 XML 块，如 `<post_compact_skills>`，不混进稳定前缀

**不做:**

- ❌ 跨 session durable LRU（Phase 4 baseline 先做 session 内存态，checkpoint 持久化另开）
- ❌ 内容截断到 5K token（超限直接 skip，不做有损裁切）
- ❌ 新的 compact 算法 / compact 触发器本身（只消费 02-context 后续提供的 compact 信号）
- ❌ watcher / REPL 提示（P4-b）

**验证(`manager.test.ts` / `skill-view.test.ts` / `context` 集成测试新增):**

- [ ] `recordViewedSkill()` newest-first 去重，重复查看 skill 会提升到队首
- [ ] `postCompactRestore()` 最多返回 5 条
- [ ] 单 skill >5K token → 跳过而非截断
- [ ] 总预算 >25K 时在边界前停止
- [ ] 不存在 / 已删除 skill 会在 restore 时静默跳过
- [ ] `skill_view` 成功读取后会更新 `recentSkillNames`
- [ ] prompt 组装时 restore 块只出现在 `dynamicSuffix`，`staticPrefix` hash 不变
- [ ] restore 块排序 = `recentSkillNames` newest-first，与 `<hot_skills>` 共享同一份 recency 数据
- [ ] 在当前无 compact 实现前，mock `sessionState.compaction` 也能单测 restore section 的触发与空输出行为

**R-03 契约测试(Phase 4 新增,high):**

- spy 包住 `estimateTokens()`，验证:
  - `postCompactRestore()` 对每个纳入候选的 skill 都经过 token 估算
  - `totalTokens` 预算判断由同一估算结果驱动
  - 超预算后不继续把更多 skill 拼进 restore 结果

> **My independent view is:** R-03 不该验证“调用次数恰好等于某个常量”，而应验证“每个被评估 / 纳入的候选都走统一 estimator，且预算截止后不继续接受更多 entry”。否则实现若加入缓存，测试会被无谓打碎。

### P4-b:file watcher + catalog 热发现

**做什么:**

1. 在 `SkillsManager` 内部增加 watcher 生命周期 API:
   - `startWatching()` / `stopWatching()` 或构造选项启用
   - 只监听 `userRoots` + `projectRoots`
   - 事件经 200ms debounce 后统一触发一次 `discover()`
2. watcher 基线优先用 `node:fs.watch`
   - 只有在实证确认跨平台或递归语义不够时，才引入 `chokidar`
   - 若引依赖，必须单独留痕到 tracking doc `Decisions`
3. `discover()` 完成后继续复用现有 `onCatalogChange()` 通道
4. REPL 基于 catalog diff 输出最小提示:
   - 新增: `📥 New skill discovered: <name>`
   - 删除: `🗑 Skill removed: <name>`
   - 若无法精确区分，仅退化为 `🎯 Skills catalog updated`

**不做:**

- ❌ 监听 bundled roots
- ❌ 直接在 watcher 回调里加载 skill body
- ❌ watcher 驱动 auto-activate / auto-scan 输出正文
- ❌ 递归超过当前 `SkillsManager.discover()` 支持的目录模型

**验证(`manager.test.ts` / `repl.test.ts` 新增):**

- [ ] user root 新增 skill 文件 → debounce 后 catalog 可见
- [ ] 删除 skill 文件 → debounce 后 catalog 消失
- [ ] 连续多次 fs event 抖动 → 200ms 内只触发一次 `discover()`
- [ ] watcher 只监听 configured user/project roots，不触碰 bundled roots
- [ ] REPL 在 catalog 变化时输出最小提示，不输出 skill body
- [ ] `stopWatching()` 后后续事件不再触发 `discover()`

## 依赖 / 决策边界

- **P4-a 优先**：纯逻辑 + 02-context 接线，无新 runtime 依赖
- **P4-b 次之**：文件系统事件 + REPL 提示，优先复用 `onCatalogChange()`
- **watcher 依赖策略**：
  - 默认: `node:fs.watch`
  - 只有出现明确 blocker，再讨论 `chokidar`
- **restore 数据来源**：
  - Phase 4 baseline 直接把 `recentSkillNames` 扶正为单一真相源
  - `<hot_skills>` 排序和 `postCompactRestore` 候选共享同一份 newest-first 名单
  - 不再额外造第二套 recent-view ledger，防止两条状态线漂移
- **compact 触发策略**：
  - Phase 4 采用 **选项 A**：先实现 restore contract + mock-triggered section
  - 不在本 phase 发明 compact 机制；待 02-context 后续补 compact 生产者后自然接通

## 不做(scope 外,明令)

- ❌ 把 restore 块混入稳定前缀
- ❌ durable cross-session skill usage telemetry / `last_used_at` 存储
- ❌ 多机 / agent-mesh 同步 skills
- ❌ chokidar 先行引入而不做 `fs.watch` 可行性实证
- ❌ compact 策略本身改造

## 完成定义(Phase 4 done)

- [x] P4-a / P4-b 代码合入 master,无 tsc error（`1f74adb` + `93141c5`,tsc exit 0）
- [x] `postCompactRestore()` 契约成立: ≤5 skills / ≤5K each / ≤25K total（`manager.ts` L234+,`manager.test.ts` 覆盖）
- [x] restore 块位于 `<hot_skills>` 之后,且 `staticPrefix` hash 不变（`skills-catalog-section.ts` `POST_COMPACT_SKILLS_ORDER=60`）
- [x] `skill_view` 成功调用会更新 `sessionState.skills.recentSkillNames`（newest-first、去重、bounded）（`skill-view.ts` → `recordViewedSkill` → `repl.ts getSessionState`）
- [x] watcher 经过 200ms debounce 后可触发 catalog 热更新（`manager.ts scheduleRescan` + `manager.test.ts` fake-timer 用例）
- [x] `manager.test.ts` / `repl.test.ts` / `context` 集成测试补齐（P4-a +7 / P4-b +6 用例）
- [x] **R-03 token budget contract** 通过（`estimateTokens` per-candidate + 总预算 short-circuit）
- [x] `vitest run --configLoader runner` 全绿（41 files / 358 tests）
- [x] CI tsc hard gate 通过（本地 `bunx tsc --noEmit -p packages/agent-core/tsconfig.json` exit 0,CI 同配置）
- [x] `2026-04-21-01-skills-b3b-activation.md §Phases L181 Phase 4` ⏳ → ✅（本 closure 同步翻转）
- [x] 本文件 status:`in-progress` → `completed`
- [x] closure_commits 回填 `1f74adb`(P4-a) / `93141c5`(P4-b)

## 风险

- **R-03(high):** post-compact 恢复超预算，把动态尾部膨胀成第二个“伪稳定前缀”。**守护:** 单 skill 5K / 总量 25K 双上限 + estimator 契约测试 + `dynamicSuffix` hash-only 验证。
- **R-03b(high):** Phase 4 假设已有 compact 信号,结果 restore section 永远不触发或被各处私自发明。**守护:** 文档显式承认 `compact` 当前不存在,先以 mock-triggered contract 落地,由 02-context 后续统一生产信号。 
- **R-04(high):** watcher 抖动导致 `discover()` 高频触发、REPL 噪音过大。**守护:** 200ms debounce + 变化摘要最小化 + `stopWatching()` 生命周期测试。
- **R-05(medium):** file watcher 与已有同步 `discover()` 路径竞争，导致 catalog 短暂旧值。**守护:** watcher 只触发单一路径 `discover()`，不引第二套缓存。
- **R-06(medium):** restore 候选在 compact 与恢复之间被删除。**守护:** `postCompactRestore()` load 失败时跳过，不抛异常。
- **R-07(low):** 为了 watcher 引入新依赖，扩大运行面和 CI 体积。**守护:** 默认 `fs.watch`，引依赖必须单独 decision 留痕。

## Open Questions

- [x] **restore 候选是否需要单独 ledger?**:NO。Phase 4 直接把 `sessionState.skills.recentSkillNames` 作为单一真相源，由 `skill_view` 成功路径生产；`<hot_skills>` 与 `postCompactRestore` 共享同一份 newest-first 名单。
- [x] **compact 信号是否可直接假设为 `sessionState.compaction?.justCompacted`?**:NO,不能假设它已存在。当前 `BuildContext.sessionState` 虽是开放式 bag，但 `agent-core/src` 里 `compact` 命中为 0；Phase 4 仅定义建议形状 `sessionState.compaction = { justCompacted: boolean; at: number }`，由 02-context 后续补生产者。
- [ ] **watcher 是否需要区分 body-only 变更 vs frontmatter 变更?** 暂定 NO。Phase 4 基线统一走 `discover()`；细分 invalidation 留到后续优化。
- [x] **REPL 提示是否必须带 emoji?**:YES。Phase 4 文案直接对齐 spec，用最小提示；若后续测试环境噪音大，再单独调 verbose 策略，不在本 tracking doc 悬而未决。
- [ ] **是否直接引 `chokidar`?** 暂定 NO。先以 `fs.watch` 为基线，除非出现明确跨平台 blocker。

## Decisions

### 2026-04-22 — Phase 4 拆成 P4-a / P4-b 两段

- **Before:** Phase 4 spec 把 post-compact 恢复和 file watcher 写在同一阶段描述里
- **After:** tracking doc 明确拆成 `P4-a = postCompactRestore + context dynamic block`、`P4-b = watcher + REPL hint`
- **理由:** P4-a 是纯逻辑 + 现有边界接线，无需新依赖；P4-b 涉及 fs 事件模型和潜在 runtime 依赖，风险面明显更高
- **Source:** Claude proposal + Codex independent convergence, 2026-04-22

### 2026-04-22 — watcher 基线优先 `node:fs.watch`

- **Before:** 可选方案是直接引入 `chokidar`
- **After:** Phase 4 tracking 以 `fs.watch + debounce 200ms` 为默认实现路径；仅在实证确认 blocker 后再考虑新依赖
- **理由:** `packages/agent-core/package.json` 当前无 watcher runtime 依赖；先用平台原语更符合现有简洁度和 blast radius 控制
- **Source:** Codex package/dependency audit, 2026-04-22

### 2026-04-22 — P4-a 采用“restore contract + mock-triggered section”而不发明 compact 机制

- **Before:** 可选方案包括 Phase 4 内顺手补一个最小 compact 触发器,或者把 feature 改写成每轮都显示的 recent skills block
- **After:** P4-a 采用选项 A。Phase 4 只实现 `postCompactRestore()` 与 `post-compact-skills` section 的契约、预算和测试,触发信号由 mock / 外部注入提供；不在本 phase 发明 compact 生产者,也不把 feature 改写成常驻 recent block
- **理由:** `rg "compact|Compact" packages/agent-core/src` 实证为 0 命中。强行在 Phase 4 内补 compact 会越过 02-context 设计边界；改成常驻 recent block 则会稀释“post-compact restore”语义
- **Source:** Claude cross-review finding + Codex convergence, 2026-04-22

### 2026-04-22 — `recentSkillNames` 升格为 P4-a 的单一真相源

- **Before:** 草稿曾假设单独 recent-view ledger,并将 `recentSkillNames` 视为仅服务 `<hot_skills>` 的排序态
- **After:** P4-a 明确由 `skill_view` 成功路径写入 `sessionState.skills.recentSkillNames`; `<hot_skills>` 与 `postCompactRestore` 共享这份 newest-first、bounded list
- **理由:** 生产代码当前没有任何 `recentSkillNames` 写入者,正好应在 Phase 4 把它扶正,避免额外造第二套 recent-view 状态导致漂移
- **Source:** Claude cross-review finding + repo grep audit, 2026-04-22
