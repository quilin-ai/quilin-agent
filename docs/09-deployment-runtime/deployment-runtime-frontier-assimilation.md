# 部署运行时前沿吸收 / Deployment Runtime Frontier Assimilation

## 范围与结论 / Scope and Conclusion

English: This note executes Linear issue `QUI-21`（the Linear task tracking Deployment/Runtime packaging, hot update, development container and sandbox lifecycle assimilation）. It focuses on packaging, update, daemon lifecycle, home-path isolation, container sandbox lifecycle, and long-session suspend/resume. It does not start benchmark work; Benchmark is frozen unless the user explicitly asks for it.

中文：本笔记执行 Linear issue `QUI-21`（Linear 中跟踪 Deployment/Runtime 打包、热更新、开发容器和沙箱生命周期吸收的任务）。范围聚焦打包、更新、守护进程生命周期、主目录路径隔离、容器沙箱生命周期和长会话暂停/恢复。这里不启动 benchmark（基准测试）工作；除非用户明确要求，Benchmark 保持冻结。

English: The previous design direction is still valid, but it is too broad if treated as one generic deployment feature. Quilin should split Deployment/Runtime into six explicit contracts: release artifact, secure update, supervised daemon, platform path, sandbox lifecycle, and suspend/resume. Each contract needs observable state transitions and a minimum smoke gate.

中文：之前的设计方向仍然成立，但如果把它当成一个泛泛的部署功能，范围会过大。Quilin 应把 Deployment/Runtime 拆成六个显式契约：发布产物、安全更新、受监督守护进程、平台路径、沙箱生命周期和暂停/恢复。每个契约都需要可观测状态迁移和最小冒烟门禁。

## 调研覆盖 / Research Coverage

English: Primary sources include Bun standalone executable documentation, the Dev Container Specification, GitHub Copilot cloud-agent environment documentation, GitHub artifact attestations, Sigstore, The Update Framework（secure software update metadata framework，用于防止更新链路被篡改）, Docker Engine API, gVisor（a container sandbox runtime that inserts a user-space kernel boundary between workload and host）, Fly Machines suspend/resume, E2B auto-resume, Modal sandboxes, Daytona snapshots, systemd service notifications, and Microsoft Windows Service lifecycle documentation.

中文：一手来源包括 Bun 单文件可执行文件文档、Dev Container Specification（开发容器规范）、GitHub Copilot cloud-agent（云端编码 agent）环境文档、GitHub artifact attestations（构建产物证明）、Sigstore、TUF（The Update Framework，用安全元数据保护软件更新链路的框架）、Docker Engine API、gVisor（在工作负载与宿主机之间插入用户态内核边界的容器沙箱运行时）、Fly Machines 暂停/恢复、E2B 自动恢复、Modal 沙箱、Daytona 快照、systemd 服务通知和 Microsoft Windows Service 生命周期文档。

English: GitHub issue evidence comes from `docs/00-core-loop/competitor-issue-intake.md`: OpenClaw repeatedly exposes Linux/Windows packaging, Docker mount, Windows update, gateway restart, child-process leak, and sandbox lifecycle failures; Hermes Agent repeatedly exposes Docker home-directory permission, `Path.home` bypass, missing image commands, stale process identifier restart loops, and background adapter delivery leaks.

中文：GitHub issue 证据来自 `docs/00-core-loop/competitor-issue-intake.md`：OpenClaw 反复暴露 Linux/Windows 打包、Docker 挂载、Windows 更新、gateway restart（网关重启）、子进程泄漏和沙箱生命周期失败；Hermes Agent 反复暴露 Docker 主目录权限、`Path.home` 绕过、镜像命令缺失、过期 process identifier（进程标识符）重启循环和后台适配器交付泄漏。

English: X/Twitter was queried for current weak signals. The useful recurring signal was not a normative design pattern; it was that practitioners keep naming sandbox reliability, cold start, state management, and agent observability as practical bottlenecks. Therefore this note cites official docs and repository evidence for decisions, and treats social posts only as directional pressure.

