# 沙箱路由器实现规划 / SandboxRouter Implementation Plan

## 范围与结论 / Scope And Conclusion

English: This note executes Linear `QUI-62`（the existing Linear issue for promoting sandbox execution from benchmark-only behavior into runtime implementation planning）. It synthesizes the Tools frontier note, the Deployment/Runtime frontier note, and the benchmark DockerSandbox（the Docker-based sandbox currently used by benchmark tests, important because it is Quilin's only concrete container isolation implementation today）facts.

中文：本文执行 Linear `QUI-62`（现有 Linear issue，用于把沙箱执行从仅服务 benchmark 的行为提升为运行时实现规划）。它综合 Tools 前沿文档、Deployment/Runtime 前沿文档，以及 benchmark DockerSandbox（当前由 benchmark 测试使用的 Docker 沙箱；重要性在于它是 Quilin 目前唯一已落地的容器隔离实现）事实。

English: The implementation direction should be: define `SandboxRouter`（a runtime routing interface that selects and governs sandbox providers）first, promote Docker into the first production provider, keep `LocalSandbox`（a local subprocess fallback that is useful for development but not a security boundary）strictly dev-only, and leave OpenAI/E2B/Modal/Daytona as provider spikes（small vendor-evaluation adapters used to test fit before committing to a dependency）behind the same interface.

中文：实现方向应是：先定义 `SandboxRouter`（选择并治理沙箱提供方的运行时路由接口），再把 Docker 提升为第一个 production provider（生产提供方），把 `LocalSandbox`（本地子进程兜底，只适合开发，不是安全边界）严格限定为 dev-only（仅开发），并把 OpenAI/E2B/Modal/Daytona 作为同一接口后的 provider spikes（小规模供应商适配评估，用于先验证适配性再决定是否引入依赖）。

English: Benchmark work is frozen unless the user explicitly asks for it. The goal here is not to add benchmark coverage; it is to make the Sandbox runtime component strong enough for local runtime evidence and production safety.

中文：除非用户明确要求，benchmark（基准测试）工作保持冻结。这里的目标不是补 benchmark 覆盖，而是先把 Sandbox runtime（沙箱运行时）组件做强，用于本地 runtime 实证和生产安全。

## 现有事实 / Existing Facts

English: `benchmarks/src/sandbox/docker.ts` already implements a useful one-shot Docker command runner. It validates required directories and image names, creates scratch and artifact directories, invokes `docker run --rm`, disables networking with `--network none`, sets CPU, memory, memory-swap, process-count, stop-timeout, and read-only root filesystem limits, then mounts `/workspace/base` and `/workspace/cache` as read-only and `/workspace/task` and `/workspace/artifacts` as writable.

中文：`benchmarks/src/sandbox/docker.ts` 已实现一个有用的一次性 Docker 命令执行器。它会校验必需目录和镜像名，创建 scratch（任务临时目录）和 artifact（产物目录），调用 `docker run --rm`，用 `--network none` 禁止网络，设置 CPU、内存、memory-swap（内存交换限制）、进程数量、停止超时和只读根文件系统限制，并把 `/workspace/base` 与 `/workspace/cache` 只读挂载，把 `/workspace/task` 与 `/workspace/artifacts` 可写挂载。

English: The same file already reports structured command output as JSON with `artifactsDir`, `containerName`, `exitCode`, `output_truncated`, `stderr`, `stdout`, and `timedOut`, then sets `isError` when timeout, truncation, or non-zero exit occurs. It also force-removes containers on host-side timeout or output truncation.

中文：同一文件已经把命令输出用 JSON 结构返回，字段包括 `artifactsDir`、`containerName`、`exitCode`、`output_truncated`、`stderr`、`stdout` 和 `timedOut`，并在超时、输出截断或非零退出码时设置 `isError`。它也会在宿主侧超时或输出截断时强制删除容器。

