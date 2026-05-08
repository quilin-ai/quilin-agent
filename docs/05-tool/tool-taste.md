# 工具品味 / Tool Taste

> Make Quilin's agent pick the right tool (`grep` vs spawn explore-agent vs delegate to subagent) **without** relying on LLM in-situ reasoning of half-trained tool descriptions. Tracking iteration: **Iter L+1**.
>
> 让 Quilin agent "选对工具"（grep vs spawn explore-agent vs 委派 subagent），**不靠** LLM 现场推理半训练态的 tool description。追踪 iteration：**Iter L+1**。

---

## 一、问题 / Problem

The model itself contributes ~80 % of "tool selection intelligence" — Anthropic spent enormous training compute teaching their model when to use which tool, and Quilin already lets you choose Claude Sonnet 4.6 / Opus 4.7. But **the harness shape also matters**: how tool descriptors are written, how subagent capabilities are advertised, how the system prompt frames "when to delegate". These are 100 % under Quilin's control and currently inconsistent across builtin tools.

模型本身贡献了"工具选择智能"约 80%——Anthropic 花了大量训练 compute 教模型"什么时候用什么工具"，Quilin 也已经让你选 Claude Sonnet 4.6 / Opus 4.7。但 **harness 形状也决定结果**：descriptor 怎么写、subagent 能力怎么宣传、system prompt 怎么 frame "什么时候委派"。这些 100% 在 Quilin 控制范围内，目前 builtin tool 的写法参差不齐。

Concrete failure modes 具体失败模式:

* Agent calls `web_fetch` on a JS-heavy SPA when `web_browse` is the right call (cost: empty `<div id="root">` + a wasted token round-trip).
* Agent reads 5 files one-by-one when `glob` + `grep` could have done it in two calls (cost: 5× token usage for context-establishing).
* Agent runs a 30-step task in the foreground when `subagent_spawn` would have kept the main thread responsive (cost: user waits 5 minutes staring at a spinner).

* Agent 在 JS-heavy SPA 上调用 `web_fetch`，正确的调用应该是 `web_browse`（代价：拿到空的 `<div id="root">` + 一次浪费的 token round-trip）。
* Agent 一次读一个文件读 5 次，本可以 `glob` + `grep` 两次解决（代价：建立 context 用了 5 倍 token）。
* Agent 在前台跑 30 步任务，本应 `subagent_spawn` 让主线程保持响应（代价：用户对着 spinner 等 5 分钟）。

---

## 二、当前状态 / Current State

| 能力 / Capability | 状态 / State |
|---|---|
| Gateway tools<br>网关工具 | ✅ `tool_search` / `skill_search` / `mcp_search` 落地（commit a3c683c），catalog 不再全量塞 system prompt / Landed (commit a3c683c), catalog no longer floods system prompt. |
| Subagent 暴露<br>Subagent exposure | ✅ `subagent_spawn` / `subagent_status` 在 system prompt 中可见 / Visible in system prompt. |
| Tool descriptor 质量<br>Tool descriptor quality | 🚧 参差：部分 tool 是一句话描述，部分是一段；没有 "when to use / when not to use / cost class" 统一规范 / Inconsistent: some tools have a one-liner, others a paragraph; no unified "when to use / when not to use / cost class" schema. |
| Subagent 能力宣传<br>Subagent capability advertisement | 🚧 `subagent_type` 列表只有名字 + 一段描述；没有标注"擅长 / 不擅长 / 典型场景"<br>Only name + paragraph description; no "good at / bad at / typical use" labels. |
| Tool selection trace<br>工具选择 trace | ❌ 不存在；agent 选错工具不被记录 / Does not exist; wrong tool selection is not logged. |
| System prompt curation<br>System prompt 策划 | 🚧 部分；没有"prefer X for Y, fall back to Z when ..." 这类显式 prefer-fallback 模式 / Partial; no explicit "prefer X for Y, fall back to Z when ..." patterns. |

---

## 三、设计 / Design

### 3.1 Descriptor 卖货式 schema / Marketing-Style Descriptor Schema

每个 tool 的 descriptor 必须包含以下字段（在 `ToolMetadata` 里声明）：

Each tool's descriptor must include these fields (declared in `ToolMetadata`):

