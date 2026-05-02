# Skills 运行时实现规划 / Skills Runtime Implementation Plan

English: Linear record: `QUI-67`. This document turns the `QUI-56` Skills frontier decision into an implementation plan for the first runtime version. The goal is to implement a skill package manifest（技能包清单，用来声明技能包结构、权限、依赖、版本和评测入口）, trigger precision/recall（触发精确率/召回率，用来衡量技能是否在该出现时出现、不该出现时不出现）, eval runner（评测运行器，用来重复执行技能触发与任务收益检查）, provenance receipts（来源凭据，用来证明安装的技能来自哪里、具体字节是什么）, dependency metadata（依赖元数据，用来声明外部工具、包、服务和环境要求）, registry safety checks（注册表安全检查，用来在发布或安装前拦截危险技能）, size/path safety（大小与路径安全，用来防止超大文件和路径逃逸）, and readable validation errors（可读校验错误，用来让作者能修复问题）.

中文：Linear 记录：`QUI-67`。本文把 `QUI-56` 的 Skills 前沿决策转成第一版运行时实现规划。目标是实现 skill package manifest（技能包清单，用来声明技能包结构、权限、依赖、版本和评测入口）、trigger precision/recall（触发精确率/召回率，用来衡量技能是否在该出现时出现、不该出现时不出现）、eval runner（评测运行器，用来重复执行技能触发与任务收益检查）、provenance receipts（来源凭据，用来证明安装的技能来自哪里、具体字节是什么）、dependency metadata（依赖元数据，用来声明外部工具、包、服务和环境要求）、registry safety checks（注册表安全检查，用来在发布或安装前拦截危险技能）、size/path safety（大小与路径安全，用来防止超大文件和路径逃逸）和 readable validation errors（可读校验错误，用来让作者能修复问题）。

English: Benchmark（基准测试，用来衡量完整 Agent 系统表现） expansion is frozen unless the user explicitly asks for it. `QUI-67` should make Skills installable, inspectable, testable, and enforceable as a runtime component through local evidence.

中文：除非用户明确要求，benchmark（基准测试，用来衡量完整 Agent 系统表现）扩展保持冻结。`QUI-67` 应通过本地实证让 Skills 作为运行时组件变得可安装、可检查、可测试、可强制执行。

## 输入与边界 / Inputs And Boundaries

English: The primary input is `docs/13-skills/skills-frontier-assimilation.md`, which decides that Quilin should keep `SKILL.md` compatibility, place Quilin-specific fields under `metadata.quilin`, keep the registry metadata-only at first, and connect skill capabilities to `WriteAuthority`（统一写权限门，用来集中审批所有 agent 写入动作）plus action-level safety checks.

中文：主要输入是 `docs/13-skills/skills-frontier-assimilation.md`，它已决定 Quilin 应保持 `SKILL.md` 兼容，把 Quilin 特有字段放在 `metadata.quilin` 下，第一版 registry（注册表）保持 metadata-only（只托管元数据），并把技能能力接入 `WriteAuthority`（统一写权限门，用来集中审批所有 agent 写入动作）与动作级安全检查。

English: Supporting inputs are `QUI-64` for action-level verification（动作级验证，用来在工具调用前后记录、拦截和审计风险动作）and `QUI-52` for tool metadata（工具元数据，用来描述工具效果、目标资源、预算、结构化错误和审计引用）. `QUI-67` should not duplicate those implementations; it should emit the skill-side records that those layers can consume.

中文：辅助输入是 `QUI-64` 的 action-level verification（动作级验证，用来在工具调用前后记录、拦截和审计风险动作）和 `QUI-52` 的 tool metadata（工具元数据，用来描述工具效果、目标资源、预算、结构化错误和审计引用）。`QUI-67` 不应重复实现这些层，而应产出这些层可消费的技能侧记录。

English: This plan does not create new Linear issues because the workspace uses a 250-issue free plan. Follow-up work should stay on `QUI-67`, `QUI-56`, `QUI-64`, and `QUI-52` unless a separate blocker needs independent ownership or status.

