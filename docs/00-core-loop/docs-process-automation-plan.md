# Docs/process 自动化检查实现规划 / Docs/process Automation Check Implementation Plan

Planning timestamp: 2026-05-02 Asia/Shanghai workspace time. Linear record: `QUI-69` is the implementation-planning issue for docs/process automation checks. This document creates no new Linear issue and maps all follow-up work to existing `QUI-69`, `QUI-57`, `QUI-76`, and `QUI-78`.

规划时间：2026-05-02（工作区 Asia/Shanghai 时间）。Linear 记录：`QUI-69` 是 docs/process 自动化检查的实现规划 issue。本文不创建新的 Linear issue，并把全部后续工作映射到既有 `QUI-69`、`QUI-57`、`QUI-76` 和 `QUI-78`。

## 目标 / Goal

The goal is to turn the docs/process rules that are now written in `quilin.md`, `docs/README.md`, and `docs/00-core-loop/docs-process-frontier-assimilation.md` into a conservative local gate. The gate should catch predictable process failures before review: English-only project docs, glossary drift, unsupported status claims, source-of-truth drift, accidental generated artifacts, and task-tracking leakage back into docs.

目标是把已经写在 `quilin.md`、`docs/README.md` 和 `docs/00-core-loop/docs-process-frontier-assimilation.md` 中的 docs/process 规则，转成一个保守的本地门禁。该门禁应在 review（审核）前捕获可预测流程错误：英文-only 项目文档、术语漂移、缺少证据的状态声明、事实源漂移、误提交生成物，以及任务追踪重新泄漏回 docs。

The first version should prefer deterministic text checks over semantic judgment. It should fail only when the repository can prove a rule was broken locally; ambiguous cases should warn with a remediation message and remain human-review items.

第一版应优先使用确定性的文本检查，而不是语义判断。只有当仓库本地证据能证明规则被违反时才失败；模糊情况应给出 warning（警告）和修复提示，并保留给人工 review 判断。

## 输入事实 / Input Facts

`docs/00-core-loop/docs-process-frontier-assimilation.md` decides that Linear remains the internal task source, `docs/STATUS.md` remains the global state snapshot, component `README.md` files remain current architecture facts, and `agent-bridge.md` remains only the AgentBridge collaboration protocol source.

`docs/00-core-loop/docs-process-frontier-assimilation.md` 已决定：Linear 继续作为内部任务源，`docs/STATUS.md` 继续作为全局状态快照，组件 `README.md` 继续作为当前架构事实源，而 `agent-bridge.md` 只作为 AgentBridge 协作协议源。

`quilin.md` defines four hard project rules that this plan must preserve: execution must be recorded in Linear, Linear issue count is limited by the free-plan cap, new or rewritten project docs must be bilingual by paragraph, and acronyms or internal terms must be explained on first use.

`quilin.md` 定义了四条本文必须保留的项目硬规则：执行必须记录到 Linear，Linear issue 数量受免费版上限约束，新增或重写项目文档必须按段落中英双语，缩写或内部术语首次出现必须解释。

`scripts/lint-glossary.py` already provides a narrow terminology check against known glossary drift. It ignores code blocks, inline code, web links, Markdown link targets, and file paths, which is the right false-positive control model for the next docs/process gate.

`scripts/lint-glossary.py` 已经提供了针对已知术语漂移的窄范围检查。它会忽略代码块、行内代码、网页链接、Markdown 链接目标和文件路径，这是下一版 docs/process 门禁应沿用的误报控制模型。

`.github/workflows/docs.yml` already runs glossary lint and Markdown link checks in CI（Continuous Integration，持续集成，用来在提交或 pull request 中自动运行检查）. It still excludes `docs/*/evidence`, so `QUI-69` should stop treating evidence directories as silently ignored input and instead make their reappearance a drift failure.

`.github/workflows/docs.yml` 已经在 CI（Continuous Integration，持续集成，用来在提交或 pull request 中自动运行检查）中执行术语检查和 Markdown 链接检查。它目前仍排除 `docs/*/evidence`，所以 `QUI-69` 应停止把 evidence 目录当作静默忽略输入，而应把它们重新出现视为漂移失败。

## 总体设计 / Overall Design

Implement one future script, tentatively named `scripts/lint-docs-process.py`, as the orchestration point for docs/process checks. The script should accept explicit paths for targeted validation and should default to changed Markdown and process files when no path is supplied.

实现一个未来脚本，暂定名为 `scripts/lint-docs-process.py`，作为 docs/process 检查的编排入口。该脚本应支持显式传入路径做定向验证；未传路径时，应默认检查发生变更的 Markdown 和流程文件。

