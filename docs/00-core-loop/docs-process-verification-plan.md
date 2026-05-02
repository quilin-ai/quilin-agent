# Docs/process 验证基线 / Docs/process Verification Baseline

Verification timestamp: 2026-05-02 Asia/Shanghai workspace time. Linear（internal issue tracker, used as Quilin's task and execution record source）record: `QUI-76`. This document creates no new Linear issue and maps follow-up ownership to existing `QUI-76`, `QUI-69`, `QUI-57`, and `QUI-78`.

验证时间：2026-05-02（工作区 Asia/Shanghai 时间）。Linear（内部 issue 追踪系统，用作 Quilin 的任务与执行记录源）记录：`QUI-76`。本文不创建新的 Linear issue，并把后续权属映射到既有 `QUI-76`、`QUI-69`、`QUI-57` 和 `QUI-78`。

## 目标 / Goal

The goal is to define a verification baseline for docs/process checks. A verification baseline means a repeatable set of fixture（test sample, used to prove that a check catches one failure mode）cases, expected pass/fail outcomes, bilingual failure messages, and manual-review boundaries.

目标是定义 docs/process 检查的验证基线。verification baseline（验证基线）指一组可重复的 fixture（测试样例，用来证明某个检查能抓住某类失败）、预期通过/失败结果、中英双语失败信息和人工 review 边界。

This baseline synthesizes `docs/00-core-loop/docs-process-frontier-assimilation.md` and `docs/00-core-loop/docs-process-automation-plan.md`. The first document sets the process decisions; the second document defines the future automation shape. This document verifies that the future automation actually catches the intended failures.

本基线综合 `docs/00-core-loop/docs-process-frontier-assimilation.md` 与 `docs/00-core-loop/docs-process-automation-plan.md`。前者确定流程决策，后者定义未来自动化形态；本文验证未来自动化确实能抓住预期失败。

The baseline intentionally stays local-first. Local-first means the check can run without network access and should not query Linear or GitHub（code hosting and public collaboration platform）during ordinary lint（static check, used to catch process errors before review）.

本基线刻意保持 local-first（本地优先）。本地优先指检查无需网络也能运行，并且普通 lint（静态检查，用来在 review 前捕获流程错误）期间不查询 Linear 或 GitHub（代码托管与公开协作平台）。

## 输入决策 / Input Decisions

`QUI-57` decided that Linear remains the internal task source, `docs/STATUS.md` remains the global state snapshot, component `README.md` files remain current architecture fact sources, and `agent-bridge.md` remains only the AgentBridge（Claude Code and Codex collaboration protocol）authority.

`QUI-57` 已决定：Linear 继续作为内部任务源，`docs/STATUS.md` 继续作为全局状态快照，组件 `README.md` 继续作为当前架构事实源，而 `agent-bridge.md` 只作为 AgentBridge（Claude Code 与 Codex 的协作协议）权威源。

`QUI-69` plans a conservative docs/process gate. The gate should cover bilingual documentation structure, glossary enforcement, evidence-claim proof, source-of-truth drift, generated artifact policy, and task-system hygiene.

`QUI-69` 规划了保守的 docs/process 门禁。该门禁应覆盖中英双语文档结构、术语强制、实证声明证据、事实源漂移、生成物策略和任务系统卫生。

`QUI-78` owns execution logging and issue-budget discipline. The verification baseline may require local Linear identifiers in process documents, but it must not turn docs back into task boards.

`QUI-78` 负责执行记录与 issue 额度纪律。验证基线可以要求流程文档中出现本地 Linear 编号，但不得把 docs 重新变成任务看板。

## 验证原则 / Verification Principles

Each automated check must have at least one negative fixture that fails for the intended reason and one positive fixture that demonstrates the same rule does not overreach. Negative fixture means a deliberately invalid sample; positive fixture means a deliberately valid sample.

