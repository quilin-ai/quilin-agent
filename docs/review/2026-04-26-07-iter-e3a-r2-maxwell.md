# Iter E3a R2 Cross-Track Review — Maxwell

**Reviewer**: Maxwell（独立 subagent，不复用 R1 Raman 已 cover finding）
**Target commit**: f8f06cc — `fix(benchmarks): close E3a GAIA review findings (R1)`
**Date**: 2026-04-26
**Scope**: 仅 commit f8f06cc 引入的改动（10 files / +747/-57）

---

## 1. R1 fix delta 摘要

R1 Raman 闭合 2 BLOCKING + 2 HIGH，commit f8f06cc 落地：
1. **runner.ts**: dataset-aware `collectOutput`，GAIA 强制 strict JSON `{model_answer, reasoning_trace?}`；非 runnable dataset（`bfcl-v4`）在 setup 阶段 fail-fast。
2. **gaia-exact-match.ts**: 重写 `questionScorer` 仿 upstream `question_scorer` 三分支（numeric / list / string），新增 `parsePythonFloat` 端口 Python `float()` 文法（接受 `1_000`、`inf`/`nan`/科学记数法；拒绝 `0x10`、underscore 边界）。
3. **cache.ts**: manifest schema 加 `attachments.{filename}.{sha256, size_bytes}`，加载时按内容校验。
4. **fetch-benchmark.ts**: GAIA attachment 写 staging dir，失败 cleanup；cache-hit 时校验 attachment 内容。
5. **gaia.ts (loader)**: 输出 container path（`/workspace/cache/datasets/gaia/attachments/...`）+ host path 双轨。

实证：`benchmarks: 252 passed / 1 skipped`，`AMB 100k p95 7.417ms`。

---

## 2. R2 必查项结果

### A. GAIA scorer Python float() parity 边界穷举

经验证脚本同时跑 Python `float()` 和 TS `parsePythonFloat` 对照（39 个 case），结果如下：

| case | Python float() | TS parsePythonFloat | parity |
|------|---------------|---------------------|--------|
| `inf` / `-inf` / `Infinity` / `+infinity` / `INF` / `-INFINITY` | inf 系列 | inf 系列 | PASS |
| `nan` / `NaN` / `+NaN` / `-nan` / `NAN` | nan | NaN | PASS |
| `1.5e+10` / `1.5E10` / `1.5e10` | 1.5e10 | 1.5e10 | PASS |
| `1e` / `.` / `+` / `-` / `""` | ValueError | undefined | PASS |
| `.5` / `5.` | 0.5 / 5.0 | 0.5 / 5 | PASS |
| `  1.5  ` (前后空格) | 1.5 | 1.5 | PASS |
| `1_` / `_1` / `1__0` / `1_.0` / `1._0` | ValueError | undefined | PASS |
| `1_000` / `1_000.5` / `1_000_000` / `1e1_0` | 1000 / ... | 1000 / ... | PASS |
| `1e_5` (underscore 紧跟 e) | ValueError | undefined | PASS |
| `0x10` / `0o10` / `0b10` | ValueError | undefined | PASS（R1 已修） |
| `+1.5` / `-0` | 1.5 / -0.0 | 1.5 / -0 | PASS |
| **`١٢٣` (Arabic digits)** | **123.0** | **undefined** | **FAIL** |
| **`１２３` (full-width digits)** | **123.0** | **undefined** | **FAIL** |

→ Unicode digits 解析存在 parity 缺口（FAIL）。Python `float()` 接受 `Nd` (Number, decimal digit) Unicode 类，TS regex `\d` 仅匹配 ASCII 0-9。这会让中文/阿拉伯/印地数字答案错配为 string-compare 分支。**实证 finding：见 §3 MEDIUM-1。**

但更严重的是：**穷举之外发现 R1 fix 引入了 Infinity-sentinel false-positive bug**。详见 §3 BLOCKING-1 — `normalizeNumberString` 在 fall-through 时返回 `Number.POSITIVE_INFINITY` 哨兵，与合法的 `parsePythonFloat("inf")` 解析结果发生 `===` 相等碰撞，导致 ground truth 是 `inf`/`Infinity` 时**任意 model_answer 都 passed=true**。已用 vitest 实测 4 个独立场景重现。

