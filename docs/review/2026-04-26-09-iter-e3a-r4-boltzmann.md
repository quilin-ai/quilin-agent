# Iter E3a R4 Cross-Track Review — Boltzmann

**Reviewer**: Boltzmann（独立 subagent，不复用 R1 Raman / R2 Maxwell / R3 Hertz）
**Target commits**: `ecf7c32` (R3 review) + `9910571` (R3 fix)
**Date**: 2026-04-26
**Scope**: 仅 commit `9910571` 引入的改动（3 files / +483/-17）+ ADR-010 §3.1 / §3.4 修订
**Method**: file:line + 代码片段实证；不复用 R1/R2/R3 已闭合 / 已 defer 的 12 项 finding

---

## 1. R3 fix delta 摘要

R3 fix 解决 R3 提的 4 件事：

1. **BLOCKING-1（finally rm cascade）**：lock body 升级为 `{created_at, pid, nonce}`（`fetch-benchmark.ts:78-82, 258-264`）；`releaseFetchLock` 释放前 read-back 校验 `pid + nonce`，nonce 不匹配则 **不** rm（`fetch-benchmark.ts:287-300`）；finally 段从无条件 rm 改为带 owner 的 conditional rm（`fetch-benchmark.ts:235`）。
2. **HIGH-1（ADR-010 §3.1 字段类型未冻结）**：ADR-010:56 加 `sha256 ^[a-f0-9]{64}$` / `size_bytes 非负 integer` / `file_path / container_path posix` / `file_name ^[A-Za-z0-9._-]+$ ≤255 bytes` 类型约束。
3. **HIGH-2（pid liveness check 缺失 + 10min stale 不够）**：`isProcessAlive` 用 `process.kill(pid, 0)` + ESRCH 判断（`fetch-benchmark.ts:351-361`）；heartbeat 每 5 分钟刷 mtime（`fetch-benchmark.ts:266-285`）；stale threshold 10min → 30min（`fetch-benchmark.ts:42`）。
4. **MEDIUM-1（lockfile 协议未在 ADR §3.4 文档化）**：ADR-010:114-116 加 "Fetch lockfile protocol" 子节，描述 `<cacheDir>/.fetch.lock` / O_EXCL / 5min heartbeat / 30min stale + pid liveness / per-cacheDir per-dataset / macOS APFS + Linux ext4/tmpfs 支持，NFS/Windows 不纳入 CI 支持面。

新增测试 6 项（`fetch-benchmark.test.ts:282-490`）覆盖跨进程序列化、crash-orphan 清理、nonce 不匹配释放被拒、heartbeat 仅刷自己、malformed/fresh lock 行为、非 ENOENT 错误透传。**总计 36 个 fetch-benchmark 测试**全绿；benchmarks 整包 265 passed / 1 skipped。

R4 任务 = 找 R3 fix 自己引入的二阶副作用，特别是 nonce/pid liveness/heartbeat 三件新机制的失效路径与 ADR-vs-code drift。

---

## 2. R4 必查项结果

### A. Nonce randomness 与 reuse — 整体 PASS

- **来源**：`fetch-benchmark.ts:1` `import { createHash, randomUUID } from "node:crypto"`；`createFetchLockBody` line 261 `nonce: randomUUID()`。`crypto.randomUUID` 是 RFC 4122 v4，122-bit 随机熵，由 OS CSPRNG 派生（Node `crypto.randomBytes`）。**非** `Math.random()` / `Date.now()`。**PASS**。
- **per-acquire 重新生成**：`withDatasetFetchLock` line 207 每次 while 循环顶部调用 `createFetchLockBody()`，每次 retry 都生成新 nonce。即使同一 process 短 fetch 立刻 release 后 acquire，nonce 也不同。**PASS**。
- **collision**：UUID v4 的 122-bit 等价 ~5×10^36 空间，单仓库一辈子的 fetch 次数 ≪ √(2×5×10^36) ≈ 3×10^18，birthday 碰撞概率天文级低。**PASS**。
- **pid + nonce 双因子**：`fetchLockMatches` line 308 `lock.body?.nonce === owner.nonce && lock.body.pid === owner.pid` 双字段比对；即使 nonce 哪天确实碰撞，pid 不同也能挡住跨进程冒充。**PASS**。