每个自动化检查必须至少有一个负向 fixture 和一个正向 fixture：负向 fixture 会因为预期原因失败，正向 fixture 证明同一规则不会过度误伤。负向 fixture 指故意无效的样例；正向 fixture 指故意有效的样例。

Every failure message must be bilingual and actionable. Bilingual means an English explanation and a Chinese explanation. Actionable means the message names the violated rule, the file and line where feasible, and the exact remediation.

每条失败信息都必须中英双语且可执行。中英双语指同时有英文说明和中文说明；可执行指信息要说明违反的规则、可行时给出文件和行号，并给出明确修复方式。

Automation should only fail on locally provable hard-rule violations. Ambiguous quality judgments should remain warning-level signals or manual review items.

自动化只应对本地可证明的硬规则违规报错。含糊的质量判断应保持为 warning（警告）信号或人工 review 项。

## Fixture 一：中英双语文档 / Fixture 1: Bilingual Docs

The bilingual docs fixture verifies that newly added or rewritten project Markdown（plain-text documentation format）uses paired prose: one English paragraph followed by the corresponding Chinese paragraph. The check should ignore headings, code fences, tables, links, short metadata lines, and source-list bullets.

中英双语文档 fixture 验证新增或重写的项目 Markdown（纯文本格式文档）是否使用段落对照：一段英文后接对应中文段落。检查应忽略标题、代码块、表格、链接、短元数据行和来源列表项目符号。

The negative fixture should contain an English prose paragraph with no following Chinese paragraph before the next heading.

负向 fixture 应包含一段英文正文，并且在下一个标题前没有紧随的中文段落。

```markdown
## Example / Example

This paragraph describes a project rule but has no paired Chinese paragraph.

## Next / Next
```

The expected result is an error because the paragraph is English-like and unpaired. The remediation should tell the author to add the paired Chinese paragraph immediately after the English paragraph.

预期结果是 error（错误），因为该段落类似英文且未配对。修复方式应告诉作者在该英文段落后立即补充对应中文段落。

The positive fixture should contain the same English paragraph followed by a Chinese paragraph before the next heading.

正向 fixture 应包含同一英文段落，并且在下一个标题前紧跟中文段落。

```markdown
## Example / Example

This paragraph describes a project rule and is paired with Chinese.

这一段说明项目规则，并且与前一段英文配对。
```

## Fixture 二：术语违规 / Fixture 2: Glossary Violation

The glossary violation fixture verifies that forbidden or drifting project terms are caught by `scripts/lint-glossary.py`. Glossary means the canonical terminology source at `docs/00-core-loop/glossary.md`, used to keep project language consistent.

术语违规 fixture 验证 `scripts/lint-glossary.py` 能抓住禁用或漂移的项目术语。glossary（术语表）指 `docs/00-core-loop/glossary.md` 这个规范术语源，用于保持项目语言一致。

The negative fixture should include a known rejected term inside prose, not inside a code fence or inline code span. The actual test file should use a term selected from the current glossary lint rule set.

负向 fixture 应在散文正文里包含一个已知禁用术语，而不是放在代码块或行内代码里。真实测试文件应从当前术语检查规则集中选择一个术语。

```markdown
This prose line intentionally uses a rejected project-name spelling.
```

The expected result is an error from glossary lint. The remediation should name the canonical term and point to `docs/00-core-loop/glossary.md`.

预期结果是术语检查报 error。修复方式应说明规范术语，并指向 `docs/00-core-loop/glossary.md`。

The positive fixture should show that quoted examples, code fences, links, and explicit historical explanations do not fail. This keeps the check useful without punishing documentation that explains old mistakes.

正向 fixture 应证明引用示例、代码块、链接和明确历史解释不会失败。这样可以让检查保持有用，同时不惩罚解释旧错误的文档。

## Fixture 三：实证声明 / Fixture 3: Evidence Claim