The script should produce bilingual failure output. Every failing rule should include an English explanation, a Chinese explanation, the file and line where feasible, and a concrete remediation step.

该脚本应输出中英双语失败信息。每条失败规则都应包含英文解释、中文解释、可行时包含文件和行号，并给出具体修复步骤。

The script should not query Linear or GitHub during ordinary local lint. Linear（the internal issue tracker used for planning and task records）and GitHub（the code hosting and public collaboration system）can be checked through local text signals only, such as branch names, issue identifiers in docs, and workflow configuration files.

普通本地 lint（静态检查）期间，脚本不应查询 Linear 或 GitHub。Linear（内部 issue 追踪系统，用于规划和任务记录）和 GitHub（代码托管与公开协作系统）只能通过本地文本信号检查，例如分支名、文档中的 issue 编号和 workflow（自动化流程）配置文件。

## 检查一：中英双语文档 / Check 1: Bilingual Docs

The bilingual docs check verifies that new or rewritten project documentation uses paired prose: one English paragraph followed by the corresponding Chinese paragraph. It applies to root project Markdown files and `docs/` Markdown files, except generated upstream-style content explicitly excluded by policy.

中英双语文档检查用于验证新增或重写的项目文档是否采用段落配对：一段英文后接对应中文段落。它适用于根目录项目 Markdown 文件和 `docs/` 下的 Markdown 文件，但按策略明确排除的上游式生成内容除外。

The first implementation should strip code fences, inline code, Markdown tables, blockquotes, web links, short metadata lines, and source-list bullets before language detection. It should then classify each remaining prose block as English-like, Chinese-like, mixed, or unknown using Unicode character ratios and simple stopword hints.

第一版实现应先移除代码块、行内代码、Markdown 表格、引用块、网页链接、短元数据行和来源列表 bullet（项目符号项），再做语言检测。随后用 Unicode（字符编码标准）字符比例和简单停用词线索，把剩余散文块分类为类似英文、类似中文、混合或未知。

The check should fail when an English-like paragraph is not followed by a Chinese-like or mixed paragraph before the next heading. It should also fail when a Chinese-like paragraph starts a section that is supposed to mirror a previous English paragraph but no English paragraph exists.

当类似英文的段落在下一个标题前没有跟随类似中文或混合段落时，检查应失败。当类似中文的段落启动一个本应对照前一段英文的 section（章节），但前面没有英文段落时，也应失败。

The remediation should be explicit: "Add a Chinese paragraph immediately after this English paragraph" and "在该英文段落后立即补充对应中文段落". The message should avoid judging translation quality because semantic equivalence remains a human-review responsibility.

修复提示必须明确："Add a Chinese paragraph immediately after this English paragraph" 和 "在该英文段落后立即补充对应中文段落"。提示不应评价翻译质量，因为语义等价仍是人工 review 责任。

## 检查二：术语强制 / Check 2: Glossary Enforcement

Glossary enforcement should keep `scripts/lint-glossary.py` as the current source of terminology rules. `QUI-69` should call it from the new orchestration script rather than reimplementing the same checks in parallel.

术语强制应继续把 `scripts/lint-glossary.py` 作为当前术语规则源。`QUI-69` 应在新的编排脚本中调用它，而不是并行重写同一批检查。

The next improvement is to move hard-coded terminology rules into structured data under `docs/00-core-loop/glossary.md` or a small adjacent machine-readable file. Machine-readable means a format such as JSON（JavaScript Object Notation，一种结构化数据格式）or YAML（YAML Ain't Markup Language，一种结构化配置格式）that scripts can parse without reading prose.

下一步改进是把硬编码术语规则迁移到 `docs/00-core-loop/glossary.md` 或其相邻的小型机器可读文件中。机器可读指 JSON（JavaScript Object Notation，一种结构化数据格式）或 YAML（YAML Ain't Markup Language，一种结构化配置格式）这类脚本无需理解散文即可解析的格式。

The glossary check should keep the current ignore model: code fences, inline code, web links, paths, upstream directories, and explicitly historical mentions should not fail. This prevents the linter from punishing examples that explain which terms are forbidden.

术语检查应保留当前忽略模型：代码块、行内代码、网页链接、路径、上游目录和明确的历史说明不应失败。这可以避免 linter（静态检查器）误伤那些用于解释禁用术语的示例。

## 检查三：实证声明 / Check 3: Evidence Claim Check

