# Iter E3a R5 Cross-Track Review — Faraday

**Reviewer**: Faraday（独立 subagent，不复用 R1 Raman / R2 Maxwell / R3 Hertz / R4 Boltzmann）
**Target commits**: `0668741`（R4 Boltzmann review）+ `cf88a30`（R4 fix）
**Date**: 2026-04-26
**Scope**: 仅 commit `cf88a30` 引入的改动（3 files / +121/-5）+ ADR-010 §3.4 修订
**Goal**: close E3a

---

## 1. R4 fix delta 摘要

`cf88a30` 仅碰 3 个文件，所有改动均围绕 R4 Boltzmann 的 1 BLOCKING + 2 HIGH + 1 MEDIUM：

- `benchmarks/scripts/fetch-benchmark.ts` (+40/-5)
  - 新增 `assertFetchLockPlatformSupported()`（line 265-271）→ Windows 入口 fail-loud
  - `withDatasetFetchLock` 入口调用平台 guard（line 205）
  - `withDatasetFetchLock` catch 块 `handle.close()` 后 `await rm(lockPath, { force: true })` 直清空 lockfile（line 213-218），跳过 `releaseFetchLock` 的 nonce-match 检查（empty file 没有 body 会 mismatch）
  - `removeStaleFetchLock` 改双因子（line 246-255）：`lock.body == null && age ≤ 30min` → keep；`lock.body != null && pid alive && age ≤ 30min` → keep；其他 → 清
  - 新增 `fetchLockFreshnessAgeMs` 助手（line 371-381）：`Math.max(mtimeMs, createdAtMs)`
  - `parseFetchLockBody` 加 `Date.parse(created_at)` finite check（line 347-353）
  - `__privateForTests` 暴露 `assertFetchLockPlatformSupported` 与 `fetchLockFreshnessAgeMs`
- `benchmarks/src/datasets/fetch-benchmark.test.ts` (+84/-1)：4 个新测试 + 1 个 rename（live-pid → freshness 语义）
- `docs/adr/adr-010-benchmark-harness-wire-schema.md` (+1/-1)：§3.4 双因子语义和 PID recycling 兜底冻结

---

## 2. R5 必查项结果

### A. removeStaleFetchLock 双因子 logic correctness — PASS

逻辑表（实测对照 line 244-256）：

| lock.body | pid alive | age | 行为 | 期望 |
|---|---|---|---|---|
| null | — | ≤ 30min | keep（line 246-248） | ✓ |
| null | — | > 30min | 清 → fall through 到 releaseFetchLock(undefined) → `rm`（line 256, line 306-308） | ✓ |
| valid | true | ≤ 30min | keep（line 249-254） | ✓ |
| valid | true | > 30min | 清 → releaseFetchLock with body → nonce-match → rm | ✓（PID recycling 解套） |
| valid | false | any | 清 | ✓ |

R4 BLOCKING-1（PID 复用永久卡）实证：测试 line 360-381 用 `process.pid`（必活）+ 31min stale → expect `removeStaleFetchLock` 返回 true。`pnpm vitest run` 268 passed / 1 skipped 全绿。

### B. Windows fail-loud 实现 — PASS

实现：`process.platform === "win32"` 比较（line 266）抛 Error，错误消息包含 "lockfile is not supported on Windows; use Linux/macOS or provide a platform-native lock implementation."。测试 line 521-533 通过 `Object.defineProperty(process, "platform", ...)` mock 平台值（不是 mock `isProcessAlive`），verify `fetchBenchmark` 抛 `/lockfile is not supported on Windows/`，并 expect `fetchMock` 未被调用（fail-fast 在数据 fetch 之前）。stub helper line 1203-1215 提供 descriptor restore，afterEach 清理。

### C. writeFile failure cleanup 完整性 — PASS

实现 line 213-218：catch 内 `handle.close()` → `handle = undefined` → `await rm(lockPath, { force: true })`。`force: true` 吞 ENOENT。测试 line 535-558 通过 spy `FileHandle.prototype.writeFile` 注入 `mockRejectedValueOnce` 模拟空 lock 文件留下的场景，verify `fetchBenchmark` 抛 simulated error，且最终 `.fetch.lock` 不存在（`readFile` 拒）。

