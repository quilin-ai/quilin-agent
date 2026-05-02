# 前沿吸收交叉复核 / Frontier Assimilation Cross-Review

Review timestamp: 2026-05-02 Asia/Shanghai workspace time. Linear record: `QUI-78`（the Linear issue that records execution logging, idle exploration, and cross-review discipline）. This review creates no new Linear issue and does not modify `agent-bridge.md`（the Claude Code and Codex collaboration protocol file）.

复核时间：2026-05-02（工作区 Asia/Shanghai 时间）。Linear 记录：`QUI-78`（用于记录执行日志、空闲探索和交叉复核纪律的 Linear issue）。本复核不创建新的 Linear issue，也不修改 `agent-bridge.md`（Claude Code 与 Codex 的协作协议文件）。

## 复核范围 / Review Scope

The review sampled 33 recent frontier assimilation, implementation plan, verification, and evidence documents across LLM Integration（large language model integration, the provider and routing layer）, Context（the runtime layer that selects, compresses, caches, and traces context）, Memory, Planning, Tools, Multi-Agent, Safety, Observability, Deployment, Self-Evolution, Agent Mesh, Skills, Docs/process, and benchmark evidence.

本次复核抽样检查了 33 份近期新增的前沿吸收、实现规划、验证和证据文档，覆盖 LLM Integration（大语言模型接入层，负责供应商与路由）、Context（上下文运行层，负责选择、压缩、缓存和追踪上下文）、Memory、Planning、Tools、Multi-Agent、Safety、Observability、Deployment、Self-Evolution、Agent Mesh、Skills、Docs/process 和 benchmark 证据。

The checked document set has 8,938 total lines by `wc -l`. The largest reviewed files were `self-evolution-runtime-implementation-plan.md` at 494 lines, `skills-runtime-implementation-plan.md` at 437 lines, and `durable-subagent-runtime-plan.md` at 418 lines.

经 `wc -l` 检查，被复核文档合计 8,938 行。最大的几份被复核文件是 494 行的 `self-evolution-runtime-implementation-plan.md`、437 行的 `skills-runtime-implementation-plan.md` 和 418 行的 `durable-subagent-runtime-plan.md`。

## 总体结论 / Overall Verdict

No independent blocker was found. The documents are broadly aligned on the main architecture direction: component strength first, benchmark（standardized evaluation used to measure system capability）execution later, Linear as the task record, docs as architecture and evidence records, and `agent-bridge.md` kept out of project execution rules.

没有发现需要独立新建 issue 的 blocker（阻塞项）。这些文档整体对齐主架构方向：先强化组件，再执行 benchmark（用于衡量系统能力的标准化评测）；Linear 作为任务记录源；docs 作为架构与证据记录；`agent-bridge.md` 不承载项目执行规则。

The strongest cross-document pattern is correct ownership separation: Safety owns `WriteAuthority`（the central write-permission gate for agent-initiated writes）and action policy records; Deployment owns `SandboxRouter`（the runtime interface that selects and manages sandbox providers）; Tools owns tool-facing result contracts and browser routing; Observability owns `LoopStepEvent` and `LoopStopState`（typed loop event and stop-state contracts）; Agent Mesh owns local peer-agent interoperability; Skills owns manifest, provenance, and eval runner behavior.

最强的跨文档模式是正确的权属拆分：Safety 负责 `WriteAuthority`（Agent 发起写入的中央写权限门）和动作策略记录；Deployment 负责 `SandboxRouter`（选择和管理沙箱提供方的运行时接口）；Tools 负责面向工具的结果契约与浏览器路由；Observability 负责 `LoopStepEvent` 与 `LoopStopState`（类型化循环事件和停止状态契约）；Agent Mesh 负责本机同伴 Agent 互操作；Skills 负责 manifest、provenance 和 eval runner 行为。

## 发现一：Linear 映射存在但格式不完全统一 / Finding 1: Linear Mapping Exists But Is Not Fully Standardized

Severity: P2 non-blocking. Every reviewed document had at least one Linear or `QUI-` reference, so this is not a missing-record failure. However, several documents use inline mapping, decision tables, or "Next Steps" instead of a standard `Linear 映射 / Linear Mapping` heading, including `docs/04-planning/planning-durable-runtime-frontier.md`, `docs/05-tool/tools-frontier-assimilation.md`, `docs/11-agent-mesh/mesh-frontier-assimilation.md`, and `docs/00-core-loop/competitor-issue-intake.md`.