The evidence claim fixture verifies that high-risk progress claims require nearby proof. Evidence claim means a statement such as "done", "implemented", "completed", "已实现", "完成", "通过", line count, coverage, or test success.

实证声明 fixture 验证高风险进度声明必须带有附近证据。evidence claim（实证声明）指类似 "done"、"implemented"、"completed"、"已实现"、"完成"、"通过"、行数、覆盖率或测试成功的声明。

The negative fixture should contain a completion claim without nearby proof in the same paragraph or the next two lines.

负向 fixture 应包含完成声明，但同一段落或后续两行内没有附近证据。

```markdown
The docs/process gate is complete.

文档流程门禁已经完成。
```

The expected result is at least a warning in the first implementation and may become an error after `QUI-76` proves low false-positive risk. The remediation should list acceptable proof forms: command result, commit hash, line count, test count, Linear link, pull request link, or concrete file path.

预期结果在第一版至少是 warning，并可在 `QUI-76` 证明低误报风险后提升为 error。修复方式应列出可接受证据形式：命令结果、commit hash（提交哈希）、行数、测试数量、Linear 链接、pull request（代码合并请求）链接或具体文件路径。

The positive fixture should include a completion claim with nearby proof.

正向 fixture 应包含完成声明，并在附近附上证据。

```markdown
The docs/process gate passed. Evidence: `python3 scripts/lint-glossary.py docs/example.md` returned `glossary lint: clean`.

文档流程门禁已通过。证据：`python3 scripts/lint-glossary.py docs/example.md` 返回 `glossary lint: clean`。
```

## Fixture 四：状态漂移 / Fixture 4: Status Drift

The status drift fixture verifies source-of-truth boundaries. Source-of-truth boundary means the rule that tasks live in Linear, current global status lives in `docs/STATUS.md`, component facts live in component `README.md` files, and old archive or evidence directories should not return.

状态漂移 fixture 验证事实源边界。source-of-truth boundary（事实源边界）指任务写在 Linear，当前全局状态写在 `docs/STATUS.md`，组件事实写在组件 `README.md`，旧档案目录或 evidence 目录不应回归。

The negative fixture should include a resurrected `docs/<component>/evidence` directory, a numbered component directory without `README.md`, or a component directory missing from `docs/README.md` navigation.

负向 fixture 应包含重新出现的 `docs/<component>/evidence` 目录、缺少 `README.md` 的编号组件目录，或未被 `docs/README.md` 导航列出的组件目录。

```text
docs/04-planning/evidence/source-note.md
docs/15-new-component/without-readme.md
```

The expected result is an error when local files prove structural drift. The remediation should name the stale boundary and tell the author to move task/history material to Linear or git history, or add the missing component `README.md` and navigation entry.

当本地文件能证明结构漂移时，预期结果是 error。修复方式应说明被破坏的边界，并要求作者把任务/历史材料移到 Linear 或 git history（提交历史），或补齐组件 `README.md` 与导航入口。

The positive fixture should include component docs that keep current architecture facts in a component `README.md` and link to Linear only as the task record.

正向 fixture 应包含组件文档：当前架构事实写在组件 `README.md`，并且只把 Linear 作为任务记录链接。

## Fixture 五：生成物 / Fixture 5: Generated Artifact

The generated artifact fixture verifies that disposable outputs do not enter source docs or commits without promotion evidence. Generated artifact means output from tools, tests, builds, benchmark（capability measurement suite, used later after component strengthening）, agents, or local graph databases.

生成物 fixture 验证可丢弃输出不会在缺少提升证据时进入源文档或提交。generated artifact（生成物）指工具、测试、构建、benchmark（能力测量套件，在组件强化后使用）、agent 或本地图数据库产生的输出。

The negative fixture should include staged or source-tree files under disposable paths such as `.logs/`, `.patches/`, `.benchmarks/`, `dist/`, `target/`, coverage files, or raw generated reports under `docs/` without a source command and review note.