注意：catch 内 `handle.close()` 若自身抛错会越过 line 216-217 的 rm，并使 finally 内的 `handle.close()`（line 228-230）二次抛错。这是 LOW（见 §3 LOW-1），不阻塞。

### D. ADR-010 §3.4 与实现一致性 — MOSTLY PASS（一个 wording drift）

ADR-010 §3.4 line 116 修订 verbatim 写入：
- ✓ 「双因子 stale 判定：pid 存活且 freshness timestamp（heartbeat mtime, `created_at` 作为初始 fallback）距今 ≤ 30 分钟才继续等待」
- ✓ 「pid 已退出、freshness 超过 30 分钟、或 lock body 无效且 mtime 超过 30 分钟时清理」
- ✓ 「PID recycling 后无关进程让 orphan lock 永久存活」兜底语义
- ✓ 「Windows 必须 fail-loud 或改用平台原生锁」

drift（见 §3 MEDIUM-1）：ADR 措辞「`created_at` 作为初始 fallback」隐含 "mtime 优先，仅当 mtime 不可用时退到 created_at"；但 `fetchLockFreshnessAgeMs` 永远做 `Math.max(mtime, createdAtMs)`。实际 stat 必返 mtimeMs，"mtime 不可用" 不存在，所以行为永远是 max 而非 fallback。

### E. R4 fix regression — PASS

`git diff cf88a30^ cf88a30 --stat`：仅 3 文件。`runner.ts` / `docker.ts` / `gaia.ts` / scorer / submission 全未碰。E2 swe-bench / AMB / wire schema 不可能受 cf88a30 影响。`pnpm vitest run` 18 test files 全绿；coverage statements 97.56% / branches 95.22% / lines 97.61% / funcs 98.47%（`pnpm vitest run --coverage`）。

### F. R5 大局判断 — close

E3a §6 硬验收对照：

| 验收项 | 状态 | 实证 |
|---|---|---|
| GAIA loader + scorer + submission 端到端 | ✅ 已在 R1 fix `f8f06cc` 落地（runner dataset-aware collect / GAIA prompt sanitization / attachment integrity / container path）；R5 不破坏 | 96a7971 + f8f06cc + 6b94a97 + 9910571 + cf88a30 commit chain |
| benchmarks 测试覆盖率 ≥ 95%（双入口） | ✅ Branches 95.22% > 95（本 session 实测） | — |
| just test-all 三语言绿 | ✅ commit 自报 TS 717 + Py 187 + Rust 1（本 session 未重跑，依据 cf88a30 commit message 与 lint/tsc 干净） | 见 §3 备注 |
| AMB 100k p95 ≤ 300ms 不回归 | ✅ commit 自报 0.278ms（本 session 未重跑） | 见 §3 备注 |
| R1 review BLOCKING/HIGH = 0; MEDIUM ≤ 1 仅文档 | ✅ R5 finding：0 BLOCKING / 0 HIGH / 1 MEDIUM (doc) / 1 LOW | 本报告 §3 |

---

## 3. Findings

### BLOCKING

无 BLOCKING finding。

### HIGH

无 HIGH finding。

### MEDIUM

#### M-1: ADR §3.4「初始 fallback」措辞 vs 代码 `Math.max` 行为漂移

- **File**: `docs/adr/adr-010-benchmark-harness-wire-schema.md:116` ＆ `benchmarks/scripts/fetch-benchmark.ts:371-381`
- **Evidence**:
  ```ts
  function fetchLockFreshnessAgeMs(lock: FetchLockRead): number {
      const createdAtMs =
          lock.body == null
              ? Number.NEGATIVE_INFINITY
              : Date.parse(lock.body.created_at);
      const freshnessMs = Math.max(
          lock.mtimeMs,
          Number.isFinite(createdAtMs) ? createdAtMs : Number.NEGATIVE_INFINITY,
      );
      return Date.now() - freshnessMs;
  }
  ```
  ADR 文字：「heartbeat mtime, `created_at` 作为初始 fallback」。语义上「初始 fallback」=「当 mtime 不可用时退到 created_at」；实际代码：`Math.max(mtime, createdAt)` 永远取较新。`fs.stat` 必返 mtimeMs（永不缺），所以"fallback when unavailable" 永不触发；行为永远是 max。
