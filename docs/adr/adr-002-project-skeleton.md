# ADR-002: 项目骨架初始化 — Phase 0 开发 Blueprint

> **状态**: Accepted
> **日期**: 2026-04-15
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-001](./adr-001-core-loop-and-language.md)（核心 Agent Loop 与语言架构）

---

## 1. 目的

本文档是 Quilin Agent Phase 0 开发的**完整执行蓝图**。任何开发者或 AI Agent（Claude Code / Codex / Gemini CLI）拿到本文档后，应能独立完成项目骨架初始化，无需额外上下文。

**读完本文档后你应该知道**：
- 创建哪些目录和文件
- 每个配置文件的完整内容
- Phase 0 的 TS 核心接口定义
- 日志 / 脚本 / CI 的具体实现
- 什么不该做（明确排除项）

---

## 2. 架构决策：按语言隔离的 Monorepo

三种语言各用自己的 workspace 管理器，`just` 统一编排：

| 语言 | 目录 | 运行时 | 包管理 | 测试 | 构建 |
|------|------|--------|-------|------|------|
| TypeScript | `packages/` | Bun (latest stable) | pnpm | Vitest | Bun bundler |
| Python | `providers/` | CPython 3.14 | uv (Astral) | pytest | uv + hatchling |
| Rust | `crates/` | native + Tokio | cargo | cargo test + insta | cargo |

**为什么不用扁平 `src/`**：三语言混在同一目录下，workspace 管理混乱，IDE 支持差。
**为什么不按领域切 12 个 TS package**：Phase 0 过早抽象，管理开销大。后续按需拆分。

---

## 3. 完整目录结构

```
quilin-agent/
│
├── packages/                           # TS — pnpm workspace
│   └── agent-core/                     # Phase 0 核心包
│       ├── package.json                # → §4.3
│       ├── tsconfig.json               # → §4.4
│       ├── vitest.config.ts            # → §4.5
│       └── src/
│           ├── index.ts                # 主入口：启动 → 验证 → REPL → §6.5
│           ├── repl.ts                 # CLI REPL 交互循环 → §6.8
│           ├── logger.ts               # 结构化日志 (pino) → §7
│           ├── loop.ts                 # Agent Loop (< 200 行 while-loop) → §6.6
│           ├── llm/                    # 01-LLM Integration
│           │   ├── client.ts           # LLMClient (封装 Vercel AI SDK) → §6.7
│           │   ├── provider.ts         # DeepSeek / OpenAI / Anthropic provider 配置
│           │   └── types.ts            # ThinkingMode, InferenceConfig, LLMResponse
│           ├── context/                # 02-Context
│           │   ├── manager.ts          # ContextManager
│           │   └── types.ts            # ContextSource, TokenBudget
│           ├── tools/                  # 05-Tools (基础)
│           │   ├── router.ts           # ToolRouter
│           │   ├── mcp-client.ts       # MCP Client Manager
│           │   └── types.ts            # Tool, ToolResult, ToolCall
│           ├── state/                  # E-S 组件
│           │   ├── checkpoint.ts       # SQLite checkpoint
│           │   └── types.ts            # AgentState, Message
│           └── types/                  # 共享类型
│               └── index.ts
│
├── providers/                          # Python — uv workspace
│   └── memory/                         # OmniMem MCP Server
│       ├── pyproject.toml              # → §5.1
│       └── src/
│           └── omnimem/
│               ├── __init__.py
│               ├── server.py           # MCP Server 入口
│               ├── logging.py          # structlog 配置 → §7
│               ├── store.py            # 记忆存储
│               └── types.py            # 记忆类型
│
├── crates/                             # Rust — cargo workspace (Phase 2 骨架)
│   └── mesh-sdk/
│       ├── Cargo.toml                  # → §5.2
│       └── src/
│           └── lib.rs                  # 占位，Phase 2 实现
│
├── .devcontainer/                      # Dev Container → §9
│   ├── devcontainer.json
│   └── Dockerfile
│
├── .github/
│   └── workflows/
│       └── ci.yml                      # CI workflow → §10
│
├── justfile                            # 跨语言编排 → §8
├── pnpm-workspace.yaml                 # → §4.1
├── package.json                        # root workspace → §4.2
├── tsconfig.base.json                  # TS 基础配置 → §4.4
├── Cargo.toml                          # Rust workspace root → §5.2
├── .env.example                        # 环境变量模板 → §11
├── .gitignore                          # 更新：新增构建产物排除
│
├── docs/                               # (已有，不动)
├── scripts/                            # (已有，不动)
└── upstreams/                          # (已有，不动)
```

