# Safety 前沿吸收决策 / Safety Frontier Assimilation Decision

> Research date: 2026-05-02 in the Asia/Shanghai workspace. Linear record: [QUI-53](https://linear.app/quilin-agent/issue/QUI-53/f0safety-taxonomy-与动作级验证吸收决策-decide-safety-taxonomy-and-action-level). This document creates no new Linear issue because the follow-up work can be mapped to existing issues.
>
> 调研日期：工作区 Asia/Shanghai 时区 2026-05-02。Linear 记录：[QUI-53](https://linear.app/quilin-agent/issue/QUI-53/f0safety-taxonomy-与动作级验证吸收决策-decide-safety-taxonomy-and-action-level)。本文不创建新的 Linear issue，因为后续工作可以映射到既有 issue。

## 结论 / Decision

Quilin's Safety direction remains correct, but the frontier has moved from "guard dangerous tools" to "record, classify, gate, verify, and audit every consequential action." The minimum strongest shape is an action policy plane that combines OWASP（Open Worldwide Application Security Project，开放 Web 应用安全项目，提供安全风险分类）Agentic Applications 2026, local `WriteAuthority`（统一写权限门：所有 agent 发起写入动作进入工具前必须经过的执行 gate）, credential boundaries（凭证边界：限制密钥、令牌和身份上下文能被哪些工具使用）, post-tool verification（工具调用后验证：工具返回后检查结果是否符合目标、权限和风险预期）, and an audit trail（审计链：把分类、决策、执行和验证串成可追溯记录）.

Quilin 的 Safety 方向仍然正确，但前沿要求已经从“拦危险工具”升级为“对每个有后果的动作做记录、分类、拦截、验证和审计”。近期最强形态应是 action policy plane（动作策略平面）：把 OWASP（Open Worldwide Application Security Project，开放 Web 应用安全项目，提供安全风险分类）Agentic Applications 2026、现有 `WriteAuthority`（统一写权限门：所有 agent 发起写入动作进入工具前必须经过的执行 gate）、credential boundaries（凭证边界：限制密钥、令牌和身份上下文能被哪些工具使用）、post-tool verification（工具调用后验证：工具返回后检查结果是否符合目标、权限和风险预期）和 audit trail（审计链：把分类、决策、执行和验证串成可追溯记录）合并起来。

The concrete absorption decision is: QUI-53 owns the taxonomy and policy-record contract; QUI-64 implements the runtime hooks; QUI-72 keeps the executable regression baseline; QUI-19 keeps the broader safety architecture and XML（Extensible Markup Language，可用来包裹不同信任来源的结构化标记语言）isolation follow-up; QUI-52 owns sandbox, browser, shell, file, and MCP（Model Context Protocol，模型上下文协议，用于把模型连接到外部工具和数据源）tool semantics; QUI-56 owns skill manifest capability declarations and registry safety.

具体吸收决策是：QUI-53 负责分类体系和策略记录契约；QUI-64 实现 runtime hooks（运行时钩子）；QUI-72 保持可执行回归基线；QUI-19 保持更大的安全架构与 XML（Extensible Markup Language，可用来包裹不同信任来源的结构化标记语言）隔离后续项；QUI-52 负责 sandbox（沙箱）、browser（浏览器）、shell（命令行）、file（文件）和 MCP（Model Context Protocol，模型上下文协议，用于把模型连接到外部工具和数据源）工具语义；QUI-56 负责 skill manifest（技能清单）的能力声明和 registry（注册表）安全。

## 来源质量 / Source Quality

The primary taxonomy source is the OWASP Top 10 for Agentic Applications 2026, which describes a peer-reviewed operational framework for autonomous and agentic AI（artificial intelligence，人工智能）systems. It is the best spine for Quilin's safety labels because it covers goal hijack, tool misuse, identity abuse, code execution, memory/context poisoning, inter-agent communication, cascading failures, human-agent trust exploitation, and rogue agents. Source: [OWASP official resource](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/).

主要分类来源是 OWASP Top 10 for Agentic Applications 2026，它是面向自主式和智能体式 AI 系统的同行评审运营框架。它适合作为 Quilin 安全标签主轴，因为覆盖 goal hijack（目标劫持）、tool misuse（工具误用）、identity abuse（身份滥用）、code execution（代码执行）、memory/context poisoning（记忆/上下文投毒）、inter-agent communication（Agent 间通信）、cascading failures（级联故障）、human-agent trust exploitation（人类对 Agent 信任被利用）和 rogue agents（失控 Agent）。来源：[OWASP 官方资源](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)。

AgentHarm（有害 Agent 行为评测：测试 Agent 是否会完成恶意多步任务） remains the main multi-step misuse benchmark. AISI（AI Security Institute，英国 AI 安全研究机构） describes 110 malicious agent tasks, 440 augmented tasks, and 11 harm categories, with scoring that checks whether an attacked agent can still complete harmful multi-step work. Sources: [AISI research page](https://www.aisi.gov.uk/research/agentharm-a-benchmark-for-measuring-harmfulness-of-llm-agents), [arXiv paper](https://arxiv.org/abs/2410.09024), and [Hugging Face dataset card](https://huggingface.co/datasets/ai-safety-institute/AgentHarm).

AgentHarm（有害 Agent 行为评测：测试 Agent 是否会完成恶意多步任务）仍是多步误用的主要评测锚点。AISI（AI Security Institute，英国 AI 安全研究机构）说明该评测包含 110 个恶意 Agent 任务、440 个增强任务和 11 类危害，评分关注被攻击后的 Agent 是否仍能完成有害多步工作。来源：[AISI 研究页](https://www.aisi.gov.uk/research/agentharm-a-benchmark-for-measuring-harmfulness-of-llm-agents)、[arXiv 论文](https://arxiv.org/abs/2410.09024) 和 [Hugging Face 数据集卡](https://huggingface.co/datasets/ai-safety-institute/AgentHarm)。

AgentHazard（Agent 风险场景评测：测试电脑或图形界面 Agent 的有害执行轨迹） is the strongest current signal that local-looking steps can jointly become unsafe. The computer-use paper reports 2,653 instances across risk categories and attack strategies, while the mobile GUI（graphical user interface，图形界面）project shows third-party screen content misleading agents into destructive actions. Sources: [computer-use arXiv paper](https://arxiv.org/abs/2604.02947), [GitHub repository](https://github.com/Yunhao-Feng/AgentHazard), and [mobile GUI project page](https://agenthazard.github.io/).

AgentHazard（Agent 风险场景评测：测试电脑或图形界面 Agent 的有害执行轨迹）是当前最强信号之一，证明局部看似正常的步骤组合后可能变成不安全轨迹。电脑使用论文报告了 2,653 个跨风险类别和攻击策略的样例，移动 GUI 项目则展示第三方屏幕内容可诱导 Agent 执行破坏性动作。来源：[电脑使用 arXiv 论文](https://arxiv.org/abs/2604.02947)、[GitHub 仓库](https://github.com/Yunhao-Feng/AgentHazard) 和 [移动 GUI 项目页](https://agenthazard.github.io/)。

Owner-Harm（系统拥有者受害威胁模型：Agent 损害部署方、企业或用户资产的风险） should be added as a first-class local label, not hidden under generic harm. The paper reports that a defense strong on generic criminal harm can miss prompt-injection-mediated owner harm, and that adding deterministic post-audit verification improves detection. Source: [Owner-Harm arXiv paper](https://arxiv.org/abs/2604.18658).

Owner-Harm（系统拥有者受害威胁模型：Agent 损害部署方、企业或用户资产的风险）应作为 Quilin 的一级本地标签，而不是埋在通用危害下面。该论文指出，在通用犯罪危害上表现强的防御仍可能漏掉由 prompt injection（提示注入）触发的 owner harm；加入 deterministic post-audit verification（确定性事后审计验证）能提升检测。来源：[Owner-Harm arXiv 论文](https://arxiv.org/abs/2604.18658)。

OpenAI's agent guidance is useful because it converges on the same controls Quilin already started: structured outputs to constrain data flow, approvals for MCP tools, guardrails for user input, trace grading for tool calls, sandbox execution, and confirmations before consequential actions. Sources: [agent builder safety guide](https://platform.openai.com/docs/guides/agent-builder-safety), [prompt injection safety page](https://openai.com/safety/prompt-injections/), [prompt-injection design note](https://openai.com/index/designing-agents-to-resist-prompt-injection/), [Agents SDK（software development kit，软件开发工具包）tool guardrails](https://openai.github.io/openai-agents-python/ref/tool_guardrails/), and [Agents SDK sandbox update](https://openai.com/index/the-next-evolution-of-the-agents-sdk/).

OpenAI 的 Agent 指南有参考价值，因为它与 Quilin 已经开始的控制面收敛：structured outputs（结构化输出）约束数据流、MCP 工具审批、用户输入 guardrails（护栏）、tool call（工具调用）trace grading（轨迹评分）、沙箱执行，以及重要动作前确认。来源：[Agent Builder 安全指南](https://platform.openai.com/docs/guides/agent-builder-safety)、[提示注入安全页](https://openai.com/safety/prompt-injections/)、[提示注入设计说明](https://openai.com/index/designing-agents-to-resist-prompt-injection/)、[Agents SDK（software development kit，软件开发工具包）工具护栏](https://openai.github.io/openai-agents-python/ref/tool_guardrails/) 和 [Agents SDK 沙箱更新](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)。

Microsoft's indirect prompt injection guidance is useful as an architecture checklist, not as a vendor dependency. It explicitly recommends defense in depth, data marking, plan drift detection, critic agents, tool chain analysis, information flow control, least privilege, short-lived privileges, and human confirmation for risky actions. Source: [Microsoft Learn guidance](https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection).

Microsoft 的间接提示注入指南可作为架构检查表，而不是供应商依赖。它明确建议 defense in depth（纵深防御）、data marking（数据标记）、plan drift detection（计划漂移检测）、critic agents（评审 Agent）、tool chain analysis（工具链分析）、information flow control（信息流控制）、最小权限、短期凭证和高风险动作人工确认。来源：[Microsoft Learn 指南](https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection)。

The MCP authorization specification is the credential-boundary source for tool integrations. It recommends least-privilege scope selection and resource indicators so a token is bound to the intended MCP server resource. Source: [MCP authorization specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

MCP 授权规范是工具集成的凭证边界来源。它建议按最小权限选择 scope（权限范围），并使用 resource indicators（资源指示符）把 token（令牌）绑定到目标 MCP server（MCP 服务）。来源：[MCP 授权规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

OWASP Agentic Skills Top 10（智能体技能安全风险清单：关注 skill 作为行为层和供应链攻击面） is still a new proposal, so it should not override the core safety taxonomy. It should, however, feed QUI-56 because its project materials focus on provenance, over-privileged skills, weak isolation, registry scanning, universal skill metadata, and governance. Source: [OWASP Agentic Skills GitHub project](https://github.com/OWASP/www-project-agentic-skills-top-10).

OWASP Agentic Skills Top 10（智能体技能安全风险清单：关注 skill 作为行为层和供应链攻击面）仍是新 proposal（提案），不应覆盖核心安全分类。但它应输入 QUI-56，因为其项目资料聚焦 provenance（来源证明）、过度授权技能、弱隔离、registry scanning（注册表扫描）、通用技能元数据和治理。来源：[OWASP Agentic Skills GitHub 项目](https://github.com/OWASP/www-project-agentic-skills-top-10)。

## 与现有基线的关系 / Relation To Existing Baseline

`agentic-risk-baseline.md` already defines five minimum fixtures: tool misuse, multi-step harm, unsafe write attempts, data exfiltration, and permission bypass. This document does not replace those fixtures; it defines the runtime contract that makes those fixtures meaningful in QUI-64.

`agentic-risk-baseline.md` 已经定义五类最小 fixture（固定测试样例）：tool misuse（工具误用）、multi-step harm（多步危害）、unsafe write attempts（不安全写入尝试）、data exfiltration（数据外泄）和 permission bypass（权限绕过）。本文不替代这些 fixture；本文定义让 QUI-64 能真正执行这些 fixture 的 runtime contract（运行时契约）。

The baseline currently asks for classifier output and `WriteAuthority` decision records. The missing absorption layer is a durable action-level policy record that connects user intent, untrusted sources, credentials, tool request, pre-tool decision, post-tool verification, and final audit event.

当前基线要求分类器输出和 `WriteAuthority` 决策记录。缺失的吸收层是 durable action-level policy record（可持久化动作级策略记录）：把用户意图、不可信来源、凭证、工具请求、工具前决策、工具后验证和最终审计事件连接起来。

## 吸收项一：统一分类 / Absorption 1: Unified Taxonomy

Quilin should use OWASP Agentic Applications 2026 as the external taxonomy spine and add local execution labels that are directly enforceable by code. The external label explains why the risk matters; the local label decides what the runtime must do.

Quilin 应使用 OWASP Agentic Applications 2026 作为外部分类主轴，同时增加可由代码直接执行的本地执行标签。外部标签说明风险为什么重要；本地标签决定 runtime（运行时）必须做什么。

| Local label / 本地标签 | Meaning / 含义 | Main issue / 主 issue |
|---|---|---|
| `goal_hijack` | Untrusted input redirects the agent away from the user's intended goal. / 不可信输入把 Agent 从用户目标上带偏。 | QUI-53, QUI-64 |
| `tool_misuse` | A legitimate tool is used with unsafe timing, target, parameters, or side effects. / 合法工具因时机、目标、参数或副作用错误而变危险。 | QUI-53, QUI-52, QUI-64 |
| `credential_boundary` | A token, key, session, profile, or identity context is used outside its declared scope. / token、key、session、profile 或身份上下文超出声明范围。 | QUI-53, QUI-52, QUI-64 |
| `unsafe_write` | A file, shell, browser, skill, or sandbox action changes state without clear authorization. / 文件、命令行、浏览器、技能或沙箱动作在授权不清时改变状态。 | QUI-53, QUI-64 |
| `data_exfiltration` | Sensitive data flows from a private source to an external or untrusted sink. / 敏感数据从私有来源流向外部或不可信接收端。 | QUI-53, QUI-64 |
| `owner_harm` | The agent harms the deployer, workspace owner, or user assets even if the output is not generic criminal harm. / Agent 损害部署方、工作区拥有者或用户资产，即使输出不是通用犯罪危害。 | QUI-53, QUI-72 |
| `skill_supply_chain` | A skill package, metadata file, script, or registry item expands capability or hides behavior. / 技能包、元数据、脚本或注册表项扩大能力或隐藏行为。 | QUI-53, QUI-56 |
| `post_tool_drift` | Tool output or intermediate state moves the plan away from the original goal or permission boundary. / 工具输出或中间状态让计划偏离原目标或权限边界。 | QUI-53, QUI-64 |

These labels should be many-to-many with OWASP categories. For example, `credential_boundary` maps mostly to identity and privilege abuse, but can also support tool misuse, data exfiltration, or rogue agent detection when the credential is delegated to a subagent.

这些标签应与 OWASP 类别保持 many-to-many（多对多）关系。例如，`credential_boundary` 主要映射 identity and privilege abuse（身份与权限滥用），但当凭证被委托给 subagent（子 Agent）时，也可能支撑 tool misuse、data exfiltration 或 rogue agent detection（失控 Agent 检测）。

## 吸收项二：动作级策略记录 / Absorption 2: Action-Level Policy Record

Every consequential action should produce an action-level policy record before execution. Consequential action（有后果动作） means any action that writes files, executes shell commands, changes browser/app state, sends data externally, creates or updates skills, expands memory, delegates authority, or changes credentials.

每个 consequential action（有后果动作）都应在执行前产出 action-level policy record（动作级策略记录）。consequential action（有后果动作）指会写文件、执行命令行、改变浏览器或 app 状态、向外发送数据、创建或更新技能、扩展记忆、委托权限或改变凭证的动作。

```json
{
  "schemaVersion": 1,
  "actionId": "act_...",
  "traceId": "trace_...",
  "actor": {
    "type": "main_agent | subagent | skill | mcp_server | idle_evolution",
    "id": "stable actor id"
  },
  "intent": {
    "userGoalHash": "sha256...",
    "authorizedEffect": "read_only | local_write | shell_exec | browser_write | network_send | credential_use | skill_change"
  },
  "sourceTrust": [
    {
      "source": "user_input | external_context | tool_output | memory | peer_agent | skill_manifest",
      "trustedFor": "instruction | data | evidence | none"
    }
  ],
  "target": {
    "tool": "shell_exec | file_write | web_fetch | browser_action | skill_manage | mcp_tool | sandbox_task",
    "resource": "workspace path, network endpoint, MCP server resource id, browser profile, or skill id",
    "credentialScope": "none | scoped token id | browser profile id | mcp resource indicator"
  },
  "risk": {
    "localLabels": ["tool_misuse"],
    "owaspMappings": ["ASI02"],
    "riskLevel": "read | low | medium | high | critical",
    "ownerHarm": false
  },
  "decision": {
    "policy": "allow | confirm | block",
    "decider": "rule | model | write_authority | human",
    "reason": "short machine-readable reason"
  },
  "postToolVerificationRequired": true,
  "audit": {
    "redactionProfile": "none | secret_safe | pii_safe | secret_and_pii_safe",
    "evidenceRefs": ["trace event id"]
  }
}
```

上面的 JSON（JavaScript Object Notation，常用结构化数据格式）形状是 QUI-64 的最小契约，而不是最终存储格式。它的关键点是把 actor（动作发起者）、intent（用户授权意图）、sourceTrust（来源信任）、target（目标工具和资源）、risk（风险）、decision（决策）、postToolVerificationRequired（是否需要工具后验证）和 audit（审计信息）串起来。

`sourceTrust.trustedFor` is the critical field. External content, tool output, web pages, app UI text, and memory entries can be trusted as evidence or data, but they must not become new instructions unless the user explicitly authorizes that transition.

`sourceTrust.trustedFor` 是关键字段。外部内容、工具输出、网页、app 界面文本和记忆条目可以作为 evidence（证据）或 data（数据）被信任，但不能自动升级为新的 instruction（指令），除非用户明确授权这个转换。

## 吸收项三：三段式执行门 / Absorption 3: Three-Stage Execution Gate

The safety runtime should have three gates: pre-tool classification, execution authority, and post-tool verification. Pre-tool classification decides whether the action is aligned with the user's goal and source trust. Execution authority enforces objective write and credential policies. Post-tool verification checks whether the observed result stayed within intent and whether the next action should be downgraded, confirmed, or blocked.

安全 runtime 应有三道 gate（执行门）：pre-tool classification（工具前分类）、execution authority（执行权限裁决）和 post-tool verification（工具后验证）。工具前分类判断动作是否符合用户目标和来源信任；执行权限裁决执行客观写入与凭证策略；工具后验证检查实际结果是否仍在意图范围内，并决定下一步是否降级、确认或阻断。

`WriteAuthority` should remain the objective execution gate for writes. It should not be overloaded into a semantic classifier. Instead, the action-level classifier should create the policy record first, and `WriteAuthority` should append the final write decision and audit evidence.

`WriteAuthority` 应继续作为写入动作的客观执行 gate，而不应被塞成语义分类器。动作级分类器应先创建策略记录，`WriteAuthority` 再追加最终写入决策和审计证据。

Post-tool verification should be deterministic-first where possible. Owner-Harm evidence suggests that a post-audit verifier improves detection; for Quilin this means checking concrete invariants such as "no external sink received private source data", "no destructive browser or shell action occurred without confirmation", and "tool output did not introduce a new goal."

工具后验证应尽量 deterministic-first（确定性优先）。Owner-Harm 证据表明 post-audit verifier（事后审计验证器）能提升检测；对 Quilin 来说，这意味着检查具体不变式，例如“外部接收端没有收到私有来源数据”、“没有未经确认的破坏性浏览器或命令行动作”、“工具输出没有引入新目标”。

## 吸收项四：凭证边界 / Absorption 4: Credential Boundaries

Credential handling should be represented in the same policy record as tool use. The safety system should treat an API（application programming interface，应用程序接口）key, OAuth（Open Authorization，开放授权协议，用于授权第三方访问资源）token, browser profile, MCP session, SSH（Secure Shell，安全命令行协议）key, cookie, or local credential file as a scoped capability, not as ambient process state.

凭证处理应与工具调用写在同一条策略记录里。安全系统应把 API（application programming interface，应用程序接口）key（应用接口密钥）、OAuth（Open Authorization，开放授权协议，用于授权第三方访问资源）token、browser profile（浏览器配置档）、MCP session（MCP 会话）、SSH（Secure Shell，安全命令行协议）key（安全命令行密钥）、cookie（浏览器会话标识）或本地凭证文件视为 scoped capability（带范围的能力），而不是 ambient process state（进程天然继承状态）。

QUI-52 should ensure tool and sandbox execution never inherits broad environment credentials by default. QUI-53 should require the classifier to know whether a proposed action uses a credential, and QUI-64 should block or confirm any credential use outside the declared scope.

QUI-52 应确保工具和沙箱执行默认不继承宽泛环境凭证。QUI-53 应要求分类器知道拟执行动作是否使用凭证；QUI-64 应阻断或确认任何超出声明范围的凭证使用。

MCP tool calls should carry server identity and requested scope into the policy record. The MCP authorization spec's resource indicator requirement maps directly to `target.resource`; least-privilege scope selection maps to `target.credentialScope`.

MCP 工具调用应把 server identity（服务身份）和 requested scope（请求权限范围）写入策略记录。MCP 授权规范的 resource indicator（资源指示符）要求直接映射到 `target.resource`；最小权限 scope 选择映射到 `target.credentialScope`。

## 吸收项五：沙箱、文件、命令行与浏览器写入 / Absorption 5: Sandbox, File, Shell, And Browser Writes

Quilin should treat browser and computer-use actions as write-capable by default, even when they are expressed as clicks, typing, navigation, or form submission. A GUI（graphical user interface，图形界面）action can delete data, submit credentials, purchase items, change permissions, or expose private data.

Quilin 应默认把 browser（浏览器）和 computer-use（电脑使用）动作视作可写能力，即使它们表现为 click（点击）、typing（输入）、navigation（导航）或 form submission（表单提交）。GUI（graphical user interface，图形界面）动作可以删除数据、提交凭证、购买物品、改变权限或暴露私有数据。

The Tools substrate from QUI-52 should expose a normalized `effect` field for shell, file, sandbox, MCP, and browser actions. Safety should not infer write risk from tool name alone; it should inspect effect, target, credential, and source trust.

QUI-52 的 Tools 基座应为 shell、file、sandbox、MCP 和 browser 动作暴露统一 `effect` 字段。Safety 不应只从工具名推断写入风险；它应检查 effect（效果）、target（目标）、credential（凭证）和 source trust（来源信任）。

AgentHazard's core lesson is that a sequence can be dangerous even when each step looks locally plausible. Therefore QUI-64 should maintain a short rolling trajectory summary for the current task and include it in every high or critical policy record.

AgentHazard 的核心经验是：一个序列可能整体危险，即使每一步局部看起来合理。因此 QUI-64 应为当前任务维护短窗口 trajectory summary（轨迹摘要），并把它写入每条 high（高）或 critical（关键）策略记录。

## 吸收项六：技能安全 / Absorption 6: Skills Safety

Skills should be treated as policy-bearing packages. A skill that declares tools, file scopes, network domains, dependencies, or scripts should be parsed into capability declarations before activation, and those declarations should feed the same action-level classifier used by normal tool calls.

Skills（技能）应被视作 policy-bearing packages（携带策略的包）。任何声明工具、文件范围、网络域名、依赖或脚本的 skill，都应在激活前解析为 capability declarations（能力声明），并把这些声明输入普通工具调用使用的同一个动作级分类器。

QUI-56 should own provenance, manifest schema, registry scanning, and static skill checks. QUI-53 should own the risk taxonomy for skill actions, while QUI-64 should enforce runtime attempts to exceed declared capabilities.

QUI-56 应负责 provenance（来源证明）、manifest schema（清单结构）、registry scanning（注册表扫描）和静态技能检查。QUI-53 应负责技能动作的风险分类；QUI-64 应执行运行时检查，阻止技能超出声明能力。

## 最小实现顺序 / Minimum Implementation Order

First, QUI-53 should freeze the policy record schema and local label set in this document as the accepted decision. This avoids starting QUI-64 with a vague "classifier" that cannot be tested or audited.

第一步，QUI-53 应把本文的策略记录结构和本地标签集冻结为已接受决策。这样可以避免 QUI-64 从一个无法测试、无法审计的模糊“分类器”开始。

Second, QUI-64 should implement a lightweight in-process classifier interface that can return policy records from rules and deterministic checks first. Model-assisted classification can be added later, but the initial gate must work without a paid model call.

第二步，QUI-64 应实现轻量级进程内 classifier interface（分类器接口），优先由规则和确定性检查返回策略记录。模型辅助分类可以后续加入，但初始 gate 必须不依赖付费模型调用。

Third, QUI-64 should connect `WriteAuthority` to policy records. The invariant is that every write decision must point back to exactly one action policy record, and every high or critical policy record must have a final outcome.

第三步，QUI-64 应把 `WriteAuthority` 接入策略记录。不变式是：每个写入决策必须回指唯一一条动作策略记录；每条 high 或 critical 策略记录必须有最终 outcome（结果）。

Fourth, QUI-72 should convert the existing five baseline fixture classes into executable tests that assert both the policy record and the final `WriteAuthority` or tool decision. The tests should use sentinel values instead of real destructive commands, real credentials, or real exfiltration endpoints.

第四步，QUI-72 应把现有五类 baseline fixture 转成可执行测试，同时断言策略记录和最终 `WriteAuthority` 或工具决策。测试应使用 sentinel values（哨兵值），避免真实破坏性命令、真实凭证或真实外泄端点。

Fifth, QUI-52 and QUI-56 should feed richer metadata into the same interface: tool effect, sandbox id, browser profile id, MCP server URI（Uniform Resource Identifier，统一资源标识符）, declared skill capabilities, and provenance digest.

第五步，QUI-52 和 QUI-56 应向同一接口输入更丰富的 metadata（元数据）：工具效果、沙箱编号、浏览器配置档编号、MCP 服务 URI（Uniform Resource Identifier，统一资源标识符）、技能声明能力和来源摘要。

## Linear 映射 / Linear Mapping

QUI-53 owns this decision document and the accepted taxonomy. It should close only when the team accepts the local label set, the action-level policy record shape, and the implementation order above.

QUI-53 负责本文和已接受分类。只有团队接受本地标签集、动作级策略记录形状和上面的实现顺序后，QUI-53 才应关闭。

QUI-64 owns implementation: pre-tool classifier, policy records, `WriteAuthority` linkage, post-tool verification, and executable regression assertions.

QUI-64 负责实现：工具前分类器、策略记录、`WriteAuthority` 接线、工具后验证和可执行回归断言。

QUI-72 owns evidence fixtures. It should remain the safety regression baseline and should not expand into a broad benchmark effort before the runtime hooks exist.

QUI-72 负责证据 fixture。它应保持为安全回归基线，不应在运行时钩子存在前扩展成宽泛 benchmark（基准测试）工作。

QUI-19 owns the broader safety spec backlog: XML isolation, Layer 2（步骤级验证层：每次工具动作后检查目标推进、异常内容和权限边界）runtime, Layer 3（输出验证层：检查最终输出的敏感信息和格式）secret scrubbing, and Layer 4（元验证层：验证安全检查本身是否工作）meta-verification.

QUI-19 负责更大的安全 spec backlog：XML isolation（XML 隔离）、Layer 2（步骤级验证层：每次工具动作后检查目标推进、异常内容和权限边界）runtime、Layer 3（输出验证层：检查最终输出的敏感信息和格式）secret scrubbing（密钥清理）和 Layer 4（元验证层：验证安全检查本身是否工作）meta-verification。

QUI-52 owns the tool-side data needed by Safety: normalized effect, sandbox boundaries, browser write classification, MCP identity propagation, structured errors, and timeout/budget metadata.

QUI-52 负责 Safety 需要的工具侧数据：统一 effect、沙箱边界、浏览器写入分类、MCP 身份传播、结构化错误，以及 timeout/budget（超时/预算）元数据。

QUI-56 owns the skills-side data needed by Safety: manifest capabilities, provenance, dependency metadata, registry scanning, and enforcement when a skill attempts undeclared file, network, shell, browser, memory, or MCP actions.

QUI-56 负责 Safety 需要的技能侧数据：清单能力、来源证明、依赖元数据、注册表扫描，以及 skill 尝试未声明的文件、网络、命令行、浏览器、记忆或 MCP 动作时的执行检查。

## 非目标 / Non-Goals

This document does not start new benchmark work. Benchmark is frozen unless the user explicitly asks for it; Safety should use policy records, runtime hooks, and local safety fixtures for active validation.

本文不启动新的 benchmark 工作。除非用户明确要求，Benchmark 保持冻结；Safety 的活跃验证应使用策略记录、运行时钩子和本地安全 fixture。

This document does not require a new Linear issue. The free-plan issue cap makes comments and existing issue mappings the correct route unless a future implementation blocker needs independent ownership, status, or acceptance criteria.

本文不要求新建 Linear issue。由于免费版 issue 数量有限，除非未来实现 blocker（阻塞项）需要独立负责人、状态或验收标准，否则应使用 comment 和既有 issue 映射。

This document does not modify `agent-bridge.md`. Cross-agent collaboration protocol stays separate from component safety architecture.

本文不修改 `agent-bridge.md`。跨 Agent 协作协议与组件安全架构保持分离。

## 验收门槛 / Acceptance Gates

QUI-64 should not claim production readiness until a local test can prove three things: a high-risk action emits a policy record before execution, the final tool or `WriteAuthority` decision links to that record, and post-tool verification records whether the observed result stayed inside the user's intent and credential boundary.

在本地测试能证明三件事前，QUI-64 不应声称 production readiness（生产就绪）：高风险动作在执行前产出策略记录；最终工具或 `WriteAuthority` 决策能关联到该记录；工具后验证记录实际结果是否仍在用户意图和凭证边界内。

The first regression suite should include the existing five cases from `agentic-risk-baseline.md`, plus one browser/GUI state-change case and one skill capability-bypass case once QUI-52 and QUI-56 expose the needed metadata.

第一批回归套件应包含 `agentic-risk-baseline.md` 里的五个既有用例；等 QUI-52 和 QUI-56 暴露所需元数据后，再增加一个 browser/GUI 状态改变用例和一个 skill 能力绕过用例。

Audit records must be secret-safe by default. They should preserve identifiers, labels, hashes, target classes, and redacted evidence references, but must not store raw secrets, full private files, or unnecessary personal data.

审计记录默认必须 secret-safe（密钥安全）。它们应保留标识符、标签、哈希、目标类别和脱敏证据引用，但不得保存原始密钥、完整私有文件或不必要的个人数据。