The evidence claim check should identify high-risk progress claims and require nearby proof. High-risk claims include "done", "implemented", "landed", "closed", "complete", `✅`, "已实现", "完成", "通过", "覆盖率", "LOC", and "tests passed".

实证声明检查应识别高风险进度声明，并要求附近存在证据。高风险声明包括 "done"、"implemented"、"landed"、"closed"、"complete"、`✅`、"已实现"、"完成"、"通过"、"覆盖率"、"LOC" 和 "tests passed"。

Acceptable nearby proof should include a commit hash, a command with result, a line count, a test count, a Linear issue identifier, a GitHub pull request link, or a concrete file path with enough context. The check should search within the same paragraph and the next two lines before failing.

可接受的附近证据应包括 commit hash（提交哈希）、带结果的命令、行数、测试数量、Linear issue 编号、GitHub pull request（代码合并请求）链接，或带足够上下文的具体文件路径。检查应在同一段落和后续两行内搜索证据，再决定是否失败。

The failure message should say which proof forms are accepted. For example: "Add a command result, commit hash, line count, test count, Linear link, or file path near this claim" and "在该声明附近补充命令结果、提交哈希、行数、测试数量、Linear 链接或文件路径"。

失败信息应说明哪些证据形式可接受。例如："Add a command result, commit hash, line count, test count, Linear link, or file path near this claim" 和 "在该声明附近补充命令结果、提交哈希、行数、测试数量、Linear 链接或文件路径"。

## 检查四：状态漂移 / Check 4: Status Drift

The status drift check should guard the source-of-truth model. It should fail when old top-level docs archive directories return, when any `docs/*/evidence` directory exists, when numbered component directories lack a `README.md`, or when `docs/README.md` does not list an existing numbered component directory.

状态漂移检查应保护事实源模型。以下情况应失败：旧顶层 docs 档案目录回归、存在任何 `docs/*/evidence` 目录、编号组件目录缺少 `README.md`，或 `docs/README.md` 未列出某个现有编号组件目录。

The first implementation can also compare `docs/STATUS.md` against existing component directories. If `docs/STATUS.md` references a component number that has no directory, or omits an active component that exists under `docs/`, the check should fail or warn depending on confidence.

第一版也可以把 `docs/STATUS.md` 与现有组件目录做比对。如果 `docs/STATUS.md` 引用了没有目录的组件编号，或漏掉了 `docs/` 下存在的活跃组件，检查应根据置信度选择失败或警告。

The check should not try to prove that every status statement is semantically current. It should only catch structural drift that local files can prove.

该检查不应尝试证明每条状态声明在语义上都仍然最新。它只应捕获本地文件能够证明的结构性漂移。

## 检查五：Linear/GitHub 卫生 / Check 5: Linear/GitHub Hygiene

Linear/GitHub hygiene should enforce local collaboration signals without using network calls. For internal work, docs that describe active work should include a Linear issue identifier such as `QUI-69`; for public work later, GitHub issue templates can require structured bug and feature reports.

Linear/GitHub 卫生检查应在不使用网络请求的前提下，约束本地协作信号。对内部工作，描述活跃工作的 docs 应包含类似 `QUI-69` 的 Linear issue 编号；对未来公开工作，GitHub issue template（issue 模板）可以要求结构化 bug 与 feature report（缺陷与功能报告）。

The check should fail when a docs file looks like a task board. Local signals include headings such as "TODO", "Backlog", "Sprint", "Task Board", "任务看板", or unchecked checklist blocks with owner and due-date fields. Architecture docs can still mention future work when they link to Linear and describe design constraints rather than acting as a backlog.

当某个 docs 文件看起来像任务看板时，检查应失败。本地信号包括 "TODO"、"Backlog"、"Sprint"、"Task Board"、"任务看板" 等标题，或带 owner（负责人）和 due date（截止日期）字段的未完成 checklist（检查清单）。架构文档仍可提到未来工作，但必须链接 Linear 并描述设计约束，而不是充当 backlog。

The check should warn when a newly added process document mentions GitHub issue sync without also saying that Linear remains the internal task source. This protects the current split between internal planning and future public intake.

当新增流程文档提到 GitHub issue sync（GitHub issue 同步）却没有说明 Linear 仍是内部任务源时，检查应给出警告。这可以保护当前“内部规划”和“未来公开入口”的分工。

## 检查六：生成物策略 / Check 6: Generated Artifact Policy

Generated artifact policy should fail when disposable output is staged or placed under source docs without promotion evidence. Disposable output includes `.logs/`, `.patches/`, build directories, benchmark scratch data, graph databases, coverage files, and local identity files.