---

## 4. TypeScript 配置

### 4.1 pnpm-workspace.yaml

```yaml
packages:
  - "packages/*"
```

### 4.2 根 package.json

```json
{
  "name": "quilin-agent",
  "private": true,
  "packageManager": "pnpm@10.8.1",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "format": "pnpm -r format"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

### 4.3 packages/agent-core/package.json

```json
{
  "name": "@quilin/agent-core",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target node",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check src/",
    "format": "biome format --write src/"
  },
  "dependencies": {
    "ai": "^6.0.0",
    "@ai-sdk/openai-compatible": "^0.2.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "pino": "^9.0.0",
    "zod": "^3.24.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/better-sqlite3": "^7.0.0",
    "pino-pretty": "^13.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

> **注意**：TypeScript 编译使用 Bun bundler，不需要 `tsc`。`typescript` 作为 devDependency 仅供类型检查和 IDE 支持。版本锁定到 `^5.8.0`（Bun 当前支持的最高版本），后续 Bun 支持 TS 6 后升级。

### 4.4 tsconfig.base.json（根）

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"]
  },
  "exclude": ["node_modules", "dist"]
}
```

### packages/agent-core/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

### 4.5 packages/agent-core/vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
    reporters: process.env.QUILIN_ENV === 'test'
      ? ['json']        // CI / Monitor: 机器可解析
      : ['default'],    // 本地: 人读
  },
});
```

---

## 5. Python & Rust 配置

### 5.1 providers/memory/pyproject.toml

```toml
[project]
name = "quilin-omnimem"
version = "0.0.1"
description = "Quilin OmniMem — 4-tier memory system as MCP Server"
requires-python = ">=3.14"
dependencies = [
    "mcp[cli]>=1.0.0",
    "sentence-transformers>=3.0.0",
    "chromadb>=0.6.0",
    "structlog>=24.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "ruff>=0.8.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/omnimem"]

[tool.ruff]
target-version = "py314"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "SIM"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

### 5.2 Rust workspace

**根 Cargo.toml**：

```toml
[workspace]
resolver = "3"
members = ["crates/*"]

[workspace.package]
edition = "2024"
rust-version = "1.94"
license = "MIT"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
tonic = "0.13"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**crates/mesh-sdk/Cargo.toml**：

```toml
[package]
name = "quilin-mesh-sdk"
version = "0.0.1"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[dependencies]
tokio.workspace = true
tonic.workspace = true
tracing.workspace = true
serde.workspace = true
serde_json.workspace = true
```

---

## 6. Phase 0 核心 TS 接口

> 从 12 个工程 spec 的 Python Protocol/dataclass 翻译为 TS interface。
> 这些是**类型定义**，Phase 0 骨架阶段只有空函数体。

### 6.0 类型导入关系（无循环依赖）

```
state/types.ts          ← 定义: Message, MessageRole, AgentState, Checkpoint（无依赖）
tools/types.ts          ← 定义: Tool, ToolCall, ToolResult（无依赖）
context/types.ts        ← 定义: ContextSource, TokenBudget, ContextManager（无依赖）

llm/types.ts            ← 定义: ThinkingMode, InferenceConfig, LLMResponse, LLMClient
                           导入: Message ← state/types, Tool + ToolCall ← tools/types

loop.ts                 ← 导入: 上述全部（组装 AgentLoopConfig）

types/index.ts          ← re-export 所有公共类型
```

### 6.1 LLM 层 (`packages/agent-core/src/llm/types.ts`)

