# OpenViking (volcengine)

- **上游**：[volcengine/OpenViking](https://github.com/volcengine/OpenViking)
- **License**：Apache-2.0
- **Stars**：21.9k（2026-04-20）
- **主要语言**：Python ≥ 3.10 + Go ≥ 1.22 + C++（多语言基建）
- **对应 OmniMem v2 层**：Filesystem Hierarchy（嵌入 L2 的冷热分层，§二·A.7）

## 2026-04-20 baseline digest

**架构摘要**：
- **Filesystem-hierarchical**：L0 / L1 / L2 三层物理分层
- L0 = 热数据常驻内存；L1 = 温数据按需加载；L2 = 冷数据归档
- 分层 loader 做 token-usage optimization
- 工业级：30 contributors、多语言文档

**Benchmark**：未在公开对比表里（LongMemEval 未收录）

**动机分析**：
- "memory as files" 思路源于 Claude Code 的 CLAUDE.md —— 但 OpenViking 把它做成了**分层文件系统**
- 多语言基建（Python + Go + C++）暗示目标是**企业规模**：Go 处理并发文件 IO、C++ 处理序列化性能
- 按 byte offset + 分层加载避免把整个记忆拉到内存，是 **scale-first** 设计

**对 OmniMem v2 的启示**：
- ✅ **保留**：冷热分层思想、分层 loader 做 token 预算
- ❌ **丢弃**：多语言基建（ADR-001 已定 TS + Python 双语言，不加 Go/C++）
- ⚠️ **升级**：物理文件分层 → Quilin 在 **SQLite 内做分层**（热表常驻 WAL、冷表按访问熵分区到独立 file）
- ⚠️ **升级**：LRU 分层 → Quilin 改为 **Entropy-based tiering**（访问分布的信息熵：稳定被访问的升 hot，集中在特定时期的降 cold）

**建议行动**：
- [x] 起 D-20 spec delta（§二·A.7 L2 冷热分层）
- [ ] 后续 benchmark：跑 10 万条 verbatim 下的 SQLite 分层 vs OpenViking 多语言方案的 p95 召回延迟

## 后续 digest

（上游若简化语言栈、若发布轻量版、若与 Claude Code CLAUDE.md 出现新的对齐 → 在此追加）
