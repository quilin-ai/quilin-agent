---
title: Iter B3b — Skills Activation (M1)
status: in-progress
owner: Claude (plan) + Codex (impl)
created: 2026-04-21
last_updated: 2026-04-22

threat_surface_delta:
  phase_0:
    new_ingress:
      - source: skill frontmatter (M1 fields — requiresTools / requiresToolsets / platforms / trust / metadata.quilin.*)
        trust: untrusted (community / user sources)
        mitigations: [frontmatter-parser-size-cap, unknown-field-ignore, yaml-depth-limit-2, path-realpath-guard-inherited-from-M0]
    new_egress: []
    new_persistence: []
  phase_1:
    new_ingress:
      - source: turnContext.availableToolNames (for requiresTools filter)
        trust: trusted (produced by ToolRouter)
        mitigations: [filter-logic-pure-function, no-escape-from-lexicographic-sort]
    new_egress: []
    new_persistence: []
  phase_2:
    new_ingress:
      - source: skill_manage(create|update|delete) args (agent / user can invoke)
        trust: untrusted (may include path-traversal attempts in skill_id)
        mitigations: [WriteAuthority-single-gate, path-workspace-containment, skill_id-charset-whitelist, size-cap, content-scan-stub-until-phase-3]
    new_egress: []
    new_persistence:
      - location: .quilin/skills/**/SKILL.md and adjacencies
        sensitive: [user-authored-instructions, agent-authored-instructions]
        migration: schemaVersion in SKILL.md frontmatter (M1 adds trust default by source, no schema bump)
  phase_3:
    new_ingress:
      - source: skill body content (community / agent-created skills)
        trust: untrusted
        mitigations: [skills_guard-30+-threat-patterns, 4-level-trust-strategy, trust=agent-created-forces-ask]
    new_egress: []
    new_persistence: []
  phase_4:
    new_ingress:
      - source: fs.watch events on .quilin/skills/ (file watcher)
        trust: untrusted (attacker could drop skill file while session live)
        mitigations: [debounce, realpath-guard, re-run-skills_guard-on-new-file, rate-limit-add-events]
    new_egress: []
    new_persistence: []
---

> **规划状态（2026-04-22 更新）**：用户已 approve 4-phase 拆法 + R-01 critical 约束（2026-04-21）+ Phase 0 最终边界（2026-04-21 19:xx，Codex 提议 / Claude 转达 / 用户 approved）。**Phase 0 已完成并提交 `bc93f42`**。实证：`vitest src/skills/frontmatter.test.ts src/skills/manager.test.ts` → 14 passed（2 files）；改动仅限 `skills/*` 五个文件；`biome check` on changed files passed。进度以 commit 实证为准，不接受"凭记忆"状态转述。

### Phase 0 最终边界（2026-04-22 用户 approved）

- **单一 Phase 0** = `frontmatter schema v2 reader`。不拆 Phase 0a/0b，回归 tracking doc 原定边界。
- **trust 责任分层**（Codex 独立判断，Claude 转达 / 用户 approved）：
  - parser：**只**校验并返回文本里明写的 trust，不硬编码默认值
  - `SkillsManager.discover()`：按 source 注入默认（`bundled/` → `builtin` / `~/.quilin/skills/` → `community`）
  - `skill_manage(create)`（Phase 2）：写入时显式 `agent-created`，不靠 parser 默认值
- **writer 延到 Phase 2**：`skill_manage(update)` 实现时一起做完整 writer + 保真写回。Phase 0 **只 ship reader**，不做半成品 writer 结构。
- **CC-03 已剥离独立 cluster**：剩余 `tsc --noEmit` residual 见 `docs/planning/2026-04-22-01-tsc-hard-gate.md`，不再算入 B3b Phase 0 范围。
- **YAML parser 最小改法**：升级现有逐行 parser 支持 2 层缩进，**不引入** YAML 库依赖。
- **fixture 选择**：复用 `upstreams/llm-vercel-ai/skills/*/SKILL.md` 真实上游样式 + 本地扩展 fixture 覆盖 `metadata.quilin.*`。

# Iter B3b — Skills Activation (M1)

## 目标

