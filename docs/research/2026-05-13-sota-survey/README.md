# 业界最强方案调研 / Industry SOTA Survey

**调研日期 / Date**: 2026-05-13
**触发 / Trigger**: 用户要求 Quilin Agent 在每一个架构维度都做到业界最强。横向对比 Claude Code (v2.1.88) / Codex (OpenAI) / Hermes Agent / OpenClaw / Quilin 之后，识别出 14 个待补维度，分 6 组深度调研。
**Trigger**: User wants Quilin Agent to be industry-strongest in every architectural dimension. After horizontal comparison of Claude Code (v2.1.88) / Codex (OpenAI) / Hermes Agent / OpenClaw / Quilin, 14 dimensions identified for deep research, organized into 6 clusters.

## 调研方法 / Methodology

每个集群由独立 deep-research subagent 负责，使用 WebSearch + WebFetch 抓取 2025-2026 最新公开数据，输出双语 markdown。每个候选方案必须给出：一句话原理、架构草图、License、维护状态、性能特征、Quilin 集成成本、风险。

Each cluster is handled by an independent deep-research subagent using WebSearch + WebFetch for 2025-2026 public data, output as bilingual markdown. Each candidate must include: one-line principle, architecture sketch, license, maintenance status, performance characteristics, Quilin integration cost, risk.

## 集群索引 / Cluster Index

| # | 集群 / Cluster | 涵盖维度 / Dimensions | 文件 / File | 状态 / Status |
|---|---|---|---|---|
| 01 | 执行隔离 / Execution Isolation | Sandbox / 持久 Shell / 权限模型 | [01-execution-isolation.md](./01-execution-isolation.md) | ✅ done (4,600 字) |
| 02 | 能力原语 / Capability Primitives | 工具系统 / MCP 生态 | [02-capability-primitives.md](./02-capability-primitives.md) | ✅ done (5,755 字) |
| 03 | 记忆 / Memory | 4-tier / KG / 向量 / reranker / 反思 | _pending_ | ⚠️ 撞限速 + 主动 stop，下面是 interim 速写 |
| 04 | 协同 / Coordination | Multi-Agent / Cross-Agent | _pending_ | ⚠️ 撞限速 + 主动 stop，下面是 interim 速写 |
| 05 | 学习扩展 / Learning & Extension | Skills / Self-Evolution | _pending_ | ⚠️ 撞限速 + 主动 stop，下面是 interim 速写 |
| 06 | 运维表面 / Operability | UI / Observability / Cross-Language / Testing | _pending_ | ⚠️ 撞限速 + 主动 stop，下面是 interim 速写 |

## 14 个维度回顾 / 14 Dimensions

1. **沙箱 / Sandbox** — OS 级进程隔离 (sandbox-exec / bwrap / landlock / gVisor / Firecracker / WASM)
2. **持久 Shell / Persistent Shell** — 交互会话 + 状态保留 + 进度流
3. **权限模型 / Permission Model** — mode-based + per-tool approval + capability tokens
4. **工具系统 / Tool Surface** — LSP / 语义搜索 / 一等公民 Glob/Grep / Notebook / Cron
5. **MCP 生态 / MCP Ecosystem** — bidirectional client+server / Resources / federation
6. **记忆 / Memory** — episodic / semantic / KG / 反思 / 个人画像
7. **多 Agent / Multi-Agent** — supervisor / graph-based / concurrent / approval inheritance
8. **跨 Agent 协作 / Cross-Agent Collaboration** — A2A / ACP / agent bridge / MCP federation
9. **Skills / Skills** — progressive disclosure / marketplace / agentskills.io 标准
10. **自我进化 / Self-Evolution** — Voyager skill library / Reflexion / SELF-DISCOVER / OS-Copilot
11. **UI** — Ink / Ratatui / Bubble Tea / Web dashboard / IDE 扩展
12. **可观测性 / Observability** — OTel / Langfuse / LangSmith / Helicone / Phoenix / Braintrust
13. **跨语言 / Cross-Language** — gRPC / Tonic / capnp / IPC / FFI / NATS / Temporal
14. **测试纪律 / Testing Discipline** — coverage gate / mutation / deterministic LLM testing / property-based