English: `benchmarks/src/runner/runner.ts` routes only `shell_exec`-style tools through an injected `BenchmarkSandbox`（benchmark-only sandbox interface used by the benchmark runner）and keeps non-shell tools on their original execution path. The runner also blocks path-like tool arguments outside the workspace and adds a benchmark network whitelist around host `fetch`.

中文：`benchmarks/src/runner/runner.ts` 只把 `shell_exec` 这类 shell 执行工具路由到注入的 `BenchmarkSandbox`（benchmark runner 使用的专用沙箱接口），非 shell 工具仍走原执行路径。runner 还会阻止指向 workspace（工作区）外部的路径参数，并给宿主 `fetch` 增加 benchmark 网络白名单。

English: `benchmarks/scripts/docker-smoke.ts` proves the current MVP（Minimum Viable Product, the smallest useful implementation）behavior on Linux: base/cache mounts are read-only, task/artifact mounts are writable, egress is denied, timeout is enforced, and the benchmark phase order remains `setup,agent_loop,collect,score,cleanup`.

中文：`benchmarks/scripts/docker-smoke.ts` 证明当前 MVP（Minimum Viable Product，最小可用实现）在 Linux 上的行为：base/cache 挂载只读，task/artifact 挂载可写，出站网络被拒绝，超时被强制执行，并且 benchmark 阶段顺序保持为 `setup,agent_loop,collect,score,cleanup`。

English: The gap is that this MVP is not a production runtime. It lacks persistent sessions, leases, provider routing, snapshot/resume, install policy, identity and permission manifests, readiness probes, cleanup deadlines, resource accounting, and a stable failure taxonomy shared with Tools and Deployment/Runtime.

中文：差距在于这个 MVP 还不是生产运行时。它缺少持久 session（会话）、lease（租约）、provider routing（提供方路由）、snapshot/resume（快照/恢复）、安装策略、身份和权限清单、readiness probe（就绪探针）、清理截止时间、资源核算，以及与 Tools 和 Deployment/Runtime 共享的稳定失败分类。

## 运行时接口 / Runtime Interface

English: `SandboxRouter` should be a runtime interface, not a Docker helper. It owns provider selection, policy validation, session lifecycle, and structured failure normalization, while each provider owns the concrete execution backend.

中文：`SandboxRouter` 应是运行时接口，而不是 Docker 辅助函数。它负责 provider selection（提供方选择）、policy validation（策略校验）、session lifecycle（会话生命周期）和 structured failure（结构化失败）归一化；各 provider 只负责具体执行后端。

```ts
export interface SandboxRouter {
  createSession(request: SandboxCreateRequest): Promise<SandboxSession>;
  resumeSession(request: SandboxResumeRequest): Promise<SandboxSession>;
  inspectSession(id: SandboxSessionId): Promise<SandboxSessionState>;
  destroySession(id: SandboxSessionId, reason: SandboxDestroyReason): Promise<void>;
}

export interface SandboxSession {
  readonly id: SandboxSessionId;
  readonly provider: SandboxProviderKind;
  readonly policy: SandboxPolicy;

  execute(input: SandboxCommandInput): Promise<SandboxCommandResult>;
  install(input: SandboxInstallInput): Promise<SandboxInstallResult>;
  snapshot(input: SandboxSnapshotInput): Promise<SandboxSnapshotRef>;
  suspend(reason: SandboxSuspendReason): Promise<SandboxSnapshotRef>;
  destroy(reason: SandboxDestroyReason): Promise<void>;
}

export interface SandboxCreateRequest {
  readonly owner: SandboxOwner;
  readonly purpose: "agent-task" | "benchmark" | "tool-worker" | "dev-shell";
  readonly providerPreference?: readonly SandboxProviderKind[];
  readonly image: SandboxImageSpec;
  readonly mounts: readonly SandboxMountSpec[];
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly resourcePolicy: SandboxResourcePolicy;
  readonly outputPolicy: SandboxOutputPolicy;
  readonly permissionManifest: SandboxPermissionManifest;
  readonly ttlMs: number;
}
```

