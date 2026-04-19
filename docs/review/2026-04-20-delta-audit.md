# Quilin Agent — Opus 4.7 Delta Audit（2026-04-20）

> **背景**：`2026-04-17` 的 ultra-review（170 findings / 14 CRITICAL / 59 HIGH）之后，2 天内 Codex 推进了 8 个 fix commit。本报告是升级到 Opus 4.7 后的**差分审查**，不重跑全量 subagent 阵列，只做两件事：
>
> 1. **验收**已修 findings 是否真干净（28 条抽样）
> 2. **对抗扫描** delta 本身是否引入新 bug（找到 **1 CRITICAL + 4 HIGH + 5 MEDIUM** 净新增）
>
> **基线 commit**：`6959e28`（ultra-review 基线）
> **HEAD**：`f403f60` + 9 docs commits
> **审查方法**：4 个并行 subagent（security / state+python / dead-code+logic / adversarial delta scan）

---

## 0. TL;DR

- **Batch 2 / FEA-01 的 CRITICAL 修复基本干净**：shell_exec / file-tools / web_fetch SSRF / MCP command allowlist / MCP env 隔离 / maxOutputTokens / MCPRegistry 生命周期 / schema-converter enum fallback 全部 FIXED。
- **HIGH 级尚有 9 条未修**（需派工下一批）：TS-04 / TS-11（anyOf/oneOf/null） / TS-15 / CR-04 / CR-06 / PY-02 / PY-05 / PY-06 / PY-08。
- **P2 死代码 14 条全未修**（CR-01/07/08/09/10 + M-01..13 + TS-07/08/12/16/17）——属预期 backlog，未派工。
- ⚠️ **Delta 自引入 10 条新 finding**（1 CRITICAL + 4 HIGH + 5 MEDIUM），其中 **NEW-01 SSRF 数字 IP 字面量绕过**最危险 —— `http://2130706433/` 或 `http://0x7f000001/` 可能绕过当前 BlockList。

---

## 1. 验收：已修 findings 在 HEAD 的真实状态

### 1.1 Security 组（8 条）

| ID | 原始风险 | 验收结论 | 证据 |
|----|---------|---------|------|
| **SEC-01/TS-02** shell_exec | CRITICAL | **FIXED** | `shell-exec.ts:23-55,119-121` — execFile + argv + MAX_TIMEOUT_MS=60s + BLOCKED_COMMAND_PATTERNS + ALLOWED_ENV_KEYS |
| **SEC-02** tool output scan | CRITICAL | **FIXED**（MEDIUM 加固） | `loop.ts:132-149` — 调 `scanExternalContext`；但 `block` 仅 warn+sanitize，未硬阻断 |
| **SEC-03/04 + TS-05/06** file-tools | CRITICAL | **FIXED**（LOW 加固） | `file-tools.ts:25-30,67-114` — BASENAME + exactSensitivePaths（~/.aws/credentials 等）+ realpath + root 白名单；缺 /etc/\* 绝对路径 deny |
| **SEC-05 + TS-01** web_fetch SSRF | CRITICAL | **FIXED**（MEDIUM 加固） | `web-fetch.ts:11-18,66-106,182-223` — BLOCKED_IPS + unwrapIPv4Mapped + AbortSignal.timeout + redirect:manual(≤3 hop) + body 截断；缺 `fe80::/10` + `0.0.0.0/8` |
| **SEC-06** MCP cmd injection | CRITICAL | **FIXED** | `mcp-client.ts:17-94` — ALLOWED_PATH_COMMANDS + ABSOLUTE_COMMAND_PREFIXES + DISALLOWED_SHELL_EXECUTABLES + DISALLOWED_SHELL_ARGS |
| **SEC-09** MCP env 不继承 | CRITICAL | **FIXED** | `mcp-client.ts:96-103,201` — `createMCPSpawnEnv` 只放 `LOG_LEVEL`/`QUILIN_ENV`；显式传入即阻止 MCP SDK 自动 merge `process.env`；Task #84 可 close |
| **TS-03** maxOutputTokens | CRITICAL | **FIXED** | `llm/client.ts:172-179,206-213` — generateText + streamText 都用 `maxOutputTokens` |
| **PY-04/SEC-08** tier enum | CRITICAL | **FIXED** | `types.py:6` `MemoryTier = Literal["working","episodic","semantic","skill"]` + FastMCP schema 校验 |

**Security 组：8/8 FIXED**（附 5 条 MEDIUM/LOW 加固建议，非阻塞）。

### 1.2 State / Lifecycle / Python 组（14 条）