```typescript
import type { Message } from '../state/types.js';
import type { Tool, ToolCall } from '../tools/types.js';

/** 思考模式控制 — 来自 01-LLM spec §ThinkingMode */
export type ThinkingMode = 'enabled' | 'disabled' | 'auto';

/** 推理配置 — 来自 01-LLM spec §InferenceConfig */
export interface InferenceConfig {
  readonly temperature: number;
  readonly maxTokens: number;
  readonly thinkingMode: ThinkingMode;
  readonly thinkingBudget?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
}

/** LLM 响应 */
export interface LLMResponse {
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: string;
  readonly usage: TokenUsage;
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheHitTokens?: number;
}

/** LLMClient 接口 — Agent Loop 唯一的 LLM 交互点 */
export interface LLMClient {
  chat(
    messages: readonly Message[],
    tools: readonly Tool[],
    config: InferenceConfig,
  ): Promise<LLMResponse>;
}
```

### 6.2 工具层 (`packages/agent-core/src/tools/types.ts`)

```typescript
import type { z } from 'zod';

/** 工具定义 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodSchema;
  readonly execute: (args: unknown) => Promise<ToolResult>;
}

/** 工具调用请求（来自 LLM） */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** 工具执行结果 */
export interface ToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}
```

### 6.3 上下文层 (`packages/agent-core/src/context/types.ts`)

```typescript
/** 上下文来源 — 来自 02-Context spec §ContextSource */
export interface ContextSource {
  readonly type: 'system' | 'memory' | 'environment' | 'temporal' | 'user_profile';
  readonly content: string;
  readonly priority: number;
  readonly tokenEstimate: number;
}

/** Token 预算 */
export interface TokenBudget {
  readonly total: number;
  readonly system: number;
  readonly memory: number;
  readonly tools: number;
  readonly conversation: number;
  readonly reserved: number;
}

/** ContextManager 接口 */
export interface ContextManager {
  buildContext(
    sources: readonly ContextSource[],
    budget: TokenBudget,
  ): Promise<string>;
}
```

### 6.4 状态层 (`packages/agent-core/src/state/types.ts`)

```typescript
/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 消息 */
export interface Message {
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

/** Agent 状态 — "the only state is a message array" */
export interface AgentState {
  readonly messages: readonly Message[];
  readonly isTerminal: boolean;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly lastActiveAt: string;
}

/** Checkpoint 接口 — SQLite 持久化 */
export interface Checkpoint {
  save(state: AgentState): Promise<void>;
  load(sessionId: string): Promise<AgentState | null>;
  list(): Promise<readonly string[]>;
}
```

### 6.5 入口文件 (`packages/agent-core/src/index.ts`) — 启动 → 验证 → REPL

`index.ts` 是主入口。`just dev` 后经历三个阶段：初始化 → DeepSeek 连通性验证 → 进入 CLI REPL 交互循环。

```typescript
import 'dotenv/config';
import { logger } from './logger.js';
import { createProvider, getDefaultModel } from './llm/provider.js';
import { generateText } from 'ai';
import { startRepl } from './repl.js';

// re-export all public types
export * from './llm/types.js';
export * from './tools/types.js';
export * from './context/types.js';
export * from './state/types.js';

async function main() {
  logger.info({ version: '0.0.1' }, 'Quilin Agent starting');

  // 1. 初始化 LLM provider
  const provider = createProvider();
  const modelId = getDefaultModel();
  logger.info({ provider: 'deepseek', model: modelId }, 'LLM provider initialized');

  // 2. 验证连通性 — 一次真实的 LLM 调用
  logger.info('Verifying LLM connection...');
  try {
    const { text, usage } = await generateText({
      model: provider(modelId),
      prompt: 'Reply with exactly: "Quilin Agent online." Nothing else.',
      maxTokens: 20,
    });
    logger.info(
      { response: text.trim(), inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
      'LLM connection verified',
    );
  } catch (err) {
    logger.fatal({ err }, 'LLM connection failed');
    process.exit(1);
  }

  // 3. 启动 CLI REPL
  logger.info('Starting CLI REPL...');
  await startRepl({ provider, modelId });
}

main().catch((err) => {
  logger.fatal({ err }, 'Unexpected error');
  process.exit(1);
});
```

**`just dev` 后你会看到**：