English: The interface must keep the benchmark `runShellCommand` behavior as a compatibility adapter, but production code should call `createSession().execute()` so future providers can keep state, install dependencies, snapshot files, and resume after interruption.

中文：该接口必须保留 benchmark `runShellCommand` 行为作为兼容 adapter（适配层），但生产代码应调用 `createSession().execute()`，这样未来 provider 可以保留状态、安装依赖、快照文件，并在中断后恢复。

English: `SandboxProviderKind` should initially allow `docker`, `local-dev`, `openai-hosted`, `e2b`, `modal`, and `daytona`. Only `docker` and `local-dev` should be implementation targets in `QUI-62`; hosted providers remain spike targets until their security, cost, snapshot, and dependency-install behavior is measured.

中文：`SandboxProviderKind` 初始应允许 `docker`、`local-dev`、`openai-hosted`、`e2b`、`modal` 和 `daytona`。`QUI-62` 的实现目标只应包含 `docker` 与 `local-dev`；托管 provider 在安全、成本、快照和依赖安装行为被测量前，只作为 spike（小规模试验）目标。

## 路由决策 / Routing Decision

English: The default production route is Docker. `SandboxRouter` should choose Docker when the user is not explicitly in trusted local development, Docker is available, and the requested policy can be enforced with container mounts, network mode, resource limits, and cleanup labels.

中文：默认生产路径是 Docker。当用户不是显式处于可信本地开发、Docker 可用，并且请求策略能通过容器挂载、网络模式、资源限制和清理标签执行时，`SandboxRouter` 应选择 Docker。

English: The router should choose `local-dev` only when configuration explicitly allows a dev-only fallback. Falling back from Docker to LocalSandbox silently is forbidden because it turns a missing Docker daemon（the background Docker service that creates and manages containers）into a security downgrade.

中文：只有配置显式允许 dev-only fallback（仅开发兜底）时，router 才能选择 `local-dev`。禁止在 Docker 不可用时静默降级到 LocalSandbox，因为这会把 Docker daemon（Docker 守护进程）缺失变成安全降级。

English: Hosted providers should be selected only by explicit configuration or a spike command. The router must record route reason, provider, policy digest, lease owner, and trace identifier so later observability and audit work in `QUI-20` can explain why a sandbox ran where it ran.

中文：托管 provider 只能由显式配置或 spike 命令选择。router 必须记录 route reason（路由理由）、provider、policy digest（策略摘要）、lease owner（租约归属）和 trace identifier（追踪标识），这样后续 `QUI-20` 的可观测性和审计工作才能解释某个沙箱为什么在对应位置运行。

## 生产 DockerSandbox 边界 / Production DockerSandbox Boundary

English: Production DockerSandbox should be stateful at the session level, even if each command is implemented with container exec or short-lived containers in the first slice. The contract should expose states: `allocated`, `pulling`, `creating`, `starting`, `ready`, `leased`, `executing`, `snapshotting`, `suspending`, `resuming`, `draining`, `destroyed`, and `failed`.

中文：production DockerSandbox（生产 Docker 沙箱）应在 session 层面有状态，即使第一阶段每个命令仍通过 container exec（容器内执行）或短生命周期容器实现。契约应暴露状态：`allocated`、`pulling`、`creating`、`starting`、`ready`、`leased`、`executing`、`snapshotting`、`suspending`、`resuming`、`draining`、`destroyed` 和 `failed`。

English: The first implementation can reuse the benchmark Docker CLI runner but must add production metadata: labels for project, session, owner, purpose, lease, expiry, and trace; a cleanup deadline; readiness checks; and a state-transition log. Docker Engine API adoption can follow after the contract is stable.

