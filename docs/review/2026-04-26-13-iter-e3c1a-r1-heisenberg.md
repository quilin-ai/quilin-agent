# Iter E3c1a R1 Cross-Track Review — Heisenberg

**Reviewer**: Heisenberg（独立 subagent，不复用 E3a R1-R5 / E3b R1-R2）
**Target commit**: `976be69` (E3c1a first-cut)
**Date**: 2026-04-26
**Scope**: 仅 commit 976be69 引入的 15 files / +1989/-16 改动

## 1. E3c1a first-cut delta 摘要

E3c1a 落了"fixture-trajectory only"的多轮 BFCL 评分链路：

- **fetch CLI**：`fetch-benchmark.ts` 增 `bfclV4SupportedCategories = AST + multi-turn` + multi_turn 数据/可能答案/fixture trajectory + pinned checker bundle（`multi_turn_eval/` 子树 + `constants/executable_backend_config.py`），共 17 个 Python 文件，sha256 入 manifest.attachments
- **loader**：`bfcl-v4-multi-turn.ts` 从 mixed bfcl-v4 cache 反序列化 `general_category=multi_turn` 行；AST loader (`bfcl-v4.ts:87`) 加 `isMultiTurnLine` skip；双向跳过
- **scorer**：`bfcl-v4-multi-turn.ts` spawn `python3 scripts/bfcl-multi-turn-checker.py`，subprocess 边界含 timeout (默认 10s) + appendBounded 1MB cap + bundle sha256 verify
- **submission**：`bfcl-v4-multi-turn-jsonl.ts` 沿用 `serializeFiles?` 不落盘 + 三标位 `partial_eval=true / official_parity=false / stateful_eval=false`
- **ADR-010 §3.1**：同步 fixture-only wire contract 注释

## 2. R1 必查项结果

### A. Python checker bundle 最小闭包 — **FAIL**
拉取 pinned upstream `multi_turn_checker.py` (`f7cf735`) 实证：
- `multi_turn_checker.py:1` → 仅 import `multi_turn_utils`（已 bundle 覆盖）
- `multi_turn_utils.py:1-7` → stdlib (`copy/importlib/inspect/json/re`) + `bfcl_eval.constants.executable_backend_config`（已覆盖）
- 但 `executable_backend_config.py:18-31` 的 `CLASS_FILE_PATH_MAPPING` 引用 12 个 backend，bundle 只装 8 个；缺 `web_search` / `memory_kv` / `memory_vector` / `memory_rec_sum`。当前 in-scope 数据 0 row 触及（已在 finding 中分析，PASS for current scope，但 latent gap）
- **`func_source_code/math_api.py:5` `import mpmath`**——第三方包，不在 stdlib，bundle 不装，repo + docs grep 0 命中。**多轮数据每 category 25 行 involved_classes 含 `MathAPI`，× 4 cat = 100 row 必命中**

### B. Python subprocess 边界 — **PARTIAL PASS**
- timeout：`bfcl-v4-multi-turn.ts:33` `DEFAULT_CHECKER_TIMEOUT_MS=10_000`、186-192 SIGKILL — PASS
- output buffer cap：`appendBounded` 1MB — PASS（但 char/byte mismatch 见 MEDIUM-1）
- DockerSandbox python3：scorer 在 host 进程 `spawn(pythonExecutable, …)` 不进 sandbox — N/A
- signal/orphan：parent 退出未注册 SIGINT/SIGTERM 转发 — 见 HIGH-2

### C. Mixed bfcl-v4 cache 双向跳过 — **PASS**
- AST loader `bfcl-v4.ts:87-90` skip `general_category=multi_turn`
- multi-turn loader `bfcl-v4-multi-turn.ts:74-77` skip 非 `general_category=multi_turn`
- fetch CLI `bfclV4SupportedCategories = AST + multi_turn` 严格闭合，无第三类（hallucination/agentic 当前不 fetch）— 无 silent loss

### D. 三标志位 (partial_eval / official_parity / stateful_eval) — **PASS**
- task.metadata：`bfcl-v4-multi-turn.ts:174-179` 三标齐
- submission manifest：`bfcl-v4-multi-turn-jsonl.ts` 同步标位（已通过测试覆盖）
- E3b AST adapter 不受影响（未改 `bfcl-v4-jsonl.ts`）— grep 实证