| ID | 类 | 验收结论 | 备注 |
|----|---|---------|------|
| **CR-02** MCPRegistry.register | HIGH | **FIXED** | `registry.ts:81-117` connect-then-swap + 失败回滚 |
| **CR-03** MCPRegistry.unregister | HIGH | **FIXED** | `registry.ts:119-132` try/catch/finally 保证 map 清理 |
| **CR-04** createDisconnectedResult 语义 | MEDIUM | **PARTIAL** | 仍双用（disconnect + 通用错误），未重命名/加注释 |
| **CR-06** checkpoint `created_at` 不被覆盖 | HIGH | **PARTIAL** | `checkpoint.ts:128-148` UPSERT 仍 `created_at = excluded.created_at` 无条件覆盖；依赖 caller 传入相同 `state.createdAt` 才不退化 |
| **TS-04** callToolWithMetadata 超时 | HIGH | **UNFIXED** | `mcp-client.ts:288-293` 无 `withTimeout` / AbortSignal，MCP 长调用可 hang Agent Loop |
| **TS-10** checkpoint JSON.parse guard | HIGH | **FIXED** | `checkpoint.ts:163-177` + `migrateEnvelope` 结构校验 |
| **TS-11** schema-converter anyOf/oneOf/null | HIGH | **PARTIAL** | enum 已修（3f57744），但 `anyOf/oneOf/null` 仍 `throw` → 阻塞真实 MCP server 注册 |
| **TS-15** better-sqlite3 vs bun:sqlite | MEDIUM | **UNFIXED** | `package.json` 声明 better-sqlite3，运行时用 `bun:sqlite` |
| **PY-01** async 阻塞事件循环 | HIGH | **FIXED** | `store.py:147-175` asyncio.to_thread + `__aenter__/__aexit__` |
| **PY-02** sqlite3 close 路径 | MEDIUM | **PARTIAL** | 有 `close()`，但 prod 路径（直接 `OmniMemStore()`）未走 async with，异常退出仍泄漏 |
| **PY-05** except Exception 吞 MCP 错误 | HIGH | **UNFIXED** | `server.py:22-24,41-43` 仍返回 `{"error": ...}` JSON 字符串，未走 `McpError` / `isError:true` |
| **PY-06** _rebuild_fts_index 事务保护 | LOW | **PARTIAL** | 依赖 sqlite3 隐式事务，未显式 `with self._conn:` |
| **PY-07 / M-17** 模块级 store 单例 | HIGH | **FIXED** | `create_server(store=None)` 工厂 + lifespan 注入 |
| **PY-08** structlog exc_info | MEDIUM | **UNFIXED** | `logging.py` 缺 `format_exc_info` / `ExceptionRenderer` |

**State/Python 组：5/14 FIXED + 4 PARTIAL + 5 UNFIXED**。

### 1.3 Dead code / Logic bugs 组（14 条）

| ID | 结论 | 说明 |
|----|------|------|
| CR-01 / M-04 / TS-08 `* 0` | **UNFIXED** | `budget.ts:83` 死表达式不变 |
| M-05 `shouldExit` | **UNFIXED** | `index.ts:178,197,204-207` fallthrough 仍 unreachable |
| TS-12 workingMessages[0] mutate | **UNFIXED** | `loop.ts:54,72` 原地 mutate |
| M-09 `callTool` 仅测试用 | **UNFIXED** | `mcp-client.ts:266` 生产路径全走 `callToolWithMetadata` |
| M-11 / M-13 zero-consumer | **UNFIXED** | `BuiltinToolOptions` / `PROMPT_CACHE_BOUNDARY` 仍导出 0 消费 |
| M-01 BasicCtx vs ContextAssembler | **UNFIXED** | 二套并存，仍都从 barrel 导出 |
| M-02 Vercel/StreamingLLMClient | **UNFIXED** | 同上 |
| M-03 ContextSource 双定义 | **UNFIXED** | `types.ts:2`（5 字段）+ `source-types.ts:10`（7 字段）同时 re-export |
| CR-09 oversized system | **UNFIXED** | `manager.ts:38-46` first-fit break，用户 system 超 budget 被静默清空 |
| CR-07 LIKE 未转义 | **UNFIXED** | `store.py:162-166` 无 ESCAPE |
| TS-16 / CR-10 | **UNFIXED** | `manager.ts:41` break 非 continue；`router.ts:30-35` 歧义仍报 not found |
| TS-17 / CR-08 | **UNFIXED** | `memory-bridge.ts:29` hardcoded `isExternal:true`；scanner `base64_suspicious` 仍误杀 |
| TS-07 mapFinishReason | **UNFIXED** | `llm/client.ts:126-139` default `"length"` |
| M-10 withDefaultMetadata | **UNFIXED** | `repl.ts:99-105,121` MCP 工具注册为 builtin，绕过 namespace+riskLevel |

**Dead code 组：0/14 FIXED**（P2 backlog，预期）。

---

## 2. Delta 新增 findings（fix 自身引入的回归 / 新攻击面）