中文：本次也查询了 X/Twitter 的当前弱信号。可用的重复信号不是规范设计模式，而是实践者持续指出 sandbox reliability（沙箱可靠性）、cold start（冷启动）、state management（状态管理）和 agent observability（智能体可观测性）是实际瓶颈。因此本文档只把官方文档和仓库证据作为决策依据，把社媒内容仅作为方向压力。

## 吸收方案一：单文件打包 / Absorption 1: Single-Binary Packaging

English: Because Quilin's active core runtime is TypeScript on Bun, the first packaging lane should use Bun `--compile` to produce standalone executables for Linux, macOS, and Windows. Bun documents cross-target builds and embedded files, which matches a CLI-first agent better than a Node.js SEA（Single Executable Application，Node.js 的单可执行文件机制）path that is still more operationally involved for TypeScript projects.

中文：由于 Quilin 当前核心运行时是 TypeScript on Bun（用 Bun 运行 TypeScript），第一条打包路径应使用 Bun `--compile` 为 Linux、macOS 和 Windows 产出 standalone executable（独立可执行文件）。Bun 文档明确支持跨目标构建和嵌入文件，这比 Node.js SEA（Single Executable Application，Node.js 的单可执行文件机制）更适合 CLI-first agent（以命令行为第一入口的智能体）项目，因为后者对 TypeScript 项目的运维复杂度更高。

English: The binary must not carry mutable runtime state. Embedded assets may include default templates, schema files, and built-in help text, but user config, session state, logs, model cache, sandbox scratch space, and update staging must live under the platform path contract described below. This prevents the competitor class of "binary update changed runtime state" and "current working directory accidentally becomes the database path" failures.

中文：二进制文件不能承载可变运行时状态。可嵌入的资产包括默认模板、schema（结构约束）文件和内置帮助文本，但用户配置、会话状态、日志、模型缓存、沙箱临时空间和更新暂存区必须落在下面的平台路径契约中。这样可以避免竞品中出现的“二进制更新改变运行时状态”和“当前工作目录意外变成数据库路径”这类失败。

English: Release artifacts should be generated as an explicit matrix: `darwin-arm64`, `darwin-x64`, `linux-x64-baseline`, `linux-arm64`, `windows-x64`, plus container images for users who prefer Docker. Each artifact gets a smoke command that runs without network, prints version/build metadata, checks config resolution, checks state-path writability, and exits without starting a daemon.

中文：发布产物应按显式矩阵生成：`darwin-arm64`、`darwin-x64`、`linux-x64-baseline`、`linux-arm64`、`windows-x64`，并额外提供给偏好 Docker 的用户使用的容器镜像。每个产物都要有一个无需网络的 smoke command（冒烟命令）：打印版本和构建元数据，检查配置解析，检查状态路径可写性，然后在不启动守护进程的情况下退出。

## 吸收方案二：开发容器与持续交付 / Absorption 2: Devcontainer and Continuous Delivery

English: The Dev Container Specification should become the canonical development-environment contract, not just editor convenience. The specification exists to make development containers easy to create and recreate, and GitHub's Copilot cloud-agent documentation shows the same pattern in production agent environments: each agent task runs in an ephemeral GitHub Actions-powered environment with setup steps.

中文：Dev Container Specification（开发容器规范）应成为标准开发环境契约，而不只是编辑器便利配置。该规范的目标是让开发容器容易创建和重建，GitHub Copilot cloud-agent 文档也展示了同样的生产 agent 环境模式：每个 agent 任务在由 GitHub Actions 驱动的临时环境中运行，并通过 setup steps（初始化步骤）准备依赖。

English: Quilin should maintain one environment declaration that feeds local development, cloud agent execution, and continuous delivery. In practice this means `.devcontainer/devcontainer.json`, GitHub Actions setup, `just init`, and release jobs must share the same dependency versions for Bun, CPython, Rust, pnpm, uv, and Docker tooling.

