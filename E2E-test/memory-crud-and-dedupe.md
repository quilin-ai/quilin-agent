# Memory CRUD + Dedupe — 端到端测试 / End-to-End Test Spec

> 适用于 `/memory` page 与 `quilin-mem` MCP 后端联调,覆盖记忆写入、读取、编辑、删除、智能整理(dedupe + kg-prune + reflect-insight)三类提案的完整人机回路。
>
> Covers the full `/memory` page round-trip against the `quilin-mem` MCP backend — write (LLM observer → `memory_store`), read (`GET /api/memory`), edit (per-record edit if available; otherwise tracked as a follow-up gap), delete (single + batch via `DELETE /api/memory?ids=`), and smart consolidation (`POST /api/memory/dedupe` returning `dedupe / kg-prune / reflect-insight` proposals).

## 0. 适用范围 / Scope

This spec is the single source of truth for end-to-end verification of memory features in the Quilin web UI. It is intentionally exhaustive — single-step CRUD plus the QUI-185/QUI-187 consolidation flow that turns ~9 semantically duplicated records (`老孟 / 孟哥 / 小明 / 小花` style) into 2-3 canonical ones.

本文档是 Quilin Web UI 记忆功能的端到端验证唯一权威源。覆盖范围有意做到详尽 — 单条 CRUD,加上 QUI-185 / QUI-187 智能整理流程(把语义重复的 ~9 条记忆,例如"老孟 / 孟哥 / 小明 / 小花"等,合并成 2-3 条规范记忆)。

### 0.1 测试模式 / Test Modes

There are two complementary execution modes for this spec:

本规范有两种互补的执行模式:

- **Mocked (offline)** — `apps/web/tests/e2e/memory-crud-and-dedupe.spec.ts` stubs `/api/memory` and `/api/memory/dedupe` via Playwright `page.route` so the UI flow is verified without booting the Python MCP backend. Runs in CI.
- **Live (online)** — Manual / scripted run against a real `quilin-mem` MCP server, used after `server.py` budget-gate changes. Verifies DB round-trip.

- **Mock 模式(离线)** — `apps/web/tests/e2e/memory-crud-and-dedupe.spec.ts` 通过 Playwright 的 `page.route` 拦截 `/api/memory` 和 `/api/memory/dedupe`,在不启动 Python MCP 后端的情况下验证 UI 流程。可在 CI 中运行。
- **Live 模式(在线)** — 针对真实 `quilin-mem` MCP 服务的手动/脚本运行,主要用在 `server.py` budget-gate 改动之后,验证数据库实际落地。

### 0.2 与已通过测试的关系 / Relation to Existing Tests

| 已有覆盖 / Existing | 范围 / Coverage | 本 spec 是否重复 / Overlap? |
|---|---|---|
| `tests/unit/app/memory-dedupe-route.test.ts` (vitest) | `POST /api/memory/dedupe` route 单元(wire parse + execute) | 不重复,本 spec 验证 **UI + 端到端** |
| `tests/e2e/memory-kg-tab.spec.ts` | `/memory` page 三个 tab(list / graph / timeline)的可达性 | 不重复,本 spec 验证 **list tab 内的 CRUD + dedupe** |
| `tests/e2e/chat-*` | `/` chat UI(send / queue / drain / watchdog) | 不重复,本 spec 引用 chat 仅作为"触发 memory_store 的入口" |

---

## 1. 前置条件 / Prerequisites

### 1.1 服务 / Services

| 组件 / Component | 启动方式 / Start | 端口 / Port |
|---|---|---|
| Next.js dev server | `cd apps/web && pnpm dev` 或 `next dev --turbopack -p 3000 -H 127.0.0.1` | 3000 |
| quilin-mem MCP server (live mode only) | `just dev-memory`(uv 启动 `providers/memory/src/quilin_mem/server.py`) | stdio |
| Agent core(产生 `memory_store` 调用) | `pnpm dev`(`packages/agent-core`),`POST /api/chat` 走 control-plane 触发 LLM observer | 3000(同 web) |

### 1.2 测试账号 / Test Identity

`/api/memory` 与 `/api/memory/dedupe` 当前不要求登录,使用浏览器默认 session。无需准备额外账号。

`/api/memory` and `/api/memory/dedupe` currently do not require login — use the default browser session. No additional accounts needed.

### 1.3 测试数据约定 / Seed Data Convention

For dedupe 9 → 2-3 testing, seed nine semantically-duplicated semantic-tier records via three personas:

为了测试"9 条合并到 2-3 条",通过三个人物各写 3 条语义重复的语义层记忆:

```
(persona: 老孟)
  - 老孟在凌晨 2 点处理紧急上线
  - 孟哥(老孟)昨晚 2am 处理 prod 故障
  - 老孟习惯凌晨工作,2 am 还在写代码

(persona: 小明)
  - 小明喜欢喝咖啡,下午 3 点必喝一杯
  - 小明每天下午都要喝咖啡
  - 小明咖啡成瘾,午后两点开始喝

(persona: 小花)
  - 小花喜欢加班到很晚
  - 小花经常 deep work 到深夜
  - 小花夜猫子,半夜还在干活
```

期望合并后 / Expected after consolidation:
```
- 老孟习惯凌晨工作(合并 3 → 1)
- 小明对咖啡的依赖(合并 3 → 1)
- 小花夜间深度工作模式(合并 3 → 1)
合计 9 → 3 条
```