中文：本文不新建 Linear issue，因为当前 workspace 使用 250 issue 免费版。后续工作应继续复用 `QUI-67`、`QUI-56`、`QUI-64` 和 `QUI-52`，除非出现需要独立负责人或状态的阻塞项。

## 运行时路径 / Runtime Path

English: The first runtime path is `discover skill directory -> parse SKILL.md -> normalize manifest -> validate package -> write install lockfile -> write provenance receipt -> run trigger eval -> run task-lift eval -> expose skill to runtime with capability policy`.

中文：第一版运行时路径是：`发现技能目录 -> 解析 SKILL.md -> 归一化清单 -> 校验技能包 -> 写入安装锁文件 -> 写入来源凭据 -> 运行触发评测 -> 运行任务收益评测 -> 带能力策略暴露给运行时`。

English: Local skills can load after format and safety validation, but bundled, official, plugin-delivered, or registry-installed skills require stronger evidence: a normalized manifest, a lockfile entry, a provenance receipt when source data exists, dependency metadata, a trigger-quality report, and readable diagnostics for all warnings and failures.

中文：本地技能通过格式与安全校验后即可加载，但内置、官方、插件交付或注册表安装的技能需要更强证据：归一化清单、锁文件记录、存在来源信息时的来源凭据、依赖元数据、触发质量报告，以及所有警告和失败的可读诊断。

English: All validation should be deterministic-first（确定性优先：先用规则、结构化字段和不变式检查，避免依赖付费模型调用）. Model-assisted review can be added later for suspicious packages, but the first acceptance gate must run locally and repeatably.

中文：所有校验应 deterministic-first（确定性优先：先用规则、结构化字段和不变式检查，避免依赖付费模型调用）。后续可以为可疑包加入模型辅助审核，但第一道验收门必须能在本地可重复运行。

## 技能包清单 / Skill Package Manifest

English: `SKILL.md` remains the behavior manifest for local and project skills. It must contain YAML（YAML Ain't Markup Language，一种人可读配置格式，用来写机器可解析元数据）frontmatter with at least `name` and `description`, followed by Markdown（轻量标记文本格式，用来写技能说明）instructions.

中文：`SKILL.md` 继续作为本地和项目内技能的行为清单。它必须包含 YAML（YAML Ain't Markup Language，一种人可读配置格式，用来写机器可解析元数据）文件头，至少包含 `name` 和 `description`，后面跟 Markdown（轻量标记文本格式，用来写技能说明）指令正文。

English: Quilin-specific runtime fields live under `metadata.quilin`. This namespace avoids breaking Agent Skills compatibility while still giving Quilin enough structured information to enforce permissions, measure quality, and track provenance.

中文：Quilin 特有运行时字段放在 `metadata.quilin` 下。这个命名空间避免破坏 Agent Skills 兼容性，同时给 Quilin 足够的结构化信息来执行权限、衡量质量和追踪来源。

English: In the schema below, `mcpServers` means MCP servers（Model Context Protocol servers，模型上下文协议服务，用来把模型连接到外部工具和数据源）, `exec` means executable command permission（命令执行权限，用来控制技能能否启动本地程序）, and `sha256` means SHA-256 digest（Secure Hash Algorithm 256-bit，一种文件摘要算法，用来检查内容是否被篡改）.

中文：在下面的 schema 中，`mcpServers` 指 MCP servers（Model Context Protocol servers，模型上下文协议服务，用来把模型连接到外部工具和数据源），`exec` 指 executable command permission（命令执行权限，用来控制技能能否启动本地程序），`sha256` 指 SHA-256 digest（Secure Hash Algorithm 256-bit，一种文件摘要算法，用来检查内容是否被篡改）。