中文：Quilin 应维护一个环境声明，同时服务本地开发、云端 agent 执行和持续交付。实际含义是 `.devcontainer/devcontainer.json`、GitHub Actions 初始化、`just init` 和发布任务必须共享同一组 Bun、CPython、Rust、pnpm、uv 和 Docker 工具版本。

English: Continuous delivery should publish three things together: signed binary artifacts, signed container images, and provenance records. GitHub artifact attestations prove which workflow built an artifact, while Sigstore signs artifacts and records signing events in a transparency log. This gives users a concrete verification path before auto-update or manual install.

中文：持续交付应同时发布三类东西：已签名二进制产物、已签名容器镜像和 provenance records（来源证明记录）。GitHub artifact attestations 能证明某个产物由哪个 workflow（工作流）构建，Sigstore 能签名产物并把签名事件写入 transparency log（透明日志）。这给自动更新和手动安装都提供了明确验证路径。

## 吸收方案三：安全热更新 / Absorption 3: Secure Hot Update

English: Hot update should be a staged handoff, not an in-place overwrite. The updater downloads into a versioned staging directory, verifies the release manifest, verifies the Sigstore or GitHub attestation identity, runs the smoke command from the staged binary, then flips a shim or symlink on Unix-like systems. On Windows, where active executables commonly produce file-lock failures, the active process should ask a helper process to replace the shim after graceful drain.

中文：热更新应是 staged handoff（分阶段交接），不是原地覆盖。更新器下载到带版本号的 staging directory（暂存目录），验证发布 manifest（清单），验证 Sigstore 或 GitHub attestation identity（构建身份），运行暂存二进制的冒烟命令，然后在类 Unix 系统上切换 shim（启动入口包装器）或 symlink（符号链接）。在 Windows 上，运行中的可执行文件常见文件锁失败，活跃进程应请求 helper process（辅助进程）在优雅排空后替换 shim。

English: The Update Framework should supply the update metadata model: signed role separation, expiry, rollback resistance, and target metadata. Quilin does not need to implement the whole ecosystem in the first slice, but `QUI-21` should require an update manifest with version, channel, artifact digest, compatibility range, minimum config schema, and rollback target.

中文：TUF（The Update Framework，用安全元数据保护软件更新链路的框架）应提供更新元数据模型：签名角色隔离、过期控制、回滚防护和目标文件元数据。Quilin 第一阶段不需要实现完整生态，但 `QUI-21` 应要求 update manifest（更新清单）包含版本、发布通道、产物摘要、兼容范围、最低配置 schema 和回滚目标。

English: After an update, the agent must proactively tell the user what changed: old version, new version, migration status, resumed sessions, interrupted sessions, failed adapter reconnects, and where the release evidence lives. This directly addresses the competitor pain where updates restart or disconnect without useful operator feedback.

中文：更新后，agent 必须主动告知用户变更内容：旧版本、新版本、迁移状态、已恢复会话、中断会话、失败的 adapter reconnect（适配器重连）和发布证据位置。这直接解决竞品中“更新后重启或断连，但操作者没有有用反馈”的痛点。

## 吸收方案四：守护进程生命周期 / Absorption 4: Daemon Lifecycle

English: Daemon runtime should be a supervised state machine. The minimum states are `starting`, `ready`, `running`, `reloading`, `draining`, `suspending`, `suspended`, `resuming`, `stopping`, and `failed`. A process identifier file is only advisory; correctness must come from an exclusive lock, heartbeat, child-process accounting, and supervisor integration.

中文：Daemon runtime（守护进程运行时）应是受监督的状态机。最小状态包括 `starting`、`ready`、`running`、`reloading`、`draining`、`suspending`、`suspended`、`resuming`、`stopping` 和 `failed`。process identifier file（进程标识符文件）只能作为提示；正确性必须来自排他锁、心跳、子进程计数和 supervisor integration（与系统监督器集成）。