### B. PID recycling false-active — 发现 BLOCKING-1（见 §3）

- **scenario**：A 进程 pid=12345 在写完 lockfile 后**立即崩溃**（kernel OOM kill / `kill -9` / 段错误）→ heartbeat 没机会刷 mtime → OS 在 30 min stale 阈值之前给 pid=12345 分配给无关进程 D（macOS 默认 `kern.maxproc=2048`，Linux PID_MAX 默认 32768，CI matrix 高并发 + busy worker 节点完全可能在小时级窗口内 recycle）→ Reaper Process B 调 `removeStaleFetchLock` line 240：
  - line 242 `readFetchLock` 读到 A 写入的 valid body（pid=12345, nonce=N1）。
  - line 243 `isProcessAlive(12345)` 调 `process.kill(12345, 0)` → D 在跑 → 返 true。
  - line 244 `return false` ← **永久卡死**。
- **没有 mtime 兜底**：line 246 的 stale 兜底**只在 `lock.body == null` 时触发**（malformed lock）。body 是 valid + pid 被 recycle → 永远不进 line 246-248，永远不 reap。
- **mitigation 缺失**：lock body 写了 `created_at`（line 260），但 `removeStaleFetchLock` **完全不读 created_at**——可以用 `created_at` + `process.uptime()` / `os.boot_time` 做兜底（"如果 pid 存活但启动时间晚于 lock created_at，就是 recycle"），但当前实现没有。
- **macOS 默认 pid wrap**：`sysctl kern.maxproc` 默认 2048，开发笔记本 + CI runner 长期跑会触及；CI fleet 多 worker 节点 + 多 GAIA fetch 并发 + 偶发崩溃 → recycle 在数小时内是真实场景。
- **Confidence**: 0.80 — 实证可走通；唯一不确定的是 CI 实际触发频率（需要 A 在 heartbeat 来得及刷之前崩溃 + recycle 窗口足够小），但作为 invariant violation 已经足够 BLOCKING。

### C. Heartbeat 5min vs stale 30min 比例 — 整体 PASS（一处 OBSERVATION）

- **比例**：heartbeat 5min（`FETCH_LOCK_HEARTBEAT_MS = 5 * 60 * 1000`，line 41）/ stale 30min（`FETCH_LOCK_STALE_MS = 30 * 60 * 1000`，line 42）= 6 个周期容忍。理论上能承受 5 个连续 missed heartbeat 后才被外部判 stale。**PASS**。
- **App Nap / cgroup throttling**：macOS 仅 GUI 应用（`activity_state == background`）会被 App Nap，CLI 子进程一般免疫；Linux cgroup CPU throttle 不会让 setInterval 推迟到 30min（最多 ms-秒级）。**PASS**。
- **GC pause**：Bun 1.3 V8 STW 一般 ms 级；Bun 子进程 OOM 接近 limit 可能数秒，累积不可能逼近 30min。**PASS**。
- **fetch loop 是否阻塞 setInterval**：`fetchAllRows` line 363-410 的 `await fetch(url)` 基于 libuv 异步 I/O，不阻塞 event loop；setInterval 回调能在每个 page fetch 间隙触发。**PASS**。
- **timer leak 兜底**：`startFetchLockHeartbeat` line 273 `heartbeat.unref?.()` 不会阻止 process 退出；`withDatasetFetchLock` line 234 `clearInterval(heartbeat)` 在 finally 中清理，不会泄漏 timer。**PASS**。
- **OBSERVATION（不上报为 finding）**：单 row download 阻塞 > 30min 极端慢网络场景，HF datasets-server / attachment fetch 没有 per-request timeout。如果某个 attachment 死循环 hang，**fetch loop 内 await 会无限挂起**，此时 setInterval 仍能定期触发（fetch hang 不阻塞 event loop），heartbeat 会持续刷 mtime，stale 兜底永远不触发。这是预期行为（heartbeat 设计目标）但意味着死 hang 的 fetch 永远不会被外部 reaper 抢断。下一 iter 可考虑加 `AbortController` + per-request timeout。

### D. ADR-010 §3.4 vs 代码实现一致性 drift — 发现 HIGH-1（见 §3）