```yaml
name: docs-writer
description: Create and update bilingual project documentation.
license: MIT
allowed-tools:
  - file_read
  - file_write
metadata:
  quilin:
    schemaVersion: 1
    package:
      id: "quilin/docs-writer"
      version: "1.0.0"
      kind: "local | project | bundled | plugin | registry"
      compatibility:
        quilin: ">=0.1.0"
        agentSkills: ">=0.1.0"
    capabilities:
      tools:
        - file_read
        - file_write
      fsRead:
        - "docs/**"
      fsWrite:
        - "docs/**"
      network: []
      exec: []
      memory: []
      rationale: "Reads and writes project documentation only."
    dependencies:
      bins: []
      packages: []
      mcpServers: []
      env: []
      files:
        maxSkillBytes: 500000
        maxFileBytes: 100000
    evals:
      triggerSet: "evals/trigger.json"
      taskSet: "evals/tasks.json"
      minTriggerPrecision: 0.85
      minTriggerRecall: 0.75
      minTaskPassDelta: 0.20
    provenance:
      receipt: "provenance/receipt.json"
      digestAlgorithm: "sha256"
```

English: A registry or plugin package may also contain `quilin.skill-package.json`. That artifact-level file describes distribution: package identifier, version, source URI（Uniform Resource Identifier，统一资源标识符，用来定位源码或包）, resolved commit, archive digest, registry namespace, publisher identity, supported agent versions, and links to eval and provenance files.

中文：注册表或插件包也可以包含 `quilin.skill-package.json`。这份产物级文件描述分发信息：包标识、版本、source URI（Uniform Resource Identifier，统一资源标识符，用来定位源码或包）、解析后的 commit、归档摘要、注册表命名空间、发布者身份、支持的 Agent 版本，以及评测与来源文件链接。

English: The runtime should not require `quilin.skill-package.json` for a manually authored local skill. The normalized internal manifest should be produced from `SKILL.md` alone when package metadata is absent.

中文：运行时不应要求手写本地技能提供 `quilin.skill-package.json`。当包元数据缺失时，应只根据 `SKILL.md` 生成归一化内部清单。

## 依赖元数据 / Dependency Metadata

English: Dependency metadata declares what a skill needs before activation. It is not an approval to use those resources; approval still comes from workspace policy, `WriteAuthority`, and the action-level classifier from `QUI-64`.

中文：依赖元数据声明技能激活前需要什么。它不是使用这些资源的授权；授权仍来自工作区策略、`WriteAuthority` 和 `QUI-64` 的动作级分类器。

English: Dependencies should use explicit categories: `bins` for command-line binaries（命令行程序，用来执行本地命令）, `packages` for language packages, `mcpServers` for MCP（Model Context Protocol，模型上下文协议，用来把模型连接到外部工具和数据源）servers, `env` for environment variables, `files` for bundled file limits, and `services` for optional network services.

中文：依赖应使用显式类别：`bins` 表示 command-line binaries（命令行程序，用来执行本地命令），`packages` 表示语言包，`mcpServers` 表示 MCP（Model Context Protocol，模型上下文协议，用来把模型连接到外部工具和数据源）服务，`env` 表示环境变量，`files` 表示内置文件限制，`services` 表示可选网络服务。

```ts
export interface SkillDependencyMetadata {
  readonly bins: readonly {
    readonly name: string;
    readonly versionCommand?: readonly string[];
    readonly required: boolean;
    readonly purpose: string;
  }[];
  readonly packages: readonly {
    readonly ecosystem: "npm" | "pypi" | "cargo" | "other";
    readonly name: string;
    readonly versionRange?: string;
    readonly required: boolean;
    readonly purpose: string;
  }[];
  readonly mcpServers: readonly {
    readonly name: string;
    readonly transport: "stdio" | "http";
    readonly requiredTools: readonly string[];
    readonly purpose: string;
  }[];
  readonly env: readonly {
    readonly name: string;
    readonly secret: boolean;
    readonly required: boolean;
    readonly purpose: string;
  }[];
}
```

English: Validation should distinguish missing optional dependencies from missing required dependencies. Optional dependency failures are warnings with disabled feature flags; required dependency failures block activation with a specific repair message.