English: On Linux, systemd integration should use readiness notification and watchdog heartbeats; on macOS, launchd should own start and keepalive behavior; on Windows, Service Control Manager should own service states such as running, paused, and stopped. Quilin's CLI should expose the same logical status on every platform instead of leaking platform-specific wording to users.

中文：在 Linux 上，systemd 集成应使用 readiness notification（就绪通知）和 watchdog heartbeat（看门狗心跳）；在 macOS 上，launchd 应负责启动和保活行为；在 Windows 上，Service Control Manager（服务控制管理器）应负责 running、paused、stopped 等服务状态。Quilin 的 CLI 应在每个平台暴露同一套逻辑状态，而不是把平台特定措辞泄漏给用户。

English: Read-only commands must never restart the daemon. `quilin status`, `quilin config show`, `quilin doctor`, and `quilin logs` should be idempotent and must report stale locks, orphaned children, memory growth, and pending update state without changing daemon ownership.

中文：只读命令绝不能重启守护进程。`quilin status`、`quilin config show`、`quilin doctor` 和 `quilin logs` 应保持 idempotent（幂等，即重复执行不会改变状态），并在不改变守护进程归属的前提下报告过期锁、孤儿子进程、内存增长和待更新状态。

## 吸收方案五：主目录路径与配置隔离 / Absorption 5: Home Path and Config Isolation

English: Quilin should never call a raw home-directory helper as the source of truth for runtime state. On Linux, follow the XDG Base Directory model: config, data, state, cache, runtime sockets, and logs are separate concerns. On systemd-managed services, prefer service-provided runtime, state, cache, log, and configuration directories where available.

中文：Quilin 不能把原始 home-directory helper（主目录辅助函数）当作运行时状态的唯一真相源。在 Linux 上，应遵循 XDG Base Directory（用户级配置、数据、状态和缓存目录规范）模型：配置、数据、状态、缓存、运行时 socket（套接字）和日志是不同关注点。在 systemd 管理的服务中，应优先使用服务提供的 runtime、state、cache、log 和 configuration directories（运行、状态、缓存、日志和配置目录）。

English: On macOS and Windows, the same logical categories should map to platform directories instead of `~/.quilin` hard-coding. The config resolver must accept `QUILIN_HOME` only as an explicit override, then derive subdirectories under it; ordinary user config should still keep secrets out of config files and load credentials from environment variables or a credential broker.

中文：在 macOS 和 Windows 上，同样的逻辑类别应映射到平台目录，而不是硬编码 `~/.quilin`。配置解析器可以接受 `QUILIN_HOME` 作为显式覆盖，然后从它派生子目录；普通用户配置仍应避免把 secret（密钥）写进配置文件，并从环境变量或 credential broker（凭证代理）加载凭证。

English: This directly absorbs the Hermes Agent path failures where Docker home permissions and `Path.home` bypassed the intended home override. The acceptance gate is a path-matrix test: native shell, daemon, Docker image, development container, and cloud sandbox must all resolve the same logical paths without accidentally writing into the source checkout.

中文：这直接吸收 Hermes Agent 的路径失败：Docker 主目录权限问题和 `Path.home` 绕过预期 home override（主目录覆盖）。验收门禁是路径矩阵测试：原生 shell、守护进程、Docker 镜像、开发容器和云沙箱都必须解析出同一套逻辑路径，并且不能意外写入源码 checkout（检出的代码目录）。

## 吸收方案六：容器沙箱生命周期 / Absorption 6: Container Sandbox Lifecycle

English: DockerSandbox should be treated as a managed lifecycle resource, not a helper around `docker run`. The Docker Engine API already exposes version negotiation and daemon interaction; Quilin should wrap it with explicit states: `allocated`, `pulling`, `creating`, `starting`, `ready`, `leased`, `draining`, `stopping`, `removed`, and `failed`.

