# 2026-04-20 Code Ultra-Review (Opus 4.7)

**范围**：`packages/agent-core/src/**` + `providers/memory/src/**`（非 test）
**评审人**：Opus 4.7（继 2026-04-17 文档 ultra-review 之后的代码层补完）
**触发**：用户最初请求 = "已经写好的代码你也 ultrareview 一遍，并且解决所有的问题"
**前置**：文档层 186 findings 已全部回写（D-11..D-19 已落）

## 方法

- 只审**非 test** 源文件（35 个 TS + 6 个 Python，约 3.5k LOC）
- 用 Opus 4.7 视角：假设 LLM 可被 prompt-inject、MCP server 可被劫持、文件系统/网络存在敌对输入
- 不审已知的 spec 未实现部分（如 OTel、多 MCP 热注册），只审**已有代码的缺陷**
- 与前轮 reviews（Ultra-Review 2026-04-17、Delta Audit 2026-04-20、Opus 4.7 Revisit 2026-04-20）去重

## 汇总

| Severity | 数量 | 代表性 |
|----------|------|-------|
| 🔴 CRITICAL | 3 | maxTurns 默认无界 / mcp env spawn bypass / shell_exec 无 executable allowlist |
| 🟠 HIGH | 10 | mcp disconnect race / file_write authorize 顺序 / web_fetch header 泄漏 / Python reset 阻塞 event loop |
| 🟡 MEDIUM | 8 | checkpoint 只在 final 保存 / tokenize 语义混淆 / globToRegExp 不支持 `**` |
| ⚪ LOW | 5 | file_read 大文件 OOM / FTS5 rebuild 启动慢 / getAllTools N² |
| **合计** | **26** | |

---

## CRITICAL

### C-01 🔴 `maxTurns` 默认 `Infinity` + 无 token/cost budget
**文件**：`packages/agent-core/src/loop.ts:84`
```ts
const maxTurns = config.maxTurns ?? Number.POSITIVE_INFINITY;
```
**问题**：
- REPL 或集成方若忘传 `maxTurns`，单次会话可跑无限 turn
- 没有累积 token 预算（`response.usage` 仅日志，不累加、不判断）
- prompt injection 或 tool-call 死循环会烧光 API 配额
- spec 层多处承诺"token 预估 + 余量不足建议拆分"（`project_token_estimation` memory、04-Planning spec），代码零落实

**修复**：
1. `maxTurns` 默认改 50；同步调 `repl.ts` 传显式值
2. 新增 `maxTotalTokens?: number` config（默认 200_000），每轮累计 `response.usage.inputTokens + outputTokens`，超限 throw
3. Iter C Planning 引入 `cost-estimator` 时对接此 budget 钩子

**影响范围**：agent 跑 SWE-bench 等长轨迹任务时必须有此防线；否则 E2 harness 会出现"一个 bug task 吃光 $100 额度"。

---

### C-02 🔴 MCP spawn allowlist 允许 `/usr/bin/env`，可绕过 shell 封禁
**文件**：`packages/agent-core/src/tools/mcp-client.ts:18-43`
```ts
const ALLOWED_PATH_COMMANDS = new Set(["bun", "node", "npx", "python", "python3", "uv"]);
const ALLOWED_ABSOLUTE_COMMAND_PREFIXES = ["/bin/", "/opt/homebrew/bin/", "/usr/bin/", "/usr/local/bin/"];
const DISALLOWED_SHELL_EXECUTABLES = new Set(["bash", "cmd", "dash", "fish", "powershell", "pwsh", "sh", "zsh"]);
```
**问题**：`basename("/usr/bin/env") === "env"`，不在 `DISALLOWED_SHELL_EXECUTABLES`，在 `/usr/bin/` 绝对路径白名单内 → 通过校验。
- 攻击者（污染 config / 动态 MCP 热注册）可 `command: "/usr/bin/env", args: ["bash", "-c", "rm -rf $HOME"]`
- DISALLOWED_SHELL_ARGS 里的 `-c` 校验会拦 args 中的 `-c` ✅（line 89-94）— 但这是二级防御。env 在白名单本身就是主防御失效。
- 同类风险候选：`/usr/bin/xargs`、`/usr/bin/timeout`、`/usr/bin/perl`、`/usr/bin/awk`、`/usr/bin/ruby`（basename 都能通过）

