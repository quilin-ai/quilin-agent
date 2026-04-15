# Iteration A: Grounded Context — 上下文工程 + 提示词工程

> **状态**：✅ 已完成（v0.1.0-iter-a, 2026-04-15）
>
> **主轴**：02-Context（上下文工程 + 提示词工程）　**搭配**：03-light 改进、12-light 基础
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么第一

当前最大产品短板不是"记不住"，而是"记住了也没系统性喂回模型"。`BasicContextManager` 已存在但只喂了一个硬编码 prompt source。Phase 0 的 system prompt 越写越长、全部塞在 `repl.ts` 里，没有模板化、没有预算管理、没有动态组装。

**提示词工程是上下文工程的子集**——系统提示本身已经变成一个工程系统，需要模块化组装、缓存分层、安全扫描。Claude Code、Codex、OpenClaw、Hermes 的实践证明：不做这些，单靠手写一段 system prompt 无法支撑生产级 Agent。

## 实施约束

> 以下约束来自 Codex 独立审查（2026-04-15），确保 spec 与现有代码兼容：

1. **不改冻结接口**：不修改现有 `packages/agent-core/src/context/types.ts`、`state/types.ts`、`llm/types.ts`。新增 `prompt-types.ts` 等 prompt 专属类型文件
2. **不扩张 LLM transport**：cache boundary 在 Iter A 只作为 `AssembledPrompt` 的 metadata 存在，真正的 `cache_control` API 标记延后到 Iter B 或独立小迭代
3. **不持有 MemoryClient**：`ContextManager` 接收外部注入的 `memorySources: ContextSource[]`，不自己依赖 memory transport 层，保持 02/03 边界清晰
4. **测试目录沿用惯例**：测试文件放在 `src/**/*.test.ts`，与现有 Vitest 配置一致

## 范围

### A1. 分段式 SystemPromptBuilder（提示词工程核心）

取长于 Claude Code 的 `systemPromptSection()` + OpenClaw 的 context file ordering + PromptMode + Hermes 的 11 层严格排序：

- **PromptSection 注册机制**：每个段有 `name`、`order`（排序权重）、`compute()`（内容生成）、`updateFrequency`（`static` / `per_session` / `per_turn`）、`maxTokens`（段级预算）
- **段的分类与排序**：

| 段名 | order | updateFrequency | 内容 | 取长于 |
|------|-------|-----------------|------|--------|
| `identity` | 10 | static | Agent 身份 + 人设 | Hermes Identity 层 |
| `rules` | 20 | static | 约束规则（安全、输出格式） | Claude Code rules sections |
| `user-instructions` | 30 | static | 用户自定义规则（类似 CLAUDE.md） | OpenClaw agents.md/soul.md |
| `tool-guidance` | 40 | static | 工具使用行为指导（何时用、怎么用好） | Claude Code `getUsingYourToolsSection()` |
| **CACHE_BOUNDARY** | — | — | **静态/动态分界线** | Claude Code / OpenClaw |
| `memory` | 50 | per_session | OmniMem recall 结果（session 内冻结） | Hermes Memory snapshot 冻结策略 |
| `session` | 60 | per_turn | 当前会话上下文摘要 | — |
| `temporal` | 70 | per_turn | 时间感知注入 | — |
| `environment` | 80 | per_session | 运行时环境信息 | Claude Code env_info |
| `mcp-instructions` | 90 | per_turn | MCP server 指令（随连接动态变化） | Claude Code `DANGEROUS_uncachedSystemPromptSection` |

- **缓存边界**：`PROMPT_CACHE_BOUNDARY` 标记将段列表分为静态前缀和动态后缀。`static` 和 `per_session` 的段归入前缀（可缓存），`per_turn` 的段归入后缀
- **PromptProfile**：`full` / `minimal` / `none` 三种模式，取长于 OpenClaw 的 PromptMode，为子 Agent 场景裁剪段

### A2. 多源 ContextSource 动态组装

System prompt 之外的上下文原料，拆为多个 `ContextSource`，每个有 `priority` + `maxTokens`。外部来源需标记 `isExternal: true` 供注入扫描识别：

| Source | 内容 | 优先级 | 动态性 | isExternal |
|--------|------|--------|--------|------------|
| `memory` | OmniMem recall 结果 | 中高 | 每轮按相关性装填 | true |
| `session` | 当前会话上下文摘要 | 中 | 动态 | false |
| `temporal` | 时间感知注入 | 中 | 动态 | false |
| `environment` | 运行时环境信息 | 中低 | 启动时确定 | false |
| `tool-results` | 上一轮工具返回结果 | 中 | 动态 | true |
| `user-context-files` | 用户项目 context 文件 | 中 | 启动时加载 | true |
| `mcp-instructions` | MCP server 提供的指令 | 中低 | 动态 | true |

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

