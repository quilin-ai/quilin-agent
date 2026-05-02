# Skills 前沿吸收决策 / Skills Frontier Assimilation Decisions

English: This note records the QUI-56 decision for Skills M2+ direction. It focuses on skill eval runner（技能评测运行器，用来证明 skill 是否真的带来任务收益）, manifest（技能包清单，用来声明包结构、依赖、权限和版本）, registry（注册表，用来发现和安装 skill）, provenance（来源记录，用来追踪 skill 从哪里来、由什么构建、是否被篡改）, and runtime safety integration. Benchmark suites（基准测试套件，用来衡量完整 Agent 能力）are intentionally not the first priority here; this document prepares the Skills component to become strong before global benchmarks are expanded.

中文：本文记录 QUI-56 对 Skills M2+ 方向的决策，重点是 skill eval runner（技能评测运行器，用来证明 skill 是否真的带来任务收益）、manifest（技能包清单，用来声明包结构、依赖、权限和版本）、registry（注册表，用来发现和安装 skill）、provenance（来源记录，用来追踪 skill 从哪里来、由什么构建、是否被篡改）和运行时安全集成。benchmark suites（基准测试套件，用来衡量完整 Agent 能力）不是这里的第一优先级；本文的目标是先把 Skills 组件补到足够强，再为后续全局 benchmark 做准备。

English: The decision is to keep Agent Skills compatibility as the default contract, then add Quilin-specific metadata only where compatibility fields are insufficient. Local skills should remain simple `SKILL.md` folders; published or plugin-delivered skills should gain stronger package metadata, lockfile entries, provenance records, eval reports, and runtime capability enforcement.

中文：本决策是：默认保持 Agent Skills 兼容，把 Quilin 特有元数据只放在兼容字段不足的地方。local skills（本地技能）仍然保持简单的 `SKILL.md` 文件夹；通过 registry（注册表）或 plugin（插件）交付的 skills 才增加更强的 package metadata（包元数据）、lockfile entries（锁文件记录）、provenance records（来源记录）、eval reports（评测报告）和 runtime capability enforcement（运行时能力约束）。

## 资料来源 / Sources

