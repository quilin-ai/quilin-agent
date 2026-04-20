# Prompt Cache Architecture Spec（2026-04-21）

> **状态**：Draft for review
>
> **目标**：在 **不暴露 provider-specific 概念到 context/prompt 层** 的前提下，重构 Prompt runtime lifecycle，使 Quilin 立即受益于 DeepSeek / OpenAI / xAI 一类 provider 的自动前缀缓存，并为 Anthropic 的显式 breakpoint cache control 留出干净适配面。
>
> **当前共识**：先修 runtime lifecycle，再落 provider-agnostic segments 接口；短期采用 **C + sliding single breakpoint + D-ready interface**，暂不做 full multi-breakpoint history/window 策略。

---

## 0. TL;DR

本轮不直接做 “Anthropic prompt cache 接线”，而是先把 prompt runtime 结构修正为 **session 内可重建、每轮 outbound 重序列化、raw transcript 与装饰层分离**。具体方案：

1. 引入 **`PromptSessionAssembler`** 作为 session 级对象，由 REPL 持有。
2. `PromptBuilder` 不再在启动时 `new + build + discard`，而是在 session 生命周期内常驻，使 `per_session` 语义真正成立。
3. `temporal` 拆成两层：
   - **桶化 temporal**：进入 system/session prefix，字节稳定，可缓存。
   - **精确 temporal**：只在 outbound latest user 副本上装饰，不写回 transcript，不进 checkpoint。
4. `AssembledPrompt` 升级为 **`segments + recommendedBreakpoints`** 的 provider-agnostic 形态，保留 `staticPrefix` / `dynamicSuffix` 作为过渡兼容字段。
5. 新增 **`llm/cache-adapter.ts`**：由 LLM transport 层按 provider 翻译 cache hints。
6. 短期只启用 **single sliding breakpoint policy**；full D 的多 breakpoint 策略延后到 transcript window / rolling history policy 成熟后再上。

---

## 1. 已确认的 runtime 事实

以下不是抽象风险，而是当前代码的真实行为：