### 🔴 NEW-01 [CRITICAL] SSRF 数字 IP 字面量绕过

**文件**：`packages/agent-core/src/tools/builtin/web-fetch.ts:80-90`

```ts
async function defaultResolver(hostname: string): Promise<readonly string[]> {
    if (isIP(hostname) !== 0) {
        return [hostname];
    }
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((r) => r.address);
}
```

**攻击**：
- `http://2130706433/`（127.0.0.1 十进制）：`isIP` 返回 0；`dns.lookup("2130706433")` 在不同 libc 上行为不一致
- `http://0x7f000001/`（127.0.0.1 十六进制）：`dns.lookup` 常返 ENOTFOUND，但 `undici.fetch` 内部 **第二次 DNS 解析**可能自行处理
- `http://0/`（0.0.0.0 路由到 localhost on Linux）：`0.0.0.0/8` 不在 BLOCKED_IPS

**修复**：
1. 在 `defaultResolver` 前加 hostname canonicalization：若不是合法 `isIP` 且不是合法 DNS name（`/^[a-z][a-z0-9.-]*$/i` 必须含字母），reject
2. BlockList 加 `0.0.0.0/8`、`100.64.0.0/10`（CGNAT）、`fe80::/10`（IPv6 link-local）、IPv4-mapped IPv6 私网前缀
3. 使用 `undici.Agent({ connect: { lookup: pinnedLookup } })` 将 `resolveAndCheckIP` 解析到的 IP pin 死，消除第二次 DNS

### 🟠 NEW-02 [HIGH] DNS Rebinding TOCTOU

**文件**：`web-fetch.ts:182-192`

`resolveAndCheckIP` 做一次 DNS，`fetch()` 内部另做一次。恶意 DNS 服务器返回 `TTL=0`，第一次给公网 IP，第二次给 `169.254.169.254` AWS IMDS。

**修复**：与 NEW-01 合并 —— pin 解析结果到 dispatcher。

### 🟠 NEW-03 [HIGH] shell_exec denylist 正则误杀合法命令

**文件**：`shell-exec.ts:23-55`

`BLOCKED_COMMAND_PATTERNS` 中 `/\beval\b/i` 会误杀 `go test ./internal/evaluator/` / `pytest tests/test_evaluation.py`（`evaluation` 含 `eval`）；`;` 在 argv 模式下是合法字符，但全局 regex 扫描会阻断 `git log --pretty='a;b'`。

**修复**：denylist 只检 tokenize 后的 `tokens[0]`，或因 `execFile` 已禁 shell metachar 而完全移除。

### 🟠 NEW-06 [HIGH] tool output injection scanner 误杀整段合法输出

**文件**：`loop.ts:131-149` + `injection-scanner.ts:76-82`

- `block` 严重级时 `sanitizedContent = ""`，全内容清空
- `credential_exfiltration` 正则 `/\b(print|show|reveal|output|display)\s+(your\s+)?(system\s+prompt|...)/gi` 会在 LLM web_fetch Anthropic 安全博客 / GitHub README 时误触
- 结果：LLM 收到空 tool result → 不知道为何 → 重试循环烧 token

**修复**：
1. `block` 只替换匹配 span 而非整段；插入 `[REDACTED: …]` 标记让 LLM 知情
2. 可信工具白名单（`file_read` of workspace files 跳过扫描）
3. 加 per-session block 计数器，N 次触发后整轮 abort

### 🟠 NEW-09 [HIGH] OmniMemStore 并发写竞态

**文件**：`providers/memory/src/omnimem/store.py:99-100` + `_store_sync`

`check_same_thread=False` 允许 `asyncio.to_thread` 工作，但 sqlite3 Connection 对并发写不是线程安全的。`_store_sync` 两条 INSERT（主表 + FTS）未在事务中，并发可能 `SQLITE_BUSY` 或 FTS 索引脱节。

**修复**：
1. `_store_sync` 外层加 `threading.Lock()`
2. 两条 INSERT 用 `with self._conn:` 或显式 `BEGIN … COMMIT` 包起
3. `sqlite3.connect(db_path, isolation_level=None)` + WAL 模式并发更稳

### 🟡 NEW-04 [MEDIUM] shell_exec 不支持 env 赋值前缀

`NODE_ENV=test bun test` 会被 tokenize 成可执行文件 "NODE_ENV=test" → ENOENT 失败，错误消息没有提示。

**修复**：检测 `KEY=VALUE` 前缀 → 剥离到 env，或返回显式错误 "use env field"。

### 🟡 NEW-05 [MEDIUM] shell_exec PATH 未加固

父进程 `PATH` 原样透传。若父进程被注入 `PATH=/tmp/evil:/usr/bin`，LLM 调用 `git` / `ls` 会走恶意路径。