负向 fixture 应包含被暂存或出现在源码树里的可丢弃路径文件，例如 `.logs/`、`.patches/`、`.benchmarks/`、`dist/`、`target/`、覆盖率文件，或没有来源命令与 review 说明的 `docs/` 原始生成报告。

```text
.logs/agent-run.json
.patches/scaffold-preview.patch
docs/00-core-loop/generated-summary.md
```

The expected result is an error for staged disposable artifacts and a warning for generated-looking docs that may have been intentionally promoted but lack clear evidence. The remediation should ask for removal, `.gitignore` coverage, or a bilingual rewrite with generator/source command and review evidence.

对被暂存的可丢弃生成物，预期结果是 error；对看似生成但可能已被有意提升的 docs，预期结果是 warning。修复方式应要求删除、补充 `.gitignore` 覆盖，或改写成中英双语文档并附生成器/来源命令与 review 证据。

The positive fixture should include a reviewed generated report that has been rewritten as bilingual prose, cites source commands, and passes glossary plus whitespace checks.

正向 fixture 应包含一个已审核的生成报告：它已改写成中英双语散文，引用来源命令，并通过术语检查和空白字符检查。

## Fixture 六：禁止 docs 任务看板 / Fixture 6: Forbidden Docs Task Board

The forbidden docs task-board fixture verifies that docs do not become the backlog. Task board means a file or section that tracks active ownership, status, due dates, sprint lanes, unchecked implementation tasks, or phase execution state instead of architecture facts.

禁止 docs 任务看板 fixture 验证 docs 不会变成 backlog（待办队列）。task board（任务看板）指追踪活跃负责人、状态、截止日期、sprint（短周期迭代）泳道、未完成实现任务或阶段执行状态的文件或章节，而不是记录架构事实。

The negative fixture should include headings and checklist fields that make the document act like an active task board.

负向 fixture 应包含让文档像活跃任务看板的标题和 checklist（检查清单）字段。

```markdown
## Sprint Backlog / Sprint Backlog

- [ ] Owner: agent-a; Due: tomorrow; Status: in progress; Task: implement runtime.
```

The expected result is an error when the file lives under `docs/` and lacks a clear architecture or verification purpose. The remediation should tell the author to move active work tracking to Linear and keep docs focused on current facts, decisions, and evidence-backed verification.

当该文件位于 `docs/` 且缺少明确架构或验证目的时，预期结果是 error。修复方式应告诉作者把活跃工作追踪移到 Linear，并让 docs 聚焦当前事实、决策和带证据的验证。

The positive fixture should allow architecture docs to mention future work when they map to Linear and describe constraints rather than acting as the execution state.

正向 fixture 应允许架构文档提到未来工作，前提是它们映射到 Linear 并描述约束，而不是充当执行状态。

## 自动化范围 / Automatable Scope

The following checks are automatable as errors in the first useful version: missing bilingual paragraph pair, current glossary violation, resurrected evidence directory, numbered component directory missing `README.md`, docs navigation missing a numbered component directory, staged disposable generated artifact, and obvious docs task-board leakage.

以下检查适合在第一版可用实现中作为 error 自动化：缺少中英段落配对、当前术语违规、evidence 目录回归、编号组件目录缺少 `README.md`、docs 导航漏掉编号组件目录、暂存的可丢弃生成物，以及明显的 docs 任务看板泄漏。

The following checks are automatable as warnings first: unsupported evidence claim, generated-looking report without promotion evidence, ambiguous GitHub/Linear process text, and status references that appear stale but cannot be proven structurally.

以下检查应先作为 warning 自动化：缺少证据的实证声明、看似生成但缺少提升证据的报告、含糊的 GitHub/Linear 流程文字，以及看起来过期但无法从结构上证明的状态引用。

The gate should produce stable rule codes. Stable rule codes make regression fixtures and future exceptions precise without matching long prose strings.

