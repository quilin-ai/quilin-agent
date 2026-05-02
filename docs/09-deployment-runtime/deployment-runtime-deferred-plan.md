# 部署运行时延后路径 / Deployment Runtime Deferred Path

## 范围与边界 / Scope and Boundary

English: This document is the deferred runtime path for Linear `QUI-21`（the Linear issue that tracks deployment runtime packaging, hot update, development container, continuous delivery, daemon lifecycle, long-session sandbox resume, and release safety）. It only defines future runtime boundaries and acceptance gates. It is not an implementation record and it does not replace `docs/09-deployment-runtime/deployment-runtime-frontier-assimilation.md`, which captured the frontier evidence and competitor lessons.

中文：本文档是 Linear `QUI-21`（跟踪部署运行时打包、热更新、开发容器、持续交付、守护进程生命周期、长会话沙箱恢复和发布安全的 Linear issue）的延后运行时路径。它只定义未来运行时边界和验收门槛。它不是实现记录，也不替代 `docs/09-deployment-runtime/deployment-runtime-frontier-assimilation.md`，后者负责记录前沿证据和竞品经验。

English: The key distinction is operational: the frontier assimilation note says what Quilin should absorb; this deferred plan says when each capability is allowed to become runtime code. A deferred capability may be designed, documented, and reviewed now, but it should not be marked complete until the executable, tests, release jobs, and rollback paths exist.

中文：关键区别是操作层面的：前沿吸收文档说明 Quilin 应吸收什么；本延后计划说明每项能力什么时候才允许进入运行时代码。延后能力现在可以设计、记录和 review（复核），但在可执行文件、测试、发布任务和回滚路径存在之前，不能标为完成。

English: `QUI-21` should therefore remain open after this document lands. This document closes the planning gap, not the runtime implementation gap. The issue should only be marked Done after the single-binary artifact matrix, config hot update path, daemon lifecycle, long-session sandbox suspend/resume path, and release-safety gates are implemented and verified.

中文：因此，本文档落地后 `QUI-21` 仍应保持 open（未完成）。本文档关闭的是规划缺口，不是运行时实现缺口。只有当单二进制产物矩阵、配置热更新路径、守护进程生命周期、长会话沙箱暂停/恢复路径和发布安全门禁都已实现并验证后，才能把该 issue 标为 Done。

## 延后原则 / Deferred Principles

English: Deployment runtime work must be treated as a reliability boundary, not as packaging polish. A broken release artifact, a stuck update, a confused daemon, or a half-restored sandbox can corrupt user work even when the core agent loop is correct.

中文：部署运行时工作必须被视为 reliability boundary（可靠性边界），而不是打包美化。即使 core agent loop（核心智能体循环）本身正确，破损的发布产物、卡住的更新、混乱的守护进程或半恢复的沙箱仍然会破坏用户工作。

English: Runtime writes must remain explicit. A build artifact may embed default schemas, templates, and help text, but mutable state must stay under the platform path contract: config, state, cache, logs, runtime sockets, update staging, and sandbox scratch space are separate categories.

中文：运行时写入必须保持显式。构建产物可以嵌入默认 schema（结构约束）、模板和帮助文本，但可变状态必须落在平台路径契约下：配置、状态、缓存、日志、运行时 socket（套接字）、更新暂存区和沙箱临时空间是不同类别。

English: Every deferred runtime feature needs a dry-run mode before it can mutate user machines. The dry run must print planned writes, platform-specific service actions, release verification evidence, and rollback instructions in machine-readable JSON（JavaScript Object Notation，一种结构化数据格式）.

中文：每个延后运行时能力在改动用户机器前都需要 dry-run（试运行）模式。试运行必须以机器可读的 JSON（JavaScript Object Notation，一种结构化数据格式）输出计划写入、平台特定服务动作、发布验证证据和回滚说明。

English: The implementation order should be conservative: artifact identity first, path isolation second, read-only diagnostics third, staged mutation fourth, automatic mutation last. This order prevents a daemon or updater from changing state before Quilin can prove what it is about to change.

