# 组件延后运行时交叉复核 / Component Deferred Runtime Cross-Review

English: Linear record: `QUI-45`. This cross-review checks recent component deferred runtime planning docs as planning artifacts, not as implementation evidence. It does not create new Linear issues, does not modify `agent-bridge.md`, and does not change the reviewed component docs.

中文：Linear 记录：`QUI-45`。本交叉复核检查最近新增的组件 deferred runtime planning docs（延后运行时规划文档），把它们视为规划产物，而不是实现证据。本文不新建 Linear issue，不修改 `agent-bridge.md`，也不改动被复核的组件文档。

English: Scope covers LLM（Large Language Model，大语言模型）, Context（上下文组装与压缩层）, Memory（分层记忆与检索层）, Planning（规划与路由层）, Tools（工具执行与外部动作层）, Multi-Agent（多 Agent 调度层）, Safety（安全与权限层）, Observability（可观测性层）, Deployment（部署与运行时分发层）, Self-Evolution（自进化提案层）, Agent Mesh（Agent 间互操作层）, and Skills（技能加载与执行层）.

中文：覆盖范围包括 LLM（Large Language Model，大语言模型）、Context（上下文组装与压缩层）、Memory（分层记忆与检索层）、Planning（规划与路由层）、Tools（工具执行与外部动作层）、Multi-Agent（多 Agent 调度层）、Safety（安全与权限层）、Observability（可观测性层）、Deployment（部署与运行时分发层）、Self-Evolution（自进化提案层）、Agent Mesh（Agent 间互操作层）和 Skills（技能加载与执行层）。

## 复核方法 / Review Method

English: I first checked the repository graph overview, then used targeted `rg` scans for `Linear Mapping`, benchmark deferral, `Done` / runtime-complete boundaries, stale file-existence claims, and uppercase acronym risk. The concrete evidence commands were `rg -n`, `rg --files-without-match`, `wc -l`, and the required glossary and whitespace checks listed at the end of this document.

中文：我先检查了仓库图谱概览，然后用定向 `rg` 扫描 `Linear Mapping`、benchmark 后置、`Done` / runtime-complete（运行时完成）边界、过期文件存在性声明，以及大写缩写风险。具体证据命令包括 `rg -n`、`rg --files-without-match`、`wc -l`，以及本文末尾列出的必跑术语与空白检查。

English: This review is intentionally documentation-scoped. It checks whether the planning docs make the right claims and leave the right task boundaries. It does not assert that runtime code exists unless the reviewed document itself provides that evidence.

中文：本复核刻意限定在文档范围内。它检查规划文档是否做出正确声明、是否保留正确任务边界。除非被复核文档本身提供证据，否则本文不声称运行时代码已经存在。

## 总体结论 / Overall Verdict

English: No independent blocker was found. The reviewed docs generally keep planning deliverables separate from runtime completion, keep public benchmark（标准化能力评测，用固定任务集比较系统能力）work frozen unless requested, and map work back to Linear records.

中文：未发现独立 blocker（阻塞项）。被复核文档整体上能把规划交付与运行时完成分开，把公开 benchmark（标准化能力评测，用固定任务集比较系统能力）工作保持冻结除非用户要求，并把工作映射回 Linear 记录。

English: The main residual risk is consistency, not architecture. A few docs have stale existence statements, some lack a standardized `Linear 映射 / Linear Mapping` section, and some still need the same explicit Benchmark-frozen marker even though they do not actually start benchmark work.

中文：主要剩余风险是表述一致性，不是架构方向。少数文档存在过期的“文件不存在”声明，部分文档缺少统一的 `Linear 映射 / Linear Mapping` 小节，部分文档虽然没有启动 benchmark 工作，但仍需要同样明确的 Benchmark 冻结标记。

## 覆盖结果 / Coverage Result

English: LLM coverage passed with a clear runtime-completion boundary. `docs/01-llm-integration/production-provider-matrix-plan.md:17` says the file must not mark runtime work complete, `:265` says the issue should not be marked Done from the document alone, and `:269` provides a Linear mapping section.

中文：LLM 覆盖通过，并且运行时完成边界清晰。`docs/01-llm-integration/production-provider-matrix-plan.md:17` 说明该文件不能用于宣称运行时工作完成，`:265` 说明不能只靠本文把 issue 标为 Done，`:269` 提供了 Linear 映射小节。

English: Context coverage passed. `docs/02-context/context-runtime-deferred-plan.md:17` and `:241` should be read under the Benchmark freeze, while `:247` states that `QUI-15` stays open because relevance selection, adaptive compression, durable delta delivery, and Conversation Engineering（对话工程，用来设计长期对话体验与提示层行为的研究模块） integration are not implemented in code.