### B. Attachment manifest 向后兼容 + 并发安全

#### B.1 旧 manifest（无 attachments 字段）的 cache-hit 行为

`cache.ts:26-36` Zod schema：`attachments` 是 `.optional()`，旧 manifest 通过 schema validation。
`fetch-benchmark.ts:368-414` `tryReadValidManifest`：对 GAIA dataset，调用 `gaiaAttachmentsComplete(cacheDir, data, manifest.attachments)`（line 401-403）。
`fetch-benchmark.ts:293-337` `gaiaAttachmentsComplete`：line 316-318 `if (attachments == null) return false`，会**触发 refetch**。

→ **PASS**：旧 manifest 无 `attachments` 字段时，若任一 row 含 `file_name`，会自动 redownload；若所有 rows 都无 file_name，则跳过校验。fail-loud 一侧由 `loadDatasetCache` → `loadGaiaTasks` → `resolveAttachment` (gaia.ts:263-269) 在 read 路径强制 `attachments` 必须存在。两侧契约一致。

#### B.2 staging dir 并发安全

`fetch-benchmark.ts:267`：
```ts
const stagingDir = `${attachmentDir}.tmp-${process.pid}-${Date.now()}`;
```
`process.pid` 跨进程互不冲突；`Date.now()` 同进程同毫秒可能撞名。**单进程内并发调用 `fetchGaiaAttachmentsIfNeeded` 同 dataset** 才会冲突，CLI 单次调用场景不触发。

但 line 284-286 的非原子 rmdir+rename：
```ts
await rm(attachmentDir, { recursive: true, force: true });
await rename(stagingDir, attachmentDir);
```
若两个**不同进程**（A pid=100, B pid=200）几乎同时进入这一段，A 的 rm 成功 → B 的 rm 看到不存在（force:true 安全）→ A 的 rename 成功 → B 的 rename 覆盖 A 的目录。最终 `attachmentDir` 是 B 的内容，但 manifest.json 是各自独立写的（line 142），可能发生 manifest sha256（B）+ attachments 文件（A）错配的窗口。窗口很短但不为零。

→ **HIGH**：跨进程并发 fetch 存在 cache 内容/manifest 不一致窗口（详见 §3 HIGH-2）。R1 闭合的是「失败时 cleanup」，没覆盖「并发成功时谁赢」。

#### B.3 partial cache 与 GAIA attachment 隔离

`cacheSatisfiesRequest` (line 416-432) 仍按 `requested_max_rows + rows` 决策。GAIA attachment 由 `gaiaAttachmentsComplete` 独立校验。partial cache（如 `maxRows=2`）只 fetch 前 2 个 row 引用的 attachment；`gaiaAttachmentsComplete` 按 data.jsonl 中的 file_name 列表逐个校验，与 partial 范围一致。→ **PASS**。

### C. Runner collect fail-loud scope

#### C.1 GAIA collect throw 是否过度限制

runner.ts:342-365：strict JSON parse + `model_answer` 必须非空字符串；任何不符直接 throw。

考察 max_steps 终止场景：agent 跑满步数后返回 last assistant message。若 prompt 工程让 agent 输出 markdown 代码块（如 ` ```json\n{"model_answer": "Paris"}\n``` `）→ `JSON.parse` 失败 → throw。这是「output_format_invalid」而不是「task failed」，但当前归为 same BenchmarkRunError(phase="collect") 路径，没有区分。

错误信息（line 348）`"GAIA agent output must be a JSON object with model_answer (...)"` 已经表达契约。但缺少：
- 提示 agent 输出原文（前 200 字节用于 trajectory 调试）。
- 区分 `parse_failed` / `not_object` / `empty_model_answer` 三种子原因。

→ **MEDIUM**：throw 行为正确，但调试信息可加强（详见 §3 MEDIUM-3）。