**修复**：
1. 把 `ALLOWED_ABSOLUTE_COMMAND_PREFIXES` 改白名单模式（只接受具体路径 `/usr/bin/bun`、`/opt/homebrew/bin/uv` 等），不接受"前缀 + 任意 basename"
2. 保留 `DISALLOWED_SHELL_EXECUTABLES` 作为二级拒绝列表
3. 显式加测试 `validateMCPServerConfig({ command: "/usr/bin/env", args: ["node", "x.js"] })` 必须抛错

---

### C-03 🔴 `shell_exec` 无 executable allowlist，依赖单层 WriteAuthority confirm
**文件**：`packages/agent-core/src/tools/builtin/shell-exec.ts:287-332`
**问题**：
- `tokenizeCommand("bash -c '...'")` → `["bash", "-c", "..."]`
- `findBlockedCommandReason` 只拦 `eval` 和 `rm -rf /` 字面匹配
- `DISALLOWED_SHELL_ARGS`（`-c` / `/c`）在 `mcp-client.ts` 有定义，但 **未在 `shell-exec.ts` 使用**
- 依赖 WriteAuthority 单点 confirm — 与 07-safety spec 的 "2-stage classifier + Two-Strike Rule" 完全未对齐（D-07 承诺 but 未实装）
- `auto-medium` 模式下 `high` risk 仍 confirm，UX 上用户面对 `bash -c 'long_script'` 极易疲劳同意

**修复**：
1. 引入可选 `executableAllowlist: string[]`（默认 `["ls", "cat", "grep", "git", ...]`）；不在列表内的命令默认 riskLevel 提升为 `critical`（强制 confirm 不可跳过）
2. 在 `findBlockedCommandReason` 加 shell wrapper 拦截：若 `executable` basename ∈ `{bash, sh, zsh, fish, dash, cmd, pwsh, powershell}` 且 argv 含 `-c` / `/c` → block
3. 扩充 fork-bomb / `dd if=/dev/zero of=/dev/sd*` / `:(){:|:&};:` 的 regex 拦截
4. D-07 spec 落实：Iter C 接入 classifier 后本条降级为 MEDIUM

---

## HIGH

### H-01 🟠 MCP disconnect 与 in-flight callTool 的 race
**文件**：`mcp-client.ts:278-286`
**问题**：`disconnect()` 立即把 `isConnected=false` 并 close transport，但没等正在 `await` 的 `callTool`。in-flight 调用拿到部分响应或 hang 直到外层 timeout。没有 in-flight set / AbortController 协调。
**修复**：维护 `pendingCalls: Set<AbortController>`，`disconnect()` 先 `controller.abort()` 全量 + await 所有 settle。

### H-02 🟠 `file_write` authorize 顺序：sensitive check 在 confirm 之后
**文件**：`tools/builtin/file-tools.ts:344-362`
**问题**：先 `await authority.authorize(...)` 再检查 `pathIsSensitive`。用户面对 confirm 提示同意后才看到 "Writing sensitive file is not allowed" — 授权流断链，浪费用户操作。
**修复**：把 `if (pathIsSensitive) return error` 上提到 authorize 之前；authorize 时已知 sensitive 则 riskLevel=`critical` 或直接 deny。

