# 完美记忆系统 v2 进度同步 / Perfect Memory v2 Progress Sync

This note records the local evidence needed to synchronize Plane after the 2026-05-21 Codex-only continuation. The current Codex toolset does not expose Plane MCP tools, so this file is the source text for the next Plane-capable session to paste into work item comments/status updates.

本文记录 2026-05-21 Codex 单独接管后的本地实证，用于后续同步 Plane。当前 Codex 工具集中没有暴露 Plane MCP 工具，因此本文件是下一次具备 Plane 工具的 session 可直接粘贴到工单 comment / status update 的来源文本。

## 已提交批次 / Committed Batch

Commit `2a392e1` landed the converged backend batch for the memory v2 roadmap.

Commit `2a392e1` 已提交完美记忆系统 v2 的一批后端收敛改动。

Included scope:

包含范围：

- QUI-195 destructive guard: 72h soft delete, recover path, destructive preview, history snapshot integration, expired/deleted retrieval filtering.
- QUI-195 破坏防护：72 小时软删除、撤销路径、破坏性操作预览、历史快照集成、过期 / 删除检索过滤。
- QUI-188 quilin-daemon backend: job registry, lease, heartbeat, retry/backoff, budget guard, responsive shutdown cancellation.
- QUI-188 quilin-daemon 后端：任务注册、租约、心跳、重试 / 退避、预算门、可响应 shutdown cancellation。
- QUI-22 follow-up: working-to-episodic promotion commit is atomic under the SQLite store lock and no longer double-promotes under concurrency.
- QUI-22 follow-up：working→episodic promotion commit 在 SQLite store lock 内原子执行，并发下不再 double-promote。
- QUI-197 support slice: `MemoryKind` validation, strict JSON for salience/resource metadata, invalid schema fallback, structured fields preserved through retrieval rebuilds.
- QUI-197 支撑切片：`MemoryKind` 校验、salience/resource metadata strict JSON、invalid schema fallback、retrieval rebuild 保留 structured fields。
- QUI-198 support slice: trajectory compressor / skill proposer feedback parsing fixes for mixed negative and positive Chinese feedback.
- QUI-198 支撑切片：trajectory compressor / skill proposer 修复中文正负混合反馈解析。
- QUI-199 support slice: prospective/resource metadata can be stored and recalled through `memory_store` / `memory_recall`.
- QUI-199 支撑切片：prospective/resource metadata 可通过 `memory_store` / `memory_recall` 存取。

Verification:

实证：

- `cd providers/memory && DEEPSEEK_API_KEY= QUILIN_OBSERVER_API_KEY= QUILIN_ENV=test uv run pytest -q` → `723 passed`, coverage `95.21%`.
- `cd providers/memory && DEEPSEEK_API_KEY= QUILIN_OBSERVER_API_KEY= QUILIN_ENV=test uv run pytest -q` → `723 passed`，coverage `95.21%`。
- `cd providers/memory && DEEPSEEK_API_KEY= QUILIN_OBSERVER_API_KEY= QUILIN_ENV=test uv run pytest -q --no-cov` → `723 passed`.
- `cd providers/memory && DEEPSEEK_API_KEY= QUILIN_OBSERVER_API_KEY= QUILIN_ENV=test uv run pytest -q --no-cov` → `723 passed`。
- `ruff check` and `ruff format --check` passed on touched provider files.
- touched provider files 的 `ruff check` 与 `ruff format --check` 均通过。
- Targeted mypy passed on the 10 source files owned by the batch.
- 本批次 owned 的 10 个 source files targeted mypy 通过。
- Fresh cross-reviewers C and D both reported `0 REAL / 0 SUSPECT`.
- 两个 fresh cross-reviewer C/D 均报告 `0 REAL / 0 SUSPECT`。

Suggested Plane updates:

建议 Plane 更新：

- QUI-195: move to Done after confirming commit `2a392e1` is pushed/visible.
- QUI-195：确认 commit `2a392e1` 已 push / 可见后移到 Done。
- QUI-188: mark backend daemon slice Done; keep any packaging / launchd / PM2 production wrapper as follow-up only if acceptance requires deployment wiring beyond Python backend.
- QUI-188：后端 daemon slice 标 Done；如 acceptance 要求 Python 后端以外的 launchd / PM2 生产包装，则另留 follow-up。
- QUI-22: add comment that promotion atomicity / rollback / FTS orphan fixes shipped in `2a392e1`.
- QUI-22：追加 comment，说明 promotion atomicity / rollback / FTS orphan fix 已在 `2a392e1` ship。
- QUI-197 / QUI-198 / QUI-199: add comments that support slices landed, but keep open for the remaining acceptance items listed below.
- QUI-197 / QUI-198 / QUI-199：追加 comment，说明支撑切片已落地，但保留 open 直到下列剩余 acceptance 完成。

## 当前并行任务 / Active Parallel Tasks

Six implementation workers are active because the current subagent tool hit its thread limit before the requested 8 workers.

当前 subagent 工具在线程上限处挡住了第 7 / 8 个 worker，因此实际已启动 6 个实现 worker。

- QUI-196: multi-client + project scope.
- QUI-196：多客户端 + 项目范围。
- QUI-200: SQLite-backed SafetyLessonStore.
- QUI-200：SQLite-backed SafetyLessonStore。
- QUI-190: temporal-aware dedupe completion.
- QUI-190：temporal-aware dedupe 补齐。
- QUI-197: salience ranking integration.
- QUI-197：多维重要性检索排序集成。
- QUI-199: prospective scheduler/resource backend APIs.
- QUI-199：前瞻记忆 scheduler / resource 后端 API。
- QUI-81: Soul Import 6-framework scanner backend.
- QUI-81：灵魂导入 6 框架 scanner 后端。

The main Codex thread owns docs/status/Plane-sync text while those workers run.

这些 worker 运行期间，Codex 主线程负责 docs/status/Plane-sync 文本。

## 仍未完成 / Remaining Acceptance

QUI-196 still needs project-scoped conflict policy, per-client receipts, filter/query exposure, and tests.

QUI-196 仍需完成 project-scoped conflict policy、per-client receipts、filter/query 暴露和测试。

QUI-197 still needs salience to affect retrieval/rerank behavior, not only storage and validation.

QUI-197 仍需让 salience 真正影响 retrieval / rerank，而不只是存储和校验。

QUI-199 still needs due-list / snooze / done / cancel backend semantics and resource pointer validation. Web visualization remains separate unless explicitly assigned.

QUI-199 仍需 due-list / snooze / done / cancel 后端语义和 resource pointer 校验。Web 可视化除非明确分配，否则保持独立。

QUI-200 still needs persistent lessons and retrieval safety gate integration.

QUI-200 仍需持久化 lessons 和 retrieval safety gate 集成。

QUI-190 still needs temporal-aware dedupe behavior on top of the evidence/version fields that already shipped.

QUI-190 仍需在已 ship 的 evidence/version 字段之上补齐 temporal-aware dedupe 行为。

QUI-81 still needs full install-time six-framework scanning; QUI-186 only shipped first-run prompt/profile plumbing.

QUI-81 仍需完整安装期六框架扫描；QUI-186 只 ship 了 first-run prompt/profile 接入。