#### C.2 bfcl-v4 fail-fast 仅在 setup 阶段

runner.ts:188 `assertRunnableDataset(task)` 在 setup 第一步调用，line 422-426 `runnableDatasets = {swe-bench-lite, swe-bench-verified, gaia}`，其他数据集直接 throw。setup phase 之后的任何代码路径（agent_loop / collect / score / cleanup）都不会被 bfcl-v4 触发，因为流程已 short-circuit。→ **PASS**。runner.test.ts:281-300 已实证。

#### C.3 SWE-bench collect 路径未受影响

runner.ts:330-340 `collectOutput`：
```ts
if (task.dataset === "gaia") return collectGaiaOutput(loopOutput);
return { patch: loopOutput };
```
swe-bench-lite/swe-bench-verified 走 `{patch: loopOutput}` 原路径，无任何 throw 行为变化。→ **PASS** (E2 regression check)。

### D. Container path 在 DockerSandbox 实际生效路径

#### D.1 mount 类型

`benchmarks/src/sandbox/docker.ts:325-332`：
```ts
"--mount", bindMount(input.baseDir, "/workspace/base", true),     // readonly
"--mount", bindMount(input.scratchDir, "/workspace/task", false), // writable
"--mount", bindMount(input.artifactsDir, "/workspace/artifacts", false),
"--mount", bindMount(input.cacheDir, "/workspace/cache", true),   // readonly ✓
```
gaia.ts:15 `const dockerCacheRoot = "/workspace/cache"` 和 docker.ts:62 `workspaceCachePath = "/workspace/cache"` 一致。cache mount **readonly**，符合 ADR-011 §3.2 (`cache: read-only by default`)。→ **PASS**。

#### D.2 prompt 中 host path 泄漏（CRITICAL）

gaia.ts:217-225 把 attachment 写入 `task.inputs`：
```ts
inputs: {
  ...(attachment == null ? {} : {
    file_attachments: [attachment],   // 包含 host_path 字段
    file_host_path: attachment.host_path,   // 直接是 host 绝对路径
    file_name: attachment.file_name,
    file_path: attachment.file_path,        // 这个是 container path（OK）
  }),
  ...
}
```
attachment 对象（gaia.ts:298-306）包含 7 字段：`container_path / file_name / file_path / host_path / relative_path / sha256 / size_bytes`。**全部** 序列化进 `file_attachments[0]`。

runner.ts:394-402 把 `task.inputs` 完整 `JSON.stringify` 写入 user message：
```ts
content: JSON.stringify({
  task_id, dataset, workspace_dir, inputs: task.inputs,
}),
```

→ agent 看到的 user message 里 host_path 出现 **两次**（顶层 `inputs.file_host_path` + 嵌套 `inputs.file_attachments[0].host_path`）。容器内 host_path 不存在，agent 试图打开会失败（行为问题）；更严重是 host 文件系统布局（如 `/Users/<username>/...` / `/var/folders/...`）泄漏给 LLM，可能进入 trajectory log / submission artifact / 第三方 grader 输入。

ADR-010 §3.1 line 56 规定 `gaia: inputs.{question, level, file_name?, file_attachments?}` —— **没有** `file_host_path`，且 `file_attachments` schema 未冻结到字段集，但 attachment 对象的 host_path 显然是 host-only metadata，不应进 prompt。

→ **HIGH**：详见 §3 HIGH-1。修复建议：保留 host_path 在 runner-internal map（按 task_id index），prompt 只塞 container path 系列。

#### D.3 runtime mount vs setup mount

`createDockerSandbox` (docker.ts:64-110) 在构造期固定 cacheDir。每次 `runShellCommand` 调 `dockerRunArgs` 重新生成 `--mount` 参数，每个 docker run 都重新 mount cache。多 task 共享同一 host cacheDir，readonly mount 不会写。→ **PASS**。性能：cache mount 是 bind mount，无 IO 拷贝；每 docker run 启动开销与 cache mount 数量成线性，可忽略。

### E. code-review-graph 25 test gap 验证

graph hook 报告 5 个未测试 function：

