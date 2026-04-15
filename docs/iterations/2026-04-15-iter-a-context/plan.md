# Iteration A: Grounded Context — 上下文工程

> **状态**：待启动
>
> **主轴**：02-Context　**搭配**：03-light 改进、12-light 基础
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么第一

当前最大产品短板不是"记不住"，而是"记住了也没系统性喂回模型"。`BasicContextManager` 已存在但只喂了一个硬编码 prompt source。Phase 0 的 system prompt 越写越长、全部塞在 `repl.ts` 里，没有模板化、没有预算管理、没有动态组装。

## 范围

### 多源 ContextSource 动态组装

System prompt 拆为多个 `ContextSource`，每个有 `priority` + `maxTokens`：

| Source | 内容 | 优先级 | 动态性 |
|--------|------|--------|--------|
| `identity` | Agent 身份 + 人设 | 最高 | 固定 |
| `user-instructions` | 用户自定义规则（类似 CLAUDE.md） | 高 | 可选，文件加载 |
| `memory` | OmniMem recall 结果 | 中高 | 每轮按相关性装填 |
| `session` | 当前会话上下文摘要 | 中 | 动态 |
| `temporal` | 时间感知注入 | 中 | 动态 |
| `environment` | 运行时环境信息（系统、可用工具列表） | 中低 | 启动时确定 |
| `tool-hints` | 当前可用工具的 schema 描述 | 低 | 动态 |

### Token Budget 管理

- 按 source priority 从高到低填充
- 超限时截断低优先级 source
- 预留输出 token（configurable，默认 30%）
- Lost-in-the-Middle aware 排布：重要信息放首尾

### Temporal Awareness 注入

- 会话内间隔：感知消息之间的"沉默"（用户走了/在忙/回来了）
- 绝对时间：当前时间、时区
- 跨 session 时间线：距离上次对话过了多久

### Memory → Context 集成

- 每轮自动 recall 相关记忆，注入 context（不再只靠 LLM 主动调 tool）
- recall query 从用户输入自动提取关键词
- recall 结果按相关性排序后截断到 budget 内

## 依赖关系

- 消费 `03-Memory`（recall 结果注入 context）
- 直接影响 `04-Planning`（context 质量决定 plan 质量）
- 也是 `12-ConversationEng` 是否"像个人"的地基
- `BasicContextManager` 已具备多源组装 + 优先级 + 截断能力，需要扩展而非重写

## 验收标准

- [ ] system prompt 由 ≥3 个独立 source 动态组装
- [ ] Token budget 超限时自动截断低优先级 source
- [ ] memory recall 结果自动注入 context（不再只靠 tool call）
- [ ] temporal awareness：agent 知道"距离上次对话过了多久"
- [ ] 所有 source 有对应的单元测试
- [ ] 现有 47 TS tests + 31 Python tests 不回归

## 参考 Spec

- [02-context/README.md](../../engineering/02-context/README.md)
- [03-memory/README.md](../../engineering/03-memory/README.md)
