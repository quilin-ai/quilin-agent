# Iter E3b R1 Cross-Track Review — Lorentz

**Reviewer**: Lorentz（独立 subagent，不复用 E3a R1-R5）
**Target commit**: `d4fd62a` (E3b first-cut)
**Date**: 2026-04-26
**Scope**: 仅 `d4fd62a` 引入的 14 文件改动（+2287/-20）

---

## 1. E3b first-cut delta 摘要

E3b 在 E3a 已稳态的 runner / DockerSandbox / cache / lockfile 协议之上落了 BFCL v4 单轮 AST slice：
loader (`benchmarks/src/datasets/bfcl-v4.ts`, 253 LOC) 把 pinned `f7cf735` 上游 13 个 non-live + live category JSONL 归一为 `BenchmarkTask`；
fetch CLI 走独立 `fetchBfclV4Rows` 路径并复用 `withDatasetFetchLock` (PID + nonce + 5min heartbeat / 30min stale)；
scorer (`bfcl-v4-ast.ts`, 298 LOC) 负责 function name / arg name / arg value 比对，
parallel 走 unordered，其它走 ordered，relevance/irrelevance 走 function-call presence 检测；
submission (`bfcl-v4-jsonl.ts`, 224 LOC) 输出 partial-eval manifest + 模板化的官方 per-category result file 路径；
runner.collect 加 `bfcl-v4` 分支（`{tool_calls:[…]}` strict JSON，与 GAIA 同 fail-loud 模式）。

---

## 2. R1 必查项结果

### A. AST scorer 与 BFCL `ast_checker.py` parity — **FAIL（HIGH）**
`/tmp/bfcl_ast_checker.py:333-515` 上游 `simple_function_checker` 通过 `func_description.parameters.properties[param].type` + `JAVA_TYPE_CONVERSION` / `JS_TYPE_CONVERSION` + `java_type_converter` / `js_type_converter` 做语言级类型转换；上游还按 `func_description.parameters.required` 区分必填/可选参数。我们的 `bfcl-v4-ast.ts:179-212 toolCallMatches` **完全没读 `func_description`**，
仅靠 `expected.ground_truth` 推导参数集，且无 Java/JS 字符串解码（详见 §3 HIGH-2）。
parallel 不支持 enforce_order 分支（上游 `parallel_function_checker_enforce_order` 单独存在但未在 `ast_checker` 默认走到，OK）。

### B. normalize-at-fetch 正确性 — **PASS**
上游 raw JSONL 仅含 `id` / `question` / `function` / 可选 `ground_truth`（possible_answer 文件单独）。
`fetch-benchmark.ts:509-554` 在迭代 13 个 category 时合成 `category` + `general_category`，再用 `validateBfclV4Row` 强校验；possible_answer 仅对存在该文件的 category 抓取（`bfclV4PossibleAnswerCategories` 排除了 `irrelevance` / `live_irrelevance` / `live_relevance`），与上游目录一致（curl 验证 `possible_answer/` 目录无 irrelevance/relevance 文件）。`question` 多层嵌套 `[[{role,content}]]` 由 `extractQuestionText` 递归收集。

### C. Multi-file submission adapter 原子性 — **FAIL（BLOCKING）**
`createBfclV4ResultFiles` 仅被同模块 `createBfclV4SubmissionManifest` 内部调用（生成 manifest 的 `result_files` 路径列表）；`grep -rn createBfclV4ResultFiles benchmarks/ --include="*.ts" | grep -v test.ts` 仅命中 `bfcl-v4-jsonl.ts` 自身和 `submissions/index.ts` re-export，**无实际落盘 caller**。`SubmissionAdapter` 接口 (`submissions/types.ts:6-11`) 是 `serialize(): string` + `filename(): string` 单文件契约，BFCL adapter 只 emit manifest，per-category result files 永不落盘。详见 §3 BLOCKING-1。

### D. runner.collect BFCL 分支 — **PASS**
`runner.ts:368-407 collectBfclV4Output` 强制 JSON 解析 + `tool_calls` 数组检查 + `normalizeBfclV4ToolCall` 校验 function/arguments 必填，与 E3a GAIA fail-loud 模式同款。`tool_calls` 支持 alias `name`/`args`/`parameters`（与 scorer 一致）。多轮 / agentic 未被误开放。`runner.test.ts:351-435` 覆盖正向 + 4 类反向。

### E. host_path sanitization 同步 — **PASS（不适用）**
BFCL 上游无 attachment / file。loader inputs 仅含 `function_definitions` / `messages` / `question`，不含 host filesystem path。`promptInputsForTask` 仅对 `gaia` 做 sanitize，BFCL 直通——**因源数据不含 host path，无需 sanitize**。Grep `host_path|relative_path|file_host_path` 在 `bfcl-v4.ts` 全部 0 命中。

### F. lockfile 复用 — **PASS**
BFCL fetch 经 `fetchBenchmark → withDatasetFetchLock → fetchBenchmarkWithLock` 同链路（`fetch-benchmark.ts:140-148`）。R3/R4 PID + nonce + heartbeat + stale 双因子完整继承。

