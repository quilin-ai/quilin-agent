# Iter E3b R2 Cross-Track Review — Schrödinger

**Reviewer**: Schrödinger（独立 subagent，不复用 E3b R1 Lorentz / E3a R1-R5）
**Target commits**: `d0d02e3` (R1 review) + `c8e221f` (R1 fix)
**Date**: 2026-04-26
**Scope**: 仅 commit `c8e221f` 引入的改动（9 files / +890/-12）+ ADR-010 §3.1 修订
**Goal**: confirm close E3b

## 1. R1 fix delta 摘要

`c8e221f` 关闭 R1 三条 finding：

- **BLOCKING-1**：`SubmissionAdapter` 增加 optional `serializeFiles?: (results, runId) => ReadonlyMap<path, content>`；新增顶层 `serializeSubmissionFiles(adapter, results, runId)` helper，未实现 `serializeFiles` 时回退到单文件 `serialize` + `filename` 路径。`bfcl-v4-jsonl` 实现 `serializeFiles`：写 `bfcl-v4/<runId>/manifest.json` + `bfcl-v4/<runId>/result/<model>/<general_category>/BFCL_v4_<category>_result.json` per-category file。manifest 通过新参数 `runId` 让 `result_files` 指向真实路径而非 `<run_id>` 占位符。
- **HIGH-1**：port BFCL Java/JavaScript type converter 至 `bfcl-v4-ast.ts`：新增 `convertActualValue` / `convertJavaValue` / `convertJsValue` / `parseJavaArray` / `parseJavaArrayList` / `parseJavaHashMap` / `parseJsArray` / `parseJsObject`，从 `task.inputs.function_definitions[*].parameters.properties[*].type/items.type` 读 schema 后路由 scalar/array/object 转换。
- **MEDIUM-1**：ADR-010 §3.1 同步实际 BFCL v4 wire — `inputs.{question, messages, function_definitions}` + `expected.{ground_truth, expected_tool_calls, category, general_category}` + `metadata.{partial_eval, official_parity, source_commit}` + `scorer_type="bfcl-v4-ast"`。

## 2. R2 必查项结果

