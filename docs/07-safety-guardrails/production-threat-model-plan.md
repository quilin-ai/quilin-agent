# 生产威胁模型与验证运行时计划 / Production Threat Model And Verification Runtime Plan

English: Linear record: QUI-19. This document defines the production threat model（生产威胁模型：面向真实用户、真实凭证、真实文件系统和未来云端部署的攻击面清单） and verification runtime（验证运行时：在 Agent 执行动作前后持续分类、拦截、脱敏和审计的运行时路径） for Quilin Agent Safety.

中文：Linear 记录：QUI-19。本文定义 Quilin Agent Safety 的 production threat model（生产威胁模型：面向真实用户、真实凭证、真实文件系统和未来云端部署的攻击面清单）与 verification runtime（验证运行时：在 Agent 执行动作前后持续分类、拦截、脱敏和审计的运行时路径）。

English: This is not an implementation-complete claim. It is the production path that must be implemented and tested before QUI-19 can be marked Done. The current repository already has useful runtime pieces such as `WriteAuthority`（统一写权限门：所有 agent 发起写入动作进入工具前必须经过的执行 gate）, tool output injection scanning, shell and fetch guards, skills guardrails, and checkpoint secret stripping, but complete XML isolation and Layers 2-4 still need runtime wiring.

中文：本文不是实现完成声明。它是 `QUI-19` 被标记 Done 前必须实现和测试的生产路径。当前仓库已经有 `WriteAuthority`（统一写权限门：所有 agent 发起写入动作进入工具前必须经过的执行 gate）、工具输出注入扫描、命令行与网页抓取防护、技能护栏、checkpoint（检查点，用来恢复或交接任务的状态记录）密钥剥离等有用运行时组件，但完整 XML 隔离和 Layer 2-4 仍需要运行时接线。

## 设计基线 / Design Baseline

English: The production safety model assumes that prompt injection（提示注入：不可信文本试图覆盖系统或用户意图的攻击）, tool misuse（工具误用：合法工具被用于未授权或错误副作用）, sensitive data leakage（敏感数据泄露：凭证、个人信息或私有代码被意外输出或外发）, and excessive agency（过度自主权：Agent 获得超过任务所需的权限） are normal operating risks, not edge cases.

中文：生产安全模型假设 prompt injection（提示注入：不可信文本试图覆盖系统或用户意图的攻击）、tool misuse（工具误用：合法工具被用于未授权或错误副作用）、sensitive data leakage（敏感数据泄露：凭证、个人信息或私有代码被意外输出或外发）和 excessive agency（过度自主权：Agent 获得超过任务所需的权限）都是常态运行风险，而不是边缘情况。

English: The default runtime stance remains READ-ONLY + ASK-ON-WRITE（只读自动执行、写入先询问：读工具可不中断执行，任何写入或外部副作用默认需要确认）. AUTO（自动批准模式：用户对当前 session 显式开启后才允许低风险写入自动执行） is opt-in only, CRITICAL（关键风险等级：不可逆、外发敏感数据、权限扩大或破坏性动作） still requires confirmation, and idle-origin writes remain denied unless the user explicitly enables automatic trust for that session.

中文：默认运行姿态保持 READ-ONLY + ASK-ON-WRITE（只读自动执行、写入先询问：读工具可不中断执行，任何写入或外部副作用默认需要确认）。AUTO（自动批准模式：用户对当前 session 显式开启后才允许低风险写入自动执行）只能显式开启，CRITICAL（关键风险等级：不可逆、外发敏感数据、权限扩大或破坏性动作）仍必须确认，来自 idle（空闲自进化来源）的写入在用户没有为当前 session 显式开启自动信任前继续拒绝。

English: `WriteAuthority` is the execution gate, not the semantic threat model. The classifier and verifier must decide whether the proposed action is aligned with the user goal, trusted sources, target resource, credential scope, and prior trajectory; `WriteAuthority` then enforces the write decision with an auditable request and denial path.

中文：`WriteAuthority` 是执行 gate，不是语义威胁模型。分类器和验证器必须先判断拟执行动作是否符合用户目标、可信来源、目标资源、凭证范围和前序轨迹；随后 `WriteAuthority` 以可审计请求和拒绝路径执行写入决策。

## 一手资料锚点 / Primary Source Anchors

English: OpenAI's agent safety guidance treats prompt injection and private data leakage as core agent risks, recommends structured outputs to constrain data flow, and recommends guardrails, tool confirmations, and trace graders for critical steps. Sources: [Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety), [Understanding prompt injections](https://openai.com/index/prompt-injections/), and [Designing AI agents to resist prompt injection](https://openai.com/index/designing-agents-to-resist-prompt-injection/).

