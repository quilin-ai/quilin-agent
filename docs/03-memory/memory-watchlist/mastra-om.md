# Mastra Observational Memory

- **上游**：[mastra-ai/mastra](https://github.com/mastra-ai/mastra) —— `packages/memory/src/processors/observational-memory`
- **License**：Apache-2.0（部分 `ee/` 目录为 Mastra Enterprise License）
- **主要语言**：TypeScript 99.4%
- **对应 quilin-mem v2 层**：L3a Observation Layer（§二·A.7）

## 2026-04-20 baseline digest

**架构摘要**：
- 两个后台 LLM agent：**Observer** 和 **Reflector**
- Observer：每轮对话实时压缩为 **dated observation**（3-6x 对文本，5-40x 对工具密集场景）
- Reflector：积累到阈值后重结构化旧 observations（合并相关、删除冗余）
- 三层 representation：**message history → observations → reflections**
- 创新点：**append-only 稳定 prompt prefix**，启用 prompt caching

**Benchmark**（LongMemEval）：
- gpt-5-mini: 94.87%（published SOTA）
- gemini-3-pro-preview: 93.27%
- gpt-4o: 84.23%（高于 oracle 82.4%）

**动机分析**：
- 百万 token context 下 "dump everything" 其实能跑，但贵。Observer/Reflector 的本质是**把压缩从推理时挪到后台异步**，让推理时的 prompt 稳定又小。
- prompt caching 是降本的另一根杠杆 —— 稳定前缀 = cache 命中率高 = 每轮节省 $$$。

**对 quilin-mem v2 的启示**：
- ✅ **保留**：两级 representation（observation + reflection）、append-only prompt 前缀、temporal anchoring（observation / referenced / relative 三种日期）
- ⚠️ **升级**：每轮都烧 LLM observer 成本随轮数线性增长 → Quilin 改为 **rule-first two-tier observer**（Tier 1 规则零 LLM、Tier 2 LLM 兜底），判决门槛 Tier 1 hit rate ≥ 40% 且精度不降
- ⚠️ **升级**：Reflector 按时间/数量阈值触发 → Quilin 改为 **信息增益门控**（Δentropy > ε 才触发）
- ⚠️ **升级**：prompt cache 前缀整体失效 → Quilin 改为 **block-level invalidation**（前缀拆 N 块，只让变更块失效）

**建议行动**：
- [x] 起 D-20 spec delta（§二·A.7 L3a）
- [x] Task #97 rule-first observer spike（验证 Tier 1 hit rate 假设）

## 后续 digest

（上游新版本 / 重要 blog / paper 发布时在此追加）