中文：实现顺序应保持保守：先做产物身份，再做路径隔离，再做只读诊断，再做分阶段变更，最后才做自动变更。这个顺序可以防止守护进程或更新器在 Quilin 证明即将改动什么之前就修改状态。

## 单二进制打包 / Single-Binary Packaging

English: Single-binary packaging（单二进制打包，即把命令行入口和运行时依赖编译成可直接执行的单个文件） should be the first release artifact path because Quilin's active core is TypeScript on Bun. Bun documents `--compile`, cross-target builds, build-time constants, embedded files, Windows-specific behavior, and macOS signing considerations, which gives Quilin a practical packaging base.

中文：single-binary packaging（单二进制打包，即把命令行入口和运行时依赖编译成可直接执行的单个文件）应成为第一条发布产物路径，因为 Quilin 当前核心是 TypeScript on Bun（用 Bun 运行 TypeScript）。Bun 文档覆盖 `--compile`、跨目标构建、构建期常量、嵌入文件、Windows 特定行为和 macOS 签名注意事项，这给 Quilin 提供了可落地的打包基础。

English: The deferred runtime contract is an artifact matrix, not a single happy-path binary. Minimum targets are `darwin-arm64`, `darwin-x64`, `linux-x64-baseline`, `linux-arm64`, `windows-x64`, and a Docker image for users who prefer container delivery. The Linux x64 baseline build matters because older CPUs can fail modern instruction-set builds.

中文：延后运行时契约是 artifact matrix（产物矩阵），不是一条顺利路径的单个二进制。最小目标包括 `darwin-arm64`、`darwin-x64`、`linux-x64-baseline`、`linux-arm64`、`windows-x64`，以及给偏好容器交付的用户使用的 Docker 镜像。Linux x64 baseline（基线构建）很重要，因为旧 CPU 可能无法运行依赖新指令集的构建。

English: The binary must expose identity before doing work. `quilin --version --json` should include product version, commit hash, build timestamp, target triple（operating system, CPU architecture, and runtime variant grouped as one target identity）, config schema version, bundled asset manifest digest, and release-channel name.

中文：二进制在执行工作前必须暴露身份。`quilin --version --json` 应包含产品版本、commit hash（提交哈希）、构建时间、target triple（把操作系统、CPU 架构和运行时变体组合成一个目标身份）、配置 schema 版本、内置资产清单摘要和发布通道名称。

English: Embedded assets must be deterministic. Build-time constants may identify the build, and embedded files may provide defaults, but the binary must not contain user secrets, model provider keys, session transcripts, memory stores, update state, or sandbox state. This prevents reinstalling or updating the binary from silently rewriting user data.

中文：嵌入资产必须是确定性的。构建期常量可以标识构建，嵌入文件可以提供默认值，但二进制不得包含用户 secret（密钥）、模型供应商 key（访问密钥）、会话转录、记忆存储、更新状态或沙箱状态。这样可以防止重装或更新二进制时静默改写用户数据。

English: The first acceptance gate is offline smoke. Each artifact must run without network and pass `--version --json`, `doctor --paths --json`, `config show --source --json`, and `runtime check --no-daemon --json`. These commands must not start a daemon, open a socket, create a sandbox, or download anything.

中文：第一道验收门槛是离线 smoke（冒烟验证）。每个产物必须在无网络条件下运行并通过 `--version --json`、`doctor --paths --json`、`config show --source --json` 和 `runtime check --no-daemon --json`。这些命令不得启动守护进程、打开 socket、创建沙箱或下载任何内容。

## 开发容器与持续交付 / Devcontainer and Continuous Delivery

English: Devcontainer（development container，开发容器） should be the canonical development environment contract, not only an editor convenience. The Dev Container metadata reference gives a stable shape for build, features, mounts, environment variables, lifecycle commands, and post-create setup. Quilin should use that shape to keep local development, cloud agent execution, and release jobs aligned.

中文：devcontainer（development container，开发容器）应成为标准开发环境契约，而不只是编辑器便利配置。Dev Container metadata reference（开发容器元数据参考）给出了 build（构建）、features（特性）、mounts（挂载）、环境变量、生命周期命令和创建后初始化的稳定形态。Quilin 应用这套形态来保持本地开发、云端 agent 执行和发布任务一致。