严重级别：P2，非阻塞。每份被复核文档都至少有一个 Linear 或 `QUI-` 引用，所以这不是缺少记录的问题。但有几份文档使用内联映射、决策表或“下一步”来表达映射，而不是统一的 `Linear 映射 / Linear Mapping` 标题，包括 `docs/04-planning/planning-durable-runtime-frontier.md`、`docs/05-tool/tools-frontier-assimilation.md`、`docs/11-agent-mesh/mesh-frontier-assimilation.md` 和 `docs/00-core-loop/competitor-issue-intake.md`。

Why it matters: future docs/process automation in `QUI-69`（the issue for local documentation and process checks）will be easier and less fragile if each decision or implementation document has a predictable Linear mapping section. The current content is usable for humans, but less reliable for local lint or review scripts.

影响原因：未来 `QUI-69`（本地文档与流程检查 issue）的 docs/process 自动化，如果每份决策或实现文档都有可预测的 Linear 映射小节，就会更简单且更不脆弱。当前内容对人类可读，但对本地 lint 或 review 脚本不够稳定。

Recommended fix: do not create a new issue. Add this normalization to `QUI-69` acceptance: every new frontier assimilation or implementation plan should include a `Linear 映射 / Linear Mapping` section, even when it already mentions Linear near the top.

建议修复：不要新建 issue。把这条规范化要求加入 `QUI-69` 验收：每份新的前沿吸收或实现规划文档都应包含 `Linear 映射 / Linear Mapping` 小节，即使顶部已经提到 Linear。

## 发现二：Benchmark 后置纪律总体正确但应形成统一标记 / Finding 2: Benchmark Deferral Is Correct But Should Use A Stable Marker

Severity: P2 non-blocking. The scan found many explicit "benchmark later" statements, including the LLM, Context, Memory, Planning, Safety, Deployment, Mesh implementation, Observability implementation, Skills, and Docs/process documents. No reviewed component document promoted public benchmark execution ahead of component hardening.

严重级别：P2，非阻塞。扫描发现大量明确的“benchmark 后置”声明，覆盖 LLM、Context、Memory、Planning、Safety、Deployment、Mesh 实现、Observability 实现、Skills 和 Docs/process 文档。没有发现被复核的组件文档把公开 benchmark 执行提升到组件强化之前。

The weaker point is consistency. Some documents carry the benchmark posture as a top-scope paragraph; others only imply it through implementation order or omit it because the component is not benchmark-facing. This is acceptable now, but it makes future review depend on human judgment.

较弱点是一致性。有些文档在顶部范围段落中写明 benchmark 姿态；有些只通过实现顺序暗示，或因为组件本身不直接面向 benchmark 而省略。当前可以接受，但会让后续复核依赖人工判断。

Recommended fix: reuse `QUI-69` rather than creating a new issue. Add a docs/process check that recognizes an optional stable marker such as "Benchmark posture: deferred until component gates pass" and its Chinese paired paragraph for F0/F1 planning documents.

建议修复：复用 `QUI-69`，不要新建 issue。为 F0/F1 规划文档增加一个 docs/process 检查，识别可选的稳定标记，例如 “Benchmark posture: deferred until component gates pass”，并要求配套中文段落。

## 发现三：重复契约目前有清楚权属 / Finding 3: Repeated Contracts Currently Have Clear Ownership

No ownership conflict was found for the major repeated contracts. `SandboxRouter` appears in Tools and Deployment documents, but the split is coherent: Tools describes the consumer-facing tool and browser contract, while Deployment owns sandbox lifecycle, provider selection, snapshots, and runtime resource policy.

主要重复契约没有发现权属冲突。`SandboxRouter` 同时出现在 Tools 和 Deployment 文档中，但拆分是清楚的：Tools 描述面向工具和浏览器的消费侧契约，Deployment 负责沙箱生命周期、提供方选择、快照和运行时资源策略。

`WriteAuthority` appears in Safety, Multi-Agent, Agent Mesh, and Skills documents, but the split is also coherent: Safety owns the policy record and classifier integration; the other components are consumers that must pass their write-capable actions through that gate.

`WriteAuthority` 同时出现在 Safety、Multi-Agent、Agent Mesh 和 Skills 文档中，但拆分同样清楚：Safety 负责策略记录和分类器集成；其他组件是消费方，必须把具备写入能力的动作送过这个 gate。