中文：校验应区分缺少可选依赖和缺少必需依赖。可选依赖失败是警告，并关闭对应功能；必需依赖失败会阻止激活，并输出具体修复信息。

## 来源凭据 / Provenance Receipts

English: A provenance receipt records where the installed skill came from, what exact bytes were installed, and which process produced or installed them. It proves traceability, not safety.

中文：来源凭据记录已安装技能来自哪里、安装的具体字节是什么、由什么流程产出或安装。它证明可追溯性，不证明安全性。

English: The receipt should preserve concepts from SLSA（Supply-chain Levels for Software Artifacts，软件供应链来源记录框架，用来描述构建者、输入和产物）without requiring full external attestation in the first version.

中文：来源凭据应保留 SLSA（Supply-chain Levels for Software Artifacts，软件供应链来源记录框架，用来描述构建者、输入和产物）的概念，但第一版不要求完整外部证明。

```json
{
  "schemaVersion": 1,
  "skillId": "quilin/docs-writer",
  "version": "1.0.0",
  "source": {
    "kind": "local",
    "uri": "file:skills/docs-writer",
    "ref": null,
    "commit": null
  },
  "subject": {
    "rootDigest": "sha256:example",
    "files": [
      {
        "path": "SKILL.md",
        "digest": "sha256:example"
      }
    ]
  },
  "builder": {
    "name": "quilin-skill-installer",
    "version": "0.1.0"
  },
  "installedAt": "2026-05-02T00:00:00Z",
  "reports": {
    "triggerQualityDigest": "sha256:example",
    "taskLiftDigest": "sha256:example",
    "safetyScanDigest": "sha256:example"
  }
}
```

English: A lockfile entry should store the receipt digest, the normalized manifest digest, eval report digests, install path, trust tier（信任等级，用来表达安装来源和用户授权强度）, and local modification status. If installed bytes no longer match the lockfile, update must ask before overwriting.

中文：锁文件记录应保存来源凭据摘要、归一化清单摘要、评测报告摘要、安装路径、trust tier（信任等级，用来表达安装来源和用户授权强度）和本地修改状态。如果已安装字节不再匹配锁文件，更新前必须询问用户。

## 注册表安全检查 / Registry Safety Checks

English: Registry safety checks run at publish time and install time. The registry can stay metadata-only, but it should reject packages whose metadata cannot prove namespace ownership, source control, file integrity, and minimum eval evidence.

中文：注册表安全检查在发布和安装时运行。注册表可以保持 metadata-only（只托管元数据），但应拒绝无法证明命名空间所有权、来源控制、文件完整性和最低评测证据的包。

English: The first check set is namespace ownership, source URI ownership, archive digest match, file digest match, declared license presence, dependency metadata completeness, provenance receipt validity, and eval report presence for non-local packages.

中文：第一组检查包括命名空间所有权、source URI 所有权、归档摘要匹配、文件摘要匹配、许可证声明存在、依赖元数据完整、来源凭据有效，以及非本地包具备评测报告。

English: The second check set is safety scanning: path escape, symlink escape（符号链接逃逸，用软链接越过允许目录边界）, oversized file, binary blob, suspicious shell pattern, prompt injection pattern, undeclared write scope, undeclared network domain, and undeclared executable.

中文：第二组检查是安全扫描：路径逃逸、symlink escape（符号链接逃逸，用软链接越过允许目录边界）、超大文件、二进制文件块、可疑 shell 模式、提示注入模式、未声明写入范围、未声明网络域名和未声明可执行程序。

English: Suspicious findings should not silently downgrade to warnings for registry packages. The install result should be `allow`, `allow_with_warning`, `needs_review`, or `block`, and every non-allow result must include readable evidence and a suggested repair.

中文：对注册表包，可疑发现不应静默降级成警告。安装结果应是 `allow`、`allow_with_warning`、`needs_review` 或 `block`，每个非 allow 结果都必须包含可读证据和建议修复方式。

