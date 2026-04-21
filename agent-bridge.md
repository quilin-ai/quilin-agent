---
title: Agent Bridge — Claude × Codex × User 协作协议
status: draft
version: v1.1
owner: Claude + Codex (co-authored) + human (终审)
created: 2026-04-22
last_updated: 2026-04-22
revision_note: v1.1 adds §10.3.1 Claude 代写代码细粒度约束 (PB-03 closed)
supersedes: docs/planning/2026-04-21-05-collaboration-protocol.md
precedence: User instructions > this file > quilin.md > agent global rules
---

# Agent Bridge 协作协议 v1

## §1 目的与优先级

本文件是 **Claude × Codex × User** 在 quilin-agent 项目内的协作权威源。

**优先级**：
1. 用户的当次 / 长期指令（CLAUDE.md / AGENTS.md / 会话中直接要求）
2. 本文件（`agent-bridge.md`）
3. `quilin.md` 项目指南
4. Agent 全局规则（`~/.claude/CLAUDE.md` 等）

**何时适用**：每一个非琐碎请求（需要多步执行 / 多方协作 / 跨 session 的任务）。一句话可答的问题不走本协议。

**冲突处理**：当本协议与下层规则冲突 → 本协议为准；当本协议与用户指令冲突 → 用户指令为准。

---

## §2 角色分工

| 角色 | 身份 | 主要职责 | **不做**什么 |
|---|---|---|---|
| **User** | 决策者、价值判断、终审 | 需求描述、优先级、方案拍板、review 终审 | 不写代码、不手动 commit（除非特别要求） |
| **Claude**（主线程 + subagent） | Planner / Reviewer / Scribe | 规划、拆解、review、文档、协作消息、独立调研 | **不当甩手掌柜**：双在线时必须承担规划 / 调研 / review / 文档中至少一项，不能只做任务转发 |
| **Codex**（主线程 + subagent） | Implementer / Verifier | 代码实现、测试、重构、build 验证、根因定位 | 不独自做架构 / 公共接口 / schema / 迁移策略决策（需先拉 Claude 对齐） |

**双在线 + token 充足**：Claude + Codex **共同规划**（R1）。Claude 不许只等 Codex 给方案，必须主动深入思考。

**Codex token 耗尽**：Claude 接手执行（R2）。Codex 重新上线后**必须 review**（见 §10.1）。

---

## §3 任务生命周期

### §3.1 六步协作流

```
1. 需求拆解  → 2. 调研分析  → 3. 方案整理  → 4. 规划迭代  → 5. 按步执行  → 6. Review 验收
  Claude 主导   双方并行调研    双方独立意见     Claude 主导     Codex 主导      双方交叉
```

**每步必须打标记**：tracking doc status 更新 + AgentBridge 消息 + 用户可见的简短同步（≤200 字）。

### §3.2 各步产出要求

| 步骤 | 产出 | 标记 |
|---|---|---|
| 1 需求拆解 | tracking doc 骨架 + 需求理解清单 | `status: planning` |
| 2 调研分析 | tracking doc `## Probe` 段（证据链 + 官方文档链接） | Phase 0 `pending → completed` |
| 3 方案整理 | 2-3 个选项 + tradeoff + Claude / Codex 各自独立推荐 | tracking doc `## Decisions` 新增 |
| 4 规划迭代 | Phase 0..N 表 + 每 phase 的 do/don't/threat_surface_delta/验证/产出 | `status: planning → in-progress` |
| 5 按步执行 | 一次一个 phase，每 phase 完成即回传 | Phase 行 `in-progress → completed` + commit SHA |
| 6 Review 验收 | `docs/review/YYYY-MM-DD-<topic>.md` 或 tracking doc 追加 review 结论 | 全 phase `completed` + review pass → `status: done` |

### §3.3 长任务执行纪律（R4）

**长任务判定**：预期连续执行 **超过 5 分钟** 的任务，必须起 subagent 执行。