```
[12:00:00 INFO] Quilin Agent starting                    version=0.0.1
[12:00:00 INFO] LLM provider initialized                 provider=deepseek model=deepseek-chat
[12:00:00 INFO] Verifying LLM connection...
[12:00:01 INFO] LLM connection verified                  response="Quilin Agent online." inputTokens=18 outputTokens=5
[12:00:01 INFO] Starting CLI REPL...

🐉 Quilin Agent v0.0.1 (DeepSeek)
Type your message, or /exit to quit.

quilin> _
```

如果 DeepSeek key 无效或网络不通，会看到：

```json
{"ts":"...","level":"fatal","service":"agent-core","env":"dev","msg":"LLM connection failed","err":{"message":"401 Unauthorized"}}
```

### 6.6 Agent Loop (`packages/agent-core/src/loop.ts`) — 核心循环实现

```typescript
import type { ContextManager } from './context/types.js';
import type { InferenceConfig, LLMClient } from './llm/types.js';
import type { AgentState, Checkpoint, Message } from './state/types.js';
import type { Tool } from './tools/types.js';
import { logger } from './logger.js';

/**
 * Quilin Agent 核心循环
 *
 * 目标: < 200 行，极简 while-loop
 * 参考: Claude Code ~88 行, Codex async queue, OpenClaw Pi agent
 *
 * 数据流:
 *   用户输入 → LLMClient.chat()
 *            → if tool_calls → ToolRouter.execute() → 结果追加 messages
 *            → if assistant   → 返回文本
 *            → loop
 *
 * Phase 0 简化:
 *   - 无 ContextManager（直接传 messages）
 *   - 无 ToolRouter（无工具）
 *   - 无 Checkpoint（不持久化）
 *   - 纯文本对话，不处理 tool_calls
 */

export interface AgentLoopConfig {
  readonly llm: LLMClient;
  readonly context?: ContextManager;
  readonly tools?: readonly Tool[];
  readonly checkpoint?: Checkpoint;
  readonly maxTurns?: number;
  readonly inferenceConfig: InferenceConfig;
}

/**
 * 单轮对话：接收 messages，调用 LLM，返回 assistant 回复
 *
 * Phase 0 只做最简单的事：把 messages 发给 LLM，拿回回复。
 * 没有 tool_calls 处理，没有多轮 inner loop，没有 checkpoint。
 */
export async function runAgentLoop(
  config: AgentLoopConfig,
  messages: readonly Message[],
): Promise<string> {
  const { llm, inferenceConfig } = config;

  logger.debug({ turnMessages: messages.length }, 'Agent loop: calling LLM');

  const response = await llm.chat(messages, config.tools ?? [], inferenceConfig);

  logger.debug(
    {
      finishReason: response.finishReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
    'Agent loop: LLM responded',
  );

  return response.content;
}
```

> **Phase 0 到 Phase 1 的演进路径**：
> - Phase 0: `runAgentLoop()` 只是单轮 LLM 调用的封装，REPL 负责会话循环
> - Phase 1: 加入 tool_calls 内循环（LLM 返回 tool_calls → execute → 追加结果 → 再调 LLM → 直到 stop）
> - Phase 1+: 加入 ContextManager（prompt 组装）、Checkpoint（状态持久化）

### 6.7 LLM Client 实现 (`packages/agent-core/src/llm/client.ts`)

```typescript
import { generateText, streamText } from 'ai';
import type { LanguageModelV1 } from 'ai';
import type { Message } from '../state/types.js';
import type { Tool } from '../tools/types.js';
import type { InferenceConfig, LLMClient, LLMResponse } from './types.js';

/**
 * 基于 Vercel AI SDK 的 LLMClient 实现
 *
 * Phase 0: 只用 generateText()，不处理 tool_calls
 * Phase 1: 加入 streamText() + tool_calls 支持
 */
export class VercelLLMClient implements LLMClient {
  constructor(private readonly model: LanguageModelV1) {}

  async chat(
    messages: readonly Message[],
    _tools: readonly Tool[],
    config: InferenceConfig,
  ): Promise<LLMResponse> {
    const result = await generateText({
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
    });

    return {
      content: result.text,
      usage: {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
      },
      finishReason: result.finishReason === 'stop' ? 'stop' : 'length',
    };
  }
}

/** 基于 streamText 的流式 LLMClient — Phase 0 用于 REPL 逐字输出 */
export class StreamingLLMClient implements LLMClient {
  constructor(
    private readonly model: LanguageModelV1,
    private readonly onChunk?: (chunk: string) => void,
  ) {}

  async chat(
    messages: readonly Message[],
    _tools: readonly Tool[],
    config: InferenceConfig,
  ): Promise<LLMResponse> {
    const result = streamText({
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      fullText += chunk;
      this.onChunk?.(chunk);
    }

    const usage = await result.usage;

    return {
      content: fullText,
      usage: {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      },
      finishReason: 'stop',
    };
  }
}
```