中文：DockerSandbox（Docker 容器沙箱）应被视为受管理的生命周期资源，而不是 `docker run` 的辅助封装。Docker Engine API 已经提供版本协商和 daemon（守护进程）交互；Quilin 应在其上包一层显式状态：`allocated`、`pulling`、`creating`、`starting`、`ready`、`leased`、`draining`、`stopping`、`removed` 和 `failed`。

English: Every sandbox must have a lease owner, labels, resource limits, network policy, mount manifest, readiness probe, cleanup deadline, and audit record. Labels and audit records make cleanup reliable after crashes; leases prevent two agents from reusing one sandbox; readiness probes prevent tests from racing before dependencies are installed.

中文：每个沙箱必须有 lease owner（租约归属）、labels（标签）、资源限制、网络策略、挂载清单、readiness probe（就绪探针）、清理截止时间和审计记录。标签和审计记录让崩溃后的清理可靠；租约防止两个 agent 复用同一个沙箱；就绪探针防止依赖尚未安装完时测试抢跑。

English: gVisor should be the first stronger-isolation option after plain Docker because it implements an OCI-compatible runtime and integrates with Docker and Kubernetes. Firecracker-style microVMs should remain the stronger future option for untrusted multi-tenant workloads, but the first local slice should keep Docker plus optional gVisor to avoid turning `QUI-21` into a cloud platform project.

中文：gVisor 应作为 plain Docker（普通 Docker）之后的第一层更强隔离选项，因为它实现 OCI-compatible runtime（开放容器规范兼容运行时），并能接入 Docker 和 Kubernetes。Firecracker-style microVM（类似 Firecracker 的微型虚拟机）应保留为面向不可信多租户工作负载的更强未来选项，但第一阶段本机切片应保持 Docker 加可选 gVisor，避免把 `QUI-21` 变成云平台项目。

English: Daytona, Modal, and E2B show useful cloud-sandbox patterns: reusable snapshots, Docker-in-Docker or service dependencies, readiness probes, timeout policies, and auto-resume. Quilin should absorb the contract shapes, not bind itself to one vendor in the core runtime.

中文：Daytona、Modal 和 E2B 展示了有用的云沙箱模式：可复用快照、Docker-in-Docker（在沙箱里运行 Docker）或服务依赖、就绪探针、超时策略和自动恢复。Quilin 应吸收契约形态，而不是在核心运行时绑定某一个供应商。

## 吸收方案七：长会话暂停与恢复 / Absorption 7: Long-Session Suspend and Resume

English: Long-session suspend/resume must support both warm resume and cold restore. Fly Machines show that memory snapshot resume can be fast, but snapshots can be invalidated by deployment, migration, corruption, or host maintenance; E2B shows activity-triggered auto-resume; Modal recommends filesystem snapshots beyond 24-hour sandbox lifetimes. Quilin must therefore persist enough durable state to survive cold restore even when warm resume is unavailable.

中文：长会话暂停/恢复必须同时支持 warm resume（从内存或进程快照快速恢复）和 cold restore（从持久化状态冷恢复）。Fly Machines 说明内存快照恢复可以很快，但部署、迁移、损坏或宿主机维护都可能让快照失效；E2B 展示了 activity-triggered auto-resume（活动触发自动恢复）；Modal 建议超过 24 小时的沙箱生命周期使用文件系统快照。因此 Quilin 必须持久化足够的 durable state（可恢复状态），即使 warm resume 不可用，也能 cold restore。

English: Resume should be observable and honest. On resume, Quilin must revalidate clocks, reconnect model providers, reconnect message adapters, rebuild browser or sandbox handles, and mark any non-resumable tool call as `needs_replay`（a state meaning the operation must be safely rerun or reviewed before reuse）. It should never pretend that TCP connections, file descriptors, or child processes are still valid merely because a snapshot resumed.