| 项 | 状态 | 实证 |
|----|------|------|
| **A.** SubmissionAdapter 接口扩展兼容 | PASS | `swe-bench-verified-jsonl.ts` / `gaia-jsonl.ts` 仍只实现 `serialize`+`filename`（grep 命中 71/68 行），`serializeFiles?` 为 optional。`serializeSubmissionFiles` fallback：`adapter.serializeFiles?.(results, runId) ?? new Map([[adapter.filename(runId), adapter.serialize(results)]])`（`types.ts:23-24`）。`registry.test.ts:75-79` 用 `liteAdapter`（无 `serializeFiles`）实证 fallback 输出 `[["lite-run-1.json", "{}"]]`。 |
| **B.** Multi-file 写盘原子性 | PASS（不适用） | `grep -rn "serializeSubmissionFiles\|adapter\.serialize" benchmarks/src --include="*.ts"` 仅命中 types/bfcl-v4-jsonl/index/test 文件；`benchmarks/src/runner/runner.ts` 1058 行内 0 处调用 submission writer。当前 R1 fix 仅返回 `Map<path, content>` 内存结构，**未引入磁盘写入**，因此不存在"半成品 manifest + 缺失 result files"竞态。落盘是 operator 下游责任。文件 key 在 `serializeFiles` 内单调插入，runId 被 `assertSafePathSegment` 守护，无路径越权风险。 |
| **C.** Java/JS converter 完整性 vs 官方 f7cf735 | PARTIAL（已知 partial_eval） | 实证：`curl https://raw.githubusercontent.com/.../f7cf73.../type_mappings.py`。**JAVA_TYPE_CONVERSION** 上游 17 keys（byte/short/integer/float/double/long/boolean/char/Array/ArrayList/Set/HashMap/Hashtable/Queue/Stack/String/any），Quilin `javaConvertibleTypes` 13 keys，缺 Set/Hashtable/Queue/Stack。**JS_TYPE_CONVERSION** 上游 8 keys，Quilin `jsConvertibleTypes` 8 keys，完全对齐。实测 `BFCL_v4_simple_java.json` 实际只用 {any, Array, ArrayList, boolean, char, dict, double, HashMap, integer, long, String}，缺失 4 类型不在真实 task 数据中；`dict` Quilin 与上游均未在 JAVA_TYPE_CONVERSION 表中（上游会 `KeyError`，Quilin silent pass-through，行为不同但都不正确）。manifest 已声明 `official_parity: false / partial_eval: true`，可接受。 |
| **D.** 反例驱动测试 | PASS | `bfcl-v4-ast.test.ts:573-651` `__bfclV4AstPrivateForTests` 直接打 `convertJavaValue` 18 条断言（含 `"bad"→"bad"` / `"3.5"→"3.5"` / `"42"→"42"` / `"maybe"→"maybe"` / `"xy"→"xy"` / `"not-array"→"not-array"` / `"bad-list"→"bad-list"` / `"bad-map"→"bad-map"` / `"Unsupported"→"value"` 等反例），`convertJsValue` 18+ 条断言（含 `"12.5"→"12.5"` / `"12.5px"→"12.5px"` / `"12"→"12"`(Bigint) / `"maybe"→"maybe"` / `"not-array"→"not-array"` / `"not-dict"→"not-dict"` 等）。E2E `simple_java` (`:450-499`) / `simple_javascript` (`:501-550`) / `live_simple` + metadata language=javascript (`:552-571`) 均含 happy + fail 双路径。 |
| **E.** ADR-010 §3.1 不破坏 wire schema | PASS | `git diff` 仅修改 §3.1 一行 BFCL 描述。`benchmarks/src/wire/task.ts:16` `inputs: unknownRecordSchema` 为 open record，新增 `function_definitions/messages/question` 字段不被 zod 排斥。`grep -rn "candidate_functions\|prompt.*bfcl-v4" benchmarks/src` 0 命中——无遗留旧字段。swe-bench / gaia wire 顶层未触及。 |
| **F.** code-review-graph 28 untested | PASS（false-positive） | `task` / `functionDefinition` / `scoreBfclV4Ast` / `readLanguage` / `matchCallsOrdered` 等 graph 标 untested 的 symbol 实际在 `bfcl-v4-ast.test.ts` 中通过 `scoreBfclV4Ast` 入口 22+ 次端到端调用被覆盖（grep `scoreBfclV4Ast` 命中 12 行）。同 R2 LOW-1 deferred 模式：graph per-symbol 误报，集成路径已覆盖。 |
| **G.** R1 fix 不破坏 E2/E3a | PASS | `swe-bench-verified-jsonl.test.ts` / `gaia-jsonl.test.ts` 0 处涉及 `serializeFiles` / `serializeSubmissionFiles`；两个 adapter 文件 `c8e221f^..c8e221f` 内 0 改动。`registry.test.ts` 仅追加 1 条 fallback 用例，原有 6 条 untouched。commit message 实证：benchmarks 310 passed / 1 skipped；`just test-all` TS 717 + Python 187 + Rust 1 全绿；AMB p95 0.268ms（vs 0.273ms baseline，noise 范围内）。 |
| **H.** R2 大局判断 | PASS | E3b plan §6 验收硬指标全 PASS（commit message 已提供 grep-able 实证：tsc 0 / biome 0 / lines+branches+funcs+stmts 95.35%+ / AMB p95 0.268ms / 全 suite 绿）。BFCL upstream parity 标记为 `official_parity: false / partial_eval: true`，与 ADR-010 §3.1 元数据声明一致。 |

## 3. Findings

### BLOCKING

无。

### HIGH

无。

### MEDIUM

**MEDIUM-1: Java 表罕用类型与上游表面不一致（partial_eval 已声明，可 defer）**