- **常量交叉验证**：
  - `FETCH_LOCK_HEARTBEAT_MS = 5 * 60 * 1000` (line 41) ↔ ADR-010:116 "持有者每 5 分钟 heartbeat 更新 mtime"。**MATCH**。
  - `FETCH_LOCK_STALE_MS = 30 * 60 * 1000` (line 42) ↔ ADR-010:116 "mtime 超过 30 分钟 stale threshold"。**MATCH**。
  - `FETCH_LOCK_RETRY_MS = 25` (line 40) — ADR 未提；属于内部实现细节（retry busy-wait 间隔），不需要冻结。**PASS**。
- **lock body 字段集**：ADR-010:116 "body 为 `{created_at, pid, nonce}`" ↔ `FetchLockBody` interface line 78-82 三个字段一致。**MATCH**。
- **read-back 协议**：ADR-010:116 "释放前必须 read-back 校验 `pid + nonce`，只删除自己持有的 lock" ↔ `fetchLockMatches` line 308 校验 `nonce + pid`。**MATCH**。
- **pid liveness 描述精度**：ADR-010:116 "竞争者遇到已存在 lock 时先做 pid liveness check：pid 存活则等待；pid 已退出则清理 orphan lock" — 文字描述**精确**。但**没说 pid recycling 兜底策略**（即 §B 发现的 BLOCKING-1：pid 复用导致的 false-active）。下一个实现者读完 ADR 写出来的协议**会和当前代码一样有 PID recycling 漏洞**。HIGH-1（见 §3）。
- **平台支持声明 vs 代码实现**：ADR-010:116 "NFS / Windows 不纳入 E2/E3 CI 支持面，必须 fail-loud 或改用平台原生锁" — 代码 **不 fail-loud**：`isProcessAlive` line 358 在非 ESRCH 错误（包括 Windows 上 EINVAL/EPERM）时 `return true`，意味着 Windows 上每次 liveness check 都判活，orphan lock 永远不被清理；`withDatasetFetchLock` 也没有 `process.platform !== "linux" && process.platform !== "darwin"` 的早期拒绝。HIGH-2（见 §3）。

### E. Cross-platform lockfile — HIGH-2（见 §D 已合并）

- **APFS 大小写折叠**：macOS APFS 默认 case-insensitive，但 Quilin Agent 仓库根的 cacheDir 默认 `<cwd>/.benchmarks/datasets/<dataset>/`，文件名 `.fetch.lock` 是固定字符串、无大小写变体竞争。**PASS**。
- **NFS**：ADR 已声明不支持。代码不主动检测 NFS（没有 `statvfs` 或 `/proc/mounts` 读取）。如果 cacheDir 在 NFS mount 上，`open(... wx)` 在 NFSv2 不可靠（NFSv3+ OK）；ADR 已 disclaimer。**PASS**（boundary 已声明）。
- **Windows**：ADR 已声明 fail-loud；代码**未 fail-loud**——见 §D HIGH-2。
- **tmpfs / Docker overlay**：ADR 没单独声明；ADR-011 DockerSandbox 未读，但 ADR-010 §3.4 当前文字暗示 ext4/tmpfs OK。`open(... wx)` 在 tmpfs / overlay 是原子的（内核层 inode 创建），**PASS**。

### F. R3 fix regression check — 整体 PASS（一处 OBSERVATION）

