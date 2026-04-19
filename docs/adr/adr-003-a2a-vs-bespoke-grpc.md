# ADR-003: Agent Mesh 传输协议 — A2A vs 自建 gRPC schema

**状态**：Draft（2026-04-20 开议，Iter D 开工前必须定稿）
**决策者**：待定（需 Claude + Codex + 用户 review）
**相关**：[11-agent-mesh](../engineering/11-agent-mesh/README.md)、[ADR-001](./adr-001-core-loop-and-language.md)

## 背景

Iter D 要引入 Agent Mesh —— Quilin 实例之间（或 Quilin ↔ 异构 agent）的通信层。原始决策（ADR-001 附）是：

- 传输：**gRPC**
- daemon：`meshd`（Rust 实现）
- schema：**自建 `.proto`**

但 2026-04-20 外部调研发现 Google 推动的 **A2A（Agent2Agent）Protocol** 已在 2025-06 进入 Linux Foundation，150+ 企业（MS / AWS / Salesforce / SAP / ServiceNow）签署，v0.3 (2025-11) 已加入 gRPC 绑定 + Signed Agent Cards + JSON-RPC/SSE fallback。MCP 官方明确把 A2A 定位为"agent↔agent 水平协议"，与 MCP"agent↔tool 垂直协议"互补。

这迫使我们重新评估是否自建 schema。

## 决策选项

### Option A：采用 A2A v1.0（官方标准）

**Pros**
- 复用现成的 agent discovery / capability card / auth / signed messaging（Signed Agent Cards）
- 企业生态（Microsoft Semantic Kernel、AWS Bedrock AgentCore、Salesforce AgentForce、ServiceNow 均已接入）
- gRPC + JSON-RPC + SSE 三传输同 spec 覆盖
- 与未来 "接入第三方 agent" 场景天然兼容（无需翻译层）

**Cons**
- spec 仍在演化（0.3 → 1.0 正在推进），我们需持续跟踪
- 可能引入 Quilin 用不上的复杂度（如 long-running task streaming state machine）
- Rust SDK 生态弱（官方主要是 Go/Python/TS）

### Option B：自建 gRPC schema（原计划）

**Pros**
- schema 完全可控，只做 Quilin 需要的子集
- Rust `tonic` 生态成熟
- 不被上游 spec 变更影响

**Cons**
- 自建 = 自己实现 discovery / capability card / auth / replay protection
- 对第三方 agent 封闭；未来接入异构 agent 要写翻译层
- "重新发明轮子" 风险：每一个 A2A 已解决的问题都要我们二次发现

### Option C：A2A subset + Quilin extensions

- 以 A2A 为 baseline（`.proto` 从官方 repo 拉取）
- Quilin 特有能力（WriteAuthority origin 字段、OmniMem tier 提示等）放进 A2A metadata extension
- 内部调用走 subset；对第三方场景自动是完整 A2A

**Pros**：前两选项的优点
**Cons**：需要定期 rebase A2A 上游；有短期对齐成本

## 当前倾向

**Option C（A2A subset + extensions）**，理由：

1. **不自己发明轮子**原则 —— 自建 gRPC schema 的每一步都会被 A2A 先一步踩过
2. **开放性**与 Quilin "自进化 + 上游融合" 定位一致 —— 封闭 schema 跟项目精神冲突
3. **风险可控** —— A2A v1.0 已进入 LF，breaking change 概率低；即使有，也是 subset 调整
4. Rust SDK 生态弱可以通过 `prost` + 官方 proto 直接解决

## 待决问题

- **Rust 侧**：`tonic` + A2A 官方 `.proto` 的端到端 demo 是否足够成熟？需要 Codex spike 一次
- **A2A authorization**：OAuth 2.0 + Signed Agent Cards 模型是否能与 Quilin WriteAuthority 对接？
- **扩展字段命名**：Quilin 扩展是否统一放在 `metadata.quilin.*` 前缀？（参考 13-skills frontmatter 做法）

## 验收标准（Iter D 开工前）

- [ ] Rust `tonic` + A2A `.proto` 编译通过，两个本地 Quilin 实例能互发 message
- [ ] Signed Agent Cards → WriteAuthority 对接 POC（至少能 block 未签名 agent）
- [ ] benchmark 一条跨机 roundtrip 延迟（目标 <50ms p50）
- [ ] 若 Option C 被否，明确 Option A 或 B 的退路

## 参考

- [A2A Protocol spec v1.0 (2026-04)](https://a2a-protocol.org/latest/specification/)
- [Google Cloud: A2A upgrade announcement](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [MCP 2026 transport roadmap](https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/)（MCP 官方说明 A2A 是互补协议）
- [Microsoft Semantic Kernel A2A integration](https://learn.microsoft.com/en-us/semantic-kernel/concepts/agents)（作为生态采用参考）

---

**Next action**：Iter D Sprint 0（工程启动前一周）Codex 做 tonic + A2A `.proto` spike，benchmark 成绩 + POC 签名流程入此 ADR §验收；拿到数据后本 ADR 定稿。
