# MemPalace

- **上游**：MemPalace / mempalace（43k stars 8 天内涨成 —— 病毒式增长，2026-02）
- **License**：Apache-2.0
- **对应 quilin-mem v2 层**：L2 Verbatim Episodic Store（§二·A.7）

## 2026-04-20 baseline digest

**架构摘要**：
- **Verbatim storage**：原文全留，不压缩、不总结
- 基于 ChromaDB 做向量
- **Palace metaphor**：Wing → Hall → Room → Closet → Drawer 五层组织
- 170 tokens 的最低启动开销

**Benchmark**：
- LongMemEval (raw mode): **96.6%** —— 2026-04 LongMemEval 开源榜首
- 启用 AAAK 压缩模式后回归 12.4 pts（84.2%）

**动机分析**：
- 论点 "**Don't burn an LLM to decide what's worth remembering**" —— 字面上就是"别用 LLM 决定什么值得记"
- 本质：在 context 窗口已经够大的 2026，verbatim 是**反直觉地便宜**（向量检索毫秒级、全原文不损失精度）；反而做压缩要烧 LLM，还可能丢信息
- 96.6% 分数的真正意义：**证明对"压缩就是进步"的反共识** —— 不压缩反而更准

**对 quilin-mem v2 的启示**：
- ✅ **保留**：verbatim storage 作为 L2 的基础；FTS + 向量双检索
- ⚠️ **升级**：无限增长 → Quilin 改为 **冷热分层归档**（> N 天的 verbatim 迁到冷区，用 zstd 字典压缩 ~8x，检索命中时解压）
- ❌ **丢弃**：Palace metaphor（Wing/Hall/Room/...）—— 这是人类心智比喻，对检索没有工程收益；直接用 SQLite 表 + metadata index 按 `user_id / session_id / age_tier` 分区

**建议行动**：
- [x] 起 D-20 spec delta（§二·A.7 L2）
- [ ] 冻结：原“后续 benchmark”不再推进；若需要容量与检索精度对比，只能在用户明确要求后以本地记忆实证重新定义。

## 后续 digest

（上游若补上压缩、若发布 v2、若 benchmark 被其他系统超越 → 在此追加）
