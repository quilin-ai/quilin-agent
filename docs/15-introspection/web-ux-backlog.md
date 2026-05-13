# Web UX 待办清单 / Web UX Backlog

> 2026-05-14 · 实际使用 web 端跑出来的 UX gap 集中归档。每条带"影响范围 + 当前现状证据 + 期望行为 + 拟实施位置"四要素,避免实现时再翻聊天记录。
>
> 2026-05-14 · A consolidated backlog of UX gaps found while actually using the web frontend. Each entry carries scope, current-state evidence, expected behavior, and implementation target so an implementer doesn't need to re-trawl chat history.

---

## UX-1 · Shell exec 调用的显示太技术 / shell_exec call rendering is too technical

**影响范围 / Scope**: `apps/web/components/chat/*.tsx`(ToolPart 渲染层),所有有 `tool-shell_exec` part 的 turn。

**当前现状 / Current state (evidence)**: 用户截图显示工具调用行渲染为 `调用 shell_exec`,展开后是 `{"command": "ls -la ~/Desktop/...", "timeoutMs": 5000, "sandbox": "auto"}` JSON 块。用户看到的是工具名 + 实现参数,而不是"系统在执行什么"。

**期望 / Expected**: 把工具名替换成自然语言描述 + 实际命令,例如:
- `调用 shell_exec` → `运行本地命令 ls -la ~/Desktop`
- `调用 web_fetch` → `抓取网页 https://example.com`
- `调用 spawn_subagent` → `派子代理 · 任务: 查询 Rust 最新版本`

折叠态默认只显示一行人话摘要,展开才看原始 JSON。

**实施位置 / Where to implement**:
- 在 `apps/web/components/chat/`(找渲染 `tool-*` part 的组件)加 `formatToolHeader(toolName, input)` 函数
- 每个工具一个 case;未知工具回退到原 `调用 ${toolName}` 形态
- Streamdown 渲染处保留原 JSON 在展开区

**English**: Web's tool-call rendering currently shows the raw tool name (`调用 shell_exec`) plus a JSON dump of the input. Replace the header with a natural-language summary derived from tool name + input shape (e.g. `运行本地命令 ls -la ~/Desktop` for `shell_exec`; `抓取网页 <url>` for `web_fetch`; `派子代理 · 任务: <task>` for `spawn_subagent`). Keep the raw JSON in the expanded body. Add `formatToolHeader(toolName, input)` in `apps/web/components/chat/` with per-tool cases, falling back to the legacy `调用 <toolName>` format for unknown tools.

---

## UX-2 · 连续相同类型动作之间不应该有间距 / Consecutive same-type actions should visually group

**影响范围 / Scope**: `ConversationView.tsx` / `TurnMessage.tsx` 的 part 间距样式。

**当前现状 / Current state (evidence)**: 用户反馈多次("之前说了好几遍")。当 agent 在一个 turn 内连续做 3 次 `shell_exec`,UI 把它们渲染成 3 个独立卡片,每个卡片之间有 `margin-bottom` 间距,视觉上像 3 个分开的步骤,看不出"这是同一个连续动作的多次试探"。

**期望 / Expected**: 连续相同 `partType`(同一个 `tool-<name>` 或同一个 `text`/`reasoning` 段)之间不加间距,渲染成单一连贯块。类型切换(tool → text,或 tool-a → tool-b)才回到正常间距。

**实施位置 / Where to implement**:
- `ConversationView.tsx` 渲染 `message.parts[]` 时,记前一个 part 的 `partType`,如果 `parts[i].type === parts[i-1].type`,给当前 part 加 `q-part-merged` class
- CSS 里 `.q-part-merged { margin-top: 0; border-top: none; border-radius: 0 0 ... ...; }`(或更激进的合并到同一个边框框里)