### 6.8 CLI REPL (`packages/agent-core/src/repl.ts`)

```typescript
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { logger } from './logger.js';
import { StreamingLLMClient } from './llm/client.js';
import { runAgentLoop } from './loop.js';
import type { Message } from './state/types.js';
import type { InferenceConfig } from './llm/types.js';

const DEFAULT_SYSTEM_PROMPT = `You are Quilin Agent (拼布麒麟), a helpful AI assistant.
Be concise, accurate, and friendly. Answer in the same language as the user.`;

const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
  temperature: 0.7,
  maxTokens: 4096,
  thinkingMode: 'disabled',
};

interface ReplOptions {
  provider: ReturnType<typeof import('./llm/provider.js').createProvider>;
  modelId: string;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { provider, modelId } = options;

  // 显示欢迎信息（直接写 stdout，不走 logger）
  stdout.write('\n🐉 Quilin Agent v0.0.1 (DeepSeek)\n');
  stdout.write('Type your message, or /exit to quit.\n\n');

  // 初始化 readline
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // 会话历史 — 整个 REPL 生命周期内累积
  const messages: Message[] = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
  ];

  // 创建流式 LLM client（逐字输出到 stdout）
  const llm = new StreamingLLMClient(
    provider(modelId),
    (chunk) => stdout.write(chunk),
  );

  // 主循环
  while (true) {
    const input = await rl.question('quilin> ');
    const trimmed = input.trim();

    // 空输入跳过
    if (!trimmed) continue;

    // 退出命令
    if (trimmed === '/exit' || trimmed === '/quit') {
      stdout.write('\nBye! 🐉\n');
      rl.close();
      return;
    }

    // 清除历史
    if (trimmed === '/clear') {
      messages.length = 1; // 保留 system prompt
      stdout.write('Conversation cleared.\n\n');
      continue;
    }

    // 追加用户消息
    messages.push({ role: 'user', content: trimmed });

    // 调用 Agent Loop
    stdout.write('\n');
    try {
      const response = await runAgentLoop(
        { llm, inferenceConfig: DEFAULT_INFERENCE_CONFIG },
        messages,
      );

      // 追加 assistant 消息到历史
      messages.push({ role: 'assistant', content: response });
      stdout.write('\n\n');
    } catch (err) {
      logger.error({ err }, 'REPL: LLM call failed');
      stdout.write('\n[Error: LLM call failed. Check logs for details.]\n\n');
      // 移除失败的 user 消息，避免污染历史
      messages.pop();
    }
  }
}
```

**REPL 交互效果**：

```
🐉 Quilin Agent v0.0.1 (DeepSeek)
Type your message, or /exit to quit.

quilin> 你好，介绍一下你自己
你好！我是 Quilin Agent（拼布麒麟），一个 AI 助手。我可以回答问题、
帮助编程、分析问题等。有什么可以帮你的吗？

quilin> 用 TypeScript 写一个 hello world
这是一个简单的 TypeScript Hello World：

```typescript
console.log("Hello, World!");
```

quilin> /clear
Conversation cleared.

quilin> /exit
Bye! 🐉
```

**REPL 命令一览**：

| 命令 | 说明 |
|------|------|
| `/exit` 或 `/quit` | 退出 REPL |
| `/clear` | 清除对话历史（保留 system prompt） |
| 其他任意文本 | 发送给 LLM |

