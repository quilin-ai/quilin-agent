# Iteration A: Grounded Context — 上下文工程 + 提示词工程

> **状态**：待启动
>
> **主轴**：02-Context（上下文工程 + 提示词工程）　**搭配**：03-light 改进、12-light 基础
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么第一

当前最大产品短板不是"记不住"，而是"记住了也没系统性喂回模型"。`BasicContextManager` 已存在但只喂了一个硬编码 prompt source。Phase 0 的 system prompt 越写越长、全部塞在 `repl.ts` 里，没有模板化、没有预算管理、没有动态组装。

**提示词工程是上下文工程的子集**——系统提示本身已经变成一个工程系统，需要模块化组装、缓存分层、安全扫描。Claude Code、Codex、OpenClaw、Hermes 的实践证明：不做这些，单靠手写一段 system prompt 无法支撑生产级 Agent。

## 范围

### A1. 分段式 SystemPromptBuilder（提示词工程核心）

取长于 Claude Code 的 `systemPromptSection()` + OpenClaw 的 25+ 段模式 + Hermes 的 11 层严格排序：

- **PromptSection 注册机制**：每个段有 `name`、`order`（排序权重）、`compute()`（内容生成）、`volatile`（是否每轮变化）、`maxTokens`（段级预算）
- **段的分类与排序**：

| 段名 | order | volatile | 内容 | 取长于 |
|------|-------|----------|------|--------|
| `identity` | 10 | false | Agent 身份 + 人设 | Hermes Identity 层 |
| `rules` | 20 | false | 约束规则（安全、输出格式） | Claude Code rules sections |
| `user-instructions` | 30 | false | 用户自定义规则（类似 CLAUDE.md） | OpenClaw agents.md/soul.md |
| `tool-guidance` | 40 | false | 工具使用行为指导（何时用、怎么用好） | Claude Code `getUsingYourToolsSection()` |
| **CACHE_BOUNDARY** | — | — | **静态/动态分界线** | Claude Code / OpenClaw |
| `memory` | 50 | true | OmniMem recall 结果 | Hermes Memory snapshot |
| `session` | 60 | true | 当前会话上下文摘要 | — |
| `temporal` | 70 | true | 时间感知注入 | — |
| `environment` | 80 | true | 运行时环境信息 | Claude Code env_info |
| `mcp-instructions` | 90 | true | MCP server 指令（随连接动态变化） | Claude Code `DANGEROUS_uncachedSystemPromptSection` |

- **缓存边界**：`PROMPT_CACHE_BOUNDARY` 标记将段列表分为静态前缀和动态后缀，送入 LLM API 时在边界位置添加 `cache_control`

### A2. 多源 ContextSource 动态组装

System prompt 之外的上下文原料，拆为多个 `ContextSource`，每个有 `priority` + `maxTokens`：

| Source | 内容 | 优先级 | 动态性 |
|--------|------|--------|--------|
| `memory` | OmniMem recall 结果 | 中高 | 每轮按相关性装填 |
| `session` | 当前会话上下文摘要 | 中 | 动态 |
| `temporal` | 时间感知注入 | 中 | 动态 |
| `environment` | 运行时环境信息（系统、可用工具列表） | 中低 | 启动时确定 |
| `tool-results` | 上一轮工具返回结果 | 中 | 动态 |

### A3. Token Budget 管理

- 按 source priority 从高到低填充
- 超限时截断低优先级 source
- 预留输出 token（configurable，默认 30%）
- Lost-in-the-Middle aware 排布：重要信息放首尾
- **段级预算控制**：每个 PromptSection 可设 `maxTokens`，超过则截断

### A4. Temporal Awareness 注入

- 会话内间隔：感知消息之间的"沉默"（用户走了/在忙/回来了）
- 绝对时间：当前时间、时区
- 跨 session 时间线：距离上次对话过了多久

### A5. Memory → Context 集成

- 每轮自动 recall 相关记忆，注入 context（不再只靠 LLM 主动调 tool）
- recall query 从用户输入自动提取关键词
- recall 结果按相关性排序后截断到 budget 内

### A6. Prompt 缓存稳定性

取长于 OpenClaw 的 `normalizeStructuredPromptSection()` + Hermes 的冻结策略：

- **Section 标准化**：空白字符归一化、列表排序，确保相同语义产生相同 token 序列
- **Session 级冻结**：`per_session` 更新频率的 section（如 memory snapshot）在 session 内冻结，不突变缓存前缀

### A7. 上下文文件注入扫描

取长于 Hermes 的 `_scan_context_content()` + OpenClaw 的 `sanitizeContextFileContentForPrompt()`：

- **威胁模式扫描**：不可见 Unicode、指令覆盖、凭据泄露、编码混淆、隐藏 HTML
- **分级响应**：`warn` 级记录日志继续注入，`block` 级拒绝并通知用户
- 扫描范围：所有外部来源（用户 config 文件、MCP server 指令、项目 context 文件）

## 延后到 Iter B 的项

- **模型特异性 Prompt 适配**（ModelPromptAdapter）——与 LLM 集成深度耦合，适合在 Iter B 的工具系统建设中一并实现
- **ProviderSystemPromptContribution**——允许 LLM provider 覆盖默认段，依赖多 provider 支持

## 依赖关系

- 消费 `03-Memory`（recall 结果注入 context）
- 直接影响 `04-Planning`（context 质量决定 plan 质量）
- 也是 `12-ConversationEng` 是否"像个人"的地基
- `BasicContextManager` 已具备多源组装 + 优先级 + 截断能力，需要扩展而非重写
- 提示词工程的 6 个模式中，4 个在本迭代实现，2 个延后（见上）

## 验收标准

- [ ] SystemPromptBuilder 支持分段式注册 + 自动排序组装（≥5 个段）
- [ ] 缓存边界正确标记，静态前缀在连续调用间保持 token 级一致
- [ ] system prompt 由 ≥3 个独立 source 动态组装
- [ ] Token budget 超限时自动截断低优先级 source（段级 + source 级）
- [ ] memory recall 结果自动注入 context（不再只靠 tool call）
- [ ] temporal awareness：agent 知道"距离上次对话过了多久"
- [ ] Section 标准化：相同逻辑的 prompt 在多次构建间产生 byte-identical 输出
- [ ] 注入扫描：包含 `ignore previous instructions` 的 context 文件被标记 warn
- [ ] Prompt cache 命中率 ≥ 70%（通过 API 返回的 cached token 统计）
- [ ] 所有 source 和 section 有对应的单元测试
- [ ] 现有 47 TS tests + 31 Python tests 不回归

## 参考 Spec

- [02-context/README.md](../../engineering/02-context/README.md)（含 2.5 提示词工程章节）
- [03-memory/README.md](../../engineering/03-memory/README.md)
