# 基准测试 Harness / Benchmark Harness

> 当前状态：冻结 / Frozen. 全局状态见 [STATUS.md](../STATUS.md)。

## 冻结状态 / Frozen State

Benchmark is the lowest project priority as of 2026-05-02. The `Iter E 基准冲刺 / Benchmark Ascent` Linear project is canceled, and unfinished Benchmark issues `QUI-6`, `QUI-7`, `QUI-8`, `QUI-43`, `QUI-47`, and `QUI-70` are canceled and low priority.

截至 2026-05-02，Benchmark 是全项目最低优先级。Linear project `Iter E 基准冲刺 / Benchmark Ascent` 已取消；未完成 Benchmark issue `QUI-6`、`QUI-7`、`QUI-8`、`QUI-43`、`QUI-47`、`QUI-70` 已取消并降为低优先级。

No Iter may add or modify Benchmark code unless the user explicitly asks for Benchmark work. This rule covers dataset loaders, runners, scorers, submission adapters, public leaderboard adapters, benchmark worker code, and benchmark-specific smoke or evidence-pack code.

除非用户明确要求 Benchmark 工作，任何 Iter 都不得新增或修改 Benchmark 代码。该规则覆盖 dataset loader、runner、scorer、submission adapter、公开 leaderboard adapter、benchmark worker code，以及 Benchmark 专用 smoke 或 evidence-pack 代码。

## 当前代码事实 / Current Code Facts

Existing Benchmark code remains in the repository and should be described honestly. It is not deleted by this policy, and it is not active roadmap scope.

已有 Benchmark 代码仍保留在仓库中，并应如实描述。本政策不删除这些代码，但它们不再是活跃路线图范围。

The current implementation surface includes `benchmarks/` TS/Python code for dataset fetching, GAIA/BFCL/SWE-bench slices, runner/scorer/submission wiring, DockerSandbox slices, and BFCL stateful runtime worker code. It also includes `providers/memory/benchmarks/` Python offline memory benchmark scripts.

当前实现面包括 `benchmarks/` 下的 TS/Python 代码，用于数据集抓取、GAIA/BFCL/SWE-bench 切片、runner/scorer/submission wiring、DockerSandbox 切片，以及 BFCL stateful runtime worker 代码。它还包括 `providers/memory/benchmarks/` 下的 Python 离线 memory benchmark scripts。

Local evidence from 2026-05-02: `find benchmarks/src benchmarks/scripts -type f \( -name '*.ts' -o -name '*.test.ts' -o -name '*.py' \) | wc -l` reports 62 files; `wc -l` reports 1,058 lines in `benchmarks/src/runner/runner.ts`, 449 lines in `benchmarks/src/runtime/bfcl-stateful-runtime.ts`, and 468 lines in `benchmarks/scripts/bfcl-stateful-worker.py`.

2026-05-02 本地实证：`find benchmarks/src benchmarks/scripts -type f \( -name '*.ts' -o -name '*.test.ts' -o -name '*.py' \) | wc -l` 报告 62 个文件；`wc -l` 报告 `benchmarks/src/runner/runner.ts` 为 1,058 行、`benchmarks/src/runtime/bfcl-stateful-runtime.ts` 为 449 行、`benchmarks/scripts/bfcl-stateful-worker.py` 为 468 行。

## 只读历史 / Read-Only History

Historical evidence documents in this directory are retained for context. They may explain why earlier work chose GAIA, BFCL v4, SWE-bench Verified, or SWE-bench Pro, but they no longer authorize implementation work.

本目录中的历史证据文档保留用于上下文。它们可以解释早期为什么选择 GAIA、BFCL v4、SWE-bench Verified 或 SWE-bench Pro，但不再授权实现工作。

The [coding benchmark evidence](coding-benchmark-evidence.md), [GAIA/BFCL evidence](gaia-bfcl-evidence.md), and [roadmap snapshot](roadmap.md) are now frozen references. Any future change must start from an explicit user request and a fresh Linear record.

[coding benchmark evidence](coding-benchmark-evidence.md)、[GAIA/BFCL evidence](gaia-bfcl-evidence.md) 和 [roadmap snapshot](roadmap.md) 现在都是冻结参考。任何未来变更都必须先有用户明确要求和新的 Linear 记录。

## 允许与禁止 / Allowed And Blocked

Allowed without restarting Benchmark: read existing Benchmark code, cite existing code as actual repository state, update docs to say Benchmark is frozen, and run generic repository checks that happen to traverse existing files.

无需重启 Benchmark 即允许：读取已有 Benchmark 代码、把已有代码作为真实仓库状态引用、更新 docs 说明 Benchmark 已冻结，以及运行会自然遍历既有文件的通用仓库检查。

Blocked unless the user explicitly asks: adding Benchmark files, modifying Benchmark files, adding public benchmark adapters, adding benchmark-specific tests, creating benchmark Linear issues, reopening canceled Benchmark issues, or promoting Benchmark as an Iter goal.

除非用户明确要求，否则禁止：新增 Benchmark 文件、修改 Benchmark 文件、添加公开 benchmark adapter、添加 Benchmark 专用测试、新建 Benchmark Linear issue、重开已取消 Benchmark issue，或把 Benchmark 提升为 Iter 目标。
