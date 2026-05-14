# Task #16 — Cross-language file lock for user.md

> 状态 / Status:**Plan(实施前)** · 下一 session 起步
> 写于 / Drafted:2026-05-15 autonomous run · Task #14 race-narrowing 落地后
> 关联 / Related:Task #14 commit `40e2914` · `feedback_no_review_loophole.md`

---

## 背景 / Background

Task #14 收掉了**一种** TS/Python user.md race —— Python 端覆盖时把 TS 端追加的 `## Quilin 观察` 段落保留下来。但 cross-review R2 reviewer 实证还有**残余 race**:在 Python 读取 existing → 生成 merged content → atomic rename 这个窗口里,TS 端的一次新追加会被 Python 的下一次写覆盖。

窗口很小(亚秒级),但严格说不安全。本片彻底关闭。

## 三种思路 / Three options

### 思路 A — flock 双向加锁(最直接,工程量中)

- Python:`sync_user_md` 用 `fcntl.flock(fd, LOCK_EX)` 锁 `~/.quilin/user.md.lock` sentinel,读+写都在锁内
- TS:`profile-evolution.ts.appendToProfileSection` 用 `proper-lockfile`(npm 包)或自家 O_EXCL polling 加同一个 sentinel
- 两边都 blocking-with-timeout(5 秒)避免死锁

**Pros:** 思路清晰,POSIX 标准,关闭整个 read-modify-write 窗口。
**Cons:**  
1. 新依赖:`proper-lockfile`(~10KB)或自家 polling 代码;
2. Node 没原生 fcntl,跨平台行为可能微差(Linux 强 POSIX vs macOS BSD vs Windows 完全不同);
3. 锁文件残留(进程崩溃时)需要 stale-lock 清理逻辑。

**预计:~30-40M token + cross-review**

### 思路 B — SQLite 单源(最干净,工程量大)

- TS 把观察改写入 SQLite 的新表 `user_observations(id, text, created_at)`,不再直接 append user.md
- Python `sync_user_md` 读 `user_profiles` + `user_observations` 一起 render,user.md 变成纯渲染产物
- TS profile-evolution.ts 通过 MCP tool 调 quilin-mem `observation_append`(新建)

**Pros:** 架构干净,SQLite 锁是天然单 writer 保护,无残余 race。
**Cons:**  
1. 需要新建 SQLite 表 + 迁移逻辑;
2. quilin-mem 加新 MCP tool(`observation_append`);
3. TS 端 profile-evolution.ts 大改写,不再操作文件;
4. 用户手动修改 user.md 的"## Quilin 观察"段会被 Python 渲染覆盖 → 需要决定是否要"手动覆盖 + 数据库观察"两条来源混合 render。

**预计:~70-90M token + cross-review。架构改动大。**

### 思路 C — Python-only flock(最便宜,半解决)

- 只给 Python sync_user_md 加 `fcntl.flock`,保护同进程内 / 多个观察者信号同时写 user.md 的情况
- TS 端不动,TS-vs-Python race 还在但 Python-vs-Python 关掉了
- 文档里把残余 race 标成 "known + low impact"

**Pros:** ~10M token,无新依赖,无架构改动。
**Cons:** 不彻底,TS append 仍可能被 Python 覆盖。

---

## 推荐 / Recommendation

**先做思路 A,等用户反馈后再决定要不要升级到 B。** A 关掉 90% 的实际场景(用户手 edit user.md 的场景不在 race 路径内),保留架构灵活性。B 是更长线的正确选项但等到真出现 race 投诉再做。

C 是兜底方案 —— 若 token 实在不够走 A,就先 C 把 Python 同进程并发关掉,留 doc 标 known issue 等下次。

---

## 思路 A 实施步骤 / Steps for option A

### A.1 — Python 侧 flock(~10M)

```python
# providers/memory/src/quilin_mem/profile_updater.py
import fcntl
from contextlib import contextmanager

_USER_MD_LOCK_PATH = _USER_MD_DIR / "user.md.lock"
_LOCK_TIMEOUT_S = 5.0

@contextmanager
def _user_md_lock():
    _USER_MD_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(_USER_MD_LOCK_PATH), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        # Non-blocking attempts with backoff up to LOCK_TIMEOUT_S
        deadline = time.monotonic() + _LOCK_TIMEOUT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise TimeoutError("user.md lock acquisition timed out")
                time.sleep(0.05)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

# 包装 sync_user_md 内的 read + write 整段
def sync_user_md(self, profile_id=...):
    ...
    with _user_md_lock():
        # existing read + extract + write
```

### A.2 — TS 侧 lockfile(~10M)

```typescript
// apps/web/lib/profile-evolution.ts
import lockfile from "proper-lockfile";

async function appendToProfileSection(input: AppendInput): Promise<...> {
    const release = await lockfile.lock(input.path, {
        retries: { retries: 100, minTimeout: 50, maxTimeout: 100 },
        stale: 10_000,  // 10s stale lock cleanup
    });
    try {
        // existing read + append logic
    } finally {
        await release();
    }
}
```

依赖:`pnpm --filter @quilin/web add proper-lockfile @types/proper-lockfile`

### A.3 — Tests(~10M)

- Python `test_sync_user_md_lock_timeout`:模拟外部进程拿着锁,verify TimeoutError 被抛出
- Python `test_concurrent_sync_user_md`:开 5 个 thread 同时调,verify 都成功 + 文件最后一致
- TS `test_appendToProfileSection_lock`:同步并发调用,verify 两次 append 都到位
- Integration:TS append + Python sync 交错(用 subprocess 启 Python 一个简单 script),verify 都不丢

### A.4 — Cross-review + commit(~10M + CR)

按硬规则 2 fresh reviewer 0/0。

---

## 不在 scope / Out of scope

- 思路 B 的 SQLite 迁移(延后)
- Windows 兼容性(项目当前 macOS / Linux only)
- 锁等待图形化指示(用户感知不到亚秒级等待)

## 协议 / Protocol

- Python:`uv run pytest providers/memory/tests/test_user_md_mirror.py` 全过
- TS:`pnpm --filter @quilin/web exec vitest run` 全过
- Cross-review:per CLAUDE.md 硬规则,2 fresh reviewer 连续 0 REAL 才能 commit
- Playwright 不强制(无 UI 改动)