门禁应输出稳定规则编号。稳定规则编号能让回归 fixture 和未来例外记录更精确，而不用匹配长段散文。

## 人工 review 范围 / Manual Review Scope

Semantic translation quality remains manual review. The automation can check that English and Chinese paragraphs are paired, but it cannot prove that the Chinese faithfully translates the English.

语义翻译质量仍属于人工 review。自动化可以检查英文与中文段落是否配对，但无法证明中文是否忠实翻译英文。

Source credibility remains manual review. The automation can check that source links or file paths exist, but it cannot decide whether an external source is authoritative enough for an architectural decision.

来源可信度仍属于人工 review。自动化可以检查来源链接或文件路径是否存在，但无法判断外部来源是否足够权威，能否支撑架构决策。

Technical correctness remains manual review. A document can pass structure, terminology, and evidence checks while still making a weak technical recommendation.

技术正确性仍属于人工 review。某份文档可以通过结构、术语和证据检查，但技术建议仍可能薄弱。

Linear issue reuse decisions remain manual review. Automation can warn about task-board leakage or missing issue identifiers, but deciding whether work needs a new issue requires ownership, status, blocker, and acceptance-criteria judgment.

Linear issue 复用决策仍属于人工 review。自动化可以对任务看板泄漏或缺少 issue 编号发出 warning，但判断某项工作是否需要新 issue，需要结合负责人、状态、阻塞关系和验收标准。

## 失败信息模板 / Failure Message Templates

`DPA-101` should represent a bilingual paragraph pairing failure. DPA（Docs Process Automation, the planned docs/process check family）codes are stable identifiers for check outcomes.

`DPA-101` 应代表中英段落配对失败。DPA（Docs Process Automation，计划中的 docs/process 检查族）编号是检查结果的稳定标识。

```text
DPA-101 error: English prose paragraph is missing a paired Chinese paragraph at {path}:{line}. Add a Chinese paragraph immediately after this English paragraph.
DPA-101 错误：{path}:{line} 的英文正文段落缺少配对中文段落。请在该英文段落后立即补充对应中文段落。
```

`DPA-201` should represent an evidence claim without nearby proof.

`DPA-201` 应代表缺少附近证据的实证声明。

```text
DPA-201 warning: Progress claim at {path}:{line} lacks nearby proof. Add a command result, commit hash, line count, test count, Linear link, pull request link, or concrete file path.
DPA-201 警告：{path}:{line} 的进度声明缺少附近证据。请补充命令结果、提交哈希、行数、测试数量、Linear 链接、pull request 链接或具体文件路径。
```

`DPA-301` should represent status drift in docs structure.

`DPA-301` 应代表 docs 结构中的状态漂移。

```text
DPA-301 error: Source-of-truth drift detected at {path}:{line}. Move task/history material to Linear or git history, or repair the missing component README/navigation entry.
DPA-301 错误：{path}:{line} 检测到事实源漂移。请把任务/历史材料移到 Linear 或 git history，或修复缺失的组件 README/导航入口。
```

`DPA-401` should represent generated artifact policy failure.

`DPA-401` 应代表生成物策略失败。

```text
DPA-401 error: Disposable generated artifact is staged or stored as source at {path}:{line}. Remove it, add ignore coverage, or promote it through bilingual rewrite with source command and review evidence.
DPA-401 错误：{path}:{line} 的可丢弃生成物被暂存或作为源文件保存。请删除、补充忽略规则，或通过中英双语改写、来源命令和 review 证据正式提升。
```

`DPA-501` should represent forbidden docs task-board leakage.

`DPA-501` 应代表禁止的 docs 任务看板泄漏。

```text
DPA-501 error: Docs file appears to track active tasks at {path}:{line}. Move active ownership, status, due dates, and backlog tracking to Linear.
DPA-501 错误：{path}:{line} 的 docs 文件看起来在追踪活跃任务。请把负责人、状态、截止日期和 backlog 追踪移到 Linear。
```