生成物策略应在可丢弃输出被 staged（暂存）或放入源 docs 且没有提升证据时失败。可丢弃输出包括 `.logs/`、`.patches/`、构建目录、benchmark（基准测试）草稿数据、图数据库、覆盖率文件和本地身份文件。

If a generated report becomes source documentation, the document must state its generator or source command, cite the source files or external sources, and be rewritten as bilingual prose. A raw generated report should remain an artifact, not a source fact.

如果生成报告要成为源文档，该文档必须说明生成器或来源命令，引用源文件或外部来源，并改写成中英双语散文。原始生成报告应保留为 artifact（产物），而不是成为源事实。

The check should read `.gitignore` and known ignored paths before failing, so it does not duplicate existing Git behavior. It should focus on generated files that are not ignored or are intentionally force-added.

该检查应在失败前读取 `.gitignore` 和已知忽略路径，避免重复 Git 已经处理的行为。它应重点关注未被忽略或被刻意强制加入的生成文件。

## `just check` 接入 / `just check` Integration

`just check` currently runs TypeScript lint and format through `lint fmt`. `QUI-69` should add a docs lane rather than hiding docs/process checks inside unrelated TypeScript commands.

`just check` 目前通过 `lint fmt` 运行 TypeScript lint 与 format。`QUI-69` 应增加独立 docs lane（文档检查通道），而不是把 docs/process 检查藏进无关的 TypeScript 命令里。

The proposed target shape is `check: lint fmt lint-docs-process`, with `lint-docs-process` running `python3 scripts/lint-glossary.py` and `python3 scripts/lint-docs-process.py`. If Python dependencies remain standard-library-only, this can run on fresh machines without extra setup.

建议目标形态是 `check: lint fmt lint-docs-process`，其中 `lint-docs-process` 运行 `python3 scripts/lint-glossary.py` 和 `python3 scripts/lint-docs-process.py`。如果 Python 依赖保持为 standard library（标准库）即可满足，该检查就能在新机器上无需额外安装直接运行。

The docs CI workflow should call the same `lint-docs-process` target or the same underlying scripts. This keeps local checks and CI checks aligned and prevents a contributor from passing locally but failing in CI for a different reason.

docs CI workflow（文档持续集成流程）应调用同一个 `lint-docs-process` target（任务目标）或同一批底层脚本。这样可以保持本地检查与 CI 检查一致，避免贡献者本地通过但 CI 因不同规则失败。

## 实现阶段 / Implementation Stages

Stage 1 for `QUI-69`: add `scripts/lint-docs-process.py` with path handling, ignore-zone parsing, bilingual paragraph checks, docs drift checks, generated artifact checks, and bilingual failure messages. Reuse `scripts/lint-glossary.py` rather than duplicating its rule set.

`QUI-69` 的阶段 1：新增 `scripts/lint-docs-process.py`，实现路径处理、忽略区域解析、中英段落检查、文档漂移检查、生成物检查和中英双语失败信息。复用 `scripts/lint-glossary.py`，不要复制它的规则集。

Stage 2 for `QUI-69`: add evidence claim checks and Linear/GitHub hygiene checks in warning mode first. Promote individual warnings to failures only after fixtures in `QUI-76` prove low false-positive risk.

`QUI-69` 的阶段 2：先以 warning 模式加入实证声明检查和 Linear/GitHub 卫生检查。只有当 `QUI-76` 的 fixture（测试样例）证明误报风险较低后，再把单项 warning 提升为失败。

Stage 3 for `QUI-69`: wire the new target into `just check` and `.github/workflows/docs.yml`. Remove the silent exclusion of `docs/*/evidence` from docs link checks once the drift check can report the clearer failure.

`QUI-69` 的阶段 3：把新 target 接入 `just check` 和 `.github/workflows/docs.yml`。当漂移检查能够给出更清晰失败信息后，从 docs 链接检查中移除对 `docs/*/evidence` 的静默排除。

Stage 4 for `QUI-76`: add negative fixtures for English-only docs, unpaired bilingual paragraphs, forbidden glossary terms, unsupported status claims, resurrected evidence directories, staged generated artifacts, and task-board leakage under `docs/`.

`QUI-76` 的阶段 4：增加负向 fixture，覆盖英文-only 文档、中英段落未配对、禁用术语、缺少证据的状态声明、重新出现的 evidence 目录、被暂存的生成物，以及 `docs/` 下任务看板泄漏。

## 失败级别 / Failure Levels