### E. Pinned bundle sha256 verification — **PASS**
- `verifyCheckerBundle` `bfcl-v4-multi-turn.ts:142-169` 校验所有 17 个 `checkerSupportFiles` sha256 + size_bytes
- mismatch fail-loud（throw Error），无 silent fallback
- 测试覆盖：`bfcl-v4-multi-turn.test.ts:313-349` 覆盖 missing entry / sha256 mismatch 两路径

### F. code-review-graph 19 untested 验证 — **PASS（误报）**
`fetchBfclV4CheckerFilesIfNeeded` / `bfclV4SupportFilesComplete` 被 `tryReadValidManifest` 路径在 `fetch-benchmark.test.ts` 间接覆盖（150+ 行新测试覆盖 manifest reuse + sha256 mismatch invalidation）— graph per-symbol 未识别为间接调用

### G. R1 fix regression — **PASS**
`docker.test.ts` 仅 +14 行无 behavior delta；E3a 已闭合 finding（attachment sha256 / Infinity-sentinel / Lockfile finally rm / pid liveness 等）grep 未受影响；E3b Lorentz 闭合的 `serializeFiles?` 模式被 multi-turn submission 复用

### H. R1 大局判断
plan §5 部分 PASS，但 BLOCKING-1 阻止 close：mpmath 缺失 → MathAPI 100% 静默打分错误。建议 R1 **fix-pass-needed**

## 3. Findings

### BLOCKING-1：mpmath 缺失 + 静默 score=0 级联（assumption violation + cascade）
**file:line**: `benchmarks/scripts/fetch-benchmark.ts:89-107`（bundle 列表）+ `benchmarks/scripts/bfcl-multi-turn-checker.py:64-79`（exit-0 catch-all）+ `benchmarks/src/scorers/bfcl-v4-multi-turn.ts:92`（passed 计算）

**实证链**：
1. 上游 `func_source_code/math_api.py:5` `import mpmath`（`curl f7cf735` 验证）
2. 我方 bundle 列表（`fetch-benchmark.ts:99-107` + scorer `checkerSupportFiles:35-53`）含 `math_api.py` 但**未声明 mpmath 依赖**（`grep -rn 'mpmath' docs/ benchmarks/` 0 命中）
3. `multi_turn_utils.execute_multi_turn_func_call` 通过 `importlib.import_module(CLASS_FILE_PATH_MAPPING[class_name])` 动态加载 → MathAPI 必触发 `import mpmath` → host Python 未装则 `ModuleNotFoundError`
4. 上游 BFCL v4 多轮数据 4 categories × 25 involved=MathAPI = **100 行**（`curl + jq` involved_classes 频次实测）
5. wrapper `bfcl-multi-turn-checker.py:64-79` `except Exception` 捕 ModuleNotFoundError → 输出 `{valid:false, score:0, breakdown.error_type:"quilin_checker_adapter_error"}` → **return 0**（exit code 0）
6. TS scorer `bfcl-v4-multi-turn.ts:92` `passed = response.valid === true || response.score === 1` → 仅看顶层字段，**不查 `breakdown.error_type`** → 与"模型答错"完全不可区分
7. 结果：MathAPI 子集 100% 假阴性 → leaderboard 数字偏低 ~12.5% → 调试无信号

**Confidence**: 0.92。完整可复现：拆 mpmath → run 任一 MathAPI fixture → 看 breakdown.error_type vs passed 永 false。

**修复建议**：
- (a) `fetch-benchmark.ts` 在 bundle 写入后做 import-probe（spawn `python3 -c "import mpmath; import bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker"`），失败 fail-loud + 提示 `pip install mpmath`
- (b) `bfcl-v4-multi-turn.ts` 在 `error_type === "quilin_checker_adapter_error"` 时 throw（区分 env 错 vs 模型错）
- (c) docs/planning/2026-04-26-05-iter-e3c1a 加 prereq 章节列出 host Python 必备包（mpmath；`pyproject.toml` 或 `requirements-bench.txt`）