B3a M0 已经让 SkillsManager + CatalogRenderer + `skill_view` 上线，并把 catalog 注入 system prompt 稳定前缀（commits `16f3868` / `d617e32`）。B3b 要把 13-skills 的 **M1 激活层**补齐，让 Quilin 具备"条件激活、动态 catalog、agent 自创、内容安全"四项生产必需能力：

1. **条件激活**：按 `requires_tools` / `requires_toolsets` / `platforms` / `trust` 过滤 catalog，对应 13 §维度 3 的 "filter by requires"
2. **KV-cache 友好的动态段**：把 recency × relevance 的热门段拆成独立 `<hot_skills>` 块（≤10），稳定前缀段按 `skill_id` 排序（D-13 NEW-15）
3. **Skill CRUD**：`skill_manage(create|update|delete)` 工具，唯一写入入口，**全部过 07 §2.6.4 WriteAuthority gate**（这是 10-self-evolution Background nudge 的前置）
4. **内容安全**：skills_guard 威胁模式扫描 + 4 级信任策略（builtin / trusted / community / agent-created）
5. **长对话恢复 + 热发现**：post-compact 恢复最近 5 个、≤25K 总预算；文件 watcher 让新增 skill 立即可见

B3b 不做：M2+ 的 Plugin 平台、Background nudge 自进化、ToolSearch 延迟加载——这些等 10-self-evolution / 11-agent-mesh 到位再开。

## Phases

| # | 名称 | 状态 | Owner | Commit | 备注 |
|---|---|---|---|---|---|
| 0 | Frontmatter schema v2 + D-17 kebab-case alias | ✅ completed | Codex | `bc93f42` | parser 解锁 M1 字段 + `metadata.quilin.*` + source-based trust defaults；CC-03 从本 phase 剥离为独立 cluster |
| 1 | 条件激活 + KV-cache friendly catalog (D-13) | ✅ completed | Codex | `338c607` | 稳定前缀 lex-sort + `<hot_skills>` ≤10;tracking:`2026-04-22-04-skills-b3b-phase-1.md`(P1-a `a9ef022` / P1-b `86f4512` / P1-c `338c607`) |
| 2 | skill_manage CRUD + WriteAuthority 集成 | ⏳ pending | Codex | — | **R-01 critical**：落盘必须过单一 WriteAuthority gate |
| 3 | skills_guard 内容扫描 + 4 级信任策略 | ⏳ pending | Codex | — | 借用 07 分类器基础设施；trust=agent-created 自动 ask |
| 4 | Post-compact 恢复 + file watcher | ⏳ pending | Codex | — | 02-context 协作：compact 后保留最近 5 个 skill、≤25K token |

### Phase 0 — Frontmatter schema v2 + kebab-case alias ✅

- **做什么**：
  1. `packages/agent-core/src/skills/frontmatter.ts` parser 解锁 M1 字段：`requiresTools` / `requiresToolsets` / `platforms` / `trust` / `metadata.quilin.*`
  2. 实现 D-17 双向 alias：Anthropic 官方 kebab-case (`allowed-tools`, `when-to-use`) ↔ Quilin 内部 camelCase
     - 读入时规范化到 camelCase
     - 写回时保留**原始键名**，不规范化（避免社区 skill diff 漂移）
  3. `SkillFrontmatter` TS 接口扩容并保持 `readonly`
  4. `trust` 默认值规则：bundled → `builtin`，`~/.quilin/skills` → `community`，`skill_manage(create)` → `agent-created`
- **不做什么**：
  - ❌ 任何 catalog 过滤逻辑（Phase 1）
  - ❌ skill_manage 写入路径（Phase 2）
- **依赖**：B3a M0 完成（已 ✅）
- **验证**：
  - `src/skills/frontmatter.test.ts` 补 kebab-case alias 往返 + M1 字段 parse + 未知字段 ignore
  - 真实的 `anthropics/skills` fixture（2 个 skill 足够）能零翻译解析
- **产出**：frontmatter.ts + types.ts + 测试
- **提交**：`bc93f42` — `feat(skills): add frontmatter v2 reader with source-based trust defaults`
- **实证**：
  - `vitest src/skills/frontmatter.test.ts src/skills/manager.test.ts` → 14 passed（2 files）
  - `biome check` on changed files → passed
  - `git diff --stat` → `skills/*` only，5 files changed，`+305 / -24`