中文：第一阶段实现可以复用 benchmark 的 Docker CLI runner（Docker 命令行执行器），但必须增加生产元数据：project（项目）、session、owner（归属）、purpose（用途）、lease、expiry（过期时间）和 trace 的 labels（标签）；清理截止时间；就绪检查；以及状态迁移日志。Docker Engine API（Docker 引擎接口）可以在契约稳定后再接入。

English: DockerSandbox must keep network default-deny, read-only root filesystem, read-only base/cache mounts, writable task/artifacts mounts, CPU and memory limits, process-count limits, output byte limits, command timeout, and forced cleanup. It should add `cap_drop=ALL`, `no-new-privileges`, optional gVisor（a stronger container runtime that adds a user-space kernel boundary）runtime selection, and an explicit image allowlist.

中文：DockerSandbox 必须保持默认拒绝网络、只读根文件系统、只读 base/cache 挂载、可写 task/artifacts 挂载、CPU 和内存限制、进程数量限制、输出字节限制、命令超时和强制清理。它还应增加 `cap_drop=ALL`、`no-new-privileges`、可选 gVisor（通过用户态内核边界增强隔离的容器运行时）选择，以及显式 image allowlist（镜像白名单）。

English: DockerSandbox must not own host policy by itself. `WriteAuthority`（the central write-permission gate described in the project guide）still decides whether a tool may write; DockerSandbox enforces the runtime boundary after that decision.

中文：DockerSandbox 不能单独拥有宿主策略。`WriteAuthority`（项目指南中描述的中央写权限门）仍负责决定某个工具是否可以写入；DockerSandbox 只在该决策之后执行运行时边界。

## LocalSandbox 边界 / LocalSandbox Boundary

English: `LocalSandbox` is a developer convenience adapter, not a security feature. It may run subprocesses in a temporary working directory, scrub obvious sensitive environment variables, apply wall-clock timeouts, and delete temporary files, but it cannot claim filesystem, network, process, or kernel isolation.

中文：`LocalSandbox` 是开发便利 adapter，不是安全功能。它可以在临时工作目录中运行子进程，清洗明显敏感环境变量，应用 wall-clock timeout（墙钟时间超时），并删除临时文件，但不能宣称提供文件系统、网络、进程或内核隔离。

English: The router must require an explicit dev signal such as `sandbox.provider=local-dev` and `sandbox.localDev.allowUnsafe=true`. Any production config, daemon config（configuration for a long-running background service）, remote task, or multi-user context must reject LocalSandbox with a structured failure instead of silently continuing.

中文：router 必须要求显式开发信号，例如 `sandbox.provider=local-dev` 和 `sandbox.localDev.allowUnsafe=true`。任何生产配置、daemon（守护进程）配置、远程任务或多用户上下文都必须用结构化失败拒绝 LocalSandbox，而不是静默继续。

English: LocalSandbox should still implement the same `SandboxSession` interface so Tools can run the same code path in development. Its result must include `isIsolationBoundary:false` and `risk:"dev-only"` so logs and UI never confuse it with Docker.

中文：LocalSandbox 仍应实现同一个 `SandboxSession` 接口，这样 Tools 在开发中可以走同一代码路径。它的结果必须包含 `isIsolationBoundary:false` 和 `risk:"dev-only"`，避免日志和 UI 把它误认为 Docker。

## 快照与恢复 / Snapshot And Resume

English: Snapshot/resume means persisting enough sandbox state to pause work and later recover it. For the first Docker slice, a snapshot should be a filesystem snapshot of `/workspace/task`, `/workspace/artifacts`, selected cache metadata, image reference, environment manifest, policy digest, command history, and last known state. It should not pretend to preserve TCP connections, file descriptors, or child processes.

中文：snapshot/resume（快照/恢复）指持久化足够的沙箱状态，以便暂停工作后再恢复。第一阶段 Docker 切片中，snapshot 应是 `/workspace/task`、`/workspace/artifacts`、选定 cache metadata（缓存元数据）、镜像引用、环境清单、策略摘要、命令历史和最后已知状态的文件系统快照。它不能假装保留 TCP 连接、文件描述符或子进程。