| function | 实测 | verdict |
|----------|------|---------|
| `fetchBenchmark` | fetch-benchmark.test.ts 全文调用 30+ 次 | PASS（graph 误报） |
| `fetchGaiaAttachmentsIfNeeded` | line 200-233 "cleans staged GAIA attachments..." 显式触发 fail-cleanup 分支 | PASS（间接） |
| `gaiaAttachmentsComplete` | line 133-198 "refetches GAIA when manifest is valid but cached attachments are missing/tampered" 触发 false 分支 | PASS（间接） |
| `tryReadValidManifest` | line 51-81 / line 366-433 显式触发 cache-hit / stale schema / row count invalid 分支 | PASS（间接） |
| `validateGaiaAttachmentFileName` | line 326-364 "rejects unsafe GAIA attachment names" 显式 `../secret.txt` + 256-byte filename | PASS（间接） |

→ **graph node-level uncovered ≠ vitest line/branch coverage gap**。vitest coverage 报告 95.01% / 95.14%，与门槛一致。graph 是 per-symbol 节点视角（导出 vs 私有），vitest 是行/分支视角；二者不冲突。

verdict：graph 误报，**不是真 gap，无 finding**。建议（见 §3 LOW-1）：在 `code-review-graph` 配置层面给 file-private function 标 `@internal` / 排除 vitest-line-covered private helpers，避免后续误导。

### F. R1 fix regression 检查

| 检查项 | 结果 |
|--------|------|
| E2 SWE-bench-Verified collect 路径 | runner.ts:330-340 GAIA 分支独立，SWE-bench 走 `{patch: loopOutput}` 原路径，无变更 |
| AMB benchmark | AMB 在 `providers/memory/`，commit f8f06cc 不涉及；commit message 报 "AMB 100k p95 7.417ms" 实证未受影响 |
| ADR-010 wire schema | `BenchmarkResult.output` / `BenchmarkRun` 字段集不变；`task.inputs` 是 `Record<string, unknown>` 自由结构（GAIA 新增的 `file_host_path` 是字段名扩张，不破坏 schema） |
| `BenchmarkRunError(phase)` 枚举 | 仍是 5 阶段，未扩张 |
| swe-bench-lite/verified loader | 未触动 |
| scorer registry | 未触动；`gaia-exact-match` 新增是 additive |

→ **PASS**：R1 fix 没有破坏既有 E1/E2 通过的契约；唯一回归是新引入的 Infinity-sentinel bug（见 §3 BLOCKING-1）。

---

## 3. Findings

### BLOCKING

#### BLOCKING-1: Infinity-sentinel 哨兵碰撞导致 inf 类 ground truth 上 false-positive

**File**: `benchmarks/src/scorers/gaia-exact-match.ts:84-90`

```ts
function normalizeNumberString(value: string): number {
  const normalized = value.replaceAll("$", "").replaceAll("%", "").replaceAll(",", "");
  return parsePythonFloat(normalized) ?? Number.POSITIVE_INFINITY;  // <-- 哨兵 fallback
}
```

`parsePythonFloat` 解析失败时返回 `undefined`，`??` 把它替换成 `Number.POSITIVE_INFINITY` 作为「不可能匹配」哨兵。但 `Number.POSITIVE_INFINITY` 同时也是 `parsePythonFloat("inf"/"Infinity"/"+infinity"/...)` 的合法返回值。当 ground truth 解析为 `Infinity` 时，**任意无法解析为数字的 model_answer 都会被 fallback 成 `Infinity`，与 ground truth `===` 相等，scorer 返回 passed=true**。

**实证**（vitest 临时 probe，4 个独立场景全部 false-positive）：

| ground_truth | model_answer | 实测 passed | 期望 |
|---|---|---|---|
| `"inf"` | `"Boston"` | **true** | false |
| `"Infinity"` | `"zzzz"` | **true** | false |
| `"inf"` | `"$%,"` (currency-strip 后空) | **true** | false |
| `"inf"` | `"   "` (全空格) | **true** | false |
| `"Paris; inf"` (列表元素) | `"Paris; whatever"` | **true** | false（列表分支同样命中） |

