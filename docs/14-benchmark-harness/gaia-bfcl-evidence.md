# GAIA 与 BFCL v4 证据包 / GAIA and BFCL v4 Evidence Pack

> Verified by Subagent C for Linear QUI-71 on 2026-05-02 local session time.
>
> Subagent C 于本地会话时间 2026-05-02 为 Linear QUI-71 核验。
>
> Frozen note, 2026-05-02: this document is a historical evidence pack only. Iter E is frozen/canceled, unfinished GAIA/BFCL Benchmark issues are canceled/Low, and no GAIA or BFCL code may be added or modified unless the user explicitly asks for Benchmark work.
>
> 冻结说明，2026-05-02：本文只作为历史证据包保留。Iter E 已冻结/取消，未完成的 GAIA/BFCL Benchmark issue 已取消并降为低优先级；除非用户明确要求 Benchmark 工作，不得新增或修改 GAIA 或 BFCL 代码。

## 结论 / Conclusion

The earlier conclusion that GAIA（General AI Assistants, a benchmark for evaluating general assistant ability across reasoning, tool use, browsing, and multimodal files）and BFCL v4（Berkeley Function Calling Leaderboard v4, a benchmark for evaluating function/tool-calling and agentic tool use）remain valid non-coding Iter E anchors is now frozen. The evidence remains useful for describing existing code and past planning, but it no longer authorizes Iter E work.

此前认为 GAIA（General AI Assistants，一个评估通用助理在推理、工具使用、浏览和多模态文件处理上能力的基准）与 BFCL v4（Berkeley Function Calling Leaderboard v4，一个评估函数/工具调用与 Agentic 工具使用能力的基准）仍适合作为 Iter E 非代码锚点的结论现在已经冻结。证据仍可用于描述既有代码和历史规划，但不再授权 Iter E 工作。

The current Linear state is different: `QUI-5` is historical/done, while unfinished Benchmark issues `QUI-6`, `QUI-7`, and `QUI-47` are canceled/Low. Do not finish BFCL stateful-worker confirmation, build a BFCL runner adapter, or preserve GAIA/BFCL as active anchors unless the user explicitly restarts Benchmark work.

当前 Linear 状态已经不同：`QUI-5` 是历史完成项，而未完成 Benchmark issue `QUI-6`、`QUI-7` 与 `QUI-47` 已取消并降为低优先级。除非用户明确重启 Benchmark 工作，不得继续 BFCL stateful-worker 确认、构建 BFCL runner adapter，或把 GAIA/BFCL 保留为活跃锚点。

## 官方来源 / Official Sources