## 大小与路径安全 / Size And Path Safety

English: Size safety prevents skills from becoming hidden context bombs. The default package limits should include maximum total skill bytes, maximum `SKILL.md` bytes, maximum single reference file bytes, maximum file count, and maximum asset bytes.

中文：大小安全防止技能变成隐藏的上下文炸弹。默认包限制应包括最大技能总字节数、最大 `SKILL.md` 字节数、最大单个参考文件字节数、最大文件数量和最大资源文件字节数。

English: Path safety must normalize every file path before validation. The runtime should reject absolute paths, `..` traversal, symlink targets outside the skill root, hidden credential files, nested package managers that write outside the skill root, and references that point outside the declared package.

中文：路径安全必须在校验前归一化每个文件路径。运行时应拒绝绝对路径、`..` 遍历、指向技能根目录外的符号链接、隐藏凭证文件、会写出技能根目录的嵌套包管理器，以及指向声明包外部的引用。

English: The same path checker should be used by manifest loading, registry scanning, eval fixture loading, helper script execution, and provenance file digesting. One checker avoids different layers disagreeing about whether a path is safe.

中文：清单加载、注册表扫描、评测样例加载、辅助脚本执行和来源文件摘要计算都应使用同一个路径检查器。一个统一检查器可以避免不同层对同一路径是否安全产生分歧。

## 触发质量评测 / Trigger Quality Evaluation

English: Trigger precision measures how many activated cases were correct. Trigger recall measures how many cases that should have activated did activate. Both are required because a vague description can get high recall by activating too often, while an overly narrow description can get high precision by missing useful cases.

中文：触发精确率衡量已触发案例中有多少是正确触发。触发召回率衡量应该触发的案例中有多少真的触发。两者都必须有，因为模糊描述可以靠过度触发获得高召回率，过窄描述可以靠漏掉有用案例获得高精确率。

English: Each trigger eval set should include positive prompts（正例提示，应该触发技能的用户请求）, negative prompts（负例提示，不应该触发技能的用户请求）, and near-miss prompts（近似负例，表面相似但不应触发的请求）. The near-miss split is mandatory because it catches broad, expensive, and unsafe descriptions.

中文：每个触发评测集应包含 positive prompts（正例提示，应该触发技能的用户请求）、negative prompts（负例提示，不应该触发技能的用户请求）和 near-miss prompts（近似负例，表面相似但不应触发的请求）。近似负例必须存在，因为它能抓住过宽、昂贵或不安全的描述。

```json
{
  "schemaVersion": 1,
  "skillId": "quilin/docs-writer",
  "cases": [
    {
      "id": "docs-positive-001",
      "prompt": "Update this component README in bilingual format.",
      "expected": "trigger",
      "category": "positive"
    },
    {
      "id": "docs-near-miss-001",
      "prompt": "Explain what this README says without editing files.",
      "expected": "do_not_trigger",
      "category": "near_miss"
    }
  ]
}
```

English: The trigger report should store model/provider metadata, prompt count, true positives, false positives, true negatives, false negatives, precision, recall, cost, latency, and the selected threshold. If the report is generated with a model-dependent router, it must record that router version.

中文：触发报告应记录模型/供应商元数据、提示数量、真阳性、假阳性、真阴性、假阴性、精确率、召回率、成本、延迟和所选阈值。如果报告由依赖模型的路由器生成，必须记录该路由器版本。

## 评测运行器 / Eval Runner

English: The eval runner has two lanes: trigger-quality evaluation and task-lift evaluation（任务收益评测，用来比较启用技能前后的成功率、质量、成本和耗时）. Trigger quality answers "should this skill activate?" Task lift answers "does this skill make the task better after activation?"

中文：评测运行器有两条通道：触发质量评测和 task-lift evaluation（任务收益评测，用来比较启用技能前后的成功率、质量、成本和耗时）。触发质量回答“这个技能是否应该被激活？”任务收益回答“技能激活后是否真的让任务变好？”

