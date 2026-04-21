---
title: 三方协作体系 v0 — User × Claude × Codex
status: planning
owner: Claude (起草) + Codex (待 review) + human (终审)
created: 2026-04-21
last_updated: 2026-04-21
threat_surface_delta:
  new_ingress: []
  new_egress: []
  new_persistence: []
---

# 三方协作体系 v0

## 目标

一份所有人都在看的、不漂移的协作合约。解决三个问题：
1. **需求拆解 → 执行 → review** 各阶段谁做、做什么、输出什么
2. Claude / Codex 分工明确（避免重叠、避免漏）
3. 每做完一块必须有可见标记（用户不用追问）

## 角色定义

| 角色 | 身份 | 主要职责 | **不做**什么 |
|---|---|---|---|
| **User** | 决策者、价值判断 | 需求描述、优先级、方案拍板、review 终审 | 不写代码、不手动 commit（除非特别要求） |
| **Claude** | Planner / Reviewer / Scribe | 规划、拆解、review、文档、协作消息、decision 记录 | **不写业务代码**（条件例外见下）、不直接执行大批量操作 |
| **Codex** | Implementer / Verifier | 代码实现、测试、重构、build 验证、根因定位 | 不做架构决策（应先和 Claude 对齐再动手）、不 commit（把 commit 范围交给 Claude） |

**Claude 写代码的例外**：token 充足 + 偏规划/脚本/小改（参考 memory `feedback_claude_no_code`）。批量执行、重构、复杂实现 → 全部交 Codex。

## 6 步协作流

每一个非琐碎请求都走这 6 步。**每步结束必须打标记**（用户可见 + 文档可溯）。

```
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ 1. 需求  │ → │ 2. 调研  │ → │ 3. 方案  │ → │ 4. 规划  │ → │ 5. 执行  │ → │ 6. Review│
│ 拆解    │   │ 分析    │   │ 整理    │   │ 迭代    │   │ 按步    │   │ 验收    │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
  Claude       Claude        Claude         Claude        Codex         Claude
   主导         主导          主导           主导          主导          主导
```

### Step 1 — 需求拆解

- **Claude 主导**：把用户一句话需求拆成可验证的子问题 / 约束 / 验收标准
- **Codex 协作**：补充实现层面的技术约束（依赖、性能、兼容性）
- **产出**：`docs/planning/YYYY-MM-DD-NN-<slug>.md` 的 `## 目标` + `## Phases` 骨架
- **打标记**：frontmatter `status: planning`；开头写"需求描述"段落
- **用户信号**：Claude 在聊天中贴出需求理解清单，用户确认"对齐"后才进 Step 2

### Step 2 — 调研分析

- **并行**：Claude 负责文档调研（上游、ADR、历史 review）；Codex 负责代码调研（root cause、现有实现、依赖链）
- **硬规则**：**必须用 `code-review-graph` MCP** 先查结构，查不到再 Grep/Read
- **产出**：tracking doc 的 `## Probe` 段（证据链、数据、官方文档链接），附 commit 或 PR 引用
- **打标记**：Phase 0 从 `pending` → `completed`，填入"产出"和"验证"
- **用户信号**：Claude 推送 ≤200 字摘要（关键发现 + 不确定点），用户确认进 Step 3

### Step 3 — 方案整理

- **Claude 主导**：基于调研给出 2-3 个选项（不是单一方案），每个标注 tradeoff
- **Codex 协作**：对每个选项独立打分（可行性、成本、风险）；不同意就用 `My independent view / I disagree on` 显式表达
- **产出**：tracking doc 的 `## Decisions` 新增一条，列出 Before / After / 证据
- **打标记**：若推翻原计划，`status` 可能变 `blocked` 或保持 `planning`
- **用户信号**：用户看到 Claude + Codex 的**两份独立意见**（可能一致、可能冲突），由用户拍板

### Step 4 — 迭代规划

- **Claude 主导**：把方案拆成 Phase 0..N，每 phase 有独立 `do / don't / threat_surface_delta / 验证 / 产出`
- **必填**：`threat_surface_delta`（新 ingress / egress / persistence），参考 `docs/planning/_template.md`
- **产出**：tracking doc 的 `## Phases` 表 + 每 phase 详细展开
- **打标记**：`status: planning` → `in-progress`（Phase 0 starting）
- **用户信号**：Claude 贴出 Phase 表（markdown），用户"OK 开动"