### Phase 1 — 条件激活 + KV-cache friendly catalog ✅

- **做什么**：
  1. `CatalogRenderer.render(descriptors, turnContext)` 新增过滤管道：
     - 按 `requiresTools` 过滤（`turnContext.availableToolNames` 必须覆盖）
     - 按 `requiresToolsets` 过滤
     - 按 `platforms` 过滤（读 `process.platform`）
     - 按 `trust` 过滤（UI/agent 请求可要求最低 trust level）
  2. **D-13 KV-cache 稳定性改造**（关键）：
     - 稳定前缀段（bundled + user + `mandatory: true`）按 `skill_id` **lexicographic** 排序，放 system prompt 稳定前缀
     - 可变段 `<hot_skills>` 按 `recency × relevance` 排序，**限 ≤10 条**，作为独立 XML 块放在稳定前缀**之后**
     - hot_skills 排序算法待定：先走简单 `recency (last_used_at) × 0.6 + relevance (keyword match) × 0.4`
  3. Prompt session assembler 的插入点对齐 02-context：稳定前缀 → `<hot_skills>` → per-turn decoration
- **不做什么**：
  - ❌ hot_skills 的机器学习型 relevance（简单 keyword match 就行，M2+ 再做 embedding）
  - ❌ CRUD / 内容扫描
- **依赖**：Phase 0 完成
- **验证**：
  - `src/skills/catalog-renderer.test.ts` 覆盖四种过滤 + 稳定前缀 lex-sort + hot_skills 限 10 条 + 前缀 hash 稳定性（两轮不同 recency 下，稳定前缀字节级一致）
  - 02-context 集成测试：KV-cache 命中率（通过 stable-prefix hash）在 3 轮对话里保持 100%
- **产出**：catalog-renderer.ts 改造 + sorter 工具 + 测试

### Phase 2 — skill_manage CRUD + WriteAuthority 集成 ✅

- **做什么**：
  1. `packages/agent-core/src/skills/manage.ts` 实现 `SkillManageAction` 三种 action（参照 13 §2.6）
  2. **路由所有写入到 07 §2.6.4 WriteAuthority**：
     - `create` → `origin: "agent"` / `riskLevel: "high"`
     - `update` → `origin: "agent"` / `riskLevel: "high"`
     - `delete` → `origin: "agent"` / `riskLevel: "medium"`
     - **敏感 frontmatter 升级**：`allowedTools` 含 `shell_exec` / `file_write` / `skill_manage` 自身时，`riskLevel` 升为 `"critical"`
     - **Background nudge 未来调用时**：`origin: "idle"` —— 在非 `--trust auto` 模式下**强制 deny**
  3. 路径安全（复用 M0 的 realpath + symlink reject）+ 大小校验（≤100K 字符 / ≤1MiB）
  4. 写入目标目录决策：
     - agent 主动 create 默认写到 `~/.quilin/skills/<name>/SKILL.md`
     - project-level 写入需要用户显式在 action 里声明 `target: "project"`
  5. CRUD 成功后触发 `SkillsManager.discover()` 重建 catalog（或走 watcher 自然同步，看 Phase 4 实现）
- **不做什么**：
  - ❌ skills_guard 威胁扫描（Phase 3）—— Phase 2 只做路径 / 大小 / WriteAuthority
  - ❌ 撤销机制 —— undo 走 WriteAuthority 的通用 dry-run + 用户确认
- **依赖**：Phase 0 + Phase 1；07 §2.6.4 WriteAuthority 已 ✅
- **验证**：
  - `src/skills/manage.test.ts`：三个 action 的 happy + error path、sensitive frontmatter 升级、`origin:"idle"` 在 ask 模式下 deny
  - 契约测试：skill_manage 不能绕过 WriteAuthority（用 spy 验证每条写入都经过 gate）
  - E2E：agent 调用 skill_manage(create) → WriteAuthority prompt → 用户确认 → 文件落盘 → catalog 立即包含新 skill