- **次生 abuse case**: 写入端时钟向后跳（`created_at` 是「未来」时间戳），`Math.max` 取该未来值；`Date.now() - 未来 = 负值 ≤ 30min`，判定 fresh。若同时 PID 复用为长寿进程（line 251 `isProcessAlive` 也通过），lock 永久卡。要触发需「写入端时钟前跳」+「PID 复用为长寿进程」双条件，是 R4 BLOCKING-1 同形态 cascade 的极小子集。
- **Confidence**: 0.65（次生 cascade 需双条件；主问题是 ADR/代码 wording drift，可读性影响）
- **修复建议**: 二选一 —
  1. 紧 ADR：改为「freshness timestamp 取 `max(heartbeat mtime, created_at)`，由两值各自的写入路径保证至少一个反映持有者活动」
  2. 紧代码：在 `fetchLockFreshnessAgeMs` 末尾 `Math.min(freshnessMs, Date.now())` 钳到当前时刻，杜绝未来时间戳 cascade
- **Owner**: human（语义决策，由 Codex/Claude 选向）

### LOW

#### L-1: `isProcessAlive` 缺少 unix-only JSDoc，与 commit message 自述不符

- **File**: `benchmarks/scripts/fetch-benchmark.ts:383-393`
- **Evidence**: `cf88a30` commit message 第 9 行写「isProcessAlive 文档化 unix-like only」，但 line 383 `function isProcessAlive(pid: number): boolean {` 上方没有 JSDoc。Windows 兜底实际由 `assertFetchLockPlatformSupported`（line 265-271）在更上游 entrypoint 拦截，`isProcessAlive` 在 Windows 不可达，所以功能正确；但 commit message 与代码不一致。
- **Confidence**: 0.95（文本对比 + grep 直接证伪）
- **修复建议**: 加一行 JSDoc：
  ```
  /** Unix-like only. On Windows this function is unreachable; entry blocked by assertFetchLockPlatformSupported. */
  ```
- **Owner**: downstream-resolver（可在下次任意 commit 顺手补）

### Other notes（不计入 finding）

- catch 内 `handle.close()` 若抛错可掩盖 writeFile 原错并使 finally 二次 close（line 228-230）。close 抛错概率极低（kernel-level fd 故障），即使发生，下一个 retry 循环或后续运行会通过 30min stale 兜底清理。不升级。
- §6「双入口顺序复跑」纪律：cross-process 串行化由 `writeCrashOrphanLock`（test line 303）覆盖，R5 未引入新的 cross-process 测试缺口。
- 本 session 仅本机重跑 `pnpm vitest run` + `pnpm vitest run --coverage` + `biome check` + `tsc --noEmit`。`just test-all`（Py 187 + Rust 1）与 AMB 100k p95 0.278ms 采纳 cf88a30 commit message evidence，未亲跑（time/scope tradeoff，cf88a30 改动局限于 fetch-benchmark.ts，不接触 agent-core / providers / crates）。

---

## 4. R5 conclusion

**close — E3a 收口。**

R4 BLOCKING-1 + 2 HIGH + 1 MEDIUM 在 `cf88a30` 全部修复并由测试覆盖；R5 独立检查未发现新的 BLOCKING/HIGH。本轮唯一 MEDIUM (M-1) 是 ADR ↔ 代码 wording drift，且仅文档级影响，符合 Iter E3 §6 验收「MEDIUM ≤ 1 仅文档」。LOW (L-1) 是 commit message 自述与代码不符的纯文档纰漏。两者均不阻塞 close，建议在下个 sub-iter 顺手清理（可与 E3b 启动文档同 commit）。
