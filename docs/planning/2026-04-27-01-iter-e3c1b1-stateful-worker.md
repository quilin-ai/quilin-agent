# Iter E3c1b1 — BFCL multi-turn Python stateful runtime worker MVP + TS thin adapter

> **状态**: Day 0 ready（spike + reassessment + E3c1b spike 已 commit；待启动）
> **日期**: 2026-04-27
> **owner**: Quilin Agent 团队
> **前置**:
> - E3a CLOSED ✅（commit `bc9e008`，R5 Faraday）
> - E3b CLOSED ✅（commit `5c5ca2a`，R2 Schrödinger）
> - E3c1a CLOSED ✅（commit `767e049`，R2 Pauli）
> - Roadmap reassessment ✅（commit `b338e03`）
> - E3c1 spike ✅（commit `0b6638e`）
> - E3c1b spike ✅（commit `717436d`）

---

## 0. 实证基线

### 0.1 入场状态（HEAD `717436d`）

- 分支 `master`；工作树 clean（除自动 coverage 产物）
- E3a + E3b + E3c1a review chains 全闭合
- benchmarks 测试基线：335 passed / 1 skipped；Branch 95.00 / Lines 97.87（双入口）
- `just test-all` 三语言绿；AMB 100k p95 0.219ms
- DockerSandbox MVP 稳定；E3c1a Python checker bundle + mpmath wheel 落地

### 0.2 进度记录区

| 轮次 | 任务 | 状态 | commit | 实证 |
|---|---|---|---|---|
| Day 0 spike (E3c1b 整体) | 拆 E3c1b1 + E3c1b2 决议 | ✅ closed | `717436d` | 303 行；reject generic runner / MCP / OmniMem state / E3c2 合并 |
| Day 0 plan (E3c1b1) | 本 plan + worker contract 冻结 | 🔄 本轮 | — | — |
| Iter E3c1b1 first-cut | Python stateful worker + TS thin adapter（不接 LLM）| ⏳ 待启动 | — | 长 session lifecycle + backend state 跨 turn 保留 |
| Iter E3c1b1 R1 review | R1 独立 subagent (新名字) | ⏳ 待启动 | — | first-cut 后 |
| Iter E3c1b1 R1 fix（如需）| 按 R1 finding 修复 | ⏳ 待启动 | — | review 后 |
| Iter E3c1b1 收口 | review chain 闭合 + 95% 覆盖率 + just test-all 三语言绿 | ⏳ 待启动 | — | review 通过后 |

E3c1b2（BFCL-specific runner adapter）独立 sub-iter，不在本 plan 范围。

---

## 1. 当前共识（spike 已锁定）

- **范围**：E3c1b1 = **Python stateful runtime worker + TS thin adapter** ONLY
  - Python worker：long-session DockerSandbox-spawnable，stdin JSONL 接收 tool-call → 执行 BFCL backend object 方法 → stdout JSONL 返 result + state snapshot
  - TS adapter：spawn / heartbeat / SIGINT-SIGTERM forward / lifecycle
  - **不接 injected runAgent**（E3c1b2）
  - **不处理 holdout turn / dynamic tools**（E3c1b2）
  - **不接 BFCL checker scorer**（E3c1a 已落，E3c1b2 复用）
- **Worker contract（spike 决议）**：
  - 长 session：per-task spawn 一次 Python worker → 多次 tool-call → close
  - stdin JSONL：`{type: "call", tool: "GorillaFileSystem.cd", args: {...}}` / `{type: "snapshot"}` / `{type: "close"}`
  - stdout JSONL：`{type: "result", value: ..., error?: ...}` / `{type: "snapshot", state: {...}}` / `{type: "closed"}`
  - 错误：worker 不 exit-0 catch-all（吸取 E3c1a R1 BLOCKING-1 教训），按 `error_type` 区分
  - 安全：DockerSandbox 内执行（`execute_multi_turn_func_call` 含 `eval`，host 禁运）
- **8 backend classes 支持**：GorillaFileSystem / Twitter / Ticket / Message / Math / Vehicle / Trading / Travel（pinned f7cf735）
- **不支持**：WebSearchAPI / MemoryAPI（E3c2/E4 范围；E3c1b1 worker 显式 reject）
- **复用，不新增**：BFCL checker bundle（已 E3c1a 落 mpmath wheel + multi_turn_eval/）+ DockerSandbox + cache + lockfile

---

## 2. 不做事项

- 不在 Iter E3c1b1 接 injected runAgent / LLM（→ E3c1b2）
- 不处理 BFCL holdout turn / dynamic tools（→ E3c1b2）
- 不接 BFCL checker scorer（→ E3c1b2，复用 E3c1a Python adapter）
- 不实现 multi-turn submission（→ E3c1b2，复用 E3c1a multi-file adapter）
- 不实现 web_search / memory_* backend（→ E3c2/E4）
- 不动 generic runner.ts / DockerSandbox 顶层契约 / cache.ts / wire schema / submission registry / scorer registry
- 不引入 OmniMem 4 层（→ Iter F）

---

## 3. Iter E3c1b1 第一轮任务