- **产出**：manage.ts + skill_manage tool 注册 + 测试

### Phase 3 — skills_guard 内容扫描 + 4 级信任策略 ⏳

- **做什么**：
  1. `packages/agent-core/src/skills/guard.ts`：移植 Hermes 的 30+ 威胁模式（数据外泄、prompt 注入、破坏性操作、持久化、混淆）为 regex / AST 规则集
  2. 4 级信任策略决定扫描严格度：
     - `builtin` → 不扫描（编译进 agent-core，已审）
     - `trusted` → 扫描但只 warn
     - `community` → 扫描；发现 medium+ 威胁 → 载入时 ask
     - `agent-created` → 扫描；任何 medium+ 威胁 → deny（除非 `--trust auto`）
  3. 两个介入点：
     - `skill_view` 执行时（读入前扫描）
     - `skill_manage(create|update)` 写入前扫描
  4. 复用 07 分类器基础设施（不再自建），只贡献威胁模式表
- **不做什么**：
  - ❌ 2 阶段 ML 分类器（M2+，和 B2 tiny-classifier spike 并轨）
  - ❌ 运行时的 skill body 修改拦截 —— 只在 load / write 两个边界扫描
- **依赖**：Phase 2 完成；07 §2.6.4 分类器 API 可复用
- **验证**：
  - `src/skills/guard.test.ts`：每类威胁至少 2 个 positive + 2 个 negative fixture
  - 4 级策略矩阵：同一条 medium 威胁在 builtin/trusted/community/agent-created 下分别得到 pass/warn/ask/deny
- **产出**：guard.ts + threat-patterns.ts + 测试

### Phase 4 — Post-compact 恢复 + file watcher ⏳

- **做什么**：
  1. **Post-compact 恢复**（Claude Code 模型）：
     - 02-context 压缩触发后，`SkillsManager.postCompactRestore(ctx)` 返回最近 5 个被 `skill_view` 加载过的 skill、每个 ≤5K token、总预算 ≤25K
     - 恢复点作为独立可变块，放在 `<hot_skills>` 之后（避免污染稳定前缀）
     - 跨 session（checkpoint 恢复）用 last_used_at 排序的 LRU
  2. **File watcher**（热发现）：
     - 监听 `~/.quilin/skills/` / `.quilin/skills/` 目录（`fs.watch` + debounce 200ms）
     - 新增 / 删除 → `discover()` + emit `onChange` 事件
     - 内容修改 → 仅当 frontmatter 变了才重 parse；body-only 改动只 invalidate 缓存
  3. 用户体验：REPL 显示 `🎯 Skill activated: web-scraping` / `📥 New skill discovered: rust-migration-helper`（可折叠，对齐 Phase 2 /verbose）
- **不做什么**：
  - ❌ 多机 skill 同步（M2+ agent-mesh）
  - ❌ Plugin 贡献的 skill roots（M2+）
- **依赖**：Phase 0~3 全部完成；02-context 的 compact 钩子
- **验证**：
  - `src/skills/manager.test.ts` 补 watcher 新增 / 删除 / 修改 fixture
  - `src/context/post-compact.test.ts` 跑端到端：模拟 10 次 skill_view 后 compact，确认 restore 返回正确的 LRU 5 个
  - E2E：跑 B3a smoke test + 手动往 `~/.quilin/skills/` 扔一个新 skill，observer 看到 activation 通知
- **产出**：post-compact.ts + watcher.ts + REPL 事件接线 + 测试

## Decisions

### 2026-04-21 — B3b 完全走 M1，不碰 M2+ 的自进化

- **Before**：一个候选方案是 B3b 顺手把 Background nudge (10-self-evolution 的入口) 也做了
- **After**：B3b 只交付 M1（CRUD + 条件激活 + skills_guard + post-compact），Background nudge 推迟到 10-self-evolution 单独立项
- **理由**：
  - 10-self-evolution 自己的 Idle Evolution Budget 还没落地，`origin:"idle"` 的预算钩子缺失
  - 先把 skill_manage 的写入通道和 WriteAuthority 验证对齐，后面 nudge 就是"调用已有 API"的问题