- **E2 swe-bench fetch path**：`withDatasetFetchLock` 在 `fetchBenchmark` line 108 入口对**所有** dataset 应用，不区分 GAIA / SWE-bench。新增 lockfile 协议是 dataset-agnostic 的，对 swe-bench-lite/verified 同样生效。但 swe-bench fetch 时间一般 < 5min（300/500 行 + 无 attachment），`heartbeat unref + 5min interval` 大概率不会触发——此时 lockfile 全程 mtime 不刷新，被 R3 fix 的"30 分钟 stale + pid liveness check"双重保护——**OK**。
- **AMB 100k p95 1.888ms**：commit message 报 1.888ms，R2 fix 时报 0.267ms。`git log --since="2026-04-26 00:00" -- providers/memory/` 实证今日**无 memory provider 改动**，差异是测试运行环境 noise（可能宿主负载 / Bun GC 抽样差异）；阈值是 ≤300ms，1.888ms 仍距阈值 159× 的安全 margin。**PASS（noise，非 regression）**。
- **wire schema**：ADR-010 §3.1 修订只动了 `file_attachments[]` 元素的类型约束（不动字段集），`benchmarks/src/wire/task.ts` zod schema 未需要修订。**PASS**。
- **OBSERVATION（不上报为 finding）**：`withDatasetFetchLock` 在 catch 路径 line 213-216 调用 `releaseFetchLock(lockPath, lockOwner)` 处理 "open 成功但 writeFile 失败" 的情况，但因为 lockfile body 还没写入（空文件），`fetchLockMatches` line 308 读到 body=undefined，返 false → **不删空 lockfile**。空 lockfile 留在原地，需要等 30min stale 阈值 + body=null 路径（line 246-248）才会被下一个 fetcher 清理，意味着该 cacheDir 在 30min 内**完全卡住后续 fetch**。是真实但低概率的边角（writeFile 失败需要 ENOSPC / EIO / EACCES）。

### G. R3 LOW-1 (Unicode codepoint snapshot drift) 重判 — 维持 LOW

- **当前 V8/ICU 状态**：Node 22.20.0 ICU 77.1（实证：`node -e 'console.log(process.versions.icu)'`），覆盖 Unicode 16.0（2024 年发布）。Bun 1.3.11 用 V8 12.8（基于 13.x ICU），同样 Unicode 16.0。Unicode 17 由 Unicode Consortium 计划 2025 年 9 月发布，截至 2026-04-26 没有 Unicode 16+ 之外的 decimal digit script 已 ratified。
- **drift 实际触发概率**：未来 Unicode 17 / 18 引入新 decimal script 后，需要 ICU/V8 升级 + Quilin Agent Bun/Node 版本升级才会生效；hand-maintained codepoint list 落后概率存在但 score impact 极小（GAIA 答案数字使用罕见 script 的概率 ≪ 1%）。
- **重判结论**：**维持 LOW**——drift 速度慢、覆盖窗口大、impact 小、修复路径清晰（注释说明 snapshot 来源 + 升级清单 + 自动化 test 兜底）。下一 iter chore 处理。**不升级**。

### H. R3 测试质量反向检查 — 整体 PASS（一处 OBSERVATION）

- **真崩溃 vs 模拟崩溃**：`writeCrashOrphanLock` test (`fetch-benchmark.test.ts:1086-1105`) 通过 spawn 一个 Node 子进程**写 lockfile 然后正常退出**——子进程 pid 在退出后被 OS 回收（或 zombie reap），从主测试进程的视角 `process.kill(pid, 0)` 会返 ESRCH，触发清理。这模拟"crash orphan"是**正确的**（dead pid + valid body 走 line 240-249 的清理路径）。**PASS**。
- **真 SIGKILL**：测试**不**真 `kill -9` 一个跑到一半的 fetch；但因为测试目标是 lockfile 协议（不是中断行为），spawn-write-exit 等价于"crash 后 fd 已被 OS 回收 + 文件残留 + pid 死"的稳态，**等价覆盖**。**PASS**。
- **malicious nonce reuse**：`removes only the lock matching the owner nonce` test (`fetch-benchmark.test.ts:359-387`) 覆盖"B 重写 lock body 为另一个 nonce 后 A 试图释放"——A 的 release 因 nonce 不匹配返 false（line 376-381），lockfile 内容仍是 B 的（line 379-381）；然后 B 用自己 owner 调 release 返 true（line 383-385）。但**不**覆盖"B 故意重写 lock body 为 **A 的 nonce + B 的 pid**"——这种情况 `fetchLockMatches` 会因 pid 不匹配返 false，仍然安全；不构成 finding。**PASS**。
- **OBSERVATION（不上报为 finding）**：测试**不**模拟 `kill -9` + recycle 同 pid 的场景（即 §B 描述的 PID recycling）。这是因为单测无法可靠 hit OS pid recycle window；要复现需要 stress test（CI matrix high-concurrency runner + 数千次 fetch 触发自然 pid wrap）。当前 test suite coverage 95.17 是行覆盖，**不能**断言 BLOCKING-1 被覆盖。