---

## 2. 测试用例 / Test Cases

每个 case 含 5 段:**前置状态 / 操作 / 期望结果 / 实证方式 / 已知 follow-up**。
Each case contains: **precondition / action / expected / verification / known follow-up**.

---

### 2.1 写入 · 通过 chat 触发 `memory_store` / Write via chat triggering observer

#### 2.1.1 前置状态 / Precondition

- `/memory` page 当前显示 N 条记忆(N 可能为 0,也可能继承 dev DB)。
- Web `/` chat 已加载,输入框可见,quilin-mem MCP 连接已 ready(查 `/mcp` 状态,期望 `quilin-mem` 在线)。

- `/memory` page currently shows N records (may be 0, may inherit dev DB state).
- Web `/` chat is loaded, composer input visible, quilin-mem MCP connection ready (check `/mcp` — expect `quilin-mem` online).

#### 2.1.2 操作 / Action

1. 浏览器打开 `http://127.0.0.1:3000/`,在 composer 输入 `"请记住:老孟习惯凌晨工作"`,回车发送。
2. 等待 LLM 流式回复完成,期间 control-plane(`packages/agent-core/src/control-plane`)会通过 LLM observer 决策调用 `quilin-mem/memory_store` tool。
3. 跳转到 `/memory` page,等列表加载完成。

1. Open `http://127.0.0.1:3000/` in browser, type `"请记住:老孟习惯凌晨工作"` in composer, press enter.
2. Wait for the LLM stream to finish — during this window the control-plane LLM observer decides to call `quilin-mem/memory_store`.
3. Navigate to `/memory` page, wait for list to load.

#### 2.1.3 期望结果 / Expected

- `/memory` page 顶部 stats 计数从 N 增长到 N+1(或 N+K,如果 LLM 同时写入多条)。
- 新增记录出现在 `semantic` 或 `episodic` 层(具体由 observer 的 tier 决策决定)。
- 记录内容含关键词 `老孟` 或语义相关。

- `/memory` page top stats counter increases from N to N+1 (or N+K if multiple writes).
- New record appears under `semantic` or `episodic` tier (observer decides).
- Record content contains `老孟` keyword or is semantically related.

#### 2.1.4 实证方式 / Verification

```bash
# 1) 直接 curl API 看 raw wire shape
curl -s http://127.0.0.1:3000/api/memory | jq '.data.counts.total, .data.records[0:3]'

# 2) Playwright assertion
await expect(page.getByTestId(/^memory-/)).toHaveCount(/* >= N+1 */);
await expect(page.getByText("老孟习惯凌晨工作")).toBeVisible();

# 3) SQLite 直查(仅 live mode,跳过此步若用 MCP-only)
# 路径见 providers/memory/src/quilin_mem/config.py
sqlite3 ~/.quilin/memory.db "SELECT id, content, tier FROM memory WHERE deleted=0 ORDER BY created_at DESC LIMIT 3;"
```

#### 2.1.5 已知 follow-up / Known follow-up

- **GAP-1**:LLM observer 是否触发是非确定性的。如果用 GPT-5-mini 等小模型,可能跳过 `memory_store` 调用。Mock 模式下用 `page.route` 直接构造 record,Live 模式下可改用更明确的 prompt(例如 `"记住这条:..."`)提升触发率。
- **GAP-2**:`memory_store` 写入的 tier 不可预测,可能 `working` / `episodic` / `semantic` 任一。期望结果只断言"总数增长",不断言具体 tier。

---

### 2.2 读取 · `GET /api/memory` 拉全部 / Read via `GET /api/memory`

#### 2.2.1 前置状态 / Precondition

DB 中至少有 3 条不同 tier(`working` / `episodic` / `semantic`)的记忆。

DB has at least 3 records across different tiers (`working` / `episodic` / `semantic`).

#### 2.2.2 操作 / Action

1. 直接 `curl http://127.0.0.1:3000/api/memory`(API 测试)。
2. 或浏览器打开 `/memory`,观察 UI 渲染。

1. Either `curl http://127.0.0.1:3000/api/memory` (API check), or
2. open `/memory` in browser and observe rendering.

#### 2.2.3 期望结果 / Expected

API:
- HTTP 200,`{ ok: true, data: { available: true, records: [...], byTier: {...}, counts: {...} } }`。
- `counts.total === records.length`。
- 每条 record 满足 `{ id, content, tier, layer, createdAt, metadata }` 形状,`content` 非空。
- `byTier` key 按 `["working", "episodic", "semantic", "skill"]` 顺序展现的子集。

UI:
- `data-testid="memory-view"` 容器渲染。
- 顶部 stats 显示 `<strong>{total}</strong>条记忆` 和每个 tier 的计数。
- 列表按 tier 分段(每段含 `q-section-title`),每条记录有 `data-testid="memory-{id}"`。
- Filter 输入框 `data-testid="memory-filter"` 可见,tier 过滤按钮(全部 / 工作 / 情景 / 语义 / 技能)可见。

#### 2.2.4 实证方式 / Verification