**3 分钟自检**：主线程任务执行到约 3 分钟仍未完成、预计还需继续明显工作时，必须做一次自检：
- 快收尾 → 主线程吃完
- 还要继续扩展 → 立刻升级为 subagent

**不必 subagent 的短操作**：
- 单文件快速核对
- 一条本地命令即时验证
- 当前对话一句话必须立刻完成的阻塞小检查
- 路径极短、拆分反更慢的修改

**Subagent 启动时同步给用户**（E3）。

**对称异步 review 拓扑** — 详见 §7.3。

**心跳协议**：
- **时间心跳**：subagent 运行中每 2-5 分钟回传一次简短状态
- **阶段心跳**：每完成一个 phase 或关键验证点立即回传，不必等时间到
- **静默上限 5 分钟**：超时必须回报 "仍在跑 X，暂无结论，下一检查点 Y"，避免主线程假死

**心跳内容标准**：
1. 当前在做什么
2. 已确认了什么
3. 还缺什么结果
4. 是否出现 blocker / scope 漂移

**Subagent 升级 / 回传阈值** — subagent 必须停下回传 owning 主线程（或对方 subagent）的情况：
1. 前提假设被证伪
2. 修复扩散到第二条逻辑线
3. 需要改公共接口 / 状态模型 / schema / 迁移策略
4. 本地验证和预期冲突，需重新定性
5. 遇到意外的现有脏改动或潜在冲突

---

## §4 独立验证规则

### §4.1 必须独立验证的 4 个触发条件

只要满足任一条，**不得直接信任对方结论**：
1. 涉及运行时行为，不只是 TS 表面类型
2. 涉及"最新 / 当前版本 / 已验证过"等时间敏感表述
3. 结论会决定 push / merge / release
4. 结论来自 advisor / 第三方文档 / 记忆转述，而不是本地证据

**反面教材**（2026-04-21）：Claude 转述 advisor "sanitizeState 已做结构校验所以不用加 guard" → Codex 一读实现发现只 `messages.map()` 而已，其他字段根本没验。

### §4.2 证据优先级

对外结论必须引用证据，优先级从高到低：
1. 本地源码（file#Lxx）
2. 安装包类型定义（`node_modules/...types.d.ts#Lxx`）
3. 测试输出
4. 官方文档 / release notes
5. 口头判断（最弱，仅可作为辅助）

### §4.3 Advisor 使用纪律

- 调用 advisor 不能替代本地验证
- 任何 advisor 结论都必须由 owning agent **亲自读一次相关代码 / 文档** 后才能对外传递
- 转述 advisor 时必须标注 `(via advisor, 待本地验证)` 直到验证完成

---

## §5 工具与调研规则

### §5.1 code-review-graph 先行

**默认**：在 Grep / Glob / Read 之前，先用 `code-review-graph` MCP 查结构。

**构建成本**：本仓库 full rebuild 约 10 秒（2026-04-22 实测，108 files / 909 nodes / 9575 edges），近乎零成本。

**何时必须先 `build_or_update_graph`**（F4 freshness 触发）：
- 做大范围 review / impact 分析前（incremental update 即可）
- 怀疑图谱损坏或严重过期时用 `full_rebuild=true`
- **刚发生过 rename / move / 大量文件新增**（hook 可能漏触发，先 incremental update）
- **`list_graph_stats` 的 `last_updated` 明显落后于工作树**（`git log -1 --format=%cd` 对比）
- **`detect_changes` 返回的 changed files 与 `git diff` 实际不一致**（提示 hook 漏跑）
- **关键节点 `semantic_search_nodes` query miss**，但本地 `rg` 能搜到对应代码（提示图谱未覆盖）

> **关于 `quilin.md` "auto-updates on file changes (via hooks)" 的口径**：
> auto-update 是**尽力而为（best-effort）**，不是 freshness 保证。hook 可能漏跑、可能异步、可能卡在队列里。
> 做**决策性 review**（impact、breakage 判定、commit 前核对）前，必须按上面的触发条件显式 `build_or_update_graph`，不要盲信自动刷新。