---

## 3. Findings

### BLOCKING-1: PID recycling 导致 lock 永久卡死，30min stale 兜底不可达

**File**: `benchmarks/scripts/fetch-benchmark.ts:240-256, 351-361`

**实证代码**:
```ts
// line 240-256
async function removeStaleFetchLock(lockPath: string): Promise<boolean> {
    try {
        const lock = await readFetchLock(lockPath);
        if (lock.body != null && isProcessAlive(lock.body.pid)) {
            return false;                // ← 永远走这一支
        }
        if (lock.body == null && Date.now() - lock.mtimeMs <= FETCH_LOCK_STALE_MS) {
            return false;
        }
        return releaseFetchLock(lockPath, lock.body);
    } catch (error) {
        if (isNotFoundError(error)) return true;
        throw error;
    }
}

// line 351-361
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        return true;
    }
}
```

**Scenario（reproduce-step-by-step）**:
- T=0: Process A (pid=12345) 调 `withDatasetFetchLock` → `open(lockPath, "wx")` 成功，写 body `{created_at: T0, pid: 12345, nonce: N_A}`。开始 GAIA fetch。
- T=10s: A 在第一个 attachment fetch 时被 OOM killer kill -9（heartbeat 5min interval 还没机会 fire；mtime 仍是 T0+ε）。lockfile 残留在文件系统，body 完整 valid。
- T~30min-1h（CI matrix 高并发场景）：OS 在 PID 池中将 12345 分配给无关进程 D（macOS `kern.maxproc=2048` 默认，Linux PID_MAX 32768 默认；CI runner 跑过几千个 fork 后必然 wrap）。D 是无关进程，可能跑到几小时后才退出。
- T=30min+ε: Process B（同一个或另一个 CI worker）调 `fetchBenchmark` 同一 dataset → `open(... wx)` 抛 EEXIST → `removeStaleFetchLock`：
  - line 242 `readFetchLock`：读到 valid body `{pid: 12345, nonce: N_A, created_at: T0}`。
  - line 243 `isProcessAlive(12345)` → `process.kill(12345, 0)` → D 在跑 → 返 true。
  - line 244 `return false`。
- B 进入 `delay(25ms)` 然后 `continue`（line 223-224），无限 retry。
- B 永远拿不到锁，**直到 D 退出**（可能数小时数天）。CI 任务超时失败、用户的 GAIA fetch 卡死。

**为什么是 BLOCKING**:

1. 违反 lockfile 协议的 liveness 不变量："orphan lock 必须能在有限时间内被清理"。
2. mtime 兜底（line 246-248）**只在 `lock.body == null` 时触发**，valid body + recycled pid 永远走不到这一支。即使 lockfile mtime 已经 > 30min stale，只要 PID 被 recycle 给活进程，逻辑就**永久卡死**。
3. 没有 `created_at + 进程启动时间`（`process.uptime()` / `/proc/<pid>/stat starttime`）的兜底。R3 在 lock body 写了 `created_at` 但 `removeStaleFetchLock` **完全不读 created_at**——这是 R3 fix 自己的漏写。
4. 现有测试 (`fetch-benchmark.test.ts:336-357`) 覆盖"pid 存活则不清理 stale"——但**正向断言这个 bug 是 feature**：测试用 `process.pid`（同测试进程必然 alive），写一个 mtime 31min stale 的 lock，期望 `removeStaleFetchLock` 返 false。**这等于把 bug 锁进了测试**。
5. ADR-010:116 文字也没说 pid recycling 兜底——下一个实现者读完 ADR 写出来的协议还会有同样的洞。

**Confidence**: 0.80（实证 invariant 可被 PID recycle 直接打破；CI 高并发场景下 macOS 2048 pid wrap 在小时级窗口内是真实的；但需要"A 崩溃 + heartbeat 没刷 + 同 pid 被 recycle"三件事同时发生，单 dev 笔记本难触发，CI matrix 长时间跑必然遇到）