1. **`per_session` 语义当前不成立**
   - `PromptBuilder` 在 [`repl.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/repl.ts#L69) 的 `buildDefaultSystemPrompt()` 中被临时创建、构建一次、立刻丢弃。
   - 结果：[`prompt-builder.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/context/prompt-builder.ts#L20) 的 `sessionCache` 在 REPL 主路径中几乎没有机会命中。

2. **`temporal` 当前语义已经错误**
   - [`repl.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/repl.ts#L83) 在 session 启动时就把 `temporal` section 固化进 system prompt。
   - `lastMessageTime` 永远是 `null`。
   - `currentTime` / `sessionStartTime` 实际上是 “REPL 启动瞬间”，后续 turn 不会更新。

3. **system prompt 当前被长期固化在 `messages[0]`**
   - 启动时生成一次后，作为 state/transcript 的一部分长期存在。
   - [`loop.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/loop.ts#L123) 每轮只复用这个 base system prompt，不会因 tool registry / skills catalog / temporal 变化而重建。

4. **`tool-guidance` 的稳定性标注与实际输入不一致**
   - [`default-sections.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/context/default-sections.ts#L72) 把 `tool-guidance` 标为 `static`。
   - 但其 `compute()` 直接读取 `ctx.availableToolDescriptors`，运行时 registry 变化会导致内容变化。

5. **`PROMPT_CACHE_BOUNDARY` 是死常量**
   - [`prompt-types.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/context/prompt-types.ts#L25) 定义了 `PROMPT_CACHE_BOUNDARY`，但当前无实际消费方。

---

## 2. 设计原则

### 2.1 Provider-agnostic first

`context/`、`prompt-builder`、`PromptSessionAssembler` 不允许出现 `anthropic`、`cache_control`、`ephemeral` 等 provider-specific 概念。上层只表达：

- 哪些内容稳定
- 哪些内容每 turn 变化
- 哪些 segment 边界建议作为 cache reuse breakpoint

Provider-specific 翻译只能出现在 `llm/` 层。

### 2.2 Raw transcript 与 outbound prompt view 分离

Checkpoint / state 存储的是 **原始 transcript**，不是发送给模型的最终视图。

- transcript 负责持久化和恢复
- outbound prompt 负责本轮发送前的装饰、分段、cache hint、provider serialization

两者必须可以独立演化。

### 2.3 稳定前缀优先于显式 cache API

DeepSeek / OpenAI / xAI 的 prompt cache 即使没有显式 breakpoint，也依赖 **前缀字节稳定**。因此：

- runtime lifecycle 修正本身就是收益
- Anthropic 显式 breakpoint 只是未来的加速层，不是架构核心

### 2.4 先 single breakpoint，后 multi-breakpoint

这轮不预先锁死 full D 的 history 2/3、tool window、rolling compaction 分段策略。

短期只要求：

- 接口支持多个推荐 breakpoint
- 运行策略默认只产出 1 个 breakpoint
- breakpoint 位置可根据调用阶段滑动

### 2.5 Session cache 是 runtime optimization，不是 durable state

`per_session` cache 属于 **进程内优化**：

- 不写 checkpoint
- 不做跨进程持久化
- 进程重启后自然重建

---

## 3. 非目标

本 spec **不包含** 以下内容：

1. 不在本轮引入 Gemini CachedContent API。
2. 不在本轮做 Anthropic 4 breakpoint 全打满策略。
3. 不在本轮定义 transcript compaction / rolling history window 的最终策略。
4. 不在本轮持久化 `PromptBuilder.sessionCache`。
5. 不在本轮把 cache metrics 做成全 provider 成本模型，只先打通 usage + cache 命中/创建遥测。

---

## 4. 接口契约（provider-agnostic）

### 4.1 `PromptSegment`

```ts
export type PromptSegmentRole = "system" | "user" | "assistant" | "tool";

export type PromptSegmentStability = "static" | "per_session" | "per_turn";

export type PromptSegmentSource =
  | "prompt-section"
  | "transcript"
  | "temporal-bucket"
  | "temporal-precise";

export interface PromptSegment {
  readonly id: string;
  readonly role: PromptSegmentRole;
  readonly text: string;
  readonly stability: PromptSegmentStability;
  readonly source: PromptSegmentSource;
  readonly cacheEligible: boolean;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}
```

字段语义：

- `id`: 稳定命名，便于 metrics / tracing / future diffing。示例：`identity`、`tool-guidance`、`skills-catalog`、`temporal-bucket`、`user:latest-decorated`、`transcript:tool-3`
- `role`: provider serializer 所需的目标消息角色
- `text`: 原始字节内容；`cache-adapter` 不得改写文本，只能决定如何包裹
- `stability`: provider-agnostic 稳定性语义
- `source`: 用于遥测和调试，不参与 cache 逻辑判断
- `cacheEligible`: 上游 assembler 认为该 segment 可以纳入可复用前缀；provider adapter 可进一步裁剪，但不得把 `false` 升级为 `true`

### 4.2 `RecommendedBreakpoint`

```ts
export type BreakpointReason =
  | "system-tail"
  | "history-tail"
  | "tool-resume-tail";

export interface RecommendedBreakpoint {
  readonly segmentIndex: number;
  readonly reason: BreakpointReason;
}
```

语义：

- `segmentIndex` 是 `AssembledPrompt.segments` 的数组下标
- 含义是：“**建议在该 segment 结束处** 切出一个可复用前缀”
- 这是 **provider-agnostic hint**，不是 Anthropic 专属坐标

### 4.3 `AssembledPrompt`

```ts
export interface AssembledPrompt {
  readonly segments: readonly PromptSegment[];
  readonly recommendedBreakpoints: readonly RecommendedBreakpoint[];
  readonly sectionTokens: Readonly<Record<string, number>>;
  readonly totalTokens: number;

  // Legacy compatibility during migration
  readonly staticPrefix: string;
  readonly dynamicSuffix: string;
}
```

约束：

- `segments` 是真实的结构化输出，后续所有新逻辑以它为准
- `staticPrefix` / `dynamicSuffix` 为 derived 字段，仅供旧调用点过渡使用
- 一旦所有调用点切到 `segments`，legacy 字段可在后续迭代删除

### 4.4 `PromptSessionAssembler`

建议定义：

```ts
export interface PromptSessionAssemblerDeps {
  readonly promptBuilder: PromptBuilder;
  readonly registry?: MCPRegistry;
  readonly skillsManager?: SkillsManager;
  readonly now?: () => Date;
}

export type SessionInvalidationReason =
  | "session-reset"
  | "tool-registry-changed"
  | "skills-catalog-changed"
  | "model-changed";

export interface BuildOutboundPromptInput {
  readonly transcript: readonly Message[];
  readonly modelId: string;
  readonly turnKind: "user-turn" | "tool-resume";
  readonly sessionStartedAt: string;
  readonly lastSessionEndedAt?: string;
}

export class PromptSessionAssembler {
  constructor(deps: PromptSessionAssemblerDeps);

  invalidateSessionPrefix(reason: SessionInvalidationReason): void;

  resetSession(): void;

  buildOutboundPrompt(input: BuildOutboundPromptInput): AssembledPrompt;
}
```

行为约束：

1. `PromptSessionAssembler` 必须在 session 生命周期内复用同一个 `PromptBuilder`
2. `invalidateSessionPrefix()` 只标记 dirty，不直接修改 transcript
3. `buildOutboundPrompt()` 负责：
   - 重建 session-level system prefix
   - 应用桶化 temporal
   - 仅在 `turnKind === "user-turn"` 时注入精确 temporal decoration
   - 产出 provider-agnostic `segments + recommendedBreakpoints`

### 4.5 `llm/cache-adapter.ts`

建议定义：

```ts
export type CacheAwareProvider =
  | "anthropic"
  | "deepseek"
  | "openai"
  | "gemini"
  | "xai"
  | "unknown";

export interface CacheAdapterInput {
  readonly prompt: AssembledPrompt;
  readonly provider: CacheAwareProvider;
}

export interface CacheAdapterOutput {
  readonly messages: ModelMessage[];
  readonly appliedBreakpoints: readonly RecommendedBreakpoint[];
}

export function adaptPromptForProvider(
  input: CacheAdapterInput,
): CacheAdapterOutput;
```

职责边界：

- 输入：provider-agnostic prompt
- 输出：provider-specific SDK messages
- 不允许修改 segment 文本字节
- 允许裁剪 / 忽略 `recommendedBreakpoints`

---

## 5. Runtime 生命周期

### 5.1 组件归属

`PromptSessionAssembler` 放在 `context/`，而不是 `llm/`。

原因：

- 它的职责是组织 context 信息、session prefix、temporal 分层和 breakpoint hint
- 它不负责 provider transport
- `llm/` 只负责把上游结构序列化成 provider 可接受的 `ModelMessage[]`

建议文件：

- Create: `packages/agent-core/src/context/prompt-session-assembler.ts`
- Create: `packages/agent-core/src/llm/cache-adapter.ts`

### 5.2 实例所有权

由 **REPL 持有**，与 `checkpoint`、`registry`、`skillsManager` 同级。

建议流程：

1. REPL 启动
2. 加载 `checkpoint`
3. 初始化 `registry` / `skillsManager`
4. 创建 `PromptBuilder`
5. 创建 `PromptSessionAssembler`
6. 每次即将调用 LLM 时，由 loop 请求 assembler 构建 outbound prompt

即：

- `repl.ts` owns the assembler
- `loop.ts` consumes it via `AgentLoopConfig.sessionAssembler`

### 5.3 `messages[0]` 不再长期持有 system prompt

新的 state / checkpoint 语义：

- transcript 只保存 raw conversation messages：`user` / `assistant` / `tool`
- system prompt 不再作为长期持久化的 `messages[0]`
- 每轮发送前，由 assembler 重新生成 outbound system segments

兼容迁移：

- 恢复旧 checkpoint 时，如果首条消息是 `system`，在 load 后剥离掉，不再写回新 checkpoint

### 5.4 Checkpoint 存什么，不存什么

**Checkpoint 存：**

- 原始 transcript
- `createdAt`
- `lastActiveAt`
- `turnCount`

**Checkpoint 不存：**

- `PromptBuilder.sessionCache`
- `PromptSessionAssembler` 内部 dirty state
- 桶化 temporal 生成结果
- 精确 temporal 装饰文本
- provider-specific 序列化结果
- cache breakpoint 应用结果

### 5.5 进程重启行为

进程重启后：

- assembler 新实例
- `PromptBuilder.sessionCache` 为空
- system prefix 通过当前 registry / skills / model / session metadata 重新计算

这是预期行为，不视为 cache miss bug。

---

## 6. Temporal 两层模型

### 6.1 桶化 temporal（进入 system/session prefix）

作用：保留“时间氛围感”和跨天语义，同时维持前缀稳定。

建议字段：

- `day_bucket`: `2026-04-21`
- `day_period`: `morning | afternoon | evening | late_night`
- `session_gap_bucket`: `fresh | resumed_same_day | resumed_cross_day`
- `message_gap_bucket`: `normal | short_away | medium_away | long_away | cross_day`

约束：

- 同一桶内字节必须完全一致
- 禁止秒级 / 分钟级精确时间进入该层

### 6.2 精确 temporal（latest user decoration）

作用：给模型本轮精确时间感，但不污染稳定前缀。

建议注入条件：

- 仅当 `turnKind === "user-turn"` 时注入
- 注入到 outbound latest user 副本的前缀
- 不回写 transcript

建议格式：

```text
[时间上下文]
当前时间: 2026-04-21T10:35:12.000+08:00
距上次活跃: 3 分钟
本次 session 持续: 18 分钟

{raw user input}
```

注：具体文本格式可以后续微调，但 “精确 temporal 不进 transcript” 是硬约束。

---

## 7. Sliding Single Breakpoint 策略

### 7.1 目标

单 breakpoint 策略要同时兼顾两类收益：

1. **跨 outer user turns 的稳定前缀复用**
2. **同一 outer turn 内 tool-resume 调用的稳定前缀复用**

### 7.2 当前建议

根据调用阶段滑动：

#### A. `turnKind = "user-turn"`

在 **当前 latest user decoration 之前** 放 breakpoint。

效果：

- system + 已完成历史 全部纳入可复用前缀
- 本轮精确 temporal 和本轮 user input 不进入可复用前缀
- 对 DeepSeek / OpenAI / xAI 的自动前缀 cache 最友好

#### B. `turnKind = "tool-resume"`

在 **当前 transcript 尾部** 放 breakpoint，也就是当前轮已存在的 assistant/tool 历史之后。

效果：

- 在同一 outer turn 的多次 LLM 往返中，尽量复用本轮已产生的 assistant/tool 前缀
- 不必等待 full D 才能获得工具回路内收益

### 7.3 “已完结边界”定义

为了避免 tool-call 中途错位，本 spec 给出当前定义：

- **外层用户 turn 已完结历史**：当前 latest raw user message 之前的全部 transcript
- **tool-resume 已完结历史**：本次 LLM 调用前已写入 `workingMessages` 的全部 transcript

换句话说：

- 对 assembler 来说，“已完结”不是语义上猜测哪条 assistant 算完成
- 而是 **“在本次 LLM 调用开始前，已经稳定存在于 transcript / workingMessages 中的消息”**

这一定义更简单，也更接近实际 cache 命中条件。

### 7.4 为什么暂不做 full D

因为以下策略仍未成熟：

- rolling history window
- transcript compaction
- tool result pinning / eviction
- long-session summary grafting

在这些未定前直接固定 4 breakpoint 坐标，会过早冻结错误抽象。

---

## 8. Provider 翻译规则（`llm/cache-adapter.ts`）

### 8.1 Anthropic

策略：

- 读取 `recommendedBreakpoints`
- 在对应 segment 结束处插入 `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`
- 支持未来最多 4 个 breakpoint
- 本轮默认只消费第 1 个推荐 breakpoint

建议序列化形式：

```ts
{
  role: "system",
  content: [
    {
      type: "text",
      text: "...",
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" },
        },
      },
    },
  ],
}
```

### 8.2 DeepSeek

策略：

- 忽略 `recommendedBreakpoints`
- 保持 segment 顺序与字节稳定
- 直接序列化成普通消息

收益来源：

- 自动前缀缓存
- 不依赖显式 cache API

### 8.3 OpenAI

策略与 DeepSeek 相同：

- 先不接 provider-specific cache API
- 依赖自动 prompt caching

### 8.4 xAI

同 DeepSeek / OpenAI：

- 先走 plain serialization
- 利用自动前缀缓存

### 8.5 Gemini

本轮策略：

- 忽略 `recommendedBreakpoints`
- 不接 CachedContent API
- 先走 plain serialization

### 8.6 Unknown / fallback

- 普通字符串/消息序列化
- 保持字节稳定
- 不应用 provider-specific cache metadata

---

## 9. 失效与重建机制

### 9.1 `tool-guidance`

从 `static` 升级为 `per_session`。

触发 `invalidateSessionPrefix("tool-registry-changed")` 的事件：

- MCP server register
- MCP server unregister
- builtin tools register

### 9.2 `skills-catalog`

保持 `per_session`，但引入显式失效触发。

触发 `invalidateSessionPrefix("skills-catalog-changed")` 的事件：

- `discover()` 后 descriptor 集变化
- 未来 skill CRUD 成功后 catalog 变化

### 9.3 `modelId`

如果 model 切换导致 system prefix 发生 provider/model-specific 分支，必须触发：

- `invalidateSessionPrefix("model-changed")`

### 9.4 `resetSession()`

以下操作触发 session 级清空：

- `/clear`
- 新 session 启动
- 明确的 session reset

---

## 10. Metrics 与可观测性

### 10.1 必须补的 usage 字段

当前 [`token-usage.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/llm/token-usage.ts#L17) 仅保留了 `cacheReadTokens`，不够。

建议扩展：

```ts
export interface NormalizedTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}
```

优先读取：

- `usage.inputTokenDetails.cacheReadTokens`
- `usage.inputTokenDetails.cacheWriteTokens`

若 provider 未返回，则字段为 `undefined`。

### 10.2 OTel 事件

建议新增 span / attributes：

- `llm.cache.provider`
- `llm.cache.recommended_breakpoint_count`
- `llm.cache.applied_breakpoint_count`
- `llm.cache.read_tokens`
- `llm.cache.write_tokens`
- `llm.cache.turn_kind`
- `llm.cache.system_prefix_dirty`

### 10.3 为什么需要 write tokens

只看 read tokens 不能判断：

- cache 是否刚被创建
- single breakpoint 是否在错误位置导致“持续创建、很少读取”

---

## 11. 迁移顺序（可增量上线）

### Step 1：修 PromptBuilder lifecycle，让 `per_session` 语义成立

目标：

- 把 `PromptBuilder` 从 “启动时临时对象” 改成 “session 生命周期对象”

建议改动：

- Create: `packages/agent-core/src/context/prompt-session-assembler.ts`
- Modify: `packages/agent-core/src/repl.ts`
- Modify: `packages/agent-core/src/loop.ts`

完成定义：

- `PromptBuilder` 在 session 内复用
- `/clear` 和新 session 会 `resetSession()`
- 尚未启用 segments/cache-adapter 也可以先落这一步

可回滚性：

- 若后续步骤延迟，本步仍然对 `per_session` 语义是正修复

### Step 2：temporal 桶化 + 精确 temporal 迁到 latest user 装饰

目标：

- 修正 temporal 语义错误
- 恢复稳定前缀

建议改动：

- Modify: `packages/agent-core/src/context/temporal.ts`
- Modify: `packages/agent-core/src/context/prompt-builder.ts`
- Modify: `packages/agent-core/src/context/prompt-types.ts`
- Test: `packages/agent-core/src/context/temporal.test.ts`
- Test: `packages/agent-core/src/repl.test.ts`

完成定义：

- system 只含桶化 temporal
- 精确 temporal 只出现在 outbound latest user 副本
- checkpoint transcript 不出现 temporal decoration

### Step 3：`tool-guidance` / `skills-catalog` 升级为真正的 `per_session` + 失效驱动

目标：

- 消除假静态和 stale prefix

建议改动：

- Modify: `packages/agent-core/src/context/default-sections.ts`
- Modify: `packages/agent-core/src/tools/registry.ts`
- Modify: `packages/agent-core/src/skills/manager.ts`
- Modify: `packages/agent-core/src/context/prompt-session-assembler.ts`

完成定义：

- registry / skills 变更可标记 prefix dirty
- 下次 outbound build 时重算 session prefix

### Step 4：`AssembledPrompt` 升级为 `segments` 接口，保留 legacy 字段

目标：

- 给 future cache adapter / breakpoint planning 提供结构化上游输入

建议改动：

- Modify: `packages/agent-core/src/context/prompt-types.ts`
- Modify: `packages/agent-core/src/context/prompt-builder.ts`
- Modify: `packages/agent-core/src/context/context-assembler.*`
- Test: `packages/agent-core/src/context/prompt-builder.test.ts`

完成定义：

- 新逻辑消费 `segments`
- 旧逻辑仍可临时消费 `staticPrefix` / `dynamicSuffix`

### Step 5：新增 `llm/cache-adapter.ts`，先实现 provider translation，不强制启用 Anthropic 分支

目标：

- 让 provider-specific cache metadata 下沉到 `llm/`

建议改动：

- Create: `packages/agent-core/src/llm/cache-adapter.ts`
- Modify: `packages/agent-core/src/llm/client.ts`
- Modify: `packages/agent-core/src/llm/client.test.ts`

完成定义：

- DeepSeek / OpenAI / xAI / Gemini / fallback 先走 noop translation
- Anthropic 分支代码可先落地，但默认不依赖当前 provider

### Step 6：补 OTel metrics 与 token usage 扩展

目标：

- 验证 cache 是否真的工作，而不是“感觉更快”

建议改动：

- Modify: `packages/agent-core/src/llm/token-usage.ts`
- Modify: `packages/agent-core/src/llm/types.ts`
- Modify: `packages/agent-core/src/loop.ts`
- Test: `packages/agent-core/src/llm/token-usage.test.ts`

完成定义：

- 支持 read/write cache token usage
- span attributes 可区分 provider、turnKind、applied breakpoints

---

## 12. 文件责任映射

| 文件 | 责任 |
|---|---|
| `packages/agent-core/src/context/prompt-builder.ts` | section 注册、稳定性分桶、segment 生成、legacy 字段派生 |
| `packages/agent-core/src/context/prompt-session-assembler.ts` | session lifecycle、dirty invalidation、temporal 两层组装、breakpoint 规划 |
| `packages/agent-core/src/context/default-sections.ts` | identity / rules / tool-guidance 的 section 定义 |
| `packages/agent-core/src/context/temporal.ts` | temporal bucket + precise decoration 逻辑 |
| `packages/agent-core/src/tools/registry.ts` | tool registry 变化事件源 |
| `packages/agent-core/src/skills/manager.ts` | skills catalog 变化事件源 |
| `packages/agent-core/src/repl.ts` | assembler 所有者；session start / clear / restore 生命周期 |
| `packages/agent-core/src/loop.ts` | 每轮向 assembler 请求 outbound prompt；LLM 调用阶段传入 `turnKind` |
| `packages/agent-core/src/llm/cache-adapter.ts` | provider-specific cache hint 翻译 |
| `packages/agent-core/src/llm/client.ts` | cache-aware prompt 序列化接入 AI SDK |
| `packages/agent-core/src/llm/token-usage.ts` | cache read/write token 归一化 |

---

## 13. 测试要求

本 spec 对后续实现提出最低测试要求：

1. `PromptBuilder` session reuse
   - 同一 session 两次 build，`per_session` section 只 compute 一次

2. temporal 语义
   - 桶化 temporal 在同桶内 byte-identical
   - 精确 temporal 只出现在 outbound latest user，不出现在 checkpoint transcript

3. registry / skills invalidation
   - register / unregister / discover 变化后，下次 outbound build 重算 prefix

4. provider translation
   - DeepSeek path 不注入 provider-specific metadata
   - Anthropic path 在推荐 breakpoint 位置注入 `cacheControl`

5. backward compatibility
   - 旧 checkpoint 含 system message 时，恢复后会剥离并正常继续

6. metrics
   - `cacheReadTokens` / `cacheWriteTokens` 缺省时不报错
   - span attributes 在无 cache provider 下也可安全上报

---

## 14. Open Questions

1. **`turnKind = "tool-resume"` 的 single breakpoint 是否先做，还是第一版只做 `user-turn`？**
   - 当前 spec 倾向做，但需要实现和测试复杂度评估。

2. **旧 checkpoint 的迁移策略要不要做一次性 rewrite？**
   - 当前建议是不 rewrite，只在 load 时剥离首条 system。

3. **Gemini CachedContent API 是否值得单独开后续小迭代？**
   - 本轮不做，但如果 Gemini 成主力 provider，需要单独评估。

4. **DeepSeek 的 cache 命中是否能从官方 usage 字段稳定拿到 read/write token？**
   - 如果不能，需要退而求其次做 wall-clock + input token delta 观测。

5. **是否需要把 `recommendedBreakpoints` 设计成 richer coordinates（如 messageIndex + partIndex）？**
   - 当前 `segmentIndex` 足够支持单 breakpoint 和过渡实现，但 full D 可能需要更精细坐标。

6. **`PromptSessionAssembler` 是否还应负责 model-specific prompt branches？**
   - 当前倾向 “允许基于 `modelId` 选段，但不允许出现 provider-specific transport 字段”。

---

## 15. 建议的下一轮 review 焦点

下轮 review 建议只盯两件事：

1. **provider-agnostic 边界是否足够干净**
   - 有没有 `anthropic` / `cache_control` 泄漏进 `context/`

2. **迁移顺序是否每一步都可独立回滚**
   - 任一步未完成时，前一步是否仍形成有效、可测试、可上线的小增量