### H-03 🟠 `web_fetch` 不限制 headers，存在凭证泄漏到任意域的风险
**文件**：`tools/builtin/web-fetch.ts:275-326`
**问题**：`headers` 参数完全透传；LLM 可以生成 `{"Authorization": "Bearer <stolen>", "Cookie": "..."}` 发送到 attacker-controlled URL（即使 SSRF 已防公网可达）。
**修复**：header 白名单 `{accept, accept-language, user-agent, content-type}`；`Authorization`/`Cookie`/自定义 `X-*` 按配置 opt-in。

### H-04 🟠 `web_fetch` 无 Content-Length / Content-Type pre-check
**文件**：`tools/builtin/web-fetch.ts:365`
**问题**：`response.text()` 对 50MB JSON / 二进制 gzip 一律吞进内存后再 truncate。没 `Content-Length` 硬拦，也没对 `content-type` 白名单（`image/*` 应拒绝）。
**修复**：
- `response.headers.get("content-length")` > 10MB 直接 reject
- `content-type` 仅允许 `text/*` / `application/json` / `application/xml` / `application/x-www-form-urlencoded`

### H-05 🟠 Python `OmniMemStore.reset()` 同步阻塞 event loop
**文件**：`providers/memory/src/omnimem/store.py:139`
**问题**：`reset()` 是同步方法（非 async / 非 to_thread），持有 `self._lock` 并跑 `BEGIN IMMEDIATE` + `DELETE` — 从 async 上下文（MCP handler）调用会阻塞事件循环。
**修复**：加 `async def reset(self)` 包装 `asyncio.to_thread(self._reset_sync)`。

### H-06 🟠 Checkpoint 只在 `finishReason !== "tool_calls"` 时保存
**文件**：`loop.ts:128-136`
**问题**：一个 10 步长任务在第 7 步崩溃 → 前 7 步状态未保存。Supervisor D-06 非阻塞架构依赖 mid-task checkpoint；SWE-bench 长轨迹依赖 partial recovery。
**修复**：tool call 循环每 N 步（默认 5）或每 30s 增量 save，state 加 `pendingToolCalls` 字段。

### H-07 🟠 Loop 无 OTel / trace id 钩子预留
**文件**：`loop.ts:88-194`
**问题**：spec 08-observability 承诺 "每次 LLM 调用 / 工具调用 / agent loop 一个 span"，但 loop 内只有 pino debug log，没有 `tracer.startActiveSpan` 钩子接口。等 Iter D 再加会侵入式重写。
**修复**：现在就加 `config.tracer?: Tracer` 可选接口（no-op 默认），在 LLM call / tool call 外包 span。接口早于实现。

### H-08 🟠 MCP 接入 `toolResult` 中 `isError` 只看顶层 JSON
**文件**：`tools/mcp-client.ts:144-156, 158-187`
**问题**：`detectErrorPayload` 只解析顶层 JSON 的 `"error"` 字段。实际 MCP server 常返回 `{"ok": false, "message": "..."}` 或结构化错误不含顶层 `error`。误判成功。
**修复**：尊重 SDK 原生 `result.isError`（已在 187 行用了），额外 JSON 检测不要覆盖；可选 `errorDetection: "strict" | "heuristic"` 配置。

### H-09 🟠 `WriteAuthority.auditLog` 抛错会让 `authorize` 失败
**文件**：`safety/write-authority.ts:133-141`
**问题**：`auditLog` 是 side-channel，不应影响授权结果。当前 `this.auditLog?.(...)` 抛错会直接 propagate。
**修复**：`try { this.auditLog?.(...) } catch (err) { logger.error(...) }`。

### H-10 🟠 `registry.ts` register 失败路径下 existing tools 未清理
**文件**：`tools/registry.ts:94-112`
**问题**：若 `existingClient.disconnect()` 失败 → throw → 新 client 也 disconnect，但 `existingClient` 对应的 `serverToolNames` / `serverTools` 未清。下次 `findTool` 仍返回已断连的 tool。
**修复**：finally 块里无条件 `this.clearServerTools(entry.id)`，再决定重装或留空。

