# Web 会话 SQLite 持久化设计 / Web Session SQLite Persistence Design

> 状态:Design / Pre-implementation gate · Iter F deliverable
> 优先级提升来源:用户指令 2026-05-13(`localStorage` 清缓存即丢的真实场景反馈)
> 关联待办:`deployment-runtime-deferred-plan.md` § "Web 会话持久化优先级提升"

> Status: Design / Pre-implementation gate · Iter F deliverable
> Priority bump trigger: user directive 2026-05-13 — real-world `localStorage` data-loss on cache clear
> Related backlog: `deployment-runtime-deferred-plan.md` § "Web Session Persistence Priority Bump"

---

## 1. 背景与动机 / Background & Motivation

English: Today the web frontend (`apps/web`) persists conversation history exclusively in browser `localStorage`. This survives a page reload and a process restart but is lost on cache clear, incognito mode, browser switch, device switch, or hostile cookie cleanup. The `/sessions` page is therefore not a stable inventory of past work — it is a per-browser cache that the user can wipe accidentally.

中文:目前 web 前端(`apps/web`)只把对话历史存在浏览器 `localStorage`。这种存储跨页面刷新和进程重启会保留,但**清缓存 / 隐身模式 / 换浏览器 / 换设备 / cookie 清理工具一刷就丢**。`/sessions` 页因此不是一份稳定的历史清单 —— 它是一份用户可能不小心就清掉的浏览器缓存。

English: The backend `AgentService` keeps live runner state in Node-process memory (Iter F baseline). A process restart drops both the runner and any session metadata the backend held. The product therefore has zero durable storage of conversation history outside the client's local browser. This is a product-level data-loss bug for any user who switches devices or clears caches.

中文:后端 `AgentService` 把活跃 runner 状态保存在 Node 进程内存里(Iter F 基线)。进程重启时 runner 和后端持有的 session 元数据都丢。整个产品在客户端本地浏览器之外**没有任何持久化的对话历史存储**。任何换设备 / 清缓存的用户都会撞上产品级的数据丢失。

English: The fix is to introduce a single-server SQLite store (`sessions.db`) that is the source of truth for: (a) which sessions exist, (b) the message history of each session, (c) optional metadata (title, timestamps). The browser `localStorage` keeps its current role as a write-through cache for fast initial render.

中文:解决办法是在单机部署下引入一份 SQLite 文件 `sessions.db`,把它作为以下三件事的真相源:(a) 有哪些 session、(b) 每个 session 的消息历史、(c) 可选元数据(标题、时间戳)。浏览器 `localStorage` 保留为写穿透缓存,负责首屏渲染加速。

---

## 2. 范围 / Scope

### In scope(本 spec 必交付)

English:
1. SQLite schema for sessions and messages tables.
2. `/api/chat` POST handler writes every user message and every finalized assistant message to SQLite.
3. New `GET /api/sessions` and `GET /api/sessions/<id>` endpoints reading from SQLite.
4. New `DELETE /api/sessions/<id>` endpoint that wipes the row.
5. Reconnect after server restart: `/api/chat` finds session in SQLite by `id`, replays history into the freshly-created AgentService runner.
6. Cross-browser visibility: `/sessions` page reads the SQLite-backed endpoint, augmenting (not replacing) localStorage for users who arrive from a different browser.
7. Migration path: existing localStorage users' history is uploaded to SQLite on first POST after upgrade.
8. Single-server topology (one Node process owns the DB file).
9. Test plan covering write, read, restart-recovery, delete, migration, concurrency.

中文:
1. sessions 表和 messages 表的 SQLite schema。
2. `/api/chat` POST 处理时把每条 user message 和每条完成的 assistant message 写到 SQLite。
3. 新的 `GET /api/sessions` 和 `GET /api/sessions/<id>` endpoint 从 SQLite 读。
4. 新的 `DELETE /api/sessions/<id>` endpoint 直接删表行。
5. 服务端重启后的重连:`/api/chat` 按 `id` 在 SQLite 里查 session,把历史 replay 进新创建的 AgentService runner。
6. 跨浏览器可见:`/sessions` 页从 SQLite 端读,补全(不替代)从其他浏览器进来的用户的本地缓存。
7. 迁移路径:升级后的第一次 POST 把现有 localStorage 用户的历史上传到 SQLite。
8. 单机部署(一个 Node 进程独占数据库文件)。
9. 测试计划覆盖写入、读取、重启恢复、删除、迁移、并发。