English: Continuous delivery（持续交付，即自动构建、验证、签名和发布产物的流程） should share one dependency declaration with local setup. `.devcontainer/devcontainer.json`, `just init`, GitHub Actions workflows, and release scripts must agree on Bun, CPython, Rust, pnpm, uv, Docker tooling, and platform-specific signing tools.

中文：Continuous delivery（持续交付，即自动构建、验证、签名和发布产物的流程）应与本地初始化共享同一份依赖声明。`.devcontainer/devcontainer.json`、`just init`、GitHub Actions workflow（工作流）和发布脚本必须在 Bun、CPython、Rust、pnpm、uv、Docker 工具以及平台特定签名工具上保持一致。

English: The deferred contract is a drift gate. A pull request that changes a runtime dependency version must update the development container, local setup, release workflow, and artifact smoke matrix together. If those files diverge, CI（continuous integration，持续集成） should fail before release packaging starts.

中文：延后契约是 drift gate（漂移门禁）。任何修改运行时依赖版本的 pull request（代码合并请求）都必须同时更新开发容器、本地初始化、发布 workflow 和产物冒烟矩阵。如果这些文件发生漂移，CI（continuous integration，持续集成）应在发布打包开始前失败。

English: Continuous delivery must produce three linked outputs: signed binaries, signed container images, and provenance records（machine-readable proof of which workflow and source revision produced an artifact）. GitHub artifact attestations and Sigstore-style signing should be used as the public verification path before users trust auto-update or manual installation.

中文：持续交付必须产出三类互相绑定的结果：已签名二进制、已签名容器镜像和 provenance records（机器可读的产物来源证明，说明哪个 workflow 和源码版本生成了产物）。GitHub artifact attestations（GitHub 产物证明）和 Sigstore-style signing（Sigstore 风格签名）应作为用户信任自动更新或手动安装前的公开验证路径。

## 配置热更新 / Config Hot Update

English: Config hot update（配置热更新，即在不完整重启进程的情况下重新加载安全配置子集） must be narrower than general config editing. Only fields marked reloadable by schema may change live. Examples include log level, tracing sample rate, dashboard endpoint, provider timeout, and non-secret display preferences.

中文：config hot update（配置热更新，即在不完整重启进程的情况下重新加载安全配置子集）必须比一般配置编辑更窄。只有 schema 标记为 reloadable（可重新加载）的字段才允许实时变更。例如日志级别、追踪采样率、dashboard endpoint（仪表盘端点）、供应商超时和非敏感显示偏好。

English: Static fields must trigger a restart-required result, not an implicit restart. Static fields include sandbox backend, filesystem root, model provider key sources, daemon listen address, release channel, and config schema version. Changing these while work is active can break safety assumptions, leases, or recovery handles.

中文：静态字段必须触发 restart-required（需要重启）的结果，而不是隐式重启。静态字段包括沙箱后端、文件系统根路径、模型供应商 key 来源、守护进程监听地址、发布通道和配置 schema 版本。在工作运行中修改这些字段可能破坏安全假设、租约或恢复句柄。

English: The hot update path should be a transaction: parse, validate, classify changed fields, redact secret-like values, compute an effective diff, ask `WriteAuthority`（the write gate that decides whether an agent-initiated mutation is allowed）, apply reloadable fields, emit an audit event, then publish the new runtime generation number.

中文：热更新路径应是一个 transaction（事务）：解析、校验、分类变更字段、遮蔽类似 secret 的值、计算生效 diff（差异）、请求 `WriteAuthority`（判断 agent 发起写入是否允许的写入门禁）、应用可热更新字段、输出审计事件，然后发布新的 runtime generation number（运行时代数）。

English: Partial failure must be explicit. If one reloadable field fails, Quilin should keep the previous generation active, report the rejected field, preserve the validated candidate in a staging record, and leave a remediation command. It should not apply half of a config change and then ask the user to infer the final state.

中文：部分失败必须显式。如果某个可热更新字段失败，Quilin 应保持上一代配置有效，报告被拒字段，把已验证候选配置保存在 staging record（暂存记录）里，并留下修复命令。它不能应用一半配置后让用户自己推断最终状态。