```ts
// Playwright
const res = await page.request.get("/api/memory");
const body = await res.json();
expect(body.ok).toBe(true);
expect(body.data.available).toBe(true);
expect(body.data.counts.total).toBeGreaterThanOrEqual(3);

await page.goto("/memory");
await expect(page.getByTestId("memory-view")).toBeVisible();
await expect(page.getByTestId(/^memory-[^t]/)).not.toHaveCount(0); // 至少一条 record
```

```bash
# Filter 验证
curl -s http://127.0.0.1:3000/api/memory | jq '.data.byTier | keys'
# 期望: 至少包含 ["working", "episodic", "semantic"] 中的一些
```

#### 2.2.5 已知 follow-up / Known follow-up

- **GAP-3**:`rawSamplePreview` 字段(`route.ts:174`)只在 UI 不渲染未解析输出时有意义,目前 UI 没用它。属于死字段,可标 follow-up 删掉或接入。

---

### 2.3 编辑 · `/memory` 修改记忆内容 / Edit a memory record

#### 2.3.1 前置状态 / Precondition

`/memory` 列表至少有 1 条记忆。

`/memory` list has at least 1 record.

#### 2.3.2 操作 / Action

1. 点击某条记忆(`data-testid="memory-{id}"`)的 expand 按钮 — 这会展开 metadata。
2. 寻找 textarea / edit 入口。

1. Click on a record's expand button (`data-testid="memory-{id}"`) — this expands metadata.
2. Look for textarea / edit affordance.

#### 2.3.3 期望结果 / Expected

理想情况下:textarea 可编辑,保存按钮存在,点保存走 `PATCH /api/memory/{id}`(或类似)→ WriteAuthority gate → DB 更新 → 列表刷新。

Ideally: textarea editable, save button present, click save → `PATCH /api/memory/{id}` (or similar) → WriteAuthority gate → DB update → list refresh.

#### 2.3.4 实证方式 / Verification

```ts
// Playwright
const firstRecord = page.getByTestId(/^memory-/).first();
await firstRecord.click(); // expand
// 寻找 textarea
const textareaCount = await page.locator('textarea[data-testid^="memory-edit-"]').count();
// 寻找保存按钮
const saveButtonCount = await page.getByTestId(/^memory-edit-save-/).count();
```

#### 2.3.5 已知 follow-up / Known follow-up

**GAP-4(BLOCKING for "全部" 但非本 spec 的 critical bug)**:经检查 `apps/web/app/memory/page.tsx`(已读全文 1153 行),**当前 `/memory` page 没有 inline edit 入口**。

- 展开记忆只显示 metadata 的 JSON readonly preview(`<pre>` block),没有 textarea。
- 没有 `data-testid="memory-edit-*"` 系列。
- 没有 `PATCH /api/memory` 路由。

**Status**: NOT IMPLEMENTED. 用户指令明确要"如果没有标 follow-up",此处即标记为:

> **TODO**: 在 `/memory` page 上加 per-record inline edit(展开后显示 textarea + 保存按钮),保存路径走 `PATCH /api/memory/{id}` → `quilin-mem/memory_update` MCP tool → WriteAuthority gate(`origin: "user"`,non-CRITICAL,AUTO 模式下自动通过)。考虑作为新 Plane issue `QUI-edit-memory-ui`(假名,真正立 issue 时按 Plane 实际命名)。

When this lands, this section's verification block becomes:
```ts
const textarea = page.getByTestId(`memory-edit-textarea-${id}`);
await textarea.fill("更新后的内容");
await page.getByTestId(`memory-edit-save-${id}`).click();
await expect(page.getByTestId("memory-action-message")).toContainText("已更新");
await page.reload();
await expect(page.getByText("更新后的内容")).toBeVisible();
```

本 spec 在 GAP-4 上不阻塞其他 case 的执行。

---

### 2.4 单条删除 · 选中一条 + 顶部 sticky bar / Single delete via sticky bar

#### 2.4.1 前置状态 / Precondition

`/memory` 列表至少有 3 条记忆,记录目标记录的 id(例如 `target-id`)。

`/memory` list has at least 3 records; note the target id (e.g. `target-id`).

#### 2.4.2 操作 / Action

1. 找到目标记录的 checkbox `data-testid="memory-checkbox-{target-id}"`,点击勾选。
2. 顶部 sticky bar `data-testid="memory-action-bar"` 出现,显示 `已选 1 条`。
3. 点击 `data-testid="memory-batch-delete"` 按钮。
4. confirm dialog `data-testid="memory-confirm-delete"` 出现。
5. 点击 `data-testid="memory-confirm-delete-confirm"`。

1. Locate target row checkbox `data-testid="memory-checkbox-{target-id}"`, click to select.
2. Top sticky bar `data-testid="memory-action-bar"` appears showing `已选 1 条`.
3. Click `data-testid="memory-batch-delete"`.
4. Confirm dialog `data-testid="memory-confirm-delete"` appears.
5. Click `data-testid="memory-confirm-delete-confirm"`.

#### 2.4.3 期望结果 / Expected

- `DELETE /api/memory?ids={target-id}` 调用,返 `{ ok: true, data: { requested: 1, deleted: 1, failed: 0 } }`。
- UI 显示 action message `已删除 1 条`(`data-testid="memory-action-message"`)。
- 列表条数减 1,目标 `memory-{target-id}` 节点消失。
- `counts.total` 减 1。