> **设计决策**：Phase 0 使用 `StreamingLLMClient`（基于 `streamText`），LLM 回复逐字流式输出到 stdout，用户体验类似 Claude Code。非流式 `VercelLLMClient` 保留给 API / 测试场景。

---

## 7. 日志系统

### 7.1 统一日志 Schema

所有语言（TS / Python / Rust）输出**同一种 JSON 格式**到 stdout，Claude Code Monitor 可实时解析：

```typescript
/** 三种语言的日志都遵守此 schema */
interface QuilinLogEntry {
  ts: string;          // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  service: string;     // 'agent-core' | 'omnimem' | 'mesh-sdk'
  env: string;         // 'dev' | 'test' | 'prod'
  msg: string;
  traceId?: string;
  spanId?: string;
  turnCount?: number;
  toolName?: string;
  tokenUsage?: { input: number; output: number };
  durationMs?: number;
  error?: { name: string; message: string; stack?: string };
}
```

### 7.2 TS 日志 (`packages/agent-core/src/logger.ts`)

```typescript
import pino from 'pino';

const env = process.env.QUILIN_ENV ?? 'dev';

export const logger = pino({
  name: 'agent-core',
  level: process.env.LOG_LEVEL ?? (env === 'prod' ? 'info' : 'debug'),
  formatters: {
    bindings: () => ({ service: 'agent-core', env }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env === 'dev'
    ? {
        transport: {
          targets: [
            { target: 'pino-pretty', options: { destination: 2 } },  // stderr → 人读
            { target: 'pino/file', options: { destination: 1 } },    // stdout → Monitor
          ],
        },
      }
    : {}),
});
```

### 7.3 Python 日志 (`providers/memory/src/omnimem/logging.py`)

```python
import os
import structlog

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer(),
    ],
    context_class=dict,
    wrapper_class=structlog.BoundLogger,
)

logger = structlog.get_logger(
    service="omnimem",
    env=os.environ.get("QUILIN_ENV", "dev"),
)
```

### 7.4 Rust 日志 (`crates/mesh-sdk/src/lib.rs`)

```rust
// Phase 2 实现，使用 tracing + tracing-subscriber (JSON layer)
// 输出格式与 TS/Python 对齐
```

### 7.5 监控方式

| 环境 | 启动命令 | Claude Code Monitor 方式 | 日志格式 |
|------|---------|-------------------------|---------|
| dev | `just start` | `Monitor` attach 后台进程 | JSON (stdout) + pretty (stderr) |
| test | `just test-all` | `Monitor` 流式看测试进度 | JSON (每条 case 一行) |
| prod | `just prod` | `Monitor` attach + 健康检查 | JSON only |

---

## 8. justfile — 跨语言编排

```just
# Quilin Agent — 跨语言开发编排
# 使用: just <command>

set dotenv-load := true

# ============ 一键操作 ============

# 一键初始化（新机器第一次）
init:
    pnpm install
    cd providers/memory && uv sync
    cargo build --workspace
    cp -n .env.example .env 2>/dev/null || true
    @echo '✅ All dependencies installed. Edit .env with your API keys.'

# 一键启动全部服务（后台）
start:
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"Starting all services..."}'
    just _start-memory &
    sleep 2
    just _start-core &
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"All services started. Use Monitor to watch."}'

# 一键停止全部
stop:
    @pkill -f "bun run.*agent-core" || true
    @pkill -f "python -m omnimem" || true
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"All services stopped."}'

# 一键重启
restart: stop start

# 一键测试全部
test-all: test test-py test-rs

# 一键质量检查
check: lint fmt

# 一键清理
clean:
    pnpm -r exec -- rm -rf dist
    cd providers/memory && rm -rf .venv __pycache__
    cargo clean

# ============ TS (packages/) ============

# 开发模式（前台，直接看日志）
dev:
    cd packages/agent-core && LOG_LEVEL=debug QUILIN_ENV=dev bun run --watch src/index.ts

# 测试
test:
    cd packages/agent-core && QUILIN_ENV=test bun run vitest run

# Lint + Format
lint:
    cd packages/agent-core && bun run biome check src/
fmt:
    cd packages/agent-core && bun run biome format --write src/

# 构建
build:
    cd packages/agent-core && bun build src/index.ts --outdir dist --target node

# ============ Python (providers/) ============

dev-memory:
    cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m omnimem

test-py:
    cd providers/memory && QUILIN_ENV=test uv run pytest

lint-py:
    cd providers/memory && uv run ruff check src/ tests/
fmt-py:
    cd providers/memory && uv run ruff format src/ tests/

# ============ Rust (crates/) ============

build-rs:
    cargo build --workspace

test-rs:
    cargo test --workspace

lint-rs:
    cargo clippy --workspace -- -D warnings
fmt-rs:
    cargo fmt --all

# ============ 生产 ============

prod:
    LOG_LEVEL=info QUILIN_ENV=prod bun run packages/agent-core/dist/index.js

# ============ 内部 ============

_start-core:
    LOG_LEVEL=debug QUILIN_ENV=dev bun run packages/agent-core/src/index.ts

_start-memory:
    cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m omnimem
```