**允许直接用 Grep / Read 的例外**：
- MCP 服务器不可用（图谱调用报错）
- 搜索目标是 Markdown / JSON / 配置文件 / 纯文本（graph 只覆盖 TypeScript / Python / Bash / JavaScript）
- 搜索字面量字符串（graph 是结构图，字面量匹配用 `rg` 更直接）

**何时用 full_rebuild 而非 incremental**：
- 怀疑图谱状态异常
- 大规模文件重命名 / 移动后
- 日常小改 → `incremental`（默认）

### §5.2 网络搜索强制触发（R1）

用户问题或内部判断含以下任一情形时，**必须先网络搜索**再回答：
1. 触发词：最新 / 当前 / today / 现在 / benchmark / release / 版本 / API 变更
2. 结论依赖外部项目**最近 90 天内**可能变化的信息
3. 需要推荐用户投入时间或金钱的方案
4. 需要引用具体网页 / issue / PR / tweet / release note

**搜索顺序**：
1. 本地代码 / 安装包
2. 官方文档 / release notes
3. GitHub issue / PR / changelog
4. 更广泛网页搜索（Twitter / Google / 技术博客）

### §5.3 Claude 的主动调研义务（R1）

双在线时，Claude 至少承担以下之一：
- 方案拆分
- 外部调研
- review / 交叉验证
- 文档 / commit / PR 整理

**不能只做任务转发**。

---

## §6 交接与打断规则

### §6.1 通信语言

- **AgentBridge 消息**：中文（方便用户同步看）
- **代码 / commit message / PR / tracking doc frontmatter**：英文

### §6.2 独立意见协议

涉及方案 / 决策 / review 时，**必须**使用固定格式：
- `My independent view is:` — 独立判断（不 echo 对方）
- `I agree on: ...` — 分项同意
- `I disagree on: ...` — 分项反对（必须给证据）
- `Current consensus:` — 最终共识

**禁止**："好的"、"同意"、"👍"式被动附和。**独立判断是协作的核心价值**。

### §6.3 打断承接

- 收到打断信号（用户新指令 / 对方紧急消息）→ **让对方讲完再动**
- **禁止拼凑缺失上下文**：宁可先重建最小上下文，也不要顺手接着编
- 如果 subagent 被打断，由 owning agent 决定是 resume 还是 abort

### §6.4 三种 Pending 状态

| 状态 | 含义 | 标记方式 |
|---|---|---|
| **Holding** | 等人（等用户授权 / 等对方 agent） | tracking doc `## Next Action` 注明 |
| **Blocked** | 卡住（缺依赖 / 环境问题 / 不可达） | `status: blocked` + `## Blockers` 段 |
| **Residual** | 本次不修但记录（超出 scope） | `## Open Questions` 段 |

### §6.5 越界打断

- Codex 独自做架构 / 方案决策 → Claude 立即 AgentBridge 打断
- Claude 大规模写业务代码（双在线时）→ Codex 立即 AgentBridge 打断

---

## §7 Review 证据标准

### §7.1 Review 请求结构化

Review 请求必须包含以下字段（缺任一视为请求无效）：

```markdown
1. 背景（1-3 句）
2. 具体 review 点（编号列出；每点：工具结论 + 当前判断 + 要求对方验证什么）
3. 不在范围内的东西（显式列出）
4. 输出格式要求（✅ 可 push / ⚠️ 需改不阻塞 / ❌ 阻塞）
5. 文件清单（绝对路径）
```

**反面教材**："帮我看看有没有坑" → 接收方必须重新建立上下文，token 浪费翻倍。

### §7.2 Review 输出分级

- **✅ 可 push**：无 blocking 问题
- **⚠️ 需改但不阻塞 push**：下个 commit 跟进的改进
- **❌ 阻塞 push**：必须先修再 push

**每条结论必须绑定可点击证据**：`file:Lxx` 或 `types.d.ts#Lxx`。