- `DELETE /api/memory?ids={target-id}` returns `{ ok: true, data: { requested: 1, deleted: 1, failed: 0 } }`.
- UI shows action message `已删除 1 条` (`data-testid="memory-action-message"`).
- List count decreases by 1, target `memory-{target-id}` node gone.
- `counts.total` decreases by 1.

#### 2.4.4 实证方式 / Verification

```ts
const targetId = await page.getByTestId(/^memory-(?!view|filter|tab|action|batch|confirm|select|clear|dedupe|checkbox|selected)/).first().getAttribute("data-testid");
const id = targetId!.replace(/^memory-/, "");
const before = await page.getByTestId(/^memory-[a-z0-9-]+$/).count();

await page.getByTestId(`memory-checkbox-${id}`).click();
await expect(page.getByTestId("memory-action-bar")).toBeVisible();
await page.getByTestId("memory-batch-delete").click();
await expect(page.getByTestId("memory-confirm-delete")).toBeVisible();
await page.getByTestId("memory-confirm-delete-confirm").click();

await expect(page.getByTestId("memory-action-message")).toContainText("已删除");
await expect(page.getByTestId(`memory-${id}`)).toHaveCount(0);
```

#### 2.4.5 已知 follow-up / Known follow-up

- **GAP-5**:对 `synth:*` id 的删除会被 route.ts:273 pre-check 拒绝。如果选中的是合成 id,UI 应该显示明确文案。需在 verification 里增加 negative case。

---

### 2.5 批量删除 · 选中多条 / Batch delete N records

#### 2.5.1 前置状态 / Precondition

`/memory` 列表至少 5 条。

`/memory` list has at least 5 records.

#### 2.5.2 操作 / Action

1. 点击 `data-testid="memory-select-all"` 全选当前可见。
2. sticky bar 显示 `已选 N 条`(N 为当前可见条数)。
3. 点击 `memory-batch-delete` → confirm dialog → confirm。

1. Click `data-testid="memory-select-all"` to select all visible.
2. Sticky bar shows `已选 N 条` (where N = visible count).
3. Click `memory-batch-delete` → confirm dialog → confirm.

#### 2.5.3 期望结果 / Expected

- `DELETE /api/memory?ids=a,b,c,...` 调用,返 `{ ok: true, data: { requested: N, deleted: N, failed: 0 } }`。
- UI message `已删除 N 条`。
- 当前过滤范围内列表清空,显示 `没有匹配的记忆 · no matches` 或全空状态 `还没有任何记忆条目`。

- `DELETE /api/memory?ids=a,b,c,...` returns `{ ok: true, data: { requested: N, deleted: N, failed: 0 } }`.
- UI message `已删除 N 条`.
- List empties in current filter; either `没有匹配的记忆 · no matches` or all-empty `还没有任何记忆条目`.

#### 2.5.4 实证方式 / Verification

```ts
const before = await page.getByTestId(/^memory-[a-f0-9-]{4,}$/).count();
await page.getByTestId("memory-select-all").click();
await expect(page.getByTestId("memory-selected-count")).toHaveText(String(before));
await page.getByTestId("memory-batch-delete").click();
await page.getByTestId("memory-confirm-delete-confirm").click();
await expect(page.getByTestId("memory-action-message")).toContainText(`已删除 ${before}`);
```

#### 2.5.5 已知 follow-up / Known follow-up

- **GAP-6**:`MAX_BATCH_DELETE = 500`(`route.ts:29`),如果实际记忆超过 500 条,需走分页删除。当前 UI 没有 paginate,巨量 DB 会被截断。属于边界 follow-up,非阻塞。

---

### 2.6 智能整理 · preview / Dedupe preview (execute=false)

#### 2.6.1 前置状态 / Precondition

DB 已 seed §0.3 的 9 条语义重复记忆。`quilin-mem MCP` 暴露 `memory_consolidate_plan`(或老 `memory_dedupe_plan`)。

DB seeded with the 9 semantically-duplicated records from §0.3. `quilin-mem MCP` exposes `memory_consolidate_plan` (or legacy `memory_dedupe_plan`).

#### 2.6.2 操作 / Action

1. 打开 `/memory`。
2. 点击 `data-testid="memory-dedupe-button"`(`✨ 智能整理`)。
3. 等 preview modal 出现。

1. Open `/memory`.
2. Click `data-testid="memory-dedupe-button"` (`✨ 智能整理`).
3. Wait for preview modal.

#### 2.6.3 期望结果 / Expected

- `POST /api/memory/dedupe` body `{ execute: false }` 触发,返 200。
- Modal `data-testid="memory-dedupe-preview"` 渲染。
- 三个计数 testid:
  - `memory-dedupe-delete-count` ≥ 6(9 条合并到 3 条 → 删 6)
  - `memory-dedupe-keep-count` ≥ 3
  - `memory-dedupe-insert-count` ≥ 0(reflect-insight 可能 0 或多条)
- Proposals 列表 `data-testid="memory-dedupe-proposals"` 含 ≥ 1 个 `data-testid="memory-dedupe-proposal-dedupe"` 子节点。
- 可能含 `memory-dedupe-proposal-kg-prune` / `memory-dedupe-proposal-reflect-insight`(取决于 consolidator)。
- Confirm 按钮 `data-testid="memory-dedupe-confirm"` 可点。

