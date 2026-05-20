# 记忆工程（Memory Engineering）

> **2026-05-21 v2 Roadmap / Perfect Memory System v2**
>
> 用户原话："我要做一个能打爆所有竞品的记忆系统"。完成 14 个竞品仓库 + 24 篇论文 + 9 个评测榜调研，Claude × Codex 双视角协商产出 unified roadmap。
>
> **调研产物**：
> - [`docs/research/agent-memory-systems-survey-2026-05-21.md`](../research/agent-memory-systems-survey-2026-05-21.md)（315 行 unified report）+ HTML 可视化版
> - [`docs/research/competitor-analysis-codex.md`](../research/competitor-analysis-codex.md)（205 行 Codex 视角）
> - [`docs/research/external-survey-codex.md`](../research/external-survey-codex.md)（296 行 papers/bench/repo 扩展）
> - [`docs/research/quilin-mem-competitive-strategy-claude.md`](../research/quilin-mem-competitive-strategy-claude.md)（576 行 Claude 视角）
> - [`docs/research/external-survey-claude.md`](../research/external-survey-claude.md)（494 行 papers/bench/repo 扩展）
> - [`docs/research/integration-feasibility-codex.md`](../research/integration-feasibility-codex.md)（298 行 Codex 独立接入可行性 verify）
>
> **核心策略**：不为了层级而加层级，交付"受治理的记忆操作系统"。基础是 append-only evidence + actor-scoped provenance + 时态有效期 + 版本链 + soft-delete rollback。检索 hybrid 且谨慎（低置信拒答 + 多重验证）。后台智能通过 quilin-daemon 跑。
>
> **Quilin 已超前业界 3 项**（14 竞品都没）：
> 1. **WriteAuthority 全局门禁** — 一套审批门管 14 类敏感操作
> 2. **4 客户端共享记忆** — 命令行 / 终端 / 网页 / Mac App 共享 `~/.quilin/`
> 3. **灵魂导入（Soul Import）** — 6 框架扫描冷启动（反向导出已明确不做）
>
> **v2 epic + 子工单**（Plane）：
> - **QUI-191** epic 完美记忆系统 v2（Backlog）
> - **第一周（必做前置）**：
>   - QUI-192（QUI-191A）记忆完整性本地评测集（纯新增，先建记分牌）
>   - QUI-193（QUI-191B）证据库 + 版本链 + 时光回溯（additive migration）
>   - QUI-194（QUI-191C）安全检索门（低置信拒答 + 多重验证，吸收 QUI-15 拆出的 HippoRAG）
>   - QUI-189（既有）批量 LLM judge（保留独立，不扩破坏防护）
> - **第二周**：
>   - QUI-195（QUI-191E）破坏防护（72h soft-delete + 影响预览 + 回滚）
>   - QUI-196（QUI-191F）多客户端 + 项目范围（冲突解决 + QUILIN.md 检索加权）
> - **第三周**：
>   - QUI-188（既有）quilin-daemon idle 调度框架
>   - QUI-197（QUI-191H）重要性多维 + 类型标签 + 过期感知
> - **第四周+**：
>   - QUI-198（QUI-191I）操作步骤流水线（对话轨迹→技能编译，吸收 QUI-15 拆出的 trajectory_compressor）
>   - QUI-199（QUI-191J）前瞻记忆 + 证据可视化 + 资源指针
> - **保留 Active**：QUI-190（temporal-aware dedupe，acceptance 微调）+ QUI-22（L3a working→episodic promotion，acceptance 扩）+ QUI-81（灵魂导入 6 框架 scan）
> - **Close**：QUI-186（状态漂移 → Done，commit `d918608` 已 ship）+ QUI-15（Cancelled，Graphiti superseded by docs/03-memory D-20，HippoRAG/trajectory 移到 QUI-194/198）
>
> **核心架构规则**：能用可选 metadata 或侧表承载能力时，不要新增 layer 或替换字段。Quilin 的优势是本地优先安全 + WriteAuthority + 多客户端上下文 + Soul Import 可移植；保住这些边界，比照搬竞品分类体系更重要。

