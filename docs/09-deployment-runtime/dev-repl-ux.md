# 开发 REPL 的 UX 协议 / Dev REPL UX Protocol

> 验收文档 for QUI-141。本文档把 dev REPL 三件 UX 改动（trailing newline、channel split、log volume defaults）固化下来，避免后续被悄悄 regress。
>
> Acceptance doc for QUI-141. This file pins the three dev-REPL UX changes (trailing newline, channel split, log volume defaults) so future regressions are visible.

---

## 上下文 / Context

2026-05-08 用户用 `just dev` 真实评估 web tools 时发现三个 UX 问题。三个症状全部集中在 "用户用 REPL 跟 agent 对话" 的核心路径上，互相独立但同时影响日常使用体感。

On 2026-05-08, real-world evaluation of web tools via `just dev` surfaced three independent dev-REPL UX issues — all on the core "converse with agent in REPL" path, each independently degrading daily-use ergonomics.

---

## Symptom A — 回答末尾换行 / Reply trailing newline

**现象 / Symptom**: agent 输出 markdown 内容流式打到 stdout 后没有换行，下一条 stderr 上的 logger 输出会紧贴着回答末尾打印。

After streaming markdown reply to stdout, no `\n` was emitted; the next stderr logger line printed flush against the reply's last character.

**修复 / Fix**: commit `e4aee47` `fix(repl): finalize agent reply stream with trailing newline (QUI-141 A)`. `finalizeStreamRender` 钩子在 loop.ts:306（最终 message）与 :392（每个 tool-call round）都被触发；用 `lastTextEndedWithNewline` flag 跟踪最后一个字节，仅当 reply 实际写过 text 且最后字节不是 `\n` 时才 emit `\n`。flag 在 fire 之后立即重置，避免多 round 触发携带 stale 状态。

The `finalizeStreamRender` hook fires both at loop.ts:306 (final assistant message) and :392 (each tool-call round). A `lastTextEndedWithNewline` flag tracks the last byte; finalize emits `\n` only when reply actually wrote text AND last byte is not `\n`. Flags reset after firing so multi-round tool calls don't carry stale state.

**Regression-locked by**: `packages/agent-core/src/repl.test.ts` 中针对 `finalizeStreamRender` 的多 round 单测。

---

## Symptom B — Channel split: reply 与 operational 分流 / Reply / operational channel split

**现象 / Symptom**: 历史上 readline prompt + reply text 都走 stderr，让 `just dev 2>/tmp/log` 把 prompt 也吸走，REPL 看起来卡死。

Historically the readline prompt + reply text both went to `stderr`. Running `just dev 2>/tmp/log` swallowed the prompt and the REPL appeared frozen.

**修复 / Fix**: commit `1fcb05e` `fix(repl): split reply content from operational stderr (QUI-141 B)`。改成 channel split:

The fix reroutes by channel:

| 内容 / Content | 通道 / Channel | 理由 / Rationale |
| --- | --- | --- |
| LLM `text` deltas (回答正文 / reply body) | **stdout** | 用户对话内容，期望 pipe 时被捕获 / user-facing reply, pipe-capturable |
| `readline` prompt + 输入 echo | **stdout** | 与 reply 同流，便于 capture / co-located with reply |
| Slash-help block + cursor manipulation | **stdout** | 与 readline 同流避免 cursor 漂移 / co-located so cursor doesn't drift |
| Banner / `Bye!` / slash-command output | **stderr** | 控制 surface / control surface |
| Tool icons (`🔧 calling`, `✅`, `⚠️`) | **stderr** | 操作 surface / operational surface |
| pino logger 输出 | **stderr** | 日志通道 / log channel |
| `reasoning` verbose mode | **stderr** | debug surface — `2>` 重定向时丢失是 debug-by-design / debug surface; loss under `2>` is intentional |
| Error messages | **stderr** | 错误通道 / error channel |

`getTerminalColumns` fallback 链改成 `stdout.columns ?? stderr.columns ?? 80`，让 wrap 数学跟随实际渲染 surface。

`getTerminalColumns` falls back `stdout.columns ?? stderr.columns ?? 80` so wrap math tracks the actual rendering surface.

**测试更新 / Test updates**: `setProcessTty` 助手扩展同时 flip stdout TTY；slash-help install guard `stdin.isTTY && stdout.isTTY` 对应测试 setup。

