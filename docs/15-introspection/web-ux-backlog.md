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

## UX-4 · 记忆基于知识图谱重做:抽取 / dedup / 可视化 / Memory rebuilt around the knowledge graph: extraction / dedup / visualization

**影响范围 / Scope**: `providers/memory/` (quilin-mem 服务端) + `apps/web/app/memory/` (UI) + 新 `/api/memory/graph` endpoint。

**当前现状 / Current state (evidence)**: 用户 `/memory` 截图:工作层 51 条,其中 10+ 条 `用户叫小明`、10+ 条 `my name is 小明`、多条 `用户希望我改名为...`。Flat list 视图。

后端代码实证(2026-05-14 grep):

- ✅ **`TemporalKnowledgeGraph` 已实现** —— `providers/memory/src/quilin_mem/kg.py` 222 行,有 `add_edge` / `search` / `subgraph_search` / `reset` 完整 API。
- ✅ **SQLite schema 已存在** —— `kg_validation.py:153` 定义 `kg_edges(edge_id, subject, predicate, object, valid_from, valid_to, memory_id, weight, metadata_json, created_at)`,含 `(subject, object)` 和 `(valid_from, valid_to)` 索引。标准 RDF-like temporal triple store。
- ✅ **KG 检索器已写好** —— `retriever_kg.py` 实现基于子图的检索。
- ❌ **没人调 `add_edge`** —— `grep -rln "add_edge" providers/memory/src/quilin_mem/` 命中 0 个调用方。MCP server `server.py` 写 memory 时直接进 `memory_records` 表,**不抽实体也不建关系**。`kg_edges` 表实际是空的。
- ❌ **没人抽实体关系** —— 没有 LLM-driven 也没有规则的 NER + relation extraction 把 "用户叫小明" 转成 `(用户, has_name, 小明)`。
- ❌ **没人渲染图** —— `apps/web/app/memory/` 只是 flat list,没读 `kg_edges`。

**期望 / Expected**: 记忆**完全基于知识图谱重做**,不只是给现有 flat list 加 dedup。三层一起补:

### A. 写入路径:实体/关系抽取 + dedup / Write path: extraction + dedup

- 新增 `providers/memory/src/quilin_mem/kg_extractor.py`:接收 raw memory text + 上下文 → 输出 `KGEdge[]`(subject/predicate/object)。两种 backend:
  - **LLM 抽取**:调用 DeepSeek/小模型,prompt 模板"抽取所有 (subject, predicate, object) 三元组"
  - **规则抽取(fallback)**:简单正则覆盖高频 pattern("X 叫 Y" / "X 是 Y" / "X 喜欢 Y" 等),抽不到的退到 LLM
- `server.py` 写 memory 时 await 抽取 → 对每条 edge 先查 `(subject, predicate, valid_to IS NULL)`:
  - 命中且 object 相同 → 更新 weight(计数累加)/ `metadata_json.last_seen`,不插新行
  - 命中且 object 不同 → `UPDATE kg_edges SET valid_to=NOW() WHERE edge_id=旧` 关掉旧 fact + INSERT 新 edge(这样"老孟 → 孟哥 → 小明 → 小花" 的演化才能在时间轴上看)
  - 未命中 → INSERT 新 edge
- 文本层 `memory_records` 仍照常写(保留 raw provenance + 全文检索),但 `(subject, predicate, object)` 这种结构性事实**在图层 dedup**。

### B. Backfill 现有记忆 / Backfill existing memories

- 新 MCP 工具 `memory_backfill_kg(dry_run, batch_size)`:扫 `memory_records` 表,对每条 raw text 跑抽取,把结果写到 `kg_edges`(同样应用上面的 dedup 规则)。
- UI 加一次性按钮:"扫描历史记忆,建立知识图谱"。预计当前 51 条记录处理后压缩到 ~5 个 unique edge(`用户.name=小明`、`用户.also_known_as=孟哥`/`老孟`/`小花`、`用户.requested_rename=小明` 等)。

### C. UI 可视化:知识图谱视图 + flat list 共存 / KG visualization + flat list coexist

- 新 endpoint `GET /api/memory/graph?focus=<entity>&hops=<n>` 返回:
  ```json
  {
    "nodes": [{ "id": "用户", "label": "用户", "memoryCount": 12 }, ...],
    "edges": [{
      "id": "uuid",
      "subject": "用户", "predicate": "has_name", "object": "小明",
      "validFrom": "2026-04-23T...", "validTo": null,
      "weight": 3, "memoryIds": ["21391d5a", "d1bca491", ...]
    }, ...]
  }
  ```