English: Primary sources reviewed include the Agent Skills specification and creator guidance, especially the progressive disclosure model, frontmatter constraints, client implementation guidance, description optimization, and skill evaluation loop: [specification](https://agentskills.io/specification), [adding skills support](https://agentskills.io/client-implementation/adding-skills-support), [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions), and [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills).

中文：已调研的一手资料包括 Agent Skills specification（Agent Skills 规范）和作者指南，尤其是 progressive disclosure（渐进披露）、frontmatter（文件头元数据）约束、客户端接入方式、description optimization（描述优化）和 skill evaluation loop（技能评测循环）：[规范](https://agentskills.io/specification)、[客户端接入](https://agentskills.io/client-implementation/adding-skills-support)、[描述优化](https://agentskills.io/skill-creation/optimizing-descriptions) 和 [技能评测](https://agentskills.io/skill-creation/evaluating-skills)。

English: Implementation examples and ecosystem signals came from Anthropic's public skills repository and official skill creator guidance, OpenClaw's skills, plugin manifest, ClawHub registry, and high-signal GitHub issues on skill security and discoverability: [anthropics/skills](https://github.com/anthropics/skills), [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md), [OpenClaw skills](https://docs.openclaw.ai/tools/skills), [OpenClaw plugin manifest](https://docs.openclaw.ai/plugins/manifest), [ClawHub](https://docs.openclaw.ai/tools/clawhub), [OpenClaw #10890](https://github.com/openclaw/openclaw/issues/10890), [OpenClaw #6276](https://github.com/openclaw/openclaw/issues/6276), [OpenClaw #10386](https://github.com/openclaw/openclaw/issues/10386), and [OpenClaw #39681](https://github.com/openclaw/openclaw/issues/39681).

中文：实现样例和生态信号来自 Anthropic 的公开 skills 仓库与官方 skill creator 指南、OpenClaw 的 skills、plugin manifest（插件清单）、ClawHub registry（ClawHub 注册表），以及关于 skill 安全和发现机制的高信号 GitHub issue：[anthropics/skills](https://github.com/anthropics/skills)、[skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)、[OpenClaw skills](https://docs.openclaw.ai/tools/skills)、[OpenClaw plugin manifest](https://docs.openclaw.ai/plugins/manifest)、[ClawHub](https://docs.openclaw.ai/tools/clawhub)、[OpenClaw #10890](https://github.com/openclaw/openclaw/issues/10890)、[OpenClaw #6276](https://github.com/openclaw/openclaw/issues/6276)、[OpenClaw #10386](https://github.com/openclaw/openclaw/issues/10386) 和 [OpenClaw #39681](https://github.com/openclaw/openclaw/issues/39681)。

English: Registry and provenance patterns came from the official Model Context Protocol Registry, npm package provenance, and SLSA provenance. These sources are relevant because skills will become installable third-party code-and-instruction bundles, not just local prompt snippets: [MCP Registry](https://modelcontextprotocol.io/registry/about), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [SLSA provenance](https://slsa.dev/spec/v1.2-rc2/build-provenance).

中文：registry（注册表）和 provenance（来源记录）模式来自官方 Model Context Protocol Registry（模型上下文协议注册表）、npm package provenance（npm 包来源记录）和 SLSA provenance（软件供应链来源记录）。这些来源相关，是因为 skills 会变成可安装的第三方代码与指令包，而不只是本地 prompt 片段：[MCP Registry](https://modelcontextprotocol.io/registry/about)、[npm provenance](https://docs.npmjs.com/generating-provenance-statements/) 和 [SLSA provenance](https://slsa.dev/spec/v1.2-rc2/build-provenance)。

English: Research signals came from recent papers on agent skill ecosystems, skill package registries, self-evolving skills, and malicious skill triage: [Agent Skills data-driven analysis](https://arxiv.org/abs/2602.08004), [Skilldex](https://arxiv.org/abs/2604.16911), [CoEvoSkills](https://arxiv.org/abs/2604.01687), and [SkillSieve](https://arxiv.org/abs/2604.06550). These papers are not implementation authorities, but they highlight ecosystem scale, redundancy, safety risk, eval design, and packaging gaps.

中文：研究信号来自近期关于 agent skill 生态、skill package registry（技能包注册表）、self-evolving skills（自进化技能）和 malicious skill triage（恶意技能分层筛查）的论文：[Agent Skills 数据驱动分析](https://arxiv.org/abs/2602.08004)、[Skilldex](https://arxiv.org/abs/2604.16911)、[CoEvoSkills](https://arxiv.org/abs/2604.01687) 和 [SkillSieve](https://arxiv.org/abs/2604.06550)。这些论文不是实现权威源，但它们指出了生态规模、重复建设、安全风险、评测设计和打包缺口。

## 决策一：格式兼容优先 / Decision 1: Format Compatibility First

English: Quilin should keep `SKILL.md` as the required entrypoint. The compatibility baseline is the Agent Skills format: a skill directory contains `SKILL.md`; the file has YAML frontmatter（YAML 文件头元数据，用来给机器读取 name、description 等字段）followed by Markdown instructions; optional `scripts/`, `references/`, and `assets/` are loaded only when needed. This preserves portability with Anthropic, Claude Code, OpenClaw, Hermes, and other clients that already read this format.

中文：Quilin 应继续把 `SKILL.md` 作为必需入口。兼容基线是 Agent Skills 格式：一个 skill 目录包含 `SKILL.md`；文件先是 YAML frontmatter（YAML 文件头元数据，用来给机器读取 name、description 等字段），再是 Markdown 指令；可选的 `scripts/`、`references/` 和 `assets/` 只在需要时按需加载。这可以保留与 Anthropic、Claude Code、OpenClaw、Hermes 以及其他已读取该格式客户端的可移植性。

English: The parser should accept the standard fields `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. Quilin may keep internal camelCase aliases, but write-back should preserve the original key spelling to avoid noisy diffs when users import community skills.

中文：parser（解析器）应接受标准字段 `name`、`description`、`license`、`compatibility`、`metadata` 和 `allowed-tools`。Quilin 可以在内部保留 camelCase aliases（驼峰字段别名），但写回文件时应保留原始键名，避免用户导入社区 skill 后产生无意义 diff。

English: Validation should be strict for safety-critical failures and lenient for cosmetic portability differences. Missing `description` is a load failure because the description drives disclosure and activation. A directory/name mismatch, long name, or recoverable YAML formatting issue should produce diagnostics and still load when it is safe to do so.

中文：validation（校验）应对安全关键失败保持严格，对不影响安全的兼容差异保持宽容。缺少 `description` 必须导致加载失败，因为 description 决定披露和激活。目录名与 `name` 不一致、名称偏长、可恢复的 YAML 格式问题，应输出诊断信息，并在安全时继续加载。

English: The main `SKILL.md` should remain a compact instruction surface, not a full manual. The practical target is under 500 lines and roughly 5,000 tokens, with large details moved to focused reference files and linked with explicit conditions such as "read this reference only when the API returns a non-200 response."

中文：主 `SKILL.md` 应保持为紧凑的指令面，而不是完整手册。实践目标是小于 500 行、约 5,000 tokens（模型上下文计量单位），较大的细节应移到聚焦的 reference files（参考文件）里，并用明确条件链接，例如“只有 API 返回非 200 状态时才读取该参考文件”。

## 决策二：Manifest 分两层 / Decision 2: Two-Layer Manifest

English: Quilin should not require a second manifest for local skills. For local and project skills, the `SKILL.md` frontmatter is the manifest. This keeps authoring simple and avoids diverging from the Agent Skills standard before the ecosystem stabilizes.

中文：Quilin 不应要求 local skills（本地技能）额外提供第二份 manifest（清单）。对于本地和项目内 skills，`SKILL.md` frontmatter 就是 manifest。这样可以保持作者体验简单，也避免在生态稳定前偏离 Agent Skills 标准。

English: Quilin-specific fields should live under `metadata.quilin`. This namespace should hold implementation fields that the open standard does not yet define: provenance pointers, dependency metadata, capability declarations, eval profile paths, trigger quality thresholds, and optional model routing hints.

中文：Quilin 特有字段应放在 `metadata.quilin` 下。这个 namespace（命名空间）用于承载开放标准尚未定义的实现字段：provenance pointers（来源记录指针）、dependency metadata（依赖元数据）、capability declarations（能力声明）、eval profile paths（评测配置路径）、trigger quality thresholds（触发质量阈值）和可选 model routing hints（模型路由提示）。

English: Published registry packages and plugin bundles may add an artifact-level package manifest, but that file describes distribution rather than skill behavior. It should include package name, version, source URI, source commit or tag, archive digest, registry namespace, supported agent versions, and links to provenance and eval reports. The runtime should not need that package manifest to run a manually authored local skill.

中文：发布到 registry（注册表）的 packages（包）和 plugin bundles（插件包）可以增加 artifact-level package manifest（产物级包清单），但该文件描述的是分发信息，而不是 skill 行为。它应包含包名、版本、来源 URI、来源 commit 或 tag、归档 digest（摘要哈希）、注册表 namespace（命名空间）、支持的 agent 版本，以及 provenance（来源记录）和 eval reports（评测报告）链接。runtime（运行时）不应为了运行手写本地 skill 而依赖这份包清单。

English: The recommended `metadata.quilin` shape for QUI-67 implementation is:

中文：建议 QUI-67 实现的 `metadata.quilin` 结构如下：

```yaml
metadata:
  quilin:
    schema: "https://quilin.ai/schemas/skill-metadata.v1.json"
    version: "1.0.0"
    source:
      kind: bundled | user | project | plugin | registry
      uri: "git+https://github.com/org/repo"
      ref: "refs/tags/v1.0.0"
      commit: "0123456789abcdef"
      digest: "sha256:..."
      provenance: "slsa-v1 | npm-provenance | none"
    dependencies:
      tools: ["skill_view"]
      mcpServers: []
      bins: ["git"]
      env: []
      packages: []
    capabilities:
      tools: ["read", "write"]
      fsRead: ["workspace/**"]
      fsWrite: ["workspace/docs/**"]
      network: []
      exec: []
      rationale:
        write: "Writes generated documentation into the workspace."
    evals:
      triggerSet: "evals/trigger.json"
      taskSet: "evals/evals.json"
      minTriggerPrecision: 0.85
      minTriggerRecall: 0.75
      minTaskPassDelta: 0.20
    model:
      preference: "fast-low-cost | default | high-reasoning"
      providerHint: "optional-provider-name"
```

English: The portable `allowed-tools` field should remain a hint, not the source of enforceable policy. Enforceable policy belongs in `metadata.quilin.capabilities`, the installed package lockfile, and the runtime safety layer because different clients interpret `allowed-tools` differently.

中文：可移植的 `allowed-tools` 字段应保留为 hint（提示），而不是 enforceable policy（可强制执行策略）的唯一来源。可强制执行策略应落在 `metadata.quilin.capabilities`、installed package lockfile（已安装包锁文件）和运行时安全层中，因为不同客户端对 `allowed-tools` 的解释不一致。

## 决策三：Registry 采用 metadata-only 模式 / Decision 3: Metadata-Only Registry

English: Quilin's registry should start as metadata-only. It should index skill metadata, source locations, versions, hashes, provenance links, eval report summaries, and compatibility constraints, while leaving code and archive hosting to package registries, Git repositories, or private artifact stores. This mirrors the MCP Registry pattern: the registry authenticates namespaces and publishes discoverable metadata, while underlying package registries and downstream marketplaces handle code scanning and richer curation.

中文：Quilin 的 registry（注册表）应从 metadata-only（只托管元数据）模式开始。它索引 skill metadata（技能元数据）、来源位置、版本、哈希、provenance links（来源记录链接）、eval report summaries（评测报告摘要）和兼容约束，但把代码和归档托管留给 package registries（包注册表）、Git 仓库或私有 artifact stores（产物存储）。这与 MCP Registry 的模式一致：registry 负责认证 namespace（命名空间）和发布可发现元数据，底层包注册表和下游 marketplace（市场）负责代码扫描与更丰富的策展。

English: Namespaces should be authenticated before publish. Acceptable namespace proofs include GitHub ownership, DNS ownership, or an internal organization namespace. A package named under a namespace must point back to a source URI controlled by the same owner, unless an explicit mirror policy says otherwise.

中文：发布前必须认证 namespace（命名空间）。可接受的 namespace proof（命名空间证明）包括 GitHub 所有权、DNS 所有权或内部组织命名空间。一个命名空间下的包必须指回同一 owner（所有者）控制的来源 URI，除非有明确 mirror policy（镜像策略）说明例外。

English: Installation should create a local lockfile entry. The entry should capture package name, version, registry URL, source URI, resolved commit or tag, archive digest, file digests, install time, trust tier, and eval/provenance report digests. Local changes should be detected by content hash before update; if the local copy differs from the recorded origin hash, updates must ask before overwriting.

中文：安装时应创建本地 lockfile entry（锁文件记录）。记录应包含包名、版本、registry URL、来源 URI、解析后的 commit 或 tag、归档 digest（摘要哈希）、文件 digest、安装时间、trust tier（信任等级）以及 eval/provenance report digests（评测/来源报告摘要）。更新前必须通过内容哈希检测本地改动；如果本地副本与记录的 origin hash（来源哈希）不同，覆盖前必须询问。

English: The registry should support private deployments later, but QUI-67 should implement the local lockfile and metadata contract first. A public registry without provenance, eval gates, and safety gates would create more risk than value.

中文：registry 后续可以支持 private deployments（私有部署），但 QUI-67 应先实现本地 lockfile 和元数据契约。如果没有 provenance（来源记录）、eval gates（评测门禁）和 safety gates（安全门禁），过早做公共 registry 会增加风险而不是价值。

## 决策四：Eval Runner 先服务组件质量 / Decision 4: Eval Runner Serves Component Quality First

English: The skills eval runner should have two lanes. The first lane is trigger-quality evaluation: given a skill description and a labeled set of realistic user prompts, measure trigger precision（触发精确率，触发时有多少是真的应该触发）, trigger recall（触发召回率，应该触发时有多少被触发）, false positives（误触发）, false negatives（漏触发）, and cost. The second lane is task-lift evaluation: run the same task with the skill and without the skill, or with the new skill and a previous version, then compare outputs, pass rates, time, and token cost.

中文：skills eval runner（技能评测运行器）应分两条 lane（评测通道）。第一条是 trigger-quality evaluation（触发质量评测）：给定 skill description（技能描述）和带标签的真实用户 prompt 集，测量 trigger precision（触发精确率，触发时有多少是真的应该触发）、trigger recall（触发召回率，应该触发时有多少被触发）、false positives（误触发）、false negatives（漏触发）和成本。第二条是 task-lift evaluation（任务收益评测）：同一个任务分别用 skill 和不用 skill 跑，或者用新版 skill 和旧版 skill 跑，再比较输出、通过率、耗时和 token cost（token 成本）。

English: Trigger eval sets should start small and realistic: about 20 prompts per skill, split between should-trigger cases and should-not-trigger near misses. Near misses matter because broad descriptions can look good on easy positives while causing expensive or harmful overtriggering in real work.

中文：trigger eval sets（触发评测集）应从小而真实开始：每个 skill 大约 20 条 prompt，分为 should-trigger（应该触发）和 should-not-trigger near misses（不该触发但很相似的近似负例）。near misses 很重要，因为过宽泛的 description 在简单正例上看起来不错，但真实工作中会导致昂贵或危险的过度触发。

English: Task evals should run in clean isolated sessions. Each case should record inputs, outputs, assertion results, human feedback, transcript references, token count, duration, and whether helper scripts were used. Mechanical assertions such as valid JSON, file existence, row counts, image dimensions, or schema conformance should be checked by scripts rather than only by an LLM judge（大语言模型裁判，用模型判断输出是否达标）.

中文：task evals（任务评测）应在干净隔离的 session（会话）中运行。每个 case（用例）应记录输入、输出、assertion results（断言结果）、human feedback（人工反馈）、transcript references（执行记录引用）、token count（token 数）、duration（耗时）以及是否使用 helper scripts（辅助脚本）。valid JSON（合法 JSON）、文件存在、行数、图片尺寸或 schema conformance（模式符合性）等机械断言应由脚本检查，而不是只交给 LLM judge（大语言模型裁判，用模型判断输出是否达标）。

English: Promotion gates should be explicit. A skill may be accepted as local draft with only format validation, but it should not become bundled, official, or registry-featured until it has a trigger-quality report, a task-lift report, a security scan result, and a provenance record when applicable.

中文：promotion gates（晋级门禁）必须明确。一个 skill 只通过格式校验即可作为 local draft（本地草稿）存在，但在成为 bundled（内置）、official（官方）或 registry-featured（注册表精选）之前，必须有 trigger-quality report（触发质量报告）、task-lift report（任务收益报告）、security scan result（安全扫描结果），以及在适用时提供 provenance record（来源记录）。

## 决策五：Provenance 必须可验证但不替代安全扫描 / Decision 5: Provenance Must Be Verifiable But Does Not Replace Scanning

English: Provenance should answer "where did this skill come from, what exact bytes were installed, and what process produced them?" It should not claim that a skill is safe. npm provenance is a useful model because it links a package to source and build instructions through signed attestations and a transparency log, while clearly stating that this does not prove absence of malicious code.

中文：provenance（来源记录）应回答“这个 skill 来自哪里、安装的具体字节是什么、由什么流程产生？”它不应声称 skill 一定安全。npm provenance 是有用参考，因为它通过 signed attestations（签名证明）和 transparency log（透明日志）把包与源码和构建指令关联起来，同时明确这不证明代码没有恶意内容。

English: The minimum provenance record for a registry skill should include source URI, resolved commit or tag, source digest, archive digest, file digests, publisher identity, publish workflow identity, build or packaging tool version, timestamp, and the eval/security report digests that were current at publication time.

中文：registry skill（注册表技能）的最小 provenance record（来源记录）应包含 source URI（来源地址）、解析后的 commit 或 tag、source digest（来源摘要）、archive digest（归档摘要）、file digests（文件摘要）、publisher identity（发布者身份）、publish workflow identity（发布流程身份）、build or packaging tool version（构建或打包工具版本）、timestamp（时间戳），以及发布时对应的 eval/security report digests（评测/安全报告摘要）。

English: SLSA provenance（Supply-chain Levels for Software Artifacts provenance，一种软件供应链来源记录规范）is the right conceptual model for builder identity, external parameters, resolved dependencies, and subjects. Quilin does not need full SLSA conformance in QUI-67, but the schema should preserve the same concepts so later attestation support does not require a breaking migration.

中文：SLSA provenance（Supply-chain Levels for Software Artifacts provenance，一种软件供应链来源记录规范）是 builder identity（构建者身份）、external parameters（外部参数）、resolved dependencies（已解析依赖）和 subjects（产物对象）的正确概念模型。QUI-67 不需要完整符合 SLSA，但 schema（模式）应保留相同概念，避免后续加入 attestation support（证明支持）时发生破坏性迁移。

## 决策六：能力声明接入 WriteAuthority / Decision 6: Capability Declarations Connect To WriteAuthority

English: Skill capabilities should express what a skill may do after activation, not only whether it can load. OpenClaw's capability and permission-manifest discussions identify the core gap: prerequisite checks such as binaries or environment variables answer "can this skill run?", but not "what actions can this skill perform safely?"

中文：skill capabilities（技能能力声明）应表达 skill 激活后可以做什么，而不只是它能不能加载。OpenClaw 的 capability（能力）和 permission-manifest（权限清单）讨论指出了核心缺口：binary（系统命令）或 environment variable（环境变量）等 prerequisite checks（前置条件检查）只能回答“这个 skill 能不能运行？”，不能回答“这个 skill 能安全执行哪些动作？”

English: `metadata.quilin.capabilities` should declare tool names, filesystem read/write scopes, network domains, executable allowlists, memory scopes, and a human-readable rationale. The runtime should combine this declaration with WriteAuthority（统一写权限门，用来集中审批所有 agent 写入动作）and the QUI-64 action-level safety classifier（动作级安全分类器，用来在工具调用前判定风险）.

中文：`metadata.quilin.capabilities` 应声明 tool names（工具名）、filesystem read/write scopes（文件系统读写范围）、network domains（网络域名）、executable allowlists（可执行命令白名单）、memory scopes（记忆访问范围）和 human-readable rationale（人可读理由）。runtime 应把这个声明与 WriteAuthority（统一写权限门，用来集中审批所有 agent 写入动作）以及 QUI-64 action-level safety classifier（动作级安全分类器，用来在工具调用前判定风险）结合起来。

English: During active skill execution, undeclared or denied actions should be blocked or escalated according to trust tier. The runtime should also log the skill name, declared capability, attempted action, decision, and evidence. This makes safety review possible without reading entire transcripts.

中文：skill 执行期间，未声明或被 deny（拒绝）的动作应按 trust tier（信任等级）阻止或升级确认。runtime 还应记录 skill name（技能名）、declared capability（已声明能力）、attempted action（尝试动作）、decision（决策）和 evidence（证据）。这样安全 review（审核）不需要读取完整 transcript（执行记录）也能进行。

English: Static scanning should be layered. A cheap scanner should check path escapes, prompt injection patterns, destructive commands, suspicious network exfiltration, oversized files, binary blobs, and obfuscation. Suspicious skills can then go to an LLM-assisted triage step with structured outputs. This follows the direction of SkillSieve-style hierarchical triage without making registry ingestion dependent on expensive model calls for every benign package.

中文：static scanning（静态扫描）应分层。低成本 scanner（扫描器）先检查 path escapes（路径逃逸）、prompt injection patterns（提示注入模式）、destructive commands（破坏性命令）、suspicious network exfiltration（可疑网络外传）、oversized files（超大文件）、binary blobs（二进制文件块）和 obfuscation（混淆）。可疑 skills 再进入 LLM-assisted triage（大语言模型辅助分诊）并输出结构化结果。这吸收了 SkillSieve-style hierarchical triage（SkillSieve 风格分层筛查）的方向，同时避免每个良性包都依赖昂贵模型调用。

## 决策七：模型路由是建议，不是包作者特权 / Decision 7: Model Routing Is A Recommendation, Not Author Privilege

English: Skills may declare a model preference for cost and latency reasons, but package authors should not be able to force an arbitrary provider or model. Resolution order should be user override first, workspace policy second, skill recommendation third, and current agent default last. This absorbs the useful idea from Hermes per-skill model switching while keeping control with the user and runtime.

中文：skills 可以为了成本和延迟声明 model preference（模型偏好），但包作者不能强制任意 provider（模型供应商）或 model（模型）。解析顺序应是 user override（用户覆盖）第一、workspace policy（工作区策略）第二、skill recommendation（技能建议）第三、当前 agent default（默认模型）最后。这样吸收了 Hermes per-skill model switching（按技能切换模型）的有效思路，同时把控制权留在用户和 runtime。

English: Skill eval reports should include model and provider information because trigger behavior, tool-use behavior, latency, and token cost are model-dependent. QUI-74 should provide the shared metric vocabulary for TTFT（Time To First Token，首 token 延迟）, token cost, prompt cache hit rate, and output quality so skill eval reports can compare cost and quality consistently.

中文：skill eval reports（技能评测报告）应包含 model（模型）和 provider（供应商）信息，因为触发行为、工具使用行为、延迟和 token cost（token 成本）都依赖模型。QUI-74 应提供共享指标词汇，包括 TTFT（Time To First Token，首 token 延迟）、token cost、prompt cache hit rate（提示缓存命中率）和 output quality（输出质量），这样 skill eval reports 才能一致比较成本和质量。

## 与 Linear 的映射 / Linear Mapping

English: QUI-56 owns this decision document and should close only after the package, registry, provenance, eval, and safety direction is accepted.

中文：QUI-56 负责本文决策，只有 package（包）、registry（注册表）、provenance（来源记录）、eval（评测）和 safety（安全）方向被接受后才应关闭。

English: QUI-67 should implement the first runtime version: standard-compatible parser, `metadata.quilin` schema, local lockfile, trigger eval runner, task-lift eval runner, provenance record writer, unsafe/oversized skill validation, and readable diagnostics.

中文：QUI-67 应实现第一版 runtime（运行时）：标准兼容 parser（解析器）、`metadata.quilin` schema（模式）、本地 lockfile（锁文件）、trigger eval runner（触发评测运行器）、task-lift eval runner（任务收益评测运行器）、provenance record writer（来源记录写入器）、不安全/超尺寸 skill 校验，以及可读诊断。

English: QUI-53 should absorb the safety taxonomy implications: skill capabilities need to map to action-level risk, prompt injection risk, tool misuse risk, data exfiltration risk, and post-tool verification records.

中文：QUI-53 应吸收 safety taxonomy（安全分类体系）影响：skill capabilities（技能能力）需要映射到 action-level risk（动作级风险）、prompt injection risk（提示注入风险）、tool misuse risk（工具误用风险）、data exfiltration risk（数据外传风险）和 post-tool verification records（工具调用后验证记录）。

English: QUI-64 should implement enforcement hooks: capability checks before tool calls, WriteAuthority escalation for risky writes, structured violation logs, and safety regression cases where a skill attempts undeclared filesystem, network, exec, or memory actions.

中文：QUI-64 应实现 enforcement hooks（执行钩子）：工具调用前 capability checks（能力检查）、危险写入经 WriteAuthority 升级确认、结构化 violation logs（违规日志），以及 skill 尝试未声明文件系统、网络、命令执行或记忆动作的安全回归用例。

English: QUI-52 should own the tool and MCP interaction surface: dedicated skill activation tool behavior, permission allowlisting for skill directories, resource listing without eager reads, sandbox routing for skill scripts, and MCP server identity propagation for skill-declared dependencies.

中文：QUI-52 应负责 tool（工具）和 MCP（Model Context Protocol，模型上下文协议）交互面：专用 skill activation tool（技能激活工具）行为、skill 目录 permission allowlisting（权限白名单）、列出资源但不 eager read（提前读取）、skill scripts（技能脚本）的 sandbox routing（沙箱路由），以及 skill 声明依赖的 MCP server identity propagation（MCP 服务身份传播）。

English: QUI-74 should own cost and model metrics used by skills: model routing vocabulary, prompt cache placement impact, TTFT, token cost, and output quality thresholds. Per-skill model preferences must be evaluated against those metrics rather than accepted as author claims.

中文：QUI-74 应负责 skills 使用的成本和模型指标：model routing vocabulary（模型路由词汇）、prompt cache placement impact（提示缓存放置影响）、TTFT（首 token 延迟）、token cost（token 成本）和 output quality thresholds（输出质量阈值）。per-skill model preferences（按技能模型偏好）必须用这些指标评估，而不是直接接受作者声明。

## QUI-67 最小验收 / Minimum Acceptance For QUI-67

English: A sample skill package should validate against the Agent Skills-compatible parser, include `metadata.quilin`, include a lockfile record after installation, and produce a trigger-quality report plus a task-lift report.

中文：一个 sample skill package（示例技能包）应能通过 Agent Skills 兼容 parser（解析器）校验，包含 `metadata.quilin`，安装后包含 lockfile record（锁文件记录），并产出 trigger-quality report（触发质量报告）和 task-lift report（任务收益报告）。

English: The eval runner should prove at least one meaningful task-lift delta against a no-skill baseline or previous-skill baseline. It should also show trigger precision, trigger recall, false positives, false negatives, token cost, duration, and model/provider metadata.

中文：eval runner（评测运行器）应至少证明一个相对 no-skill baseline（无技能基线）或 previous-skill baseline（旧版技能基线）的有效 task-lift delta（任务收益差值）。它还应展示 trigger precision（触发精确率）、trigger recall（触发召回率）、false positives（误触发）、false negatives（漏触发）、token cost（token 成本）、duration（耗时）和 model/provider metadata（模型/供应商元数据）。

English: Unsafe or oversized skills should fail validation with readable messages. At minimum, the failures should cover missing description, path escape, symlink escape, file too large, unparseable YAML, dangerous shell pattern, undeclared write scope, undeclared network domain, and provenance digest mismatch for installed packages.

中文：不安全或超尺寸 skills 应通过可读错误信息校验失败。最小失败场景应覆盖 missing description（缺少描述）、path escape（路径逃逸）、symlink escape（符号链接逃逸）、file too large（文件过大）、unparseable YAML（无法解析的 YAML）、dangerous shell pattern（危险 shell 模式）、undeclared write scope（未声明写入范围）、undeclared network domain（未声明网络域名）和已安装包的 provenance digest mismatch（来源摘要不匹配）。

English: Registry behavior can remain local-first in QUI-67. The required deliverable is the metadata and lockfile contract; a hosted public registry should wait until safety gates, provenance records, and eval reports are routine.

中文：QUI-67 中的 registry behavior（注册表行为）可以保持 local-first（本地优先）。必需交付物是 metadata（元数据）和 lockfile（锁文件）契约；hosted public registry（托管公共注册表）应等安全门禁、来源记录和评测报告成为常规流程后再推进。

## 当前不做 / Non-Goals For This Iteration

English: Do not create new Linear issues for every sub-task in this document. The workspace is on a 250-issue free plan, so QUI-56 and QUI-67 should carry design and implementation discussion unless a separate blocker needs its own ownership or status.

中文：不要为本文每个子任务都新建 Linear issue。当前 workspace 使用 250 issue 免费版，所以 QUI-56 和 QUI-67 应承载设计和实现讨论，除非出现需要独立负责人或状态的 blocker（阻塞项）。

English: Do not make benchmark suites the first implementation target. Skills quality should first be measured by component-level trigger quality, task lift, safety conformance, provenance completeness, and cost metrics. Global agent benchmarks can use these artifacts later.

中文：不要把 benchmark suites（基准测试套件）作为第一实现目标。Skills 质量应先用组件级 trigger quality（触发质量）、task lift（任务收益）、safety conformance（安全符合性）、provenance completeness（来源完整性）和 cost metrics（成本指标）衡量。全局 Agent benchmark 后续可以复用这些产物。

English: Do not let package authors bypass runtime authority. Metadata can recommend tools, models, dependencies, and capabilities, but WriteAuthority, workspace policy, user trust settings, and the action-level classifier remain authoritative.

中文：不要允许包作者绕过 runtime authority（运行时权限）。metadata（元数据）可以推荐 tools（工具）、models（模型）、dependencies（依赖）和 capabilities（能力），但 WriteAuthority、workspace policy（工作区策略）、user trust settings（用户信任设置）和 action-level classifier（动作级分类器）仍然是权威。
