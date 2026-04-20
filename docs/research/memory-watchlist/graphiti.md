# Graphiti (Zep)

- **上游**：[getzep/graphiti](https://github.com/getzep/graphiti) —— `graphiti-core`
- **License**：Apache-2.0
- **主要语言**：Python
- **对应 OmniMem v2 层**：L3b Temporal KG（§二·A.7）
- **相关 spike**：[graphiti-spike-report.md](../graphiti-spike-report.md) (Task #93, 2026-04-20)

## 2026-04-20 baseline digest

**架构摘要**：
- **Context Graph**：每条事实是一个 KG 节点，带 **bi-temporal validity window**（valid_from / valid_to）
- **Episode 驱动**：原始输入（对话、文档、事件）称为 Episode；每个 Episode 触发 pipeline：**实体识别 → 关系抽取 → 时序标注 → 增量融合到图中**
- **增量更新**：不同于批处理 KG，Graphiti 支持实时写入，新数据立即可查
- **混合检索**：语义 embedding + BM25 + 图遍历 + 结果 fusion

**Benchmark**：
- LongMemEval (gpt-4o): 71.2% —— 2026-04 已被 Mem0 v2 (93.4%) 和 Mastra OM (84.23%) 反超
- DMR benchmark: 94.8% (vs 93.4% baseline)

**支持后端**：Neo4j、FalkorDB、Kuzu、Amazon Neptune

**Spike 发现的上游缺陷**（2026-04-20，graphiti-core==0.28.2）：
- `Graphiti()` 默认需要 Neo4j URI + OpenAI clients（非 zero-config）
- Python 3.14 无预编译 Kuzu wheel，需源码编译
- `KuzuDriver.build_indices_and_constraints()` 是 **no-op**，但 Graphiti 调用链依赖 FTS 索引 → 第一次 `add_episode()` 崩
- 无公开 `Graphiti.node_search()`，只有内部 helper

**动机分析**：
- Graphiti 2024-2025 的论点是"时序是 agent 记忆的核心" —— 这个论点在 2026 被数据证伪：Mem0 v2 无时序 KG 照样拿 93.4%，Mastra OM 纯 observation 拿 94.87%。
- 时序 KG 真正的价值不在**日常检索**，而在**少数 temporal intent 查询**（"X 在 T 时刻和 Y 的关系") —— 但 Graphiti eagerly 为每条 episode 抽三元组，90% 的工作被浪费。

**对 OmniMem v2 的启示**：
- ✅ **保留**：bi-temporal edges 概念（valid_from / valid_to）、Episode 驱动的抽取管线
- ⚠️ **升级**：eager 抽取 → Quilin 改为 **Lazy extraction**（仅在 intent classifier 判定 temporal 时才抽；抽取结果缓存）
- ❌ **丢弃**：对 Graphiti / Kuzu / Neo4j 的**代码依赖**。我们自写 SQLite 实现（两列 `valid_from` / `valid_to` + 索引 + 递归 CTE 做 hop-N 遍历）
- ❌ **丢弃**：OpenAI 默认客户端。走 Quilin 自己的 LLM client 抽象

**建议行动**：
- [x] D-12 撤销，被 D-20 §二·A.7 L3b 取代
- [x] 已归档 spike 证据到 [graphiti-spike-report.md](../graphiti-spike-report.md)

## 后续 digest

（上游 FTS bootstrap bug 若被修复 / Python 3.14 wheel 若正式发布 / 新 benchmark 数据 → 在此追加）