- 前端 `apps/web/app/memory/page.tsx` 加两个 tab:
  - **图谱 · graph**(默认):用 [reactflow](https://reactflow.dev/) 或 [cytoscape.js](https://cytoscape.org/) 渲染力导向图。节点大小按 `memoryCount` 缩放。边带 predicate label,过期 fact(`validTo` 非 null)用虚线+灰色,hover 显示完整时间轴 + 关联的 raw memory_id 列表。点节点展开子图 / 在右抽屉看该节点的所有 fact + 全文证据。
  - **列表 · list**:保留现有 flat-list 视图作为 debug / 兜底入口。
- 整理活动可见:图谱 tab 顶部一行 "已整理 X 条 raw 为 Y 条 fact · [立即整理]" 按钮 + 弹出最近 consolidation log("11:23 把 12 条 '用户叫小明' raw 合并为 1 条 fact `用户.has_name=小明`",可点击看具体合并了哪些 memory_id)。

### D. 工具暴露 / Tool surface

- `memory_consolidate(dry_run=False)`:手动触发一次全量 consolidation,返回操作总结。
- `memory_audit_log(since=ts)`:返回最近的 consolidation 事件。
- `memory_graph(focus, hops)`:服务端版本,供 agent / 其他客户端使用,与 `/api/memory/graph` 同输出。
- `memory_backfill_kg(...)`:见 §B。

**实施位置 / Where to implement**:
- `providers/memory/src/quilin_mem/kg_extractor.py`(新)+ `server.py` 写路径接入
- `providers/memory/src/quilin_mem/consolidator.py` 已存在 —— 看现有逻辑,extend 而不是新建
- `apps/web/app/api/memory/graph/route.ts`(新)走 MCP 客户端
- `apps/web/app/memory/page.tsx` 加图谱 tab + reactflow 依赖

**English**: Rebuild the memory experience around the knowledge graph rather than bolting dedup onto the flat list. The backend already has a temporal-KG store (`TemporalKnowledgeGraph` in `providers/memory/src/quilin_mem/kg.py` with full `kg_edges(subject, predicate, object, valid_from, valid_to, memory_id, weight, ...)` schema and subgraph search), but **nothing currently writes to it** — `grep add_edge` returns zero callers. The 51 duplicate working-tier entries reflect that the write path stores raw text into `memory_records` without entity/relation extraction.

Three coordinated changes:
- **(A) Write path with extraction + temporal dedup**: a new `kg_extractor.py` (LLM-driven, rule-fallback) converts raw memory text into `KGEdge[]`. On write, look up `(subject, predicate, valid_to IS NULL)`: same object → bump weight; different object → close the old edge with `valid_to=NOW()` and insert the new one (so the "老孟 → 孟哥 → 小明 → 小花" rename history becomes a navigable timeline); none → insert. Raw text continues to land in `memory_records` for provenance and full-text search.
- **(B) Backfill**: `memory_backfill_kg` MCP tool runs the extractor over existing `memory_records` rows so today's duplicates collapse to a small fact set the moment the feature ships. UI exposes a "scan and build graph" button.
- **(C) UI visualization**: `/api/memory/graph?focus=<entity>&hops=<n>` returns `{ nodes, edges }`. The `/memory` page gets a `图谱 · graph` tab (default) using `reactflow` or `cytoscape.js`: node size by `memoryCount`, expired facts dashed/grey, hover shows the timeline and raw `memory_id` provenance, click opens a side drawer with full fact list and source text. A flat-list tab is kept as fallback. Consolidation activity is visible at the top: "compacted X raw → Y facts; [consolidate now]" plus a recent-events panel ("11:23 merged 12 '用户叫小明' rows into 1 fact").
- **(D) MCP tools exposed**: `memory_consolidate`, `memory_audit_log`, `memory_graph`, `memory_backfill_kg`.

This supersedes the original UX-4 ("dedup + flat-list consolidation log"). The original framing missed that the dedup target is **structural facts, not text rows**; flat-list dedup can't represent the rename timeline.

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

## UX-6 · 移动端左侧导航栏挡住主内容 / Mobile-viewport sidebar overlaps main content

**影响范围 / Scope**: `apps/web/app/layout.tsx` + 全局响应式样式(`apps/web/app/globals.css` 或对应 CSS Modules)。

**当前现状 / Current state (evidence)**: 用户在窄屏(疑似 iPhone 宽度 ~390px)截图显示导航栏(`会话 / 记忆 / 技能 / 服务 / 工具 / 配置`,纵向竖排)固定贴在左侧,**叠加在主内容之上**:
- `/sessions` 页:左侧导航把 "Sessions 会话" 标题前几字 + 时间戳 + 计数都遮住("…essions 会话" / "…话"...)
- `/`(首页):导航 rail 把页面左缘整片盖住,虽然 hero 标题在中央可见,但首屏 "Quilin 麒麟" 字母被截
- 用户原话:"每一个页面都被挡住了"

**期望 / Expected**:

- **断点策略 / Breakpoints**: 主内容容器(navigation rail 右侧的 main pane)在视口宽度 ≤ 640px 时主导航 rail 折叠成顶部 sticky 横向 bar,或左侧 drawer 默认收起。
- **方案 A · 顶部横向(推荐)**: 把竖直 rail 翻成 sticky `top` 上横向滚动条,只在窄屏(`@media (max-width: 640px)`)启用;桌面端保持现在的竖直 rail。每个导航项保留中文 + 英文标签,横向滑动可达。优点:无需 drawer 开关交互,主内容 100% 宽度可用。
- **方案 B · 可折叠 drawer**: 默认隐藏,顶部加汉堡按钮触发滑入 drawer。drawer 显示时覆盖主内容(全屏 overlay),点空白处关闭。优点:屏占用更小;缺点:多一次交互才能切换页面。
- **底部"安全区" / Bottom safe-area**: composer 已经做了固定底部,但要给底部 navbar(iOS Safari 的工具栏)留 `padding-bottom: env(safe-area-inset-bottom)`,否则发送按钮被遮。
- 顺手解决的: 顶部 banner 那一行 "v0.1.0-iter-f / session · — / light · 切换" 在窄屏挤一团,需要响应式收成两行或者只保留"切换主题"按钮加 menu。

**实施位置 / Where to implement**:

- `apps/web/app/layout.tsx` 找 `<aside>` / `<nav>` 或 `complementary "Quilin navigation rail"` 那个组件
- 加 `@media (max-width: 640px)` 切换布局,或用 Tailwind `sm:` / `md:` 断点
- 测试矩阵:iPhone SE 宽(375px)、iPhone 14 Pro(393px)、iPad mini portrait(768px)、桌面(1280+)
- E2E 测试:`apps/web/tests/e2e/responsive.spec.ts` 用 Playwright `page.setViewportSize({width: 390, height: 844})` 验证 `/sessions` 首屏所有元素可见且 nav 不重叠主内容

**English**: On narrow viewports (≤ 640px) the left navigation rail (`会话 / 记忆 / 技能 / 服务 / 工具 / 配置`) overlays the main content, hiding page titles and timestamps on `/sessions` and clipping the hero on `/`. User reports it across every page. Fix: at `@media (max-width: 640px)` switch the vertical rail to either (a) a sticky horizontal top bar (preferred — no drawer toggle, main content keeps full width) or (b) a collapsible drawer behind a hamburger. Also: respect `env(safe-area-inset-bottom)` so the composer's send button isn't covered by iOS Safari's toolbar, and reflow the top banner (`v0.1.0-iter-f / session / theme toggle`) which currently overruns. Test matrix: 375/393/768/1280+ widths, Playwright `responsive.spec.ts`.

---

## 优先级 / Priority

排序由 [Iter F web session 持久化](../09-deployment-runtime/web-session-persistence-spec.md) 和 [Iter F 交互 primitives](../07-safety-guardrails/interaction-primitives-spec.md) 完成后再开始这些。它们都没有 SSRF / jailbreak 级别的安全风险,但 UX-4(基于 KG 重做记忆)对长期可用性影响最大,UX-6(移动端导航遮挡)是用户日常用手机访问就直接被挡的硬阻塞,UX-3(旁白)对 Conversation Engineering(02.x 子模块)是前置依赖。

Suggested execution order after the two design-doc deliverables land:
1. **UX-6** (mobile sidebar overlap) — blocking all mobile users right now; fix is small and isolated
2. **UX-4** (KG-based memory rebuild) — long-term product viability; the largest single item (~7 person-days) but unblocks meaningful memory display
3. **UX-3** (aside channel) — ships with interaction-primitives spec, Conversation Engineering prerequisite
4. **UX-1** (tool-call header rewrite) — quick UX win
5. **UX-2** (consecutive-part merging) — quick UX win
6. **UX-5** (soul/profile viewer) — depends on (forthcoming) approval gate for the edit path