## 综合执行摘要 / Synthesis (Interim, 2026-05-13)

> **状态说明**：C1 / C2 是经 WebSearch + 源码 grep 的深度调研产物（数据可信）；C3 / C4 / C5 / C6 是 agent 撞 Claude Pro 5h 配额墙、被主线主动 stop 之前未落档的速写——下面这部分由主 agent 用训练知识 + 5 仓库实证对比补出，**未经 2025-2026 新数据 web 验证**，需要后续 session 重跑或人工补充。
>
> **Status**: C1 / C2 are deep research outputs (WebSearch + source-grep verified, trustworthy). C3 / C4 / C5 / C6 are interim summaries written by the main agent from training knowledge + the 5-repo comparison, **NOT yet verified against 2025-2026 web data**. Re-run in a future session or supplement manually.

### 14 维度推荐方案表 / Per-Dimension Recommendation Table

| # | 维度 / Dimension | 推荐 SOTA / Recommended SOTA | 一句话理由 / One-Line Rationale | 数据来源 / Source | 人日 / Person-Days |
|---|---|---|---|---|---|
| 1 | OS 沙箱 / Sandbox | `sandbox-exec` (macOS) + `bwrap`+landlock (Linux) | 跟 Claude Code/Codex 同款；gVisor/Firecracker v1 拒；Apple Container 26 fast-follow | C1 ✅ | 10-14 |
| 2 | 持久 Shell / Persistent Shell | 照搬 Codex `unified_exec` 设计到 `node-pty@1.1.0`，两工具 `shell_start` + `shell_input`，64 进程上限，1 MiB head/tail 缓冲 | Codex 已经把 corner case 跑稳；wheel 不重造 | C1 ✅ | 7-10 |
| 3 | 权限模型 / Permission Model | execpolicy-style Starlark `.rules` 文件 + 3 模式 (`ask`/`auto`/`bypass`)；WriteAuthority 留作运行时 gate；JSONL 审计日志 | 不照抄 Claude 6-mode UI（过度工程化）；vendor Codex grammar 避免上游 break | C1 ✅ | 12-16 |
| 4 | 工具系统 / Tool Surface | 10 工具按依赖序加：Glob → Grep (`@vscode/ripgrep`) → LSP → Sleep → Cron → NotebookEdit → SendMessage → TreeSitter → TeamCreate → MultimodalOutput | Grep+LSP 是 CRITICAL（其他 agent 5-10× token 效率领先）；Glob 解锁后续所有列文件工具 | C2 ✅ | 32-36 |
| 5 | MCP 生态 / MCP Ecosystem | 5 阶段双向化：(1) Resources+Prompts 客户端 (2) Elicitation (3) Quilin-as-stdio-server (4) Streamable HTTP+OAuth (5) MCP Apps + 注册表 | 不双向无法被 Claude Desktop/Cursor/Goose 消费，生态封闭 | C2 ✅ | 35-50 |
| 6 | 记忆 / Memory | **保持现有 4-tier 主干**，三件事补强：(a) 引入 **Graphiti** (Zep OSS KG 引擎) 替换或并跑当前 `kg.py`；(b) 加 **HippoRAG**-式神经-符号联合检索；(c) 仿 Hermes **trajectory_compressor** 实现 episode 压缩与经验回放 | Quilin 已经是 5 家最重的；缺的是学术 SOTA 落地（HippoRAG）+ 工程 SOTA 落地（trajectory compress） | interim ⚠️ | 25-35 |
| 7 | 多 Agent / Multi-Agent | **LangGraph 风格的 graph-based supervisor**（不引 LangChain，自研 200 LOC graph runtime） + 把 Codex `multi_agents_v2` 的 concurrent 图执行模式搬过来 | OpenClaw ACP 太重；LangGraph API 已是事实标准；非阻塞 supervisor 是 Quilin 已声明意图 | interim ⚠️ | 15-20 |
| 8 | 跨 Agent 协作 / Cross-Agent | **Google A2A 协议**作为对外标准 + 现有 AgentBridge 作为本机 fast path + MCP federation 走 Smithery/mcphub 风格 aggregator | A2A 是 2025 Google 推的开放标准，未来生态会聚集；现有 AgentBridge 留作 Claude↔Codex 私通路 | interim ⚠️ | 10-15 |
| 9 | Skills / Skills | 在现有 M0/M1 上补 3 件事：(a) **Anthropic SKILL.md 兼容**（agentskills.io 跨厂商）；(b) Hermes **progressive disclosure**（list → view → full）；(c) skill **signature/provenance** (cosign 风格) | Quilin 已经有 manifest+provenance 骨架；补 spec 兼容拿 Anthropic+Hermes+ClawHub 生态 | interim ⚠️ | 8-12 |
| 10 | 自我进化 / Self-Evolution | **Voyager skill library 模式**（成功 trajectory → 自动归纳成 skill）+ **Reflexion**（episode-end 自我批评）+ Hermes **trajectory_compressor** 工程版 + HITL gate 严守（idle evolution 默认 OFF 不变）| 学术 + 工程 + 安全三件套；不引入 RL 训练（太重） | interim ⚠️ | 30-45 |
| 11 | UI | TUI: **Ink** (TS-native, Claude Code 同款)；Web: 保持 **Next.js 15**；IDE: 仿 **Cline** 模式做 VSCode 扩展（Iter F 候选） | Ratatui 要切 Rust 太重；Ink 与现有 TS core 同栈；Cline 已证明 VSCode 扩展是 agent 关键投放面 | interim ⚠️ | 20-30 |
| 12 | 可观测性 / Observability | **OpenTelemetry GenAI semantic conventions** 原生 + 自托管 **Langfuse** 实例作为 dashboard / replay 后端 | 现有 22 文件 obs 已经是 OTel-style；Langfuse 是开源 self-host SOTA，能替换 LangSmith 商业方案；Phoenix/Braintrust 也行但 Langfuse 生态最大 | interim ⚠️ | 8-12 |
| 13 | 跨语言 / Cross-Language | 保持现状（MCP stdio TS↔Py）+ Rust 部分用 **NAPI-RS** 暴露到 TS（不要 PyO3 经 Python 中转）；Mesh 走 **gRPC + Tonic** | NAPI-RS 是 2024-2026 的 Rust↔Node 事实标准；Bazel 太重不引 | interim ⚠️ | 5-8（基建打通） |
| 14 | 测试纪律 / Testing | 95% 硬门槛保持；加 **VCR-style LLM fixture replay**（自研轻量版，~300 LOC）+ **promptfoo** 做 eval harness + 跑 **τ-Bench** 公开评分 | Quilin 已经在 5 家里最严；缺 deterministic LLM testing 模式；mutation testing 暂不加（成本太高） | interim ⚠️ | 8-12 |