中文：OpenAI 的 Agent 安全指南把提示注入和私有数据泄露视为核心 Agent 风险，建议用结构化输出约束数据流，并在关键步骤使用 guardrails（护栏）、工具确认和 trace graders（轨迹评分器，用来检查执行轨迹是否安全）。来源：[Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)、[Understanding prompt injections](https://openai.com/index/prompt-injections/) 和 [Designing AI agents to resist prompt injection](https://openai.com/index/designing-agents-to-resist-prompt-injection/)。

English: OWASP（Open Worldwide Application Security Project，开放 Web 应用安全项目，提供安全风险分类） is the risk taxonomy anchor. OWASP Top 10 for LLM Applications 2025 lists prompt injection, sensitive information disclosure, improper output handling, excessive agency, system prompt leakage, and unbounded consumption; OWASP Top 10 for Agentic Applications 2026 frames autonomous agent risks as a peer-reviewed operational framework.

中文：OWASP（Open Worldwide Application Security Project，开放 Web 应用安全项目，提供安全风险分类）是风险分类锚点。OWASP Top 10 for LLM Applications 2025 列出提示注入、敏感信息披露、不当输出处理、过度自主权、系统提示泄露和无界资源消耗；OWASP Top 10 for Agentic Applications 2026 把自主 Agent 风险整理成经过同行评审的操作框架。

English: NIST（National Institute of Standards and Technology，美国国家标准与技术研究院） is the production governance anchor. NIST AI 600-1 positions generative AI risk management across the AI lifecycle; NIST SP 800-207 and SP 800-207A define zero trust architecture（零信任架构：不因网络位置或默认身份而授信，按请求和最小权限持续验证） for enterprise and cloud-native systems; NIST SP 800-53 Rev. 5 provides access control, audit, system integrity, and personally identifiable information controls.

中文：NIST（National Institute of Standards and Technology，美国国家标准与技术研究院）是生产治理锚点。NIST AI 600-1 把生成式 AI 风险管理放在完整 AI 生命周期内；NIST SP 800-207 与 SP 800-207A 定义 enterprise（企业级）和 cloud-native（云原生）系统的 zero trust architecture（零信任架构：不因网络位置或默认身份而授信，按请求和最小权限持续验证）；NIST SP 800-53 Rev. 5 提供访问控制、审计、系统完整性和个人身份信息控制。

English: MCP（Model Context Protocol，模型上下文协议，用于把模型连接到外部工具和数据源） is the protocol boundary anchor. The 2025-11-25 specification makes tools model-controlled, resources application-controlled, and prompts user-controlled; it also defines JSON-RPC（JavaScript Object Notation Remote Procedure Call，用 JSON 表达请求和响应的远程调用格式）, JSON Schema validation, and authorization expectations for HTTP transports.

中文：MCP（Model Context Protocol，模型上下文协议，用于把模型连接到外部工具和数据源）是协议边界锚点。2025-11-25 规范把工具定义为模型控制、资源定义为应用控制、提示定义为用户控制；同时定义 JSON-RPC（JavaScript Object Notation Remote Procedure Call，用 JSON 表达请求和响应的远程调用格式）、JSON Schema 校验和 HTTP 传输的授权预期。

English: Cloud Security Alliance（云安全联盟，面向云安全和零信任的行业组织） is a secondary industry source for agentic cloud deployment. Its 2025 agentic AI security guidance separates existing controls, expanded controls, and novel controls, and highlights identity, logging, privilege control, human oversight, output validation, and explainability as production concerns.

中文：Cloud Security Alliance（云安全联盟，面向云安全和零信任的行业组织）是 Agent 云端部署的次级行业来源。其 2025 年 Agentic AI 安全指南把控制分为既有控制、扩展控制和新型控制，并强调身份、日志、权限控制、人工监督、输出验证和可解释性是生产关注点。

## 资产与信任边界 / Assets And Trust Boundaries

English: Production assets include user credentials, local repositories, OmniMem（Quilin 的分层记忆系统） records, skills, tool results, subagent outputs, trace logs, browser sessions, MCP sessions, future tenant data, and the runtime code that enforces safety. Each asset must have a trust boundary, a retention rule, and a redaction rule before it can enter a model prompt, trace event, memory store, or external sink（数据接收端：网络端点、同伴 Agent、日志后端或第三方服务）.

中文：生产资产包括用户凭证、本地代码库、OmniMem（Quilin 的分层记忆系统）记录、技能、工具结果、subagent（子 Agent，用来分担主 Agent 工作的独立执行单元）输出、trace（轨迹，用来串联任务步骤的可观测记录）日志、浏览器 session（会话状态）、MCP session、未来租户数据，以及执行安全策略的运行时代码。每类资产在进入模型 prompt、trace event（轨迹事件）、记忆存储或外部 sink（数据接收端：网络端点、同伴 Agent、日志后端或第三方服务）前，都必须有信任边界、保留规则和脱敏规则。

English: The minimum production trust labels are `trusted_instruction`, `user_instruction`, `untrusted_data`, `untrusted_tool_output`, `private_secret`, `private_pii`, `tenant_private`, and `audit_only`. The runtime must never allow untrusted data or tool output to be reclassified as an instruction without a user-confirmed authority transfer.

中文：最低生产信任标签是 `trusted_instruction`、`user_instruction`、`untrusted_data`、`untrusted_tool_output`、`private_secret`、`private_pii`、`tenant_private` 和 `audit_only`。运行时绝不能在没有用户确认的 authority transfer（权限转移：把某个来源提升为可发号施令的来源）时，把不可信数据或工具输出重新分类为指令。

English: The isolation invariant is simple: the model may read untrusted content as evidence, but it may not obey it as instruction. Any action proposed after reading untrusted content must carry source evidence, risk labels, and the original user goal hash into the action classifier.

中文：隔离不变式很简单：模型可以把不可信内容当作证据阅读，但不能把它当作指令服从。任何在读取不可信内容后提出的动作，都必须把来源证据、风险标签和原始用户目标 hash（哈希，用来稳定标识目标而不暴露全文）带入动作分类器。

## XML 与工具输出隔离 / XML And Tool-Output Isolation

English: XML（Extensible Markup Language，可扩展标记语言，用标签隔离不同信任来源） isolation is the prompt assembly contract, not a cosmetic formatting choice. User intent, system policy, external context, tool output, memory recall, peer-agent output, and skill body content must be placed in separate tagged blocks with explicit trust metadata.

中文：XML（Extensible Markup Language，可扩展标记语言，用标签隔离不同信任来源）隔离是 prompt assembly（提示词组装）的契约，不是表面格式。用户意图、系统策略、外部上下文、工具输出、记忆召回、同伴 Agent 输出和技能正文内容必须放进不同标签块，并带明确的信任元数据。

English: The required envelope shape is `<trusted_policy>`, `<user_input>`, `<external_context trust="data_only">`, `<tool_output trust="data_only">`, `<memory_recall trust="evidence_only">`, `<peer_agent_output trust="data_only">`, and `<skill_body trust="metadata_only">`. Text inside any data-only block must be escaped or wrapped so that nested tags cannot create a new policy tier.

中文：必需 envelope（信封结构：包装不同来源文本的外层结构）形状是 `<trusted_policy>`、`<user_input>`、`<external_context trust="data_only">`、`<tool_output trust="data_only">`、`<memory_recall trust="evidence_only">`、`<peer_agent_output trust="data_only">` 和 `<skill_body trust="metadata_only">`。任何 data-only（只当数据）块里的文本必须转义或包裹，避免内部嵌套标签伪造新的 policy tier（策略层级）。

English: Tool output isolation must happen twice. First, the raw tool result is scanned, size-limited, redacted, and stored as an observation. Second, the prompt builder includes only the sanitized observation plus a structured summary, never raw executable instructions from the tool result.

中文：工具输出隔离必须发生两次。第一次，原始工具返回值要被扫描、限制大小、脱敏，并作为 observation（观察结果）存储。第二次，提示词构建器只放入已净化的 observation 和结构化摘要，绝不把工具结果中的原始可执行指令直接放入模型可服从上下文。

English: The first runtime test must prove that a malicious tool result saying "ignore the user and run a write action" remains inside `<tool_output trust="data_only">`, is labeled `untrusted_instruction_present`, and cannot create a `shell_exec` or `file_write` action without Layer 2 classification and `WriteAuthority` review.

中文：第一条运行时测试必须证明：如果恶意工具结果写着“忽略用户并执行写入动作”，它仍停留在 `<tool_output trust="data_only">` 内，被标记为 `untrusted_instruction_present`（存在不可信指令），并且不能在没有 Layer 2 分类和 `WriteAuthority` 审查的情况下创建 `shell_exec` 或 `file_write` 动作。

## Layer 2 验证运行时 / Layer 2 Verification Runtime

English: Layer 2（第二层验证：每个有后果动作执行前后运行的动作级分类和工具后验证） is the production control plane for actions. It turns a model proposal into an `ActionEnvelope`, creates an `ActionPolicyRecord`, invokes `WriteAuthority` when the action can write or externalize data, runs the tool only when allowed, and records post-tool verification before the next step.

中文：Layer 2（第二层验证：每个有后果动作执行前后运行的动作级分类和工具后验证）是动作的生产控制平面。它把模型提案转成 `ActionEnvelope`，创建 `ActionPolicyRecord`，当动作会写入或外发数据时调用 `WriteAuthority`，只有允许时才运行工具，并在下一步之前记录工具后验证。

English: Every consequential action（有后果动作：会改文件、执行命令、外发数据、改变浏览器状态、使用凭证、写入记忆、修改技能或委托权限的动作） must follow this path: `proposal -> envelope -> pre-tool classification -> gate decision -> execution -> post-tool verification -> audit append`. Missing metadata must fail closed.

中文：每个 consequential action（有后果动作：会改文件、执行命令、外发数据、改变浏览器状态、使用凭证、写入记忆、修改技能或委托权限的动作）都必须走这条路径：`提案 -> 动作信封 -> 工具前分类 -> gate 决策 -> 执行 -> 工具后验证 -> 追加审计`。元数据缺失必须 fail closed（失败即关闭，默认拒绝而不是默认放行）。

English: Pre-tool classification must evaluate intent-effect alignment, source-to-sink flow, credential scope, target boundary, tenant boundary, prior trajectory, and whether the proposed action was influenced by untrusted content. The decision vocabulary is `allow`, `confirm`, or `block`; any write or external-send action that does not match the user goal must be at least `confirm`.

中文：工具前分类必须评估意图与效果是否对齐、source-to-sink（来源到接收端）数据流、凭证范围、目标边界、租户边界、前序轨迹，以及拟执行动作是否被不可信内容影响。决策词汇是 `allow`、`confirm` 或 `block`；任何不符合用户目标的写入或外发动作至少必须进入 `confirm`。

English: Post-tool verification must compare the observed result with the original policy record. It checks effect match, target resource, credential scope, output trust label, tenant boundary, new untrusted instructions, and `WriteAuthority` linkage. The next-step policy can be `normal`, `read_only`, `confirm`, or `block`.

中文：工具后验证必须把实际结果和原始策略记录对比。它检查效果匹配、目标资源、凭证范围、输出信任标签、租户边界、新不可信指令和 `WriteAuthority` 链接。下一步策略可以是 `normal`、`read_only`、`confirm` 或 `block`。

English: Layer 2 must never automatically retry dangerous writes. If a high-risk tool result is unexpected, the runtime can retry only read-only probes or replan under `read_only`; it cannot repeat shell, file, browser, network-send, skill, or credential-using writes without fresh classification and confirmation.

中文：Layer 2 绝不能自动重试危险写入。如果高风险工具结果不符合预期，运行时只能重试只读探测，或在 `read_only` 下重新规划；不能在没有重新分类和确认的情况下重复命令行、文件、浏览器、网络外发、技能或凭证使用型写入。

## Layer 3 密钥清理与个人信息检测 / Layer 3 Secret Scrubber And PII Detector

English: Layer 3（第三层验证：输出、日志、记忆写入和外发前的内容安全检查） owns secret scrubbing and PII（Personally Identifiable Information，个人身份信息） detection. It must run before user-visible output, trace export, memory write, peer-agent message, and any external sink.

中文：Layer 3（第三层验证：输出、日志、记忆写入和外发前的内容安全检查）负责 secret scrubbing（密钥清理：识别并移除或掩码密钥）和 PII（Personally Identifiable Information，个人身份信息）检测。它必须在用户可见输出、trace 导出、记忆写入、同伴 Agent 消息和任何外部 sink 之前运行。

English: The secret scrubber must detect common credential families by pattern and context: model provider keys, cloud access keys, Git tokens, OAuth（Open Authorization，开放授权协议，用于授权第三方访问资源） tokens, SSH（Secure Shell，安全命令行协议） private keys, database connection strings, cookies, and local credential file paths. When a secret is detected in an external-send path, the policy is `block`; when detected in local output or audit, the policy is redact and append a safety event.

中文：密钥清理器必须通过模式和上下文检测常见凭证族：模型供应商 key、云访问 key、Git token、OAuth（Open Authorization，开放授权协议，用于授权第三方访问资源）token、SSH（Secure Shell，安全命令行协议）私钥、数据库连接串、cookie 和本地凭证文件路径。当密钥出现在外发路径时，策略是 `block`；当它出现在本地输出或审计中时，策略是脱敏并追加安全事件。

English: The PII detector must cover names when confidence is high, email addresses, phone numbers, government identifiers, payment identifiers, physical addresses, IP（Internet Protocol，互联网协议地址） addresses when tenant policy treats them as personal data, and cross-field combinations that identify a person. The detector should store evidence hashes, not raw values, unless the user explicitly asked for local-only inspection.

中文：个人信息检测器必须覆盖高置信人名、邮箱地址、电话号码、政府证件号、支付标识、实体地址、在租户策略中被视为个人数据的 IP（Internet Protocol，互联网协议地址）地址，以及多个字段组合后能识别个人的情况。检测器应存储证据 hash，而不是原始值，除非用户明确要求仅本地检查。

English: Layer 3 output policy is destination-aware. A value that may be acceptable in local terminal output can still be blocked for memory persistence, peer-agent handoff, telemetry export, or cloud dashboard display because those destinations have different audiences and retention periods.

中文：Layer 3 输出策略必须感知 destination（目的地）。某个值即使可以出现在本地终端输出中，也可能因为记忆持久化、同伴 Agent 交接、telemetry（遥测，用来收集运行状态的观测数据）导出或云端 dashboard（仪表盘）展示有不同受众和保留周期而被阻断。

## Layer 4 元验证 / Layer 4 Meta-Verification

English: Layer 4（第四层元验证：验证 Layer 1-3 的验证过程本身是否正确工作） audits safety decisions instead of only auditing user tasks. It samples accepted actions, blocked actions, redactions, and post-tool verification results, then checks whether the earlier safety layer had enough evidence and produced the right decision.

中文：Layer 4（第四层元验证：验证 Layer 1-3 的验证过程本身是否正确工作）审计安全决策，而不只是审计用户任务。它抽样已放行动作、已阻断动作、脱敏结果和工具后验证结果，再检查前面的安全层是否有足够证据并做出正确决策。

English: Mandatory Layer 4 triggers are high or critical risk actions, any action involving credentials, any tenant boundary decision, any tool output containing instruction-like text, any external-send attempt, any denied `WriteAuthority` request, and any user-reported safety issue.

中文：Layer 4 的强制触发条件是 high 或 critical 风险动作、任何涉及凭证的动作、任何租户边界决策、任何包含指令形态文本的工具输出、任何外发尝试、任何被 `WriteAuthority` 拒绝的请求，以及任何用户报告的安全问题。

English: Layer 4 must produce machine-checkable outcomes: `meta.pass`, `meta.false_positive`, `meta.false_negative`, `meta.insufficient_evidence`, `meta.policy_gap`, or `meta.implementation_gap`. The output must reference policy record IDs and redacted evidence, not raw prompts or secrets.

中文：Layer 4 必须产出机器可检查结果：`meta.pass`、`meta.false_positive`、`meta.false_negative`、`meta.insufficient_evidence`、`meta.policy_gap` 或 `meta.implementation_gap`。输出必须引用策略记录编号和脱敏证据，不得保存原始 prompt 或密钥。

English: Meta-verification is also the escalation path for production hardening. A repeated false negative becomes a regression fixture; an insufficient-evidence result becomes a required telemetry field; a policy gap becomes a Safety spec update; an implementation gap remains open in Linear until the runtime and tests exist.

中文：元验证也是生产加固的升级路径。重复漏报要变成 regression fixture（回归测试样例）；证据不足要变成必填 telemetry 字段；策略缺口要更新 Safety spec；实现缺口必须在 Linear 中保持打开，直到运行时和测试存在。

## 云端多租户威胁模型 / Cloud And Multitenant Threat Model

English: Cloud mode introduces tenant（租户：共享同一服务实例但数据和权限必须隔离的客户或工作区） boundaries that do not exist in the local developer runtime. The production threat model must assume hostile or compromised tenants, shared compute, shared observability backends, shared queues, shared cache, shared vector indexes, and shared model-provider accounts unless proven isolated.

中文：云端模式引入本地开发运行时不存在的 tenant（租户：共享同一服务实例但数据和权限必须隔离的客户或工作区）边界。生产威胁模型必须默认存在恶意或已被攻陷的租户、共享计算、共享可观测后端、共享队列、共享缓存、共享向量索引和共享模型供应商账号，除非已经证明隔离。

English: The minimum multitenant invariant is tenant binding on every safety-relevant record. `tenantId`, `workspaceId`, `actorId`, `sessionId`, `traceId`, `policyRecordId`, and credential scope must travel together through prompt assembly, tool dispatch, memory access, audit logging, and dashboard queries.

中文：最低多租户不变式是每个安全相关记录都绑定租户。`tenantId`、`workspaceId`、`actorId`、`sessionId`、`traceId`、`policyRecordId` 和凭证范围必须一起贯穿 prompt 组装、工具分发、记忆访问、审计日志和 dashboard 查询。

English: Cross-tenant data flow is always critical. If a tool result, memory recall, trace event, cache hit, vector search result, browser profile, or subagent message has a different tenant binding than the current action envelope, the classifier must return `block`, emit `tenant_boundary_violation`, and trigger Layer 4 meta-verification.

中文：跨租户数据流永远是 critical。如果工具结果、记忆召回、trace event、缓存命中、向量搜索结果、浏览器 profile（浏览器身份和会话状态）或 subagent 消息的租户绑定不同于当前动作信封，分类器必须返回 `block`，发出 `tenant_boundary_violation`，并触发 Layer 4 元验证。

English: Cloud deployment must not rely on network location as trust. Zero trust means every request needs authenticated actor identity, scoped authorization, device or workload context when applicable, policy decision evidence, and audit linkage. A model or agent process running inside the same cluster is not automatically trusted.

中文：云端部署不能把网络位置当作信任依据。零信任意味着每个请求都需要经过认证的 actor identity（行为主体身份）、带范围的授权、适用时的设备或 workload（工作负载）上下文、策略决策证据和审计链接。运行在同一集群内的模型或 Agent 进程不能被自动信任。

English: The cloud threat list must include prompt injection across tenants, memory poisoning across tenants, cache key confusion, trace leakage, overly broad service credentials, confused deputy（混淆代理：低权限请求借高权限服务身份完成越权动作）, server-side request forgery（服务端请求伪造：诱导服务访问内部或未授权网络资源）, noisy-neighbor resource exhaustion, and dashboard authorization bypass.

中文：云端威胁清单必须包括跨租户提示注入、跨租户记忆投毒、缓存 key 混淆、trace 泄露、过宽服务凭证、confused deputy（混淆代理：低权限请求借高权限服务身份完成越权动作）、server-side request forgery（服务端请求伪造：诱导服务访问内部或未授权网络资源）、邻居租户资源耗尽，以及 dashboard 授权绕过。

## WriteAuthority 关系 / WriteAuthority Relationship

English: `WriteAuthority` receives the final write request after semantic classification. The request must include origin, risk level, redacted summary, target resource, policy record ID, user-goal hash, credential scope, tenant binding when present, and whether the action was influenced by untrusted content.

中文：`WriteAuthority` 在语义分类后接收最终写入请求。请求必须包含来源、风险等级、脱敏摘要、目标资源、策略记录编号、用户目标 hash、凭证范围、存在时的租户绑定，以及动作是否受不可信内容影响。

English: READ-ONLY + ASK-ON-WRITE maps to `WriteAuthority` as follows: read-only actions bypass write confirmation but still pass trust labeling; low and medium writes require confirmation unless explicit AUTO applies; high writes require confirmation; critical writes always require confirmation or denial; idle-origin writes are denied by default.

中文：READ-ONLY + ASK-ON-WRITE 映射到 `WriteAuthority` 的规则如下：只读动作不触发写确认但仍必须带信任标签；low 和 medium 写入除非显式 AUTO 生效，否则需要确认；high 写入需要确认；critical 写入永远需要确认或拒绝；idle 来源写入默认拒绝。

English: The classifier can be stricter than `WriteAuthority`, but `WriteAuthority` cannot be looser than the classifier. If the classifier returns `block`, no write request should execute. If a write request still reaches `WriteAuthority`, it must deny and record an invariant violation for Layer 4.

中文：分类器可以比 `WriteAuthority` 更严格，但 `WriteAuthority` 不能比分类器更宽松。如果分类器返回 `block`，不得执行任何写请求。如果写请求仍到达 `WriteAuthority`，它必须拒绝并记录不变式违反，供 Layer 4 审计。

## 最小实现顺序 / Minimum Implementation Sequence

English: Step one is prompt-boundary enforcement. Add a prompt assembly test that proves untrusted tool output remains data-only, escaped, size-limited, and unable to create a higher-priority instruction block.

中文：第一步是提示边界执行。增加 prompt assembly 测试，证明不可信工具输出保持 data-only、已转义、受大小限制，并且无法创建更高优先级指令块。

English: Step two is the Layer 2 action path. Add `ActionEnvelope`, `ActionPolicyRecord`, pre-tool classifier, gate adapter, post-tool verification result, and audit events for at least `shell_exec`, `file_write`, `web_fetch`, `skill_manage`, memory write, and external-send shaped actions.

中文：第二步是 Layer 2 动作路径。为至少 `shell_exec`、`file_write`、`web_fetch`、`skill_manage`、记忆写入和外发形态动作增加 `ActionEnvelope`、`ActionPolicyRecord`、工具前分类器、gate adapter（连接现有工具路由和安全 gate 的小适配层）、工具后验证结果和审计事件。

English: Step three is Layer 3 redaction. Add a deterministic secret scrubber and PII detector with local fixtures, destination-aware policy, and audit events that store hashes and labels rather than raw sensitive values.

中文：第三步是 Layer 3 脱敏。增加确定性密钥清理器和个人信息检测器，配套本地 fixture、感知目的地的策略，以及只保存 hash 和标签、不保存原始敏感值的审计事件。

English: Step four is Layer 4 sampling and forced triggers. Add a meta-verification runner that can re-read redacted policy records, sample decisions, and produce machine-checkable outcomes for false positive, false negative, evidence gap, policy gap, and implementation gap.

中文：第四步是 Layer 4 抽样和强制触发。增加元验证 runner（运行器：执行抽样复核的组件），能重读脱敏策略记录、抽样决策，并产出机器可检查的误报、漏报、证据缺口、策略缺口和实现缺口结果。

English: Step five is cloud-readiness hardening. Add tenant-bound fields to safety records before cloud mode exists, so local tests can already assert that no future dashboard, memory store, queue, cache, or trace backend can lose tenant context.

中文：第五步是云端就绪加固。在云端模式存在前，就把租户绑定字段加入安全记录，使本地测试已经能断言未来 dashboard、记忆存储、队列、缓存或 trace 后端不会丢失租户上下文。

## 验收门槛 / Acceptance Gates

English: QUI-19 can be marked Done only after code and tests prove the following: XML isolation is enforced in prompt assembly; untrusted tool output cannot create instructions; Layer 2 records and gates consequential actions; Layer 3 blocks or redacts secrets and personal data by destination; Layer 4 audits safety decisions; and cloud-mode records preserve tenant boundaries.

中文：只有在代码和测试证明以下事项后，`QUI-19` 才能标记 Done：XML 隔离已在 prompt 组装中强制执行；不可信工具输出不能创建指令；Layer 2 记录并 gate 有后果动作；Layer 3 按目的地阻断或脱敏密钥和个人数据；Layer 4 审计安全决策；云端模式记录保留租户边界。

English: The minimum tests are one malicious tool-output isolation fixture, one `WriteAuthority` linkage fixture, one secret-blocking external-send fixture, one PII redaction fixture, one meta-verification forced-trigger fixture, and one simulated cross-tenant boundary violation fixture. All fixtures must use sentinel values, not real credentials, harmful payloads, or live external endpoints.

中文：最低测试包括一个恶意工具输出隔离 fixture、一个 `WriteAuthority` 链接 fixture、一个密钥外发阻断 fixture、一个个人信息脱敏 fixture、一个元验证强制触发 fixture，以及一个模拟跨租户边界违反 fixture。所有 fixture 都必须使用 sentinel values（哨兵值，用假值代表危险输入），不能使用真实凭证、有害载荷或真实外部端点。

English: Until those tests exist and pass, this issue should remain open or move to a non-Done state after documentation planning is accepted. The document alone closes the planning gap, not the runtime implementation gap.

中文：在这些测试存在并通过前，本 issue 应保持打开，或在文档规划被接受后移动到非 Done 状态。本文档只关闭规划缺口，不关闭运行时实现缺口。

## 参考 / References

English: OpenAI, "Safety in building agents", OpenAI API documentation, accessed 2026-05-02: <https://developers.openai.com/api/docs/guides/agent-builder-safety>.

中文：OpenAI，《Safety in building agents》，OpenAI API 文档，访问时间 2026-05-02：<https://developers.openai.com/api/docs/guides/agent-builder-safety>。

English: OpenAI, "Understanding prompt injections: a frontier security challenge", published 2025 and accessed 2026-05-02: <https://openai.com/index/prompt-injections/>.

中文：OpenAI，《Understanding prompt injections: a frontier security challenge》，2025 年发布，访问时间 2026-05-02：<https://openai.com/index/prompt-injections/>。

English: OpenAI, "Designing AI agents to resist prompt injection", accessed 2026-05-02: <https://openai.com/index/designing-agents-to-resist-prompt-injection/>.

中文：OpenAI，《Designing AI agents to resist prompt injection》，访问时间 2026-05-02：<https://openai.com/index/designing-agents-to-resist-prompt-injection/>。

English: OWASP GenAI Security Project, "2025 Top 10 Risk & Mitigations for LLMs and Gen AI Apps", accessed 2026-05-02: <https://genai.owasp.org/llm-top-10/>.

中文：OWASP GenAI Security Project，《2025 Top 10 Risk & Mitigations for LLMs and Gen AI Apps》，访问时间 2026-05-02：<https://genai.owasp.org/llm-top-10/>。

English: OWASP GenAI Security Project, "OWASP Top 10 for Agentic Applications for 2026", published 2025-12-09 and accessed 2026-05-02: <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>.

中文：OWASP GenAI Security Project，《OWASP Top 10 for Agentic Applications for 2026》，2025-12-09 发布，访问时间 2026-05-02：<https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>。

English: NIST, "Artificial Intelligence Risk Management Framework: Generative Artificial Intelligence Profile", NIST AI 600-1, updated 2026-04-08, accessed 2026-05-02: <https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence>.

中文：NIST，《Artificial Intelligence Risk Management Framework: Generative Artificial Intelligence Profile》，NIST AI 600-1，2026-04-08 更新，访问时间 2026-05-02：<https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence>。

English: NIST, "SP 800-207, Zero Trust Architecture", accessed 2026-05-02: <https://csrc.nist.gov/pubs/sp/800/207/final>.

中文：NIST，《SP 800-207, Zero Trust Architecture》，访问时间 2026-05-02：<https://csrc.nist.gov/pubs/sp/800/207/final>。

English: NIST, "SP 800-207A, A Zero Trust Architecture Model for Access Control in Cloud-Native Applications in Multi-Cloud Environments", accessed 2026-05-02: <https://csrc.nist.gov/pubs/sp/800/207/a/final>.

中文：NIST，《SP 800-207A, A Zero Trust Architecture Model for Access Control in Cloud-Native Applications in Multi-Cloud Environments》，访问时间 2026-05-02：<https://csrc.nist.gov/pubs/sp/800/207/a/final>。

English: NIST, "SP 800-53 Rev. 5, Security and Privacy Controls for Information Systems and Organizations", accessed 2026-05-02: <https://csrc.nist.gov/Pubs/sp/800/53/r5/upd1/Final>.

中文：NIST，《SP 800-53 Rev. 5, Security and Privacy Controls for Information Systems and Organizations》，访问时间 2026-05-02：<https://csrc.nist.gov/Pubs/sp/800/53/r5/upd1/Final>。

English: NIST, "SP 800-146, Cloud Computing Synopsis and Recommendations", accessed 2026-05-02: <https://csrc.nist.gov/pubs/sp/800/146/final>.

中文：NIST，《SP 800-146, Cloud Computing Synopsis and Recommendations》，访问时间 2026-05-02：<https://csrc.nist.gov/pubs/sp/800/146/final>。

English: Model Context Protocol, "Specification 2025-11-25", accessed 2026-05-02: <https://modelcontextprotocol.io/specification/2025-11-25/basic> and <https://modelcontextprotocol.io/specification/2025-11-25/server/index>.

中文：Model Context Protocol，《Specification 2025-11-25》，访问时间 2026-05-02：<https://modelcontextprotocol.io/specification/2025-11-25/basic> 与 <https://modelcontextprotocol.io/specification/2025-11-25/server/index>。

English: Cloud Security Alliance, "Agentic AI Security: New Dynamics, Trusted Foundations", published 2025-12-18 and accessed 2026-05-02: <https://cloudsecurityalliance.org/blog/2025/12/18/agentic-ai-security-new-dynamics-trusted-foundations>.

中文：Cloud Security Alliance，《Agentic AI Security: New Dynamics, Trusted Foundations》，2025-12-18 发布，访问时间 2026-05-02：<https://cloudsecurityalliance.org/blog/2025/12/18/agentic-ai-security-new-dynamics-trusted-foundations>。