English: Task-lift cases should compare a baseline run against a skill-enabled run. The baseline may be no-skill, previous skill version, or current skill with a disabled reference file. Each case should define deterministic assertions before any model-assisted judgment is allowed.

中文：任务收益案例应比较基线运行和启用技能运行。基线可以是无技能、旧版技能，或禁用某个参考文件的当前技能。每个案例都应先定义确定性断言，再允许模型辅助判断。

```ts
export interface SkillEvalCase {
  readonly id: string;
  readonly skillId: string;
  readonly input: string;
  readonly baseline: "no_skill" | "previous_version" | "ablation";
  readonly assertions: readonly {
    readonly kind: "file_exists" | "json_schema" | "contains_text" | "command_exit" | "custom";
    readonly target: string;
    readonly expected: string;
  }[];
  readonly budgets: {
    readonly maxTokens: number;
    readonly maxWallClockMs: number;
    readonly maxOutputBytes: number;
  };
}
```

English: Eval execution should happen in an isolated workspace. Helper scripts may run only through the Tools/Sandbox layer owned by `QUI-52`, so skill tests do not receive broader filesystem or shell authority than the skill itself declares.

中文：评测执行应发生在隔离工作区里。辅助脚本只能通过 `QUI-52` 负责的 Tools/Sandbox 层运行，这样技能测试不会获得比技能本身声明更宽的文件系统或命令权限。

English: The report should include pass rate, task-lift delta, assertion details, token cost, wall-clock duration, model/provider metadata, tool calls, safety decisions, and links to provenance receipts. A report without safety and provenance references is useful for local drafting but not enough for registry promotion.

中文：报告应包含通过率、任务收益差值、断言细节、token 成本、总耗时、模型/供应商元数据、工具调用、安全决策，以及来源凭据链接。缺少安全和来源引用的报告可用于本地草稿，但不足以让技能晋级到注册表。

## 可读校验错误 / Readable Validation Errors

English: Validation errors should be structured for machines and written clearly for authors. Each error should include code, severity, location, message, evidence, and fix suggestion.

中文：校验错误应同时便于机器处理和作者阅读。每个错误应包含代码、严重级别、位置、信息、证据和修复建议。

```ts
export interface SkillValidationDiagnostic {
  readonly code:
    | "missing_description"
    | "invalid_yaml"
    | "path_escape"
    | "symlink_escape"
    | "file_too_large"
    | "package_too_large"
    | "undeclared_dependency"
    | "undeclared_write_scope"
    | "undeclared_network_domain"
    | "dangerous_shell_pattern"
    | "provenance_digest_mismatch"
    | "trigger_quality_below_threshold";
  readonly severity: "warning" | "error" | "blocker";
  readonly location: {
    readonly file: string;
    readonly line?: number;
    readonly field?: string;
  };
  readonly message: string;
  readonly evidence: string;
  readonly suggestion: string;
}
```

English: Example author-facing message: `blocker path_escape at references/../../.env: this file resolves outside the skill directory. Move the reference under the skill folder or remove it from metadata.quilin.dependencies.files.`

中文：作者可读信息示例：`blocker path_escape at references/../../.env: this file resolves outside the skill directory. Move the reference under the skill folder or remove it from metadata.quilin.dependencies.files.` 这类信息必须指出哪里错、为什么被拦截，以及作者应如何修复。

English: Errors should never expose raw secrets. If a validator detects a secret-like value, the diagnostic should include only a redacted hash or short evidence label.

中文：错误信息不得泄露原始密钥。如果校验器发现疑似密钥，只能在诊断里包含脱敏哈希或简短证据标签。

## 安全接线 / Safety Wiring

English: `QUI-67` emits skill-side capability declarations and validation diagnostics. `QUI-64` consumes those records to create action-level policy records before tool execution. `QUI-52` consumes them to route tool calls through the correct sandbox, browser, MCP server, timeout, and structured error contract.