- 文件: `benchmarks/src/scorers/bfcl-v4-ast.ts:35-49`
- 实证: 上游 `JAVA_TYPE_CONVERSION` 含 `Set / Hashtable / Queue / Stack`（4 类型上游 `java_type_converter.py` 内 `raise NotImplementedError`），Quilin `javaConvertibleTypes` 不含。差异：上游遇到这些类型 raise → checker valid=False；Quilin 走 `convertActualValue` 默认分支 `return { ok: true, value: actual }` 字符串原样比较。`BFCL_v4_simple_java.json` 实际不含这 4 类型，real eval 不触发；但若未来 BFCL 数据更新引入，Quilin 静默 pass-through 与上游 hard-fail 行为不同。
- 修复建议: E4 official-parity slice 时补齐 4 类型 → 抛 `SubmissionAdapterError` 或同等错误以与上游对齐；当前 partial_eval 阶段保持现状可接受。
- Confidence: 0.85（已有上游表 + Quilin 表 + real data 三方实证）

**MEDIUM-2: char 正则修正了上游 bug（正向漂移）**

- 文件: `benchmarks/src/scorers/bfcl-v4-ast.ts:496`
- 实证: 上游 `java_type_converter.py:34` `re.match(r"^\'.$\'", value)` —— `$` 锚点出现在 `\'` 之前导致 regex 永不匹配，所有 char 输入 fall through 至 `return str(value)`。Quilin 为 `/^'.'$/` —— 修正版 regex，对 `"'x'"` 返回 `"x"`（test `:586` 实证）。这是正向 divergence（修 bug）但仍是 parity gap。
- 修复建议: 在 ADR-010 §3.1 注脚说明该 bug 已上游 issue（如确认）或 E4 切回 bug-mirror 模式；当前 partial_eval 标记下可保持。
- Confidence: 0.90

**MEDIUM-3: 单文件 fallback 路径下 manifest result_files 仍含 `<run_id>` 占位符**

- 文件: `benchmarks/src/submissions/bfcl-v4-jsonl.ts:50-52, 116-137`
- 实证: 当 operator 仅调用 `adapter.serialize(results)`（不走 `serializeSubmissionFiles`），`createBfclV4SubmissionManifest` 默认 `runId="RUN_ID"`，第 134 行 `.replace("/RUN_ID/", "/<run_id>/")` 把 `result_files` 内路径替换为 `<run_id>` 占位符。但单文件 adapter `filename(runId)` 用的是真实 runId。结果：manifest 内引用 `bfcl-v4/<run_id>/result/...` 而 manifest 自身被写到 `bfcl-v4/<actualRun>/manifest.json`，operator 无法据 manifest 找到 result files（即原 BLOCKING-1 残留）。`serializeFiles` 路径已修复——这是 legacy fallback 的语义模糊。
- 修复建议: 在 BFCL adapter 的 `serialize()` 内 throw `SubmissionAdapterError("BFCL v4 must use serializeSubmissionFiles for full submission output")`，或文档注明 single-file `serialize()` 仅用于 manifest preview 不可用于 leaderboard 提交。
- Confidence: 0.80

### LOW

**LOW-1: code-review-graph 28 untested 是 per-symbol 误报**

- 实证: 与 R2 deferred LOW-1（前 review 已记录）同模式。`scoreBfclV4Ast` / `readLanguage` / `matchCallsOrdered` / `readFunctionSchemas` 在 22+ 处 `scoreBfclV4Ast(...)` 端到端调用中被传递触发；graph 静态分析未跨 export entry。Defer。

## 4. R2 conclusion

**close（E3b 收口）**。

3 条 MEDIUM 全部为 `partial_eval: true / official_parity: false` 元数据已涵盖范畴的可接受偏差，建议作为 E4 official-parity slice 的 backlog 候选项（与 R5 MEDIUM-1 / R2 MEDIUM-2/3 一同 defer）。无 BLOCKING / HIGH，E3b R1 三条 finding 实证关闭，回归无破坏，AMB p95 噪声范围内，全 suite 绿。