- `POST /api/memory/dedupe` with `{ execute: false }` returns 200.
- Modal `data-testid="memory-dedupe-preview"` rendered.
- Three counter testids:
  - `memory-dedupe-delete-count` ≥ 6
  - `memory-dedupe-keep-count` ≥ 3
  - `memory-dedupe-insert-count` ≥ 0
- Proposals list contains ≥ 1 dedupe proposal.
- May also contain kg-prune / reflect-insight proposals.
- Confirm button clickable.

#### 2.6.4 实证方式 / Verification

```ts
await page.getByTestId("memory-dedupe-button").click();
const modal = page.getByTestId("memory-dedupe-preview");
await expect(modal).toBeVisible();
const deleteCount = Number(await modal.getByTestId("memory-dedupe-delete-count").textContent());
expect(deleteCount).toBeGreaterThanOrEqual(6);
const dedupeProposals = modal.getByTestId("memory-dedupe-proposal-dedupe");
await expect(dedupeProposals.first()).toBeVisible();
```

```bash
# API 直查
curl -s -X POST http://127.0.0.1:3000/api/memory/dedupe \
  -H 'content-type: application/json' \
  -d '{"execute":false}' | jq '.data.plan.totalDelete, .data.plan.proposals[0].kind'
# 期望: totalDelete >= 6, kind 出现 "dedupe"
```

#### 2.6.5 已知 follow-up / Known follow-up

- **GAP-7**:`memory_consolidate_plan` 的 embedding / llm 策略需要 OPENAI key。如果只跑 exact 策略,语义重复但字符串不同的"老孟 / 孟哥"不会合并。需 live 测试时确认 strategy 设置(`POST` body 可传 `strategy: "embedding"`)。
- **GAP-8**:`server.py` budget gate(用户主线正在改)可能让 plan 返空。如果 preview modal 显示 `将删除 0 条`,说明 gate 拦了 → 不是 frontend bug。

---

### 2.7 智能整理 · execute / Dedupe execute (execute=true)

#### 2.7.1 前置状态 / Precondition

§2.6 的 preview modal 已展开,显示 `totalDelete >= 6`。

§2.6 preview modal open, showing `totalDelete >= 6`.

#### 2.7.2 操作 / Action

1. 在 preview modal 中点击 `data-testid="memory-dedupe-confirm"`(`执行整理`)。
2. 等 modal 关闭,action message 更新。

1. Click `data-testid="memory-dedupe-confirm"` (`执行整理`) in preview modal.
2. Wait for modal to close, action message to update.

#### 2.7.3 期望结果 / Expected

- `POST /api/memory/dedupe` body `{ execute: true }`,返 200。
- 响应 `{ ok: true, data: { executed: true, deleted: 6, failed: 0, skippedInsert: K, plan: {...}, results: [...] } }`。
- 每个 result 含 `{ id, ok: true, kind: "dedupe" | "kg-prune", error: null }`。
- UI action message `已删除 6 条`(可能带 `· 新增 insight K 条已跳过(后端待接入)` 如果有 reflect-insight)。
- modal 关闭。
- 列表刷新,9 条相关记忆减到 3 条。

- `POST /api/memory/dedupe` with `{ execute: true }` returns 200.
- Response includes `executed: true, deleted: 6, failed: 0, skippedInsert: K`.
- Each result `{ id, ok: true, kind: "dedupe" | "kg-prune", error: null }`.
- UI action message `已删除 6 条` (possibly suffixed with skipped insight notice).
- Modal closes.
- List refreshes — 9 related records reduced to 3.

#### 2.7.4 实证方式 / Verification

```ts
await page.getByTestId("memory-dedupe-confirm").click();
await expect(page.getByTestId("memory-dedupe-preview")).toHaveCount(0);
await expect(page.getByTestId("memory-action-message")).toContainText("已删除");
// 列表减少
const after = await page.getByTestId(/^memory-[a-f0-9-]{4,}$/).count();
expect(after).toBeLessThanOrEqual(initialCount - 6);
```

```bash
# API 直查 — 关键验证 9 → 3
curl -s http://127.0.0.1:3000/api/memory | jq '.data.counts.total'
# 期望: 原来 9 条相关的 → 现在 ~3 条
```

#### 2.7.5 已知 follow-up / Known follow-up

- **GAP-9**:reflect-insight 类的 `insertContent` **当前 backend 跳过**(`route.ts:233`),`skippedInsert` 计数会增加。要等 `memory_insert` MCP tool 接入(用户已标记为 QUI-187 follow-up)。本 spec 只断言 `deleted` 而不断言 `insertContent` 实际写入。
- **GAP-10**:`memory_delete` 失败时(soft delete + FTS 移除)如果某条 id 不存在,会作为 idempotent no-op 计为 `ok: true`。不会被算到 `failed` 上。这是设计行为(`route.ts:13`)不是 bug。

---

### 2.8 空 store · 0 条记忆 / Empty store

#### 2.8.1 前置状态 / Precondition

DB 中 0 条记忆(或新 dev 环境,或全删后)。

DB has 0 records (fresh dev env or after full delete).

#### 2.8.2 操作 / Action

打开 `/memory`,观察渲染。

Open `/memory`, observe rendering.

#### 2.8.3 期望结果 / Expected