中文：Context 覆盖通过。`docs/02-context/context-runtime-deferred-plan.md:17` 与 `:241` 应按 Benchmark 冻结口径阅读，`:247` 说明 `QUI-15` 继续保持 open，因为相关性选择、自适应压缩、持久增量传递和 Conversation Engineering（对话工程，用来设计长期对话体验与提示层行为的研究模块）集成尚未在代码中实现。

English: Memory coverage passed. `docs/03-memory/observer-evaluation-pipeline-plan.md:5` says the document is planning only and does not run public benchmarks, `:29` should be read under the Benchmark freeze, and `:293` maps ownership back to Linear.

中文：Memory 覆盖通过。`docs/03-memory/observer-evaluation-pipeline-plan.md:5` 说明本文只是规划产物且不执行公开 benchmark，`:29` 应按 Benchmark 冻结口径阅读，`:293` 把权属映射回 Linear。

English: Planning coverage passed. `docs/04-planning/production-routing-supervisor-handoff-plan.md:13` says the production runtime code is not implemented, `:21` now keeps Benchmark frozen unless requested, and `:330` provides Linear mapping.

中文：Planning 覆盖通过。`docs/04-planning/production-routing-supervisor-handoff-plan.md:13` 说明生产运行时代码尚未实现，`:21` 现在说明除非用户要求 Benchmark 保持冻结，`:330` 提供 Linear 映射。

English: Tools coverage passed with one stale-reference note. `docs/05-tool/tools-runtime-deferred-plan.md:3` says it is planning only and does not implement TypeScript runtime code, `:234` maps ownership to Linear, and `docs/05-tool/browser-provider-implementation-plan.md:3` says BrowserProvider planning does not start benchmark work.

中文：Tools 覆盖通过，但有一个过期引用备注。`docs/05-tool/tools-runtime-deferred-plan.md:3` 说明它只是规划产物且不实现 TypeScript 运行时代码，`:234` 把权属映射到 Linear，`docs/05-tool/browser-provider-implementation-plan.md:3` 说明 BrowserProvider 规划不启动 benchmark 工作。

English: Multi-Agent coverage passed. `docs/06-multi-agent/supervisor-runtime-deferred-plan.md:177` distinguishes artifact completion from issue completion, `:283` provides Linear mapping, and `:307` now keeps Benchmark frozen unless requested.

中文：Multi-Agent 覆盖通过。`docs/06-multi-agent/supervisor-runtime-deferred-plan.md:177` 区分“产物完成”和“issue 完成”，`:283` 提供 Linear 映射，`:307` 现在说明除非用户要求 Benchmark 保持冻结。

English: Safety coverage is architecturally sound but needs a consistency cleanup. `docs/07-safety-guardrails/production-threat-model-plan.md:7` says it is not an implementation-complete claim, and `:205` says the document closes the planning gap rather than the runtime implementation gap. However, this file does not currently have a standardized `Linear 映射 / Linear Mapping` heading and did not match the benchmark-deferral scan.

中文：Safety 架构方向正确，但需要一致性清理。`docs/07-safety-guardrails/production-threat-model-plan.md:7` 说明它不是实现完成声明，`:205` 说明本文档关闭的是规划缺口而不是运行时实现缺口。不过，该文件当前没有统一的 `Linear 映射 / Linear Mapping` 标题，也没有命中 benchmark 后置扫描。

English: Observability coverage passed with one stale-reference note and one closure-marker weakness. `docs/08-observability/observability-backend-dashboard-plan.md:11` says it is implementation planning only, `:260` maps Linear ownership, and `:288` now keeps Benchmark frozen unless requested. `docs/08-observability/trace-to-eval-verification-plan.md:9` should also be read under the freeze.

中文：Observability 覆盖通过，但有一个过期引用备注和一个关闭条件标记偏弱的问题。`docs/08-observability/observability-backend-dashboard-plan.md:11` 说明它只是实现规划，`:260` 映射 Linear 权属，`:288` 已改为 Benchmark 冻结。`docs/08-observability/trace-to-eval-verification-plan.md:9` 也应按冻结口径阅读。

English: Deployment coverage passed. `docs/09-deployment-runtime/deployment-runtime-deferred-plan.md:13` says `QUI-21` remains open after the document lands, `:217` now keeps Benchmark frozen unless requested, and `:229` provides Linear mapping.

中文：Deployment 覆盖通过。`docs/09-deployment-runtime/deployment-runtime-deferred-plan.md:13` 说明本文落地后 `QUI-21` 仍保持 open，`:217` 现在说明除非用户要求 Benchmark 保持冻结，`:229` 提供 Linear 映射。

English: Self-Evolution coverage passed for boundary discipline but needs the same Linear-section cleanup as Safety. `docs/10-self-evolution/trajectory-to-patch-deferred-runtime-plan.md:9` keeps `QUI-12` open as the deferred runtime owner, and `:273` says higher benchmark scores do not approve scaffold patches. The document references Linear but does not use a standardized `Linear 映射 / Linear Mapping` section.