English: The acceptance gate is a reload matrix. Tests must cover no-op reload, valid dynamic reload, static-field rejection, malformed file rejection, secret redaction, concurrent reload serialization, rollback to previous generation, and daemon status reporting the active generation without mutating state.

中文：验收门槛是 reload matrix（重载矩阵）。测试必须覆盖无变更重载、有效动态重载、静态字段拒绝、格式错误文件拒绝、密钥遮蔽、并发重载串行化、回滚到上一代，以及守护进程状态在不变更状态的情况下报告当前生效代数。

## 守护进程运行时决策 / Daemon Runtime Decisions

English: Daemon runtime（守护进程运行时，即长期驻留并负责后台协调的进程模式） should not be the default execution mode. The default remains foreground single-task or interactive execution. Daemon mode is only justified when Quilin needs long-lived adapters, background task supervision, WebUI dashboard streaming, scheduled update checks, or durable subagent coordination.

中文：daemon runtime（守护进程运行时，即长期驻留并负责后台协调的进程模式）不应成为默认执行模式。默认仍然是前台单任务或交互式执行。只有当 Quilin 需要长期适配器、后台任务监督、WebUI dashboard（网页仪表盘）流式状态、定时更新检查或持久 subagent（子智能体）协调时，守护进程模式才成立。

English: The daemon state machine should be explicit: `starting`, `ready`, `running`, `reloading`, `draining`, `suspending`, `suspended`, `resuming`, `stopping`, and `failed`. A process identifier file is advisory only; ownership must come from a lock, heartbeat, supervisor integration, and child-process accounting.

中文：守护进程状态机应保持显式：`starting`、`ready`、`running`、`reloading`、`draining`、`suspending`、`suspended`、`resuming`、`stopping` 和 `failed`。process identifier file（进程标识符文件）只能作为提示；归属必须来自锁、心跳、监督器集成和子进程计数。

English: Platform integration should preserve one logical model. On Linux, systemd readiness notification and watchdog behavior can map to `ready` and heartbeat health. On macOS, launchd can own keepalive behavior. On Windows, Service Control Manager can own service states. The user-facing CLI must still show the same Quilin states across platforms.

中文：平台集成应保持同一套逻辑模型。在 Linux 上，systemd readiness notification（就绪通知）和 watchdog（看门狗）行为可以映射到 `ready` 和心跳健康。在 macOS 上，launchd 可以负责保活行为。在 Windows 上，Service Control Manager（服务控制管理器）可以负责服务状态。面向用户的 CLI 仍必须在各平台展示同一套 Quilin 状态。

English: Read-only daemon commands must stay read-only. `quilin status`, `quilin doctor`, `quilin config show`, `quilin logs`, and `quilin runtime inspect` must never start, restart, reload, or kill the daemon. They may report stale locks, missing heartbeat, orphaned children, pending update, or required remediation.

中文：只读守护进程命令必须保持只读。`quilin status`、`quilin doctor`、`quilin config show`、`quilin logs` 和 `quilin runtime inspect` 绝不能启动、重启、重载或杀掉守护进程。它们可以报告过期锁、心跳缺失、孤儿子进程、待处理更新或所需修复动作。

English: Mutating daemon commands require an intent and a drain policy. `quilin daemon restart` must say whether it drains running tasks, cancels them, or refuses because active work cannot be safely resumed. The command should output affected task identifiers, adapter identifiers, sandbox leases, and the expected recovery path.

中文：会修改状态的守护进程命令需要明确 intent（意图）和 drain policy（排空策略）。`quilin daemon restart` 必须说明它会排空运行任务、取消任务，还是因为活跃工作无法安全恢复而拒绝执行。该命令应输出受影响任务标识、适配器标识、沙箱租约和预期恢复路径。

## 长会话沙箱暂停与恢复 / Long-Session Sandbox Suspend and Resume

English: Long-session sandbox suspend/resume（长会话沙箱暂停/恢复，即把长期任务的执行环境安全暂停并在之后恢复） must treat warm resume as an optimization, not as the correctness model. Fly Machines, E2B, Modal, and Daytona show useful patterns around machine suspend, activity-triggered resume, sandbox lifetime, and snapshots, but Quilin must persist enough durable state to recover when a warm snapshot is unavailable.