**English**: Multiple consecutive parts of the same type (e.g. three `shell_exec` calls back-to-back, or several reasoning chunks) should render as a continuous block rather than visually-separated cards. The user has flagged this repeatedly. Track previous part type while rendering `message.parts[]` and add a `q-part-merged` class when the current part's type matches the prior one; the class zeroes the top margin / border / radius corners so the result looks like a single fused block. The boundary returns to normal spacing when part type changes (tool → text, or `tool-a` → `tool-b`).

---

## UX-3 · 旁白 channel 完全没展示 / Narration channel missing in UI

**影响范围 / Scope**: AgentEvent 类型 + sse-translator wire + ConversationView 渲染层。

**当前现状 / Current state (evidence)**: 用户问"旁白呢???"。当前 wire 协议只有 `text` / `reasoning` / `tool-*` / `step-start` 几种 part 类型。Agent 没有专门的"旁白 / aside"通道 —— 那种"我现在在想 X / 我接下来会做 Y / 我犹豫了一下"的元层描述无处可放,只能塞到主 text 里污染回答。

**期望 / Expected**: 加一个 `aside` part 类型,UI 用淡色 / 斜体 / 缩进 / 左侧竖线 等弱视觉权重渲染,跟主回答区分。Agent 可以主动发 aside(通过新工具 `say_aside(text)`或 streamText 输出中混入特定 marker)。

**实施位置 / Where to implement**:
- AgentEvent 加 `aside` 类型(`packages/agent-core/src/services/agent-service/types.ts`)
- sse-translator 映射 aside → UIMessage custom data part `aside`
- ConversationView 加 `<AsidePart>` 组件,Streamdown 渲染但加视觉降权样式
- agent-core 加 `say_aside` 工具供 LLM 调用,或在 system prompt 里指明用 `<aside>...</aside>` 包裹的部分会被前端识别

**English**: There is no narration / aside channel in the wire or UI. The agent currently has to stuff meta-commentary ("I'm now considering X / next I'll try Y / I hesitate here") into the main `text` part, which pollutes the answer. Add an `aside` AgentEvent + UIMessage part type with a de-emphasized visual style (light color / italic / left rule). Expose either a `say_aside(text)` tool or a marker syntax the LLM can emit; sse-translator maps it to a custom data part; ConversationView renders an `<AsidePart>` with Streamdown but weaker visual weight.

---

## UX-4 · 记忆没看到周期性整理 / dedup,工作层全是重复 / Memory consolidation not visible; working tier is full of duplicates

**影响范围 / Scope**: `providers/memory/` (quilin-mem) + `apps/web/app/memory/` (UI 入口)。

**当前现状 / Current state (evidence)**: 用户 `/memory` 截图:工作层 51 条,其中 10+ 条 `用户叫小明`、10+ 条 `my name is 小明`、多条 `用户希望我改名为...`。明显没做 (a) 写入时语义 dedup,也没做 (b) 周期性 consolidation 把工作层多条同主题信息合并成一条语义层。用户问"记忆整理去哪看?"—— 这一类整理活动目前对用户完全不可见。

**期望 / Expected**:
- **写入侧**: quilin-mem 在写工作记忆时跑一次相似度查询,如果有高相似度命中(>0.92)就更新计数而不是新建条目
- **周期 consolidation**: 后台 job(每 N 分钟 / 每 M 条新条目)把工作层多条同主题合并成一条语义层 fact,并在 audit log 留下"merged X entries into Y" 记录
- **UI 可见性**: `/memory` 页加一个 "整理活动 · consolidation log" tab,列出最近的 consolidation 操作("11:23 把 12 条 '用户叫小明' 合并为一条语义层事实",可点击展开看具体合并了哪些 id)。也加一个手动触发按钮"立即整理"

**实施位置 / Where to implement**:
- `providers/memory/src/quilin_mem/`(Python)增 `dedup_on_write` flag 和 `consolidate_working_layer` 后台任务
- 暴露新 MCP 工具 `memory_consolidate(dry_run=False)` 和 `memory_audit_log(since=...)`
- web `/memory` 页加"整理活动"tab 调上面两个 MCP 工具