### Out of scope(本 spec 明确不做,留 backlog)

English:
- Multi-server / horizontal scaling (Postgres / D1 / Turso). The architecture is a single Node process owning `sessions.db` directly via `better-sqlite3`. Multi-server is documented in `deployment-runtime-deferred-plan.md` as future work.
- Cross-device user-level sync (would require auth + cloud sync). Iter F assumes single-server / single-user.
- Encryption at rest for the SQLite file (defer to OS / disk-level FDE).
- Vector-search over message history (memory layer's job, not session-store's).
- Tool-call / event-stream replay fidelity. We store **finalized messages**, not raw `streamText().fullStream` chunks. Re-running a session from a checkpoint mid-stream is not a goal.

中文:
- 多服务器 / 水平扩展(Postgres / D1 / Turso)。架构上是单 Node 进程通过 `better-sqlite3` 独占 `sessions.db`。多服务器的方案在 `deployment-runtime-deferred-plan.md` 里另行规划。
- 跨设备的用户级同步(需要认证 + 云端同步)。Iter F 保持单服务器 / 单用户假设。
- SQLite 文件磁盘加密(交给 OS / 磁盘级 FDE 解决)。
- 消息历史的向量检索(那是记忆层的活,不是 session store 的活)。
- 工具调用 / event-stream 的回放保真度。我们只存**完成态的消息**,不存原始 `streamText().fullStream` chunk。中流 checkpoint 重启不在目标内。

---

## 3. Schema / Schema

English: The DB has two tables. Sessions hold metadata; messages hold the actual conversation rows. Foreign key with `ON DELETE CASCADE` so deleting a session row purges its messages atomically.

中文:数据库两张表。sessions 存元数据,messages 存对话行。外键带 `ON DELETE CASCADE`,删 session 自动清掉它的消息。

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;  -- Concurrent read while one writer

CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,             -- sessionId, e.g. 'draft-mp406k7d' or 'a1-1747...'
    title         TEXT,                          -- nullable; derived from first user message if empty
    created_at    INTEGER NOT NULL,              -- unix ms
    updated_at    INTEGER NOT NULL,              -- unix ms; bumped on every message write
    origin        TEXT NOT NULL DEFAULT 'web',   -- 'web' | 'tui' | 'admin'
    epoch         INTEGER NOT NULL DEFAULT 0,    -- matches AgentService session.epoch on insert
    deleted_at    INTEGER                         -- nullable; soft-delete tombstone
);

CREATE INDEX idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_deleted_at ON sessions(deleted_at)
  WHERE deleted_at IS NOT NULL;  -- partial index for purge job

CREATE TABLE messages (
    id            TEXT PRIMARY KEY,              -- UIMessage.id (assigned by useChat / API)
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,              -- monotonic per-session position
    role          TEXT NOT NULL,                 -- 'user' | 'assistant' | 'system'
    parts_json    TEXT NOT NULL,                 -- JSON.stringify(UIMessage.parts)
    created_at    INTEGER NOT NULL,
    finalized_at  INTEGER,                       -- nullable; set when stream done
    UNIQUE(session_id, seq)
);

CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);
```

English: `parts_json` is the serialized AI SDK v6 `UIMessage.parts` array — the same wire shape `useChat` consumes. This lets reconnect rehydration push the array directly into the new chat session without per-part transformation. Schema migrations live in `apps/web/lib/sessions-db/migrations/NNNN-*.sql` and run on process start.

中文:`parts_json` 存的就是 AI SDK v6 `UIMessage.parts` 数组序列化后的字符串 —— 跟 `useChat` 消费的 wire 形状一模一样。重连水合时把数组直接灌进新 chat session 不用 per-part 转换。schema 迁移文件放在 `apps/web/lib/sessions-db/migrations/NNNN-*.sql`,进程启动时跑。

---

## 4. 写入路径 / Write Path

### 4.1 用户消息(user message)/ User message

English: When `/api/chat` POST handler receives a request with `body.messages`, the **last** entry is the new user message (older entries are already-persisted history). The handler:

1. Acquires SQLite transaction.
2. UPSERTs the session row (`sessions.id = body.id`, sets `updated_at = now`).
3. INSERTs the new user message into `messages` (if `messages.id` doesn't already exist for that session).
4. Commits.

中文:`/api/chat` POST 收到带 `body.messages` 的请求时,数组**最后一条**是新的 user message(前面那些是已经持久化的历史)。handler:

1. 开 SQLite 事务。
2. UPSERT session 行(`sessions.id = body.id`,`updated_at = now`)。
3. INSERT 新 user message 到 `messages`(如果该 session 下还没有这个 `messages.id`)。
4. 提交。

English: This must happen **before** `streamText` starts, so a slow LLM response never loses the user's prompt. If SQLite write fails (disk full, lock contention), the request fails with HTTP 503 and the client retries — we never accept a user message we can't durably store.

中文:这必须在 `streamText` 启动**之前**做完,这样即使 LLM 响应慢也不会丢用户的 prompt。SQLite 写失败(磁盘满 / 锁竞争)直接返回 HTTP 503 让客户端重试 —— 不接受任何写不进去的 user message。

### 4.2 助手消息(assistant message)/ Assistant message

English: The assistant message persists in three stages:

1. **Start** — when `streamText` emits `text-start` / `tool-input-available` / etc., insert a `messages` row with `parts_json = "[]"` and `finalized_at = NULL`. Subsequent deltas update the same row.
2. **In-flight updates** — debounce updates to every ~500ms or on `step-finish` boundaries. We don't write every text-delta (too noisy); we snapshot the parts array at safe points.
3. **Finalize** — on `finish` event, write the final `parts_json` and set `finalized_at = now`.

中文:assistant message 分三步持久化:

1. **开始** —— `streamText` 发出 `text-start` / `tool-input-available` 等事件时,插入一条 `messages` 行,`parts_json = "[]"` 且 `finalized_at = NULL`。后续 delta 更新这同一行。
2. **中流更新** —— 每 500ms 或 `step-finish` 边界 debounce 一次。不每条 text-delta 都写(太吵);在安全点 snapshot parts 数组。
3. **完成** —— `finish` 事件时写最终的 `parts_json` 并设 `finalized_at = now`。

English: If the process crashes mid-stream, the last persisted snapshot is whatever the most recent debounced write captured. On restart, the partial message is visible to `/sessions` as a finalized-but-truncated row (since the stream never completed, the agent's response just stops mid-sentence). This is acceptable degradation; the user sees the partial answer and can ask again.

中文:进程中流崩了的话,持久化的就是最近那次 debounce 写到磁盘的快照。重启后这条半截消息在 `/sessions` 里看就是一条"完成但被截断"的行(因为流没跑完,agent 的回答就停在半句话上)。可以接受的降级;用户看到半截答案再问一次就行。

### 4.3 并发与锁 / Concurrency & Locking

English: `better-sqlite3` is synchronous and single-process. WAL mode allows concurrent reads while one writer holds the write lock. Two browser tabs of the same user posting to `/api/chat` simultaneously serialize at the SQLite level, but each tab has its own sessionId so they don't fight for the same row.

中文:`better-sqlite3` 是同步的、单进程的。WAL 模式允许多读 + 一写。同一用户两个 tab 同时 POST `/api/chat` 时在 SQLite 层串行化,但每个 tab 自己的 sessionId 不同所以不会争同一行。

English: Edge case: user reloads the page mid-stream (same sessionId). The handler sees `(sessionId, messagesHash)` match → reconnect to live runner. SQLite writes from the live runner continue against the same row; the reloaded tab subscribes to the event stream. **No double-write happens** because only the runner writes; the client just reads via the subscription.

中文:边界:用户中流刷新页面(同 sessionId)。handler 看到 `(sessionId, messagesHash)` 匹配 → reconnect 到活的 runner。来自活 runner 的 SQLite 写继续打在同一行;刷新后的 tab 订阅 event 流。**不会双写** —— 只有 runner 写,客户端只通过订阅读。

---

## 5. 读取路径 / Read Path

### 5.1 列表 / List

English: `GET /api/sessions` returns up to 100 rows ordered by `updated_at DESC`, with `?limit=N&offset=M` for pagination. Each row carries `{ id, title, created_at, updated_at, message_count, last_user_message_preview }`. Title defaults to the first 60 chars of the earliest user message if `title` is null.

中文:`GET /api/sessions` 默认返回最多 100 行按 `updated_at DESC` 排,带 `?limit=N&offset=M` 分页。每行 `{ id, title, created_at, updated_at, message_count, last_user_message_preview }`。`title` 为空时取最早 user message 前 60 字。

### 5.2 单 session 历史 / Single session history

English: `GET /api/sessions/<id>` returns `{ id, title, messages: UIMessage[] }`. The messages array is reconstructed by mapping each `messages` row's `parts_json` back into a `UIMessage` object. This is what the `/?session=<id>` page initialization consumes.

中文:`GET /api/sessions/<id>` 返回 `{ id, title, messages: UIMessage[] }`。messages 数组通过把每行的 `parts_json` 还原成 `UIMessage` 对象拼出来。`/?session=<id>` 页面初始化时就调这个。

### 5.3 / sessions 页面 / `/sessions` page

English: The page issues a single `GET /api/sessions` and merges results with localStorage. When the two sources disagree (e.g. a session exists in SQLite but not localStorage), the SQLite row wins and gets cached into localStorage. This provides cross-browser visibility while keeping fast first-render via the cache.

中文:页面发一次 `GET /api/sessions` 并和 localStorage 合并。两边不一致时(比如 SQLite 有这条但 localStorage 没有)以 SQLite 为准,顺便缓回 localStorage。这样跨浏览器可见的同时还能用缓存做首屏加速。

---

## 6. 重启后重连 / Restart Recovery

English: When the Node process restarts, AgentService memory is empty. The next `/api/chat` POST with a previously-existing `id` triggers this flow:

1. Handler looks up `sessions.id` in SQLite. Found → load `messages` rows.
2. Handler creates a fresh AgentService session with the recovered history pre-populated.
3. Compute `messagesHash` on `body.messages` (which includes the new user message).
4. If hash matches a hypothetical re-attached runner: there is no live runner (process restarted), so this branch never fires after restart — we always start fresh.
5. Run `streamText` with `messages = [...recovered, ...new_user_message]` as the conversation context.
6. Response carries the new `X-Quilin-Epoch` header reflecting the post-restart epoch.

中文:Node 进程重启后 AgentService 内存空了。下一次 `/api/chat` POST 带个旧的 `id` 触发这条流程:

1. Handler 在 SQLite 里查 `sessions.id`。命中 → 读 `messages` 行。
2. Handler 创建一个新 AgentService session 并把恢复出来的历史预先灌好。
3. 在 `body.messages`(已经包含新 user message)上算 `messagesHash`。
4. 假设性的"重连到活 runner":进程刚重启没有活 runner,所以重启后这条分支永不命中 —— 一律 fresh-start。
5. 跑 `streamText`,`messages = [...恢复的历史, ...新的 user message]` 作对话上下文。
6. 响应头带新的 `X-Quilin-Epoch` 反映重启后的 epoch。

English: The client detects epoch mismatch via the existing strict-epoch handshake (already shipped in route.ts) and refreshes its cached state. Visually, the user sees their entire history seamlessly because the LLM was given the same context.

中文:客户端通过现有的 strict-epoch handshake(route.ts 里已经在 ship 的逻辑)检测到 epoch 不一致,刷新缓存状态。视觉上用户看到的是完整历史无缝衔接,因为 LLM 拿到的是同一份上下文。

---

## 7. 删除 / Delete

English: `DELETE /api/sessions/<id>` performs a hard delete:

1. SQLite transaction:`DELETE FROM sessions WHERE id = ?` (cascade purges messages).
2. AgentService:if a live runner exists for this id, abort + evict.
3. localStorage:the client clears its own cache row.

中文:`DELETE /api/sessions/<id>` 硬删:

1. SQLite 事务:`DELETE FROM sessions WHERE id = ?`(级联清掉 messages)。
2. AgentService:有活 runner 就 abort + evict。
3. localStorage:客户端自己清掉缓存行。

English: Soft delete (`deleted_at`) is reserved for a future "trash / undelete" UX that this spec does not deliver. The column is included in the schema now so we don't migrate later.

中文:软删(`deleted_at`)留给未来的"回收站 / 撤销删除"UX,本 spec 不交付。schema 里现在就放好这列以免之后再迁。

---

## 8. localStorage 迁移 / localStorage Migration

English: First-time POST after upgrade: the client includes a special header `X-Quilin-Migrate-LocalStorage: true` if it detects local history rows that have no SQLite counterpart yet. The server reads `body.messages`, persists each as it would in the write path, and returns `X-Quilin-Migrated: <count>` so the client knows the migration succeeded. After confirmation, the client marks those rows as "synced" and stops sending the migrate header.

中文:升级后第一次 POST:客户端检测到本地有但 SQLite 还没有的历史行时,带 header `X-Quilin-Migrate-LocalStorage: true`。服务端读 `body.messages`,按 write path 持久化每一条,返回 `X-Quilin-Migrated: <count>` 告诉客户端迁移成功了。客户端确认后给那些行打"已同步"标记,后续不再带 migrate header。

English: This avoids a separate migration UI and works incrementally — sessions get persisted when the user next interacts with them, not in a one-shot batch on upgrade.

中文:省掉单独的迁移 UI,改成渐进式 —— 用户下次和某个 session 交互时再持久化它,不在升级时一次性批量跑。

---

## 9. 测试计划 / Test Plan

| # | 场景 / Scenario | 验收 / Acceptance |
|---|---|---|
| T1 | 新 session, 1 user message → POST → 重启 → /sessions/<id> 读 | Returns the persisted user message |
| T2 | 同上 + LLM 回复完成 | finalized_at set, parts_json complete |
| T3 | 进程中流崩溃 | Partial parts_json persisted; row visible in /sessions |
| T4 | 删除 session | Both sessions and messages rows gone; live runner aborted |
| T5 | 两个 tab 同 sessionId 同时 POST | One runs, other reconnects via hash; no double-write |
| T6 | 两个 tab 不同 sessionId 同时 POST | Both succeed in parallel; SQLite WAL handles |
| T7 | localStorage 迁移 | First POST with migrate header persists all local sessions; X-Quilin-Migrated header returned |
| T8 | 跨浏览器访问 | Open /sessions in Firefox after using Chrome; Firefox sees all Chrome sessions |
| T9 | 大消息(>1MB parts_json) | Write succeeds; read succeeds; UI renders without overflow |
| T10 | 100 个 session,每个 50 条消息 | /sessions list returns in <200ms; single-session GET <100ms |
| T11 | SQLite 文件不可写(权限错 / 磁盘满) | POST returns HTTP 503 with clear error; client retry policy kicks in |
| T12 | 删除一个有活 runner 的 session | Runner gets aborted; subscribers receive cancellation event |

English: Tests live in `apps/web/tests/integration/sessions-db.spec.ts` (jest/vitest with a temp `:memory:` SQLite for fast isolation) plus end-to-end coverage in `apps/web/tests/e2e/sessions-persistence.spec.ts` (Playwright spanning restart simulation).

中文:测试在 `apps/web/tests/integration/sessions-db.spec.ts`(jest/vitest,临时 `:memory:` SQLite 跑得快又隔离)外加 `apps/web/tests/e2e/sessions-persistence.spec.ts`(Playwright 含重启模拟)。

---

## 10. 风险与已知约束 / Risks & Known Constraints

English:
- **Single-server only.** `better-sqlite3` opens the DB file with an exclusive write lock. Multi-process deployments need to migrate to Postgres / Turso / Cloudflare D1; the schema is portable but the connection layer must change.
- **No encryption.** The DB file holds plaintext conversation history. Deployment must rely on OS / disk-level FDE, not application-level crypto. Document this in the install guide.
- **WAL files.** SQLite WAL mode produces `sessions.db-wal` and `sessions.db-shm` alongside the main DB. Backups must include all three.
- **Vercel serverless.** This design assumes a long-lived Node process with file-system access. Pure serverless (Vercel functions, Cloudflare Workers) does NOT support `better-sqlite3` — the multi-server slice in `deployment-runtime-deferred-plan.md` covers that case.
- **Memory pressure.** Large message-history reconstruction (T9 above) loads all `parts_json` into memory. For sessions with hundreds of long messages this could be ~10MB per read. Acceptable for now; pagination on `/api/sessions/<id>?after=<seq>` is a deferred optimization.

中文:
- **只支持单机部署。** `better-sqlite3` 用独占写锁打开 DB 文件。多进程部署得换 Postgres / Turso / Cloudflare D1;schema 可移植但连接层得改。
- **不加密。** DB 文件存的是明文对话历史。靠 OS / 磁盘级 FDE 保护,不在应用层做加密。install guide 里要明说。
- **WAL 文件。** SQLite WAL 模式产生 `sessions.db-wal` 和 `sessions.db-shm` 两个旁文件。备份必须三个都带。
- **Vercel serverless 不行。** 这个设计假设有长期运行的 Node 进程 + 文件系统访问。纯 serverless(Vercel functions、Cloudflare Workers)不支持 `better-sqlite3` —— 那种情况走 `deployment-runtime-deferred-plan.md` 里的多服务器分支。
- **内存压力。** 大消息历史的重建(上面 T9)会把所有 `parts_json` 读进内存。几百条长消息的 session 可能 ~10MB / 读。当前可接受;`/api/sessions/<id>?after=<seq>` 的分页是延后优化。

---

## 11. 实施排期(切片建议) / Implementation Slicing

### Slice 1 — Schema + write path(~2 day)

- DB module: `apps/web/lib/sessions-db/index.ts`(connection + migration runner)
- Schema migration 0001
- `/api/chat` POST writes user + assistant rows
- Tests T1 + T2

**已知限制 / Known limitation:** Fresh-start path on a reused `sessionId`
(same browser, second prompt overwriting the first via `evictSession`)
does not delete or merge the prior turn's rows from SQLite. Multiple
`role='user'` rows for the same session are expected at this slice.
Slice 2 read endpoints render them as separate historical entries;
Slice 3's `DELETE /api/sessions/<id>` provides the bulk cleanup path,
and Slice 4's reconnect-recovery may add per-turn dedup.

**Known limitation:** Fresh-start re-using a `sessionId` (second prompt
in the same browser tab) leaves the previous turn's rows in SQLite. The
GET endpoints in Slice 2 will surface these as historical entries
without filtering. Slice 3's `DELETE` covers cleanup; Slice 4 may add
per-turn dedup.

### Slice 2 — Read path + UI integration(~2 day)

- `GET /api/sessions`, `GET /api/sessions/<id>`
- `/sessions` page reads SQLite, merges with localStorage
- Tests T7 + T8 + T10

### Slice 3 — Restart recovery + delete(~1 day)

- `/api/chat` history rehydration after restart
- `DELETE /api/sessions/<id>`
- Tests T3 + T4 + T12

### Slice 4 — Concurrency + migration(~1 day)

- Multi-tab POST handling
- localStorage migration header round-trip
- Tests T5 + T6 + T11

Cumulative: ~6 person-days. Each slice ships behind a feature flag (`QUILIN_WEB_PERSISTENCE=on/off`) so a regression in any slice can be flipped off without rolling back the deploy.

累计 ~6 人天。每个切片走 feature flag (`QUILIN_WEB_PERSISTENCE=on/off`),任一切片出回归可以关掉而不必回滚部署。

---

## 12. 验收门槛 / Acceptance Gate

English: Implementation is "done" only when:
1. All 12 tests in §9 pass.
2. Cross-review loop closes (2 fresh reviewers, 0 REAL each — per project rule).
3. `docs/STATUS.md` updated to mark Iter F session persistence as landed.
4. Install guide documents the SQLite file location, backup story, and the "no encryption" limitation.
5. UI shows a Settings → "Storage location" entry that links to the DB file path (debug aid).

中文:实现"完成"只在以下都满足时:
1. §9 的 12 个测试全过。
2. Cross-review loop 收敛(2 个新 reviewer, 各 0 REAL —— 项目硬规则)。
3. `docs/STATUS.md` 更新标记 Iter F session 持久化已落地。
4. install guide 写明 SQLite 文件位置、备份方式、"不加密"这一限制。
5. UI 在"设置 → 存储位置"加一行链接到 DB 文件路径(debug 辅助)。