### A5. Memory → Context 集成（薄版本）

> 本迭代只做"消费 recall 结果"，不做"拥有 memory transport"。

- 新建 `ContextAssembler.assembleContext()` 接收外部注入的 `memorySources: ContextSource[]`（不修改冻结的 `ContextManager` 接口）
- 上层（Agent Loop 或 Memory Bridge 模块）负责调用 OmniMem MCP recall，转换为 `ContextSource` 后传入
- 传入的 userInput 直接作为 recall query（不做 extractKeywords），让 OmniMem 自己做 query expansion
- recall 结果按 relevanceScore 排序后截断到 budget 内

### A6. Prompt 缓存稳定性

取长于 OpenClaw 的 `normalizePromptCapabilityIds()` + Hermes 的冻结策略：

- **Section 标准化**：空白字符归一化（合并多余空格、统一换行符、去除行尾空白）
- **结构化列表排序**：仅限明确的标识符列表（capability IDs、tool names），不对自然语言内容排序
- **Session 级冻结**：`per_session` 更新频率的 section（如 memory snapshot、environment）在 session 内冻结，不突变缓存前缀

### A7. 上下文文件注入扫描

取长于 Hermes 的 `_scan_context_content()`（威胁模式扫描）+ OpenClaw 的 `CONTEXT_FILE_ORDER`（信任分级加载）：

- **威胁模式扫描**：不可见 Unicode、指令覆盖、凭据泄露、编码混淆、隐藏 HTML
- **分级响应**：`warn` 级记录日志并清理（如移除不可见字符）继续注入，`block` 级拒绝注入并通知用户
- **扫描范围（显式定义，防止实现漂移）**：
  - **扫描**：workspace context files、user custom instructions、MCP server instructions、memory recall text、其他外部注入文本（`isExternal: true`）
  - **不扫描**：内置 identity/rules/tool-guidance 等静态段、代码中硬编码的 prompt sections
- **纯函数设计**：`scanExternalContext(content, meta) → ScanResult`，不嵌入 builder，由 source collector 调用

## 延后到 Iter B 的项

- **模型特异性 Prompt 适配**（ModelPromptAdapter）——与 LLM 集成深度耦合，适合在 Iter B 的工具系统建设中一并实现
- **ProviderSystemPromptContribution**——允许 LLM provider 覆盖默认段，依赖多 provider 支持
- **`cache_control` API 标记**——需要扩展 `Message.content` 和 `LLMClient` 接口，属于 LLM transport schema refactor

## 建议实施顺序

```
A1 (PromptSection types + PromptBuilder)
  ↓
A6 (cache stability: normalize + freeze)
  ↓
A2 (ContextSource + isExternal)  ←→  A7 (injection scanner) [可并行，共享 source 边界定义]
  ↓
A3 (TokenBudgetAllocator)
  ↓
A4 (temporal section)
  ↓
A5 (memory bridge: 薄版本，消费外部注入的 memorySources)
  ↓
全流程串联 + 集成测试
```

## 依赖关系

- 消费 `03-Memory`（recall 结果由外部注入，不直接依赖 memory transport）
- 直接影响 `04-Planning`（context 质量决定 plan 质量）
- 也是 `12-ConversationEng` 是否"像个人"的地基
- `BasicContextManager` 已具备多源组装 + 优先级 + 截断能力，需要扩展而非重写
- 提示词工程的 7 个模式中，5 个在本迭代实现（缓存边界、分段组装、注入扫描、缓存稳定性、Delta Channel），2 个延后（模型适配、工具指导分离的模型部分）

## 验收标准

- [ ] SystemPromptBuilder 支持分段式注册 + 自动排序组装（≥5 个段）
- [ ] 缓存边界正确标记，静态前缀在连续调用间保持 token 级一致（byte-identical）
- [ ] system prompt 由 ≥3 个独立 source 动态组装
- [ ] Token budget 超限时自动截断低优先级 source（段级 + source 级）
- [ ] memory recall 结果可通过外部注入 context（不要求 ContextManager 自己做 recall）
- [ ] temporal awareness：agent 知道"距离上次对话过了多久"
- [ ] Section 标准化：相同逻辑的 prompt 在多次构建间产生 byte-identical 输出
- [ ] 注入扫描：包含 `ignore previous instructions` 的外部 context 文件被标记 `block`
- [ ] 注入扫描范围正确：内置静态段不被扫描，外部来源全部扫描
- [ ] Prompt cache 命中率 ≥ 70%（通过 API 返回的 cached token 统计）
- [ ] 所有 source 和 section 有对应的单元测试
- [ ] 现有 47 TS tests + 31 Python tests 不回归

## 参考 Spec

- [02-context/README.md](../../engineering/02-context/README.md)（含 2.5 提示词工程 7 模式）
- [03-memory/README.md](../../engineering/03-memory/README.md)