### Iter G 候选项（按优先级排序）/ Iter G Candidates (Priority Order)

按"补硬基建优先 > 拉生态优先 > 学术差异化优先"排序：

Ranked by "fix hard infra first > extend ecosystem reach > academic differentiation":

| 优先级 | 工作项 | 集群 | 累计人日 | 解锁价值 / Unlocks |
|---|---|---|---|---|
| **P0** | OS 沙箱（macOS sandbox-exec + Linux bwrap+landlock） | C1 | 10-14 | 沙箱评分 2→8；让 idle evolution 真敢开 |
| **P0** | Glob + Grep + LSP（CRITICAL 三件套） | C2 | 10 | 跨文件任务 token 效率 5-10× |
| **P0** | 持久 Shell（unified_exec on node-pty） | C1 | 7-10 | 解锁交互式 REPL / 长跑任务进度流 |
| **P1** | 权限 `.rules` + 3-mode 状态栏 | C1 | 12-16 | 把 CLAUDE.md 的 AUTO 承诺变成外部可审计产物 |
| **P1** | MCP 双向化 Stage 1-2（Resources + Prompts + Elicitation 客户端） | C2 | 14（2 周） | 第三方 MCP 资源变一等 context |
| **P1** | Sleep + Cron + NotebookEdit + SendMessage（autonomous loop 必需） | C2 | 12 | 解锁 /loop 永不停 + Notebook ML 工作流 |
| **P2** | 记忆补强：Graphiti + HippoRAG + trajectory_compressor | C3 ⚠️ | 25-35 | 把 Quilin 在记忆维度从"业界最重"变成"业界最强" |
| **P2** | 自进化 Voyager + Reflexion + HITL gate 工程化 | C5 ⚠️ | 30-45 | 把 self-evolution 从 designed 变成 production |
| **P2** | Skills SKILL.md 兼容 + progressive disclosure + signing | C5 ⚠️ | 8-12 | 接入 agentskills.io 生态 |
| **P2** | LangGraph 风格 graph supervisor + concurrent multi-agent | C4 ⚠️ | 15-20 | 把非阻塞 supervisor 设计兑现为代码 |
| **P3** | MCP 双向化 Stage 3-5（Quilin-as-server + HTTP + 注册表） | C2 | 25-35 | 让 Quilin 被 Claude Desktop / Cursor / Goose 消费 |
| **P3** | Google A2A + MCP federation | C4 ⚠️ | 10-15 | 跨厂商 agent 协作标准接入 |
| **P3** | Ink TUI 重写 + Cline 风格 VSCode 扩展 | C6 ⚠️ | 20-30 | 投放面：终端 + IDE 双管齐下 |
| **P3** | OTel GenAI conventions + Langfuse self-host | C6 ⚠️ | 8-12 | dashboard / replay / cost attribution |
| **P3** | NAPI-RS Rust↔TS 桥 | C6 ⚠️ | 5-8 | 解锁 Iter F mesh 真上 Rust |
| **P3** | VCR LLM fixture + promptfoo + τ-Bench 跑分 | C6 ⚠️ | 8-12 | 把"测试通过 ≠ ship ready"的纪律补齐 |

