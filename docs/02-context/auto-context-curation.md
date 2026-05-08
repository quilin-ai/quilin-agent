# 上下文自动装配 / Auto-context Curation

> Build the **policy table** that decides what context to auto-load and when, so the harness — not the LLM at runtime — assembles `~/.claude/CLAUDE.md` + project `CLAUDE.md` + auto-memory + recent task list + relevant skills into the system prompt. Tracking iteration: **Iter L+2**.
>
> 建一张**策略表**，决定什么时候自动 load 哪些 context，让 harness（而不是运行时 LLM）把 `~/.claude/CLAUDE.md` + 项目 `CLAUDE.md` + auto-memory + 最近任务清单 + 相关 skill 组装进 system prompt。追踪 iteration：**Iter L+2**。

---

## 一、问题 / Problem

Claude Code "feels smart" partly because the harness — not the model — automatically loads global + project guidance + memory + recent state + relevant skills, and assembles them into the system prompt at session start without LLM intervention. The model doesn't have to "remember to ask"; the context is already there. Quilin's `02-Context` already has the **assembly machinery** (PromptSessionAssembler, ContextManager, TokenBudgetAllocator, conversation-style injection), but it lacks the **policy layer** above — what triggers what load, in what order, with what budget.

Claude Code 的"显得聪明"一半原因是 harness（不是模型）在 session 启动时自动 load 全局 + 项目指导 + memory + 最近状态 + 相关 skill，并把它们组装进 system prompt，全程不用 LLM 介入。模型不需要"记得去问"，上下文已经在那里。Quilin 的 `02-Context` 已有**装配机器**（PromptSessionAssembler、ContextManager、TokenBudgetAllocator、conversation-style 注入），缺的是它**之上的策略层**——什么事件触发哪种 load、按什么顺序、给多少 token 预算。

Today's failure modes 今天的失败模式:

* User edits a file — agent's loaded snapshot stale, agent recommends a refactor that's already done.
* User mentions a project domain term ("our pricing engine") — agent doesn't load the relevant skill or doc, has to ask.
* User memory contains "I prefer Postgres over MySQL" — but the memory wasn't loaded for this session, agent suggests MySQL.
* Session starts — agent loads ALL skills (token bloat) instead of just relevant ones.

* 用户编辑了一个文件——agent 加载的快照过时，建议一个已经做完的重构。
* 用户提到一个项目领域术语（"我们的定价引擎"）——agent 没加载相关 skill 或 doc，得反问。
* User memory 里有"I prefer Postgres over MySQL"——但本 session 没 load 这条 memory，agent 推荐 MySQL。
* Session 启动——agent 把所有 skill 全 load（token 爆炸），不是只 load 相关的几个。

---

## 二、当前状态 / Current State

| 能力 / Capability | 状态 / State |
|---|---|
| `PromptSessionAssembler` | ✅ 已实现 / Landed |
| `ContextManager` | ✅ 已实现 / Landed |
| `TokenBudgetAllocator` | ✅ 已实现 / Landed |
| Conversation-style 注入<br>Conversation-style injection | ✅ 7 风格预设 / 7 style presets landed |
| 全局 + 项目 CLAUDE.md 自动 load<br>Global + project CLAUDE.md auto-load | 🚧 部分：只在 session 启动 load，文件改动后不 reload / Partial: load at session start only, no reload on file change |
| Auto-memory load 触发<br>Auto-memory load triggers | 🚧 全量加载 MEMORY.md 索引；不做相关性匹配 / Loads MEMORY.md index globally; no relevance matching |
| Skill load 触发<br>Skill load triggers | 🚧 catalog 全量暴露；按需 `skill_view` 拉全文 — 但 "什么时候主动建议 load 哪个 skill" 缺策略 / Catalog fully exposed; on-demand `skill_view` pulls full content — but no policy for "when to proactively suggest loading skill X" |
| 失效检测<br>Staleness detection | ❌ 不存在 / Does not exist |
| 诊断面板<br>Diagnostic surface | ❌ 不存在 / Does not exist |

---

## 三、设计 / Design

### 3.1 Trigger table / 触发表

每个事件对应"应当 ensure-loaded"的 context 项 + 加载优先级 + token 预算份额：

Each event maps to "should ensure-loaded" context items + load priority + token budget share:

| Event / 事件 | Context 项 / Context item | Priority / 优先级 | Budget share / 预算份额 |
|---|---|---|---|
| Session start / session 启动 | `~/.claude/CLAUDE.md` (global) | essential | 5 % |
| Session start | Project `CLAUDE.md` (cwd-rooted) | essential | 10 % |
| Session start | `~/.claude/projects/<project-id>/MEMORY.md` index | essential | 5 % |
| Session start | Skills catalog (descriptor list, not full content) | essential | 5 % |
| Session start | Recent TaskList state (last 50 entries) | important | 5 % |
| User message contains domain term | Matching memory entries (semantic search) | important | up to 10 % |
| User message contains domain term | Matching skill (full content via `skill_view`) | important | up to 10 % |
| File edited (PostToolUse hook) | Re-load that file's snippet, evict old version | important | dynamic |
| Tool call returns large result | Compress before next LLM call | nice-to-have | n/a |
| Subagent dispatch | Pass relevant subset to subagent's initial prompt | important | n/a |

### 3.2 Budget allocation policy / 预算分配策略

`TokenBudgetAllocator` 已实现。本 iter 在它之上加策略：

`TokenBudgetAllocator` is landed. This iter adds policy on top:

```
total_context_budget = model.maxContext - <output_reservation>
                     = ~70 % of context window

essential_budget    = 25 % of total_context_budget
important_budget    = 50 % of total_context_budget
nice_to_have_budget = 25 % of total_context_budget
```

Loading order: essential → important → nice-to-have. When budget exhausted at any tier, **drop nice-to-have first, then compress important, never drop essential.**

加载顺序：essential → important → nice-to-have。任何一档预算耗尽时，**先丢 nice-to-have，再压缩 important，永远不丢 essential。**

### 3.3 Relevance matching / 相关性匹配

User message 进来时，对 auto-memory + skill catalog + project doc 跑双通道检索：

When user message arrives, run dual-channel retrieval over auto-memory + skill catalog + project doc:

* **BM25 全文检索 / BM25 full-text** — 关键词命中 / keyword hit
* **Semantic search (embedding)** — 语义相似 / semantic similarity

合并 top-K，按 relevance score 排序，按 budget 取前 N 条注入 system prompt。

Merge top-K, sort by relevance score, take top-N within budget, inject into system prompt.

### 3.4 Staleness detection / 失效检测

PostToolUse hook：当 `file_write` / `file_edit` / `bash` 修改了 already-loaded 文件后，标记该文件为 stale；下一次 LLM call 前自动 re-load 最新内容。

PostToolUse hook: when `file_write` / `file_edit` / `bash` modifies an already-loaded file, mark that file stale; before next LLM call, auto-reload latest content.

实现位置：`packages/agent-core/src/context/staleness-tracker.ts`（新文件）。

Implementation: `packages/agent-core/src/context/staleness-tracker.ts` (new file).

### 3.5 Diagnostic surface / 诊断面板

用户能看到当前 context 里有哪些 segment、各占多少 token、为什么被 load。两个表面：

User can see what segments are currently loaded, their token cost, and why each was loaded. Two surfaces:

* TUI: `just context show` 命令打印 ASCII 表
* WebUI Dashboard (Iter G2 集成): 实时可视化 context 组成

* TUI: `just context show` prints ASCII table.
* WebUI Dashboard (Iter G2 integration): real-time visualization of context composition.

---

## 四、行动项 / Action Items

### P0 — Trigger table 与触发逻辑 / Trigger Table and Trigger Logic

* [ ] `packages/agent-core/src/context/auto-load-policy.ts`（新文件）声明 trigger table
* [ ] PromptSessionAssembler 在 session start / user message arrive / PostToolUse 三个 hook 点查表执行
* [ ] 单测覆盖每条 trigger 路径，覆盖率 ≥ 95 %

### P0 — 全局 + 项目 CLAUDE.md auto-load + reload / Global + Project CLAUDE.md Auto-Load + Reload

* [ ] Session start: load `~/.claude/CLAUDE.md` + cwd-rooted `CLAUDE.md` + auto-memory `MEMORY.md` index 全部进 essential 档
* [ ] PostToolUse hook 检测 CLAUDE.md 改动 → re-load
* [ ] PromptSessionAssembler 中英双语段落对照配对 essential / important / nice-to-have 三档

### P1 — 相关性匹配 / Relevance Matching

* [ ] BM25 + semantic search 双通道检索（embedding 用 Quilin 现有 LLM provider，不引入新依赖）
* [ ] User message → top-K memory + skill + doc 注入
* [ ] 集成测试：给定 user message，断言注入了正确的 memory / skill

### P1 — Staleness detection / 失效检测

* [ ] PostToolUse hook 监听 `file_write` / `file_edit` / `bash`
* [ ] 标记 stale；下次 LLM call 前 re-load
* [ ] 单测 + 集成测试

### P2 — Diagnostic surface / 诊断面板

* [ ] `just context show` TUI 命令
* [ ] WebUI Dashboard 集成（依赖 Iter G2）

---

## 五、不做 / Out of Scope

* 不重写 PromptSessionAssembler / ContextManager / TokenBudgetAllocator 核心（已实现）
* No PromptSessionAssembler / ContextManager / TokenBudgetAllocator core rewrite (already landed)
* 不做语义压缩（Iter A / B 已做基础压缩）
* No semantic compression (Iter A / B already covered)
* 不做 K / H 已规划的内容（对话工程 6 层 / memory.db 开箱即用）
* No content overlap with planned Iter K / H (conversation engineering 6-layer / out-of-the-box memory.db)

---

## 六、关联 / Cross-References

### Linear

* **Iter L+2 project**: [上下文自动装配 / Auto-context Curation](https://linear.app/quilin-agent/project/iter-l2上下文自动装配-auto-context-curation-c79d1abf1143)
* **Tracker issue**: [QUI-137 — Iter L+2 tracker: trigger table + relevance match + staleness detection](https://linear.app/quilin-agent/issue/QUI-137/iter-l2-tracker-trigger-table-relevance-match-staleness-detection) (priority Medium)
* **依赖 / Depends on**: Iter L+0 (EDD signal verifies policy is net-positive)
* **协同 / Coordinates with**: Iter K (本 iter 提供 K 的"何时注入 6 层"触发器), Iter H (本 iter 提供 H 的"何时 load memory" 策略)

### 文档 / Docs

* [`../00-core-loop/intelligence-roadmap.md`](../00-core-loop/intelligence-roadmap.md) — 总索引 / master index
* [`./README.md`](./README.md) — 02-Context 当前状态 / current state
* [`./conversation-engineering/`](./conversation-engineering/) — Iter K 的 parked spec / Iter K parked spec
* [`../03-memory/README.md`](../03-memory/README.md) — Memory 当前状态 / Memory current state
* [`../13-skills/README.md`](../13-skills/README.md) — Skills 当前状态 / Skills current state