English: Resume must support warm and cold paths. Warm resume may reuse an existing live container when lease, image, policy, and readiness still match; cold restore should allocate a fresh container from the same image and restore the snapshot files. Any non-resumable operation must be marked `needs_replay`（a state meaning the operation must be safely rerun or reviewed before reuse）.

中文：恢复必须支持 warm path（热恢复路径）和 cold path（冷恢复路径）。热恢复可以在 lease、镜像、策略和就绪状态仍匹配时复用现有活容器；冷恢复应从同一镜像分配新容器并恢复快照文件。任何不可恢复操作必须标记为 `needs_replay`（表示该操作需要安全重跑或经审核后才能复用的状态）。

English: Provider-specific snapshots are spike territory. E2B auto-resume, Modal filesystem snapshots, Daytona snapshots, and OpenAI hosted container state should be tested against the same `SandboxSnapshotRef` shape before Quilin commits to one hosted provider.

中文：provider-specific snapshots（提供方特定快照）属于 spike 范围。E2B 自动恢复、Modal 文件系统快照、Daytona 快照和 OpenAI 托管容器状态，都应先用同一个 `SandboxSnapshotRef` 形状测试，再决定 Quilin 是否承诺某个托管 provider。

## 网络、挂载与资源策略 / Network, Mount, And Resource Policy

English: `SandboxNetworkPolicy` should be default-deny. The first allowed modes are `none`, `allowlist`, and `debug-bridge`; `full` should not exist as a production default. Allowlist entries must be normalized by origin or host, logged, and tied to task purpose.

中文：`SandboxNetworkPolicy`（沙箱网络策略）应默认拒绝。第一批允许模式是 `none`、`allowlist` 和 `debug-bridge`；`full` 不应作为生产默认值存在。allowlist（白名单）条目必须按 origin（协议、域名、端口组合）或 host（主机名）归一化、写入日志，并绑定任务用途。

English: `SandboxMountSpec` should separate `base`, `task`, `artifacts`, `cache`, and `secrets`. Base and cache are read-only by default; task and artifacts are writable; secrets should be injected as scoped files or environment references only when `WriteAuthority` and sandbox policy both approve.

中文：`SandboxMountSpec`（沙箱挂载规格）应区分 `base`、`task`、`artifacts`、`cache` 和 `secrets`。base 与 cache 默认只读；task 与 artifacts 可写；secrets（密钥）只有在 `WriteAuthority` 和沙箱策略都批准时，才能作为 scoped files（受限文件）或环境引用注入。

English: `SandboxResourcePolicy` should cover CPU, memory, memory swap, process count, disk output bytes, stdout/stderr bytes, wall-clock timeout, idle timeout, total session TTL（time-to-live, the maximum lifetime before a session expires）, and concurrency. These limits must be reflected in both Docker arguments and structured results.

中文：`SandboxResourcePolicy`（沙箱资源策略）应覆盖 CPU、内存、memory swap、进程数量、磁盘输出字节、stdout/stderr 字节、wall-clock timeout、idle timeout（空闲超时）、session 总 TTL（time-to-live，存活时长）和并发数。这些限制必须同时体现在 Docker 参数和结构化结果中。

English: `SandboxOutputPolicy` should define where artifacts are collected, maximum artifact bytes, whether hidden files are included, which files are promoted to the host, and how failed runs expose partial output. The benchmark `artifactsDir` behavior should become a special case of this policy.

中文：`SandboxOutputPolicy`（沙箱输出策略）应定义 artifact（产物）收集位置、最大产物字节数、是否包含隐藏文件、哪些文件会提升到宿主机，以及失败运行如何暴露部分输出。benchmark 里的 `artifactsDir` 行为应成为该策略的一个特例。

## 结构化失败 / Structured Failure