Use `error` when local evidence proves a hard rule violation: missing bilingual pair, forbidden glossary term, resurrected evidence directory, missing component `README.md`, generated output staged for commit, or docs acting as a task board.

当本地证据证明硬规则被违反时，使用 `error`（错误）：缺少中英配对、出现禁用术语、evidence 目录回归、组件缺少 `README.md`、生成输出被暂存提交，或 docs 充当任务看板。

Use `warning` when the rule needs judgment: a status statement may lack proof, a GitHub/Linear process paragraph may be ambiguous, or a generated-looking report may have been intentionally promoted but lacks a clear source command.

当规则需要判断时，使用 `warning`（警告）：状态声明可能缺少证据、GitHub/Linear 流程段落可能含糊，或某个看似生成的报告可能已被有意提升但缺少清晰来源命令。

Every warning should include a stable code such as `DPA-201` and a remediation step. Stable codes make it possible to document exceptions later without relying on fragile prose matching.

每条 warning 都应包含稳定编号，例如 `DPA-201`，并给出修复步骤。稳定编号可以让未来记录例外情况时不依赖脆弱的散文匹配。

## 例外与忽略 / Exceptions and Ignores

All ignores should be explicit and narrow. The script may ignore `upstreams/`, `node_modules/`, `.git/`, `dist/`, `target/`, `__pycache__/`, `.code-review-graph/`, and `docs/superpowers/` because these are external, generated, or upstream-style areas.

所有 ignore（忽略）都应明确且窄。脚本可以忽略 `upstreams/`、`node_modules/`、`.git/`、`dist/`、`target/`、`__pycache__/`、`.code-review-graph/` 和 `docs/superpowers/`，因为这些属于外部、生成或上游式区域。

A future inline ignore should require both a rule code and a reason, such as `docs-process-ignore DPA-101: quoted upstream title`. Bare ignore comments should fail because they hide process debt.

未来的行内忽略应同时要求规则编号和原因，例如 `docs-process-ignore DPA-101: quoted upstream title`。裸 ignore 注释应失败，因为它们会隐藏流程债务。

## Linear 映射 / Linear Mapping

`QUI-69` owns the implementation of local docs/process checks and `just check` integration. The implementation should not open more issues unless a separate blocker needs independent status, owner, and acceptance criteria.

`QUI-69` 负责实现本地 docs/process 检查与 `just check` 接入。除非出现需要独立状态、负责人和验收标准的单独 blocker（阻塞项），否则实现过程不应新建更多 issue。

`QUI-57` owns the process decision that this plan implements. Any future disagreement about whether Linear, docs, or `agent-bridge.md` owns a rule should be resolved against the `QUI-57` decision and the project rules in `quilin.md`.

`QUI-57` 负责本文所实现的流程决策。未来如果出现 Linear、docs 或 `agent-bridge.md` 谁拥有某条规则的争议，应以 `QUI-57` 的决策和 `quilin.md` 的项目规则为准。

`QUI-76` owns the verification baseline. It should prove that the gate catches real failures and that bilingual remediation text exists for every failure class.

`QUI-76` 负责验证基线。它应证明该门禁能抓住真实失败，并且每类失败都有中英双语修复提示。

`QUI-78` owns execution logging and issue-budget discipline. The docs/process check may require local issue identifiers in process docs, but it should not query Linear during local lint because that would make ordinary checks depend on network state.

`QUI-78` 负责执行记录和 issue 额度纪律。docs/process 检查可以要求流程文档中出现本地 issue 编号，但不应在本地 lint 期间查询 Linear，因为这会让普通检查依赖网络状态。

## 最小验收 / Minimal Acceptance

For this planning artifact, acceptance means the document exists at `docs/00-core-loop/docs-process-automation-plan.md`, follows bilingual paragraph pairing, defines all requested check categories, maps to existing Linear issues, avoids naked jargon on first use, and passes glossary plus whitespace checks.

对本文规划产物来说，验收意味着文档存在于 `docs/00-core-loop/docs-process-automation-plan.md`，遵守中英段落对照，定义所有用户要求的检查类别，映射到既有 Linear issue，首次出现术语不裸写，并通过术语与空白字符检查。

For the future `QUI-69` implementation, acceptance means `just check` can run the docs/process gate, the gate can fail on the `QUI-76` negative fixtures, and each failure explains the remediation in both English and Chinese.

对未来 `QUI-69` 实现来说，验收意味着 `just check` 能运行 docs/process 门禁，该门禁能在 `QUI-76` 负向 fixture 上失败，并且每条失败都用英文和中文解释修复方式。