中文：long-session sandbox suspend/resume（长会话沙箱暂停/恢复，即把长期任务的执行环境安全暂停并在之后恢复）必须把 warm resume（从内存或进程快照快速恢复）当作优化，而不是正确性模型。Fly Machines、E2B、Modal 和 Daytona 展示了机器暂停、活动触发恢复、沙箱生命周期和快照的有用模式，但 Quilin 必须持久化足够的 durable state（可恢复状态），以便在热快照不可用时仍能恢复。

English: Durable state includes task plan, active tool calls, pending approvals, memory checkpoints, sandbox lease metadata, mounted paths, environment fingerprint, dependency manifest, provider connection policy, and the last user-visible checkpoint. It does not include live file descriptors, TCP connections, child process handles, browser process handles, or open Docker exec streams.

中文：可恢复状态包括任务计划、活跃工具调用、待批准项、记忆 checkpoint（检查点）、沙箱租约元数据、挂载路径、环境 fingerprint（指纹）、依赖清单、供应商连接策略和最后一个用户可见 checkpoint。它不包括活跃 file descriptor（文件描述符）、TCP connection（网络连接）、子进程句柄、浏览器进程句柄或打开中的 Docker exec stream（Docker 执行流）。

English: Resume must be a revalidation pipeline. Quilin should revalidate wall-clock time, monotonic-clock drift, release version, config generation, sandbox lease, filesystem digest, dependency manifest, model-provider availability, adapter connectivity, and outstanding approvals. Any operation that cannot be proven safe becomes `needs_replay`（a state meaning the operation must be rerun safely or reviewed before reuse）.

中文：恢复必须是 revalidation pipeline（重新验证流水线）。Quilin 应重新验证墙上时间、单调时钟漂移、发布版本、配置代数、沙箱租约、文件系统摘要、依赖清单、模型供应商可用性、适配器连接性和未完成批准项。任何无法证明安全的操作都进入 `needs_replay`（表示该操作必须安全重跑或先经复核才能复用的状态）。

English: Suspend must be explicit about user impact. Before suspension, Quilin should record which work is safe to pause, which work must drain, which work must be cancelled, and which external side effects are already committed. After resume, Quilin should summarize restored tasks, replay-required tasks, dropped connections, and suggested next commands.

中文：暂停必须明确用户影响。暂停前，Quilin 应记录哪些工作可以安全暂停、哪些工作必须排空、哪些工作必须取消，以及哪些外部副作用已经提交。恢复后，Quilin 应总结已恢复任务、需要 replay（重放）的任务、已断开的连接和建议的下一步命令。

English: The acceptance gate is a suspend/resume matrix. Tests must cover warm resume, cold restore, missing sandbox snapshot, changed release version, changed config generation, missing adapter, expired provider token, interrupted file write, and a non-resumable tool call moving to `needs_replay`.

中文：验收门槛是 suspend/resume matrix（暂停/恢复矩阵）。测试必须覆盖热恢复、冷恢复、沙箱快照缺失、发布版本变化、配置代数变化、适配器缺失、供应商 token（令牌）过期、文件写入中断，以及不可恢复工具调用进入 `needs_replay`。

## 发布安全 / Release Safety

English: Release safety（发布安全，即确保产物来源、版本迁移、更新应用和回滚路径可验证的发布控制） must be built before automatic update. Manual install can rely on user choice, but automatic update needs artifact identity, signature verification, provenance verification, staged smoke, rollback metadata, and user-visible change reporting.

中文：release safety（发布安全，即确保产物来源、版本迁移、更新应用和回滚路径可验证的发布控制）必须先于自动更新实现。手动安装可以依赖用户选择，但自动更新需要产物身份、签名验证、来源证明验证、暂存冒烟、回滚元数据和用户可见的变更报告。

English: The Update Framework（TUF, a secure-update metadata framework that separates signing roles and resists rollback） should shape the update manifest even if the first implementation is smaller than the full ecosystem. Minimum fields are version, channel, artifact digest, signing identity, build provenance identifier, config schema range, state migration range, minimum runtime version, expiry, and rollback target.