> **实现状态（2026-05-18 增量更新，前序 2026-04-30 实证保留）**
>
> **2026-05-15 新增 / Shipped 2026-05-15**：
> - ✅ **UX-4 KG-based 记忆重做完整 4 slice**：
>   - Slice 1 `kg_extractor.py` —— LLM 三元组抽取 + 反幻觉 + 反注入 + SSRF guard + 28 tests (`b1e4a6d`)
>   - Slice 2 `memory_backfill_kg` MCP tool —— 一次性回填现有 memory_records 到 KG + `kg_backfill.py` 编排 + 12 tests (`901e989`)
>   - Slice 3.1 `kg_dump_for_viz` MCP tool + `TemporalKnowledgeGraph.dump_edges` + `apps/web/app/api/memory/graph/` endpoint + 4 tests (`6afa74f`)
>   - Slice 3.2 `@xyflow/react` reactflow viz + 知识图谱 tab on /memory page + Playwright e2e (`9abbde8` + `fc4afe3`)
>   - Slice 4 `consolidation_log` SQLite 表 + `ConsolidationLogStore` + `consolidation_log_recent` MCP tool + `/api/memory/consolidations` endpoint + timeline UI + 11 tests (`376beea` + `8df50c3`)
>   - Plan 见 [`ux4-kg-rebuild-plan.md`](./ux4-kg-rebuild-plan.md)（已 ✅）
> - ✅ **`memory_delete` MCP tool**：让 agent 自己清理重复/过时记忆 + 2 tests (`e059b9e`)
> - ✅ **Profile self-evolution + 纯 markdown 迁移**：agent 把每轮会话观察自动 append 到 `~/.quilin/user.md` / `soul.md`（Task #12），user.md drop YAML frontmatter 改纯 markdown（Task #13 + `59a618d`）
> - ✅ **跨语言 user.md write lock**：Python fcntl advisory lock (`0c09867`) + TS `proper-lockfile` (`77390c7`)，关闭 TS-vs-Python 写 race（Task #16）
> - ✅ **Iter F web 持久化 SQLite chat sessions**：4 slice 全部 ship（schema + read/write + 重启恢复 + DELETE + 原子 seq alloc + localStorage 迁移），见 `apps/web/lib/sessions-db/` + `docs/STATUS-iter-F-autonomous-2026-05-15.md`
>
> **2026-05-18 新增 / Shipped 2026-05-18 (Iter J)**：
> - ⚠️ **外部信号源 integration 骨架（仅 detection 层 + parser 骨架，主体未做）**：commits `6357bf8` + `7b34e3a`
>   - `packages/agent-core/src/integrations/github-stars/detector.ts` —— `detectGitHubAuth()`（读 `~/.config/gh/hosts.yml` 或 `GITHUB_TOKEN`，**token 用 WeakMap 私存，3 个序列化路径 override 防泄漏**）+ `listStarsCount()` 经 `Authorization: Bearer` 调 GitHub API（仅 total count，O(1) 通过 Link header `rel="last"` 解析 + per_page=1 body length 区分 0/1 star）
>   - `packages/agent-core/src/integrations/x-bookmarks/detector.ts` —— 离线分类器返结构化 reason code（no_credentials / wrong_auth_kind / missing_scope / expired_or_revoked / missing_authenticated_user_id），不发实际请求
>   - `packages/agent-core/src/integrations/obsidian-watcher/detector.ts` —— 启发式 vault 探测（`.obsidian/` + Markdown 文件）+ 默认候选路径 + `extraPaths` 注入
>   - `packages/agent-core/src/integrations/wechat-import/{types,parser,profile-stub}.ts` —— wxbackup/wxexporter 格式 JSON parser（容错：unknown type / 缺字段 / 坏 timestamp 进 warnings）+ `UserProfileFromChats` 7 维度接口 + stub 函数返 `[stub]` 占位
>   - 73 unit tests 全 mock 化（不联网 / 不读真文件）
>   - **未做（QUI-103/104 仍 Backlog）**：实时 watcher、相关性 summarize、proactive 行动建议、LLM 分析真实化、写 quilin-mem 链路、用户审核 activation flow
>
> **2026-04-30 校准（保留作历史）／ Preserved as historical baseline:**
> - ✅ **已实现**：`providers/memory/src/quilin_mem/` — quilin-mem MCP server、working / episodic / semantic / skill 四层、SQLite + FTS5/BM25、KG 子图检索、vector retriever 接口、hybrid retriever + reranker、event log + trace context、ProfileStore / ProfileUpdater、scratchpad、idle_budget + consolidator dry-run、soul schema validator。
> - ✅ **L3a observer 已激活 / L3a observer is wired into the runtime**：
>   - Class implementation lives at `providers/memory/src/quilin_mem/observer.py:1404` (`L3aObserver`); deterministic L1/L2 extraction runs every turn, the flash-tier LLM (`deepseek-v4-flash`) is triggered every `frequency` turns (default 10).
>   - L3a 类实现在 `providers/memory/src/quilin_mem/observer.py:1404`（`L3aObserver`）；L1/L2 启发式抽取每轮都跑，flash 档 LLM（`deepseek-v4-flash`）每 `frequency` 轮触发一次（默认 10）。
>   - Runtime wiring is exposed via the new `memory_observe` MCP tool registered in `providers/memory/src/quilin_mem/server.py` (per-`(user_id, session_id)` observer cache, env-driven `ObserverConfig`); the agent-core loop calls it through `packages/agent-core/src/memory/observer-bridge.ts` and `packages/agent-core/src/loop.ts` after each completed turn when `memoryObserver.enabled` is true.
>   - 运行时接线由新增的 `memory_observe` MCP 工具暴露（按 `(user_id, session_id)` 缓存 observer 实例，`ObserverConfig` 从环境变量取）；agent-core loop 通过 `packages/agent-core/src/memory/observer-bridge.ts` 与 `packages/agent-core/src/loop.ts` 在每轮结束后调用，前提是 `memoryObserver.enabled` 打开。
>   - High-confidence findings (>= 0.7) sync to `~/.quilin/user.md` via `ProfileUpdater.sync_user_md` (`providers/memory/src/quilin_mem/profile_updater.py:159`).
>   - 高置信度发现（≥ 0.7）通过 `ProfileUpdater.sync_user_md`（`providers/memory/src/quilin_mem/profile_updater.py:159`）镜像到 `~/.quilin/user.md`。
>   - **Default is OFF / 默认关闭**：`memoryObserver.enabled = false`. Opt-in via `[memory.observer] enabled = true` in user.toml. The observer needs `DEEPSEEK_API_KEY` (or `QUILIN_OBSERVER_API_KEY`) — without it the L3a path silently no-ops and only deterministic candidates are returned.
>   - 默认关闭：`memoryObserver.enabled = false`，需在 user.toml 通过 `[memory.observer] enabled = true` 显式开启。observer 依赖 `DEEPSEEK_API_KEY`（或 `QUILIN_OBSERVER_API_KEY`）；缺少 key 时 L3a 路径静默 no-op，只返回确定性候选。
> - Linear 后续项：[QUI-16](https://linear.app/quilin-agent/issue/QUI-16/03-memory-observer-validation-archival-and-evaluation-pipeline)（observer 验证）、[QUI-95](https://linear.app/quilin-agent/issue/QUI-95/m3-实现长期记忆写入-召回-归档自动闭环)（长期记忆自动闭环）；Iter F memory depth 见 [QUI-11](https://linear.app/quilin-agent/issue/QUI-11/iter-f-deepen-memoryl3a-observer-and-longmemeval-path)。

> quilin-mem 4 层分级记忆系统详细规格
>
> **ADR-001 对齐说明**：核心语言已决策为 TypeScript，quilin-mem 将封装为 Python MCP Server（ML 依赖），TS 核心通过 MCP stdio 调用。本文档中的 Python 代码示例仅表达设计意图。`quilin/` 路径为规划参考。详见 [Core Loop](../00-core-loop/README.md)。
>
> **契约源**：Memory 跨语言契约（`MemoryItem` 字段 / layer 枚举 / metadata schema 版本 / `MemoryStore` Protocol / `store()`/`recall()`/`reflect()` / tier 语义 / 异步感知）以本 spec §A.5/§A.6 为当前规范源。新字段必须可选，删除/重命名字段须走计划修订。L3a 观察者当前状态见本文件 L3a 小节与 `l3a-observer/` 报告。

---

## 一、问题定义

### 为什么 Agent 需要记忆？

无记忆的 Agent 本质上是无状态函数：每次调用都从空白开始，无法积累经验，无法记住用户偏好，也无法从过去的错误中学习。记忆系统是 Agent 从"工具"进化为"智能体"的关键能力。

**跨会话持续性**：用户今天告诉 Agent "我偏好简洁代码风格"，明天开新会话时 Agent 应该记得这个偏好，而不是每次都从头问一遍。大多数现有框架的记忆只存活于单次会话的对话历史列表中，会话结束即消亡。

**经验积累**：Agent 第一次处理某类任务时会犯错；第十次时应该已经内化了正确做法。没有记忆，Agent 永远停留在"第一次"。真正的智能需要从经验中提炼规律，并在类似情境下自动应用。

**个性化**：不同用户有不同的工作方式、语言风格、专业背景。记忆系统让 Agent 为每个用户建立独立的模型，而非用同一副面孔应对所有人。

**避免重复犯错**：失败轨迹本身是有价值的数据。Agent 应该能记住"上次在这种情境下用 X 方案失败了"，并在类似情境下自动规避。

### 记忆的核心挑战

**存储效率（无限增长怎么办）**：Agent 持续运行会积累大量记忆，如果全部保留在上下文窗口中，很快就会超出 LLM 的 token 限制。如果存储在外部，检索成本和延迟又会成为瓶颈。记忆系统必须在"记得多"与"上下文不爆炸"之间找到平衡。

**检索精度（找到相关的而非全部）**：存了 10 万条记忆，当前对话只需要其中 5 条相关的。如何在毫秒级别找到最相关的记忆，而不是把所有记忆都塞进上下文，是检索工程的核心问题。简单的关键词匹配不够，纯向量检索会漏掉结构化知识，知识图谱又难以处理语义模糊查询。

**淘汰策略（什么该忘什么该记）**：人类记忆会自动遗忘不重要的细节，保留重要的模式和知识。Agent 的记忆系统也需要类似机制：常用的知识应该保留，过时的信息应该更新或删除，重复的内容应该压缩合并。没有淘汰策略的记忆系统最终会被噪音淹没。

**反思机制（从经验中提炼模式）**：原始经验（"这次任务我用了方案 A，结果是 B"）需要被提炼为可迁移的知识（"在 X 类情境下，方案 A 优于方案 C"）。这个从具体到抽象的提炼过程需要专门的反思机制，仅靠存储和检索是不够的。

### 业界现状与痛点

当前大多数 Agent 框架的记忆实现都极为简单：一个对话历史列表，每轮对话 `list.append()`，超过 token 限制就截断头部。这种"会话内记忆"模式存在三个根本缺陷：

1. **无持久化**：会话结束，记忆消亡。用户明天开新会话，Agent 认不出他。
2. **无语义组织**：记忆是线性列表，无法表达"X 和 Y 是同类问题"这样的关系知识。
3. **无反思能力**：记忆只是被动记录，不会主动从中提炼规律或更新知识。

Claude Code 的 CLAUDE.md 是一种创新——把项目级知识写成文件让 Agent 读取。这是文件级记忆，能跨会话持久化，但不是语义级的：它不能回答"最近 10 次类似任务的成功率如何"，也不能自动提炼新的项目规律并更新自身。

真正强大的记忆系统需要的是：**分层存储 + 混合检索 + 主动反思 + 自动淘汰**。这正是 quilin-mem 的设计目标。

---

## 二、设计方案

> **D-20（2026-04-20） — quilin-mem v2 融合架构（supersedes D-12）**
>
> 本节的 §二·A "quilin-mem v2 融合架构" 为 Iter C 目标设计，**取代 D-12**（默认 Graphiti）。下方 §二·B "Layer 1–4 基线 spec" 保留为 v1 参考，将在 D-20 M0/M1/M2 迭代中局部重写。

### 二·A  quilin-mem v2 融合架构（D-20）

#### A.1  问题重述：为什么推翻 D-12

D-12（2026-04-20 早期）定的 "默认 Graphiti 作为 KG 后端" 基于两条前提：(1) Graphiti 在 LongMemEval 上 +15 pts 领先 Mem0；(2) 时序 KG 是 agent 记忆的核心能力。

截至 2026-04-20，两条前提都站不住：

- **前提 1 已失效**：Mem0 v2 算法（2026-04）将 LongMemEval 从 49% 提到 93.4%，反超 Graphiti 的 71.2% 约 22 pts。Mastra Observational Memory 达 94.87%，MemPalace 96.6%。Graphiti 跌出 SOTA 前 5。
- **前提 2 存疑**：Hindsight/Vectorize 2026-03 提出 LongMemEval 本身已过时；"时序 KG" 只是记忆系统的一个**轴**，不是核心。真正的竞争维度变成 **accuracy / speed / cost / usability (AMB)** 四轴。
- **工程阻塞**：Graphiti dependency spike（Task #93，2026-04-20 Codex 独立验证）证明 `graphiti-core==0.28.2` 在 Python 3.14 + embedded Kuzu 上不 zero-config（需源码编译 Kuzu + 手动 bootstrap FTS 索引），`Graphiti()` 默认需要 Neo4j URI。直接作为 Iter C 默认不成立。

结论：**放弃"押注单一库"思路**，改为**融合 2026 开源 SOTA 的思想，构建多轴最优的 quilin-mem v2**。

#### A.2  设计原则

1. **吸收思想，不抄代码**：03-memory spec 不出现任何 `import graphiti_core` / `import mastra`。我们读上游的论文、架构、源码，写自己的实现。
2. **每层必须三段式论证**：原思想（来自谁、解决什么）→ 原思想的局限（我们分析出的弱点）→ 我们的转化 + 升级（怎么改、为什么改、判决指标）。
3. **License 干净**：只参考 Apache-2.0 项目的公开架构与论文。NOTICE 文件致谢，代码自写。
4. **证据驱动**：每层 M 阶段必须跑 AMB 四轴 benchmark（accuracy / speed / cost / usability）。未达门槛的层被回滚。
5. **上游跟思想不跟代码**：不把上游 git submodule 化；每条研究线程维护 `docs/03-memory/memory-watchlist/<name>.md`，上游升级时我们写 digest → human review → 对应迭代我们自己的代码。

#### A.3  2026-04 开源 SOTA 参考

| 系统 | LongMemEval | 架构流派 | 最强轴 | License |
|------|-------------|---------|--------|---------|
| MemPalace | 96.6% (raw mode) | Verbatim + palace metaphor | 保真度（无信息损失） | Apache-2.0 |
| Mastra Observational Memory | 94.87% (gpt-5-mini) | Observer + Reflector 双后台 agent | 推理成本 / prompt 可缓存 | Apache-2.0（`ee/` 部分除外） |
| Mem0 v2 | 93.4% | Hybrid retrieval（vector + graph + BM25 + entity linking） | 通用检索质量 | Apache-2.0 |
| Graphiti (Zep) | 71.2% | 时序 KG（bi-temporal edges） | 时序推理 | Apache-2.0 |
| OpenViking (volcengine) | — | Filesystem-hierarchical（L0/L1/L2） | 规模 / 冷热分层 | Apache-2.0 |

**核心洞察**：五家在**不同轴上占优且轴互相正交** —— 融合不是堆叠，而是**分工**。

#### A.4  五流派 → quilin-mem v2 分层分工

| quilin-mem v2 组件 | 职责 | 灵感来源 |
|---------------|------|---------|
| **Working Memory**（L1） | 最近 k 轮原文，零压缩 | 保留现有 |
| **Verbatim Episodic Store**（L2） | 原文全留 + 冷热分层归档 | MemPalace + OpenViking |
| **Observation Layer**（L3a） | rule-first + LLM 兜底的 dated observations；append-only prompt 前缀 | Mastra OM |
| **Temporal KG Layer**（L3b） | bi-temporal edges，**仅对 temporal intent 查询做 lazy 抽取** | Graphiti |
| **Hybrid Retrieval & Fusion**（L3c） | 向量 + BM25 + KG 子图 + entity linking 并行召回 + RRF rerank | Mem0 v2 |
| **Procedural / Skill Stats**（L4） | skill usage counter，指向 13-skills SSoT | 保留现有（D-11） |
| **Consolidator**（元层） | idle-time reflection、KG 剪枝、verbatim 差分压缩 | Mastra Reflector + MemOS feedback |

#### A.5  写路径（异步多源 ingestion）

```
[turn]
   │
   ▼
┌───────────────────────────────────────┐
│ L1 Working Memory（sync, deque, k=5） │  ← 同步，主流程不阻塞
└────────────────┬──────────────────────┘
                 │ FIFO 溢出 → enqueue
                 ▼
    ┌────────────────────────┐
    │ Async Ingestion Queue  │
    └───┬────────────────┬───┘
        │                │
        ▼                ▼
┌──────────────┐  ┌───────────────────────────────┐
│ L2 Verbatim  │  │ Observer（rule-first + LLM）  │
│ Episodic     │  │   ↓ dated observations         │
│ (SQLite WAL) │  │ L3a Observation Layer          │
└──────────────┘  │   ↓ entity signals             │
                  │ L3b Temporal KG (lazy)         │
                  │   ↓ vector embed + metadata    │
                  │ L3c Hybrid Retrieval Index     │
                  └───────────────────────────────┘
```

**关键约束**：
- **同步**只做 L1 写入 + L2 verbatim 落盘。observer / KG / 向量化都**异步**。
- **Eventual consistency**：L3a/b/c 与 L2 的延迟对齐在 O(秒) 级可接受。
- **失败不阻塞**：异步路径任一环失败，verbatim 仍完整，下次 idle 时重放。

#### A.6  读路径（并行召回 + 融合 rerank + 可缓存 prompt）

```
query
   │
   ▼
┌──────────────────────────────────┐
│ Intent classifier                │  ← 快速规则 + LLM 兜底
│   factual / temporal /           │
│   preference / procedural        │
└────────┬─────────────────────────┘
         │
         ▼  （按 intent 加权 fan-out）
┌────────────────────────────────────────────┐
│ 并行召回：                                  │
│   ├─ L2 Verbatim FTS5 (exact phrase)       │
│   ├─ L3a Observation vector (semantic)     │
│   ├─ L3b KG 子图遍历（temporal intent 才走） │
│   └─ L3c Hybrid index（BM25 + 向量）        │
└────────────┬───────────────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ Fusion reranker                   │
│   RRF + optional LLM rerank       │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ Append-only prompt assembly      │  ← 稳定前缀 → prompt cache 命中
│  [systemPrompt, stable context,  │
│   recent-turn diff only]         │
└──────────────────────────────────┘
```

prompt cache 的稳定前缀是 Mastra OM 的核心创新点；**我们保留并升级为 "block-level invalidation"**：前缀拆成 N 个 block，只让真正变更的 block 失效，其余 block 复用 cache。

#### A.7  每层升级（思想吸收 + 转化 + 升级）

##### L2 Verbatim Episodic Store

- **原思想（MemPalace）**：全保留、不压缩，靠 FTS + 向量检索找。
- **原思想的局限**：无上限增长，30 天后存储爆炸；palace metaphor（Wing/Hall/Room）是人类心智隐喻，对检索没有工程收益。
- **Quilin 升级**：
  1. **冷热分层归档**：`age > N 天` 的 verbatim 迁到冷区，用 zstd 字典压缩（对话文本压缩比 ~8x）；检索命中时按需解压。
  2. **不用 palace 隐喻**：直接 SQLite 表 + metadata index，按 `user_id / session_id / age_tier` 分区。

##### L3a Observation Layer

- **原思想（Mastra OM）**：后台 Observer 每轮用 LLM 压缩成 dated observations；后台 Reflector 定期重结构化。
- **原思想的局限**：
  - 每轮都烧 LLM token，成本随对话轮数线性增长
  - Reflector 按时间/数量阈值触发，可能做无意义的重排
- **Quilin 升级**（"rule-first observer"，验证中 Task #97）：
  1. **两级 Observer**：
     - Tier 1（零 LLM）：spaCy/regex + dateutil 抽 `entity / time / event`，对结构化 turn（工具结果、短回应、明确时间）直接产出 observation
     - Tier 2（LLM）：仅在 Tier 1 confidence 低时 escalate（模糊指代、隐含意图、跨轮综合）
     - 预期：70% 的 turn 走 Tier 1，LLM 成本砍 70%
  2. **Info-gain-gated Reflector**：只在新 observation 与旧 observation **冲突 / 显著扩展**（Δentropy > ε）时触发重结构化，不按时间/数量。
  3. **判决门槛**：Tier 1 hit rate ≥ 40% 且 observation 精度不降 → 保留，否则回退纯 LLM observer。

- **🚨 Task #97 v2-r3 formal gate judgment = NO（2026-04-20，1039-sample full dataset）**：
  - **v2-r3 (full 1039, gate)**: recall **21.4%**（远低于 40% 门槛），FPR 2.8%，p95 4.19ms
  - 迭代轨迹：v1 self-authored 90%（inflated baseline）→ v2-r1 7.3% → v2-r2 26.1% → **v2-r3 21.4%**
  - 按 noise：short 0.0% / emoji 6.6% / typo 7.3% / code 8.2% — 短截断最致命
  - 按语言：zh 0.0% / mixed 5.2% — 双语支持仍为零；Tier 2 escalation 仅 1.1%
  - **结论**：rule-first 路线在现实输入分布下 recall 存在天花板；M0 Sprint 1 前必须扩为 **bilingual + multi-pattern + escalation-aware**，否则 L3a 回退纯 LLM observer
  - **状态**：`gate failed, go/no-go pending` — 下一次 Sprint 若仍不过 40%，必须切 ML-first（新起 ADR-004）或把 L3a 降级为 opt-in
  - 详见 [spike report](l3a-observer/rule-first-observer-spike-report.md)
  - 数据集与评估脚本保留为 CI 回归测试基线：[`l3a-observer/fixtures/`](l3a-observer/fixtures/)

##### L3b Temporal KG Layer

- **原思想（Graphiti）**：每条 episode eagerly 抽实体 + 关系，bi-temporal edges 带 valid_from/valid_to。
- **原思想的局限**：
  - 90% 的事实从未被时序查询用到 —— eager 抽取浪费 token
  - Entity resolution（同一人多种称呼）精度不稳
  - 上游 `build_indices_and_constraints()` 在 embedded 后端是 no-op（spike 证据）
- **Quilin 升级**：
  1. **Lazy extraction**：KG 默认不抽。Intent classifier 识别 `temporal` intent 时才对相关 episode 做即时抽取（抽取结果缓存入 KG，下次命中免抽）。
  2. **Entity canonicalization**：抽取时强制通过 User Profile Store 中的 canonical entity table 归一化。
  3. **不用 Kuzu**：直接 SQLite 表存边 + valid_from/valid_to（两列），加索引；不引入 graph DB 依赖。查询用递归 CTE 做 hop-N 遍历。

##### L3c Hybrid Retrieval Index

- **原思想（Mem0 v2）**：单次 extraction pass + entity linking + multi-signal retrieval（vector + BM25 + graph）。
- **原思想的局限**：上游对 "single-pass extraction" 闭源；权重是固定的。
- **Quilin 升级**：
  1. **Learnable reranker**：记录 "哪些召回条目最终被 agent 在 response 中引用"，作为正样本，训练轻量 reranker（logistic regression on feature vector: source/recency/semantic_sim/graph_distance）。
  2. **Weight tuning per user**：为每用户维护召回权重 profile（某用户更依赖 temporal 召回，某用户更依赖 semantic 召回）。

##### Filesystem Hierarchy（借鉴 OpenViking，不单独立层）

- **原思想（OpenViking）**：L0/L1/L2 物理文件分层按访问频度。
- **原思想的局限**：需要 Python + Go + C++ 多语言基建。
- **Quilin 升级**：
  1. **不引入多语言**：在 SQLite 内做分层（热表常驻 WAL、冷表按访问 entropy 分区到独立文件）。
  2. **Entropy-based tiering**：tiering 依据不是 LRU，而是访问分布的信息熵 —— 稳定被访问的条目升 hot，访问集中在特定时期的条目降 cold。

##### Consolidator（元层）

- **原思想（Mastra Reflector + MemOS feedback loop）**：周期性整合 + 用户反馈。
- **Quilin 升级**：
  1. **Idle-budget gated**：只在 `10-self-evolution` 的 idle 预算内跑；不抢主流程资源。
  2. **三件事做**：深度 reflection / KG 过期边剪枝 / 旧 verbatim 差分再压缩。
  3. **Human-in-loop**：reflection 产出的新 "insight" 经 07 §2.6.4 WriteAuthority 落盘，不自动合入。

#### A.8  迭代规划（M0 → M1 → M2）

> **状态校准（2026-05-01）**：下表是 2026-04-22 的旧路线图快照。实际 Memory M0/M1/M2 主体已作为 Iter M 与 Iter C 并行完成；当前未落地项集中在 L3a observer resource block、LongMemEval/live spike、以及 Iter F 的 production idle evolution。宏观状态以 [`docs/STATUS.md`](../STATUS.md) 为准。

| Milestone | 范围 | 判决指标 | 预估工作量 |
|-----------|------|---------|-----------|
| **M0**（Iter F Sprint 1） | L1 + L2 verbatim + L3a Observation（rule-first + LLM 兜底） + L3c 基础向量/BM25 召回 + 融合 rerank（无 KG） | AMB 四轴基线；LongMemEval ≥ 85% | 3-4 周 |
| **M1**（Iter F Sprint 2） | 加 L3b Lazy Temporal KG + Learnable Reranker + prompt cache block-level invalidation | LongMemEval ≥ 92%；成本比 M0 ≤ 1.3x | 2-3 周 |
| **M2**（Iter F Sprint 3） | 加 L2 冷热分层归档 + Consolidator idle loop + per-user weight profile | LongMemEval ≥ 95%；容量 ≥ 10 万条 / 用户；p95 召回 < 300ms | 2 周 |

**每个 M 都必须**：
- 通过 AMB 四轴量化验证
- 若某层升级未达门槛，回滚该层（写 digest 到 watchlist）
- 不 regress 前一 M 的 benchmark

#### A.9  上游跟进机制（跟思想不跟代码）

在 `docs/03-memory/memory-watchlist/` 为每家维护研究线程：

```
docs/03-memory/memory-watchlist/
├── README.md         # 索引 + watchlist 运作规则
├── mastra-om.md      # 原架构、关键论点、digest 历史
├── graphiti.md
├── mem0.md
├── mempalace.md
└── openviking.md
```

**运作规则**：
1. 上游发新 version / blog / paper → 读 → 写 digest（"他们改了什么 / 为什么 / 对我们启示"）
2. digest 被 human review → 若启示成立，起 ADR-slug 或 spec delta PR
3. PR 通过后再动代码；**不合入上游 git**

这条机制与 10-self-evolution "human-in-loop propose patch" 同构：**没有上游自动合入**。

#### A.10  与现有实现的对齐

- 已实现（`providers/memory/`）：SQLite + FTS5 integration tests 31/31 绿 —— 对应 D-20 L2 verbatim + L3c BM25 部分。**继续沿用**。
- 不需丢弃：D-11 Skill SSoT 原则、D-05 跨域 contract、R-07/R-12 工厂重构 —— **全部保留**，D-20 叠加在上面。

---

### 二·B  Layer 1–4 基线 spec（v1，将按 D-20 M0/M1/M2 局部重写）

### quilin-mem 4 层架构图

```
用户对话 / Agent 执行轨迹
         │
         ▼
┌─────────────────────────────────────────┐
│         Working Memory (Layer 1)         │
│  最近 k=5 轮完整内容（不压缩）           │
│  高保真 · 最高优先级 · 直接注入上下文   │
└──────────────────┬──────────────────────┘
                   │ 超过 k 轮 → FIFO 淘汰
                   ▼
┌─────────────────────────────────────────┐
│        Episodic Memory (Layer 2)         │
│  LLM 驱动的语义摘要压缩                 │
│  保留关键决策点 · Discard-all at T       │
└──────────────────┬──────────────────────┘
                   │ Reflector 提炼 pattern
                   ▼
┌─────────────────────────────────────────┐
│        Semantic Memory (Layer 3)         │
│  向量索引 + 知识图谱（KG）三元组        │
│  跨会话持久化 · 混合检索                │
└──────────────────┬──────────────────────┘
                   │ 成功轨迹模板化
                   ▼
┌─────────────────────────────────────────┐
│          Skill Memory (Layer 4)          │
│  Agent 自创可复用技能模板               │
│  由自进化模块管理 · 按成功率评分        │
└─────────────────────────────────────────┘
```

### Layer 1：Working Memory（工作记忆）

**定位**：最近 k 轮对话/动作的完整原始内容，零压缩，直接构成 LLM 上下文的主体。

**keep-recent-k 策略**（来自 GLM-5.1 实证验证）：
- `k` 默认值为 5，可通过配置调整（`working_memory.k`）
- 保留内容：完整消息文本、工具调用参数、工具返回结果、推理链（thinking block）
- 保留顺序：严格按时间倒序，最新的在最前
- 不做任何压缩或摘要，最大化信息保真度

**FIFO 淘汰到 Episodic**：
- 当存储内容超过 k 轮时，最老的一轮被整体移交给 Episodic Memory
- 移交前触发 LLM 摘要：将被淘汰轮次的内容压缩为关键摘要
- 摘要格式：`{轮次: N, 关键动作: [...], 关键结论: ..., 相关实体: [...]}`

**上下文注入顺序**：由 [02-Context ContextAssembler](../02-context/README.md) 统一决定（D-05：组装权归 02，本领域只返回 recall 结果 + layer 标签，不定义排布顺序）。典型顺序见 02-Context 规范。

### Layer 2：Episodic Memory（情景记忆）

**定位**：Working Memory 溢出内容的压缩摘要库，保留对话历史的关键信息而非完整内容。

**LLM 驱动的摘要压缩**：
- 触发时机：Working Memory 满额（超过 k 轮）时自动触发
- 压缩比：目标将多轮对话（通常 2K-8K tokens）压缩为 200-400 tokens 的摘要
- 压缩内容：保留决策点（"选择了方案 A 而非 B 的原因"）、实体信息（人名、项目名、技术栈）、任务状态（完成/失败/待续）
- 丢弃内容：冗余的中间步骤、错误尝试的细节（保留结论，丢弃过程）

**Discard-all at Threshold 策略**（来自 GLM-5.1 BrowseComp 实验）：
- 当 Episodic Memory 总内容超过阈值 T（默认 32K tokens equivalent）时，触发全清除
- 全清除前：先触发 Reflector 对当前所有情景记忆进行深度提炼，产出 Semantic Memory 条目
- 全清除后：从空白 Episodic 重新开始积累，但 Semantic Memory 保留了提炼结果
- 效果（GLM-5.1 数据）：BrowseComp 准确率从 55.3% 提升到 62.0%

**时间衰减权重**：
- 每条 Episodic 记忆携带时间戳
- 检索时按时间衰减加权：`weight = base_score × exp(-λ × age_in_hours)`
- `λ` 默认 0.01（即约 70 小时后权重衰减到原来的 50%）

### Layer 3：Semantic Memory（语义记忆）

**定位**：跨会话持久化的知识库，同时维护两种存储：向量索引（语义相似检索）和知识图谱（关系推理）。

**向量存储（Vector Store）**：
- 存储内容：知识片段的文本嵌入向量 + 原文
- 后端：默认使用 ChromaDB（本地持久化，零依赖）；生产可切换为 Qdrant、Weaviate
- 嵌入模型：默认 `text-embedding-3-small`（OpenAI）；可配置为本地 `nomic-embed-text`
- 索引策略：每条记忆独立嵌入，支持按 metadata（用户 ID、项目、时间范围）过滤检索

**知识图谱（Knowledge Graph）**：
- 存储内容：实体-关系-实体三元组，如 `(Python, is_language_of, FastAPI)`
- **后端（~~D-12~~ **已被 D-20 取代**，见 §二·A）**：~~默认 Graphiti（Zep 开源版）~~。D-20 基于 Codex spike (Task #93) 证据 + 2026-04 SOTA 格局变化（Mem0 v2 反超 Graphiti 22 pts、LongMemEval 被 Hindsight 论证已过时），**改为 Lazy Temporal KG 自研实现（SQLite + bi-temporal 列 + 递归 CTE）**；不引入 Kuzu/Neo4j/FalkorDB 依赖，不 lock in 任何单一库。详见 §二·A.7 L3b。
- 三元组来源：Intent classifier 识别 temporal intent 时才对相关 episode 做 lazy 抽取（Quilin 自研，思想借鉴 Graphiti 但不依赖其包）；Entity canonicalization 走 User Profile Store。
- 时序标注：每条关系携带 `valid_from` / `valid_to` 两列，支持 point-in-time 查询（SQL `WHERE ts BETWEEN valid_from AND COALESCE(valid_to, 'infinity')`）。
- 查询能力：子图检索、关系路径查询、实体邻居查询

**Agent-facing 接口（Letta 启发）**：除了被动 Reflector 自动抽取外，额外暴露以下工具让 agent 主动自编辑语义 tier：
- `memory_replace(tier, old_fragment, new_fragment)` — 点更新
- `memory_append(tier, content)` — 追加
- `archival_insert(content, tags)` — 归档（仅 semantic tier）

Letta 证明了 "self-editing memory" 在长任务中优于纯被动自动抽取；我们保留被动抽取为默认，主动接口作为 Agent 在发现自动抽取错误或希望显式锚定关键事实时的 escape hatch。

**跨会话持久化**：
- 向量索引：持久化到本地目录（`~/.quilin/memory/vector/`）
- 知识图谱：序列化为 JSON-LD 格式（`~/.quilin/memory/kg/graph.jsonld`）
- 加载时机：Quilin 初始化时自动加载，无需用户干预

### Layer 4：Procedural Memory / Skill Usage Stats（技能使用统计）

> **D-11（2026-04-20 NEW-11 Skill 单写方原则）**：Skill 的**唯一真源（SSoT）**是文件系统 `~/.quilin/skills/**/SKILL.md`，由 [13-skills](../13-skills/README.md) 维护。Layer 4 **不存 skill body / trigger_pattern / execution_steps**，只保留 usage/success 计数，供排序与淘汰决策使用。这消除了 03-memory 与 13-skills 的双写冲突（避免索引漂移 / CRUD race）。

**定位**：对 13-skills 注册表的 usage counter 镜像（只读引用 + 写入计数器），供 catalog 排序与低效 skill 发现使用。

**Skill 使用统计表**：
```python
@dataclass
class SkillUsageStat:
    skill_id: str                # 引用 ~/.quilin/skills/<slug>/SKILL.md
    success_count: int = 0
    invocation_count: int = 0
    last_used: datetime | None = None

    @property
    def success_rate(self) -> float:
        if self.invocation_count == 0:
            return 0.0
        return self.success_count / self.invocation_count
```

**技能创建**：**不在 03-memory 范围**。创建/更新/删除路径由 10-self-evolution 的 idle evolution 产生建议 → 13-skills 的 `skill_manage` 工具写盘 SKILL.md（经 07 §2.6.4 WriteAuthority）。Layer 4 只在 skill 被调用后 upsert 对应的 `skill_id` 计数器。

**按成功率淘汰**（建议层，不自动删除）：
- 调用次数 >= 5 且成功率 < 0.3 的 skill 由 Layer 4 产出 "deprecation suggestion"
- 由 13-skills `skill_manage(delete)` 经 WriteAuthority + 人审执行

### User Profile Store（用户画像存储）

**定位**：专门为用户建模的持久化存储，贯穿 Agent 完整生命周期，是实现 Agentic 人味和 Aha Moment 的数据基础。

**核心理念**：好的 Agent 不是被动等待使用的工具，而是能理解人、有人味、有主动性的伙伴。Agent 应该主动收集和学习用户背景，帮用户记得且觉察到用户自己都注意不到的事情。

#### 首次启动引导式收集（Onboarding）

Quilin 首次启动时主动向用户发起引导式问卷，而非等待用户自行告知：

```
[首次启动引导]
"你好！为了更好地帮助你，我想了解一些背景信息：
1. 你的角色是什么？（工程师/产品经理/研究员/...）
2. 你主要使用什么技术栈？
3. 你目前在做什么项目/任务？
4. 你有什么工作习惯偏好？（比如喜欢简洁还是详细的回答）
当然，你可以跳过任何问题，我会在后续使用中慢慢了解。"
```

收集到的信息存入 User Profile：

```python
@dataclass
class UserProfile:
    user_id: str
    role: str | None                    # 用户角色
    tech_stack: list[str]               # 技术栈
    current_projects: list[str]         # 当前项目
    work_style: dict                    # 工作风格偏好
    active_hours: list[tuple[int,int]]  # 活跃时段（从使用模式中学习）
    communication_preference: str       # 沟通偏好（简洁/详细/技术深度）
    known_expertise: list[str]          # 已知专长领域
    known_gaps: list[str]               # 已知薄弱领域（用于调整解释深度）
    interaction_count: int = 0          # 总交互次数
    last_seen: datetime | None = None   # 最后一次活跃时间
    created_at: datetime                # 首次使用时间
    schema_version: int = 1             # 用于跨版本迁移（D-05）
```

#### 唯一写入方（D-05 合同）

> **单写原则**：UserProfile 只能通过本领域暴露的 `ProfileUpdater` 写入，任何其他领域（02-Context、对话工程子模块、10-Self-Evolution 等）都只能**读**不能**写**。这避免了多写方 race、口径漂移和回滚困难。

```python
class ProfileUpdater:
    """UserProfile 的唯一写入入口 — 供 quilin-mem 内部调度，不对外直接暴露。"""

    def apply_signal(self, user_id: str, signal: ProfileSignal) -> UserProfile: ...
    def bulk_apply(self, user_id: str, signals: list[ProfileSignal]) -> UserProfile: ...
    def reset(self, user_id: str, reason: str) -> None: ...  # 审计日志必填
```

- **对外接口**：其他领域通过 `QuilinMemClient.emit_profile_signal(signal)` 发送**候选信号**，由 ProfileUpdater 聚合判决后才落盘。
- **写入审计**：每次写入记录 `who(caller_domain) / when / why(signal) / diff`，写入 Semantic Memory 的 meta 层，供 08-Observability 消费。
- **schema 版本化**：UserProfile 字段变更必须递增 `schema_version`，ProfileUpdater 持有向前迁移脚本，不允许字段级破坏性变更直接上线。

#### 持续静默更新

不靠用户主动告知，Agent 在每次交互中**发出 ProfileSignal**（不是直接写），由 ProfileUpdater 聚合判决后更新画像：

| 信号 | 推断 | 更新字段 |
|------|------|---------|
| 用户使用了大量 Go 专业术语 | 用户熟悉 Go | `known_expertise += ["Go"]` |
| 用户在凌晨 1-3 点活跃 | 夜猫子工作模式 | `active_hours` 更新 |
| 用户总是要求更简洁的回答 | 偏好简洁 | `communication_preference = "concise"` |
| 用户对 React 概念频繁提问 | React 相对薄弱 | `known_gaps += ["React"]` |
| 用户切换了项目上下文 | 项目变更 | `current_projects` 更新 |

更新策略：**增量 + 阈值确认**。连续 3 次在同一方向上观察到信号后才更新，避免单次误判。

#### Departure Context（离开上下文）

当检测到用户长时间未响应（> 30 分钟），quilin-mem 自动记录当前上下文状态：

```python
@dataclass
class DepartureContext:
    session_id: str
    departed_at: datetime               # 离开时间
    last_topic: str                     # 最后讨论话题摘要
    pending_user_actions: list[str]     # 用户承诺要做但未报告结果的事
    pending_agent_suggestions: list[str] # Agent 建议了但用户未确认的事
    emotional_state: str | None         # 用户离开时的情绪线索（如有）
    context_summary: str                # 整体上下文摘要
```

- **写入时机**：用户消息间隔 > 30 分钟时自动生成
- **读取时机**：用户新消息到达时，02-Context 的 `build_context()` 优先检索最近的 DepartureContext
- **与 02-Context 时间感知联动**：DepartureContext 提供"未完成动作"列表，02-Context 的时间感知层据此决定如何衔接对话

### 混合检索策略

每次 `ContextManager.build_context()` 调用时，按以下策略从各层检索相关记忆：

**综合评分公式**：
```
score(memory) = α × vector_similarity
              + β × time_decay
              + γ × layer_priority
              + δ × task_relevance

默认权重：α=0.4, β=0.2, γ=0.2, δ=0.2
```

参数说明：
- `vector_similarity`：查询向量与记忆向量的余弦相似度（0-1）
- `time_decay`：`exp(-λ × age_hours)`，越新的记忆权重越高
- `layer_priority`：Working=1.0, Episodic=0.7, Semantic=0.5, Skill=0.6
- `task_relevance`：基于任务类型标签匹配度（0-1）

**分层检索流程**：

```
1. Working Memory（直接取，无需检索）
   → 取最近 k 轮，全部注入

2. Episodic Memory（关键词 + 时间过滤）
   → 取最近 3-5 条摘要（按时间衰减排序）

3. Semantic Memory（向量 + KG 双路检索）
   → 向量路：embed(query) → top-K 相似度匹配 → 取 top 5
   → KG 路：实体抽取(query) → 子图检索 → 取相关三元组
   → 结果融合：去重，按综合评分排序，取 top 5

4. Skill Memory（模式匹配）
   → embed(task_description) → 匹配 trigger_pattern → 取 top 2
   → 仅匹配 success_rate >= 0.5 的技能

5. 全局裁剪
   → 各层结果合并，按综合评分排序
   → 控制总注入 token 不超过 context_budget × 0.3
```

### 记忆淘汰策略详解

| 层级 | 策略 | 触发条件 | 动作 |
|------|------|---------|------|
| Working | FIFO | 超过 k 轮 | 最老一轮移交 Episodic（先摘要） |
| Episodic | Discard-all | 超过 T tokens | 先 Reflect → 再全清除 |
| Semantic（向量） | 重要性评分 | 总条数 > 10000 | 淘汰评分最低的 20% |
| Semantic（KG） | 时序过期 | 关系失效时间到达 | 标记为历史关系，不删除 |
| Skill | 成功率 | 调用 >= 5 且成功率 < 0.3 | 标记 deprecated，下次清理 |

**Semantic Memory 重要性评分**：
```
importance(memory) = log(1 + access_count)
                   × log(1 + reference_count)
                   × recency_decay
```
- `access_count`：该记忆被检索命中的次数
- `reference_count`：该记忆被其他记忆引用的次数（在 KG 中作为节点的边数）
- `recency_decay`：`exp(-λ × days_since_last_access)`

### Reflector 自动反思

Reflector 是连接 Episodic Memory 和 Semantic Memory 的桥梁，负责从具体经验中提炼抽象知识。

**触发条件**（任意一个满足即触发）：
- 任务成功完成后（`AgentState.current_node == "end"`）
- 任务失败后（`AgentState.current_node == "error"`），优先反思失败原因
- Episodic Memory 触发 Discard-all 前（强制反思）
- 固定间隔：每 50 次 Working Memory 更新触发一次
- **空闲期主动维护**：用户空闲且 idle_evolution 预算充足时（见 [10-self-evolution 2.12](../10-self-evolution/README.md)），自动触发以下记忆维护操作：
  - Working → Episodic 批量归档（清理积压的短期记忆）
  - Episodic → Semantic 批量反思（提炼跨会话知识）
  - Semantic Memory 去重（合并高相似度条目）
  - KG 补充（为孤立节点补充关系边）
  - 重要性评分刷新（重新计算 access_count 衰减）

**反思流程**：
```
1. 收集输入
   → 取 Episodic Memory 最近 N 条摘要（N=10）
   → 取本次任务的执行轨迹（成功/失败路径）

2. LLM 提炼分析（使用 Sonnet 4.6）
   → 识别跨任务的共同模式
   → 提炼成功/失败的关键因素
   → 生成新知识条目和 KG 三元组

3. 写入 Semantic Memory
   → 新知识片段 → 向量化 → 存入向量存储
   → 实体关系 → 三元组 → 存入知识图谱
   → 成功轨迹模板 → SkillExtractor → 存入 Skill Memory
```

**反思 Prompt 设计要点**：
```python
REFLECT_PROMPT = """
你是一个 Agent 的自我反思系统。以下是该 Agent 最近的执行摘要：

{episodic_summaries}

任务结果：{task_outcome}（成功 / 失败）

请完成以下任务：
1. 识别 2-3 个跨任务可复用的规律或模式
2. 提炼 1-3 个值得长期记住的知识点（用自然语言描述）
3. 抽取重要的实体关系，用三元组格式：(主体, 关系, 客体)
4. 如果任务失败，分析失败根因和下次应该如何避免

输出格式为 JSON，字段：patterns, knowledge_items, triples, lessons
"""
```

### ProjectMemory（项目记忆）

受 Claude Code 的 CLAUDE.md 启发，quilin-mem 实现了语义级的项目记忆：

**MEMORY.md 文件**：
- 位置：项目根目录（`{project_root}/MEMORY.md`）
- 自动生成：Reflector 在每次会话结束时自动更新
- 内容结构：
  ```markdown
  # Project Memory
  ## 项目概述
  ## 关键技术决策
  ## 已知问题和解决方案
  ## 偏好和约定
  ## 近期重要变更
  ```
- 读取时机：`ContextManager.build_context()` 的第一步，注入为 System Prompt 的一部分

**自动索引**：
- MEMORY.md 内容会被向量化并同步到 Semantic Memory
- 下次检索时，项目级知识和会话记忆统一参与检索排序

### MemoryStore 接口设计

所有存储后端必须实现以下 Protocol：

```python
from typing import Protocol, Any
from dataclasses import dataclass, field
from datetime import datetime
import uuid


@dataclass
class MemoryItem:
    """单条记忆条目的统一数据模型。"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    content: str = ""
    content_type: str = "text"          # text | json | triple
    layer: str = "semantic"             # working | episodic | semantic | skill
    metadata: dict[str, Any] = field(default_factory=dict)
    embedding: list[float] | None = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    last_accessed: datetime = field(default_factory=datetime.utcnow)
    access_count: int = 0
    importance_score: float = 0.5


class MemoryStore(Protocol):
    """记忆存储后端统一接口。所有存储实现必须遵循此 Protocol。"""

    async def add(self, memory: MemoryItem) -> str:
        """存储一条记忆，返回分配的 memory_id。"""
        ...

    async def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        """语义检索，返回按相关度排序的记忆列表。filters 支持按 layer、metadata 过滤。"""
        ...

    async def get(self, memory_id: str) -> MemoryItem | None:
        """按 ID 精确获取一条记忆，不存在时返回 None。"""
        ...

    async def update(self, memory_id: str, content: str) -> None:
        """更新记忆内容（保留 ID 和 metadata，仅更新 content 和 embedding）。"""
        ...

    async def delete(self, memory_id: str) -> None:
        """软删除一条记忆（标记为 deleted，不立即物理删除）。"""
        ...

    async def list_by_layer(
        self,
        layer: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryItem]:
        """按层级列出记忆，支持分页。"""
        ...

    async def count(self, filters: dict[str, Any] | None = None) -> int:
        """统计记忆条数，支持按 filters 过滤。"""
        ...

    async def clear_layer(self, layer: str) -> int:
        """清空某层的所有记忆（Discard-all），返回被删除的条数。"""
        ...
```

**内置实现**：
- `SQLiteMemoryStore`：默认实现，本地持久化，零外部依赖
- `ChromaMemoryStore`：向量检索增强，适合语义记忆层
- `Neo4jMemoryStore`：知识图谱存储，配合 Graphiti 使用

### 配置项设计

```yaml
# quilin/config.yaml — 记忆系统配置节
memory:
  working:
    k: 5                          # 保留最近 k 轮（GLM-5.1 建议值）
    max_tokens_per_turn: 4096     # 单轮最大 token 数

  episodic:
    discard_threshold_tokens: 32000   # Discard-all 阈值
    time_decay_lambda: 0.01           # 时间衰减系数（per hour）
    summary_max_tokens: 400           # 单条摘要最大 token 数

  semantic:
    vector_backend: "chroma"      # chroma | qdrant | weaviate
    kg_backend: "networkx"        # networkx | neo4j
    persist_dir: "~/.quilin/memory"
    embedding_model: "text-embedding-3-small"
    embedding_dim: 1536
    max_items: 10000              # 超过后触发重要性淘汰
    retrieval_top_k: 5            # 向量检索返回条数

  skill:
    min_invocations_for_eval: 5   # 评估成功率所需最低调用次数
    min_success_rate: 0.3         # 低于此值标记为 deprecated
    max_skills: 500               # 技能库最大容量

  retriever:
    alpha: 0.4                    # 向量相似度权重
    beta: 0.2                     # 时间衰减权重
    gamma: 0.2                    # 层级优先级权重
    delta: 0.2                    # 任务相关性权重
    context_budget_ratio: 0.3     # 记忆注入占总 context budget 的比例
    max_retrieval_latency_ms: 100 # 检索延迟硬限制

  reflector:
    trigger_on_task_complete: true
    trigger_on_task_fail: true
    trigger_interval_turns: 50    # 每 N 轮强制触发一次
    reflect_model: "claude-sonnet-4-6"
    max_episodic_for_reflect: 10  # 每次反思最多处理多少条 Episodic

  project_memory:
    enabled: true
    file_name: "MEMORY.md"
    auto_update: true             # 会话结束时自动更新
```

---

## 三、Top 10 参考项目

### 深入分析（前 5）

#### 1. Mem0 — 自适应多级记忆层

**GitHub**：`mem0ai/mem0` | Stars：约 48,000（2026 年 4 月，增长最快的 Agent 记忆框架）

**核心设计**：Mem0 的最大创新是三级记忆范围的独立管理：用户级（user-level，记录个人偏好和历史）、Agent 级（agent-level，记录 Agent 自身的行为模式）、会话级（session-level，当前会话上下文）。三级之间完全隔离，互不污染。

**自适应更新机制**：当用户修正偏好时（"我不喜欢 X，改成 Y"），Mem0 不是简单追加一条新记忆，而是识别出与已有记忆的冲突，自动更新旧记忆，避免矛盾信息并存。这是真正的"记忆管理"而非"记忆堆积"。

**混合存储架构**：向量数据库（语义相似检索）+ 图数据库（关系建模）+ 键值存储（快速事实检索）三套存储协同工作。不同类型的查询路由到最适合的存储，检索质量和效率都大幅提升。

**性能基准**：相比 OpenAI Memory，响应质量高 26%，token 消耗低 90%——说明 Mem0 的检索精准度极高，不需要把大量无关记忆都塞进上下文。

**适配启示**：quilin-mem 的用户级/Agent 级/会话级隔离设计直接参考 Mem0，但在 Mem0 基础上增加了第四层（Skill Memory）和主动反思机制。

#### 2. Graphiti — 时序知识图谱

**GitHub**：`getzep/graphiti` | Stars：约 20,000（12 个月内达成，增速显著）

**核心设计**：Graphiti 是 Zep 的开源时序知识图谱引擎，专为在动态环境中运行的 AI Agent 设计。其核心创新是为每个实体和关系都附加时间戳（有效期起止时间），使知识图谱能够表达"在时间 T1 之前，X 与 Y 的关系是 A；之后变成了 B"这类时序信息。

**Episode 驱动的图构建**：原始输入（对话消息、文档片段、事件记录）被称为 Episode。每个 Episode 触发一个管线：实体识别 → 关系抽取 → 时序标注 → 增量融合到图中。不同于批处理知识图谱，Graphiti 支持实时增量更新，新数据立即可查。

**时序查询能力**：可以查询"现在什么是真的"或"在时间 T 时什么是真的"，旧事实被标记为失效而非删除，保留完整历史。这对于需要理解知识演变过程的 Agent 极为重要。

**双后端支持**：原生支持 Neo4j 和 FalkorDB 两个图数据库后端，通过统一接口抽象，用户可根据部署规模选择。

**适配启示**：quilin-mem Semantic Memory 的 KG 子系统的时序标注设计、Episode → 实体 → 关系的构建管线，直接参考 Graphiti。轻量部署时使用 NetworkX，生产规模时切换为 Neo4j + Graphiti 后端。

#### 3. Letta (MemGPT) — 虚拟上下文管理

**GitHub**：`letta-ai/letta` | 原 MemGPT 研究项目，现为完整 Agent 平台

**核心设计**：Letta 将操作系统的虚拟内存管理思想引入 LLM 上下文管理。Agent 的内存被分为三层，类比计算机存储层次：Core Memory（类似 RAM，直接在上下文窗口中的小块内存）、Recall Memory（类似磁盘缓存，可检索的对话历史）、Archival Memory（类似冷存储，Agent 通过工具调用主动查询的长期存储）。

**Block 系统**：Core Memory 被分割为独立的 Block（块），每个 Block 有固定的字符数限制。Agent 可以通过函数调用（`core_memory_append`、`core_memory_replace`）主动管理 Block 内容，类似程序员手动管理内存页。这种显式内存管理让 Agent 对自己"记住什么"有完全掌控权。

**分页机制**：当 Core Memory 满时，Agent 自主决定将哪些内容"换页"到 Archival Memory，需要时再"调页"回来。这比被动的 token 截断更加智能，避免了盲目丢弃重要信息的问题。

**Context Repositories**（2026 新特性）：基于 Git 的程序化上下文管理，为编码 Agent 提供版本化的记忆快照，可以 `git checkout` 到不同的记忆状态。

**适配启示**：quilin-mem Working Memory 的 k 轮保留策略借鉴了 Letta Core Memory 的显式管理思想，但采用自动 FIFO 而非手动管理，降低了 Agent 的认知负担。Episodic Memory 的压缩触发机制参考了 Letta 的分页逻辑。

#### 4. LangMem — LangGraph 原生记忆集成

**GitHub**：`langchain-ai/langmem`

**核心设计**：LangMem 是 LangChain 官方出品的长期记忆管理库，最大特点是与 LangGraph 状态图深度集成。记忆不是外挂模块，而是作为 LangGraph State 的持久化 Checkpoint 自然融入 Agent 循环。

**三类记忆类型**：情景记忆（Episodic，过去交互的具体记录）、语义记忆（Semantic，事实和偏好）、程序性记忆（Procedural，Agent 自动重写自身系统指令的能力——即 Agent 可以修改自己的行为规则）。程序性记忆是 LangMem 的独特创新，实现了一种轻量级的自进化。

**Memory Manager**：自动从对话中提取新记忆、更新或删除过时记忆、对相似记忆进行整合和泛化。Memory Manager 本身也是一个 LLM 调用，形成"记忆管理也是智能任务"的递归结构。

**存储后端**：通过 LangGraph 的 `BaseStore` 抽象支持多种后端，生产环境推荐使用 PostgreSQL + pgvector（向量检索 + 关系数据库一体化）。

**适配启示**：quilin-mem 与 LangGraph 的集成方式参考 LangMem：记忆作为 `AgentState` 的一部分参与状态图流转，`reflect` 节点（State Graph 第 6 个节点）负责记忆更新，与 LangMem 的 Memory Manager 设计思路一致。程序性记忆（Agent 修改自身行为规则）的概念被纳入 quilin-mem Skill Memory 和自进化模块（Phase 8）。

#### 5. Cognee — 知识引擎 + 混合检索

**GitHub**：`topoteretes/cognee` | Stars：约 12,000（80+ 贡献者）

**核心设计**：Cognee 的核心是 ECL 管线（Extract, Cognify, Load）：从 38+ 数据源摄入数据 → 结构化为知识图谱（同时生成嵌入向量和图关系）→ 存储为可检索格式。与其他系统相比，Cognee 最重视数据摄入的灵活性和知识结构化的质量。

**混合检索实现**：`cognee.search()` 同时执行向量相似度检索（找语义相似的知识片段）和图遍历检索（找关联实体的知识）。两路结果融合后经过 reranking，确保返回的是真正相关的内容，而非仅仅语义相似的内容。这解决了纯向量检索的"相关但不准确"问题。

**Memify 反馈回路**：用户对 Agent 响应的评分会反向传播到知识图谱的边权重，被评价为好的知识节点权重提升，差的降低。记忆系统通过使用反馈变得更精准，实现持续改进。

**MCP 原生支持**：Cognee 提供 MCP Server 接口，任何支持 MCP 的 Agent（包括 Claude Code）可以直接调用 Cognee 的记忆能力，无需深度集成。

**适配启示**：quilin-mem 的混合检索策略（向量 + KG 双路，融合后 reranking）参考 Cognee 的实现。ECL 管线的"先摄入，再结构化"思路也影响了 quilin-mem 对 Working Memory → Semantic Memory 流转的设计。

---

### 观察项目（后 5）

#### 6. Hindsight — 反思驱动记忆

**GitHub**：`vectorize-io/hindsight`

三核操作（retain/recall/reflect）+ 仿生数据结构（World/Experiences/Mental Models 三层）。Hindsight 的 LongMemEval SOTA 成绩证明了反思驱动（reflect 操作主动从记忆中生成新洞察）的有效性。quilin-mem Reflector 的设计参考 Hindsight 的反思流程。

#### 7. Zep — 会话记忆 + 自动事实提取

**GitHub**：`getzep/zep`

Zep 以"零 schema 自动事实提取"见长：发送一条对话消息，Zep 自动识别并结构化其中的实体、关系、事实，无需预定义数据模型。内部使用 Graphiti 构建时序知识图谱，商业化较成熟。quilin-mem 的 Reflector 自动抽取三元组的能力参考了 Zep 的事实提取管线。

#### 8. MemPalace — 空间记忆隐喻

**GitHub**：`milla-jovovich/mempalace` | Stars：约 19,500（2026 年 4 月，发布 5 天爆发）

基于古典记忆宫殿（Method of Loci）隐喻的层次化组织：Wing（人/项目）→ Hall（记忆类型）→ Room（主题）→ Closet（压缩摘要）→ Drawer（原文）。以 96.6% R@5 LongMemEval 成绩和仅 170 tokens 启动开销成为当前最轻量高效的记忆系统之一。quilin-mem 的层次化命名和组织结构受到 MemPalace 的启发。

#### 9. SuperMemory — 统一记忆 API

**GitHub**：`supermemoryai/supermemory` | Stars：约 20,000

定位为记忆基础设施层，提供统一的 Memory API，任何 Agent（Claude Code、Cursor、OpenClaw 等）均可接入。浏览器扩展 + MCP Server 双模式部署，三大基准（LongMemEval、LoCoMo、ConvoMem）全部第一。quilin-mem 的 MCP Server 对外接口设计参考 SuperMemory 的 API 形态。

#### 10. AgentMemory (JordanMcCann) — 轻量高精度记忆

**GitHub**：`JordanMcCann/agentmemory`

LongMemEval 96.2%（481/500），solo 16 天开发，定位为完整的记忆操作系统：检索引擎 + 知识图谱 + 整合管线 + 评估框架一体化。证明了精心设计的轻量系统可以超越复杂的工程化系统。quilin-mem 的评估框架设计参考其测试方法论。

---

## 四、吸收内化方案

### Mem0 → quilin-mem 的自适应记忆层设计

**吸收点**：三级记忆范围（用户级/Agent 级/会话级）独立管理。

在 quilin-mem 中，`MemoryItem` 的 `metadata` 字段携带 `scope` 信息：
```python
metadata = {
    "scope": "user",           # user | agent | session | project
    "user_id": "...",
    "agent_id": "...",
    "session_id": "...",
}
```

检索时，`MemoryRetriever.search()` 默认优先返回与当前 `user_id` 和 `session_id` 匹配的记忆，再扩展到 `agent_id` 级别的共享知识。不同用户的记忆物理隔离（不同向量集合），Agent 级记忆则在该 Agent 的所有用户间共享。

**自适应更新**：Mem0 的冲突检测机制内化为 Reflector 的一个子步骤。每次 `add` 新记忆时，先用向量检索找到相似度 > 0.85 的已有记忆，若发现冲突（同一事实的不同说法），由 LLM 判断保留哪个或如何合并，而非无脑追加。这避免了记忆库中存在互相矛盾的信息。

### Graphiti → Semantic Memory 的 KG 构建管线

**吸收点**：Episode → 实体抽取 → 关系建立 → 时序标注的流水线设计。

quilin-mem 的 `KGBuilder` 组件实现这一管线：

```python
class KGBuilder:
    async def process_episode(self, episode: str, source: str) -> list[Triple]:
        # Step 1: 实体识别（NER）
        entities = await self._extract_entities(episode)

        # Step 2: 关系抽取
        relations = await self._extract_relations(episode, entities)

        # Step 3: 时序标注
        valid_from = datetime.utcnow()
        triples = [
            Triple(
                subject=r.subject,
                predicate=r.predicate,
                object=r.object,
                valid_from=valid_from,
                valid_until=None,   # None 表示当前仍然有效
                source=source,
            )
            for r in relations
        ]

        # Step 4: 增量融合（检测冲突，更新已有关系的 valid_until）
        await self._merge_into_graph(triples)

        return triples
```

时序查询（"此刻什么关系有效"）通过过滤 `valid_until is None or valid_until > now` 实现，历史查询通过时间范围过滤实现，不丢失任何历史信息。

### Letta → Working Memory 的分页管理启发

**吸收点**：显式内存管理（Block 系统）+ 分页思想。

quilin-mem 没有直接实现 Letta 的 Block 系统（过于复杂，增加 Agent 认知负担），而是将其思想内化为自动 FIFO 策略：Working Memory 维护一个固定大小的 deque（`collections.deque(maxlen=k)`），满时自动弹出最老的元素并移交 Episodic Memory。

```python
from collections import deque

class WorkingMemory:
    def __init__(self, k: int = 5) -> None:
        self._buffer: deque[ConversationTurn] = deque(maxlen=k)
        self._episodic: EpisodicMemory = ...

    async def push(self, turn: ConversationTurn) -> None:
        if len(self._buffer) == self._buffer.maxlen:
            # 满时自动移交最老元素
            evicted = self._buffer[0]   # 不能用 popleft，deque 自动管理
            await self._episodic.compress_and_add(evicted)
        self._buffer.append(turn)
```

Letta 的 Archival Memory（通过工具调用主动查询）对应 quilin-mem 的 Semantic Memory：Agent 在需要历史知识时可以通过 `search_memory` 工具显式查询，但更多情况下由 `ContextManager` 自动检索注入，无需 Agent 手动管理。

### LangMem → LangGraph 状态图的记忆集成方式

**吸收点**：记忆作为状态图持久化 Checkpoint，Memory Manager 作为状态图节点。

quilin-mem 与 Quilin LangGraph 状态图的集成方式直接参考 LangMem：

1. `AgentState.variables["context"]` 携带本轮的记忆召回结果（`build_context` 节点产出）
2. `reflect` 节点（第 6 个状态图节点）负责将本轮执行结果写入记忆，并触发 Reflector
3. LangGraph 的 `Checkpoint` 机制确保 `AgentState` 在中断恢复时能找回上下文

LangMem 的程序性记忆（Agent 修改自身系统指令）被纳入 Phase 8 的自进化模块，但 quilin-mem 的 Skill Memory 已经实现了轻量版本：成功轨迹被模板化为技能，相当于 Agent 在运行时"学会了新的做事方法"。

### Cognee → 混合检索策略

**吸收点**：向量相似度 + KG 子图匹配 + Reranking 的三阶段混合检索。

quilin-mem 的 `MemoryRetriever` 实现三阶段检索：

```python
class MemoryRetriever:
    async def retrieve(
        self,
        query: str,
        task_context: dict[str, Any],
    ) -> list[MemoryItem]:

        # 阶段 1: 向量路（找语义相似）
        query_embedding = await self._embed(query)
        vector_results = await self._vector_store.search(
            query_embedding, top_k=20
        )

        # 阶段 2: KG 路（找关联实体的知识）
        entities = await self._extract_query_entities(query)
        kg_results = await self._kg_store.subgraph_search(
            entities, max_hops=2
        )
        kg_items = self._triples_to_items(kg_results)

        # 阶段 3: 融合 + Reranking
        all_candidates = vector_results + kg_items
        deduped = self._deduplicate(all_candidates)
        scored = [
            (item, self._score(item, query, task_context))
            for item in deduped
        ]
        scored.sort(key=lambda x: x[1], reverse=True)

        return [item for item, _ in scored[:self._top_k]]
```

Cognee 的 Memify 反馈回路（用户评分更新图边权重）对应 quilin-mem 的 `access_count` 机制：每次记忆被检索命中，`access_count` +1，影响后续的重要性评分，常用知识自动获得更高权重。

---

## 五、与 Harness 组件映射

### 组件总览

| 组件 | 文件路径 | 主要接口 | 描述 |
|------|---------|---------|------|
| quilin-mem | `quilin/memory/quilin_mem.py` | `store()`, `recall()`, `reflect()` | 4 层统一入口，对外暴露统一接口 |
| WorkingMemory | `quilin/memory/working.py` | `push()`, `get_recent()`, `to_context()` | keep-recent-k，FIFO 淘汰到 Episodic |
| EpisodicMemory | `quilin/memory/episodic.py` | `compress_and_add()`, `search()`, `discard_all()` | LLM 摘要压缩，阈值触发全清除 |
| SemanticMemory | `quilin/memory/semantic.py` | `add()`, `search()`, `add_triple()` | 向量 + KG 双存储，跨会话持久化 |
| SkillMemory | `quilin/memory/skill.py` | `add_skill()`, `match()`, `update_stats()` | 技能模板库，按成功率评分管理 |
| MemoryStore | `quilin/memory/store.py` | Protocol + `SQLiteMemoryStore` | 存储后端抽象接口 + 默认实现 |
| MemoryRetriever | `quilin/memory/retriever.py` | `retrieve()` | 混合检索（向量 + KG + rerank） |
| KGBuilder | `quilin/memory/kg_builder.py` | `process_episode()`, `query()` | 知识图谱构建管线 |
| Reflector | `quilin/memory/reflect.py` | `trigger()`, `extract_skills()` | 自动反思，提炼 Semantic 记忆 |
| ProjectMemory | `quilin/memory/project_memory.py` | `load()`, `update()`, `to_context_block()` | MEMORY.md 持久化和加载 |

### 与 Harness 核心组件的集成点

```
Quilin.__init__()
  └── self.memory = QuilinMem(self.mcp_bus)    ← 初始化 4 层记忆

ContextManager.build_context(task)
  ├── ProjectMemory.load()                       ← 读取 MEMORY.md
  ├── QuilinMem.recall(query=task)               ← 触发 MemoryRetriever
  │     ├── WorkingMemory.get_recent()           ← 直接取最近 k 轮
  │     ├── EpisodicMemory.search()              ← 关键词 + 时间过滤
  │     └── SemanticMemory.search()              ← 向量 + KG 双路检索
  └── 返回融合后的 context dict

Quilin._node_reflect()
  ├── QuilinMem.store(turn_result)               ← 写入 Working Memory
  └── QuilinMem.reflect()                        ← 触发 Reflector
        ├── 条件判断（是否满足触发条件）
        ├── Reflector.trigger(episodic_summaries) ← LLM 反思
        ├── 写入 SemanticMemory（向量 + KG）
        └── Reflector.extract_skills()            ← 可能写入 SkillMemory
```

### 完整 Protocol 伪代码

```python
# quilin/memory/quilin_mem.py — 对外统一接口

from typing import Any
from dataclasses import dataclass, field
from datetime import datetime
import uuid


class QuilinMem:
    """
    4 层分级记忆系统统一入口。

    层级（从短到长）：
      Working (k=5 轮完整保留)
      → Episodic (LLM 摘要压缩)
      → Semantic (向量 + KG，跨会话持久化)
      → Skill (技能模板库，自进化基础)
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self.working = WorkingMemory(k=config.get("working", {}).get("k", 5))
        self.episodic = EpisodicMemory(config.get("episodic", {}))
        self.semantic = SemanticMemory(config.get("semantic", {}))
        self.skill = SkillMemory(config.get("skill", {}))
        self.retriever = MemoryRetriever(self.semantic, config.get("retriever", {}))
        self.reflector = Reflector(self.episodic, self.semantic, self.skill)

    async def store(
        self,
        content: str,
        layer: str = "working",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """存储记忆到指定层级，返回 memory_id。"""
        item = MemoryItem(content=content, layer=layer, metadata=metadata or {})
        match layer:
            case "working":
                return await self.working.push(item)
            case "episodic":
                return await self.episodic.add(item)
            case "semantic":
                return await self.semantic.add(item)
            case "skill":
                return await self.skill.add(item)
            case _:
                raise ValueError(f"Unknown layer: {layer}")

    async def recall(
        self,
        query: str,
        task_context: dict[str, Any] | None = None,
    ) -> list[MemoryItem]:
        """从所有层检索相关记忆，返回按综合评分排序的列表。"""
        working_items = await self.working.get_recent()
        retrieved = await self.retriever.retrieve(query, task_context or {})
        # Working Memory 内容直接拼接（不参与检索评分），其余按综合评分返回
        return working_items + retrieved

    async def reflect(self) -> bool:
        """触发自动反思，将 Episodic 记忆提炼为 Semantic 记忆。返回是否实际执行了反思。"""
        return await self.reflector.trigger()

    async def save(self) -> None:
        """持久化 Semantic Memory 和 Skill Memory 到磁盘。"""
        await self.semantic.persist()
        await self.skill.persist()

    async def load(self) -> None:
        """从磁盘加载 Semantic Memory 和 Skill Memory。"""
        await self.semantic.load()
        await self.skill.load()
```

### 性能约束

| 约束项 | 硬性限制 | 说明 |
|--------|---------|------|
| 检索延迟（`recall()`） | < 100ms | Working + Episodic 直取，向量检索缓存加速 |
| 单会话存储上限 | < 50MB | 超过时触发 Episodic Discard-all |
| 向量检索 top-k | 5-20 | 可配置，越大越准确但越慢 |
| Reflector 调用延迟 | < 5s | 使用 Sonnet 4.6，允许异步执行不阻塞主循环 |
| MEMORY.md 大小 | < 10KB | 超过时触发自动压缩，保留最重要的内容 |
| KG 节点数上限 | 50,000 | 超过时触发重要性淘汰（淘汰低度数节点） |

---

## 六、验证标准

### 单元测试

**WorkingMemory keep-recent-k 正确性**：
```python
# tests/memory/test_working.py

@pytest.mark.unit
async def test_keep_recent_k():
    wm = WorkingMemory(k=3)
    for i in range(5):
        await wm.push(MemoryItem(content=f"turn_{i}"))
    recent = await wm.get_recent()
    assert len(recent) == 3
    assert recent[0].content == "turn_4"   # 最新在最前
    assert recent[-1].content == "turn_2"  # 最老的保留边界

@pytest.mark.unit
async def test_eviction_triggers_episodic(mock_episodic):
    wm = WorkingMemory(k=2, episodic=mock_episodic)
    await wm.push(MemoryItem(content="turn_0"))
    await wm.push(MemoryItem(content="turn_1"))
    await wm.push(MemoryItem(content="turn_2"))  # 触发淘汰
    mock_episodic.compress_and_add.assert_called_once()
    evicted = mock_episodic.compress_and_add.call_args[0][0]
    assert evicted.content == "turn_0"
```

**EpisodicMemory 压缩触发条件**：
```python
@pytest.mark.unit
async def test_discard_all_triggers_at_threshold(mock_reflector):
    em = EpisodicMemory(
        config={"discard_threshold_tokens": 1000},
        reflector=mock_reflector,
    )
    # 填充直到超过阈值
    for _ in range(50):
        await em.add(MemoryItem(content="x" * 30))   # 每条约 30 tokens
    assert mock_reflector.trigger.call_count >= 1     # 触发了反思
    count = await em.count()
    assert count == 0                                  # 清除后为空
```

**MemoryStore CRUD 操作**：
```python
@pytest.mark.unit
async def test_sqlite_store_crud():
    store = SQLiteMemoryStore(":memory:")
    item = MemoryItem(content="test memory", layer="semantic")
    mid = await store.add(item)
    fetched = await store.get(mid)
    assert fetched.content == "test memory"
    await store.update(mid, "updated content")
    updated = await store.get(mid)
    assert updated.content == "updated content"
    await store.delete(mid)
    deleted = await store.get(mid)
    assert deleted is None
```

**混合检索分数计算**：
```python
@pytest.mark.unit
def test_hybrid_score_components():
    retriever = MemoryRetriever.__new__(MemoryRetriever)
    retriever._config = {"alpha": 0.4, "beta": 0.2, "gamma": 0.2, "delta": 0.2}
    item = MemoryItem(layer="semantic", access_count=5)
    score = retriever._score(
        item,
        vector_similarity=0.9,
        age_hours=24,
        task_relevance=0.8,
    )
    assert 0.0 <= score <= 1.0
    # 高向量相似度应该有较高分数
    assert score > 0.5
```

### 集成测试

**4 层记忆联动：超过 k 轮自动压缩到 Episodic**：
```python
@pytest.mark.integration
async def test_four_layer_cascade():
    quilin_mem = QuilinMem(config={"working": {"k": 2}})
    # 推入 3 轮，触发第 1 轮淘汰
    for i in range(3):
        await quilin_mem.store(f"conversation turn {i}", layer="working")
    # Working 应只有 2 轮
    working_items = await quilin_mem.working.get_recent()
    assert len(working_items) == 2
    # Episodic 应有 1 条压缩摘要
    episodic_count = await quilin_mem.episodic.count()
    assert episodic_count == 1
```

**反思触发 → 生成 Semantic 记忆**：
```python
@pytest.mark.integration
async def test_reflect_produces_semantic():
    quilin_mem = QuilinMem(config=test_config)
    # 填充足够的 Episodic 记忆
    for i in range(5):
        await quilin_mem.episodic.add(MemoryItem(
            content=f"Task {i}: used Python to process data, succeeded"
        ))
    # 模拟任务完成触发反思
    await quilin_mem.reflect()
    # Semantic Memory 应该有新增条目
    semantic_count = await quilin_mem.semantic.count()
    assert semantic_count > 0
```

**跨会话记忆持久化和恢复**：
```python
@pytest.mark.integration
async def test_cross_session_persistence(tmp_path):
    config = {**test_config, "semantic": {"persist_dir": str(tmp_path)}}
    # 会话 1：存储记忆
    quilin_mem_1 = QuilinMem(config)
    await quilin_mem_1.store("User prefers concise code style", layer="semantic")
    await quilin_mem_1.save()

    # 会话 2：加载并检索
    quilin_mem_2 = QuilinMem(config)
    await quilin_mem_2.load()
    results = await quilin_mem_2.recall("code style preference")
    assert any("concise" in item.content for item in results)
```

### 端到端测试

**"记住 X" → 持久化 → 新会话能想起**：
```python
@pytest.mark.e2e
async def test_remember_across_sessions(harness_factory, tmp_path):
    # 会话 1：告知偏好
    harness_1 = harness_factory(memory_dir=tmp_path)
    await harness_1.run(
        task="Please remember that I prefer TypeScript over JavaScript"
    )
    await harness_1.memory.save()

    # 会话 2：新 Harness 实例，加载记忆
    harness_2 = harness_factory(memory_dir=tmp_path)
    await harness_2.memory.load()
    result = await harness_2.run(task="What language should I use for the frontend?")

    assert "TypeScript" in result.outputs.get("response", "")
```

**超过 k 轮后旧内容被正确压缩（不丢失关键信息）**：
```python
@pytest.mark.e2e
async def test_episodic_retains_key_decisions(harness_factory):
    harness = harness_factory(working_k=3)
    # 模拟 6 轮对话，第 1 轮包含关键决策
    await harness.memory.working.push(MemoryItem(
        content="Decided to use PostgreSQL instead of MySQL for the database"
    ))
    for i in range(5):
        await harness.memory.working.push(MemoryItem(
            content=f"Follow-up discussion {i}"
        ))

    # 检索关键词，应该能从 Episodic 中找回
    results = await harness.memory.recall("database choice PostgreSQL MySQL")
    assert any("PostgreSQL" in item.content for item in results)
```

### 性能基准测试

```python
@pytest.mark.benchmark
async def test_recall_latency(benchmark, quilin_mem_with_1000_items):
    """recall() 在 1000 条记忆下延迟应 < 100ms。"""
    async def recall():
        return await quilin_mem_with_1000_items.recall("test query")

    result = benchmark(asyncio.run, recall())
    assert benchmark.stats["mean"] < 0.1   # 100ms

@pytest.mark.benchmark
async def test_memory_size_per_session(quilin_mem):
    """单会话存储不超过 50MB。"""
    for i in range(1000):
        await quilin_mem.store(f"memory content {i}" * 100)
    size_mb = await quilin_mem.total_size_mb()
    assert size_mb < 50
```

---

*本文档涵盖 quilin-mem 记忆系统的完整设计规格，从问题定义到验证标准。实现阶段为 Phase 3，依赖 Phase 0（LLM 接入）和 Phase 2（上下文管理）完成后启动。记忆系统是 Phase 7（多 Agent + 自进化）的基础，Skill Memory 和跨 Agent 记忆共享将在 Phase 7 扩展。*