English: Structured failure should become a first-class contract shared by Tools and Sandbox. A shell failure, Docker daemon failure, policy rejection, timeout, output truncation, image pull failure, mount failure, network denial, snapshot corruption, and resume mismatch should not all collapse into free-form stderr.

中文：structured failure（结构化失败）应成为 Tools 与 Sandbox 共享的一等契约。shell 失败、Docker daemon 失败、策略拒绝、超时、输出截断、镜像拉取失败、挂载失败、网络拒绝、快照损坏和恢复不匹配，不应全部塌缩成自由文本 stderr。

```ts
export interface SandboxFailure {
  readonly kind:
    | "policy_rejected"
    | "provider_unavailable"
    | "image_unavailable"
    | "mount_failed"
    | "network_denied"
    | "command_failed"
    | "timeout"
    | "output_truncated"
    | "snapshot_failed"
    | "resume_mismatch"
    | "cleanup_failed";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly provider: SandboxProviderKind;
  readonly phase: SandboxPhase;
  readonly commandExitCode?: number | null;
  readonly stderrPreview?: string;
  readonly traceId: string;
  readonly auditRef: string;
}
```

English: `SandboxCommandResult` should preserve the current benchmark JSON fields but add typed fields: `stdout`, `stderr`, `exitCode`, `timedOut`, `outputTruncated`, `artifacts`, `metrics`, `failure`, `provider`, `sessionId`, `traceId`, and `auditRef`. The `ToolResultV2` work in `QUI-52` can then embed this object as `structuredContent`.

中文：`SandboxCommandResult` 应保留当前 benchmark JSON 字段，但增加类型字段：`stdout`、`stderr`、`exitCode`、`timedOut`、`outputTruncated`、`artifacts`、`metrics`、`failure`、`provider`、`sessionId`、`traceId` 和 `auditRef`。`QUI-52` 的 `ToolResultV2` 工作随后可以把该对象嵌入为 `structuredContent`（结构化内容）。

## Provider Spike 路线 / Provider Spike Path

English: OpenAI hosted containers should be evaluated for hosted shell execution and sandbox-as-tool composition. The spike should measure session persistence, approval boundaries, file transfer shape, provider logs, timeout behavior, and whether Quilin can keep host-side policy control.

中文：OpenAI hosted containers（OpenAI 托管容器）应评估其托管 shell 执行和 sandbox-as-tool（把沙箱作为工具）组合能力。该 spike 应测量 session 持久性、审批边界、文件传输形态、provider 日志、超时行为，以及 Quilin 是否仍能保持宿主侧策略控制。

English: E2B should be evaluated for auto-resume and long-lived development sandboxes. The spike should measure cold start, warm resume, snapshot durability, dependency installation, network controls, file sync, and cost under repeated agent tasks.

中文：E2B 应评估自动恢复和长生命周期开发沙箱能力。该 spike 应测量冷启动、热恢复、快照耐久性、依赖安装、网络控制、文件同步，以及重复 agent task（智能体任务）下的成本。

English: Modal should be evaluated for scheduled or bursty execution that needs reproducible images and filesystem snapshots. The spike should measure image build flow, secret injection, timeout behavior, snapshot restore, and suitability for non-interactive tool work.

中文：Modal 应评估适合定时或突发执行的场景，尤其是需要可复现镜像和文件系统快照的工作。该 spike 应测量镜像构建流程、密钥注入、超时行为、快照恢复，以及对非交互式工具工作的适配性。

English: Daytona should be evaluated for workspace-style snapshots and developer-environment reproduction. The spike should measure repository checkout, dependency bootstrap, snapshot/restore, persistent workspace identity, and whether it can safely back a Quilin subagent workspace.

中文：Daytona 应评估 workspace-style snapshots（工作区式快照）和开发环境复现能力。该 spike 应测量代码库 checkout（检出）、依赖启动、快照/恢复、持久工作区身份，以及它是否能安全支撑 Quilin subagent（子智能体）工作区。