**优秀范例**（2026-04-21 f40c5d3 review）：
> `mcp-client.ts` 的 cast 是 TS 层修饰 — 仓库 pin `@modelcontextprotocol/sdk@1.29.0`（见 `package.json#L18`），`Client.callTool()` 默认 schema 是 `CallToolResultSchema`（见 `client/index.js#L490`），服务端若返回 compat shape 会在 parse 层报错，`formatCallToolResult` 根本拿不到它。

### §7.3 对称异步 Review 拓扑（决策 4）

**标准流程** — owning agent 起 subagent 开发 + 对方 subagent review，循环至共识：

```
owning agent 主线程
    └─ 起 owning subagent（YOLO / 拿完整执行权限，含 write / commit / push / docs 更新）
        ├─ 开发 v1
        ├─→ 送对方 subagent review
        ├─ 收到反馈
        ├─ 改 v2
        ├─→ 再 review
        ├─ ... 循环 ...
        ├─ 双方达成共识
        ├─ 更新 tracking doc（Phase 行 → completed，挂残留项，next action）
        ├─ commit（代码 + tracking doc 同一次）
        ├─ push
        └─ 自我关闭（发最终通知）

主 Claude 和主 Codex：空闲期接新任务（不被 review 循环阻塞）
```

**顺序约束**（F1）：
- tracking doc 更新**必须在 commit 之前**，和代码一起进入同一个 commit
- 禁止 "push → 再补 tracking doc" —— 远端出现代码但 doc 没有对应 SHA / 状态，违反 §3 "tracking doc 是任务真相源"
- 如果收敛后发现遗漏了 tracking doc 项，走新一条 commit（标 `docs: <task> 补挂残留项 / SHA`），不走 amend

**用户可见的 3 个通知事件**（E3）：
1. subagent 启动
2. **最终收敛**（最后一轮 review 通过、即将进入 commit 阶段）
3. commit / push 完成后

中间 review 迭代（v1 → v2 → v3）**一律不通知用户**，避免噪音。

**未收敛硬规则**（E2）：
- 两 subagent review 循环**超过 N 轮未达成共识**（N = **3**）→ 自动升级：**立即打断用户**，由用户仲裁
- 不走主 Claude / 主 Codex 仲裁 —— 直接到用户（用户显式要求）

**主线程 ownership**：
- 任何时刻，一个任务有**唯一的 owning agent**
- owning agent = 被用户指派 / 接住任务的那方
- review agent = 对方
- fallback（对方离线）时 owning agent 起自己的 review subagent（自审，但用独立意见协议强制对立思考）

### §7.4 Cross-review 强制

**默认（双方在线）**：所有 commit / push / release 前，**必须**经对方（或对方 subagent）review（pre-push review）。

**例外 1（E2 用户仲裁）**：用户直接仲裁后的 commit 不必再 review。

**例外 2（§10 降级优先级，F2）**：
- 当对方满足以下任一条件时，§10 的 fallback 覆盖本节 pre-push 强制：
  - 对方离线（AgentBridge 不可达 / 超时静默）
  - 对方 token 低于 §10.3 阈值
  - AgentBridge 本身故障
- 此时 owning agent 可以单边 commit + push
- 但 **post-hoc cross-review 强制**：对方一上线（token 充足），必须按 §10.1 量化要求补 review
- 如果对方上线后 review 发现 ❌ 阻塞问题：owning agent 负责 follow-up commit 修复，不允许"既成事实"搪塞

**优先级明文规则**：`§10 fallback overrides §7.4 only when peer offline / token-below-threshold / bridge unavailable, and post-hoc cross-review becomes mandatory on return.`

---

## §8 Commit / PR 协作

### §8.1 Commit 权属（C1）

**谁写代码，谁 commit**。

- Codex 写代码 → Codex（或其 subagent）commit
- Claude 写代码（fallback 或 Claude 允许的小改）→ Claude commit
- Codex 离线、Claude 代写代 commit → 作者和 commit 者都是 Claude，**Codex 上线后不补作者归属，只走 §10.1 review**