- API 返 `{ ok: true, data: { available: true, records: [], byTier: {}, counts: { total: 0 } } }`。
- UI 显示 `还没有任何记忆条目 · agent 写入后会显示在这里`。
- `memory-filter` / tier 过滤按钮 / `memory-dedupe-button` **不渲染**(因为整个 `<>` block 走空 branch)。

- API returns `{ ok: true, data: { available: true, records: [], byTier: {}, counts: { total: 0 } } }`.
- UI shows `还没有任何记忆条目 · agent 写入后会显示在这里`.
- Filter / tier buttons / dedupe button **not rendered** (empty branch).

#### 2.8.4 实证方式 / Verification

```ts
await page.route("**/api/memory", (route) => {
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      data: { available: true, records: [], byTier: {}, counts: { total: 0 } },
    }),
  });
});
await page.goto("/memory");
await expect(page.getByText("还没有任何记忆条目")).toBeVisible();
await expect(page.getByTestId("memory-dedupe-button")).toHaveCount(0);
```

---

### 2.9 错误处理 · MCP 未连接 / Error: MCP not connected

#### 2.9.1 前置状态 / Precondition

`quilin-mem` MCP server 未启动或不可达。Mock 模式下 stub `/api/memory` 返 `available: false`。

`quilin-mem` MCP server not running or unreachable. In mock mode, stub `/api/memory` to return `available: false`.

#### 2.9.2 操作 / Action

打开 `/memory`。

Open `/memory`.

#### 2.9.3 期望结果 / Expected

- 顶部 stats 显示 `quilin-mem 未连接`。
- 主区显示 `reason` 字段文本(`quilin-mem MCP server is not connected. ...`)。

- Top stats shows `quilin-mem 未连接`.
- Main area shows the `reason` text.

#### 2.9.4 实证方式 / Verification

```ts
await page.route("**/api/memory", (route) => {
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      data: {
        available: false,
        reason: "quilin-mem MCP server is not connected. Memory dashboard is unavailable.",
        records: [],
        byTier: {},
        counts: { total: 0 },
      },
    }),
  });
});
await page.goto("/memory");
await expect(page.getByText("quilin-mem 未连接")).toBeVisible();
```

---

### 2.10 错误处理 · dedupe 后端不可用 / Error: dedupe backend missing

#### 2.10.1 前置状态 / Precondition

`memory_consolidate_plan` 和 `memory_dedupe_plan` 都不可用,但 `memory_recall` 可用(list 渲染正常)。

`memory_consolidate_plan` AND `memory_dedupe_plan` both unavailable, but `memory_recall` works (list renders).

#### 2.10.2 操作 / Action

1. `/memory` 列表有数据。
2. 点击 `memory-dedupe-button`。

1. `/memory` list populated.
2. Click `memory-dedupe-button`.

#### 2.10.3 期望结果 / Expected

- `POST /api/memory/dedupe` 返 503 + `error.code === "memory_consolidate_plan_unavailable"`。
- UI message 显示 `智能整理预览失败 · quilin-mem MCP server is not connected...`。

- Returns 503 with `memory_consolidate_plan_unavailable` code.
- UI shows preview failure message.

#### 2.10.4 实证方式 / Verification

```ts
await page.route("**/api/memory/dedupe", (route) => {
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      ok: false,
      error: {
        code: "memory_consolidate_plan_unavailable",
        message: "quilin-mem MCP server is not connected, or memory_consolidate_plan/memory_dedupe_plan tool is missing.",
      },
    }),
  });
});
await page.getByTestId("memory-dedupe-button").click();
await expect(page.getByTestId("memory-action-message")).toContainText("智能整理预览失败");
```

---

## 3. 执行顺序 / Test Order

Recommended order — each case is independently isolated via route mocking, but for live mode the order matters:

推荐顺序 — 每个 case 通过 route mock 独立隔离;live 模式下顺序重要:

1. §2.2 read(确认基础渲染) → §2.8 empty store(顺路测) → §2.9 MCP 未连接(顺路测)
2. §2.1 write(通过 chat 触发,确认 DB 落地)
3. §2.4 single delete(从 §2.1 / 既有数据里挑一条)
4. §2.3 edit(若 GAP-4 不存在则正向测,若存在则只 assert 编辑入口缺失)
5. §2.6 dedupe preview → §2.7 dedupe execute(必须 seed §0.3 的 9 条数据)
6. §2.5 batch delete(收尾,清空 DB)
7. §2.10 dedupe error(独立 mock,不依赖顺序)

---

## 4. Playwright Spec 对应章节 / Mapping to Playwright Spec

| 文档 case / Doc case | Playwright test name |
|---|---|
| §2.2 | `renders memory list with records grouped by tier` |
| §2.4 | `single delete via checkbox + sticky bar + confirm dialog` |
| §2.5 | `batch delete via select-all` |
| §2.6 | `dedupe preview shows three proposal kinds` |
| §2.7 | `dedupe execute closes modal and refreshes list` |
| §2.8 | `empty store shows empty placeholder, hides dedupe button` |
| §2.9 | `MCP not connected shows reason banner` |
| §2.10 | `dedupe backend missing surfaces preview-failed message` |

§2.1 (chat 触发 memory_store)和 §2.3 (edit)需要 live MCP 才能验,因此不进入 mocked Playwright spec;在 live mode 时另以脚本(`scripts/e2e-memory-live.sh`,本 spec 未实现)或手动验证执行。

