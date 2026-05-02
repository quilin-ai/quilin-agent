# Docs/process 前沿吸收决策 / Docs/process Frontier Assimilation

Research timestamp: 2026-05-02 Asia/Shanghai workspace time. Linear record: [QUI-57](https://linear.app/quilin-agent/issue/QUI-57/f0docsprocess-自动化与中英双语规则决策-decide-docsprocess-automation-and-bilingual), a Linear issue for docs/process automation decisions. This document creates no new Linear issue and only maps follow-up work to existing `QUI-57`, `QUI-69`, `QUI-76`, and `QUI-78`.

调研时间：2026-05-02（工作区 Asia/Shanghai 时间）。Linear 记录：[QUI-57](https://linear.app/quilin-agent/issue/QUI-57/f0docsprocess-自动化与中英双语规则决策-decide-docsprocess-automation-and-bilingual)，这是用于 docs/process 自动化决策的 Linear issue。本文不创建新的 Linear issue，只把后续工作映射到既有 `QUI-57`、`QUI-69`、`QUI-76` 和 `QUI-78`。

## 结论 / Verdict

Quilin's current docs/process direction is correct: Linear is the task source, `docs/STATUS.md` is the global state snapshot, component `README.md` files are current architecture facts, `docs/00-core-loop/glossary.md` is the terminology source, and `agent-bridge.md` remains only the AgentBridge collaboration protocol source. The gap is not policy clarity anymore; the gap is that several rules still depend on agent memory instead of repeatable checks.

Quilin 当前 docs/process 方向是正确的：Linear 是任务源，`docs/STATUS.md` 是全局状态快照，组件 `README.md` 是当前架构事实，`docs/00-core-loop/glossary.md` 是术语源，而 `agent-bridge.md` 只保留 AgentBridge 协作协议。现在缺口不再是规则不清，而是若干规则仍依赖 agent 记忆，没有变成可重复检查。

The strongest near-term shape is a small "docs contract gate": one command that runs glossary lint, bilingual paragraph checks, evidence-claim checks, docs drift checks, generated-artifact checks, and Linear/GitHub hygiene checks where local evidence is available. The first implementation should be conservative and explain failures in both English and Chinese.

近期最强形态是一个小型“文档契约门”：用一个命令串起术语检查、中英段落对照检查、实证声明检查、文档漂移检查、生成物检查，以及本地可判断的 Linear/GitHub 任务系统卫生检查。第一版实现应保守，并用英文和中文同时解释失败原因。

Benchmark work is frozen unless the user explicitly asks for it. Docs/process automation should make component decisions auditable, bilingual, and hard to drift; it must not become another benchmark surface.

除非用户明确要求，benchmark（基准测试，用来衡量完整 Agent 能力）工作保持冻结。docs/process 自动化应让组件决策可审计、中英双语且不易漂移；它不得变成新的 benchmark 工作面。

## 术语 / Terms

Bilingual docs check means a deterministic Markdown check that verifies newly added or rewritten project documentation uses paragraph-paired English and Chinese prose. It should ignore code blocks, tables, web links, and short metadata lines.

bilingual docs check（中英双语文档检查）指一个确定性的 Markdown 检查，用来验证新增或重写的项目文档是否采用英文段落后接中文段落的对照写法。它应忽略代码块、表格、web links（网页链接）和短元数据行。

Terminology lint means a prose linter that catches forbidden or drifting project terms and points authors back to `docs/00-core-loop/glossary.md`.

terminology lint（术语检查）指一个文档散文检查器，用来捕获禁用或漂移的项目术语，并把作者指回 `docs/00-core-loop/glossary.md`。

Evidence discipline means that status claims, implementation claims, line-count claims, coverage claims, and "done" claims must carry direct proof such as commit hashes, command results, line counts, Linear links, or file paths.

evidence discipline（实证纪律）指状态声明、实现声明、行数声明、覆盖率声明和“完成”声明必须带直接证据，例如 commit hash（提交哈希）、命令结果、行数、Linear 链接或文件路径。

Docs drift check means a local check that detects when navigation, component directories, status tables, or authoritative-source rules diverge from each other.

docs drift check（文档漂移检查）指本地检查，用来发现导航、组件目录、状态表或权威源规则之间是否互相不一致。

Issue hygiene means keeping Linear and GitHub work tracking useful by avoiding duplicate issues, stale statuses, unlabeled public reports, and noisy generated tasks. For Quilin, Linear is the internal source; GitHub issues should be reserved for public user reports after the project opens.

issue hygiene（任务系统卫生）指避免重复 issue、过期状态、未分类公开报告和噪声自动任务，让 Linear 与 GitHub 的工作追踪保持可用。对 Quilin 来说，Linear 是内部任务源；GitHub issue 应在项目开放后主要承接公开用户报告。

Agent instruction scope means deciding which instruction file owns which rule. `quilin.md` / `AGENTS.md` owns project-wide rules, nested `AGENTS.md` files may own path-specific rules later, and `agent-bridge.md` owns only the Claude-Code-to-Codex collaboration protocol.

agent instruction scope（Agent 指令作用域）指决定哪类指令文件负责哪类规则。`quilin.md` / `AGENTS.md` 负责项目级规则，未来可用嵌套 `AGENTS.md` 承载路径级规则，而 `agent-bridge.md` 只负责 Claude Code 与 Codex 的协作协议。

Generated artifact policy means deciding which files are source facts and which files are disposable outputs from tools, tests, builds, benchmarks, or agents.

generated artifact policy（生成物策略）指区分哪些文件是源事实，哪些文件只是工具、测试、构建、benchmark 或 agent 运行产生的可丢弃输出。

## 本仓库事实 / Local Repository Facts

`scripts/lint-glossary.py` already enforces narrow terminology drift checks against Markdown files and ignores code blocks, inline code, web links, paths, upstreams, and known non-project areas. This is the right foundation for terminology lint, but it currently hard-codes a small rule set instead of reading structured glossary metadata.

`scripts/lint-glossary.py` 已经对 Markdown 文件执行窄范围术语漂移检查，并忽略代码块、行内代码、web links（网页链接）、路径、upstreams 和已知非项目区域。这是 terminology lint 的正确地基，但它目前把少量规则硬编码在脚本里，而不是读取结构化术语元数据。

`.github/workflows/docs.yml` already runs glossary lint and `markdown-link-check` in CI（Continuous Integration，持续集成，用来在提交或 pull request 中自动执行检查）for Markdown changes. It still excludes `docs/*/evidence`, even though `docs/README.md` now says evidence directories should not exist.

`.github/workflows/docs.yml` 已经在 CI（Continuous Integration，持续集成，用来在提交或 pull request（代码合并请求）中自动执行检查）里对 Markdown 变更运行术语检查和 `markdown-link-check`。但它仍排除了 `docs/*/evidence`，而 `docs/README.md` 现在已经声明不再保留 evidence 目录。

`docs/README.md` states that tasks live in Linear, global status lives in `docs/STATUS.md`, current component facts live in component `README.md` files, old archive directories must not return, and new or rewritten project docs must be bilingual by paragraph.

`docs/README.md` 声明任务写在 Linear，全局状态写在 `docs/STATUS.md`，组件当前事实写在组件 `README.md`，旧档案目录不再恢复，新增或重写项目文档必须按段落中英双语。

`quilin.md` records project-wide execution logging, Linear free-plan limits, bilingual documentation, terminology readability, evidence discipline, generated artifact policy, and the rule that `agent-bridge.md` remains the collaboration protocol authority. This is the right file for project execution rules because it is loaded as `AGENTS.md` / `CLAUDE.md`.

`quilin.md` 记录了项目级执行记录、Linear 免费版额度、中英双语文档、术语可读性、实证纪律、生成物策略，以及 `agent-bridge.md` 只作为协作协议权威源的规则。这是项目执行规则的正确位置，因为它会作为 `AGENTS.md` / `CLAUDE.md` 被加载。

`.gitignore` already excludes common generated outputs: `.logs/`, `.patches/`, `dist/`, `target/`, `__pycache__/`, `.benchmarks/`, `.code-review-graph/`, local identity files, and local scratch folders. The missing process rule is how to handle generated docs-like files before they become source facts.

`.gitignore` 已经排除常见生成物：`.logs/`、`.patches/`、`dist/`、`target/`、`__pycache__/`、`.benchmarks/`、`.code-review-graph/`、本地身份文件和本地草稿目录。缺失的流程规则是：当生成物看起来像文档时，如何判断它是否能成为源事实。

## 外部来源 / External Sources

GitHub issue forms support structured fields defined in YAML（YAML Ain't Markup Language, a structured configuration format）, required validations, default labels, projects, assignees, and a template chooser that can disable blank issues for ordinary contributors. Source: [GitHub issue template configuration](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository).

GitHub issue forms（GitHub 结构化 issue 表单）支持用 YAML（YAML Ain't Markup Language，一种结构化配置格式）定义结构化字段、必填校验、默认 label（标签）、project（项目）、assignee（负责人），并可通过 template chooser（模板选择器）对普通贡献者关闭空白 issue。来源：[GitHub issue template configuration](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。

Linear's GitHub integration supports pull request linking, commit linking, magic words, issue status automation, branch-specific rules, review integration, and GitHub issue sync. Source: [Linear GitHub integration](https://linear.app/docs/github-integration).

Linear 的 GitHub 集成支持 PR（Pull Request，代码合并请求）链接、commit（提交）链接、magic words（用于自动关联或关闭任务的关键词）、issue 状态自动化、分支规则、review（审核）集成和 GitHub issue 同步。来源：[Linear GitHub integration](https://linear.app/docs/github-integration)。

Docusaurus treats broken links as a build-time contract: `onBrokenLinks` can throw by default, and broken Markdown links can be configured through Markdown hooks. Source: [Docusaurus configuration](https://www.docusaurus.io/docs/api/docusaurus-config).

Docusaurus（常见开源文档站生成器）把坏链接视为构建期契约：`onBrokenLinks` 默认可让构建失败，Markdown 坏链接也可通过 Markdown hooks（Markdown 钩子）配置。来源：[Docusaurus configuration](https://www.docusaurus.io/docs/api/docusaurus-config)。

Vale is an open-source prose linter focused on consistent writing style rather than general grammar. Its vocabulary system uses accepted and rejected term lists, and its rules can enforce exact terminology and casing. Sources: [Vale introduction](https://vale.sh/docs/) and [Vale vocabularies](https://vale.sh/docs/keys/vocab).

Vale（开源散文 lint 工具）专注一致写作风格，而不是通用语法纠错。它的 vocabulary（词表）系统使用 accepted terms（接受术语）和 rejected terms（禁用术语）列表，并可通过规则强制术语与大小写。来源：[Vale introduction](https://vale.sh/docs/) 和 [Vale vocabularies](https://vale.sh/docs/keys/vocab)。

Kubernetes documentation localization uses language-specific directories, GitHub teams, labels, OWNERS files, localized README files, branch strategy, upstream-change scripts, and language-specific glossary guidance. Source: [Kubernetes localization guide](https://kubernetes.io/docs/contribute/localization/).

Kubernetes 文档本地化使用按语言划分的目录、GitHub team（团队）、label（标签）、OWNERS（代码/文档审核责任文件）、本地化 README、分支策略、上游变更脚本和语言级 glossary（术语表）指南。来源：[Kubernetes localization guide](https://kubernetes.io/docs/contribute/localization/)。

OpenAI Codex documents that `AGENTS.md` guidance is layered by scope: global guidance, project guidance from repository root to current directory, and closer files overriding earlier ones. It also documents a default combined-size limit and verification commands for instruction loading. Source: [OpenAI Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md).

OpenAI Codex 文档说明 `AGENTS.md` 指令按作用域分层加载：全局指令、从仓库根到当前目录的项目指令，且更靠近当前目录的文件覆盖更早指令。它也说明了默认合并大小限制和验证指令加载的命令。来源：[OpenAI Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)。

GitHub documents `.gitignore` as the repository-level way to share ignored-file rules, and distinguishes repository-shared ignore rules from local-only excludes. GitHub Actions artifacts are files produced during workflow runs and are suitable for logs, test results, screenshots, binaries, and coverage output. Sources: [GitHub ignoring files](https://docs.github.com/en/get-started/git-basics/ignoring-files) and [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts).

GitHub 文档把 `.gitignore` 定义为仓库级共享忽略规则，并区分仓库共享规则与本地私有 exclude（排除）规则。GitHub Actions artifacts（工作流产物）是 workflow（自动化流程）运行中生成的文件，适合保存日志、测试结果、截图、二进制文件和覆盖率输出。来源：[GitHub ignoring files](https://docs.github.com/en/get-started/git-basics/ignoring-files) 和 [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)。

GitHub permanent file links solve evidence decay by replacing branch names with commit identifiers, so readers see the exact file version that was cited. Source: [GitHub permanent links](https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files).

GitHub permanent file links（永久文件链接）通过用 commit identifier（提交标识）替代分支名，避免证据随分支移动而漂移，让读者看到被引用时的精确文件版本。来源：[GitHub permanent links](https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files)。

## 吸收决策 / Assimilation Decisions

Decision 1: implement bilingual checks as a changed-file gate first. The check should scan Markdown files changed under `docs/` and root project docs, ignore code fences, tables, blockquotes, links, and short metadata, then fail when a new prose block is English-only without a paired Chinese paragraph. It should warn, not fail, on pre-existing legacy files until the file is rewritten.

决策 1：先把中英双语检查做成 changed-file gate（变更文件门禁）。检查应扫描 `docs/` 下和根目录项目文档中发生变更的 Markdown，忽略代码块、表格、引用块、链接和短元数据；如果新增散文块只有英文、没有配套中文段落，则失败。对尚未重写的历史文件先 warning（警告）而不是 fail（失败）。

Decision 2: keep `scripts/lint-glossary.py` as the immediate terminology gate, then move rule definitions into structured data when `QUI-69` implements the next version. Vale is useful later if Quilin needs broader style-guide enforcement, but the first milestone should avoid adding a heavy prose-lint dependency before the project glossary stabilizes.

决策 2：短期继续用 `scripts/lint-glossary.py` 作为术语门禁，等 `QUI-69` 实现下一版时再把规则定义迁移到结构化数据。Vale 适合后续做更宽的 style-guide（写作风格指南）检查，但第一阶段不应在项目术语表稳定前引入过重的散文 lint 依赖。

Decision 3: encode evidence discipline as claim-pattern checks, not natural-language understanding. The script should look for high-risk claim tokens such as `✅`, `closed`, `landed`, `implemented`, `已实现`, `完成`, `LOC`, `coverage`, and `通过`, then require nearby proof tokens such as a commit hash, command result, line count, Linear link, test count, or file path.

决策 3：把实证纪律编码成 claim-pattern checks（声明模式检查），不要依赖自然语言理解。脚本应查找高风险声明词，例如 `✅`、`closed`、`landed`、`implemented`、`已实现`、`完成`、`LOC`、`coverage` 和 `通过`，并要求附近存在证据词，例如 commit hash、命令结果、行数、Linear 链接、测试数量或文件路径。

Decision 4: implement docs drift checks around source-of-truth boundaries. The first drift checks should fail when `docs/*/evidence` directories exist, old top-level archive directories return, `docs/README.md` component navigation misses a numbered component directory, or `docs/STATUS.md` references a component that lacks a component `README.md`.

决策 4：围绕 truth source（事实源）边界实现文档漂移检查。第一版漂移检查应在以下情况失败：存在 `docs/*/evidence` 目录、旧顶层档案目录回归、`docs/README.md` 组件导航漏掉编号组件目录，或 `docs/STATUS.md` 引用了没有组件 `README.md` 的组件。

Decision 5: keep `agent-bridge.md` out of project execution rules. `agent-bridge.md` should only contain cross-agent collaboration protocol. Project execution rules, Linear discipline, bilingual docs, generated artifacts, and evidence discipline belong in `quilin.md` / `AGENTS.md`; future path-specific additions should use nested `AGENTS.md` files only when a directory has genuinely different rules.

决策 5：不要把项目执行规则写进 `agent-bridge.md`。`agent-bridge.md` 只应包含跨 agent 协作协议。项目执行规则、Linear 纪律、中英双语文档、生成物策略和实证纪律属于 `quilin.md` / `AGENTS.md`；未来只有当某个目录确实需要不同规则时，才用嵌套 `AGENTS.md` 增加路径级指令。

Decision 6: treat generated artifacts as disposable unless promoted by review. Tool logs, patch previews, benchmark scratch, build outputs, graph databases, coverage files, and local identity files stay ignored or attached as workflow artifacts. If a generated report becomes source documentation, it must be rewritten into bilingual prose, cite its generator or source commands, and pass docs checks.

决策 6：除非经过 review（审核）提升，否则生成物都视为可丢弃。工具日志、patch 预览、benchmark 草稿、构建输出、图数据库、覆盖率文件和本地身份文件应保持 ignored（被忽略）或作为 workflow artifact 保存。如果生成报告要成为源文档，必须改写成中英双语散文，引用生成器或来源命令，并通过文档检查。

Decision 7: keep Linear as the internal planning source and use GitHub issues only for public inbound reports later. Internal subagent logs, research probes, reviews, and follow-up notes should reuse existing Linear issue comments because the workspace has a 250 issue free-plan cap. GitHub issue forms can later enforce public bug/feature report structure, but they should not duplicate the Linear backlog.

决策 7：保持 Linear 作为内部规划源，GitHub issue 以后只承接公开外部报告。内部 subagent 日志、调研 probe（调研记录）、review 和后续备注应优先复用既有 Linear issue comment，因为当前 workspace 有 250 issue 的免费版上限。GitHub issue forms 之后可以约束公开 bug/feature report（缺陷/功能报告）结构，但不应复制 Linear backlog。

## QUI-69 实现基线 / QUI-69 Implementation Baseline

`QUI-69` should add a documented script, for example `scripts/lint-docs-process.py`, and wire it into `just check` or the docs workflow. The script should accept explicit file paths and default to changed Markdown files when possible.

`QUI-69` 应新增一个有文档说明的脚本，例如 `scripts/lint-docs-process.py`，并把它接入 `just check` 或 docs workflow（文档自动化流程）。脚本应支持显式传入文件路径，并在可行时默认检查发生变更的 Markdown 文件。

The first gate should run six checks: glossary lint, bilingual paragraph pairing, evidence claim proof, docs drift, generated artifact policy, and task-system hygiene. The failure messages should always include an English sentence and a Chinese sentence, plus the exact file and line where possible.

第一版门禁应运行六类检查：术语检查、中英段落配对、实证声明证据、文档漂移、生成物策略和任务系统卫生。失败信息必须同时包含英文句子和中文句子，并在可行时给出精确文件和行号。

The script should have explicit ignore zones: code fences, inline code, Markdown tables, web links, frontmatter-like metadata, source tables, and quoted external titles. These exemptions prevent bilingual and terminology checks from punishing code examples, links, or source citations.

脚本应有明确 ignore zones（忽略区域）：代码块、行内代码、Markdown 表格、web links（网页链接）、类似 frontmatter（文件头元数据）的元信息、来源表格和引用的外部标题。这些豁免能避免中英双语与术语检查误伤代码示例、链接或来源引用。

The docs workflow should stop excluding `docs/*/evidence` silently. After the evidence directory deletion policy, any new evidence directory should be a drift failure unless a future issue explicitly reopens the archive model.

docs workflow 不应继续静默排除 `docs/*/evidence`。在 evidence 目录删除政策之后，任何新的 evidence 目录都应触发漂移失败，除非未来 issue 明确重新打开档案目录模型。

## QUI-76 验证基线 / QUI-76 Verification Baseline

`QUI-76` should verify that the checks catch the actual failure modes, not only that scripts exit successfully. The fixture set should include an English-only rewritten doc, a bilingual doc with an unpaired paragraph, a forbidden term from the glossary, a status claim without proof, a resurrected `docs/04-*/evidence` directory, a generated `.logs` or `.patches` file staged for commit, and a docs task board accidentally added under `docs/`.

`QUI-76` 应验证这些检查能抓住真实失败模式，而不只是脚本退出成功。fixture set（测试样例集合）应包含：英文-only 重写文档、中英段落未配对文档、术语表禁用词、缺少证据的状态声明、重新出现的 `docs/04-*/evidence` 目录、被 staged（暂存）提交的 `.logs` 或 `.patches` 文件，以及误加到 `docs/` 下的任务看板。

The baseline should also define manual-review-only areas. Source credibility ranking, whether a research conclusion is technically correct, whether a generated report deserves promotion into docs, and whether a Linear issue truly needs independent ownership cannot be fully automated in the first version.

验证基线也应定义只能人工 review 的区域。来源可信度排序、调研结论是否技术正确、生成报告是否值得提升为 docs，以及某个 Linear issue 是否真的需要独立权属，第一版无法完全自动化。

`QUI-76` should require each failure message to include remediation. For example, bilingual failures should say "add the paired Chinese paragraph after this English paragraph" and "在该英文段落后补充对应中文段落"; evidence failures should name acceptable proof forms.

`QUI-76` 应要求每条失败信息都包含修复方式。例如，中英双语失败应说明 “add the paired Chinese paragraph after this English paragraph” 和 “在该英文段落后补充对应中文段落”；实证失败应列出可接受的证据形式。

## QUI-78 流程纪律 / QUI-78 Process Discipline

`QUI-78` should remain the record for execution logging. The automation can assist by checking that new frontier-assimilation docs include a Linear record line near the top, but it should not attempt to query Linear during ordinary local lint because that would make docs checks depend on network state.

`QUI-78` 应继续作为执行记录纪律的承载 issue。自动化可以辅助检查新增 frontier-assimilation docs（前沿吸收文档）顶部是否包含 Linear 记录行，但普通本地 lint 不应尝试查询 Linear，因为这会让文档检查依赖网络状态。

Subagent and main-agent work logs should prefer existing Linear comments. New issues are appropriate only when the work needs independent status, ownership, blockers, or acceptance criteria. This keeps the free-plan issue cap usable and prevents Linear from becoming another noisy artifact directory.

Subagent 和 main-agent 工作日志应优先复用既有 Linear comment。只有当工作需要独立状态、负责人、阻塞关系或验收标准时，才新建 issue。这样能保护免费版 issue 额度，并避免 Linear 变成另一个噪声档案目录。

## 不做事项 / Non-goals

Do not add project execution or Linear rules to `agent-bridge.md`. That file is the AgentBridge protocol authority, not the general project-process guide.

不要把项目执行或 Linear 规则加进 `agent-bridge.md`。该文件是 AgentBridge 协议权威源，不是通用项目流程指南。

Do not make bilingual checks depend on machine translation quality in the first version. The first gate only verifies structure and obvious language presence; semantic equivalence remains a human review responsibility.

第一版不要让中英双语检查依赖机器翻译质量。第一版门禁只验证结构和明显语言存在；语义等价仍由人工 review 负责。

Do not move task management back into docs. Docs can link to Linear and record architecture facts, but backlog, phase tracking, and active execution state remain in Linear.

不要把任务管理搬回 docs。docs 可以链接 Linear 并记录架构事实，但 backlog（待办队列）、phase tracking（阶段追踪）和活跃执行状态仍留在 Linear。

Do not treat generated reports as source truth just because an agent wrote them. Generated content becomes source truth only after review, bilingual rewrite, source citation, and docs checks.

不要因为某个 generated report 是 agent 写的，就把它当成事实源。生成内容只有经过 review、中英双语改写、来源引用和 docs 检查后，才能成为源事实。

## Linear 映射 / Linear Mapping

| Work / Work item | Existing Linear issue | Decision / Next action |
|---|---|---|
| Frontier-assimilation policy decision and this evidence artifact | `QUI-57` | This document is the decision artifact; no new issue. |
| Implement local docs/process checks | `QUI-69` | Add the conservative script and wire it into `just check` or docs CI. |
| Verification fixtures and pass/fail baseline | `QUI-76` | Define fixture failures, manual-review-only areas, and bilingual failure messages. |
| Execution logging and issue-budget discipline | `QUI-78` | Keep work records in Linear comments first; do not query Linear in local lint. |

| 工作项 | 既有 Linear issue | 决策 / 下一步 |
|---|---|---|
| 前沿吸收政策决策与本文证据产物 | `QUI-57` | 本文是决策产物；不新建 issue。 |
| 实现本地 docs/process 检查 | `QUI-69` | 新增保守脚本，并接入 `just check` 或 docs CI。 |
| 验证 fixture 与通过/失败基线 | `QUI-76` | 定义失败样例、只能人工 review 的区域和中英双语失败信息。 |
| 执行记录与 issue 额度纪律 | `QUI-78` | 优先用 Linear comment 记录工作；本地 lint 不查询 Linear。 |

## 最小验收 / Minimal Acceptance

For `QUI-57`, this document is sufficient when it exists in the core-loop docs directory, follows bilingual paragraph pairing, cites local and external sources, maps all follow-up work to existing Linear issues, avoids naked jargon on first use, and passes the glossary and whitespace checks.

对 `QUI-57` 来说，只要本文位于 core-loop docs 目录、遵守中英段落对照、引用本仓库与外部来源、把后续工作映射到既有 Linear issue、首次出现术语不裸写，并通过术语与空白字符检查，就满足最小验收。

For `QUI-69`, the implementation is sufficient only when a future automated check can fail on the fixture set described above and can tell an author how to fix the problem in both English and Chinese.

对 `QUI-69` 来说，未来实现只有在自动化检查能对上述 fixture set 失败，并能用英文和中文告诉作者如何修复时，才算满足最小验收。