`LoopStepEvent`, `LoopStopState`, and trace-to-eval（turning execution traces into evaluation fixtures）appear in Observability and Multi-Agent documents, but Observability remains the contract owner while Multi-Agent maps its runtime state transitions into those events.

`LoopStepEvent`、`LoopStopState` 和 trace-to-eval（把执行追踪转换成评测夹具）同时出现在 Observability 与 Multi-Agent 文档中，但 Observability 仍是契约负责人，Multi-Agent 只是把自己的运行时状态迁移映射到这些事件上。

## 发现四：AgentBridge 作用域没有被越界写入 / Finding 4: AgentBridge Scope Stayed Clean

No reviewed document asks to put project execution rules into `agent-bridge.md`. Several docs explicitly state that `agent-bridge.md` is only the AgentBridge collaboration protocol and that project execution, Linear logging, bilingual docs, and evidence discipline belong in `quilin.md` / `AGENTS.md`.

没有被复核文档要求把项目执行规则写入 `agent-bridge.md`。多份文档明确说明 `agent-bridge.md` 只负责 AgentBridge 协作协议，而项目执行、Linear 记录、中英双语文档和实证纪律属于 `quilin.md` / `AGENTS.md`。

This directly satisfies the user constraint that `agent-bridge.md` should not become the place for general project-management rules.

这直接满足用户约束：`agent-bridge.md` 不应变成通用项目管理规则的存放位置。

## 发现五：免费版 Issue 额度风险受控 / Finding 5: Free-Plan Issue Budget Risk Is Controlled

Linear `list_issues(limit=250)` returned one page with `hasNextPage=false`, and the highest observed issue identifier remains `QUI-78`. This means the workspace is not close to the 200 or 225 issue thresholds defined in the project rule.

Linear `list_issues(limit=250)` 返回单页结果，`hasNextPage=false`，当前观察到的最高 issue 编号仍是 `QUI-78`。这说明 workspace 尚未接近项目规则定义的 200 或 225 个 issue 阈值。

The reviewed docs also repeatedly say not to create new issues unless there is independent ownership, status, blockers, or acceptance criteria. This is consistent with the free-plan budget rule.

被复核文档也反复说明：除非存在独立负责人、状态、阻塞关系或验收标准，否则不要新建 issue。这与免费版额度规则一致。

## 发现六：术语与双语结构通过当前自动检查 / Finding 6: Terminology And Bilingual Structure Passed Current Checks

The full reviewed document set passed `python3 scripts/lint-glossary.py` with `glossary lint: clean`. The reviewed files also passed `git diff --check` with no whitespace output.

完整被复核文档集合通过了 `python3 scripts/lint-glossary.py`，输出为 `glossary lint: clean`。被复核文件也通过了 `git diff --check`，没有空白字符问题输出。

Manual spot checks found the expected bilingual pattern in prose sections. Tables and code fences are not pure paragraph pairs, but most reviewed tables either contain bilingual cells or have paired English and Chinese tables. This should be acceptable until `QUI-69` defines the exact automated rule.

人工抽查在正文段落中看到了预期的中英双语模式。表格和代码块不是纯段落对，但大多数被复核表格要么单元格内中英并列，要么有成对的英文表和中文表。在 `QUI-69` 定义精确自动规则前，这应视为可接受。

## 不需要新 Issue / No New Issue Needed

No finding above requires a new Linear issue. The actionable follow-ups fit existing issues: `QUI-69` for mapping and benchmark-posture markers, `QUI-78` for execution logging discipline, and existing component issues for any future component-local edits.

以上发现都不需要新建 Linear issue。可行动后续都能放入既有 issue：`QUI-69` 承接映射与 benchmark 姿态标记，`QUI-78` 承接执行记录纪律，未来的组件局部修改则复用现有组件 issue。

## 验证 / Verification

Before writing this review file, the sampled 33-document set passed `python3 scripts/lint-glossary.py` and `git diff --check`. This review file then passed `python3 scripts/lint-glossary.py docs/00-core-loop/frontier-assimilation-cross-review.md` with `glossary lint: clean`, and `git diff --check -- docs/00-core-loop/frontier-assimilation-cross-review.md` produced no output.

写入本复核文件前，抽样的 33 份文档已通过 `python3 scripts/lint-glossary.py` 和 `git diff --check`。本复核文件随后通过 `python3 scripts/lint-glossary.py docs/00-core-loop/frontier-assimilation-cross-review.md`，输出 `glossary lint: clean`；`git diff --check -- docs/00-core-loop/frontier-assimilation-cross-review.md` 没有输出。