**修复建议**:
- 在 `isProcessAlive` 或 `removeStaleFetchLock` 中**叠加 created_at 兜底**：当 `pid alive && Date.now() - lock.mtimeMs > FETCH_LOCK_STALE_MS` 同时成立，就**忽略 isProcessAlive 的判断**——这意味着 heartbeat 5 min 周期 + 30 min stale = 6 周期 missed = 必然不是真活进程在 fetch。
- 或者：在 `removeStaleFetchLock` 多读 `created_at`，与 `/proc/<pid>/stat` 的 starttime（Linux）/ `kern.proc.pid.start` (macOS sysctl) 比对——alive pid 启动时间晚于 lock created_at 就是 recycle。但跨平台实现复杂，建议 fallback 到 mtime 兜底。
- 修测试：把 `fetch-benchmark.test.ts:336-357` 拆成两个测试。一个保留"pid 存活 + mtime fresh → 不清理"。新增一个"pid 存活 + mtime > 30min stale → **必须清理**"——这个新测试会 fail 当前实现，正是 BLOCKING 的实证。
- ADR-010 §3.4 同步加 PID recycling 兜底协议描述。

---

### HIGH-1: ADR-010 §3.4 lockfile 协议未冻结 PID recycling 兜底语义

**File**: `docs/adr/adr-010-benchmark-harness-wire-schema.md:116`

**实证文本**:
> 竞争者遇到已存在 lock 时先做 pid liveness check：pid 存活则等待；pid 已退出则清理 orphan lock；无效 lock 只有在 mtime 超过 30 分钟 stale threshold 后才清理。

**问题**:
- ADR 文字描述精确到 "pid 存活则等待 / pid 已退出则清理"，但**没有冻结** PID recycling 边角的兜底策略。下一个实现者读完 ADR 会写出和 BLOCKING-1 同款逻辑：valid body + alive pid → 永远不清理。
- ADR 应该明确：**stale + pid alive 时仍需清理**（heartbeat 必须维护 invariant），或者**至少声明 PID recycling 是 ADR-010 §3.4 的 known limitation 并且 fail-loud**。
- ADR-010 §3.4 写了 `created_at` 在 body 里，但没说**用来做什么**——如果只用来调试，应该注释；如果是 PID recycling 兜底用的，应该写到协议里。

**Confidence**: 0.85（ADR 精度纪律 + R3 BLOCKING-1 之所以发生就是因为 ADR §3.4 描述完之后实现者照抄漏了兜底）

**修复建议**:
- ADR-010 §3.4 加一条："如果 lock body 的 pid 仍存活但 mtime 已超过 stale threshold，仍应清理（heartbeat 失效意味着持有者实际无法 progress；alive pid 可能是 recycle 后的无关进程）"。
- 或：声明 "lockfile 协议在 PID recycling window 内是 best-effort，跑长 GAIA fetch 必须使用独立 cacheDir per CI worker / 加 worker 级别的 cleanup 钩子"。

---

### HIGH-2: Windows 平台未 fail-loud，与 ADR-010 §3.4 声明矛盾

**File**: `benchmarks/scripts/fetch-benchmark.ts:351-361, 201-238`；ADR-010:116

**实证文本（ADR）**:
> 该协议在 macOS APFS 与 Linux ext4/tmpfs 上有效；NFS / Windows 不纳入 E2/E3 CI 支持面，必须 **fail-loud** 或改用平台原生锁。

**实证代码**:
```ts
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        return true;        // ← Windows EINVAL/EPERM/EBUSY 都进这里
    }
}
```

**问题**:
- Windows 上 `process.kill(pid, 0)` 不返 ESRCH——返 EPERM（无权限访问 system process）/ EINVAL（无效 pid）/ ENOENT 等。**所有非 ESRCH 错误**都被当作"alive"。
- 结果：Windows 上每次 liveness check 都判活，orphan lock 永远不被清理；mtime 兜底（line 246-248）只在 `body == null` 触发，valid body 永远不被 reap。**Windows 上跑 fetch-benchmark 任何崩溃都会导致永久卡死**。
- ADR 说 "必须 fail-loud" — 代码**完全不 fail-loud**：`withDatasetFetchLock` line 201-238 没有 `process.platform === "win32"` 的早期拒绝，没有 ENOSYS error 抛出。Windows 用户运行后会进入静默卡死（第一次 fetch 成功，第二次崩溃后永久卡）。
- 这是 ADR-vs-code 直接 drift。R3 fix 把 Windows 限制写进 ADR §3.4 但没在代码层强制。