**"谁开发的 subagent，就用谁的 subagent 收敛"**（commit / push / docs / 关闭都由 owning subagent 做）。

### §8.2 Commit 边界（C2）

**默认**：一个 commit ≤ 一条逻辑线。

**Support-only 搭车例外**：纯只读报告 / 配套测试 / 验证脚本可以搭主逻辑的车，但必须：
- 提交说明显式标注 `(support-only: <原因>)`
- 搭车内容**不得**引入第二条会改变运行时行为的实现

**范例**（2026-04-21 f40c5d3）：Task A 类型清理（主）+ Task D graph 评审报告（support-only，只读新文件）合并 → 合法。

### §8.3 Baseline 回归对比（C3）

大改 commit 前必须做：
```bash
git stash -u && <test command>  # 记录基线
git stash pop && <test command>  # 记录本次
```

**commit message 中必须写明**：前后对比结果（例如 "前后都是 1 failed | 266 passed，失败项一致"）。

### §8.4 残留项必须进 tracking doc（C4）

任何 "本次不修但未来要做" 的条目，**必须**进 tracking doc 的 `## Open Questions` 或 `## Blockers`。口头 "先不管" = 违规。

---

## §9 Session 重置协议

### §9.1 每任务结束的 session 切换（R3）

每完成一个完整任务（§3.1 走完六步），**双方**主动提醒用户：
```
✅ <任务名> 完成
Commit: <sha>
Tracking doc: <path>
Next Action: <下一 session 入口>
→ 建议开启新 session 以避免上下文过长
```

### §9.2 关闭当前 session 的 3 个前置条件

必须全部满足才能建议用户开新 session：
1. 任务状态已写入 `docs/`（tracking doc status 拉到 `done` / `blocked` / `in-progress`）
2. 残留项已挂 tracking doc（§8.4）
3. 下一 session 的最小入口已指定（一条命令 / 一个文件路径）

**任一不满足 → 继续当前 session 收尾**。

### §9.3 新 session 最小 context load

新 session 启动时，Claude / Codex 读：
1. Memory（auto-load，含 MEMORY.md 索引）
2. `quilin.md`
3. 上次 tracking doc 最新状态

**不**重新读全部历史。

### §9.4 Docs 为任务管理源

项目 `docs/` 结构已足够承载任务管理（`docs/planning/` + `docs/iterations/` + `docs/review/`）。**不再引入新的元目录或外部任务系统**。

---

## §10 降级模式

### §10.1 Codex 离线 → Claude 接手执行

- Claude 承担完整执行（包括代码 / 测试 / commit）
- Codex 上线后**必须 review**，量化要求：
  1. 至少检查最终 diff
  2. 至少验证主命令或关键风险点
  3. 明确输出 `✅ / ⚠️ / ❌` 结论
- 口头 "看过了" 不算 review

### §10.2 Claude 离线 → Codex 单边完全继续

- Codex 按 **(a) 完全继续** 推进：不等 Claude 上线就做完 + commit + push
- Claude 上线后补 review（同 §10.1 量化要求）

### §10.3 Token 预警阈值（R2 补强）

**不要等 token 耗尽再切换**。进入以下场景时提前切：
- 大文件阅读 + 多轮验证 + 预期还要改代码
- 下一步预计需要超过当前剩余 context 30% 的任务

主动报告自身 token 状态，不要到报错才暴露。

#### §10.3.1 Claude 代写代码的细粒度约束（PB-03）

当 Codex 额度 < 20% 或离线,Claude 可以代写代码,**但必须落在以下 allow-list**(round-3 PB-03):

**允许 (a / b / c)**:
| 类型 | 边界 | 约束 |
|---|---|---|
| **(a) 文档 / 计划 / 脚本** | `docs/**` / `scripts/**` / `*.md` / `justfile` / CI workflow | 无 LOC 上限,但必须走 §7 pre-push cross-review |
| **(b) ≤50 LOC 纯 TS 小修** | `packages/**/src/*.ts`(非 `index.ts` / 非顶层聚合) | 单文件 diff ≤50 LOC、零新抽象、零新依赖、零新跨包 import;必须同 PR 补 / 更新测试 |
| **(c) 测试用例补全** | `packages/**/*.test.ts` / `providers/**/test_*.py` / `scripts/test_*.py` | 只加 / 改测试,不改被测代码;覆盖已存在实现的既有分支 |