---

## 9. Dev Container

### .devcontainer/devcontainer.json

```json
{
  "name": "Quilin Agent Dev",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "features": {
    "ghcr.io/devcontainers/features/rust:1": {
      "version": "1.94",
      "profile": "default"
    },
    "ghcr.io/devcontainers/features/python:1": {
      "version": "3.14"
    },
    "ghcr.io/devcontainers/features/node:1": {
      "version": "22"
    }
  },
  "postCreateCommand": "npm install -g pnpm@10 && curl -fsSL https://bun.sh/install | bash && curl -LsSf https://astral.sh/uv/install.sh | sh && cargo install just && just init",
  "customizations": {
    "vscode": {
      "extensions": [
        "biomejs.biome",
        "charliermarsh.ruff",
        "rust-lang.rust-analyzer",
        "tamasfe.even-better-toml"
      ]
    }
  },
  "forwardPorts": [3000],
  "remoteEnv": {
    "QUILIN_ENV": "dev"
  }
}
```

### .devcontainer/Dockerfile

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libssl-dev \
    sqlite3 \
    libsqlite3-dev \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
```

---

## 10. CI Workflow

### .github/workflows/ci.yml

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  ts:
    name: TypeScript
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - run: pnpm install --frozen-lockfile
      - run: cd packages/agent-core && bun run biome check src/
      - run: cd packages/agent-core && bun run vitest run

  python:
    name: Python
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.14"
      - run: cd providers/memory && uv sync
      - run: cd providers/memory && uv run ruff check src/
      - run: cd providers/memory && uv run pytest

  rust:
    name: Rust
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: "1.94"
          components: clippy, rustfmt
      - run: cargo clippy --workspace -- -D warnings
      - run: cargo fmt --all -- --check
      - run: cargo test --workspace
```

---

## 11. 环境变量

### .env.example

```bash
# ===== LLM Provider =====
# Phase 0 开发使用 DeepSeek
DEEPSEEK_API_KEY=sk-xxx
QUILIN_DEFAULT_MODEL=deepseek-chat

# 可选：其他 provider（后续启用）
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# ===== 环境 =====
QUILIN_ENV=dev          # dev | test | prod
LOG_LEVEL=debug         # debug | info | warn | error
QUILIN_PORT=3000

# ===== 记忆 =====
OMNIMEM_DB_PATH=./data/omnimem.db
OMNIMEM_EMBEDDING_MODEL=all-MiniLM-L6-v2
```

### .gitignore 新增

```gitignore
# === Quilin Build ===
dist/
*.tsbuildinfo

# === Python ===
.venv/
__pycache__/
*.pyc
.pytest_cache/

# === Rust ===
target/

# === Environment ===
.env
.env.local
.env.*.local

# === Data ===
data/

# === IDE ===
.idea/
*.swp
```

---

## 12. LLM Provider 配置

### DeepSeek (Phase 0 默认)

```typescript
// packages/agent-core/src/llm/provider.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export function createProvider() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required. Copy .env.example to .env and fill in your key.');
  }

  return createOpenAICompatible({
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey,
  });
}

export function getDefaultModel() {
  return process.env.QUILIN_DEFAULT_MODEL ?? 'deepseek-chat';
}
```

### 后续扩展（Phase 1+）