中文：恢复必须可观测且诚实。恢复时，Quilin 必须重新验证时钟，重连模型供应商，重连消息适配器，重建浏览器或沙箱句柄，并把任何不可恢复的工具调用标为 `needs_replay`（表示该操作必须安全重跑或经人工确认后才能复用的状态）。不能因为快照恢复了，就假装 TCP connection（网络连接）、file descriptor（文件描述符）或子进程仍然有效。

## Linear 映射 / Linear Mapping

| 吸收项 / Absorption item | 既有 Linear issue / Existing Linear issue |
|---|---|
| Single-binary packaging（单文件打包）, release artifact matrix（发布产物矩阵）, hot update（热更新）, daemon lifecycle（守护进程生命周期） | `QUI-21` |
| DockerSandbox lifecycle（Docker 沙箱生命周期）, leases（租约）, labels（标签）, readiness probes（就绪探针）, gVisor optional runtime（可选 gVisor 运行时） | `QUI-62` |
| Daemon events（守护进程事件）, update events（更新事件）, sandbox state transitions（沙箱状态迁移）, resume traces（恢复追踪） | `QUI-20` |
| Devcontainer and continuous delivery drift checks（开发容器与持续交付漂移检查）, release docs automation（发布文档自动化） | `QUI-57` |
| Documentation drift evidence（文档漂移证据）, install matrix documentation（安装矩阵文档） | `QUI-76` |

English: No new Linear issue is required. The above work can fit the existing issue budget: `QUI-21` owns the component-level contract, `QUI-62` owns sandbox lifecycle implementation details, `QUI-20` owns observability, `QUI-57` owns process automation, and `QUI-76` owns documentation drift gates.

中文：不需要新建 Linear issue。上述工作可以复用现有 issue 额度：`QUI-21` 负责组件级契约，`QUI-62` 负责沙箱生命周期实现细节，`QUI-20` 负责可观测性，`QUI-57` 负责流程自动化，`QUI-76` 负责文档漂移门禁。

## F1（下一阶段运行时规模化实现）实施切片 / F1 Runtime Scale-Out Implementation Slice

English: F1（the next runtime scale-out implementation stage, where Quilin turns the frontier contract into production runtime behavior）should freeze the release and path contracts before adding cloud runtime scope. Acceptance criteria: `quilin --version --json` exposes build metadata; `quilin doctor --runtime` checks platform paths and Docker readiness; release artifacts are signed or attested; hot update can stage, verify, smoke-test, and report without applying by default; daemon status is read-only and idempotent.

中文：F1（下一阶段运行时规模化实现，目标是把前沿契约落成生产运行时行为）应先冻结发布和路径契约，再扩展云运行时范围。验收标准是：`quilin --version --json` 暴露构建元数据；`quilin doctor --runtime` 检查平台路径和 Docker 就绪状态；发布产物有签名或证明；热更新可以暂存、验证、冒烟测试和报告，但默认不直接应用；守护进程状态查询是只读且幂等的。

English: The second implementation slice should freeze sandbox lifecycle. Acceptance criteria: every sandbox has an owner, lease, label set, mount manifest, resource limits, network policy, readiness signal, cleanup deadline, and state-transition log; crash cleanup can remove orphaned sandboxes by label; plain Docker is the default and gVisor is an optional stricter runtime where available.

中文：第二个实现切片应冻结沙箱生命周期。验收标准是：每个沙箱都有归属、租约、标签集合、挂载清单、资源限制、网络策略、就绪信号、清理截止时间和状态迁移日志；崩溃清理可以通过标签移除孤儿沙箱；普通 Docker 是默认路径，gVisor 在可用时作为可选更严格运行时。

English: The third implementation slice should freeze suspend/resume. Acceptance criteria: sessions can enter `suspending`, `suspended`, `resuming`, and `needs_replay`; resume revalidates time, provider handles, adapter handles, and sandbox handles; cold restore works when a warm snapshot is absent; user-facing update and resume summaries are emitted after transitions.