§2.1 (chat-triggered memory_store) and §2.3 (edit) require live MCP and so are NOT in the mocked spec — verify manually or via a future live script.

---

## 5. 跑测命令 / Commands

```bash
# 单跑本 spec(mocked)
cd apps/web && pnpm exec playwright test tests/e2e/memory-crud-and-dedupe.spec.ts

# Live 模式(指向已启动的 web + MCP)
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 \
  pnpm exec playwright test tests/e2e/memory-crud-and-dedupe.spec.ts

# headed 模式调试
pnpm exec playwright test tests/e2e/memory-crud-and-dedupe.spec.ts --headed
```

---

## 6. Follow-up 汇总 / Follow-up Summary

| ID | 描述 / Description | 阻塞性 / Blocking |
|---|---|---|
| GAP-1 | LLM observer 非确定性 → §2.1 不能稳定断言 | 否,Live 手测可绕过 |
| GAP-2 | 写入 tier 不可预测 → §2.1 不断言具体 tier | 否,文档已说明 |
| GAP-3 | `rawSamplePreview` 死字段 | 否 |
| **GAP-4** | **`/memory` 无 inline edit 入口** → §2.3 当前测试只能 assert 缺失 | **是(对 "全部 CRUD" 而言)**,需新 issue 实现 |
| GAP-5 | `synth:*` id 删除被 pre-check 拒绝 | 否,设计行为 |
| GAP-6 | `MAX_BATCH_DELETE = 500` 边界 | 否 |
| GAP-7 | dedupe 策略需要 embedding key | 否,可配 strategy |
| GAP-8 | server.py budget gate 可能让 plan 空 | 用户主线在改 |
| GAP-9 | reflect-insight `insertContent` 后端跳过 | 是(对 "全部功能" 而言),QUI-187 follow-up |
| GAP-10 | `memory_delete` idempotent no-op | 否,设计行为 |

---

## 7. v2 系统完整功能矩阵 / Full Feature Matrix(2026-05-21 单一权威源 / single SOT)

> 之前 `docs/03-memory/e2e-test-coverage.md` 的 43 测试点矩阵已 merge 进本文,本表是 Web 端记忆功能 e2e 测试的唯一权威来源。任何 memory 改动后跑 `apps/web/tests/e2e/memory-crud-and-dedupe.spec.ts`(canonical spec)即可。

### 7.1 测试文件清单 / Test Files

| 文件 | 范围 | 状态 |
|---|---|---|
| `apps/web/tests/e2e/memory-crud-and-dedupe.spec.ts` | **canonical** — CRUD + dedupe + v2 详情面板 + 4 tier 显示 + KG backfill 按钮 + timeline 翻译 + chat observer | ⏳ 整合中(Codex subagent 3 跑 verify)|
| `apps/web/tests/unit/app/memory-dedupe-route.test.ts` | dedupe wire 协议单测(QUI-208 sub-strategy 映射) | ✅ 14/14 PASS |
| `apps/web/tests/unit/app/memory-consolidations-route.test.ts` | consolidations normalizer(QUI-187 三类 proposal) | ✅ 6/6 PASS |

### 7.2 完整功能矩阵(7 类别 / 44 测试点)

#### 列表 / 浏览(6 点)
| # | 功能 | 状态 |
|---|---|---|
| 1 | `/memory` 页加载 + auth | ✅ test1 |
| 2 | 按 tier 分组渲染 | ✅ test1 |
| 3 | 每 tier 计数 + 标签 | ✅ test1 |
| 4 | **始终显示 4 个 tier(空层显说明)**(commit `3e4c84e`) | ✅ |
| 5 | tier filter dropdown | ✅ test5 |
| 6 | 空状态(无 records)显示 | ❌ 缺口 |

#### 详情面板(QUI-193/196/197 — commit `404fc77`)(12 点)
| # | 功能 | 状态 |
|---|---|---|
| 7 | 点击列表一条 → expand panel | ✅ test6 |
| 8 | `MemoryDetailPanel` 真渲染 | ✅ test6 |
| 9 | staleness marker(>30 天橙色 warning) | ✅ test6 |
| 10 | 6 维 salience 网格 | ✅ test6 |
| 11 | last_writer_client 显示 | ✅ test6 |
| 12 | project_scope 显示 | ✅ test6 |
| 13 | kind 显示 | ✅ test6 |
| 14 | importance_score 显示 | ✅ test6 |
| 15 | 版本链(version + parent_id + is_latest) | ⏳ Codex 主线接 v2 字段透出 |
| 16 | archived_at + recovered_at | ❌ 缺口 |
| 17 | 原始 metadata 折叠 | ✅ |
| 18 | **4 tier info icon hover popover**(commit `3a2d14e`) | ✅ |

#### 写入 / Memory Store(5 点)
| # | 功能 | 状态 |
|---|---|---|
| 19 | LLM 主动调 `memory_store` | ✅ dogfood 1 |
| 20 | 直接 API 注入 | ✅ test2 |
| 21 | SQLite 真落 row | ✅ test2 |
| 22 | **Web chat onFinish 触发 memory_store**(QUI-205 — commit `ca697d2`)| ⏳ subagent 3 verify |
| 23 | observer payload 含 `[user]: ... [assistant]: ...` | ⏳ |