中文：The Update Framework（TUF，一个通过签名角色隔离和回滚防护保护更新元数据的安全更新框架）应塑造更新清单，即使第一版实现小于完整生态。最小字段包括版本、通道、产物摘要、签名身份、构建来源证明标识、配置 schema 范围、状态迁移范围、最低运行时版本、过期时间和回滚目标。

English: Updates should be staged, verified, smoke-tested, then applied. The updater downloads into a versioned staging directory, verifies signatures and provenance, checks compatibility, runs offline smoke from the staged artifact, drains or refuses active daemon work according to policy, flips the launcher, and preserves the previous version for rollback.

中文：更新应先暂存、验证、冒烟测试，然后应用。更新器下载到按版本命名的 staging directory（暂存目录），验证签名和来源证明，检查兼容性，从暂存产物运行离线冒烟测试，按策略排空或拒绝活跃守护进程工作，切换启动入口，并保留上一版本用于回滚。

English: Windows replacement needs a helper path because active executables can be locked by the running process. macOS replacement needs code-signing and notarization checks before trust. Linux service replacement needs integration with supervisor readiness and rollback. These are platform-specific mechanics behind one logical update contract.

中文：Windows 替换需要 helper path（辅助进程路径），因为运行中的可执行文件可能被当前进程锁定。macOS 替换需要先检查 code signing（代码签名）和 notarization（公证）。Linux 服务替换需要和监督器就绪状态及回滚集成。这些是同一逻辑更新契约背后的平台特定机制。

English: After update or rollback, Quilin must tell the user what happened: old version, new version, release channel, migration result, daemon action, sessions resumed, sessions requiring replay, failed adapter reconnects, and where the verification evidence lives. Silent update is not acceptable for an agent that can mutate user workspaces.

中文：更新或回滚后，Quilin 必须告诉用户发生了什么：旧版本、新版本、发布通道、迁移结果、守护进程动作、已恢复会话、需要重放的会话、失败的适配器重连，以及验证证据位置。对于能修改用户工作区的 agent（智能体），静默更新不可接受。

## 实施切片 / Implementation Slices

English: Slice 1 is artifact identity and path safety. It includes `--version --json`, deterministic embedded assets, platform path resolution, offline smoke commands, and a release-matrix dry run. This slice does not start daemon mutation or auto-update.

中文：切片 1 是产物身份和路径安全。它包括 `--version --json`、确定性嵌入资产、平台路径解析、离线冒烟命令和发布矩阵试运行。该切片不启动守护进程变更或自动更新。

English: Slice 2 is development and delivery drift control. It aligns devcontainer, `just init`, continuous integration, continuous delivery, release scripts, and artifact smoke. The key output is a drift failure before any signed artifact is published.

中文：切片 2 是开发与交付漂移控制。它对齐开发容器、`just init`、持续集成、持续交付、发布脚本和产物冒烟。关键输出是在任何签名产物发布前触发漂移失败。

English: Slice 3 is read-only daemon diagnostics. It adds daemon state inspection, stale-lock detection, heartbeat inspection, child-process accounting, and pending-update reporting. All commands in this slice are non-mutating.

中文：切片 3 是只读守护进程诊断。它增加守护进程状态检查、过期锁检测、心跳检查、子进程计数和待处理更新报告。该切片中的所有命令都不修改状态。

English: Slice 4 is config hot update. It adds schema reloadability markers, generation tracking, transactional reload, `WriteAuthority` gating, audit events, rollback to previous generation, and restart-required reporting for static fields.

中文：切片 4 是配置热更新。它增加 schema 可热更新标记、代数跟踪、事务式重载、`WriteAuthority` 门禁、审计事件、回滚到上一代，以及静态字段的需要重启报告。

English: Slice 5 is suspend/resume. It adds durable session state, sandbox lease snapshots, resume revalidation, `needs_replay`, user-facing resume summary, and recovery tests for lost snapshots and changed runtime versions.