注意 `-inf` ground truth 不触发，因为 fallback 是 `+Infinity` 而非 `-Infinity`，`-Infinity !== +Infinity` 恰好 false。这种**非对称性**说明哨兵选择本身是 buggy。

**影响**：
- GAIA leaderboard 提交分数会被无条件抬高（虽然 GAIA validation set 中 `inf` 类答案罕见，但任何一题命中即让 scorer 信任度归零，提交不可信）。
- 列表分支同样命中（已实证），扩大攻击面到「任何包含 inf 元素的列表答案」。
- R1 commit message 强调「Python float() parity」恰恰是这个文件，说明 R1 没有覆盖 fallback 路径的语义。

**Parity caveat**：本 review 没有读到 upstream `question_scorer` Python 源（`docs/research/2026-04-26-02-gaia-bfcl-spike.md` line 51 只引用了 leaderboard 描述）。Python `try: float(...); except ValueError` 的常见模式是抛错或返回 None，scorer 在 except 分支会落到 string-compare；推断 R1 fix 的语义破坏由此产生。但**bug 本身（任何 garbage 当 gt 是 inf 时 passed=true）独立于 upstream parity**：哪怕 Python upstream 也这么干（极不可能），对 leaderboard 提交也是错的。

**修复建议**（任选其一）：
1. 让 `normalizeNumberString` 返回 `number | undefined`，调用点显式检查：
   ```ts
   const candidateNumber = normalizeNumberString(modelAnswer);
   if (candidateNumber === undefined) return false;
   return candidateNumber === groundTruthNumber;
   ```
2. 用一个 sentinel 不可能与合法解析碰撞的值（如 `Symbol("parse_failed")`），改用 `if (sentinel === ...) return false;` 短路。
3. 直接学 Python：try/catch 包 parse，catch 分支 fall-through 到 string compare。

**Confidence**: 0.95（vitest 实测 4 case 全部 reproduce）

---

### HIGH

#### HIGH-1: GAIA loader 把 host 绝对路径泄漏到 agent prompt

**File**: `benchmarks/src/datasets/gaia.ts:217-225, 298-306`

`resolveAttachment` 返回的 attachment 对象包含 `host_path`（host 绝对路径），`toBenchmarkTask` 把整个对象塞进 `task.inputs.file_attachments[0]`，并额外提取出 `task.inputs.file_host_path`。runner.ts:394-402 `JSON.stringify(task.inputs)` 整体进 user message，agent prompt 内含两处 host path：
- `inputs.file_host_path = "/private/var/folders/.../attachment.xlsx"` 或 `<cacheRoot>/datasets/gaia/attachments/...`
- `inputs.file_attachments[0].host_path` 同上

**实证**：`benchmarks/src/datasets/gaia.test.ts:75-81` 显示 `host_path: join(cacheRoot, "datasets", GAIA_DATASET, "attachments", "attachment.xlsx")` 作为合约 fixture。即 test 已经冻结了这个泄漏行为。

**影响**：
1. 容器内 host_path 不可访问（cache 是 mount 到 `/workspace/cache`，host 路径在容器内不存在）；agent 若先尝试 host_path 会失败浪费 step。
2. host 文件系统布局（`/Users/<username>/...`、`/var/folders/...`、CI runner 路径）泄漏到 trajectory log 与可能的 submission artifact，对外暴露开发者环境信息。
3. ADR-010 §3.1 line 56 GAIA inputs schema 是 `{question, level, file_name?, file_attachments?}`，loader 自行扩了 `file_host_path` 与 `file_path` 顶层字段，且 `file_attachments` 元素 schema 未在 ADR 中冻结。建议 ADR 同步给出 attachment payload schema，并显式禁止 host-only 字段。

**修复建议**：
- attachment payload 只包含 `{container_path, file_name, file_path, sha256, size_bytes}`（去掉 `host_path`、`relative_path`）。
- runner 内部维护 `Map<task_id, host_path[]>` 用于 cleanup / verification，不进 prompt。
- 顶层 `task.inputs.file_host_path` 整个删除；保留 `task.inputs.file_path = container_path` 作为 agent 主入口。