中文：Self-Evolution 边界纪律通过，但需要和 Safety 一样补统一 Linear 小节。`docs/10-self-evolution/trajectory-to-patch-deferred-runtime-plan.md:9` 把 `QUI-12` 保留为延后运行时负责人，`:273` 说明更高 benchmark 分数不能直接批准脚手架补丁。该文档引用了 Linear，但没有使用统一的 `Linear 映射 / Linear Mapping` 小节。

English: Agent Mesh coverage passed with a benchmark-marker cleanup. `docs/11-agent-mesh/deferred-mesh-runtime-plan.md:171` provides Linear mapping, and `:221` states that implementation verification is intentionally deferred because the task is planning, not runtime code. It should add a stable note that mesh networking work must not trigger Benchmark work unless the user explicitly asks.

中文：Agent Mesh 覆盖通过，但需要补 Benchmark 标记。`docs/11-agent-mesh/deferred-mesh-runtime-plan.md:171` 提供 Linear 映射，`:221` 说明实现验证有意延后，因为该任务是规划产物而不是运行时代码。应补一句稳定声明：除非用户明确要求，mesh 网络工作不得触发 Benchmark 工作。

English: Skills coverage passed with a closure-marker caveat. `docs/13-skills/skills-runtime-implementation-plan.md:7` should be read under the Benchmark freeze, `:403` provides Linear mapping, and `:435` says not to start global benchmark work from this issue. `docs/13-skills/skills-platformization-deferred-plan.md:260` maps deferred platform ownership and `:262` keeps the issue open because runtime code is not implemented.

中文：Skills 覆盖通过，但关闭条件标记需要注意。`docs/13-skills/skills-runtime-implementation-plan.md:7` 应按 Benchmark 冻结口径阅读，`:403` 提供 Linear 映射，`:435` 说明不要从该 issue 启动全局 benchmark。`docs/13-skills/skills-platformization-deferred-plan.md:260` 映射延后平台权属，`:262` 因运行时代码尚未实现而保持 issue open。

## 非阻塞发现 / Non-Blocking Findings

English: Finding 1: stale file-existence statements should be cleaned up. `docs/08-observability/observability-backend-dashboard-plan.md:7` says `trace-to-eval-verification-plan.md` did not exist during that planning pass, but the file now exists. `docs/05-tool/browser-provider-implementation-plan.md:7` says `sandbox-router-implementation-plan.md` does not exist in the current workspace, but `docs/09-deployment-runtime/sandbox-router-implementation-plan.md` is now present.

中文：发现 1：应清理过期的文件存在性声明。`docs/08-observability/observability-backend-dashboard-plan.md:7` 说 `trace-to-eval-verification-plan.md` 在当次规划时不存在，但该文件现在已存在。`docs/05-tool/browser-provider-implementation-plan.md:7` 说当前 workspace 不存在 `sandbox-router-implementation-plan.md`，但 `docs/09-deployment-runtime/sandbox-router-implementation-plan.md` 现在已经存在。

English: Finding 2: standard `Linear 映射 / Linear Mapping` sections should be added to Safety and the Self-Evolution deferred plan. Both documents mention Linear ownership, but a consistent section heading makes later automation, review, and issue reuse easier.

中文：发现 2：Safety 与 Self-Evolution 延后规划应补统一的 `Linear 映射 / Linear Mapping` 小节。两个文档都提到了 Linear 权属，但统一的小节标题更利于后续自动化、review 和 issue 复用。

English: Finding 3: stable benchmark-deferred markers should be added to LLM, Safety, and Agent Mesh. These docs do not appear to start benchmark work, but they did not match the shared benchmark-deferral scan. Adding one explicit bilingual paragraph avoids future ambiguity.

中文：发现 3：LLM、Safety 和 Agent Mesh 应补稳定的 benchmark 后置标记。这些文档看起来没有启动 benchmark 工作，但没有命中统一的 benchmark 后置扫描。补一段明确的中英双语声明可以避免后续歧义。

English: Finding 4: runtime-complete wording is weaker in the Observability verification doc and the Skills runtime implementation plan than in the deferred docs. This is not a blocker if their Linear issues are documentation or evidence-package issues, but if they are runtime issues they should add explicit "document complete is not runtime Done" wording.

中文：发现 4：Observability 验证文档与 Skills runtime implementation plan（技能运行时实现规划）的 runtime-complete 表述弱于其他 deferred docs。如果它们的 Linear issue 是文档或证据包 issue，这不是 blocker；如果它们是运行时 issue，就应补“文档完成不等于运行时 Done”的明确表述。

## 边界复核 / Boundary Review

