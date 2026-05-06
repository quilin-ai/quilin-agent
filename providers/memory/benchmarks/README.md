# Memory Benchmark 数据目录规范

本目录存放 quilin-mem / memory provider 的 benchmark harness、输入数据说明与运行产物约定。目录规则以区分 **input dataset** 与 **output artifact** 为核心，避免数据集、manifest、测评输出混存。

## 目录约定

- `*.py`：benchmark harness 源码，例如 `amb_baseline.py`。
- `datasets/`：input dataset 入口。优先提交小型 manifest、数据集版本说明、校验和、下载脚本或生成脚本；不得直接提交大型原始数据文件，除非后续明确采用 Git LFS 策略。
- `.output/`：output artifact 默认目录，用于放置 benchmark 运行结果、临时报告、下载缓存、解压后的数据副本与中间文件。该目录默认不纳入版本控制。

## Input Dataset 规则

`datasets/` 用于记录 benchmark 可复现所需的输入来源，而不是默认承载完整数据集。

- 小型、稳定、可审查的 manifest / fixture 可以提交。
- 外部数据集优先采用 manifest-only：记录来源、版本、样本范围、hash 与下载/生成命令。
- 大型文件、压缩包、数据库快照、解压后的 raw dataset 不直接提交；如必须纳入仓库，需先在 planning / ADR 中明确 Git LFS 策略。
- 数据不可用时，benchmark 结果必须写 blocked reason，并说明替代证据来源。

## Output Artifact 规则

`.output/` 是 benchmark 运行产物的默认落点。

- 运行脚本产生的 JSON、日志、trace、临时 SQLite、下载缓存、解压副本等都放入 `.output/`。
- 需要纳入 review 的结果应整理为小型报告或 planning / review 文档引用，不直接提交 `.output/` 原始产物。
- 运行产物应可删除、可重建，不作为唯一事实源。

## 根目录 `.benchmarks/` 状态

当前根目录 `.benchmarks/e1a-smoke/` 是 M0.9a Arm L spike 遗留的 staging / 未提交残留，用于暂存 SWE-bench-Lite manifest 与 `test.jsonl` 这类 input dataset。它不是本目录的新规范入口，本次不迁移、不删除。

后续在 Arm L Spike 解锁或 LongMemEval 数据接入时，需要二选一成文决策：将仍需保留的 input dataset 迁移到 `providers/memory/benchmarks/datasets/`，或明确根目录 `.benchmarks/` 继续作为临时 staging 并加入合适的 ignore 策略。