#### 整理 / Consolidate(8 点)
| # | 功能 | 状态 |
|---|---|---|
| 24 | dedupe button 触发 | ✅ test3 |
| 25 | preview modal 弹出 | ✅ test3 |
| 26 | 3 种 proposals(dedupe / kg-prune / reflect-insight) | ❌ 缺口 |
| 27 | reflect-insight 字段保留(commit `acdcbc1`) | ✅ 单测 |
| 28 | dedupe execute 真合并 SQLite | ❌ 缺口 |
| 29 | strategy 协议兼容(sub → top,QUI-208) | ✅ 单测 |
| 30 | 大数据集 150+ records 不超 timeout(QUI-204) | ✅ Codex e2e verify |
| 31 | budget_exceeded → exact-only | ✅ pytest |

#### 删除 / 恢复(7 点)
| # | 功能 | 状态 |
|---|---|---|
| 32 | 单条删除按钮 | ✅ test4 |
| 33 | confirm dialog | ✅ test4 |
| 34 | 软删 + archived_at 落 | ✅ test4 |
| 35 | 批量 + select-all | ✅ test5 |
| 36 | tier filter + select-all 交互 | ✅ test5 |
| 37 | 删除后 list 不显示 | ✅ test4 |
| 38 | recover API 7 天 round trip | ❌ 缺口 |

#### 视图切换(5 点)
| # | 功能 | 状态 |
|---|---|---|
| 39 | tab "list"(默认) | ✅ test1 |
| 40 | tab "graph"(KG view) | ❌ 缺口 |
| 41 | **KG empty state "立即灌入" 按钮**(commit `ca697d2`)| ✅ |
| 42 | tab "timeline" 切换 | ❌ 缺口 |
| 43 | **timeline 友好翻译**(commit `ca697d2`,no JSON dump)| ✅ |

#### Observer 自动反思链路(QUI-202)(2 点)
| # | 功能 | 状态 |
|---|---|---|
| 44 | memory_observations 真写(直调 MCP) | ✅ dogfood 2(commit `c087330`)|
| 45 | quilin-daemon 4 job 真触发 backend(reflect / consolidate / kg / token)| ⏳ subagent wire |

### 7.3 当前覆盖率 / Coverage Stats

| 类别 | 已 ✅ | 部分 ⏳ | 缺口 ❌ | 总数 |
|---|---|---|---|---|
| 列表 / 浏览 | 5 | 0 | 1 | 6 |
| 详情面板 | 10 | 1 | 1 | 12 |
| 写入 | 3 | 2 | 0 | 5 |
| 整理 / dedupe | 6 | 0 | 2 | 8 |
| 删除 / 恢复 | 6 | 0 | 1 | 7 |
| 视图切换 | 3 | 0 | 2 | 5 |
| Observer 链路 | 1 | 1 | 0 | 2 |
| **总计** | **34 ✅ + 4 ⏳** | | **7 ❌** | **45** |

**当前覆盖率 ≈ 84%**。Codex subagent 3 跑完 verify 后 → 90%+。

### 7.4 固定 Playwright 执行命令(以后任何 memory 改动跑一遍)

```bash
# === 1. 起 backend(quilin-mem MCP server)===
cd providers/memory
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-sk-xxx}" uv run python -m quilin_mem > /tmp/qm.log 2>&1 &
QM_PID=$!
sleep 3

# === 2. 起 Web dev server ===
cd /Users/raysonmeng/repo/quilin-agent/apps/web
lsof -i :3000 -t | xargs -r kill -9 2>/dev/null
pnpm dev > /tmp/web.log 2>&1 &
WEB_PID=$!
sleep 12
curl -s http://localhost:3000/memory -o /dev/null -w "HTTP %{http_code}\n"

# === 3. 跑 canonical spec(覆盖 45 测试点)===
cd /Users/raysonmeng/repo/quilin-agent
pnpm --filter web exec playwright test apps/web/tests/e2e/memory-crud-and-dedupe.spec.ts

# === 4. 清理 ===
kill $QM_PID $WEB_PID 2>/dev/null
```

### 7.5 7 个 e2e 缺口 follow-up Plane

每个缺口 1 Plane issue,优先级:

**高优先级(用户体验直接相关)**:
1. dedupe execute 真合并(test 30 但 plan only,真 confirm 合并没跑)
2. recover API 真 round trip(7 天窗口)
3. 3 种 proposals UI 真区分(dedupe / kg-prune / reflect-insight)

**中优先级**:
4. tab "graph" 切换 + reactflow 真渲染
5. tab "timeline" 切换 + consolidation_log 真显示

**低优先级**:
6. 空状态 UI
7. archived_at + recovered_at 详情面板显示

由 Codex subagent 2 立 Plane follow-up(待报告)。

### 7.6 与原 §1-§6 关系

§1-§6:CRUD + dedupe 单条 / 9→2-3 整理流程 — 历史细节深 spec(2026-05-19 初版)。
§7:v2 系统完整功能矩阵 — 2026-05-21 dogfood + user 反馈后整合的最新状态。

两者**互补不冲突**:跑 e2e 时按 §7.4 命令执行 canonical spec,覆盖 §7.2 表里的 45 点;§1-§6 的 9→2-3 细节场景仍是 dedupe 部分的真实数据 seed 来源。

---