### HIGH-1：失败模式坍缩——wrapper 把 env 错误投影成 score=0
**file:line**: `benchmarks/scripts/bfcl-multi-turn-checker.py:64-79` + scorer 92

import 错、JSON 解析错、unsupported step、bundle 路径错、stdin 截断——所有走同一 `score=0/valid=false` 出口。scorer 不 inspect `breakdown.error_type`。BLOCKING-1 仅是其中一类。

**Confidence**: 0.88。`grep -nE 'error_type|breakdown' benchmarks/src/scorers/bfcl-v4-multi-turn.ts` 实证 scorer 无判别。

**修复建议**：scorer 把 `error_type === "quilin_checker_adapter_error"` 当 throw 而非 score=0；或 wrapper 对 import 错单独 exit code（如 2）让 spawnCheckerProcess 走 `code !== 0` reject 分支（第 213-219 行）

### HIGH-2：parent SIGINT/SIGTERM 不转发——subprocess orphan
**file:line**: `benchmarks/src/scorers/bfcl-v4-multi-turn.ts:178-225`

`spawnCheckerProcess` 仅在 timeout 触发 `child.kill("SIGKILL")`。父 TS 进程被外层 ctrl+C / `process.exit()` / unhandled rejection 终止时，child Python 不会被信号转发（无 `process.on("SIGINT", …)` 注册转发）。runner 跑 1000 task 时若用户中断，可能积累 1000 个 orphan Python 进程持有 cache fd。

**Confidence**: 0.78。Node 默认行为：父死 child 不死（除非 child stdio inherit 且 detached false 仍可能继续）。grep 未见信号转发代码。

**修复建议**：spawn 后 `const onParentExit = () => child.kill("SIGTERM"); process.once("SIGINT", onParentExit); process.once("SIGTERM", onParentExit);` close 时 `removeListener`

### MEDIUM-1：appendBounded char/byte mismatch
**file:line**: `benchmarks/src/scorers/bfcl-v4-multi-turn.ts:227-233`

`Buffer.byteLength(next, "utf8")` 测字节，`next.slice(0, MAX_CHECKER_OUTPUT_BYTES)` 按 UTF-16 code units 截。中文 trace 或 emoji 多字节字符可能：(a) 截断超过宣称的 1MB（按字符 1MB ≈ 字节 3MB）；(b) 切到代理对中间产生无效 surrogate。breakdown 含上游 step error_message 时可能误截。

**Confidence**: 0.72。对 ASCII 输出无问题，对多字节 trajectory 风险存在。

**修复建议**：`Buffer.from(next, "utf8").subarray(0, MAX).toString("utf8")` 或先决断累计字节再丢弃后续 chunk

### MEDIUM-2：unbundled web_search / memory_* 模块的 latent guard gap
**file:line**: `benchmarks/scripts/fetch-benchmark.ts:89-107`（bundle whitelist）+ `executable_backend_config.py:28-31`

当前 in-scope 4 cat × 数据 0 row 触及 `WebSearchAPI` / `MemoryAPI_*`（`curl + jq involved_classes` 实证）。但若上游在 `f7cf735` 之后或 E4 加 hallucination/agentic 拉新数据 → 同 BLOCKING-1 模式静默坍缩到 score=0。

**Confidence**: 0.65（基于"未来变更可能"，非当下 bug）

**修复建议**：在 loader (`bfcl-v4-multi-turn.ts:148`) `toBenchmarkTask` 时校验 `record.involved_classes ⊂ {GorillaFileSystem, MathAPI, MessageAPI, TwitterAPI, TicketAPI, TradingBot, TravelAPI, VehicleControlAPI}`，越界 fail-loud 而非交 Python 报 import error

### LOW-1：error_type 字面量未常量化
**file:line**: `bfcl-multi-turn-checker.py:72` `"quilin_checker_adapter_error"`

字面量未在 TS 侧导出，scorer 修复 HIGH-1 时容易跑偏字面量。

**Confidence**: 0.5

## 4. R1 conclusion

**fix-pass-needed**。BLOCKING-1（mpmath silent score=0）必修才能 close R1，HIGH-1/-2 强烈建议同批改完。R2 由独立 subagent 复核 mpmath probe + scorer error_type 区分 + signal forwarding 三处。