**总预算**：P0 三件套 27-34 人日；加 P1 约 65-78 人日；P0+P1+P2 全做约 145-180 人日；全部 14 维度做到业界最强约 200-250 人日。

**Total budget**: P0 three items = 27-34 person-days; +P1 = ~65-78; +P2 = ~145-180; all 14 dims = ~200-250 person-days.

### 三条战略观察 / Three Strategic Observations

1. **Quilin 跟 Claude Code/Codex 的差距集中在硬基建（沙箱 + Shell + 工具表面），不在"agent 智能"。** P0 三件套全做完，Quilin 在执行隔离和工具表面就能追平第一梯队；后面的 P1/P2 都是拉差异化。

   **Quilin's gap vs Claude Code / Codex is concentrated in hard infrastructure (sandbox + shell + tool surface), not "agent intelligence".** Finishing P0 three items closes the execution-isolation and tool-surface gap to first tier; P1/P2 are differentiation moves.

2. **记忆 + 自进化 + 跨语言 + spec 纪律 这四件事其他四家没人同时做。** 这是 Quilin 唯一的差异化护城河——但前提是硬基建不能瘸。

   **Memory + self-evolution + cross-language + spec discipline — no other framework does all four.** This is Quilin's only moat, but only if the hard infra doesn't limp.

3. **Iter G 不要 14 件事一起干。** P0 三件套（沙箱 + 三工具 CRITICAL + 持久 Shell）约 4-5 周；P0 落地后再开 P1。先把"跟一线追平"这件事做漂亮，再去追差异化。

   **Don't tackle all 14 in one Iter.** P0 (sandbox + Grep/LSP/Glob + persistent shell) is ~4-5 weeks. Finish P0 cleanly before opening P1. Catch up to first tier before chasing differentiation.

### 待办 / TODO

- 重跑 C3 / C4 / C5 / C6 deep research（下一个 Claude Pro 5h 窗口）
- 把 P0 三件套立成 Linear project + 14 个 issue
- 把当前 docs/14-benchmark-harness 状态在 P3 启动 τ-Bench 时一并解冻

- Re-run C3 / C4 / C5 / C6 deep research in next Claude Pro 5h window
- Stand up P0 three-item Linear project + 14 issues
- Defrost docs/14-benchmark-harness when P3 starts τ-Bench scoring