**Confidence**: 0.90（test fixture 已固化泄漏路径，明确属于 R1 引入的新 surface）

---

#### HIGH-2: 跨进程并发 GAIA fetch 存在 cache 内容/manifest 不一致窗口

**File**: `benchmarks/scripts/fetch-benchmark.ts:267, 284-286`

```ts
const stagingDir = `${attachmentDir}.tmp-${process.pid}-${Date.now()}`;
// ... 写完所有 attachment 后:
await rm(attachmentDir, { recursive: true, force: true });
await rename(stagingDir, attachmentDir);
// 然后 line 142 写 manifest.json
```

`stagingDir` 名字含 pid，**进程级唯一**，跨进程冲突不发生在 staging。但 attachmentDir 替换是 **rmdir 后 rename**，非原子。两个不同 pid 的进程（A、B）同时跑 `fetch-benchmark gaia`：

1. A: `rm(attachmentDir)` 成功
2. B: `rm(attachmentDir)` （已不存在，force:true 安全）
3. A: `rename(stagingA, attachmentDir)` 成功
4. B: `rename(stagingB, attachmentDir)` 覆盖 A
5. A: 写 manifestA.json（sha256 反映 attachmentsA）
6. B: 写 manifestB.json（sha256 反映 attachmentsB）

最终 `attachments/*` 是 B 的内容，但若 A 在 step 5 比 B 在 step 6 更晚执行，`manifest.json` sha256 会指向 A 的 attachmentsA，与 B 的实际文件不匹配。下次 cache-hit 时 `gaiaAttachmentsComplete` 会发现 sha256 不匹配 → refetch（行为安全），但中间有「manifest claims A's hashes, dir has B's content」的窗口，外部观察工具或 race 检查可能 panic。

**影响**：CLI 单次调用场景下零风险；CI 并行矩阵或 daemon 模式重复触发场景下窗口存在。R1 commit message 提到「staging dir + fail-cleanup」，覆盖的是「失败时不污染 attachmentDir」，没覆盖「成功并发时谁赢」。

**修复建议**：
- 用单一 atomic rename：先 `rename(attachmentDir, attachmentDir.bak-pid-ts)` 再 `rename(stagingDir, attachmentDir)`，最后 `rm` 旧 dir。
- 或加 process-level 文件锁（`flock` on cacheDir/dataset.lock）。
- 或文档明确「`fetch-benchmark` 不支持同 dataset 并发调用」并在 CLI 入口加 lockfile guard。

**Confidence**: 0.75（race window 真实存在；单进程 CLI 不触发，并发触发概率低但非零）

---

### MEDIUM

#### MEDIUM-1: Unicode digits 解析未 port — Python `float('１２３')` 接受，TS 拒绝

**File**: `benchmarks/src/scorers/gaia-exact-match.ts:124-127`

```ts
if (!/^[+-]?(?:(?:\d(?:_?\d)*)...)/.test(trimmed)) return undefined;
```

JS regex `\d` 默认仅 ASCII 0-9（除非加 `u` flag 并用 `\p{Nd}`），Python `float()` 接受任何 Unicode `Nd` 类（阿拉伯 `١٢٣` → 123.0、全角 `１２３` → 123.0）。当 GAIA ground truth 数字以非 ASCII 形式呈现且 model_answer 也是同样形式时，scorer 走 string-compare 分支而非 numeric 分支：
- Python upstream: `float('١٢٣') == float('123')` → True
- TS port: numeric 分支双双 undefined → 进 string-compare → `"١٢٣" !== "123"` → False

**影响**：GAIA validation set 中 Arabic/中日韩/全角数字答案概率低（GAIA 答案多为英文实词或 ASCII 数字），但属于 parity FAIL。

