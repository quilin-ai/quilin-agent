# Agent Memory 扩展调研 / External Survey — Memory (Claude lane)

> **生成 / Generated**：2026-05-21 by Claude subagent (并行 Codex / 14 repo subagent)。
> **目的 / Purpose**：联网 + docs 补充调研，覆盖 14 repo subagent 不直接读源码的 4 块视角：论文 / benchmark / 没关注到的开源 repo / quilin docs 已经"想到"的东西。
> **声明 / Disclaimer**：本文是 research note，不是 spec。引用的 arxiv 编号 / 仓库 star / SOTA 数字以最近的官方 / 论文页面为准；运行决策应在落 Plane 前再实证一遍（CLAUDE.md 状态声明实证纪律）。

---

## 0. 阅读指南 / Reading Map

- §1 论文 16 篇，按"基础范式 → 工程化 → 评测 → 安全 → 神经科学启发 → 综述"分组。每篇给：核心 idea 一句话 + 与 quilin-mem 相关性 2-3 句 + arxiv link。
- §2 8 个 benchmark / evaluation harness。每个给：测什么 / 评测维度 / dataset 规模 / SOTA / quilin-mem 是否值得参加 + 怎么参加。
- §3 14 个 14-repo 调研之外的开源 repo / 平台。每个：地址 + 1 段 pitch + 与 14 repo 互补 / 重叠 / 独特点。
- §4 quilin docs 已经"想到"的 30+ 个 insight，避免合并报告时重复造轮子。
- §5 Cross-reference 表：哪些 paper / repo 在 14 repo 里已经实现 / 哪些是补充视角。
- §6 5 条 quilin-mem 还没考虑到但应该 ship 的 idea。

---

## 1. 论文 / Papers

### 1.1 基础范式 / Foundational Paradigms

