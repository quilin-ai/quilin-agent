# Roadmap Reassess — Memory Framework (2026-04-26)

> **TL;DR**：原计划 hand-rolled OmniMem 4-tier memory **应继续保留**。团队已在 2026-04-20 通过 `docs/research/memory-watchlist/` 显式建立了"跟思想不跟代码"的运作原则，并对 Graphiti / Mem0 / MemPalace / Mastra-OM / OpenViking 完成了基线 digest + spike 验证；此次 6 天 refresh 中**没有任何 framework 出现足以推翻该决策的变化**。

---

## 1. Prior Art — 不要重做评估

本文档是 watchlist 体系的 **2026-04-26 增量 refresh**，不是从零评估。读者应先读：

- `docs/research/memory-watchlist/README.md` —— 运作原则（不 submodule、不 pip install、跟思想不跟代码）
- `docs/research/memory-watchlist/{graphiti,mem0,mempalace,mastra-om,openviking}.md` —— 单 framework 基线 digest（2026-04-20）
- `docs/research/graphiti-spike-report.md` —— 269 行实测 spike，结论"do not switch"（Task #93）

任务清单提到的 6 个 framework 中，Graphiti / Mem0 已在 watchlist；Mastra-OM 也在 watchlist 但任务清单未列；GraphRAG / LangMem / Letta / Cognee 是本次新增评估。

---

## 2. 6 Frameworks — 2026-04-26 现状（gh CLI 实测，非 hallucination）

| Framework | Stars | Latest release | License | 主语言 | TS SDK | 部署模式 | KG 原生 | OmniMem fit (0-10) |
|-----------|------:|---------------|---------|--------|--------|----------|---------|--------------------|
| **Mem0** (mem0ai/mem0) | 54,085 | ts-v3.0.2 (2026-04-25) | Apache-2.0 | Python+TS | ✅ 官方 npm `mem0ai` | lib + Docker server + SaaS | 仅 Pro 付费 | 5 |
| **Letta** (letta-ai/letta) | 22,294 | v0.16.7 (2026-03-31) | Apache-2.0 | Python | ✅ `@letta-ai/letta-client` | server-first（DB-backed agents） | ❌ | 6 |
| **Graphiti** (getzep/graphiti) | 25,393 | mcp-v1.0.2 (2026-03-11) | Apache-2.0 | Python | ❌（Zep SaaS 才有） | lib + FastAPI server | ✅ 原生 bi-temporal | 4 |
| **GraphRAG** (microsoft/graphrag) | 32,508 | v3.0.9 (2026-04-13) | MIT | Python | ❌ | CLI + 批处理 pipeline | ✅ 但是离线 | 2 |
| **LangMem** (langchain-ai/langmem) | **1,416** | n/a（无 GitHub release） | MIT | Python | ❌ | LangGraph BaseStore 之上的薄 SDK | ❌ | 2 |
| **Cognee** (topoteretes/cognee) | 16,787 | v1.0.4.dev0 (2026-04-25) | Apache-2.0 | Python | ❌ | lib + Docker | ✅ 多 graph 后端 | 4 |

**关键数据点**：
- LangMem 只有 **1,416 stars**——任务清单"LangChain 官方 memory layer"的措辞高估了它。它实际上是 LangGraph BaseStore 之上的 Python-only SDK，无 GitHub release，强耦合 LangGraph runtime。
- 6 个里只有 **Mem0 + Letta** 有官方 TS SDK——这是 Quilin 双栈（TS agent core + Python providers）的硬约束。
- GraphRAG 是 **batch indexing pipeline**，不是 agent runtime memory（Microsoft 自己的定位是 "data pipeline and transformation suite"），完全不匹配 Quilin 的实时召回场景。
- Graphiti spike（[graphiti-spike-report.md](./graphiti-spike-report.md)）已实测：Python 3.14 无预编译 Kuzu wheel，`Graphiti()` 默认需要 Neo4j+OpenAI URI，KuzuDriver FTS 索引是 no-op，第一次 `add_episode()` 即崩。
- Mastra-OM (94.87% LongMemEval, watchlist 已收录) 任务清单未列——补充说明：纯 observation layer，启示已并入 OmniMem L3a，无需 framework 替换。

---

## 3. 与原 plan（hand-rolled OmniMem）的 delta 评估

OmniMem 4-tier 的关键 spec 在 `docs/engineering/03-memory/README.md` §二·A.7（D-20 融合架构）。**任何 framework 替换都会破坏的硬约束**：

1. **TS+Python 双栈**：Quilin agent core 是 TS，OmniMem provider 是 Python MCP server。Graphiti/GraphRAG/LangMem/Cognee **Python only**——若用，TS agent 必须经 MCP RPC，引入额外延迟，且 TS 端无类型化客户端。Mem0/Letta 双栈通过。
2. **零外部 DB 依赖**：OmniMem M0/M1 用 SQLite + sqlite-vec（详见 ADR-002 §部署）。Graphiti 默认 Neo4j、Cognee 倾向 graph DB、Letta 需 Postgres+pgvector。Mem0 OSS 版可用 Qdrant 但配置非平凡。
3. **LLM client 抽象**：Quilin 走 Vercel AI SDK v6（详见 [01-llm-integration](../engineering/01-llm-integration/README.md)）。Graphiti/Letta/Mem0 都内置 OpenAI/Anthropic 客户端默认，注入自定义 client 是二等公民。
4. **Skill memory tier**：4-tier 中的 skill (M2 阶段，[13-skills](../engineering/13-skills/README.md) SKILL.md frontmatter) 在所有 6 个 framework 里**都不存在原生 parity**——Mem0 没有、Letta 用 prompt-as-skill、Graphiti 是事实图谱。skill tier 必须 Quilin 自实现。
5. **READ-ONLY + WriteAuthority gate**：所有 framework 都默认 write-through，没有 origin-based 写权限控制（CLAUDE.md §Permission Model）。Quilin 需要在外面包一层 gate，相当于 framework 沦为后端。