English: None of these spikes should create new Linear issues under the free-plan cap. They should be logged as comments under `QUI-62` or `QUI-21` until one provider needs independent ownership, blockers, or acceptance criteria.

中文：受 Linear 免费版 issue 上限约束，这些 spike 不应新建 issue。它们应先作为 `QUI-62` 或 `QUI-21` 下的 comment 记录，直到某个 provider 需要独立负责人、阻塞关系或验收标准。

## 实施切片 / Implementation Slices

English: Slice 1 should define TypeScript contracts under the runtime or tools boundary without changing benchmark semantics: `SandboxRouter`, `SandboxSession`, policies, results, failures, and adapters from existing `BenchmarkSandbox`. Acceptance is type coverage plus parity tests proving benchmark shell routing still works.

中文：切片 1 应在 runtime 或 tools 边界下定义 TypeScript 契约，同时不改变 benchmark 语义：`SandboxRouter`、`SandboxSession`、策略、结果、失败，以及从现有 `BenchmarkSandbox` 到新接口的 adapters。验收是类型覆盖，以及证明 benchmark shell 路由仍可工作的等价测试。

English: Slice 2 should implement Docker provider parity and production metadata. Acceptance is the current Docker smoke behavior plus labels, lease owner, cleanup deadline, readiness state, structured failure mapping, and explicit rejection when Docker is required but unavailable.

中文：切片 2 应实现 Docker provider 等价能力和生产元数据。验收是当前 Docker 冒烟行为，加上 labels、lease owner、cleanup deadline、readiness state、structured failure mapping，以及 Docker 被要求但不可用时的显式拒绝。

English: Slice 3 should add snapshot/resume for filesystem state. Acceptance is cold restore into a fresh Docker session, warm reuse when valid, and `needs_replay` marking for anything that cannot be safely resumed.

中文：切片 3 应增加文件系统状态的 snapshot/resume。验收是能 cold restore 到新的 Docker session，条件有效时能 warm reuse，并对无法安全恢复的内容标记 `needs_replay`。

English: Slice 4 should add LocalSandbox as an explicitly unsafe development provider. Acceptance is that production and daemon configs reject it, while a dev-only config can run the same interface and emits `isIsolationBoundary:false`.

中文：切片 4 应增加 LocalSandbox，作为显式不安全的开发 provider。验收是生产和 daemon 配置拒绝它，而 dev-only 配置可以走同一接口并输出 `isIsolationBoundary:false`。

English: Slice 5 should run provider spikes without adopting a vendor. Acceptance is a comparison note under `QUI-62` or `QUI-21` covering OpenAI, E2B, Modal, and Daytona against the same session, policy, snapshot, failure, cost, and audit matrix.

中文：切片 5 应运行 provider spikes，但不直接采用供应商。验收是在 `QUI-62` 或 `QUI-21` 下写入比较记录，用同一套 session、policy、snapshot、failure、cost 和 audit matrix（审计矩阵）评估 OpenAI、E2B、Modal 和 Daytona。

## Linear 映射 / Linear Mapping

English: `QUI-62` owns `SandboxRouter`, production DockerSandbox, LocalSandbox dev-only boundaries, snapshot/resume, sandbox policy contracts, structured failure, and provider spike comparison. This document is the implementation plan for that issue.

中文：`QUI-62` 负责 `SandboxRouter`、production DockerSandbox、LocalSandbox dev-only 边界、snapshot/resume、沙箱策略契约、结构化失败和 provider spike 比较。本文是该 issue 的实现规划。

English: `QUI-52` owns Tools integration: `ToolResultV2`, sandbox-as-tool, policy-first tool routing, and how sandbox results become structured tool output.

中文：`QUI-52` 负责 Tools 集成：`ToolResultV2`、sandbox-as-tool、policy-first tool routing（策略优先的工具路由），以及沙箱结果如何成为结构化工具输出。