**Regression-locked by**: `repl.test.ts` 中显式 `stdoutWriteSpy` vs `stderrWriteSpy` 断言（line 2800 区域），以及 `slash-help install` guard 测试。

---

## Symptom C — Log volume 默认 / Log volume defaults

**现象 / Symptom**: `just dev` 历史默认 `LOG_LEVEL=debug`，每个 LLM call 5-7 条 INFO 日志加 idle-evolution / MCP server stderr forwarding 把对话淹没。

Historically `just dev` defaulted to `LOG_LEVEL=debug`, producing 5-7 INFO log lines per LLM call plus idle-evolution / MCP stderr forwarding that drowned the conversation.

**当前状态 / Current state**: justfile 所有 dev-\* recipe 都接受 `log` 参数 (default `"info"`)，并支持别名:

The justfile dev-\* recipes all accept a `log` parameter (default `"info"`) with friendly aliases:

| 别名 / Alias | 实际 LOG_LEVEL |
| --- | --- |
| `quiet` | `silent` |
| `info` (default) | `info` |
| `verbose` | `debug` |
| 任何 pino 原始值 / any pino raw value | passed through (silent / fatal / error / warn / info / debug / trace) |

涉及 recipe / Recipes covered:

- `just dev` / `just dev-once` / `just dev-yolo` / `just dev-ask` / `just dev-resume` — 默认 `info`，需要 verbose 时 `just dev-yolo verbose`
- `just dev-quiet` / `just dev-debug` — 兼容别名，`quiet` 等于 `silent`，`debug` 等于 `verbose`

> `dev-memory` / `dev-web` / `dev-debug-svc` 等仍硬编码 `LOG_LEVEL=debug`：这些是单组件调试入口，作者主动选择 verbose，不归 REPL 默认。
>
> `dev-memory` / `dev-web` / `dev-debug-svc` are still hard-coded `LOG_LEVEL=debug`: those are single-component debug entries the author opted into; not part of the REPL default.

---

## 协议 / Protocol

未来如果要新增 dev-\* recipe，遵守:

When adding a future dev-\* recipe, follow:

1. **Default `info`** — 不再硬编码 `debug` 给 user-facing entry；如果是 single-component debug entry（如 `dev-memory`）可硬编码 `debug` 但要在注释里说明动机。
2. **Reply on stdout, ops on stderr** — 任何在 REPL 渲染面 (loop / context / memory) 的输出，按 Symptom B 表分流；不要把 reply text 混到 stderr。
3. **Trailing newline 必须 finalize** — 任何流式输出最后一段（包括 tool-call rounds）走 `finalizeStreamRender` 钩子。
4. **Pipe-redirect 友好** — 任何新加的 dev recipe 都应该满足 `just <recipe> 2>/tmp/log` 时 prompt 仍可见、reply 仍打印。

1. **Default `info`** — never hard-code `debug` for a user-facing entry; single-component debug entries (e.g. `dev-memory`) may hard-code, but justify in comments.
2. **Reply on stdout, ops on stderr** — any output on the REPL render surface (loop / context / memory) routes per the Symptom B table above; never mix reply text into stderr.
3. **Trailing newline must finalize** — any streaming output end (including tool-call rounds) goes through the `finalizeStreamRender` hook.
4. **Pipe-redirect friendly** — any new dev recipe must keep the prompt visible and reply printing when the user runs `just <recipe> 2>/tmp/log`.

---

## 验收清单 / Acceptance checklist

- ✅ Symptom A — `e4aee47` + `repl.test.ts` `finalizeStreamRender` 多 round 单测
- ✅ Symptom B — `1fcb05e` + `repl.test.ts` `stdoutWriteSpy` 断言 + slash-help install guard
- ✅ Symptom C — justfile 所有 dev-\* recipe 默认 `info`（统一 3-tier 控制）
- ✅ docs/09-deployment-runtime/dev-repl-ux.md (本文件)

QUI-141 全部验收完成。/ All QUI-141 acceptance items closed.

---

## 关联 / References

- QUI-141 Linear issue: <https://linear.app/quilin-agent/issue/QUI-141>
- 触发 trajectory: 2026-05-08 真实 REPL 测试 web tools (`docs/05-tool/e2e-2026-05-08-web-tools.md`)
- Cross-review provenance: VA + VB cross-review of `1fcb05e`, both 0 real
- 相关 RECOMMEND backlog: QUI-149 (本周 cross-review 留下的 polish backlog)