```typescript
// Phase 1 添加 provider 自动选择
// import { anthropic } from '@ai-sdk/anthropic';
// import { openai } from '@ai-sdk/openai';
// 通过 QUILIN_DEFAULT_MODEL 环境变量自动路由
```

---

## 13. 明确排除项

以下内容**不在本 ADR 范围内**，不要在 Phase 0 骨架初始化中创建：

| 排除项 | 原因 | 预计 Phase |
|--------|------|-----------|
| packages/agent-dashboard/ | WebUI Dashboard | 2 |
| providers/embedding/ | 嵌入独立 MCP Server | 1 |
| providers/planning/ | 规划引擎 | 1 |
| 04-Planning 接口 | Phase 1 领域 | 1 |
| 06-MultiAgent 接口 | Phase 2 领域 | 2 |
| 07-Safety 接口 | Phase 1 领域 | 1 |
| 08-Observability (OTel) | Phase 1 领域 | 1 |
| 09-Deployment 热更新 | Phase 2 | 2 |
| 10-SelfEvolution | Phase 2 领域 | 2 |
| 11-Agent Mesh 业务代码 | Rust 骨架只有 lib.rs 占位 | 2 |
| 12-Conversation Engineering | Phase 2 领域 | 2 |
| Docker 生产镜像 | Dev Container 先行 | 1 |
| SWE-bench harness | benchmark 适配器 | 0 后续 |

---

## 14. 执行检查清单

完成骨架初始化后，验证以下全部通过：

```bash
# 1. 依赖安装
just init                           # ✅ 无报错

# 2. TS 构建 + 测试 + lint
just build                          # ✅ 构建成功
just test                           # ✅ 测试通过（即使 0 test case）
just lint                           # ✅ 无 lint 错误

# 3. Python 测试 + lint
just test-py                        # ✅ 测试通过
just lint-py                        # ✅ 无 lint 错误

# 4. Rust 构建 + 测试
just build-rs                       # ✅ 构建成功
just test-rs                        # ✅ 测试通过

# 5. 一键启动 → LLM 验证 → CLI REPL
just dev                            # ✅ 看到 "Quilin Agent starting" → "LLM connection verified"
                                    # ✅ DeepSeek 返回 "Quilin Agent online."
                                    # ✅ 看到 "🐉 Quilin Agent v0.0.1 (DeepSeek)" 欢迎信息
                                    # ✅ 出现 "quilin>" 提示符

# 6. REPL 交互验证
# 输入 "hello" → 看到流式文字逐字输出                     # ✅ 流式回复
# 输入 /clear → 看到 "Conversation cleared."               # ✅ 清除历史
# 输入 /exit → 看到 "Bye! 🐉" 并正常退出                   # ✅ 正常退出
# Ctrl+C → 进程干净退出                                    # ✅ 信号处理

# 7. 环境变量
cat .env.example                    # ✅ 模板存在
```

---

## 15. 后续步骤

骨架初始化完成后，按以下顺序进入 Phase 0 功能开发：

1. ~~**项目骨架**~~ — ✅ 已完成（ADR-002 §1-§12）
2. **CLI REPL + Agent Loop** — `repl.ts` + `loop.ts` + `client.ts`（← **当前步骤，见 §6.5-§6.8**）
   - `VercelLLMClient` / `StreamingLLMClient` 封装 Vercel AI SDK
   - `runAgentLoop()` 单轮调用（Phase 0 简化版）
   - `startRepl()` readline 交互循环
   - `index.ts` 启动 → 验证 → 进入 REPL
   - **验收标准**: `just dev` → 看到欢迎信息 → 输入文本 → 看到流式回复 → `/exit` 退出
3. **ToolRouter** — `router.ts` 基础工具分发
4. **MCP Client** — `mcp-client.ts` 连接 Python OmniMem
5. **OmniMem MCP Server** — `providers/memory/` 实现 recall/store
6. **ContextManager** — `manager.ts` 基础 prompt 组装
7. **Checkpoint** — `checkpoint.ts` SQLite 状态持久化
8. **端到端验证** — ask → recall → LLM → respond 完整流程
9. **SWE-bench 适配** — benchmark harness 接入
