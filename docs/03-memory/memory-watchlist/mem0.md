# Mem0

- **上游**：[mem0ai/mem0](https://github.com/mem0ai/mem0)
- **License**：Apache-2.0
- **Stars**：53.5k（2026-04-20）—— 社区最大的开源记忆层
- **主要语言**：Python 58.7% + TypeScript 31.0%
- **对应 quilin-mem v2 层**：L3c Hybrid Retrieval & Fusion（§二·A.7）

## 2026-04-20 baseline digest

**架构摘要**：
- Multi-Level Memory：User / Session / Agent 三层作用域
- Hybrid store：**vector + graph + key-value**
- Retrieval：vector embedding + BM25 keyword + entity extraction 组合召回
- 2026-04 v2 算法：**single-pass extraction + entity linking + multi-signal retrieval**

**Benchmark**（2026-04 v2 后）：
- LocoMo: 91.6（+20 pts）
- LongMemEval: 93.4（+26 pts；老版只有 49.0）

**后端**：多种向量 DB（未在 README 详列）；图部分需 Pro（$249/月）—— **关键商业信号：免费版只是向量 + kv**

**动机分析**：
- v1 → v2 的跳跃不是换架构，而是 retrieval 更智能 —— 证明**硬核在 rerank/召回策略**，不在存储。
- single-pass extraction 是性能优化：从"每条 memory 都抽一次实体"变成"摄入时只抽一次就足够"。

**对 quilin-mem v2 的启示**：
- ✅ **保留**：vector + BM25 + entity linking 的 hybrid 召回路径；多 scope（user/session/agent）隔离；metadata 过滤
- ⚠️ **升级**：Mem0 的 reranker 权重是固定的 → Quilin 改为 **Learnable reranker**，把 agent 实际引用过的召回条目作为正样本训练 logistic regression（feature: source/recency/semantic_sim/graph_distance）
- ⚠️ **升级**：一套权重打天下 → Quilin 改为 **per-user weight profile**（某些用户更依赖 temporal 召回，某些依赖 semantic）
- ❌ **警惕**：Mem0 把 graph 放 Pro 付费墙 —— 这暗示自己实现 graph 并不难，Mem0 的护城河是**召回策略而不是图**

**建议行动**：
- [x] 起 D-20 spec delta（§二·A.7 L3c）
- [ ] 后续 spike：learnable reranker 数据收集流程（M1 阶段）

## 后续 digest

（v3 / 新 benchmark / 新召回策略发布时在此追加）