`DPA-601` should represent glossary enforcement failure when wrapped by the future orchestration script.

`DPA-601` 应代表未来编排脚本包装术语检查时的术语强制失败。

```text
DPA-601 error: Glossary violation at {path}:{line}. Use the canonical term from docs/00-core-loop/glossary.md.
DPA-601 错误：{path}:{line} 存在术语违规。请使用 docs/00-core-loop/glossary.md 中的规范术语。
```

## 验收矩阵 / Acceptance Matrix

The verification baseline passes when fixture execution proves three things: each negative fixture fails for its intended rule code, each positive fixture passes or warns only for documented reasons, and every emitted failure includes English and Chinese remediation text.

当 fixture 执行证明三件事时，验证基线才算通过：每个负向 fixture 都因预期规则编号失败；每个正向 fixture 都通过，或只因已记录原因发出 warning；每条失败信息都包含英文和中文修复提示。

The baseline should be checked with the smallest reliable command set first: `python3 scripts/lint-glossary.py docs/00-core-loop/docs-process-verification-plan.md` for current terminology rules and `git diff --check -- docs/00-core-loop/docs-process-verification-plan.md` for whitespace issues.

基线应先用最小可靠命令集检查：用 `python3 scripts/lint-glossary.py docs/00-core-loop/docs-process-verification-plan.md` 检查当前术语规则，用 `git diff --check -- docs/00-core-loop/docs-process-verification-plan.md` 检查空白字符问题。

Future `QUI-69` implementation should add a dedicated fixture runner. Until that runner exists, `QUI-76` defines the expected fixture catalog and failure text that implementation must satisfy.

未来 `QUI-69` 实现应新增专用 fixture runner（测试样例运行器）。在该 runner 存在前，`QUI-76` 定义实现必须满足的 fixture 目录和失败信息文本。

## Linear 映射 / Linear Mapping

`QUI-76` owns this verification baseline. It should remain the source for fixture categories, expected outcomes, and bilingual failure-message templates.

`QUI-76` 负责本文验证基线。它应继续作为 fixture 类别、预期结果和中英双语失败信息模板的来源。

`QUI-69` owns the future implementation of the docs/process gate and fixture runner. It should not create additional issues unless a blocker needs independent ownership, status, or acceptance criteria.

`QUI-69` 负责未来实现 docs/process 门禁与 fixture runner。除非某个 blocker（阻塞项）需要独立负责人、状态或验收标准，否则不应创建额外 issue。

`QUI-57` owns the process decision that docs should remain architecture and state snapshots while Linear remains task management.

`QUI-57` 负责流程决策：docs 应保持为架构与状态快照，Linear 继续作为任务管理源。

`QUI-78` owns execution logging and Linear free-plan discipline. This baseline reinforces the rule by forbidding docs task boards and preferring Linear comments for subagent logs and probes.

`QUI-78` 负责执行记录与 Linear 免费版额度纪律。本文通过禁止 docs 任务看板，并优先使用 Linear comment 记录 subagent 日志和 probe（调研记录），强化该规则。

## 非目标 / Non-goals

This document does not implement `scripts/lint-docs-process.py`. It defines the verification baseline that the future implementation must satisfy.

本文不实现 `scripts/lint-docs-process.py`。它定义未来实现必须满足的验证基线。

This document does not change `agent-bridge.md`. Project execution rules belong in `quilin.md` / `AGENTS.md`, while `agent-bridge.md` remains the AgentBridge collaboration protocol authority.

本文不修改 `agent-bridge.md`。项目执行规则属于 `quilin.md` / `AGENTS.md`，而 `agent-bridge.md` 继续作为 AgentBridge 协作协议权威源。

This document does not move task management into docs. It defines checks that prevent task management from leaking back into docs.

本文不把任务管理移入 docs。它定义的检查正是为了防止任务管理重新泄漏回 docs。
