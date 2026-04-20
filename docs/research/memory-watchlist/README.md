# Memory Watchlist

> 跟 2026 开源 SOTA 记忆系统的**思想**，不跟它们的 git。支撑 [03-memory](../../engineering/03-memory/README.md) §二·A D-20 OmniMem v2 融合架构的持续迭代。

## 运作原则

1. **不 submodule 上游**：我们不把这五个项目加到 `upstreams/`，也不 `pip install` 它们做依赖。
2. **定期读 + 写 digest**：上游发了新 version / blog / paper 时，我们：
   - 读懂"他们改了什么、为什么改、带来什么收益"
   - 在对应线程的 md 里追加一段 digest（yyyy-mm-dd 日期 + 内容）
3. **human review**：digest 被评审后，若启示足以改变我们的设计，起 ADR-slug 或 spec delta PR
4. **不自动合入**：任何代码变化都走正常 PR 流程；没有上游自动合并

## Watchlist

| 线程 | 上游项目 | License | 在 OmniMem v2 里的对应层 |
|------|---------|---------|----------------------|
| [mastra-om](./mastra-om.md) | [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | Apache-2.0 (+ `ee/` 企业许可) | L3a Observation Layer |
| [graphiti](./graphiti.md) | [getzep/graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | L3b Temporal KG |
| [mem0](./mem0.md) | [mem0ai/mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | L3c Hybrid Retrieval |
| [mempalace](./mempalace.md) | MemPalace | Apache-2.0 | L2 Verbatim Episodic |
| [openviking](./openviking.md) | [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | Apache-2.0 | Filesystem Hierarchy（嵌入在 L2 冷热分层） |

## Digest 格式

每条 digest 用以下结构：

```markdown
## YYYY-MM-DD — <upstream version / event>

**变更内容**：他们做了什么（摘要）

**动机分析**：为什么这么做（你的理解，不只是引用他们原话）

**实效验证**：benchmark / star / issue 反应

**对我们的启示**：
- 启示 1：...
- 启示 2：...

**建议行动**：
- [ ] 是否需要起 spec delta PR？（是 / 否 / 再观察）
- [ ] 对应 OmniMem v2 的哪一层？
```

## 加入新 watchlist 线程的条件

只在以下之一成立时，才新开线程：

1. 该系统在 LongMemEval 或 AMB 上稳定进入前 5
2. 该系统提出**我们当前架构没有**的新轴（比如多模态、联邦学习）
3. 该系统 star 数 > 10k 且 3 个月内持续活跃

否则放进 [../model-architecture-insights.md](../model-architecture-insights.md) 的"其他参考"节就好。