English: `QUI-21` owns Deployment/Runtime lifecycle: Docker readiness, packaging/runtime configuration, daemon ownership, cleanup after crashes, suspend/resume integration, and cloud provider configuration.

中文：`QUI-21` 负责 Deployment/Runtime 生命周期：Docker 就绪、打包/运行时配置、daemon 归属、崩溃后清理、暂停/恢复集成，以及云 provider 配置。

English: `QUI-18` owns the broader Tools roadmap: browser provider routing, Computer Use（GUI control surface based on screenshots and input actions, important but high-risk）gating, MCP（Model Context Protocol，模型上下文协议，用于连接模型与工具/上下文服务）expansion, and deferred tool discovery.

中文：`QUI-18` 负责更广义的 Tools 路线图：browser provider routing、Computer Use（基于截图和输入动作的 GUI 控制面，能力重要但风险较高）门控、MCP（Model Context Protocol，模型上下文协议，用于连接模型与工具/上下文服务）扩展，以及 deferred tool discovery（延迟工具发现）。

## 验证门禁 / Verification Gates

English: Minimum verification for this planning slice is documentation lint and whitespace validation. Minimum verification for the future implementation is contract tests, Docker provider parity tests, Docker smoke on Linux, LocalSandbox rejection tests in production config, snapshot/restore tests, structured failure table tests, and runner compatibility tests.

中文：本规划切片的最小验证是文档术语检查和空白字符检查。未来实现的最小验证是契约测试、Docker provider 等价测试、Linux Docker 冒烟测试、生产配置下 LocalSandbox 拒绝测试、快照/恢复测试、结构化失败表测试，以及 runner 兼容性测试。

English: The implementation should not be considered benchmark-ready because Benchmark work is frozen. If the user later restarts Benchmark work, SandboxRouter, Tools integration, Deployment/Runtime lifecycle, and Observability trace fields must first share the same session, policy, failure, and audit model.

中文：由于 Benchmark 工作已冻结，该实现不应被视为 benchmark-ready（可进入基准测试）。如果用户未来重启 Benchmark 工作，SandboxRouter、Tools 集成、Deployment/Runtime 生命周期和 Observability（可观测性）追踪字段必须先共享同一套 session、policy、failure 和 audit model。

## 来源 / Sources

English: Local source evidence: `docs/05-tool/tools-frontier-assimilation.md`, `docs/09-deployment-runtime/deployment-runtime-frontier-assimilation.md`, `docs/09-deployment-runtime/README.md`, `benchmarks/src/sandbox/docker.ts`, `benchmarks/src/sandbox/docker.test.ts`, `benchmarks/src/runner/runner.ts`, `benchmarks/src/runner/runner.test.ts`, and `benchmarks/scripts/docker-smoke.ts`.

中文：本地证据来源：`docs/05-tool/tools-frontier-assimilation.md`、`docs/09-deployment-runtime/deployment-runtime-frontier-assimilation.md`、`docs/09-deployment-runtime/README.md`、`benchmarks/src/sandbox/docker.ts`、`benchmarks/src/sandbox/docker.test.ts`、`benchmarks/src/runner/runner.ts`、`benchmarks/src/runner/runner.test.ts` 和 `benchmarks/scripts/docker-smoke.ts`。

English: External source families are already captured in the two frontier notes: OpenAI SandboxAgent（sandboxed agent workspace pattern）, hosted tools, MCP tools/tasks/authorization semantics, Docker Engine API, gVisor, E2B auto-resume, Modal sandboxes, Daytona snapshots, and related deployment/runtime references.

中文：外部来源族已经记录在两个前沿文档中：OpenAI SandboxAgent 与托管工具、MCP tools/tasks/authorization 语义、Docker Engine API、gVisor、E2B 自动恢复、Modal 沙箱、Daytona 快照，以及相关 Deployment/Runtime 参考资料。