### Step 5 — 按步执行

- **Codex 主导**：**一次只做一个 phase**，不跨 phase 写
- **Claude 并行**：每个 phase 合并前先 read-only review 对应代码 + 核对 `threat_surface_delta` 是否兑现
- **每 phase 结束标记**（强制）：
  1. tracking doc 对应 phase 行：状态 `in-progress` → `completed` + 填 commit SHA
  2. AgentBridge 推消息给 Claude（"Phase N done, commit xxx, verification: …"）
  3. Claude 在聊天中 ack + 推 ≤100 字 status 给用户
- **不允许**：批量 merge N 个 phase 再一次性汇报、跳过 verification

### Step 6 — Review & 验收

- **Claude 主导**：走 `code-reviewer` + `security-reviewer`（触发条件见 `common/code-review.md`）
- **Codex 主导**：跑全量测试 + lint + build，粘完整输出（不是"测试过了"四个字）
- **产出**：`docs/review/YYYY-MM-DD-<topic>.md` 或在 tracking doc 的 `## Decisions` 追加 review 结论
- **打标记**：全部 phase `completed` + review pass → tracking doc `status: done`
- **用户信号**：Claude 发一条收束消息（"X feature 已完成 / review 已过 / 下一步建议 Y"），用户可以 dismiss 或追加

## Claude × Codex 协作合约

### 1. 通信语言

- AgentBridge 消息全用**中文**（方便用户同步看）
- 代码 / commit message / PR / tracking doc frontmatter 可用英文

### 2. 独立意见协议

涉及方案 / 决策时，至少一方**必须**显式写：
- `My independent view is:` — 给出独立判断（不是 echo 对方）
- `I agree on: …` / `I disagree on: …` — 分项表态
- `Current consensus:` — 最终共识

**禁止**："好的"、"同意"、"👍"式被动附和。独立判断是协作的核心价值。

### 3. Commit 边界

- **谁的 patch，谁列边界**：Codex 改代码 → Codex 列 commit 的 file list + message 草案，Claude 审 + 执行 commit
- **Claude 不擅自合并两个逻辑线**（例如 Gate A + Gate C.2）除非用户授权
- **commit message 规则**：subject 用用户价值导向描述，body 可带内部 tracking 标签（"Gate A done"）

### 4. Pending & Blocker

三个状态必须显式：
- **Holding（等人）**：例如"等用户授权"、"等 Codex 完成 X"
- **Blocked（卡住）**：例如"tsc 依赖缺失"
- **Residual（残留）**：本次不修但记录下来，写进 tracking doc 的 `## Open Questions` 或 `## Blockers`

### 5. 不越界

- Codex 不独自做架构 / 方案决策（Step 3 必须拉 Claude）
- Claude 不直接大规模写业务代码（Step 5 交 Codex）
- 任何一方发现对方越界，立刻 AgentBridge 打断

## 对用户的标记协议

用户不用追问"现在到哪一步了"。以下事件**必须**主动推送：

| 事件 | 谁推 | 格式 |
|---|---|---|
| Step 1 需求拆解完 | Claude | "需求理解：A / B / C，对齐？" |
| Step 2 调研摘要 | Claude | "关键发现 3 条 + 官方文档链接" |
| Step 3 方案选项 | Claude + Codex 并列 | 2-3 个选项 + tradeoff + 两人各自推荐 |
| Step 4 phase 表 | Claude | markdown 表 + OK 开动？ |
| Step 5 每 phase 完成 | Codex → Claude → 用户 | "Phase N done, commit xxx, 下一个：Phase N+1" |
| Step 6 收束 | Claude | "X 已完成 / 下一步建议 Y" |
| Blocker | 遇到的一方 | "卡在 X，需要你决定 A / B" |

## Open Questions

- [ ] `threat_surface_delta` CI 强制检查何时上线（目前是人工填）
- [ ] review 阶段是否固定触发 `code-reviewer` agent，还是 Claude 直接 review
- [ ] 多 feature 并行时 tracking doc 如何交叉引用

## Next Action

1. **Codex review 本文档** — 确认 6 步流 + 独立意见协议 + commit 边界规则是否接受，有否 `I disagree on` 要加
2. **用户终审** — 是否增 / 删 / 改步骤
3. v1 合并后，下一次新需求走一遍验证（例如 B3b Phase 0 启动时）
