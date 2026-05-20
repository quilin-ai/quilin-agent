# QUI-196 多客户端 + 项目范围 / Multi-Client + Project Scope

> **Status**: 📋 Planned(等 QUI-195 schema ship 后启动)
> **Plane**: QUI-196
> **Estimate**: 原估 3 联合日,实测预测 1.5-2 小时(10-15x 加速)
> **Dependencies**: QUI-193 ship(version chain)+ QUI-195 ship(archived_at schema)

## 背景 / Background

调研发现:**几乎所有 agent memory 系统都不面对"4 端共享记忆"问题**(只跑服务端单 user)。Quilin 跑 CLI / REPL TUI / Web / Mac App 4 端共享同一个 `~/.quilin/memory.db`,**这是麒麟独有的机会也是独有的责任**。

When two clients edit the same memory record concurrently, we must surface the conflict to the user instead of silently last-writer-wins. We also need to weight retrieval by current project scope (cwd + QUILIN.md).

## Scope

### 1. Schema additions(additive,backwards-compatible)

`memory_records` 加 3 个字段:
- `last_writer_client` TEXT NULL(取值:`cli` / `repl` / `web` / `mac-app` / `mcp-other`)
- `last_writer_session_id` TEXT NULL(具体 session identifier)
- `project_scope` TEXT NULL(归属项目,从 cwd + QUILIN.md 解析)

不加新表(项目元数据通过 metadata JSON + 上面 3 字段足够)。

### 2. Conflict detection + merge

- `memory_update(id, ...)` 写入前 SELECT `last_writer_*`,如果当前 caller client ≠ DB 现存 + 时间窗(默认 30s)内 → 触发 conflict
- Conflict 不阻塞写入,而是:
  - 标 `metadata["conflict_resolution_pending"] = true`
  - 创建 supersede 事件保留两个版本(走 QUI-193 supersede chain)
  - 通过 `memory_conflicts` MCP tool 暴露给 client 让用户决策

### 3. Project scope retrieval weighting

- `MemoryRetriever.recall(query, task_context)` 内,从 `task_context["cwd"]` 解析当前项目
- 项目内 records score boost(默认 +0.15)
- 跨项目 records score penalty(-0.05)
- 通过 env `QUILIN_PROJECT_SCOPE_WEIGHT_BOOST` / `_PENALTY` 覆盖

### 4. QUILIN.md ingestion

- 启动时扫 cwd / git root 的 `QUILIN.md`,作为项目级 system prompt 注入
- 解析 frontmatter 取 `project_id`(默认 `git_root` hash)
- 写入新 record 时自动填 `project_scope`

## 实现路径

### 必改文件

- `providers/memory/src/quilin_mem/store_schema.py` additive migration(3 字段)
- `providers/memory/src/quilin_mem/store_records.py` insert 接 3 字段
- `providers/memory/src/quilin_mem/store.py` 加 `_detect_conflict` + `list_conflicts()` API
- `providers/memory/src/quilin_mem/retriever.py` recall 内加 project scope weighting
- `providers/memory/src/quilin_mem/server.py` 新 MCP tool `memory_conflicts` + `memory_resolve_conflict`
- 新 `providers/memory/src/quilin_mem/project_scope.py`(QUILIN.md ingestion + cwd → project_scope 解析)

### 不动文件

- TS 客户端 0 修改(client 通过 metadata 自报 `last_writer_client`)
- `apps/web/app/memory/page.tsx` 可后续加 conflict UI(独立 follow-up,不阻塞)

## 测试要求

新 `providers/memory/tests/test_multi_client_conflict.py` 8+ pytest case:
- conflict 检测:CLI write → 30s 内 Web write → 触发 conflict
- 30s 窗口外不触发
- 同 client 二次 write 不触发
- conflict 时 supersede chain 保留两个版本
- project_scope retrieval 加权(同项目 boost / 跨项目 penalty)
- QUILIN.md ingestion 解析 project_id
- migration idempotent
- `list_conflicts(user_id)` 返 pending 列表

## 验收

1. 4 个 client 并发写不丢数据(supersede 保留两版)
2. project_scope retrieval 同项目 score boost,跨项目 penalty
3. cross-review 2 fresh × 0 REAL × 2
4. 现有 ~580 pytest 不回归
5. coverage ≥ 95%
6. TS 客户端 0 修改

## 关联

- `docs/03-memory/README.md` v2 Roadmap
- 调研 §5.5 多客户端 + 项目范围
- Plane QUI-196
- 依赖:QUI-193(supersede chain)+ QUI-195(archived_at,冲突 archive 路径)