中文：`QUI-67` 产出技能侧能力声明和校验诊断。`QUI-64` 消费这些记录，在工具执行前创建动作级策略记录。`QUI-52` 消费这些记录，把工具调用路由到正确的沙箱、浏览器、MCP 服务、超时和结构化错误契约。

English: A skill attempting an undeclared file write, network send, command execution, browser state change, memory write, or MCP tool call should be blocked or escalated before execution. The decision must include the skill id, declared capability, attempted action, policy outcome, and audit reference.

中文：技能尝试未声明的文件写入、网络发送、命令执行、浏览器状态改变、记忆写入或 MCP 工具调用时，必须在执行前被阻断或升级确认。决策必须包含技能标识、已声明能力、尝试动作、策略结果和审计引用。

English: The portable `allowed-tools` field is treated as a compatibility hint. Enforceable authority comes from `metadata.quilin.capabilities`, the install lockfile, workspace policy, and `WriteAuthority`.

中文：可移植的 `allowed-tools` 字段只作为兼容性提示。可强制执行权限来自 `metadata.quilin.capabilities`、安装锁文件、工作区策略和 `WriteAuthority`。

## 最小交付顺序 / Minimum Delivery Order

English: First, implement the parser and normalizer: read `SKILL.md`, preserve original frontmatter spelling, normalize `metadata.quilin`, and emit a typed manifest plus diagnostics.

中文：第一步，实现解析器与归一化器：读取 `SKILL.md`，保留原始文件头拼写，归一化 `metadata.quilin`，并输出类型化清单和诊断。

English: Second, implement size/path validation and dependency metadata validation. This should include path normalization, symlink checks, max-size checks, required dependency checks, and safe warnings for optional dependencies.

中文：第二步，实现大小/路径校验和依赖元数据校验。这里应包括路径归一化、符号链接检查、最大尺寸检查、必需依赖检查，以及可选依赖的安全警告。

English: Third, implement lockfile and provenance receipt writing. The first storage format can be local JSON（JavaScript Object Notation，一种结构化数据格式，用来让工具稳定读写记录）files as long as the schema is stable and digest-based.

中文：第三步，实现锁文件和来源凭据写入。第一版存储格式可以是本地 JSON（JavaScript Object Notation，一种结构化数据格式，用来让工具稳定读写记录）文件，只要 schema 稳定并基于摘要校验。

English: Fourth, implement the trigger eval runner and report writer. Start with small labeled prompt sets and deterministic metrics, then store report digests in the lockfile.

中文：第四步，实现触发评测运行器和报告写入器。先从小型带标签提示集和确定性指标开始，再把报告摘要写进锁文件。

English: Fifth, implement task-lift eval with isolated workspaces and deterministic assertions. It can use a small sample skill first; broader skills can be added after the runner proves stable.

中文：第五步，实现带隔离工作区和确定性断言的任务收益评测。可以先用一个小型示例技能；运行器稳定后再扩展到更多技能。

English: Sixth, wire skill capability records into `QUI-64` and `QUI-52` integration points. Until those runtime hooks land, `QUI-67` should at least produce the records and tests those hooks will require.

中文：第六步，把技能能力记录接入 `QUI-64` 和 `QUI-52` 的集成点。在这些运行时钩子落地前，`QUI-67` 至少应产出这些钩子后续需要的记录和测试。

## 验收检查 / Acceptance Checks

English: A sample skill package passes only if it includes `SKILL.md`, normalized `metadata.quilin`, dependency metadata, a lockfile entry, a provenance receipt when source data exists, a trigger-quality report, and a task-lift report.

中文：示例技能包只有在包含 `SKILL.md`、归一化 `metadata.quilin`、依赖元数据、锁文件记录、存在来源信息时的来源凭据、触发质量报告和任务收益报告时，才算通过。

English: Unsafe or oversized skills must fail with readable diagnostics. Minimum blocked cases are missing description, invalid YAML, path escape, symlink escape, file too large, package too large, dangerous shell pattern, undeclared write scope, undeclared network domain, undeclared executable dependency, and provenance digest mismatch.