中文：切片 5 是暂停/恢复。它增加持久会话状态、沙箱租约快照、恢复重新验证、`needs_replay`、面向用户的恢复总结，以及针对快照丢失和运行时版本变化的恢复测试。

English: Slice 6 is staged update and rollback. It adds manifest verification, signature and provenance checks, staged smoke, daemon drain policy, launcher flip, rollback preservation, and post-update user reporting.

中文：切片 6 是分阶段更新与回滚。它增加清单验证、签名与来源证明检查、暂存冒烟、守护进程排空策略、启动入口切换、回滚保留和更新后用户报告。

## 验收门槛 / Acceptance Gates

English: Single-binary acceptance: every target artifact exists, `--version --json` reports the expected identity fields, offline smoke passes without network, embedded asset digest is stable across reproducible builds, and no mutable runtime path points into the source checkout.

中文：单二进制验收：每个目标产物都存在，`--version --json` 报告预期身份字段，离线冒烟在无网络条件下通过，嵌入资产摘要在可复现构建中稳定，并且没有可变运行时路径指向源码 checkout（检出目录）。

English: Devcontainer and delivery acceptance: local setup, development container setup, continuous integration, and release workflow share dependency versions; release jobs fail on drift; signed binaries, signed container images, and provenance records are produced as one release bundle.

中文：开发容器与交付验收：本地初始化、开发容器初始化、持续集成和发布 workflow 共享依赖版本；发布任务在漂移时失败；已签名二进制、已签名容器镜像和来源证明记录作为同一个发布包产出。

English: Config hot update acceptance: reloadable fields update without restart, static fields return restart-required, malformed config leaves the previous generation active, secrets are redacted in diffs, concurrent reloads serialize, and daemon status reports the active generation without changing it.

中文：配置热更新验收：可热更新字段无需重启即可更新，静态字段返回需要重启，格式错误配置保持上一代生效，diff 中密钥被遮蔽，并发重载被串行化，守护进程状态报告当前代数但不修改它。

English: Daemon acceptance: read-only commands never start or restart the daemon, mutating commands require explicit intent, stale lock detection is observable, heartbeat loss is observable, child-process leaks are counted, and platform service integration maps to the same Quilin state machine.

中文：守护进程验收：只读命令绝不启动或重启守护进程，会修改状态的命令需要明确意图，过期锁可观测，心跳丢失可观测，子进程泄漏可计数，平台服务集成映射到同一套 Quilin 状态机。

English: Suspend/resume acceptance: warm resume works when available, cold restore works when snapshots are missing, unsafe handles are rebuilt or invalidated, non-resumable operations become `needs_replay`, and the user receives a concise resume report.

中文：暂停/恢复验收：有热快照时热恢复可用，缺失快照时冷恢复可用，不安全句柄会被重建或失效，不可恢复操作进入 `needs_replay`，用户收到简明恢复报告。

English: Release safety acceptance: updates verify signature and provenance before staging, staged smoke passes before activation, active daemon work is drained or refused according to policy, rollback target is preserved, and post-update reporting names changed versions, migrations, resumed sessions, and replay-required sessions.

中文：发布安全验收：更新在暂存前验证签名和来源证明，激活前通过暂存冒烟，活跃守护进程工作按策略排空或被拒绝，回滚目标被保留，更新后报告列出变更版本、迁移、已恢复会话和需要重放的会话。

## 非目标 / Non-Goals

English: This document does not promote public benchmark work. Benchmark（基准测试，即用固定任务集衡量能力的评测） is frozen unless the user explicitly asks for it. Deployment runtime must first become trustworthy through local component evidence.

中文：本文档不推进公开 benchmark（基准测试，即用固定任务集衡量能力的评测）工作。除非用户明确要求，Benchmark 已冻结。部署运行时必须先通过本地组件实证变得足够可信。

English: This document does not choose a cloud sandbox vendor. E2B, Modal, Daytona, Fly Machines, Docker, and stronger sandbox runtimes provide useful contract shapes, but the core runtime should keep a provider-neutral interface until local lifecycle guarantees are complete.

中文：本文档不选择云沙箱供应商。E2B、Modal、Daytona、Fly Machines、Docker 和更强沙箱运行时提供了有用的契约形态，但核心运行时应在本地生命周期保障完成前保持 provider-neutral interface（供应商中立接口）。