若强行替换，"删除多少代码"的真实答案：**节省的只有 OmniMem L3 KG 实现（约 600-1500 行 Python）**，但要新增 framework 适配层（client 注入、storage 转译、permission gate、TS RPC bridge），净 LOC 增加而不是减少。Migration 期则要双写期 + 数据格式迁移，对当前 Iter D-E 阶段是显著成本中心。

---

## 4. R5 Reviewer Recommendation

### 推荐：保留 hand-rolled OmniMem 4-tier

**理由 1 — 技术发展速度未推翻已有结论**
6 天间唯一变化是 Mem0 ts-v3.0.2（telemetry patch）、GraphRAG v3.0.9 patch。Graphiti spike 报告里的所有阻塞点（Python 3.14 wheel、零配置缺失、FTS no-op）截至今日仍未修复。"方案是一周前做的，技术发展太快"的前提在 memory framework 领域**不成立**——LongMemEval/DMR 榜单已稳定 2 个月无翻盘。

**理由 2 — Quilin 的双栈 + 零外部 DB + WriteAuthority 三个硬约束彼此叠加**
单独看任何一个约束，都能找一个 framework 妥协；但三个约束叠加时**只剩 Letta 接近候选**，且 Letta 的 Postgres-first 部署模式与 ADR-002 SQLite-first 直接冲突。妥协架构的成本高于 hand-rolled。

**理由 3 — watchlist 模式已经在用最低成本吃 framework 红利**
OmniMem D-20 已经合入 Mem0 v2 的 hybrid retrieval 思想（升级为 learnable reranker）、MemPalace 的 verbatim 思想（升级为冷热分层 + zstd）、Graphiti 的 bi-temporal 思想（lazy extraction + SQLite CTE）。"跟思想不跟代码"在 6 天内继续被验证是正确的运作模式——本次 refresh 里最值得吸收的（Letta core/archival/recall 三层 OS-inspired tier 切分，参见 Letta 2026-02 blog）已经是 OmniMem 4-tier 的成熟同构，无需重构。

### 不推荐替换的 framework

- **GraphRAG**：batch pipeline 不是 agent memory 层，方向错配。
- **LangMem**：仅 1.4k stars + Python only + 强耦合 LangGraph，对 Quilin 双栈架构和单一 LLM SDK 抽象都是负面。
- **Cognee**：Python only + graph DB 依赖偏重，无 TS 路径，且 v1.0.4.dev0 仍是 dev 标签，未到稳态。
- **Graphiti**：spike 已经验证 not zero-config，且 LongMemEval 已被 Mem0 v2 / Mastra-OM 反超。保留 watchlist 不替换默认。
- **Mem0**：可作为**未来对照基线**（idea source），但 graph 锁付费墙、retrieval 黑盒、不开放 reranker training data——直接依赖会牺牲 self-evolution 的核心契约。
- **Letta**：本次评估中**最像 Quilin 平行宇宙**的项目（stateful agent OS + tiered memory + TS+Python 双栈 + memory-first coding agent）。但其 server-first + Postgres-first 部署模式 + 完整 agent runtime 与 Quilin 自研 < 200 行 Agent Loop 的核心定位（ADR-001）方向冲突——若选 Letta 等于放弃 Quilin core loop。建议**新增 watchlist 线程**长期跟踪其 sleep-time-compute / memory subagent 论文（已发现 letta-ai/sleep-time-compute repo），但**不列入运行时依赖**。

### 建议行动

- [x] 本文档归档为 2026-04-26 refresh，保留 hand-rolled 路线
- [ ] 在 `docs/research/memory-watchlist/` 新增 `letta.md` 线程（理由：22k stars + TS+Python 双栈 + 与 Quilin 同方向最近，纳入持续观察 cohort）
- [ ] 删除任务清单对 LangMem / GraphRAG / Cognee 的"主流候选"定位——它们要么不是 agent memory 层、要么 stars 量级不构成 watchlist 入选门槛（README §加入新 watchlist 线程的条件 #3 要求 > 10k）
- [ ] OmniMem M2/M3 阶段（skill tier + idle evolution）按原 plan 推进，不阻塞于 framework 选型

---

## Sources

- Mem0 — https://github.com/mem0ai/mem0 （54,085 stars, gh API 2026-04-26）
- Letta — https://github.com/letta-ai/letta （22,294 stars）；TS SDK https://github.com/letta-ai/letta-node
- Graphiti — https://github.com/getzep/graphiti （25,393 stars）；spike: `docs/research/graphiti-spike-report.md`
- GraphRAG — https://github.com/microsoft/graphrag （32,508 stars）
- LangMem — https://github.com/langchain-ai/langmem （1,416 stars，无 GitHub release）
- Cognee — https://github.com/topoteretes/cognee （16,787 stars，v1.0.4.dev0）
- Zep / temporal KG arch paper — https://arxiv.org/abs/2501.13956
- Letta v1 agent loop — https://www.letta.com/blog/letta-v1-agent
- Atlan 2026 framework comparison — https://atlan.com/know/best-ai-agent-memory-frameworks-2026/
- Quilin watchlist — `docs/research/memory-watchlist/README.md`（项目内引用）

---

**Prepared by**: R5 Memory Framework Researcher
**Date**: 2026-04-26
**Decision posture**: Aligned with prior art (2026-04-20 watchlist + Task #93 spike)