```typescript
interface ToolMetadata {
  // ... existing fields
  // ... Iter L 新增 fields (expectedRuntime, progressObservability, equivalentAlternatives)

  /** 一句话总结，用于 catalog 列表 / One-line summary for catalog listing */
  readonly summary: string;

  /** 典型使用场景，2-5 条 / Typical use cases, 2-5 items */
  readonly whenToUse: readonly string[];

  /** 典型反例，1-3 条；什么时候不该用 / Typical anti-cases, 1-3 items; when NOT to use */
  readonly whenNotToUse: readonly string[];

  /** 成本档位 / Cost class */
  readonly costClass: "free" | "cheap" | "moderate" | "expensive";

  /** 典型参数样本，2-3 条；JSON-encoded / Typical input examples, 2-3 items; JSON-encoded */
  readonly typicalInputs: readonly Record<string, unknown>[];
}
```

Example for `web_browse`:

```typescript
{
  summary: "Render JS-heavy SPAs and extract structured data via Stagehand LLM primitives.",
  whenToUse: [
    "URL returns mostly empty HTML body with <div id=\"root\">",
    "Page requires JS to render content (React/Vue/Angular SPA)",
    "Need to interact with the page (click, fill form) before extraction",
  ],
  whenNotToUse: [
    "Static HTML page → use web_fetch (cheaper, no Chromium spin-up)",
    "JSON API → use web_fetch directly",
    "PDF / binary content → use web_fetch (which rejects with structured error)",
  ],
  costClass: "expensive",
  typicalInputs: [
    { url: "https://news.ycombinator.com", mode: "extract", instruction: "List the top 10 story titles and points" },
    { url: "https://example-spa.com/products", mode: "act", instruction: "Click the 'Load More' button" },
  ],
}
```

### 3.2 Descriptor lint / Descriptor 检查器

CI 检查 `packages/agent-core/src/tools/builtin/*.ts` 里所有 builtin tool 的 metadata：

CI lints all builtin tool metadata in `packages/agent-core/src/tools/builtin/*.ts`:

* `summary` 必须 ≤ 80 字符 / `summary` must be ≤ 80 characters
* `whenToUse` 至少 2 条，每条 ≤ 100 字符 / `whenToUse` ≥ 2 items, each ≤ 100 chars
* `whenNotToUse` 至少 1 条 / `whenNotToUse` ≥ 1 item
* `costClass` 必须四档之一 / `costClass` must be one of four values
* `typicalInputs` 至少 2 个有效样本 / `typicalInputs` ≥ 2 valid samples

不合规即 CI fail。新加 builtin tool 必须先合规才能合入。

Non-compliant → CI fails. New builtin tools must comply before merge.

### 3.3 Subagent 能力宣传 / Subagent Capability Advertisement

每个 `subagent_type` 在 `~/.claude/agents/` 或 `agents/` 下定义时，frontmatter 增加：

Each `subagent_type` defined under `~/.claude/agents/` or `agents/` adds frontmatter:

```yaml
---
name: e2e-runner
goodAt:
  - Generating Playwright/Stagehand E2E test scripts from acceptance criteria
  - Spawning headless browsers, running fixtures, capturing screenshots
  - Detecting and reporting concrete defects with reproduction steps
badAt:
  - Architecture-level design or RFC drafting (use planner instead)
  - Pure code review without execution (use code-reviewer instead)
typicalUse: Run E2E acceptance for a freshly merged feature; verify behaviors that unit tests can't catch
costClass: expensive  # spawns subprocess + may launch browsers
expectedRuntime: long  # 5-30 min for full E2E suite
---
```

主 agent 的 `subagent_spawn` tool description 注入 `subagent_type` 的 `goodAt` / `badAt` / `typicalUse` 摘要，让主 agent 选对类型。

The main agent's `subagent_spawn` tool description injects each `subagent_type`'s `goodAt` / `badAt` / `typicalUse` summary, so the main agent picks the right type.

### 3.4 Tool selection trace / 工具选择 trace

每次 tool call 记录：

Every tool call records:

```typescript
interface ToolSelectionTrace {
  readonly intentSummary: string;       // 1-line user intent at this step
  readonly chosenTool: string;
  readonly alternativesConsidered: readonly string[]; // (optional, if equivalentAlternatives is set)
  readonly outcome: "success" | "retry" | "abandon";
  readonly retryWithDifferentTool?: string; // if outcome=retry, what was tried next
}
```

写入 08-Observability trace stream，喂给 EDD 评测层（Iter L+0），用于回归检测：每次 descriptor 改写后，"tool selection success rate" 应该上升而不是下降。

Written to 08-Observability trace stream, fed to the EDD layer (Iter L+0) for regression detection: after every descriptor rewrite, "tool selection success rate" should rise, not fall.

### 3.5 System prompt curation / System prompt 策划

借鉴 Claude Code 的 prefer-fallback 模式，给 Quilin 的 system prompt 加显式工具偏好规则：

Borrow Claude Code's prefer-fallback pattern; add explicit tool preference rules to Quilin's system prompt:

```
For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with
subagent_type=Explore. Otherwise use `find` or `grep` via the Bash tool directly.

For UI or frontend changes, start the dev server and use the feature in a browser before reporting
the task as complete.

When the user asks for a static fetch (single URL → markdown), prefer web_fetch. When the page
requires JS rendering or page interaction, use web_browse. When the user wants RAG-friendly
markdown across multiple URLs, route to the quilin-web MCP provider.
```

These rules go into `02-Context`'s static system prompt assembly path, **not** as runtime LLM reasoning.

这些规则进入 `02-Context` 的静态 system prompt 装配路径，**不**通过 LLM 运行时推理。

---

## 四、行动项 / Action Items

### P0 — Descriptor schema + lint / Descriptor schema 与检查器

* [ ] `ToolMetadata` 增加 `summary` / `whenToUse` / `whenNotToUse` / `costClass` / `typicalInputs` 五个字段（与 Iter L 的三个字段并行落地）
* [ ] 给所有 builtin tool 回填合规的 metadata（约 15-20 个 tool）
* [ ] `packages/agent-core/scripts/lint-tool-metadata.ts` 落地，CI 跑
* [ ] 单测覆盖率 ≥ 95 %

### P0 — Subagent capability advertisement / Subagent 能力宣传

* [ ] `~/.claude/agents/` 和 `agents/` 下所有 subagent 定义补 `goodAt` / `badAt` / `typicalUse` / `costClass` / `expectedRuntime` frontmatter
* [ ] `subagent_spawn` tool description 自动从 frontmatter 摘要注入 system prompt
* [ ] 文档示例：每个 subagent_type 一个示例

### P1 — Tool selection trace / 工具选择 trace

* [ ] Core Loop tool dispatcher 每次 dispatch 记录 `ToolSelectionTrace`
* [ ] 写入 08-Observability trace stream
* [ ] EDD 评测层（Iter L+0）的 6 指标里加一条 "tool selection success rate"
* [ ] 单测 + 集成测试

### P1 — System prompt curation / System prompt 策划

* [ ] `02-Context` 的 system prompt 装配路径加一段 "tool preference rules"
* [ ] 规则模板：依赖 Iter L 的 `equivalentAlternatives` 字段动态生成 prefer-fallback 文本
* [ ] EDD 验证 system prompt 改动是否让 tool selection 改善

### P2 — Descriptor 自动审计 / Descriptor Auto-audit

* [ ] LLM-as-judge 评估 descriptor 质量（清晰度 / 完整度 / 是否有歧义）
* [ ] 持续提示开发者哪些 descriptor 该改写

---

## 五、不做 / Out of Scope

* 不做"AI 自动写 descriptor"（先人工 + lint）
* No AI-generated descriptors in v1 (humans + lint)
* 不替换 `tool_search` / `skill_search` / `mcp_search`（继续用，只在它们上面补 quality 层）
* No replacement of existing search gateway tools (keep using them, add quality layer on top)
* 不做工具市场（marketplace）的 descriptor 同步（marketplace 是另一个 issue）
* No tool marketplace descriptor sync (marketplace is a separate issue)

---

## 六、关联 / Cross-References

### Linear

* **Iter L+1 project**: [工具品味 / Tool Taste](https://linear.app/quilin-agent/project/iter-l1工具品味-tool-taste-60e80c4db043)
* **Tracker issue**: [QUI-136 — Iter L+1 tracker: marketing-style descriptors + lint + selection trace](https://linear.app/quilin-agent/issue/QUI-136/iter-l1-tracker-marketing-style-descriptors-lint-selection-trace) (priority Medium)
* **依赖 / Depends on**: Iter L (`expectedRuntime` / `progressObservability` / `equivalentAlternatives`), Iter L+0 (EDD signal)

### 文档 / Docs

* [`../00-core-loop/intelligence-roadmap.md`](../00-core-loop/intelligence-roadmap.md) — 总索引 / master index
* [`../00-core-loop/reactive-execution.md`](../00-core-loop/reactive-execution.md) — Iter L 设计；本 iter 在它之上扩展 ToolMetadata / Iter L design; this iter extends `ToolMetadata`
* [`../00-core-loop/eval-driven-development.md`](../00-core-loop/eval-driven-development.md) — Iter L+0 设计；本 iter 的改动通过它验证 / Iter L+0 design; this iter's changes verified by it
* [`./README.md`](./README.md) — Tool engineering 当前状态 / Tool engineering current state
* [`../06-multi-agent/README.md`](../06-multi-agent/README.md) — Subagent 系统当前状态 / Subagent system current state