English: This document does not authorize automatic scaffold writes. Any implementation in `packages/`, `providers/`, `crates/`, release workflows, or config schemas must still go through human-reviewed changes and project verification.

中文：本文档不授权自动 scaffold write（脚手架写入）。任何落在 `packages/`、`providers/`、`crates/`、发布 workflow 或配置 schema 的实现仍必须走 human-reviewed changes（人工复核变更）和项目验证。

## Linear 映射 / Linear Mapping

English: `QUI-21` remains the parent record for Deployment runtime deferred work. No new Linear issue is required for this document. Subtasks should be tracked as comments or child work under existing issues unless a future implementation slice needs independent ownership, blockers, or acceptance criteria.

中文：`QUI-21` 继续作为 Deployment runtime（部署运行时）延后工作的父级记录。本文档不需要新建 Linear issue。子任务应优先通过已有 issue 下的 comment（评论）或子工作跟踪，除非未来某个实现切片需要独立负责人、阻塞关系或验收标准。

English: Related existing records are `QUI-62` for sandbox router and Docker lifecycle implementation, `QUI-20` for observability backend and dashboard visibility, `QUI-57` for docs and process automation, `QUI-76` for documentation verification gates, and `QUI-47` for benchmark target reassessment.

中文：相关既有记录包括：`QUI-62` 负责沙箱路由和 Docker 生命周期实现，`QUI-20` 负责可观测性后端和仪表盘可见性，`QUI-57` 负责文档与流程自动化，`QUI-76` 负责文档验证门禁，`QUI-47` 负责基准测试目标重评估。

English: `QUI-21` should not be marked Done after this planning artifact. It becomes Done only when the runtime code and release jobs prove the acceptance gates above with command output, test counts, artifact identifiers, and rollback evidence.

中文：本规划产物完成后不应把 `QUI-21` 标为 Done。只有当运行时代码和发布任务用命令输出、测试数量、产物标识和回滚证据证明上述验收门槛后，`QUI-21` 才能标为 Done。

## 来源 / Sources

English: Official and primary sources used for this deferred plan: [Bun single-file executable](https://bun.sh/docs/bundler/executables), [Dev Container metadata reference](https://containers.dev/implementors/json_reference/), [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [Sigstore overview](https://docs.sigstore.dev/), [The Update Framework specification](https://theupdateframework.github.io/specification/latest/), [systemd sd_notify](https://www.freedesktop.org/software/systemd/man/sd_notify.html), [systemd execution directories](https://www.freedesktop.org/software/systemd/man/256/systemd.exec.html), [Windows Service applications](https://learn.microsoft.com/en-us/dotnet/framework/windows-services/introduction-to-windows-service-applications), [Fly Machines suspend/resume](https://fly.io/docs/reference/suspend-resume/), [E2B auto-resume](https://e2b.dev/docs/sandbox/auto-resume), [Modal sandboxes](https://modal.com/docs/guide/sandboxes), and [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/).

中文：本延后计划使用的一手和官方来源包括：[Bun 单文件可执行文件](https://bun.sh/docs/bundler/executables)、[Dev Container 元数据参考](https://containers.dev/implementors/json_reference/)、[GitHub 产物证明](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)、[Sigstore 概览](https://docs.sigstore.dev/)、[The Update Framework 规范](https://theupdateframework.github.io/specification/latest/)、[systemd sd_notify](https://www.freedesktop.org/software/systemd/man/sd_notify.html)、[systemd 执行目录](https://www.freedesktop.org/software/systemd/man/256/systemd.exec.html)、[Windows Service applications](https://learn.microsoft.com/en-us/dotnet/framework/windows-services/introduction-to-windows-service-applications)、[Fly Machines 暂停/恢复](https://fly.io/docs/reference/suspend-resume/)、[E2B 自动恢复](https://e2b.dev/docs/sandbox/auto-resume)、[Modal 沙箱](https://modal.com/docs/guide/sandboxes) 和 [Daytona 快照](https://www.daytona.io/docs/en/snapshots/)。