### G. code-review-graph 24 untested 验证 — **MIXED**
`fetchBfclV4Rows` / `fetchBfclV4Jsonl` / `parseBfclV4Jsonl` / `validateBfclV4RawUrl` / `validateBfclV4Row` 在 `fetch-benchmark.test.ts:147-269` 有显式 `__privateForTests` 覆盖（第 222-269 行 6 个 case）；`cacheSatisfiesRequest` BFCL 分支被 `skips BFCL v4 refetch when partial cache satisfies` (l.182) 与 `skips a full BFCL v4 cache` (l.196) 双 case 覆盖。**graph 误报，与 R2 LOW-1 同款 deferred 模式**。

### H. 反例驱动测试 — **PASS**
`bfcl-v4-ast.test.ts` 覆盖 function name 不匹配 / 缺必填 arg / 多余 arg / 类型不一致 / parallel 数量不齐 / relevance 反向；
`bfcl-v4.test.ts` 覆盖 malformed JSONL / 空 row / 缺字段 / category mismatch；
`bfcl-v4-jsonl.test.ts` 覆盖 missing tool_calls / non-object entry / 缺 metadata。覆盖率 95.23 branches、97.94 lines（commit message 实证）。

### I. wire schema 兼容性 — **FAIL（MEDIUM-doc）**
ADR-010 §3.1 line 57 仍写：`bfcl-v4: inputs.{prompt, candidate_functions, multi_turn?}; expected.{ground_truth_calls}; scorer_type = "bfcl-tool-call-match"`。实际实现：`inputs.{function_definitions, messages, question}`；`expected.{category, expected_tool_calls, general_category, ground_truth}`；`scorer_type = "bfcl-v4-ast"`；`metadata.{bfcl_version, category, general_category, official_parity, partial_eval, source_commit, source_row}`。**ADR 与代码漂移**。Wire schema (`wire/task.ts:5-22`) 顶层契约只锁 `dataset` enum 与 `scorer_type` 非空，运行时不强制 ADR §3.1 字段，故不触发 BLOCKING——但 ADR 必须同步。详见 §3 MEDIUM-1。

### J. R1 大局判断
- 验收硬指标 §5 line 104 "setup → score → submission 端到端"——BLOCKING-1 让端到端不闭合（result files 永不落盘）。
- §5 line 109 "partial_eval=true + official_parity=false 在 result + manifest **双向**标记"——result 文件未落盘，"双向"无法成立。
- §5 line 110 "AST scorer 与 BFCL 官方 evaluator.py AST 匹配语义对齐"——HIGH-2 显示 Java/JS 类别系统性返回 0 分。

---

## 3. Findings

### BLOCKING-1：multi-file submission adapter 输出永不落盘（plan §5 line 104/109 验收硬指标失败）
- **File**: `benchmarks/src/submissions/bfcl-v4-jsonl.ts:43-58, 60-98, 100-120` + `benchmarks/src/submissions/types.ts:6-11`
- **Trigger**: 跑端到端 BFCL → submit。
- **Path**: `SubmissionAdapter.serialize(results)` 仅返回 manifest 字符串；`createBfclV4ResultFiles` 是 module-private 数据结构（仅 `createBfclV4SubmissionManifest` 内部调用以生成 `result_files: string[]` 字段）；外部无任何 caller 把 `BfclV4ResultFile[]` 写到磁盘。Grep 实证：
  ```
  $ grep -rn "createBfclV4ResultFiles\|BfclV4ResultFile" benchmarks/ --include="*.ts" | grep -v ".test.ts"
  benchmarks/src/submissions/bfcl-v4-jsonl.ts:14:export interface BfclV4ResultFile {
  benchmarks/src/submissions/bfcl-v4-jsonl.ts:60:export function createBfclV4ResultFiles(
  benchmarks/src/submissions/bfcl-v4-jsonl.ts:65:): readonly BfclV4ResultFile[] {
  benchmarks/src/submissions/bfcl-v4-jsonl.ts:104:	const files = createBfclV4ResultFiles(results, {
  benchmarks/src/submissions/index.ts:2:	type BfclV4ResultFile,
  benchmarks/src/submissions/index.ts:6:	createBfclV4ResultFiles,
  ```