**English**: The memory store has no on-write dedup and no periodic consolidation. The UI shows 51 working-tier entries with massive duplicates (10+ "用户叫小明", 10+ "my name is 小明", etc.). Add (a) write-time similarity check that increments a count instead of creating a duplicate when similarity > 0.92, (b) a periodic consolidation job that merges same-subject working entries into a single semantic-tier fact, (c) a "consolidation log" tab in `/memory` showing recent merge operations with click-to-expand entry lists, and (d) a manual "consolidate now" button. Expose new MCP tools `memory_consolidate` and `memory_audit_log`.

---

## UX-5 · 配置页缺 user.md / soul.md / QUILIN.md 查看入口 / Config page lacks viewer for user.md / soul.md / QUILIN.md

**影响范围 / Scope**: `apps/web/app/config/` 页面 + 新 API endpoint。

**当前现状 / Current state (evidence)**: 用户:"还要能看到 user.md 和 soul.md 在配置上面增加一栏吧,点击去看这两个文件 / 配置里面还要能看到 QUILIN.md"。这三个文件是 Quilin "灵魂导入" / "用户画像" / "项目指南" 的核心 markdown 状态:
- `~/.quilin/user.md` — 全局用户画像
- `~/.quilin/soul.md` — agent 自身的"灵魂"(soul-import 阶段产物)
- 项目本地 `QUILIN.md` — per-project 指南

当前 `/config` 页没有入口看这三个。

**期望 / Expected**: `/config` 页加新分区 "灵魂与画像 · soul & profile",三行卡片:
- `user.md` ~/.quilin/user.md
- `soul.md` ~/.quilin/soul.md
- `QUILIN.md`(项目根 — 如果存在)

点击任一行进入只读 markdown viewer(Streamdown 渲染),带"重新加载 / refresh"和"在文件管理器中显示 / reveal in finder"按钮。**默认只读** —— 编辑这些文件需要走 WriteAuthority CRITICAL gate(等 ask/approval primitive 落地后再开编辑能力)。

**实施位置 / Where to implement**:
- 新 GET endpoint `/api/profile-files?which=user|soul|project`,后端读对应路径返回 `{ path, content, lastModified }`,文件不存在返回 `404 + { exists: false, path }`
- `apps/web/app/config/page.tsx` 加 "灵魂与画像" section 调上面 endpoint
- 复用 `<Streamdown>` 组件渲染 markdown

**English**: The `/config` page has no entry to view the three Markdown soul/profile files that drive Quilin's persona and per-project context:
- `~/.quilin/user.md` (global user profile)
- `~/.quilin/soul.md` (agent's "soul" — soul-import output)
- `<project>/QUILIN.md` (per-project guide)

Add a "灵魂与画像 / soul & profile" section to `/config` listing these three with click-through to a read-only Streamdown markdown viewer. Add a `GET /api/profile-files?which=user|soul|project` endpoint returning `{ path, content, lastModified }` or `{ exists: false, path }` on miss. Read-only by default; editing through this surface requires the (forthcoming) ask/approval CRITICAL gate.

---

## 优先级 / Priority

排序由 [Iter F web session 持久化](../09-deployment-runtime/web-session-persistence-spec.md) 和 [Iter F 交互 primitives](../07-safety-guardrails/interaction-primitives-spec.md) 完成后再开始这五条。它们都没有 SSRF / jailbreak 级别的安全风险,但 UX-4(记忆整理)对长期可用性影响最大,UX-3(旁白)对 Conversation Engineering(02.x 子模块)是前置依赖。

Suggested execution order after the two design-doc deliverables land:
1. **UX-4** (memory consolidation) — long-term product viability
2. **UX-3** (aside channel) — Conversation Engineering prerequisite
3. **UX-1** (tool-call header rewrite) — quick UX win
4. **UX-2** (consecutive-part merging) — quick UX win
5. **UX-5** (soul/profile viewer) — depends on (forthcoming) approval gate for the edit path