**永远禁止**(Claude 不许写,即便 token 足):
- 架构级改动(新 package / 新 provider / 新 MCP server / 新领域 spec / 新 ADR 落地代码)
- `loop.ts` / `WriteAuthority` / `SafetyPolicy` / `SkillsManager` 等单点契约核心文件的**结构性**修改(命名重命名、签名调整、新 branch)
- 跨 `llm/*` ↔ `context/*` ↔ `skills/*` ↔ `tools/*` 的接口漂移(需 Codex sandbox 验证回归)
- 任何 `providers/memory/src/**` Python runtime 代码(Codex 专属域)

**超出 allow-list 时**:Claude 只写 plan / tracking doc,用 AgentBridge 明确告知用户"此任务需唤醒 Codex",**不得**擅自扩大范围。

**强制 review**:Claude 代写的 (b) / (c) 类改动必须在 commit message 附 LOC 实证(`wc -l` 或 diff stat)+ 测试结果,Codex 上线后走 §10.1 量化补 review(抽样 ≥30% diff)。

### §10.4 用户打断 / 改需求

- tracking doc 的 `status` 按实际回退：`in-progress → planning`
- 如果用户新需求 **替换** 原任务 → 原 tracking doc 加 `superseded by: <新 doc path>`
- 如果用户新需求 **补充** 原任务 → 原 tracking doc 继续，加 `## Addendum <日期>` 段

### §10.5 Subagent 降级模式

**Subagent 失败**：
- 主线程接管，但必须 review subagent 已有产出（看能否复用）
- 失败原因进 tracking doc `## Blockers`

**Subagent token 不足**：
- subagent 主动回传未完成部分 + 当前状态
- owning 主线程决定：继续 subagent 吃完 / 换 agent / 降级主线程

**对方 agent 离线时的 review fallback**：
- owning agent 起**自己的 review subagent** 代替对方 subagent 做 review
- review subagent 必须按独立意见协议（§6.2）强制对立思考
- 自审结论在对方上线后仍需补 cross-review

**心跳丢失 / subagent 卡死**：
- 静默超 5 分钟未回报 → 主线程主动查询 subagent 状态
- 查询无响应 → 视为失败，触发 Subagent 失败流程

---

## §11 附录

### §11.1 文件位置

- **本文件**：`/agent-bridge.md`（仓库根目录）
- **旧 v0**：`docs/planning/2026-04-21-05-collaboration-protocol.md`（已 superseded）
- **项目主指南**：`quilin.md`（`## Agent Collaboration` 节内有指向本文件的引用）
- **CLAUDE.md / AGENTS.md** → 符号链接到 `quilin.md`（**不**直接链接本文件，避免和项目编码规范职责缠死）

### §11.2 修订

- 协议修订必须走 §3 六步流
- 修订 tracking doc 放 `docs/planning/YYYY-MM-DD-NN-agent-bridge-revision.md`
- 修订后在本文件 frontmatter `last_updated` + `version` 递增

### §11.3 Open Questions（v1 留待观察 / 实战后定版）

- [x] `threat_surface_delta` CI 强制检查何时上线 → **CLOSED 2026-04-22**:`scripts/lint-planning.py` 落地(SD-08,commit `a6c7cab`),本地可跑;CI 集成作为后续 track 任务
- [ ] N=3 未收敛阈值是否合适（实战后可调）
- [ ] 10-commit 图谱失效阈值是否合适（实战后可调）
- [ ] 多 feature 并行时 tracking doc 如何交叉引用（未覆盖）
- [ ] Claude subagent 在 Claude Code 环境下如何保证 YOLO / auto-approve（tool permissions 配置）