中文：不安全或超尺寸技能必须以可读诊断失败。最低阻断案例包括缺少描述、非法 YAML、路径逃逸、符号链接逃逸、单文件过大、包整体过大、危险 shell 模式、未声明写入范围、未声明网络域名、未声明可执行依赖和来源摘要不匹配。

English: Trigger-quality acceptance requires the report to include precision, recall, false positives, false negatives, model/provider metadata, token cost, latency, and thresholds. A registry-promoted skill must meet the thresholds declared in `metadata.quilin.evals`.

中文：触发质量验收要求报告包含精确率、召回率、假阳性、假阴性、模型/供应商元数据、token 成本、延迟和阈值。晋级到注册表的技能必须满足 `metadata.quilin.evals` 声明的阈值。

English: Task-lift acceptance requires at least one deterministic assertion and one baseline comparison. A report that only says "looks better" without assertions, baseline, cost, and safety references is not enough.

中文：任务收益验收至少需要一个确定性断言和一个基线比较。只写“看起来更好”但没有断言、基线、成本和安全引用的报告不够。

## Linear 映射 / Linear Mapping

English: `QUI-67` owns this implementation plan and the first runtime work: parser, normalized manifest, dependency metadata, validation diagnostics, lockfile, provenance receipt, trigger eval runner, task-lift eval runner, and sample package acceptance.

中文：`QUI-67` 负责本文实现规划和第一批运行时工作：解析器、归一化清单、依赖元数据、校验诊断、锁文件、来源凭据、触发评测运行器、任务收益评测运行器和示例包验收。

English: `QUI-56` remains the decision source for package format, registry direction, provenance direction, eval direction, and compatibility with the broader Agent Skills format.

中文：`QUI-56` 继续作为包格式、注册表方向、来源记录方向、评测方向以及广义 Agent Skills 格式兼容性的决策源。

English: `QUI-64` owns action-level safety enforcement. It should consume skill capabilities, undeclared-action diagnostics, provenance trust tier, and safety scan results when deciding whether a skill-initiated action can run.

中文：`QUI-64` 负责动作级安全执行。它在决定技能发起的动作是否可执行时，应消费技能能力、未声明动作诊断、来源信任等级和安全扫描结果。

English: `QUI-52` owns the tool and sandbox interaction surface. It should consume dependency metadata, tool requirements, MCP server requirements, timeout budgets, output byte budgets, and structured error records from the Skills runtime.

中文：`QUI-52` 负责工具和沙箱交互面。它应消费 Skills 运行时提供的依赖元数据、工具要求、MCP 服务要求、超时预算、输出字节预算和结构化错误记录。

## 当前不做 / Non-Goals

English: Do not build a public hosted registry in `QUI-67`. The first milestone is the local manifest, lockfile, provenance, validation, and eval contract that a registry can trust later.

中文：`QUI-67` 不建设公共托管注册表。第一里程碑是本地清单、锁文件、来源、校验和评测契约，后续注册表才能信任这些产物。

English: Do not let package authors choose arbitrary model providers or bypass runtime policy. Skill metadata may recommend model preference, but workspace policy and runtime routing stay authoritative.

中文：不要允许包作者选择任意模型供应商或绕过运行时策略。技能元数据可以建议模型偏好，但工作区策略和运行时路由仍是权威。

English: Do not treat provenance as a safety verdict. Provenance says where bytes came from; safety checks, eval reports, and runtime policy decide whether the skill should run.

中文：不要把来源记录当作安全结论。来源记录说明字节来自哪里；安全检查、评测报告和运行时策略决定技能是否应运行。

English: Do not start global benchmark work from this issue. Skills runtime quality should first be proven through component-level trigger quality, task lift, provenance completeness, dependency validation, and safety conformance.

中文：不要从本 issue 启动全局 benchmark 工作。Skills 运行时质量应先通过组件级触发质量、任务收益、来源完整性、依赖校验和安全符合性来证明。