English: No cross-component boundary conflict blocks the current plan. The strongest boundaries are: Tools owns external action execution and provider normalization; Safety owns permission and trust classification; Observability owns trace, metrics, logs, and trace-to-eval evidence; Deployment owns packaging, daemon lifecycle, sandbox resume, and release safety; Agent Mesh owns peer-agent interoperability only after local-first gates.

中文：未发现会阻塞当前计划的跨组件边界冲突。最清晰的边界是：Tools 负责外部动作执行和 provider 归一化；Safety 负责权限与信任分类；Observability 负责 trace、metrics、logs 和 trace-to-eval 证据；Deployment 负责打包、守护进程生命周期、沙箱恢复和发布安全；Agent Mesh 只在本机优先门槛通过后负责同伴 Agent 互操作。

English: The only repeated-ownership area is `QUI-18`, which covers both BrowserProvider v1 and the broader Tools runtime deferred path. This is acceptable under the free Linear cap if comments keep BrowserProvider as a slice and Tools runtime as the umbrella. It should not be split into new issues unless independent ownership or blockers appear.

中文：唯一重复权属区域是 `QUI-18`，它同时覆盖 BrowserProvider v1 和更大的 Tools runtime deferred path。在 Linear 免费额度下这可以接受，前提是 comment 明确 BrowserProvider 是切片、Tools runtime 是 umbrella（总边界）。除非出现独立负责人或阻塞关系，否则不应拆新 issue。

English: The benchmark posture is consistent in direction: public benchmark execution remains after component hardening. The cleanup requested above is about searchability and durable wording, not a discovered plan to run benchmark work early.

中文：benchmark 姿态在方向上是一致的：公开 benchmark 执行继续放在组件强化之后。上面要求的清理是为了可搜索性和稳定表述，不是因为发现了提前跑 benchmark 的计划。

## 术语风险 / Terminology Risk

English: No blocking naked acronym risk was found. Many uppercase tokens appear in repeated references or code identifiers, but first uses are generally annotated, such as LLM, MCP（Model Context Protocol，模型上下文协议）, OTLP（OpenTelemetry Protocol，开放遥测协议）, A2A（Agent2Agent，用于 Agent 间协作的协议方向）, XML（Extensible Markup Language，可扩展标记语言）, and PII（Personally Identifiable Information，个人身份信息）.

中文：未发现阻塞级裸写缩写风险。很多大写 token 出现在重复引用或代码标识符里，但首次出现总体已有注释，例如 LLM、MCP（Model Context Protocol，模型上下文协议）、OTLP（OpenTelemetry Protocol，开放遥测协议）、A2A（Agent2Agent，用于 Agent 间协作的协议方向）、XML（Extensible Markup Language，可扩展标记语言）和 PII（Personally Identifiable Information，个人身份信息）。

English: The residual terminology risk is future drift. When adding cleanup patches, avoid adding bare terms such as `SDK`, `API`, `CLI`, `HTTP`, `JSON`, `ID`, `worker`, `adapter`, `harness`, or `runtime-complete` without a natural parenthetical explanation on first occurrence in that document.

中文：剩余术语风险是未来漂移。后续清理补丁中，首次出现 `SDK`、`API`、`CLI`、`HTTP`、`JSON`、`ID`、`worker`、`adapter`、`harness` 或 `runtime-complete` 时，不要裸写，应加自然括号说明。

## 建议处理 / Recommended Handling

English: Do not create new Linear issues for these findings. Reuse `QUI-45` as the cross-review record and add comments to the owning issues only when a maintainer is about to edit that component doc. The highest-value cleanup order is stale existence claims first, then standardized Linear sections, then benchmark-deferred marker paragraphs.

中文：不要为这些发现新建 Linear issue。复用 `QUI-45` 作为交叉复核记录；只有当维护者准备编辑对应组件文档时，再在原 owner issue 里追加 comment。最高价值清理顺序是：先修过期文件存在性声明，再补统一 Linear 小节，最后补 benchmark 后置标记段落。

English: Blocker status: none. The current planning set is usable for review and next implementation planning as long as readers understand that the docs close planning gaps, not runtime gaps.

中文：阻塞状态：无。当前规划集可用于 review 和后续实现规划，前提是读者明确这些文档关闭的是规划缺口，不是运行时缺口。

## 验证 / Verification

English: Required verification for this document is `python3 scripts/lint-glossary.py docs/00-core-loop/component-deferred-cross-review.md`, `git diff --check -- docs/00-core-loop/component-deferred-cross-review.md`, and `wc -l docs/00-core-loop/component-deferred-cross-review.md`.

中文：本文要求的验证命令是 `python3 scripts/lint-glossary.py docs/00-core-loop/component-deferred-cross-review.md`、`git diff --check -- docs/00-core-loop/component-deferred-cross-review.md` 和 `wc -l docs/00-core-loop/component-deferred-cross-review.md`。