### 2026-04-21 — skill_manage 唯一写入，CRUD 所有路径过 WriteAuthority gate

- **After**：Phase 2 里所有 create/update/delete 动作**强制**路由到 07 §2.6.4 WriteAuthority，无 bypass
- **理由**：
  - 10-self-evolution 的 Python 侧只能 propose `SkillDescriptor` 草稿，落盘必须经 MCP → TS 侧 skill_manage → WriteAuthority
  - 避免出现"agent 绕过安全层"的第二个写入口（第一个是 shell_exec / file_write，已被 WriteAuthority 管住）
- **对应风险**：R-01 CRITICAL

### 2026-04-21 — Catalog 排序 D-13 约束固定为 "stable-prefix lex-sort + hot_skills ≤10 可变段"

- **After**：稳定前缀 `skill_id` lex-sort；hot_skills ≤10 在独立 XML 块
- **理由**：
  - harness-engineering §十 KV-cache 命中率 >80% 是硬目标
  - hot_skills 独立成块允许"活"的 recency × relevance 排序而不污染稳定前缀
  - 10 条是 Claude Code post-compact recovery 的默认值，和 Phase 4 的 LRU 5 条天然对齐

## Open Questions

- [ ] **skill_manage 默认写入位置**：agent 主动 create 默认走 `~/.quilin/skills/` 还是 `.quilin/skills/`？前者全局、后者项目；推荐前者（community skill 默认共享），但要用户确认
- [ ] **trust=agent-created 的默认处理**：无 `--trust auto` 时是载入 ask 还是**写入 ask**？倾向写入时 ask 一次（一次性决策成本低），载入时只做 skills_guard 扫描
- [ ] **post-compact LRU 5 条**的 token 预算如果某个 skill 本身 >5K，是截断还是跳过？推荐跳过（截断后指令不完整反而危险）
- [ ] **Phase 2 与 Reasoning Phase 2 first batch 的文件重叠**：Codex 正在改 `loop.ts` / `state/*`；B3b 的 CRUD 路径只会写 `src/skills/*`，不重叠；但 skill_manage 作为工具注册时会动 `tools/registry.ts`，需要等 B2 WriteAuthority gate 的 post-hook 合并后再接

## Blockers

- 无硬 blocker；Phase 2 需要等 Reasoning Phase 2 first batch 的 Codex 工作落地后再动（防止并发改动 `loop.ts` 区域）

## Risks

| # | 描述 | 严重度 | 缓解 |
|---|------|--------|------|
| R-01 | skill_manage 绕过 WriteAuthority | **CRITICAL** | 契约测试；spy 验证每条写入都过 gate；CI 断言 `packages/agent-core/src/skills/**` grep 不到 `fs.writeFile` 直接调用 |
| R-02 | 条件激活导致 catalog 预算漂移，token 爆炸 | HIGH | 稳定前缀 + hot_skills ≤10 硬上限；catalog 预算默认 1K token，超则 descriptor 截断 |
| R-03 | skills_guard 误伤（把合法 skill 拒了） | HIGH | 每类威胁 2 positive + 2 negative fixture；trust 分级让误伤只发生在 agent-created 层 |
| R-04 | Post-compact 恢复破坏 KV-cache 稳定前缀 | HIGH | 恢复点作为**独立可变块**放在稳定前缀之后，不混入前缀；契约测试验证前缀 hash 不变 |
| R-05 | File watcher 在大目录下 CPU 爆表 | MEDIUM | debounce 200ms；only watch `~/.quilin/skills/` 和 `.quilin/skills/`；不递归 > 3 层 |
| R-06 | Phase 2 与 Reasoning Phase 2 的 loop.ts 并发改动 | LOW | Phase 2 主要改 `src/skills/*`，只在工具注册时碰一次 registry；等 Codex Phase 2 first batch 合并后开 |

## Next Action

- **Claude**：等用户对 B3b 规划（4 phase 拆法 + R-01 critical 约束）确认后，把本文件 status 从 `planning` 切到 `in-progress` 并把任务交接 Codex
- **Codex**：等规划定稿 + Reasoning Phase 2 first batch 合并后，从 Phase 0 开 TDD（红→绿→refactor）