---

## MEDIUM

### M-01 🟡 loop `turnCount` 语义混淆，checkpoint 计数不反映真实轮次
**文件**：`loop.ts:14-28, 84-102`
**问题**：`turnCount` 在函数内从 0 起；`buildCheckpointState` 用 `state?.turnCount ?? 0 + 1`。重启会话后 `config.state.turnCount` 和实际 loop 内已跑 turn 数不同步。
**修复**：`turnCount` 初始化为 `config.state?.turnCount ?? 0`；每次 LLM call 前 +1。

### M-02 🟡 Loop 142-146 的第二处 `maxTurns` 检查是死代码
**文件**：`loop.ts:142-146`
**问题**：`turnCount += 1` 在第 102 行；142 行重复检查没有再次 `+= 1`，条件恒不成立（除非 Infinity 情况）。
**修复**：删除，仅保留 102 行之后的 while 顶部检查。

### M-03 🟡 `consecutiveBlockedToolOutputs` 跨轮累积，一轮多 block 直接 abort
**文件**：`loop.ts:86, 176-192`
**问题**：变量在 while 外声明，一轮内 3 个 tool 都被 block 立刻 abort。可能是设计，但 spec 未明确"三次失败"是 per-turn 还是 global。
**修复**：添加测试固化语义；或文档明确"global counter"。

### M-04 🟡 shell_exec `maxBuffer: 1024 * 1024` 对 SWE-bench 过小
**文件**：`tools/builtin/shell-exec.ts:212`
**问题**：1MB 上限对 `git diff`、长 log、npm install 输出很容易溢出 → execFile 抛 ENOBUFS。
**修复**：提升至 8MB；或按 options.maxOutputChars × 2 动态设置。

### M-05 🟡 shell_exec env 白名单允许 `SHELL`
**文件**：`tools/builtin/shell-exec.ts:16-25`
**问题**：`SHELL` 变量透传给子进程，若某命令内部再 spawn `$SHELL -c ...` 等于开后门。该列表该走最小权限。
**修复**：删除 `SHELL` 和 `TERM`（除非有 CLI 工具必需，加测试覆盖）。

### M-06 🟡 `file_list` globToRegExp 不支持 `**`
**文件**：`tools/builtin/file-tools.ts:184-188`
**问题**：`*` 全部转为 `.*`，`**` 等同 `*`；用户传 `src/**/*.ts` 不会递归匹配。LLM 很可能这么用。
**修复**：加 `**` 先替换为占位符 → `.*`；或直接文档说明 file_list 不递归、需多次 call。

### M-07 🟡 Python `server.py` 错误 re-raise 未 sanitize
**文件**：`providers/memory/src/omnimem/server.py:21-22, 41-42`
**问题**：`except Exception as exc: logger.error(...); raise` — 原始 sqlite3 error 会通过 stdio 回传给 LLM，可能含 db_path、表名等。
**修复**：logger 记完整错误；raise 统一化 `MemoryOperationError("store failed")` 不带细节。

### M-08 🟡 mcp-client 通过字符串匹配识别 timeout
**文件**：`tools/mcp-client.ts:306-311`
```ts
error.message.includes(`timed out after ${DEFAULT_TOOL_TIMEOUT_MS}ms`)
```
**问题**：改 `withTimeout` 错误文案就会破坏逻辑。重构脆弱。
**修复**：定义 `class MCPTimeoutError extends Error` 做 instanceof 判定。

---

## LOW

### L-01 ⚪ `file_read` 整文件读入内存，大文件 OOM
**文件**：`tools/builtin/file-tools.ts:288`
**修复**：stream by line（小改动，可延后）。

### L-02 ⚪ `_rebuild_fts_index` 每次 OmniMemStore 构造都跑
**文件**：`providers/memory/src/omnimem/store.py:130`
**修复**：加 `schema_version` 表，只在 upgrade 时重建。