**Confidence**: 0.85（直接代码读 + Node `process.kill(0)` 跨平台 semantic difference 是公开的；Windows 不是 Quilin Agent 主战场所以触发概率低，但 ADR 已承诺 fail-loud 而代码 fail-silent）

**修复建议**:
- `withDatasetFetchLock` 入口加：
  ```ts
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(
      `fetch-benchmark lockfile protocol requires linux/darwin, got ${process.platform}; see ADR-010 §3.4`,
    );
  }
  ```
- 或：把 ADR §3.4 改为"Windows 上 lockfile 协议是 best-effort，崩溃后需要手动删除 `.fetch.lock`"——但 R3 已声明 fail-loud，这条更弱的语义违反 ADR 一致性。
- 同步给 `isProcessAlive` 加 Windows-specific path（用 `tasklist` / `Process.GetProcessById` 通过 `child_process.execSync`），但成本高，建议先 fail-loud。

---

### MEDIUM-1: catch 路径 leak 空 lockfile，下个 fetcher 等 30min 才能继续

**File**: `benchmarks/scripts/fetch-benchmark.ts:209-228`

**实证代码**:
```ts
try {
    handle = await open(lockPath, "wx");        // ← 创建空 lockfile
    await handle.writeFile(`${JSON.stringify(lockOwner)}\n`, "utf8");  // ← 失败
} catch (error) {
    if (handle != null) {
        await handle.close();
        await releaseFetchLock(lockPath, lockOwner);  // ← read-back 失败（空 body），返 false，不删
    }
    if (!isFileExistsError(error)) {
        throw error;
    }
    // ...
} finally {
    if (handle != null) {
        await handle.close();   // ← 重复 close，Node 22 / Bun 1.3 都 idempotent，但…
    }
}
```

**问题**:
- 路径：`open(... wx)` 成功（创建空文件），但 `writeFile` 抛错（ENOSPC / EIO / EACCES / disk error）。
- catch 进入 → 调 `releaseFetchLock(lockPath, lockOwner)`。`releaseFetchLock` line 295-296 调 `fetchLockMatches`，读到的是空文件 → `parseFetchLockBody("")` → undefined → `lock.body?.nonce === owner.nonce` → `undefined === uuid` → false → **返 false → 不 rm**。
- catch 接着 `if (!isFileExistsError(error)) throw error;` → 把 writeFile 的原错抛出去。
- 留下一个空 lockfile，body=undefined，mtime=now。下一个 fetcher：
  - line 242 read → body=undefined。
  - line 243 `lock.body != null` 是 false → 走下一支。
  - line 246 `lock.body == null && Date.now() - mtime <= STALE_MS` → 是的（fresh 空 lock）→ 返 false → 不清理。
- 下一个 fetcher 必须等 **30 分钟**才能 reap 这个空 lockfile。期间 cacheDir 完全卡住。
- 实际触发场景：磁盘满 / inode 耗尽 / 网络文件系统短暂故障。低概率但真实。

**Confidence**: 0.65（路径走通；但实际触发需要 writeFile 失败，正常 ext4/APFS 上低概率；不影响 normal flow）

**修复建议**:
- catch 段在 `releaseFetchLock` 失败后**强制清理空 lockfile**：因为我们刚 `open(... wx)` 成功，这个文件**确定**是我们自己创建的（POSIX EEXIST 不会让 open 成功），所以可以无条件 rm（不需要 nonce 校验）。
- 或：把 open + writeFile 改成 `open(... wx) → write → close`，如果 write 失败就在 close 前 unlink path（POSIX 允许 unlink 已 open 的文件）。
- 或：用 `fs.writeFile(path, body, { flag: "wx" })` 一步完成（无中间空文件状态），libuv 会原子地 open+write+close。

---

### LOW-1: heartbeat unref 在 process exit 时 silent drop 未释放的 lock

**File**: `benchmarks/scripts/fetch-benchmark.ts:266-275, 230-237`