#### 1.1.1 MemGPT: Towards LLMs as Operating Systems
- **arxiv**：[2310.08560](https://arxiv.org/abs/2310.08560)（Packer et al., UC Berkeley, 2023）
- **核心 idea**：把 OS 的虚拟内存 paging 思想搬到 LLM context 管理 — main context（RAM）/ recall storage（disk）/ archival storage（cold）三层，agent 通过 function call 自己换页。
- **与 quilin-mem 相关性**：quilin-mem L1 working memory + L2 verbatim episodic 直接对应 MemGPT 的 main+recall；但 MemGPT 把 paging 决策完全交给 LLM 自管，quilin-mem 走自动 FIFO + 异步 observer 路线，工程更可控。MemGPT 是"agent self-edit memory"流派的祖师，启发了 Letta 的 block 系统 + 后来的 sleep-time agent。

#### 1.1.2 Generative Agents: Interactive Simulacra of Human Behavior
- **arxiv**：[2304.03442](https://arxiv.org/abs/2304.03442)（Park et al., Stanford + Google, 2023）
- **核心 idea**：memory stream + 周期性 reflection + recency × importance × relevance 三因子排序 retrieval — Smallville 25 个 agent 自发组织 Valentine 派对。
- **与 quilin-mem 相关性**：quilin-mem reflector 的"任务完成后 LLM 提炼 pattern"直接抄这篇；importance score 也是这里的发明。Generative Agents 的 importance × recency × relevance 三因子打分公式比 quilin-mem 当前的 4-因子（α/β/γ/δ）更经典，可以作为 ablation baseline。

#### 1.1.3 MemoryBank: Enhancing LLMs with Long-Term Memory
- **arxiv**：[2305.10250](https://arxiv.org/abs/2305.10250)（Zhong et al., AAAI 2024）
- **核心 idea**：用 Ebbinghaus 遗忘曲线驱动记忆强化与遗忘 — 记忆每次被访问就"重新激活"延长保留期，未被访问的按指数衰减。
- **与 quilin-mem 相关性**：quilin-mem 当前的 `time_decay = exp(-λ × age_hours)` 是简化版 Ebbinghaus；MemoryBank 把"访问-激活"做成完整曲线（每次访问把 age 重置或减半），quilin-mem 应升级 `access_count` 不只用于 importance score，也参与 time_decay 重算（"被访问过的记忆衰减更慢"）。

#### 1.1.4 A-MEM: Agentic Memory for LLM Agents
- **arxiv**：[2502.12110](https://arxiv.org/abs/2502.12110)（Xu, Liang et al., 2025）｜repo: [agiresearch/A-mem](https://github.com/agiresearch/A-mem)
- **核心 idea**：Zettelkasten（卢曼卡片盒）启发 — 每条新记忆带 contextual description / keywords / tags / 链接到旧记忆，添加新记忆**触发旧记忆 attribute 更新**，记忆网络自我演化。
- **与 quilin-mem 相关性**：quilin-mem KG 子图是被动写入（episode 来才抽），A-MEM 主张"写入新记忆也回流更新旧记忆"。这跟 quilin-mem 的 Reflector 互补但更细粒度 — Reflector 是"周期性把 episodic 整理成 semantic"，A-MEM 是"每条新 fact 落地时回看相关旧 fact 是否要补 tag / 合并"。

#### 1.1.5 Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory
- **arxiv**：[2504.19413](https://arxiv.org/abs/2504.19413)（Chhikara et al., 2025）｜repo: [mem0ai/mem0](https://github.com/mem0ai/mem0)
- **核心 idea**：single-pass ADD-only extraction + entity linking + multi-signal retrieval（vector + BM25 + entity），Mem0g 加图结构。LLM-as-a-Judge 上比 OpenAI Memory 高 26% / token 省 90% / p95 延迟降 91%。
- **与 quilin-mem 相关性**：quilin-mem memory-frontier-assimilation.md 已经明确提到 Mem0 v2/v3 是当前 production 工程化最强信号。"单次抽取 + entity linking + 不强制建图"路线已经写进 F1 实施顺序。补充：Mem0 v3 已经 ADD-only（不返回 update/delete），quilin-mem 的 `supersedes` 关系正好对应"靠新 fact 否定旧 fact"。

#### 1.1.6 Zep: A Temporal Knowledge Graph Architecture for Agent Memory
- **arxiv**：[2501.13956](https://arxiv.org/abs/2501.13956)（Rasmussen et al., 2025）｜repo: [getzep/graphiti](https://github.com/getzep/graphiti)
- **核心 idea**：bi-temporal edges（valid_from / valid_to）+ episode/entity/community 三子图 + 实时增量更新。DMR 94.8% vs MemGPT 93.4%；LongMemEval +18.5% accuracy, -90% latency。
- **与 quilin-mem 相关性**：quilin-mem D-20 已经明确放弃 Graphiti 作为依赖（embedded Kuzu 工程阻塞 + Mem0 v2 反超 22pts），但保留"bi-temporal edges 自研实现"思想。Zep 的"community 子图"是 quilin-mem 没考虑过的 — 自动聚类相关记忆形成 cluster，retrieval 时整 cluster 召回。

#### 1.1.7 MIRIX: Multi-Agent Memory System for LLM-Based Agents
- **arxiv**：[2507.07957](https://arxiv.org/abs/2507.07957)（Wang & Chen, 2025）
- **核心 idea**：6 种记忆类型（Core / Episodic / Semantic / Procedural / Resource / Knowledge Vault）由 6 个 sub-agent 协调管理，**首个原生多模态**（screenshot VQA）。LOCOMO 85.4% SOTA；ScreenshotVQA 比 RAG +35% accuracy / -99.9% storage。
- **与 quilin-mem 相关性**：MIRIX 把 quilin-mem 当前 4 层（working / episodic / semantic / skill）扩到 6 层，多了 **Resource Memory（文件/图片等大对象）** 和 **Knowledge Vault（敏感 PII 隔离区）**。后者跟 quilin-mem `trust_tier` 字段对应，但 MIRIX 是物理隔离存储，quilin-mem 是逻辑标签 — 升级路径明确。多模态 memory 是 quilin-mem 完全没碰过的方向。

#### 1.1.8 MemMachine: Ground-Truth-Preserving Memory System
- **arxiv**：[2604.04853](https://arxiv.org/abs/2604.04853)（2026）｜repo: [MemMachine/MemMachine](https://github.com/MemMachine/MemMachine)
- **核心 idea**：拒绝 lossy LLM extraction —— 整段对话原文保留（episodic），profile 单独存 SQL，retrieval 时 nucleus match + 周围 context 一起拉。LongMemEvalS 93.0%。
- **与 quilin-mem 相关性**：跟 MemPalace 同流派（verbatim store），但 MemMachine 工程实践更清晰 — episodic / profile / working 三层物理分开（graph / SQL / in-memory）。quilin-mem L2 verbatim episodic 思路一致；profile 用 markdown 而不是 SQL 是 quilin 的差异化（更可读、可手工编辑）。

### 1.2 工程化 / Engineering & Production

#### 1.2.1 H-MEM: Hierarchical Memory for High-Efficiency Long-Term Reasoning
- ResearchGate / arxiv 检索结果：H-MEM 把 memory 组织成多级 tree，retrieval 用 tree traversal 减少向量检索范围 — token 效率高。
- **与 quilin-mem 相关性**：quilin-mem 当前是平铺 4 层；H-MEM 启发我们考虑"每层内部再按主题/项目 hash 树状组织"，特别适合用户有 N 个独立项目时避免 cross-project 召回污染。

#### 1.2.2 HiMem: Hierarchical Long-Term Memory for Long-Horizon Agents
- **arxiv**：[2601.06377](https://arxiv.org/abs/2601.06377)（2026）
- **核心 idea**：cognitively consistent event segmentation + memory-type-aware semantic alignment + 用 usage-driven reconsolidation 调整结构。
- **与 quilin-mem 相关性**：event segmentation（哪里切一段 episode）是 quilin-mem 当前的盲点 —— L2 verbatim 默认按 turn 切，没考虑"用户切换话题时 episode boundary 在哪"。HiMem 提供了认知科学背书的切分启发式（topic shift / time gap / speaker change）。

#### 1.2.3 Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models
- 2025 paper（GitHub 列表中 Alita-G / Agentic Context Engineering 同期）。
- **核心 idea**：把 context engineering 自身视为可被 agent 修改的对象（self-improving prompt + memory layout），用 trajectory 数据驱动 context 结构演化。
- **与 quilin-mem 相关性**：跟 quilin 的 10-self-evolution 重叠度高。memory 与 context engineering 的边界正在融合 — context 不再只是"组装"，而是被 self-evolve。quilin 应把 02-context 的 RelevanceSelector 权重也纳入 self-evolution 的优化空间。

#### 1.2.4 Building Self-Evolving Agents via Experience-Driven Lifelong Learning
- 2025 paper（August）。
- **核心 idea**：把 agent experience 当 lifelong learning dataset，memory + skill + policy 三个层共同 evolve。
- **与 quilin-mem 相关性**：quilin-mem L4 Skill Memory + 10-self-evolution 的 patch proposal 路线已经覆盖部分，但这篇强调 **"benchmark 也跟着任务 evolve"** —— quilin 当前 benchmark frozen，没有自动生成新评测用例的机制，是缺口。

### 1.3 评测论文 / Evaluation Papers

#### 1.3.1 LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory
- **arxiv**：[2410.10813](https://arxiv.org/abs/2410.10813)（Wu et al., ICLR 2025）｜repo: [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- 详见 §2.1。

#### 1.3.2 LoCoMo: Evaluating Very Long-Term Conversational Memory of LLM Agents
- **arxiv**：[2402.17753](https://arxiv.org/abs/2402.17753)（Maharana et al., 2024）｜project: [snap-research/locomo](https://snap-research.github.io/locomo/)
- 详见 §2.2。

#### 1.3.3 PerLTQA: A Personal Long-Term Memory Dataset
- **arxiv**：[2402.16288](https://arxiv.org/abs/2402.16288)（SIGHAN 2024）
- 详见 §2.5。

### 1.4 安全 / Memory Security

#### 1.4.1 AgentPoison: Red-Teaming LLM Agents via Memory or Knowledge Base Backdoor Poisoning
- **arxiv**：[2407.12784](https://arxiv.org/abs/2407.12784)（NeurIPS 2024）
- **核心 idea**：用对抗优化把恶意 trigger 注入 agent 的 RAG memory store，触发 backdoor 行为（用 < 0.1% poison rate 达 80%+ attack success）。
- **与 quilin-mem 相关性**：quilin-mem memory-frontier-assimilation.md 已经列入但未实现 defense。**这是 quilin 当前最大的安全缺口** —— `QUI-53 WriteAuthority` 只控 agent 自己的写，没控住"用户主动给 agent 的网页 / 工具输出注入"。

#### 1.4.2 A-MemGuard: Proactive Defense for LLM-Based Agent Memory
- **arxiv**：[2510.02373](https://arxiv.org/abs/2510.02373)（NTU et al., 2025）
- **核心 idea**：retrieval 时取多条相关 memory 做并行 reasoning path，**consensus check** —— 单条 memory 推出的结论若偏离 group consensus 则标 anomaly，并把失败案例蒸馏成 `safety_lesson` 单独存。EHRAgent 上把 attack success rate 从 100% 降到 2.13%。
- **与 quilin-mem 相关性**：quilin-mem frontier-assimilation 已提到 `safety_lesson` 是独立 memory_kind。A-MemGuard 的 **consensus check** 是 quilin 还没实现的核心防御机制 —— retrieval 应该返回 top-K 并跑 K 路 reasoning，divergent 的标 quarantine。

#### 1.4.3 MemoryGraft: Persistent Memory Poisoning in LLM Agents
- **arxiv**：[2512.16962](https://arxiv.org/abs/2512.16962)（2025-12）
- **核心 idea**：植入"看似无害的成功经验"到 long-term memory，未来语义相似任务被检索时**触发恶意 procedure 模板** —— trigger-free，跨 session 持续生效。MetaGPT DataInterpreter 上 ~48% poisoned recall。
- **与 quilin-mem 相关性**：quilin-mem 当前的 `skill_id` + L4 procedural memory 正好是 MemoryGraft 的攻击面。procedural memory 提升前的 consensus check + cryptographic provenance attestation（来源签名）必须做 —— 否则别人投毒一个"成功 deploy 模板"，未来 agent 真按它部署。

#### 1.4.4 OWASP Agent Memory Guard
- [OWASP project](https://owasp.org/www-project-agent-memory-guard/)
- **核心 idea**：业界标准化的 agent memory 安全 checklist — cryptographic baseline / policy check / snapshot / rollback。
- **与 quilin-mem 相关性**：quilin-mem 应直接对齐 OWASP checklist 作为 release gate（类似 OWASP Top 10 之于 web）。

### 1.5 神经科学启发 / Neuroscience-Inspired

#### 1.5.1 Learning to Forget: Sleep-Inspired Memory Consolidation
- **arxiv**：[2603.14517](https://arxiv.org/abs/2603.14517)（2026）
- **核心 idea**：SleepGate framework — key decay + learned gating + consolidation 三个 sleep-inspired 模块解决 proactive interference（旧记忆干扰新学习）。
- **与 quilin-mem 相关性**：quilin-mem 当前没有 KV cache 层的"interference resolution"概念。sleep-inspired forgetting curve 比 Ebbinghaus 更精细，可以作为 Reflector 的子模块。

#### 1.5.2 Sleep-Consolidated Memory (SCM) for LLMs
- **arxiv**：[2604.20943](https://www.emergentmind.com/papers/2604.20943)（2026）
- **核心 idea**：bounded working memory + multidimensional importance tagging + offline sleep-driven consolidation + algorithmic forgetting + computational self-model。
- **与 quilin-mem 相关性**：跟 Letta sleep-time compute 思路同源，但更接近 quilin "idle-evolution budget" 的设计。**multidimensional importance tagging**（importance 不是单一标量，是 [novelty, utility, emotion, recency] 多维向量）值得 quilin-mem 直接吸收 —— 单一 importance score 容易让"高频但低价值"和"低频但关键"被压平。

#### 1.5.3 Sleep-time Compute: Beyond Inference Scaling at Test-time
- **arxiv**：[2504.13171](https://arxiv.org/pdf/2504.13171)（Letta, 2025-04）
- **核心 idea**：agent idle 时不闲着，跑 background 子 agent **预消化 context、refine memory、预测用户下次提问** —— 用户真问的时候直接 retrieve 预算好的答案。
- **与 quilin-mem 相关性**：quilin "Idle Evolution Budget" 已经规划但实施有限。sleep-time compute 给出了清晰的"sleep agent 与 primary agent 共享 memory block"的多 agent 编排范式，比 quilin 当前只做 memory consolidation 更激进。

### 1.6 综述 / Surveys

#### 1.6.1 Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers
- **arxiv**：[2603.07670](https://arxiv.org/abs/2603.07670)（2026）
- **核心 idea**：write-manage-read loop + 三维 taxonomy（temporal scope / representational substrate / control policy）+ 五大 mechanism family（context compression / retrieval-augmented / reflective self-improvement / hierarchical virtual context / policy-learned management）。
- **与 quilin-mem 相关性**：当前最权威的 framework — quilin-mem 的 4 层 + Reflector + Hybrid Retrieval 全部能对号入座。建议用这篇的 taxonomy 重写 03-memory README 的"业界对比表"。

#### 1.6.2 LLM Agent Memory: A Survey from a Unified Representation–Management Perspective
- [preprints.org](https://www.preprints.org/manuscript/202603.0359) / [OpenReview](https://openreview.net/forum?id=KPs1EgGKcT)（2026-03）
- **核心 idea**：把所有 memory 方案归并到 3 种 representation（natural language tokens / intermediate representations / parameters）× 3 个 management stage（construction / update / query）的 9 格矩阵。
- **与 quilin-mem 相关性**：quilin-mem 当前主走 "natural language tokens"（FactEvent + verbatim + KG triple）路线；intermediate representations（latent embeddings as memory）和 parameters（fine-tune as memory，类似 GPT4-RAG 的 in-weights memory）都没覆盖。是否要走 multi-paradigm 取决于 model scaling 预算。

#### 1.6.3 Memory in LLM-based Multi-agent Systems: Mechanisms, Challenges, and Collective Intelligence
- [techrxiv preprint](https://www.techrxiv.org/users/1007269/articles/1367390)
- **核心 idea**：multi-agent 场景下的 memory — shared memory blocks / agent-isolated memory / consensus memory（多 agent 投票决定的"事实"）。
- **与 quilin-mem 相关性**：quilin-mem 当前只服务单 agent，多 agent 共享 memory 的 contract 还没设计。 11-agent-mesh 落地前需要先答清楚 —— shared memory 还是 agent-isolated？谁有 write authority？

---

## 2. Benchmark / Evaluation Harness

### 2.1 LongMemEval — 长期交互记忆
- **测什么**：5 类核心能力 — information extraction / cross-session reasoning / temporal reasoning / knowledge updates / abstention。
- **评测维度**：answer accuracy（GPT-4o LLM-judge，>97% agreement with human）+ Recall@k / NDCG@k（若 retrieval log 可用）。
- **dataset 规模**：500 人工筛选 questions + 可缩放的 chat history（s / m / oracle 三档）。
- **SOTA**：MemPalace 96.6% (raw) / Mastra Observational Memory 94.87% (gpt-5-mini) / Mem0 v2 93.4% / MemMachine 93.0% / Honcho 90.4-92.6% (Gemini 3 Pro) / Zep+Graphiti 71.2%。
- **quilin-mem 是否值得参加**：值得，但当前 Benchmark Freeze 状态（2026-05-02 起），需用户显式解冻才能跑。怎么参加：
  1. clone repo, 用 `longmemeval_s_cleaned` split 做 smoke
  2. 输入按 paper 5 段 schema（question_id / haystack_sessions / answer_session_ids）
  3. 输出官方 QA JSONL + Quilin evidence sidecar
  4. 评测调官方 LLM-as-judge eval 脚本
- **link**：[arxiv 2410.10813](https://arxiv.org/abs/2410.10813) / [github](https://github.com/xiaowu0162/LongMemEval)

### 2.2 LoCoMo — 超长对话记忆
- **测什么**：长达 35 sessions / 300 turns / 9K tokens 的多模态对话 — factual recall / temporal / causal / multi-modal understanding。
- **评测维度**：question answering / event summarization / multi-modal dialogue generation。
- **dataset 规模**：10 长对话，每个 ~35 sessions。
- **SOTA**：Honcho 89.9% / MIRIX 85.4%。
- **quilin-mem 是否值得参加**：**强烈值得** —— 多模态部分（含图片）正好测试 MIRIX-style "Resource Memory" 是否必要。当前 quilin-mem 不支持图片，跑 LoCoMo 多模态 split 会暴露这个缺口。
- **link**：[arxiv 2402.17753](https://arxiv.org/abs/2402.17753) / [project page](https://snap-research.github.io/locomo/) / [github](https://github.com/snap-research/locomo)

### 2.3 BEAM — 超长对话 (10M tokens)
- **测什么**：把对话 scale 到 128K-10M tokens，测 multi-scale memory abilities — 6 大 probing category。
- **评测维度**：official BEAM probing flow（参考 [arxiv 2510.27246](https://arxiv.org/abs/2510.27246)）+ benchmarking and enhancing long-term memory baseline。
- **dataset 规模**：10M token 级长对话。
- **SOTA**：Honcho top scores across all BEAM tests（October 2025 release）。
- **quilin-mem 是否值得参加**：值得做 smoke（5K-50K token 区间），全量 10M 暂时不实际（成本高）。当前 quilin Benchmark Freeze 状态。
- **link**：[arxiv 2510.27246](https://arxiv.org/abs/2510.27246) / [github](https://github.com/mohammadtavakoli78/BEAM) / [HF dataset](https://huggingface.co/datasets/Mohammadta/BEAM)

### 2.4 DialSim — 多角色对话理解
- **测什么**：扮演 TV show（Friends / The Big Bang Theory / The Office）角色，回答 spontaneous question。**首个时间约束 benchmark**（real-time accuracy）。
- **评测维度**：exact match → LLM-as-judge fallback；time-constrained accuracy。
- **dataset 规模**：3 个 TV show × 350K tokens avg dialogue length。
- **SOTA**：未明确 public leaderboard；论文报告 large-context LLM + RAG 仍 struggle。
- **quilin-mem 是否值得参加**：**独特视角值得**（其他 benchmark 都不测延迟约束），但版权风险 — TV show 对白是 copyright 内容，谨慎使用。
- **link**：[arxiv 2406.13144](https://arxiv.org/abs/2406.13144)

### 2.5 PerLTQA — 个人长期记忆
- **测什么**：30 个角色的 8,593 questions，覆盖 world knowledge / profile / social relationships / events / dialogue 5 类。
- **评测维度**：memory classification + retrieval + synthesis 三阶段独立打分。
- **dataset 规模**：30 characters × ~286 questions/character。
- **SOTA**：BERT-based classifier 在 memory classification 上反超 ChatGLM3 / ChatGPT。
- **quilin-mem 是否值得参加**：值得 —— **中文 benchmark**（SIGHAN 2024），可以暴露 quilin 当前 L3a observer "zh 0.0% recall" 的中文盲点。
- **link**：[arxiv 2402.16288](https://arxiv.org/abs/2402.16288)

### 2.6 MemBench (ACL 2025)
- **测什么**：factual memory + reflective memory，participation / observation 两种交互场景，effectiveness + efficiency + capacity 三大方面。
- **评测维度**：综合分（精度 / 召回 / 推理深度 / token efficiency）。
- **SOTA**：GPT-4o-mini 综合最强；Llama-3.1-8B factual 弱但 reflective 强 — 模型规模与记忆能力非线性。
- **quilin-mem 是否值得参加**：值得做 smoke。reflective memory 部分正好测试 quilin reflector。
- **link**：[arxiv 2506.21605](https://arxiv.org/abs/2506.21605)

### 2.7 MemoryBench (2025-10)
- **测什么**：memory + continual learning 联合评测 — 多 domain / 多语言 / 用户 feedback 累积下的 LLMSys 表现。
- **评测维度**：效果（accuracy under feedback accumulation）+ 效率（cost / latency）。
- **dataset 规模**：多 domain（factual / reasoning / coding / dialogue）。
- **SOTA**：作者明确"现有 SOTA 都远未满意"，蓝海 benchmark。
- **quilin-mem 是否值得参加**：**最值得 ship 的一个** —— "用户 feedback 累积"是 quilin 个性化 / Profile self-evolution 的核心场景，正好对 quilin user profile + reflector pipeline。
- **link**：[arxiv 2510.17281](https://arxiv.org/abs/2510.17281)

### 2.8 EvolMem (2026-01)
- **测什么**：cognitive psychology 基础的 multi-session memory — declarative + non-declarative，多 fine-grained ability。
- **评测维度**：cognitive science-grounded sub-tasks，sample-specific evaluation guideline。
- **SOTA**：作者明确"no LLM consistently outperforms others across all memory dimensions" — 没有 winner-takes-all。
- **quilin-mem 是否值得参加**：值得，特别是 non-declarative memory（procedural / habit / skill）正好测试 quilin L4 Skill Memory。
- **link**：[arxiv 2601.03543](https://arxiv.org/abs/2601.03543)

### 2.9（额外）MemoryRewardBench
- **测什么**：评估 **reward model** 监督 long-term memory update 的能力（不是评 memory system 本身）。
- **dataset 规模**：10 settings × 8K-128K token contexts。
- **与 quilin-mem 相关性**：quilin 当前没有 reward model 介入 memory consolidation，这个 benchmark 暗示了一条新方向 — 用 RM 当 memory 写入 gate（"这条 fact 该不该 promote 到 semantic？" 由 RM 打分）。
- **link**：[arxiv 2601.11969](https://arxiv.org/abs/2601.11969)

---

## 3. 没关注到的开源 repo / 平台

### 3.1 Honcho — Stateful Social Memory
- [github.com/plastic-labs/honcho](https://github.com/plastic-labs/honcho) / [honcho.dev](https://honcho.dev/)
- **Pitch**：peer-centric memory library — 不只 model 用户，还 model agent / NPC / group / 它们的关系。FastAPI 自托管 + 托管服务双模式。LongMemEval S 90.4%（Gemini 3 Pro 92.6%）/ LoCoMo 89.9% / BEAM 全部 top score（10M token 级）。
- **跟 14 repo 关系**：补充视角 — Mem0 / Letta / Zep 都是 user-centric，Honcho 是 **multi-entity-relational**。quilin-mem 目前主要 user_id 维度，没考虑"agent 之间 / NPC 之间"的关系建模。如果 11-agent-mesh 起来，Honcho 的 peer 模型值得抄。

### 3.2 MemMachine
- [github.com/MemMachine/MemMachine](https://github.com/MemMachine/MemMachine) / [memmachine.ai](https://memmachine.ai/)
- **Pitch**：ground-truth-preserving — episodic（graph）/ profile（SQL）/ working（in-memory）物理三层分开。LongMemEvalS 93.0%。
- **跟 14 repo 关系**：跟 MemPalace 同流派（verbatim）但工程更清爽。quilin-mem L2 episodic（SQLite + FTS）思路一致。

### 3.3 Memoria — Git for AI Memory
- [dev.to introducing-memoria](https://dev.to/origin_matrix_b790e656217/introducing-memoria-the-worlds-first-git-for-ai-agent-memory-4108)
- **Pitch**：首个把 git core abstraction（branch / merge / diff / blame）搬到 agent memory 的开源 lib。Mem0 / Letta / Zep 都是 append-or-update，**没有 version control** —— Memoria 补这个缺口。
- **跟 14 repo 关系**：独特 —— 14 repo 里 Letta 有 Context Repositories（Git for memory checkpoint）但未独立成产品。quilin-mem `supersedes` 字段是简化版 git diff，可以参考 Memoria 设计 `git checkout memory@T1` 的能力（debug / 回滚 / time-travel reasoning）。

### 3.4 Memori
- search 结果中提到的 "agent-native memory infrastructure providing an LLM-agnostic layer"
- **Pitch**：把 agent execution 与 conversation 都结构化成 persistent state，跨 LLM provider 无锁定。
- **跟 14 repo 关系**：定位类似 SuperMemory，但更工程化（infrastructure 层而非 SDK）。

### 3.5 agentmemory (rohitg00)
- [github.com/rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)
- **Pitch**：tool output → SHA-256 dedup → privacy filter → LLM compress → vector embed across 6 providers → BM25 + vector dual index。**专门为 coding agent 设计**（claim "#1 persistent memory for AI coding agents"）。
- **跟 14 repo 关系**：补充 —— coding agent 场景下的 memory 有独特需求（tool output 巨大、privacy 敏感、需 dedup），主流 lib 都没专门优化。quilin 跟 Claude Code / Codex 性质相同，应该深读这个 repo 的 dedup / privacy filter 实现。

### 3.6 Stash
- search 结果："persistent memory layer for AI agents with episodes, facts, and working context stored in Postgres, MCP server included, self-hosted capability"
- **跟 14 repo 关系**：补充 —— PostgreSQL 后端 + MCP server，跟 quilin-mem 的 SQLite + MCP 思路同源但更 production-ready。

### 3.7 AutoMem
- search 结果："graph-vector memory service providing AI assistants with durable, relational memory"
- **跟 14 repo 关系**：跟 cognee / Zep 同流派，补充。

### 3.8 NirDiamant/Agent_Memory_Techniques (教程仓库)
- [github.com/NirDiamant/Agent_Memory_Techniques](https://github.com/NirDiamant/Agent_Memory_Techniques)
- **Pitch**：30 个 runnable Jupyter notebooks — conversation buffers / vector stores / KG / episodic / semantic / MemGPT / Mem0 / Letta / Zep / Graphiti / LoCoMo benchmark / production pattern。最佳学习入口。
- **跟 14 repo 关系**：不是 lib，是教程合集。**对 quilin docs 极有价值** —— 想 cover 哪个流派直接对应 notebook 就能给出 best-practice code template。

### 3.9 TsinghuaC3I/Awesome-Memory-for-Agents
- [github.com/TsinghuaC3I/Awesome-Memory-for-Agents](https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents)
- **Pitch**：清华 C3I 维护的中文友好 paper list。
- **跟 14 repo 关系**：metaresource，可作为 quilin docs/03-memory/memory-watchlist/ 的 upstream 镜像。

### 3.10 Shichun-Liu/Agent-Memory-Paper-List
- [github.com/Shichun-Liu/Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- 配套 "Memory in the Age of AI Agents: A Survey"。
- **跟 14 repo 关系**：同 3.9，paper list。

### 3.11 VoltAgent/awesome-ai-agent-papers
- [github.com/VoltAgent/awesome-ai-agent-papers](https://github.com/VoltAgent/awesome-ai-agent-papers)
- **Pitch**：专门收录 2026 AI agent paper（含 memory section），更新积极。
- **跟 14 repo 关系**：paper hub，更新比 awesome-agent-memory 更新颖。

### 3.12 TeleAI-UAGI/Awesome-Agent-Memory
- [github.com/TeleAI-UAGI/Awesome-Agent-Memory](https://github.com/TeleAI-UAGI/Awesome-Agent-Memory)
- **Pitch**：systems / benchmarks / papers on memory for LLMs/MLLMs（多模态版），include long-term context + retrieval + reasoning。
- **跟 14 repo 关系**：覆盖多模态视角，MIRIX 的 ScreenshotVQA 也属于这块。

### 3.13 LCM-Lab/MemRewardBench
- [github.com/LCM-Lab/MemRewardBench](https://github.com/LCM-Lab/MemRewardBench)
- benchmark repo（见 §2.9）。

### 3.14 Pinecone Assistant + Qdrant Cloud Inference + Weaviate Verba（vector DB 自带 memory）
- [github.com/weaviate/verba](https://github.com/weaviate/verba)
- **Pitch**：vector DB 厂商把 memory layer 内置到产品 — Pinecone Assistant（GA 2025-01）一个 endpoint 含 chunking + embed + search + rerank + answer；Qdrant Cloud Inference 把 embedding 带进 cluster；Weaviate Verba 是 RAG chatbot 模板。
- **跟 14 repo 关系**：基础设施层而非应用层。quilin-mem 默认 SQLite + Chroma 本地化，但当用户规模扩张需要 hosted vector DB 时，这三个是主流选项。

---

## 4. Quilin docs 现有 research insight 提取

读完 [`docs/03-memory/README.md`](../03-memory/README.md)（1378 行）、[`memory-frontier-assimilation.md`](../03-memory/memory-frontier-assimilation.md)、[`long-memory-evaluation-baseline.md`](../03-memory/long-memory-evaluation-baseline.md)、[`docs/10-self-evolution/README.md`](../10-self-evolution/README.md)、[`docs/02-context/README.md`](../02-context/README.md)、[`docs/13-skills/README.md`](../13-skills/README.md)、[`docs/16-soul-import/README.md`](../16-soul-import/README.md) 后，quilin docs **已经想到的** insights：

### 4.1 架构层 / Architecture
1. **4 层分级（working / episodic / semantic / skill）** — 借鉴 MIRIX / Letta，但 procedural 单写方原则交给 13-skills（避免双写漂移）
2. **D-20 v2 融合架构** — 不押注单库，五流派分工（MemPalace verbatim + Mastra observer + Graphiti temporal KG + Mem0 hybrid retrieval + OpenViking filesystem hierarchy）
3. **同步 L1 + 异步 L2-L3 ingestion** — eventual consistency，verbatim 优先保证不丢
4. **Lazy temporal KG** — intent classifier 识别 temporal intent 才抽，节省 90% 抽取成本
5. **Hybrid retrieval（vector + BM25 + entity linking + 选择性 KG）** — 直接对齐 Mem0 v3 ADD-only + entity linking 路线
6. **prompt cache block-level invalidation** — 比 Mastra OM 的稳定前缀更细粒度

### 4.2 数据契约 / Data Contract
7. **`FactEvent` schema** — fact_id / source_event_id / actor / memory_kind / content / entities / observed_at / valid_from / valid_to / supersedes / confidence / trust_tier / provenance_receipt_id / write_policy_result
8. **5 种 memory_kind**：semantic / episodic / procedural / profile / safety_lesson
9. **provenance receipt** — receipt_id / source_event_id / raw_content_hash / source_uri / actor_id / tool_call_id / run_id / trace_id / observer_version / model_id / prompt_version / policy_decision / derived_fact_ids / retrieval_use_count
10. **bi-temporal edges**（valid_from / valid_to）+ `supersedes` / `invalidates` 关系 — append-only 默认
11. **MemoryStore Protocol** — add / search / get / update / delete / list_by_layer / count / clear_layer 统一接口

### 4.3 写入路径 / Write Path
12. **Dual-path observer**（rule-first + LLM fallback）但 rule-first 在中文 / 短文本上 recall 21.4% 不达标，需要 escalation-aware bilingual 多模式
13. **quarantine queue** — 低置信 fact 不静默丢弃，进隔离区附 reason code（ambiguous_reference / conflicting_source / low_trust_actor / possible_instruction_injection / needs_human_review）
14. **WriteAuthority gate** — 跟 07-safety §2.6.4 集成，tool output / web page / low-trust agent 默认 quarantine

### 4.4 读取路径 / Read Path
15. **Intent classifier 加权 fan-out** — factual / temporal / preference / procedural 4 类 intent 各自加权召回
16. **并行召回 + RRF fusion + optional LLM rerank** — Cognee-style 三阶段
17. **stable memory prefix as N independently invalidated blocks** — 给 02-context 用

### 4.5 安全 / Security
18. **3 时序防御**（write-time / retrieval-time / promotion-time）
19. **trust + source label on every returned memory** — low-trust fact 不可成为 system instruction / persistent preference
20. **consensus check + safety_lesson 独立 kind**（A-MemGuard 思想）
21. **source hash + snapshot rollback**（OWASP baseline）

### 4.6 演化 / Evolution
22. **idle-budget gated consolidator** — 跟 10-self-evolution 共享预算
23. **3 件事：deep reflection / KG 过期边剪枝 / verbatim 差分再压缩**
24. **human-in-loop** — reflection 产出的"insight" 经 WriteAuthority 落盘
25. **L4 单写方原则** — skill body 在 13-skills，03-memory 只存 usage stat
26. **learnable reranker per user** — 记录"哪些召回最终被引用" → 训练 logistic regression
27. **per-user retrieval weight profile** — 不同用户对 temporal / semantic / entity 的依赖不同

### 4.7 评测 / Evaluation
28. **5 Memory-specific metrics**：observer write precision / observer write recall / provenance coverage / poisoning rejection rate / safe promotion rate
29. **QUI-65 close 门槛**：answer accuracy ≥0.90 / evidence recall@5 ≥0.90 / contradiction pass 1.00 / abstention pass 1.00 / profile false positive 0 / provenance coverage 1.00 on promoted / poisoning rejection 1.00 on seeded / p95 latency <300ms on 100K stress
30. **本地 fixture lane 优先**（QUI-73），公开 benchmark 是验证 lane（QUI-65 不强 gate）

### 4.8 集成 / Integration
31. **唯一写入方（ProfileUpdater）** — UserProfile 跨域写入避免 race
32. **schema_version 字段** — 跨版本迁移
33. **Departure Context** — 用户 >30 分钟未响应自动记录上下文摘要 + 未完成 action
34. **MEMORY.md / user.md / soul.md / QUILIN.md 四级文件契约** — install-time bootstrap by 16-soul-import；runtime evolution by 03-memory + 10-self-evolution
35. **跨语言写锁** — Python fcntl + TS proper-lockfile，避免 user.md double write race

---

## 5. 跟 14 repo 调研的 cross-reference

> 假设 14 repo 是 `~/repo/mem/{mem0, letta, graphiti, zep, cognee, supermemory, mempalace, mastra, openviking, hindsight}` + `~/repo/{langmem, langgraph-memory, llamaindex-memory, agentcore-memory}` 之类（具体清单 14 repo subagent 在跑）。下表标注哪些 paper / repo 在 14 repo 里已实现 / 哪些是补充视角：

| Paper / Repo (§1, §3) | 14 repo 是否已 cover | 角色 |
|---|---|---|
| MemGPT | 是（Letta repo） | 已 cover |
| A-MEM | 是（agiresearch/A-mem repo） | 已 cover |
| Mem0 | 是（mem0ai/mem0 repo） | 已 cover |
| Zep + Graphiti | 是（getzep/graphiti repo） | 已 cover |
| Generative Agents | 14 repo 通常不含（Smallville 闭源） | **补充视角 paper-only** |
| MemoryBank | 论文为主，无 prod-grade repo | **补充视角 paper-only** |
| MIRIX | 论文 + repo 待确认 | **补充视角 paper-only**（如未 cover） |
| MemMachine | repo（§3.2）通常 14 repo 没含 | **新视角 repo** |
| Honcho | 通常 14 repo 没含 | **新视角 repo** |
| Memoria | 全新概念 | **新视角 repo** |
| agentmemory (rohitg00) | 通常 14 repo 没含（小众） | **新视角 repo** |
| Stash / AutoMem / Memori | 小众，14 repo 通常没含 | **新视角 repo** |
| NirDiamant/Agent_Memory_Techniques | 教程库，14 repo 通常没含 | **学习入口** |
| TsinghuaC3I/Awesome-Memory-for-Agents | meta resource | **补充 paper list** |
| Generative Agents | 论文 | **补充 paper** |
| H-MEM / HiMem | 论文 | **补充 paper** |
| AgentPoison | 安全论文 | **补充 paper - 安全** |
| A-MemGuard | 防御论文 | **补充 paper - 安全** |
| MemoryGraft | 攻击论文 | **补充 paper - 安全** |
| OWASP Agent Memory Guard | 行业标准 | **补充 - 标准** |
| Sleep-time compute / SleepGate / SCM | 神经科学启发 paper | **补充 paper - 神经科学** |
| Sleep-time agents (Letta) | 14 repo 已含 Letta，但 sleep-time 是 2025 新功能 | **可能未 cover** |
| LongMemEval / LoCoMo / BEAM | dataset，14 repo 通常含但不深读 | **补充 - benchmark spec** |
| DialSim / PerLTQA / MemBench / MemoryBench / EvolMem | dataset / benchmark paper | **补充 - benchmark spec** |
| MemoryRewardBench | reward model benchmark | **新角度** |
| 综述 (Memory for Autonomous LLM Agents, Unified Representation-Management) | survey | **补充 - 综述** |
| Pinecone Assistant / Qdrant Cloud Inference / Weaviate Verba | infra，14 repo 通常含某一家 | **补充 - infra** |

---

## 6. quilin-mem 还没考虑到但应该 ship 的 5 条 idea

> 从联网调研挖出来的、quilin docs 当前**没明确提到**的 5 条 ship-worthy idea。每条给 1 段 pitch + 落地建议。

### 6.1 Multidimensional importance tagging（SCM / 2604.20943 启发）

**Pitch**：quilin-mem 当前 `importance_score: float` 是单一标量，无法区分"高频 trivia"（access_count 高但价值低）和"低频关键"（一次重要决策 access_count 低但不能忘）。SCM 提出 importance 应是多维向量：`[novelty, utility, emotion, recency]` 或 quilin 自定义维度（factuality / personal_relevance / actionability / cross-session_stability）。

**落地建议**：把 `MemoryItem.importance_score` 升为 `Importance` dataclass，含 4-6 个独立维度；retrieval 时按 intent 加权（temporal intent → recency 权重 ↑；preference intent → personal_relevance 权重 ↑）。**比"importance × time_decay × access_count"复合公式可解释性更强**。

### 6.2 Consensus-check retrieval（A-MemGuard 启发）

**Pitch**：A-MemGuard 95% poisoning attack 降级靠的是 **retrieval 时拉 top-K 跑 K 路 reasoning**，divergent path 标 anomaly 并蒸馏为 safety_lesson。quilin-mem frontier-assimilation 已经把 safety_lesson 列为独立 memory_kind，但没明确"如何检测 divergence" —— A-MemGuard 给出了答案。

**落地建议**：在 `MemoryRetriever.retrieve()` 之上加一层 `ConsensusGate`，retrieval 返回 top-3 candidates → 用小模型（flash 档）跑 3 路 reasoning sketch → 若 1 路明显偏离则标 quarantine + 写 safety_lesson。**成本：每次 retrieval 多 1 个 flash 调用，可接受**。

### 6.3 Sleep-time agent（Letta sleep-time compute 启发）

**Pitch**：quilin 当前"idle evolution"只跑 memory consolidation（reflector / KG 剪枝 / verbatim 压缩），是被动批处理。Sleep-time agent 主动 **预消化 next-likely-query**：基于用户最近 N 轮对话的话题嵌入 + 时间模式（"用户每周一早 9 点都问周报"），背景 sub-agent 预先 retrieve + reason，把"今日周报草稿"放进 prompt cache。

**落地建议**：跟 `10-self-evolution/idle-runner` 集成，新增 `predictive_warmer` 子任务 — 接 user profile active_hours + recent topic embedding，spawn 小 sub-agent 跑预消化。**ROI 高**：用户体验是"问完秒回"，而预消化成本走 idle budget 不挤占主流程。

### 6.4 Git-style memory time-travel（Memoria 启发）

**Pitch**：quilin-mem 当前 `supersedes` 关系是"新事实指向旧事实"的有向链，但没有"回到 T1 时刻看记忆状态"的 first-class 操作。Memoria 提出 `memory@T1` checkpoint 概念 —— debug 时可以"checkout 到 last Tuesday 的 memory state"看当时为什么 agent 做了某决策；用户也可以 rollback 受污染或错误学习的记忆批次。

**落地建议**：在 SQLite schema 加 `memory_snapshot` 表（按天 / 按 commit-equivalent 时间点 snapshot fact_id 列表 + signature hash）；新增 `memory_checkout(at: datetime)` API 返回那个时刻的 retrieval index。**额外收益**：投毒回滚（OWASP Snapshot Rollback baseline）+ 调试 reproducibility。

### 6.5 Multi-modal Resource Memory（MIRIX 启发）

**Pitch**：quilin-mem 当前完全是文本 — 用户给 agent 截图 / PDF / 图片 / 短视频时，要么走 ad-hoc tool call 处理后丢弃，要么塞进 episode 文本字段。MIRIX ScreenshotVQA 上 +35% accuracy / -99.9% storage 证明 **Resource Memory 独立成层**有巨大 ROI（关键：图片不存 raw bytes，存 vision-encoded latent + caption + retrieval pointer）。

**落地建议**：新增 L2.5 `ResourceStore`（与 L2 verbatim 同级），存非文本资源的元数据 + caption + vision embedding + 原始文件 hash。retrieval 时跨模态融合（query text → match resource caption + visual embedding）。**前置依赖**：选 vision 编码器（CLIP / SigLIP / 多模态 model API）。**优先级**：等用户场景出现真实多模态需求再做（当前可能不紧迫），但要在 L2 schema 设计时**预留 resource_pointer 字段**避免未来 schema 破坏性升级。

---

## 附：参考链接清单 / Reference Links

### Papers
- MemGPT [arxiv 2310.08560](https://arxiv.org/abs/2310.08560)
- Generative Agents [arxiv 2304.03442](https://arxiv.org/abs/2304.03442)
- MemoryBank [arxiv 2305.10250](https://arxiv.org/abs/2305.10250)
- A-MEM [arxiv 2502.12110](https://arxiv.org/abs/2502.12110)
- Mem0 [arxiv 2504.19413](https://arxiv.org/abs/2504.19413)
- Zep [arxiv 2501.13956](https://arxiv.org/abs/2501.13956)
- MIRIX [arxiv 2507.07957](https://arxiv.org/abs/2507.07957)
- MemMachine [arxiv 2604.04853](https://arxiv.org/abs/2604.04853)
- HiMem [arxiv 2601.06377](https://arxiv.org/abs/2601.06377)
- LongMemEval [arxiv 2410.10813](https://arxiv.org/abs/2410.10813)
- LoCoMo [arxiv 2402.17753](https://arxiv.org/abs/2402.17753)
- BEAM [arxiv 2510.27246](https://arxiv.org/abs/2510.27246)
- DialSim [arxiv 2406.13144](https://arxiv.org/abs/2406.13144)
- PerLTQA [arxiv 2402.16288](https://arxiv.org/abs/2402.16288)
- MemBench [arxiv 2506.21605](https://arxiv.org/abs/2506.21605)
- MemoryBench [arxiv 2510.17281](https://arxiv.org/abs/2510.17281)
- EvolMem [arxiv 2601.03543](https://arxiv.org/abs/2601.03543)
- MemoryRewardBench [arxiv 2601.11969](https://arxiv.org/abs/2601.11969)
- AgentPoison [arxiv 2407.12784](https://arxiv.org/abs/2407.12784)
- A-MemGuard [arxiv 2510.02373](https://arxiv.org/abs/2510.02373)
- MemoryGraft [arxiv 2512.16962](https://arxiv.org/abs/2512.16962)
- Memory for Autonomous LLM Agents (survey) [arxiv 2603.07670](https://arxiv.org/abs/2603.07670)
- LLM Agent Memory: Unified Representation-Management Survey [preprints.org 202603.0359](https://www.preprints.org/manuscript/202603.0359)
- Sleep-time Compute [arxiv 2504.13171](https://arxiv.org/pdf/2504.13171)
- Learning to Forget (Sleep-Inspired) [arxiv 2603.14517](https://arxiv.org/abs/2603.14517)
- LOFT [arxiv 2406.13121](https://arxiv.org/abs/2406.13121)

### Repos
- [mem0ai/mem0](https://github.com/mem0ai/mem0)
- [getzep/graphiti](https://github.com/getzep/graphiti)
- [agiresearch/A-mem](https://github.com/agiresearch/A-mem)
- [letta-ai/letta](https://github.com/letta-ai/letta)
- [topoteretes/cognee](https://github.com/topoteretes/cognee)
- [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- [snap-research/locomo](https://github.com/snap-research/locomo)
- [mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM)
- [LCM-Lab/MemRewardBench](https://github.com/LCM-Lab/MemRewardBench)
- [MemMachine/MemMachine](https://github.com/MemMachine/MemMachine)
- [plastic-labs/honcho](https://github.com/plastic-labs/honcho)
- [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)
- [NirDiamant/Agent_Memory_Techniques](https://github.com/NirDiamant/Agent_Memory_Techniques)
- [TsinghuaC3I/Awesome-Memory-for-Agents](https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents)
- [Shichun-Liu/Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [VoltAgent/awesome-ai-agent-papers](https://github.com/VoltAgent/awesome-ai-agent-papers)
- [TeleAI-UAGI/Awesome-Agent-Memory](https://github.com/TeleAI-UAGI/Awesome-Agent-Memory)
- [google-deepmind/loft](https://github.com/google-deepmind/loft)
- [weaviate/Verba](https://github.com/weaviate/verba)
- [MemPalace/mempalace](https://github.com/MemPalace/mempalace)

### Standards / Industry
- [OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/)
- [Letta sleep-time agents docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)
- [Cognee MCP server intro](https://www.cognee.ai/blog/cognee-news/introducing-cognee-mcp)
- [Mem0 State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Honcho benchmarking](https://blog.plasticlabs.ai/research/Benchmarking-Honcho)

---

*调研完成 / Survey complete. 待与 Codex / 14-repo subagent 报告合并去重。*