中文：第三个实现切片应冻结暂停/恢复。验收标准是：会话可以进入 `suspending`、`suspended`、`resuming` 和 `needs_replay`；恢复会重新验证时间、模型供应商句柄、适配器句柄和沙箱句柄；没有热快照时冷恢复可用；状态迁移后会向用户输出更新和恢复摘要。

## 验证门禁 / Verification Gates

English: Minimum local verification for `QUI-21`: documentation lint, whitespace check, release-matrix dry-run, config-path matrix test, Docker readiness smoke test, daemon status idempotence test, hot-update staging dry-run, and sandbox orphan cleanup test. These are component hardening gates, not public benchmark gates.

中文：`QUI-21` 的最小本地验证包括：文档 lint（规则检查）、空白字符检查、发布矩阵 dry-run（试运行）、配置路径矩阵测试、Docker 就绪冒烟测试、守护进程状态幂等测试、热更新暂存 dry-run 和沙箱孤儿清理测试。这些是组件强化门禁，不是公开 benchmark（基准测试）门禁。

English: Minimum cross-platform verification: Linux systemd unit smoke, macOS launchd smoke, Windows service smoke, Docker image command matrix, development container rebuild, and GitHub Actions release artifact attestation. Failures must show the affected platform, logical path category, daemon state, sandbox state, and remediation command.

中文：最小跨平台验证包括：Linux systemd unit（系统服务单元）冒烟、macOS launchd 冒烟、Windows service（Windows 服务）冒烟、Docker 镜像命令矩阵、开发容器重建和 GitHub Actions 发布产物证明。失败信息必须展示受影响平台、逻辑路径类别、守护进程状态、沙箱状态和修复命令。

## 来源 / Sources

English: Source links used for this note: [Bun single-file executable](https://bun.sh/docs/bundler/executables), [Dev Container Specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-reference.md), [GitHub Copilot cloud-agent environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment), [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [Sigstore overview](https://docs.sigstore.dev/), [The Update Framework specification](https://theupdateframework.io/spec/), [Docker Engine API](https://docs.docker.com/reference/api/engine/), [gVisor docs](https://gvisor.dev/docs/), [Fly Machines suspend/resume](https://fly.io/docs/reference/suspend-resume/), [E2B auto-resume](https://e2b.dev/docs/sandbox/auto-resume), [Modal sandboxes](https://modal.com/docs/guide/sandboxes), [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/), [systemd sd_notify](https://www.freedesktop.org/software/systemd/man/sd_notify.html), [systemd directories](https://www.freedesktop.org/software/systemd/man/systemd.exec.html), and [Windows Service lifecycle](https://learn.microsoft.com/en-us/dotnet/framework/windows-services/introduction-to-windows-service-applications).

中文：本文使用的来源链接包括：[Bun 单文件可执行文件](https://bun.sh/docs/bundler/executables)、[Dev Container Specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-reference.md)、[GitHub Copilot cloud-agent 环境](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)、[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)、[Sigstore 概览](https://docs.sigstore.dev/)、[The Update Framework 规范](https://theupdateframework.io/spec/)、[Docker Engine API](https://docs.docker.com/reference/api/engine/)、[gVisor 文档](https://gvisor.dev/docs/)、[Fly Machines 暂停/恢复](https://fly.io/docs/reference/suspend-resume/)、[E2B 自动恢复](https://e2b.dev/docs/sandbox/auto-resume)、[Modal 沙箱](https://modal.com/docs/guide/sandboxes)、[Daytona 快照](https://www.daytona.io/docs/en/snapshots/)、[systemd sd_notify](https://www.freedesktop.org/software/systemd/man/sd_notify.html)、[systemd 目录](https://www.freedesktop.org/software/systemd/man/systemd.exec.html) 和 [Windows Service 生命周期](https://learn.microsoft.com/en-us/dotnet/framework/windows-services/introduction-to-windows-service-applications)。