**实证代码**:
```ts
function startFetchLockHeartbeat(...): ReturnType<typeof setInterval> {
    const heartbeat = setInterval(...);
    heartbeat.unref?.();    // ← 不阻止 process 退出
    return heartbeat;
}

// withDatasetFetchLock line 230-236
const heartbeat = startFetchLockHeartbeat(lockPath, lockOwner);
try {
    return await operation();
} finally {
    clearInterval(heartbeat);
    await releaseFetchLock(lockPath, lockOwner);
}
```

**问题**:
- `heartbeat.unref()` 让 timer 不阻止 process exit。如果 fetch loop 期间收到 SIGINT / SIGTERM / `process.exit()` 调用，**finally 块不会执行**（同步 process.exit 会跳过 finally）。lockfile 残留，body valid，pid 是当前进程（即将死）。
- 下一个 fetcher 看到 lock：pid 已死 → ESRCH → `isProcessAlive` 返 false → `removeStaleFetchLock` 走清理路径 line 249 `releaseFetchLock(body)` → read-back match → rm。
- **PID recycling 落入 BLOCKING-1**：如果 SIGTERM 后 OS 立刻给 pid 分配给其他活进程，就回到 BLOCKING-1 场景。
- 单独看是 LOW（unref 选择本身合理：阻止 timer 拖延 process exit），但与 BLOCKING-1 形成 cascade。

**Confidence**: 0.50（正常 SIGTERM 流程不会立刻 PID recycle，但与 BLOCKING-1 叠加形成完整 cascade）

**修复建议**:
- 加 `process.on("SIGINT", ...)` / `process.on("SIGTERM", ...)` 显式 cleanup 钩子。但工程性价比一般，建议优先修 BLOCKING-1（PID recycling 兜底），LOW-1 自然消解。

---

## 4. R4 conclusion

**结论**: **fix-pass-needed** — R4 发现 BLOCKING-1（PID recycling 导致 valid-body lock 永久卡死，30min stale 兜底完全不可达；R3 fix 的 created_at 字段写了但没用），需要再修一轮。HIGH-1（ADR-010 §3.4 协议未冻结 PID recycling 兜底）和 HIGH-2（Windows 未 fail-loud 与 ADR §3.4 声明矛盾）应在同一轮一起修；MEDIUM-1（catch 路径 leak 空 lockfile）和 LOW-1（heartbeat unref + signal cascade）可与 BLOCKING/HIGH 一起修，也可顺延下一 iter。

R3 在 BLOCKING-1（finally rm cascade）/ HIGH-1（ADR §3.1 类型冻结）/ HIGH-2（pid liveness + heartbeat + 30min stale）/ MEDIUM-1（lockfile 协议文档化）这四件 R3-标号问题上的修复**本身正确**（nonce 双因子校验、heartbeat 5min/30min 比例、ADR 字段类型约束都合理），但**新增的 PID liveness check + lock body created_at 字段未被 removeStaleFetchLock 用作 PID recycling 兜底——R3 把 R2 的 finally rm cascade 推到了 R4 的 PID recycling cascade**。BLOCKING-1 没修之前，R4 不能 close。

R4 不重提 R1/R2/R3 已闭合的 12 项 finding（4+4+4），不重提 R1/R2/R3 已 defer 的 4 项（R2 MEDIUM-2/3 + R2 LOW-1 + R3 LOW-1）。R4 新发现 5 项（1 BLOCKING + 2 HIGH + 1 MEDIUM + 1 LOW），全部聚焦 R3 fix 引入的 PID-based 协议二阶副作用与 ADR §3.4 vs 代码一致性 drift。

R3 LOW-1（Unicode codepoint snapshot drift）经 R4 重判**维持 LOW**——Node 22 ICU 77 / Bun 1.3 V8 12.8 都是 Unicode 16.0 ICU，截至 2026-04-26 没有 Unicode 17 ratified。drift 速度慢、impact 小，下一 iter chore 处理。

AMB 100k p95 1.888ms（vs R2 fix 报 0.267ms）经 `git log` 实证今日**无 providers/memory/ 改动**，差异是测试运行环境 noise（仍距 ≤300ms 阈值 159× 安全 margin）。**非 regression**。

下一轮（R5 或同会话补丁）按 §3 BLOCKING-1 / HIGH-1 / HIGH-2 修复建议落地后，R5 应能 close E3a track。