GAIA evidence uses the official Hugging Face GAIA organization page, the gated `gaia-benchmark/GAIA` dataset card, the official Hugging Face leaderboard Space source, and the ICLR 2024 paper. Key links: [GAIA organization](https://huggingface.co/gaia-benchmark), [GAIA dataset](https://huggingface.co/datasets/gaia-benchmark/GAIA), [GAIA leaderboard Space](https://huggingface.co/spaces/gaia-benchmark/leaderboard), [GAIA leaderboard scorer](https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py), [GAIA leaderboard app](https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/app.py), and [GAIA paper](https://openreview.net/pdf?id=fibxvahvs3).

GAIA 证据使用官方 Hugging Face GAIA 组织页、gated dataset（需同意访问条件的数据集）`gaia-benchmark/GAIA` 卡片、官方 Hugging Face leaderboard Space 源码，以及 ICLR 2024 论文。关键链接：[GAIA organization](https://huggingface.co/gaia-benchmark)、[GAIA dataset](https://huggingface.co/datasets/gaia-benchmark/GAIA)、[GAIA leaderboard Space](https://huggingface.co/spaces/gaia-benchmark/leaderboard)、[GAIA leaderboard scorer](https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py)、[GAIA leaderboard app](https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/app.py)、[GAIA paper](https://openreview.net/pdf?id=fibxvahvs3)。

BFCL v4 evidence uses the official Berkeley leaderboard, v4 release blogs, ICML 2025 paper, GitHub repository docs, and official test category/changelog docs. Key links: [BFCL v4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard), [BFCL v4 web search](https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html), [BFCL v4 memory](https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html), [BFCL v4 format sensitivity](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html), [BFCL paper](https://openreview.net/pdf/d52a12bb32128210600246f8979d90b892505cca.pdf), [BFCL GitHub runner](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard), [test categories](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md), and [changelog](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/CHANGELOG.md).

BFCL v4 证据使用官方 Berkeley leaderboard、v4 发布博客、ICML 2025 论文、GitHub 仓库文档，以及官方 test category（测试类别）与 changelog（变更日志）文档。关键链接：[BFCL v4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard)、[BFCL v4 web search](https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html)、[BFCL v4 memory](https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html)、[BFCL v4 format sensitivity](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)、[BFCL paper](https://openreview.net/pdf/d52a12bb32128210600246f8979d90b892505cca.pdf)、[BFCL GitHub runner](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)、[test categories](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md)、[changelog](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/CHANGELOG.md)。

## GAIA 当前范围 / GAIA Current Scope

The official GAIA dataset card says the benchmark has more than 450 non-trivial questions with unambiguous answers, split into three levels. The official leaderboard app fixes the 2023 split at 165 validation questions and 301 private test questions, with validation level counts 53/86/26 and test level counts 93/159/49. The ICLR paper describes 466 carefully crafted questions, which matches 165 + 301 in the current leaderboard code.

官方 GAIA 数据集卡片说明该基准包含 450 多道有明确答案的非平凡问题，并分为三个难度等级。官方 leaderboard app 将 2023 split（数据切分）固定为 165 道 validation（验证集）题与 301 道 private test（私有测试集）题，其中 validation 各等级为 53/86/26，test 各等级为 93/159/49。ICLR 论文描述 466 道精心构造的问题，与当前 leaderboard 代码中的 165 + 301 一致。

The current dataset is gated on Hugging Face. The dataset card requires users to agree not to reshare validation or test data in crawlable form, and it notes an October 2025 format update: Parquet-backed splits mirror the former JSONL structure, with columns such as `task_id`, `Question`, `Level`, `Final answer`, `file_name`, `file_path`, and `Annotator Metadata`.

当前数据集在 Hugging Face 上是 gated（需要同意访问条件）。数据集卡片要求用户不要以可爬取形式重新分享 validation 或 test 数据，并说明 2025 年 10 月格式更新：Parquet-backed splits（以 Parquet 支撑的数据切分）镜像旧 JSONL 结构，列包括 `task_id`、`Question`、`Level`、`Final answer`、`file_name`、`file_path` 和 `Annotator Metadata`。

GAIA questions require a general assistant to combine reasoning, web browsing, tool use, and file handling. Attachments may include documents, images, audio, and other files. Level 1 usually needs no tool or one tool within about five steps; Level 2 usually needs roughly five to ten steps and multiple tools; Level 3 is intended to require much longer action chains and stronger autonomy.

GAIA 题目要求通用助理组合推理、网页浏览、工具使用和文件处理。附件可能包括文档、图片、音频和其他文件。Level 1 通常不需要工具，或最多一个工具且大约五步内完成；Level 2 通常需要约五到十步并组合多个工具；Level 3 目标是要求更长行动链和更强自主性。

## GAIA 计分与运行要求 / GAIA Scoring and Runtime Requirements

The official scorer performs deterministic exact matching. Numeric answers are converted to floats after stripping common characters such as dollar signs, percent signs, and commas. List answers are split on commas or semicolons and compared element by element. String answers are normalized by removing whitespace, optionally stripping punctuation, and lowercasing. The official app computes overall score as correct answers divided by the fixed split length, plus per-level scores.

官方 scorer（计分器）执行确定性的 exact matching（精确匹配）。数字答案会在去掉美元符号、百分号和逗号等常见字符后转为浮点数。列表答案按逗号或分号拆分，并逐项比较。字符串答案会移除空白、可选移除标点并转为小写。官方 app 将总分计算为正确题数除以固定 split 长度，同时计算各等级分数。

Submission to the official leaderboard is not just a local file format. The Space asks for agent name, model family, system prompt example, model URL, organization, contact email, and a JSONL file; it also uses Hugging Face OAuth and private gold answers for the test split. A local validation run can reproduce scoring behavior, but it does not equal an official test submission.

提交到官方 leaderboard 不只是生成本地文件格式。Space 要求提供 agent name（Agent 名称）、model family（模型族）、system prompt example（系统提示示例）、model URL、organization（组织）、contact email（联系邮箱）和 JSONL 文件；它还使用 Hugging Face OAuth 与 test split 的私有金标答案。本地 validation 运行可以复现计分行为，但不等于官方 test 提交。

The local benchmark runner must therefore provide three capabilities before GAIA can be treated as fully runnable: authenticated data fetch with `HF_TOKEN`, attachment-safe workspace staging, and a GAIA execution profile that gives the agent appropriate browsing, search, shell/file, and multimodal file-reading tools while preserving trace and cost capture.

因此，本地 benchmark runner（评测运行器，负责加载数据、运行 agent、计分和生成提交文件）在 GAIA 被视为完整可运行前，必须具备三类能力：用 `HF_TOKEN` 认证拉取数据、安全地把附件放入工作区，以及提供 GAIA 执行 profile（执行配置），让 agent 拥有合适的浏览、搜索、shell/file、多模态文件读取工具，同时保留 trace（轨迹）与 cost（成本）采集。

## BFCL v4 当前范围 / BFCL v4 Current Scope

The official BFCL v4 leaderboard states that BFCL v4 evaluates function/tool calling accuracy, is periodically updated, was last updated on 2026-04-12, and evaluates models at commit `f7cf735`; it also names `bfcl-eval==2025.12.17` as the reproduction package for that snapshot. This confirms Quilin's local pinned commit matches the official current leaderboard snapshot.

官方 BFCL v4 leaderboard 说明 BFCL v4 评估函数/工具调用准确率，会定期更新，最近更新时间是 2026-04-12，并在 commit `f7cf735` 上评测模型；它还指定 `bfcl-eval==2025.12.17` 作为该快照的复现包。这确认 Quilin 本地 pin 的 commit 与官方当前 leaderboard 快照一致。

BFCL v4 score scope is broader than earlier BFCL slices. The v4 blog and changelog define the current scoring formula as a percentage-weighted average across five scoring groups: Agentic 40%, Multi-Turn 30%, Live 10%, Non-Live 10%, and Hallucination Measurement 10%. Within those groups, some categories are unweighted averages and Live is weighted by category row counts. Format Sensitivity has 5,200 test cases but is non-scoring.

BFCL v4 的计分范围比早期 BFCL 切片更广。v4 博客和 changelog 将当前计分公式定义为五个 scoring group（计分组）的固定百分比加权平均：Agentic 40%、Multi-Turn 30%、Live 10%、Non-Live 10%、Hallucination Measurement 10%。在这些组内，部分类别按无权平均计算，Live 按类别题数加权。Format Sensitivity（格式敏感性）有 5,200 道测试，但不影响总分。

The official test category docs list runnable groups and individual categories. Scoring categories include non-live AST categories, live AST categories, hallucination/relevance categories, four multi-turn categories, memory categories (`memory_kv`, `memory_vector`, `memory_rec_sum`), and web search categories (`web_search_base`, `web_search_no_snippet`). `format_sensitivity` is explicitly limited to prompting-mode models that rely on BFCL's default system prompt.

官方 test category 文档列出可运行的组与单独类别。计分类别包括 non-live AST（非实时抽象语法树）类别、live AST（实时抽象语法树）类别、hallucination/relevance（幻觉/相关性）类别、四个 multi-turn（多轮）类别、memory（记忆）类别（`memory_kv`、`memory_vector`、`memory_rec_sum`），以及 web search（网页搜索）类别（`web_search_base`、`web_search_no_snippet`）。`format_sensitivity` 明确只适用于依赖 BFCL 默认系统提示的 prompting-mode models（提示模式模型）。

## BFCL v4 计分与运行要求 / BFCL v4 Scoring and Runtime Requirements

BFCL uses several verification modes. AST（Abstract Syntax Tree, a structured representation of function calls used for deterministic comparison）matching checks function names, argument values, type rules, ordering, and parallel-call ordering rules. Multi-turn and agentic categories require state-transition verification, where the evaluator checks whether the model's tool calls produce the expected backend state and answers across turns.

BFCL 使用多种验证方式。AST（Abstract Syntax Tree，抽象语法树，用于确定性比较函数调用的结构化表示）matching 会检查函数名、参数值、类型规则、顺序，以及 parallel call（并行调用）的顺序规则。Multi-turn 与 agentic 类别需要 state-transition verification（状态迁移验证），评测器会检查模型工具调用是否在多轮中产生期望的后端状态和答案。

The official runner is a Python package and repository flow. The GitHub README requires Python 3.10 for the documented environment, supports `pip install bfcl-eval`, requires `BFCL_PROJECT_ROOT` when installed from PyPI so result and score files are discoverable, and separates response generation from evaluation with commands such as `bfcl generate` and `bfcl evaluate`. Partial evaluation exists, but official docs warn partial scores may not match leaderboard numbers.

官方 runner 是 Python package（Python 包）和仓库流程。GitHub README 记录的环境要求 Python 3.10，支持 `pip install bfcl-eval`，从 PyPI 安装时需要 `BFCL_PROJECT_ROOT` 以便找到 result（结果）与 score（分数）文件，并用 `bfcl generate` 与 `bfcl evaluate` 等命令分离响应生成和评估。官方支持 partial evaluation（部分评测，仅跑子集），但文档警告部分评测分数可能不匹配 leaderboard 数字。

The BFCL v4 web-search category uses a standardized search interface and webpage fetch tool; the official blog describes DuckDuckGo search and `fetch_url_content` with raw, markdown, and truncate modes, including simulated request failures. The memory category uses three backends: key-value memory, vector memory with embeddings/FAISS, and recursive summarization, with snapshot-and-reload isolation between sessions and evaluation questions.

BFCL v4 的 web-search 类别使用标准化搜索接口和网页抓取工具；官方博客描述了 DuckDuckGo search 与 `fetch_url_content`，后者支持 raw、markdown 和 truncate 三种模式，并包含模拟请求失败。memory 类别使用三种后端：key-value memory（键值记忆）、vector memory（向量记忆，使用 embedding/FAISS）和 recursive summarization（递归总结），并在 session（会话）与评测问题之间使用 snapshot-and-reload（快照并重新加载）隔离。

## 本地 runner 现状 / Local Runner State

The local tree already contains useful slices: `benchmarks/scripts/fetch-benchmark.ts` pins BFCL v4 to `f7cf735`, fetches GAIA validation through Hugging Face dataset rows with `HF_TOKEN`, and fetches BFCL category JSON plus multi-turn checker support files. `benchmarks/src/datasets/gaia.ts` expects 165 validation rows and stages attachments. `benchmarks/src/scorers/gaia-exact-match.ts` mirrors the official GAIA scorer closely.

本地代码树已有有价值的切片：`benchmarks/scripts/fetch-benchmark.ts` 将 BFCL v4 pin 到 `f7cf735`，通过 Hugging Face dataset rows 与 `HF_TOKEN` 拉取 GAIA validation，并拉取 BFCL 类别 JSON 与 multi-turn checker support files（多轮计分器支持文件）。`benchmarks/src/datasets/gaia.ts` 期望 165 行 validation，并处理附件。`benchmarks/src/scorers/gaia-exact-match.ts` 与官方 GAIA scorer 高度一致。

The local BFCL AST path is still a partial scorer, not official v4 parity. `benchmarks/src/datasets/bfcl-v4.ts` limits AST loading to non-live and live categories, marks `official_parity: false`, and records `partial_eval: true`. `benchmarks/src/scorers/bfcl-v4-ast.ts` implements a deterministic AST approximation for function names, arguments, type normalization, and ordered/unordered matching, but it is not the official `bfcl-eval` score aggregation path.

本地 BFCL AST 路径仍是部分 scorer，不是官方 v4 parity。`benchmarks/src/datasets/bfcl-v4.ts` 只加载 non-live 与 live AST 类别，标记 `official_parity: false`，并记录 `partial_eval: true`。`benchmarks/src/scorers/bfcl-v4-ast.ts` 实现了函数名、参数、类型归一化、有序/无序匹配的确定性 AST 近似，但它不是官方 `bfcl-eval` 的总分聚合路径。

The local multi-turn path is also partial. `benchmarks/src/datasets/bfcl-v4-multi-turn.ts` loads the four multi-turn categories and marks `stateful_eval: false`. `benchmarks/src/scorers/bfcl-v4-multi-turn.ts` shells out to a pinned checker bundle, and `benchmarks/src/runtime/bfcl-stateful-runtime.ts` plus `benchmarks/scripts/bfcl-stateful-worker.py` remain existing code facts. Follow-up R1/R2 confirmation and a full BFCL-specific runner adapter are frozen.

本地 multi-turn 路径也是部分实现。`benchmarks/src/datasets/bfcl-v4-multi-turn.ts` 加载四个 multi-turn 类别，并标记 `stateful_eval: false`。`benchmarks/src/scorers/bfcl-v4-multi-turn.ts` 通过 shell 调用 pinned checker bundle（固定版本计分器包），`benchmarks/src/runtime/bfcl-stateful-runtime.ts` 与 `benchmarks/scripts/bfcl-stateful-worker.py` 保留为既有代码事实。后续 R1/R2 确认和完整 BFCL-specific runner adapter 已冻结。

## 本地缺口 / Local Gaps

GAIA's main local gap is execution, not scoring. The local scorer and validation loader are good enough for offline validation, but the runner still needs a GAIA-specific execution profile for browser/search, attachment reading, multimodal extraction, timeouts, trace capture, and official-test submission packaging. The docs should not claim GAIA official leaderboard readiness until that profile and submission path exist.

GAIA 的主要本地缺口是执行，不是计分。本地 scorer 和 validation loader 足以做离线 validation，但 runner 仍需要 GAIA-specific execution profile（GAIA 专用执行配置），覆盖浏览器/搜索、附件读取、多模态提取、超时、trace 采集与官方 test 提交打包。在该 profile 与提交路径存在前，docs 不应声称 GAIA 已具备官方 leaderboard 就绪度。

BFCL v4's main local gap is official v4 coverage. The current local work covers AST and a multi-turn/stateful foundation, but not the full official formula, not the agentic web-search categories, not the memory backends, not the hallucination/relevance aggregation, and not the non-scoring format-sensitivity reporting surface. It also emits manifests marked `partial_eval: true` and `official_parity: false`, which is the right honest state.

BFCL v4 的主要本地缺口是官方 v4 覆盖度。当前本地工作覆盖 AST 与 multi-turn/stateful 基础，但尚未覆盖完整官方公式、agentic web-search 类别、memory 后端、hallucination/relevance 聚合，以及 non-scoring format-sensitivity 报告面。它也会输出标记为 `partial_eval: true` 与 `official_parity: false` 的 manifest，这是当前诚实状态。

The historical runner gap was score aggregation and output parity. A full BFCL run would have needed the official result directory layout, category grouping, per-category files, weighted v4 score formula, cost/latency accounting, and known behavior for partial evaluation. That gap is not an active work item because QUI-7 is canceled.

历史 runner 缺口是分数聚合和输出 parity。完整 BFCL 运行本来需要复现官方 result 目录布局、类别分组、分类别文件、v4 加权计分公式、成本/延迟统计，以及 partial evaluation 的已知行为。由于 QUI-7 已取消，该缺口不是活跃工作项。

## Issue 判断 / Issue Decisions

QUI-5 is historical/done. Its existing code and review trail may be read as repository state, but no follow-up Benchmark code should be created from it without a user request.

QUI-5 是历史完成项。它的既有代码和 review trail 可作为仓库状态读取，但不得在没有用户请求时从它派生新的 Benchmark 代码。

QUI-6 is canceled/Low. Do not perform R2 confirmation or carry forward BFCL multi-turn findings unless the user explicitly asks for Benchmark work.

QUI-6 已取消并降为低优先级。除非用户明确要求 Benchmark 工作，不得执行 R2 确认或延续 BFCL multi-turn finding。

QUI-7 is canceled/Low. Do not implement BFCL v4 adapter parity, output layout, partial-eval semantics, or score aggregation unless the user explicitly asks.

QUI-7 已取消并降为低优先级。除非用户明确要求，不得实现 BFCL v4 adapter parity、输出布局、partial-eval 语义或分数聚合。

QUI-47 is canceled/Low. It no longer decides a coding replacement or preserves non-coding anchors unless Benchmark work is explicitly restarted.

QUI-47 已取消并降为低优先级。除非 Benchmark 工作被明确重启，它不再决定代码替代基准，也不保留非代码锚点。

QUI-8 is canceled/Low. Aspirational benchmarks should not move forward unless the user explicitly requests Benchmark work.

QUI-8 已取消并降为低优先级。除非用户明确要求 Benchmark 工作，不得推进 aspirational benchmarks（远期基准）。

## 需要降级或修正的 docs 假设 / Docs Assumptions to Downgrade or Correct

Downgrade "E3a GAIA closed" to "GAIA validation loader/scorer closed." The official test path still requires private-answer submission through the Hugging Face Space, plus an execution profile for browser/search/file/multimodal tools.

需要将 "E3a GAIA closed" 降级为 "GAIA validation loader/scorer closed"。官方 test 路径仍需要通过 Hugging Face Space 提交私有答案，还需要面向浏览器/搜索/文件/多模态工具的执行 profile。

Correct the roadmap claim that GAIA uses an LLM-based evaluator. Official GAIA scoring is deterministic exact match over final answers after normalization.

需要修正 roadmap 中 GAIA 使用 LLM-based evaluator 的说法。官方 GAIA 计分是对最终答案标准化后的确定性 exact match。

Downgrade "E3b BFCL AST closed" and "E3c1a BFCL multi-turn fixture closed" to slice-level status. Those are useful local milestones, but full BFCL v4 requires v4 weighted aggregation, stateful worker confirmation, agentic web search, memory backends, hallucination/relevance categories, and official output layout.

需要将 "E3b BFCL AST closed" 与 "E3c1a BFCL multi-turn fixture closed" 降级为 slice-level status（切片级状态）。它们是有用的本地里程碑，但完整 BFCL v4 需要 v4 加权聚合、有状态 worker 确认、agentic web search、memory 后端、hallucination/relevance 类别和官方输出布局。

Correct the shorthand "BFCL v4 = function calling accuracy" when it appears as a complete description. It is acceptable as a label, but the current official v4 benchmark is a holistic agentic tool-use benchmark with single-turn, live, hallucination, multi-turn, web-search, memory, and non-scoring format-sensitivity surfaces.

需要修正把 "BFCL v4 = function calling accuracy" 当作完整描述的简写。作为标签可以接受，但当前官方 v4 是 holistic agentic tool-use benchmark（整体 Agentic 工具使用基准），包含 single-turn、live、hallucination、multi-turn、web-search、memory 和 non-scoring format-sensitivity 等面。

Treat roadmap SOTA and target numbers as historical until refreshed. The BFCL official leaderboard is periodically updated and currently names 2026-04-12 plus commit `f7cf735`; GAIA public result data is also updated separately. Any success target should cite the exact snapshot date and formula used.

在刷新前，应把 roadmap 中的 SOTA 与目标数字视为历史值。BFCL 官方 leaderboard 会周期更新，当前标注 2026-04-12 与 commit `f7cf735`；GAIA public result data 也会独立更新。任何成功目标都应引用精确的快照日期和所用公式。

## 建议下一步 / Recommended Next Steps

Use this file and QUI-71 only as historical evidence records. Do not add follow-up implementation or verification comments to QUI-5/QUI-6/QUI-7/QUI-47 unless the user explicitly restarts Benchmark work.

本文和 QUI-71 只作为历史证据记录。除非用户明确重启 Benchmark 工作，不要向 QUI-5/QUI-6/QUI-7/QUI-47 添加后续实现或验证 comment。

If the user later restarts Benchmark work, any full benchmark claim would need a smoke sequence proving cache fetch, task loading, one runner task, scorer output, submission serialization, and trace/cost capture for the specific slice. That sequence is not current work.

如果用户未来重启 Benchmark 工作，任何完整 benchmark 声明都需要先运行 smoke sequence（冒烟序列），证明特定切片的 cache fetch（缓存拉取）、task loading（任务加载）、单题 runner、scorer output（计分输出）、submission serialization（提交序列化）和 trace/cost capture（轨迹/成本采集）。该序列不是当前工作。