| 轨道 | 范围 | 写边界 |
|---|---|---|
| **Boyle-mt** Python worker | `benchmarks/scripts/bfcl-stateful-worker.py` + tests via TS adapter | 仅 `benchmarks/scripts/bfcl-stateful-worker.py` |
| **Hilbert-mt2** TS thin adapter | `benchmarks/src/runtime/bfcl-stateful-runtime.ts` + tests | `benchmarks/src/runtime/bfcl-stateful-runtime*` |
| **Pasteur-mt2** runtime contract test | `benchmarks/src/runtime/bfcl-stateful-runtime.test.ts` | 同上 |

跨轨道同步点：

| 同步点 | 内容 |
|---|---|
| S-e3c1b1-jsonl | stdin/stdout JSONL 协议固定（`{type, tool?, args?, value?, error?, state?}`）；与 E3c1a checker subprocess 同模式 |
| S-e3c1b1-error-type | worker error_type 分类：`backend_class_not_found` / `tool_method_not_found` / `tool_args_invalid` / `tool_runtime_error` / `eval_security_violation`；TS adapter 区分 throw vs return |
| S-e3c1b1-cleanup | TS adapter SIGINT/SIGTERM forward + child exit deregister（沿用 E3c1a R1 fix 模式） |
| S-e3c1b1-timeout | worker 单 tool-call timeout（默认 10s）；session-level idle timeout（默认 60s）|

---

## 4. 节奏估算

| 阶段 | 轮数 | 备注 |
|---|---|---|
| Day 0 spike (E3c1b 整体) | 1 | 已 land `717436d` |
| Day 0 plan（本 plan）| 1 | 本轮 |
| Iter E3c1b1 第一轮（3 模块顺序）| 1-2 | Worker + TS adapter 较紧密耦合；不并行 |
| Iter E3c1b1 R1 review + fix（按经验）| 1-2 | review chain |
| Iter E3c1b1 收口 | 1 | 全实证 |
| **Iter E3c1b1 总计** | **4-6 轮** | 与 E3c1a 同节奏 |

---

## 5. 验收

### Iter E3c1b1 硬验收

- [ ] Python worker 长 session 单 task：spawn → 3+ 次 tool-call（state 跨 turn 保留）→ snapshot → close
- [ ] TS adapter API 完整：
  - [ ] `StatefulRuntime.spawn(taskId, involvedClasses, options) → Session`
  - [ ] `session.callTool(name, args) → Promise<ToolResult>`
  - [ ] `session.snapshot() → Promise<StateSnapshot>`
  - [ ] `session.close() → Promise<void>`
- [ ] 错误处理：worker error_type 5 类（class_not_found / method_not_found / args_invalid / runtime_error / eval_security_violation）TS 端正确区分
- [ ] 8 backend classes（GorillaFileSystem / Twitter / Ticket / Message / Math / Vehicle / Trading / Travel）至少 1 类完整 lifecycle 测试
- [ ] benchmarks 测试覆盖率 ≥ 95%（双入口顺序复跑）
- [ ] just test-all 三语言绿
- [ ] AMB 100k p95 ≤ 300ms 不回归
- [ ] R1 review BLOCKING/HIGH = 0；MEDIUM ≤ 1 仅文档
- [ ] reject 项验证：worker 显式拒 WebSearchAPI / MemoryAPI 调用（fail-loud）

---

## 6. 可能的风险

- **Python worker 跨 turn state identity**：BFCL backend object 是 mutable Python instance，worker 必须保留 reference（不 pickle 序列化）→ E3c1b spike 已确认
- **DockerSandbox long session**：当前 stateless per-task spawn → cleanup；E3c1b1 需 long-session container（per-task lifetime）— 是否破坏 E2 DockerSandbox MVP 假设？需 R1 抓
- **stdin/stdout JSONL framing**：大 state snapshot 可能超 buffer；需 byte-bounded streaming（沿用 E3c1a UTF-8 byte-safe 模式）
- **worker 内 eval safety**：`execute_multi_turn_func_call` 含 `eval`；DockerSandbox `--network none` + 4-mount class 已限制 blast radius，但 R1 必须查 worker 不接受任意 Python expression 评估
- **error_type 5 类是否完整**：可能漏（如 `worker_oom` / `worker_stalled`）— R1 应 attack

---

## 7. References

- [Iter E3 plan](./2026-04-26-02-iter-e3-gaia-bfcl.md)
- [E3c1a closed](./2026-04-26-05-iter-e3c1a-multi-turn-fixture.md)
- [Roadmap reassessment](./2026-04-26-03-roadmap-reassess-2026-04.md)
- [E3c1 spike](../research/2026-04-26-07-bfcl-v4-multi-turn-respike.md)
- [E3c1b spike](../research/2026-04-26-08-bfcl-v4-multi-turn-stateful-respike.md)
- [E3c1a R2 close commit](../../767e049)
- [BFCL multi-turn checker @ f7cf735](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py)
- [BaseHandler base class @ f7cf735](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf735/berkeley-function-call-leaderboard/bfcl_eval/model_handler/base_handler.py)