**修复建议**：regex 加 `u` flag 改用 `\p{Nd}`，并在 `Number()` 之前用 `String.prototype.normalize` + manual digit folding（因 `Number("١٢٣")` 也返回 NaN）。或简化为「先把 `\p{Nd}` 字符按 codepoint 减去 `'0'` 的偏移做 ASCII fold」。

**Confidence**: 0.85（Python 行为已实证，TS 行为已实证，影响概率为推断）

---

#### MEDIUM-2: cache.ts manifest schema 与 fetch-benchmark.ts manifest 类型双轨，校验不对称

**Files**:
- `benchmarks/src/datasets/cache.ts:16-38` (Zod `datasetManifestSchema`，read 端)
- `benchmarks/scripts/fetch-benchmark.ts:49-65` (TS `interface DatasetManifest`，write 端)

read 端用 Zod 严格校验（含 `.strict()` 拒绝额外字段、attachments 元素 schema），write 端只是 typed object 直接 `JSON.stringify`。两侧字段集 R1 后已经对齐（含 `attachments.{filename}.{sha256, size_bytes}`），但是：
1. fetch 侧 `tryReadValidManifest` (line 368-414) 用 `as Partial<DatasetManifest>` 强转，不走 Zod。如果旧 manifest 的 `attachments` 字段是 malformed 结构（如 `attachments: "string"`），`tryReadValidManifest` 会接受，进 `gaiaAttachmentsComplete` 时 `manifestEntry == null` → 返回 false → refetch。行为安全，但属于「fail-by-coincidence」。
2. 任何字段集变动需要双侧手动同步，缺乏 CI 检测。

**修复建议**：让 fetch-benchmark.ts import `cache.ts` 的 Zod schema（或抽 shared schema 包），write 前 `safeParse` 自己即将写入的 manifest，read 用同一 schema。

**Confidence**: 0.70（双轨现状不立刻 break，但维护风险）

---

#### MEDIUM-3: GAIA collect 错误信息缺 agent 输出 snippet，调试困难

**File**: `benchmarks/src/runner/runner.ts:342-365`

```ts
throw new Error(
  `GAIA agent output must be a JSON object with model_answer (${errorMessage(error)})`,
);
```

错误消息只有 JSON.parse 异常字符串，没有 agent 实际输出的前 200 字节，trajectory 调试需要回溯 OTel span 才能找到 raw output。建议改为：
```ts
const preview = loopOutput.slice(0, 200).replace(/\s+/g, " ");
throw new Error(
  `GAIA agent output must be a JSON object with model_answer (${errorMessage(error)}). Output preview: ${JSON.stringify(preview)}`,
);
```
同时区分子原因（`parse_failed` / `not_object` / `empty_model_answer` / `non_string_model_answer`）便于 dashboard 聚合统计。

**Confidence**: 0.65（不是 bug，是 ergonomics）

---

### LOW

#### LOW-1: code-review-graph 报告的 5 个 untested function 是 graph 误报，建议规则配置

graph 报 untested 但 vitest line/branch coverage 95%+。原因：graph 按导出/per-symbol 视角看，私有 helper 没有直接 test entry 就标 untested；vitest 看实际行覆盖。建议 graph 配置侧加白名单或 `@internal` 标记，避免把这类间接覆盖标记成 gap，否则将误导后续 R3+ reviewer 误以为有真 gap。

**Confidence**: 0.60（推断 graph 行为，未读 graph 实现）

---

## 4. R2 conclusion

**fix-pass-needed**：1 BLOCKING（Infinity-sentinel 哨兵碰撞 false-positive）+ 1 HIGH（host_path 泄漏到 prompt）必须修才能 close R2。HIGH-2（并发 race）、MEDIUM-1（Unicode digits）建议同轮一起修；MEDIUM-2/MEDIUM-3、LOW-1 可顺延 R3 或下一 iter。

R1 闭合的 4 项 finding 没有 regression（E2/AMB/wire schema 全部 PASS），但 R1 自身的 fix 引入了一个**新 BLOCKING**（哨兵 fallback 选错）和一个**新 HIGH**（attachment 字段泄漏 host path），符合 R2 边界检查目标 — 抓 R1 fix delta 的二阶副作用。