**修复**：固定默认 `PATH=/usr/local/bin:/usr/bin:/bin`，除非配置显式允许覆盖。

### 🟡 NEW-07 [MEDIUM] scanExternalContext 无循环熔断

`loop.ts` 仅 `logger.warn` 后继续循环，攻击者可控一个 tool output 让 Agent 无限循环（空内容 → hallucination → 新 tool call → 同内容）。

**修复**：会话级 `block` 事件计数器，≥3 次 abort 并上报用户。

### 🟡 NEW-08 [MEDIUM] 文件枚举经错误消息泄露

**文件**：`file-tools.ts:198-208`

`read` 模式下 `realpath` 失败 → 原始 `ENOENT: no such file or directory, realpath '/etc/shadow'` 冒泡，LLM 可枚举系统文件。`/etc/shadow` 未在敏感列表（非 $HOME 下）。

**修复**：敏感列表加 `/etc/shadow`, `/etc/passwd`, `/etc/sudoers`, `/root/**`；统一错误消息 "Path not accessible"。

### 🟡 NEW-10 [MEDIUM] create_server 闭包首次注入胜出

**文件**：`providers/memory/src/omnimem/server.py`（`create_server`）

Lifespan 未启动前的 tool call 会创建第二个 `OmniMemStore()` 缓存到闭包；lifespan 启动后两条路径指向同一文件但两条连接，打破 isolation 意图。

**修复**：Lifespan 作为唯一真理来源；ctx 缺失时 raise 而非 lazy 创建。

---

## 3. Spec ↔ 实现对齐

| 位置 | 问题 | 动作 |
|------|------|------|
| `07-safety-guardrails/threat-model.md TH-03` | 说"零继承 env 见 Task #84 (backlog)"，但 `createMCPSpawnEnv` 已实现零继承 | 更新 spec 或 close #84 |
| `threat-model.md TH-06` | 列 blocklist `127/8, 10/8, 172.16/12, 192.168/16, 169.254/16`，缺 `0.0.0.0/8`、CGNAT、`fe80::/10` | spec + 实现同步补齐（NEW-01 修复项） |
| `readme.md` Layer-1 "扫描外部上下文" | 暗示 scan context sources，实际只 scan tool outputs；也未 `<external_context>` XML 隔离 | 实现补 XML 隔离 或 降级叙事 |

---

## 4. 优先级分档 & 派工建议

### P0 — 本轮必修（阻塞 Beta 对外）
| # | 来源 | 工作量 |
|---|------|--------|
| **NEW-01** SSRF 数字 IP 绕过（含 NEW-02 DNS rebinding 合并修） | delta | 4h |
| **TS-11** anyOf/oneOf/null fallback | 原 review（PARTIAL） | 2h |
| **TS-04** callToolWithMetadata timeout | 原 review（UNFIXED） | 1h |

### P1 — 下迭代必修
| # | 来源 | 工作量 |
|---|------|--------|
| **NEW-06** tool output scanner 误杀 + 熔断（NEW-07） | delta | 3h |
| **NEW-09** OmniMemStore 并发锁 + 事务 | delta | 2h |
| **CR-06** checkpoint created_at DB 层强制 | 原 review（PARTIAL） | 1h |
| **PY-05** MCP error 语义走 McpError | 原 review（UNFIXED） | 1h |
| **NEW-03** shell_exec denylist 只检 tokens[0] | delta | 1h |
| **NEW-08** 敏感路径加 /etc/\* + 统一错误 | delta | 1h |

### P2 — Iter C/D 清理
- 原 review 的 14 条 dead code / logic bugs（CR-01/07/08/09/10 + M-01..13 + TS-07/08/12/16/17）
- NEW-04 / NEW-05 / NEW-10
- PY-02 / PY-06 / PY-08 / TS-15 / CR-04

### P3 — Spec 对齐（纯文档）
- threat-model.md TH-03 更新 "#84 已 close"
- threat-model.md TH-06 blocklist 补齐
- readme.md Layer-1 叙事对齐实现

---

## 5. 用户决策项

1. **P0 3 条是否立即派 Codex**（NEW-01 + TS-11 + TS-04）？
2. **P1 6 条是否排 #83/#84 后的下一批**？
3. **P3 spec 对齐**：Claude 直接做（文档变更）？
4. **Task #84** 能否 close？（`createMCPSpawnEnv` 已实现零继承 env）

---

**Review 元信息**
- 执行日期：2026-04-20
- Reviewer：Opus 4.7 + 4 并行 subagent（security / state+python / dead-code+logic / adversarial delta）
- 代码基线：`f403f60`（HEAD）vs `6959e28`（ultra-review baseline）
- 前置报告：[`2026-04-17-ultra-review.md`](./2026-04-17-ultra-review.md)
- 下一步：用户 decision → Codex 派工 → 按 P0/P1 分批 commit