- **Outcome**: manifest 在 `bfcl-v4/<run>/manifest.json` 写下 `result_files: ["bfcl-v4/<run_id>/result/<model>/<gen>/BFCL_v4_<cat>_result.json", ...]`，但这些路径**永远空文件**。BFCL 官方 `bfcl evaluate` 拿不到 result file → 端到端不可达。Plan §5 line 104 "setup → score → **submission**"、line 109 "partial_eval=true 在 **result + manifest 双向**标记" 均不达成。
- **Confidence**: 0.92。代码实证完备；唯一不确定是否存在尚未提交的 caller，但 commit `d4fd62a` 已 land 且测试 302 全绿，不可能依赖未提交代码。
- **Fix建议**: 给 `SubmissionAdapter` 加 `serializeFiles?: (results) => readonly { path; content }[]` 可选 hook（其它 adapter 默认 fallback `[{ path: filename(runId), content: serialize(results) }]`），BFCL adapter 实现该 hook 写 manifest + per-category 文件，runner / submission CLI 通过该 hook 原子落盘（先 `tmp` → `rename`，参考 E3a 模式）。或者在 BFCL adapter 内部直接 `writeFile`，但最小改动是扩接口 + 由 runner 写盘。

### HIGH-1：scorer 缺 Java/JS 类型转换器 → `simple_java` / `simple_javascript` 系统性返回 0 分（plan §5 line 110 验收硬指标失败）
- **File**: `benchmarks/src/scorers/bfcl-v4-ast.ts:179-241`
- **Upstream**: `/tmp/bfcl_ast_checker.py:387-426 simple_function_checker` 对 `Language.JAVA` / `Language.JAVASCRIPT` 必走 `java_type_converter` / `js_type_converter`，把模型输出的字符串值（Java `int`、`ArrayList<String>`、JS `Array` 等）解码为 typed value 后再比对。
- **Trigger**: 跑 `simple_java` 或 `simple_javascript`，模型按 BFCL 协议输出 stringified Java/JS 值。
- **Path**: scorer 不读 `task.inputs.function_definitions`，不做语言识别，无 type converter。`valuesEquivalent` 直接按 expected 值的 JS 类型分支比对。Java 模型输出 `"5"`（整数字符串），expected possible_answer 是 `[5]`（数字）——`typeof actual === "string"` vs `typeof expected === "number"` → return false。
- **Outcome**: `simple_java` (~100 题) + `simple_javascript` (~50 题) 整体 accuracy 接近 0；上榜 partial-eval 分数被严重压低，official-parity=false 标记仅声明"不官方"，不解释"Java/JS 系统性失败"。
- **Confidence**: 0.85。无实跑 fixture，但 grep 实证我们的 scorer 不消费 `function_definitions`：
  ```
  $ grep -n "function_definitions\|inputs" benchmarks/src/scorers/bfcl-v4-ast.ts
  (no matches)
  ```
  上游 `JAVA_TYPE_CONVERSION` / `js_type_converter` 在我们整个 codebase 0 命中。
- **Fix建议**: 三选一：(a) Iter E3b 范围内移除 `simple_java` / `simple_javascript`，仅跑 Python；(b) 接 BFCL upstream 的 `java_type_converter` / `js_type_converter`（spike §4.3 Option 2 子集，shell-out 或者 port）；(c) 在 plan §1 的 "official_parity=false" 之外，明确文档 partial 范围里 java/javascript 是 systematically broken，不是渐进偏差。最小 PR：(a) + 追加文档。

### MEDIUM-1：ADR-010 §3.1 line 57 与实现漂移（与 R5 MEDIUM-1 同款 doc-drift 类）
- **File**: `docs/adr/adr-010-benchmark-harness-wire-schema.md:57` vs `benchmarks/src/datasets/bfcl-v4.ts:152-181`
- **Upstream / 实测对比**: ADR-010 line 57 仍写 `bfcl-v4: inputs.{prompt, candidate_functions, multi_turn?}; expected.{ground_truth_calls}; scorer_type="bfcl-tool-call-match"`；代码实际 `inputs.{function_definitions, messages, question}` / `expected.{category, expected_tool_calls, general_category, ground_truth}` / `scorer_type="bfcl-v4-ast"` / `metadata.{bfcl_version, category, general_category, official_parity, partial_eval, source_commit, source_row}`。
- **Outcome**: 后续 reviewer / Iter E3c 实施者按 ADR 写代码会冲突；运行时 wire schema (`wire/task.ts:5-22`) 不强制顶层 enum 之外的字段，不爆错但合规验证不可信。
- **Confidence**: 0.95。直读两文件即可证。
- **Fix建议**: 与 BLOCKING-1 / HIGH-1 一并 R2 修，在 ADR-010 §3.1 line 57 重写为：`inputs.{function_definitions, messages, question}`、`expected.{category, expected_tool_calls, general_category, ground_truth}`、`scorer_type="bfcl-v4-ast"`、`metadata.{bfcl_version, category, general_category, official_parity, partial_eval, source_commit, source_row}`，并加一句 "irrelevance/live_irrelevance/live_relevance 无 possible_answer 文件，`expected.ground_truth = []`"。

---

## 4. R1 conclusion

**fix-pass-needed**。BLOCKING-1（多文件 submission 落盘缺失）+ HIGH-1（Java/JS 类型转换器缺失）触发 plan §5 line 104 / 109 / 110 三条硬验收线，gate `BLOCKING/HIGH = 0` 不达。R2 修完三条 finding（含 ADR-010 §3.1 文档同步）后再 confirm close。