### L-03 ⚪ `getAllTools()` 每次 findTool 都 N² 扫描
**文件**：`tools/registry.ts:140-167`
**修复**：加 short-name → tool 的 `Map` 索引，register/unregister 时维护。

### L-04 ⚪ Python `close_sync` 未 commit pending transaction
**文件**：`providers/memory/src/omnimem/store.py:149-155`
**修复**：`self._conn.commit()` 前于 close（virtual safety net，isolation_level=None 已 autocommit，但显式更清晰）。

### L-05 ⚪ loop.ts `logger.warn` 在 while 内每轮触发
**文件**：`loop.ts:79-83`
**问题**：若 `context != null && baseSystemPrompt == null`，while 每轮都进入这个分支并 warn → 日志洪水。
**修复**：warn 移到 while 外，只报一次。

---

## 与 spec 的漂移（非代码 bug，但要标记）

| # | spec | 代码现状 | 处理建议 |
|---|------|---------|---------|
| SD-01 | 07 §2.6.4 "2-stage classifier + Two-Strike Rule" | 未实装 | Iter C 随 Planning 一起做 |
| SD-02 | 08 "OTel span/trace" | 零钩子 | H-07 先加接口 |
| SD-03 | 01 "cost-estimator + 预估 token" | 零实现 | C-01 修复时顺带加 |
| SD-04 | 10 "Idle Evolution opt-in budget" | WriteAuthority 有 origin="idle" 但无 budget counter | Iter F 前不紧急 |
| SD-05 | 03 "Layer 4 = Skill Usage Stats"（D-11 重命名） | OmniMemStore 只有 4 个 tier 枚举，无 `SkillUsageStat` 表 | B3a 落地时加 |

---

## 修复计划（交 Codex 批量处理）

### Wave 1（CRITICAL，本周内）
- **Task #94**：C-01 maxTurns 默认 50 + maxTotalTokens accumulator
- **Task #95**：C-02 MCP allowlist 改精确路径模式 + 加 `env`/`xargs`/`timeout`/`perl` 拒绝测试
- **Task #96**：C-03 shell_exec 加 executable allowlist + shell wrapper `-c` 拦截 + fork-bomb regex

### Wave 2（HIGH，两周内）
- **Task #97**：H-01 + H-02 + H-09 + H-10（安全 / 授权修正合批）
- **Task #98**：H-03 + H-04（web_fetch header / content-type 硬化）
- **Task #99**：H-05 + M-07（Python side）
- **Task #100**：H-06 + H-07（checkpoint 中途保存 + OTel tracer 接口，配合 Iter D 提前）
- **Task #101**：H-08（MCP isError 语义）

### Wave 3（MEDIUM / LOW，Iter C 前清零）
- **Task #102**：M-01..M-06 合批
- **Task #103**：M-08 + L-01..L-05 扫尾

**预计工作量**：CRITICAL 3 条 ≤ 1 day；HIGH 10 条 ≈ 2-3 days；MEDIUM/LOW ≈ 1-2 days。
**验证**：每 Wave 跑 vitest + pytest；CRITICAL 必须加 regression test。

---

## 累计统计

- **2026-04-17 Ultra-Review**（文档）：170 findings
- **2026-04-20 Delta Audit**（文档）：10 findings
- **2026-04-20 Opus 4.7 Revisit**（文档）：6 findings
- **2026-04-20 Code Ultra-Review（本报告）**：**26 findings**（3 CRITICAL / 10 HIGH / 8 MEDIUM / 5 LOW）

**累计全部**：212 findings，文档层 186/186 已修；代码层 0/26 已修（本次新出）。

**下次 review 建议**：
- Wave 1 合并后（~1 周）做一次 CRITICAL regression 复查
- Iter C 开工前做一次"spec↔code drift 对账"
- 定期（3 个月）全量巡检

---

**Last reviewed**：2026-04-20（Opus 4.7，代码层）
