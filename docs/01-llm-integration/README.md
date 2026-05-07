# LLM 接入工程（LLM Integration Engineering）

> **实现状态（2026-04-30 校准）**
> - ✅ **已实现**：`packages/agent-core/src/llm/` — AI SDK v6 `LLMClient`、`InferenceConfig`、`ThinkingMode`、provider-aware thinking options、`fullStream` reasoning/tool events、provider-tagged `ReasoningPart` 提取、token usage/cache usage 基础、Anthropic prompt-cache breakpoint adapter。
> - 🚧 **部分实现 / 延期**：provider 能力矩阵已有 Anthropic / OpenAI / DeepSeek 等代码路径与 mock 测试，但未做全 provider live 验收；reasoning replay / carry-over adapter 仍 deferred。全局进度见 [`docs/STATUS.md`](../STATUS.md)。
> - Linear 后续项：[QUI-14](https://linear.app/quilin-agent/issue/QUI-14/01-llm-production-provider-matrix-fallback-and-reasoning-support)（provider matrix）、[QUI-91](https://linear.app/quilin-agent/issue/QUI-91/m5-实现-provider-credentials-oauth-管理与-quota-感知)（凭证/OAuth 管理，API 骨架已完成）、[QUI-93](https://linear.app/quilin-agent/issue/QUI-93/m7-实现原生多模态图片音频视频理解)（多模态理解，deferred）。

> 本文档是 Quilin Agent 工程规格系列的第 1 篇，定义 LLM 接入层的设计方案、参考来源与验证标准。
>
> **ADR-001 对齐说明**：核心语言已决策为 TypeScript（见 [Core Loop](../00-core-loop/README.md)），旧 Python 代码（`quilin/core/llm.py`）已删除。本文档中的 Python 代码示例仅表达设计意图，实施时将以 TS 重写。`quilin/` 路径为规划参考，最终目录结构以实施时为准。

> **D-07 裁决（2026-04-18）：Vercel AI SDK v6 权威锁定**
>
> - **运行时**：Agent Core 统一使用 **Vercel AI SDK v6**（`ai` + 各 provider 包，如 `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`）作为 LLM 调用底座。文档中所有 **`litellm` / `LiteLLMClient` / `acompletion` 描述均为历史设计语境**，实施时以 AI SDK v6 API 为准。
> - **参数命名权威**：AI SDK v6 起 `maxTokens` 已重命名为 **`maxOutputTokens`**（v5 → v6 breaking change）。所有新代码必须使用 `maxOutputTokens`；v5 shim 禁止存在（见 R-11 / TS-03）。
> - **provider 归一化**：AI SDK 的 `LanguageModelV2` interface 已处理 tool call / stream / token count 归一化，**不再引入 litellm 中间层**。需要接国内模型（Qwen / GLM 等）时，优先看 community provider package；没有则自行实现 `LanguageModelV2`。
> - **Python 侧**：仅 03-Memory / ML providers 使用 Python；**不做 LLM 调用**（避免跨语言同时维护两套 LLM 客户端）。Python 侧如需 LLM，走 MCP 调回 TS 的 LLMClient。
> - **Thinking token / reasoning 支持**：通过 AI SDK v6 的 `providerOptions.{anthropic|openai|google}` 透传（`thinking` / `reasoning_effort` 等），在 `LLMClient` 层做统一 `ThinkingMode` 映射。
>
> **Provider 能力矩阵**（2026-04-18 权威表，随 SDK 更新必须同步）：
>
> | Provider | Package | tool calling | streaming | reasoning token | multi-modal | 备注 |
> |----------|---------|:-:|:-:|:-:|:-:|------|
> | Anthropic Claude | `@ai-sdk/anthropic` | ✅ | ✅ | ✅ (`providerOptions.anthropic.thinking`) | ✅ 图像 | 主力模型，Opus 4.7 / Sonnet 4.6 / Haiku 4.5 |
> | OpenAI | `@ai-sdk/openai` | ✅ | ✅ | ✅ o 系列 `reasoning_effort` | ✅ 图像 | GPT-5.4 及后续 |
> | Google Gemini | `@ai-sdk/google` | ✅ | ✅ | ⚠️ 预览 | ✅ 图像/视频 | Gemini 2.x |
> | Groq / Cerebras | `@ai-sdk/groq` 等 | ✅ | ✅ | ❌ | ❌ | 低延迟备选 |
> | 本地 Ollama | `ollama-ai-provider` (community) | ✅ | ✅ | ❌ | 部分 | 离线 fallback |
> | 国内 Qwen / GLM | 自行 `LanguageModelV2` 实现 | ⚠️ 需验证 | ⚠️ | ❌ | ⚠️ | 按需接入，能力矩阵随实现更新 |
>
> ❌ 表示**未实现或无此能力**；⚠️ 表示**能力存在但 SDK 兼容性/稳定性未验收**；✅ 表示**已走通 + 集成测试覆盖**。`LLMClient` 调用前必须查能力矩阵，不支持的能力直接返回 `UnsupportedCapabilityError`，禁止静默 fallback。

---

## 一、问题定义

### 1.1 Agent 为什么需要统一 LLM 调用层？

一个生产级 Agent 框架面临的核心挑战不是"能否调用 LLM"，而是"如何跨越供应商碎片化、按需控制推理深度、统一抽象流式输出与工具调用"。具体表现在以下五个维度：

**1. 模型供应商 API 碎片化**

不同供应商的 API 格式、认证方式、参数名称、错误码均不一致：

| 供应商 | API 格式 | 工具调用格式 | 思考 token | 流式协议 |
|--------|---------|------------|-----------|---------|
| OpenAI | `/v1/chat/completions` | `tools[]` + `tool_choice` | `reasoning_content` (o系列) | SSE |
| Anthropic | `/v1/messages` | `tools[]` + `tool_use` block | `<thinking>` block | SSE |
| Google | Vertex AI 格式 | `functionDeclarations` | 无 | gRPC stream |
| 国内模型 | 各异 | 各异 | 各异 | 各异 |

Agent 代码不应直接依赖任何一家供应商的格式。变更模型时不应修改业务逻辑代码。

**2. 推理深度控制需求**

不同任务对"思考"的需求差异极大：

- **简单工具调用**（读文件、查数据库）：不需要深度思考，开启 CoT 反而浪费 token、增加延迟
- **标准任务**（代码生成、问答）：适度推理即可
- **复杂规划**（多步任务分解、长链推理）：需要完整的思考链，甚至跨轮保留思维状态

如果所有调用都用同一套参数，要么简单任务浪费成本，要么复杂任务推理不足。

**3. 思考模式管理需求**

受 GLM-5.1 的三种思考模式（Interleaved / Preserved / Off）启发，Agent 需要按调用粒度控制思考行为：

- 何时打开思考，打开多深
- 思考状态是否跨轮保留
- 思考 token 是否计入上下文计费

这不是一个简单的 `temperature` 参数能解决的问题，需要独立的 `ThinkingMode` 抽象。

**4. 流式输出与 token 计数的统一抽象**

用户期望流式响应（逐字输出），监控系统需要精确的 token 计数（输入/输出/思考分别统计）。不同模型的流式协议和 usage 字段格式不一致，需要在 `LLMClient` 层统一归一化。

**5. 工具调用格式归一化**

不同模型返回的工具调用格式差异显著（OpenAI `tool_calls[]` vs Anthropic `tool_use` block vs 文本解析）。Agent 的工具调度层不应感知这些差异，`LLMClient` 必须在边界处完成归一化，统一输出 `ToolCall` 对象。

---

## 二、设计方案

### 2.1 LLMClient 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Quilin                                       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Agent 循环（Harness.py）                    │   │
│  │  verify_input → build_context → plan → execute_tools         │   │
│  │      → verify_output → reflect → decide                      │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           │ chat() / chat_stream()                  │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   LLMClient（llm.py）                        │    │
│  │                                                             │    │
│  │  ┌──────────────┐  ┌─────────────────┐  ┌───────────────┐  │    │
│  │  │ ThinkingMode │  │ InferenceConfig  │  │ TokenCounter  │  │    │
│  │  │ OFF          │  │ QUICK / STANDARD │  │ input_tokens  │  │    │
│  │  │ INTERLEAVED  │  │ DEEP             │  │ output_tokens │  │    │
│  │  │ PRESERVED    │  │ (temp/max_tokens │  │ think_tokens  │  │    │
│  │  └──────────────┘  │  /think_budget)  │  └───────────────┘  │    │
│  │                    └─────────────────┘                      │    │
│  │  ┌──────────────────────────────────────────────────────┐   │    │
│  │  │              LLM 调用核心（litellm 封装）              │   │    │
│  │  │  acompletion() / acompletion(stream=True)            │   │    │
│  │  │  模型别名映射 / 重试 / 超时 / 回调钩子                  │   │    │
│  │  └────────────────────────┬─────────────────────────────┘   │    │
│  └───────────────────────────┼─────────────────────────────────┘    │
│                              │                                      │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ litellm.acompletion()
                               ▼
         ┌─────────────────────────────────────────────┐
         │               litellm（统一网关）              │
         │  provider 路由 / 格式转换 / 参数兼容           │
         └──────────┬──────────┬──────────┬────────────┘
                    │          │          │
          ┌─────────▼──┐ ┌────▼────┐ ┌───▼────────┐
          │  OpenAI    │ │Anthropic│ │ 本地 Ollama │
          │  GLM / etc │ │ Claude  │ │  vLLM / etc│
          └────────────┘ └─────────┘ └────────────┘

  ──────────────── 与其他 Harness 组件的关系 ────────────────

  quilin-mem（记忆层）  ─── 构建 messages[] ──→  LLMClient.chat()
  ToolRouter（工具层）─── 注入 tools[] ────→  LLMClient.chat()
  MCPBus（协议总线）  ─── 分发响应 ────────→  LLMResponse
  Verifier（验证层）  ─── 消费 LLMResponse ─→  验证输出
```

### 2.2 ThinkingMode 三模式设计（GLM-5.1 启发）

```
ThinkingMode.OFF
  适用场景：简单工具调用（read_file、search_db、格式转换）
  行为：不发送 thinking 相关参数，模型直接生成响应
  token 成本：最低（无思考 token）
  触发条件：
    - 任务类型标记为 SIMPLE（工具调用层主动传入）
    - tools 列表仅包含确定性工具（文件读写、数据库查询）
    - InferenceConfig.thinking_mode 显式设为 OFF

ThinkingMode.INTERLEAVED（每步独立思考）
  适用场景：标准 Agent 步骤（代码生成、问答、推理）
  行为：每轮调用独立开启思考，思考完成后立即生成响应
         用户消息 → <think>推理过程</think> → 响应 / 工具调用
  token 成本：中等（每轮一次思考 budget）
  触发条件：
    - 默认模式（未指定时）
    - InferenceConfig.thinking_budget 在 1000-8000 之间
    - 任务复杂度 = STANDARD

ThinkingMode.PRESERVED（跨轮连续思考）
  适用场景：需要多步连续推理的复杂任务（长链规划、调试、研究）
  行为：思考 token 跨轮保留，LLM 看到完整的跨轮思维链
         轮 1: <think>开始推理...</think> → 响应
         轮 2: <think>（延续轮1思维）...继续推理</think> → 响应
  token 成本：最高（思考 token 累积进上下文）
  触发条件：
    - 任务类型标记为 COMPLEX
    - 用户显式指定
    - Harness 在 plan 阶段检测到多步依赖
    - InferenceConfig.thinking_budget >= 8000

模式切换逻辑：
  ┌──────────────────────────────────────────────────┐
  │  任务分类器（Harness.plan 阶段）                  │
  │                                                  │
  │  简单（无状态工具调用）  → OFF                    │
  │  标准（单步推理/生成）  → INTERLEAVED             │
  │  复杂（多步依赖规划）   → PRESERVED               │
  └──────────────────────────────────────────────────┘
```

### 2.3 InferenceConfig 成本感知调参（MAI-UI 启发）

核心思想：**同一个模型，按任务复杂度调整参数**——不是换模型，而是换参数组合。

```
预设配置：

QUICK（简单问答 / 工具调用）
  temperature     = 0.0      # 确定性输出，减少随机
  max_tokens      = 512      # 短响应即可
  thinking_budget = 0        # 不思考
  thinking_mode   = OFF
  timeout_s       = 10       # 快速失败

STANDARD（正常 Agent 步骤）
  temperature     = 0.0      # 代码/工具调用仍用确定性
  max_tokens      = 4096
  thinking_budget = 2000     # 适度思考
  thinking_mode   = INTERLEAVED
  timeout_s       = 30

DEEP（复杂推理 / 长链规划）
  temperature     = 0.0      # 推理任务不需要随机性
  max_tokens      = 16384
  thinking_budget = 16000    # 深度思考预算
  thinking_mode   = PRESERVED
  timeout_s       = 120

自定义覆盖：
  config = InferenceConfig.STANDARD.replace(max_tokens=8192)
  # 允许在预设基础上覆盖单个字段（frozen dataclass + replace 方法）
```

与 MAI-UI 的 Device-Cloud 成本感知协作的对应关系：

```
MAI-UI：
  简单 GUI 操作 → 本地轻量模型
  复杂规划偏离 → 升级大模型

LLMClient：
  简单任务   → 同一模型 + QUICK 配置（成本最低）
  复杂任务   → 同一模型 + DEEP 配置（质量最高）
  # 不换模型，但调整推理深度 → 同等质量提升，无切换延迟
```

### 2.4 流式输出接口设计

```python
# AsyncIterator[str] 接口
# 逐 token 推送，调用方通过 async for 消费

async def chat_stream(
    messages: list[Message],
    config: InferenceConfig = InferenceConfig.STANDARD,
) -> AsyncIterator[str]:
    """
    流式调用 LLM，每次 yield 一个文本块（通常 1-4 个 token）。

    注意：
    - 思考 token（<think>...</think>）默认过滤，不推送给调用方
    - 可通过 config.stream_thinking=True 开启思考流
    - 工具调用不走流式接口（需完整 JSON，走 chat()）
    """
    ...
```

### 2.5 Token 计数

三类 token 分别计数，便于成本追踪和上下文窗口管理：

```
usage = {
    "prompt_tokens":     int,   # 输入 token（messages + system + tools schema）
    "completion_tokens": int,   # 输出 token（实际响应内容）
    "thinking_tokens":   int,   # 思考 token（对部分模型计费，部分不计）
    "total_tokens":      int,   # prompt + completion + thinking
}
```

`count_tokens()` 方法在发送请求前预估输入 token 数，用于：
1. 上下文窗口溢出检测（超过阈值时触发 quilin-mem 压缩）
2. 成本预算门控（超过每轮 token 上限时降级到 QUICK 配置）

### 2.6 工具调用格式归一化

统一使用 OpenAI function calling schema，litellm 负责向各 provider 转换：

```
Agent 层（统一格式）
  ↓ tools: list[ToolSchema]    # OpenAI tools[] 格式
  ↓ 传入 LLMClient.chat()
  ↓
LLMClient 层
  ↓ litellm.acompletion(tools=tools)
  ↓ litellm 自动转换为各 provider 格式：
      OpenAI   → tools[] 原样传递
      Anthropic → 转换为 tools[] + tool_use block
      GLM      → 转换为各厂商工具格式
  ↓
响应解析
  ↓ LLMClient 将各 provider 格式的工具调用响应
  ↓ 统一解析为 ToolCall(id, name, arguments) 对象
  ↓
Agent 层
  ↓ 消费 LLMResponse.tool_calls: tuple[ToolCall, ...]
  # Agent 代码无需感知任何供应商差异
```

### 2.7 核心接口定义（Protocol 伪代码）

```python
# quilin/core/llm.py

from __future__ import annotations
from enum import Enum
from dataclasses import dataclass, field, replace
from typing import AsyncIterator, Protocol
from quilin.core.messages import LLMResponse, Message


class ThinkingMode(str, Enum):
    """推理深度控制模式，受 GLM-5.1 启发。"""
    OFF         = "off"         # 不思考，直接响应
    INTERLEAVED = "interleaved" # 每轮独立思考
    PRESERVED   = "preserved"   # 跨轮保留思维链


@dataclass(frozen=True)
class InferenceConfig:
    """
    LLM 推理参数配置（单次调用粒度）。
    frozen=True 确保不可变，使用 replace() 派生新配置。
    """
    temperature:     float       = 0.0
    max_tokens:      int         = 4096
    thinking_mode:   ThinkingMode = ThinkingMode.INTERLEAVED
    thinking_budget: int         = 2000    # thinking token 预算，OFF 时忽略
    timeout_s:       float       = 30.0
    stream_thinking: bool        = False   # 是否在流式输出中包含思考 token
    retry_max:       int         = 3       # 最大重试次数
    retry_base_s:    float       = 1.0    # 指数退避基础延迟（秒）

    def replace(self, **kwargs) -> InferenceConfig:
        """派生新配置，覆盖指定字段（不可变模式）。"""
        return replace(self, **kwargs)


# 预设配置（工厂实例）
InferenceConfig.QUICK    = InferenceConfig(
    temperature=0.0, max_tokens=512,
    thinking_mode=ThinkingMode.OFF, thinking_budget=0,
    timeout_s=10.0
)
InferenceConfig.STANDARD = InferenceConfig(
    temperature=0.0, max_tokens=4096,
    thinking_mode=ThinkingMode.INTERLEAVED, thinking_budget=2000,
    timeout_s=30.0
)
InferenceConfig.DEEP     = InferenceConfig(
    temperature=0.0, max_tokens=16384,
    thinking_mode=ThinkingMode.PRESERVED, thinking_budget=16000,
    timeout_s=120.0
)


class LLMClient(Protocol):
    """
    LLM 调用的统一接口协议。
    具体实现：LiteLLMClient（quilin/core/llm.py）。
    """

    async def chat(
        self,
        messages: list[Message],
        tools: list[dict] | None = None,
        config: InferenceConfig = InferenceConfig.STANDARD,
    ) -> LLMResponse:
        """
        非流式调用，返回完整响应。
        包含 content、tool_calls、usage（输入/输出/思考 token 分别统计）。
        """
        ...

    async def chat_stream(
        self,
        messages: list[Message],
        config: InferenceConfig = InferenceConfig.STANDARD,
    ) -> AsyncIterator[str]:
        """
        流式调用，逐 token 推送文本内容。
        注意：工具调用不走流式接口。
        """
        ...

    def count_tokens(self, messages: list[Message]) -> int:
        """
        预估 messages 的输入 token 数（不发起 API 调用）。
        用于上下文窗口溢出检测和成本门控。
        """
        ...


class LLMCallbackHandler(Protocol):
    """
    LLM 调用生命周期回调（受 LangChain 启发）。
    注册到 LiteLLMClient 后，在调用的各阶段自动触发。
    用于可观测性集成（日志、指标、追踪）。
    """

    async def on_llm_start(
        self,
        messages: list[Message],
        config: InferenceConfig,
    ) -> None:
        """调用开始前触发。可用于记录请求日志、启动 span。"""
        ...

    async def on_llm_end(
        self,
        response: LLMResponse,
        elapsed_s: float,
    ) -> None:
        """调用成功后触发。可用于记录 token 使用量、响应延迟。"""
        ...

    async def on_llm_error(
        self,
        error: Exception,
        attempt: int,
    ) -> None:
        """调用失败时触发（每次重试前）。可用于记录错误、触发告警。"""
        ...
```

### 2.8 配置项设计（config.yaml）

```yaml
# quilin/config.yaml — LLM 相关配置块

llm:
  # 当前使用的模型（litellm 格式，支持任意 provider）
  model: "openai/gpt-4o"              # 示例：OpenAI
  # model: "anthropic/claude-sonnet-4-5" # 示例：Anthropic
  # model: "ollama/qwen3:14b"           # 示例：本地 Ollama
  # model: "openai/gpt-4o"              # 示例：任意 OpenAI 兼容 API

  # API 认证（优先从环境变量读取，此处为 fallback）
  api_key: "${OPENAI_API_KEY}"         # 支持环境变量插值
  api_base: ""                         # 自定义 endpoint（本地模型时使用）

  # 模型别名映射（可选，方便切换）
  aliases:
    default:  "openai/gpt-4o"
    fast:     "openai/gpt-4o-mini"
    local:    "ollama/qwen3:14b"

  # 推理参数预设（覆盖默认值）
  inference:
    quick:
      max_tokens:      512
      thinking_budget: 0
      timeout_s:       10
    standard:
      max_tokens:      4096
      thinking_budget: 2000
      timeout_s:       30
    deep:
      max_tokens:      16384
      thinking_budget: 16000
      timeout_s:       120

  # 重试策略
  retry:
    max_attempts: 3
    base_delay_s: 1.0     # 指数退避：1s, 2s, 4s
    max_delay_s:  30.0

  # 回退策略（主模型不可用时）
  fallback:
    enabled: true
    model: "ollama/qwen3:14b"   # 本地模型作为最终回退

  # litellm 全局设置
  litellm:
    drop_params: true     # 自动忽略模型不支持的参数
    set_verbose: false
```

---

## 三、Top 10 参考项目

| # | 项目 | Stars（2026-04） | 核心特色 | 吸收点 | 深度 |
|---|------|----------------|---------|--------|------|
| 1 | **litellm** | ~40k | 统一 100+ provider API，OpenAI 格式归一化，Cost tracking，AI Gateway | provider 归一化、acompletion 异步调用、模型别名、回退策略 | 深入 |
| 2 | **LangChain** | ~128k | 回调系统（on_llm_start/end/error）、LLM 缓存（InMemory/SQLite/Redis）、丰富生态 | 回调钩子设计、缓存层接口 | 深入 |
| 3 | **LlamaIndex** | ~48k | 结构化输出（Pydantic Program）、自动重试（指数退避）、RAG 数据框架 | 结构化输出集成、指数退避重试 | 深入 |
| 4 | **vLLM** | ~75k | PagedAttention 高效 KV 缓存、AsyncLLMEngine、连续批处理、生产级本地部署 | 本地部署对接模式、AsyncEngine 接入 | 深入 |
| 5 | **SGLang** | ~25k | RadixAttention 前缀 KV 缓存复用、前端 DSL、最高吞吐量、2026 已商业化 | 前缀缓存策略启发（Prompt Caching 对齐） | 深入 |
| 6 | **Ollama** | ~169k | 本地推理一键拉起、模型管理、OpenAI 兼容 API、52M 月下载量 | 本地模型 fallback 对接、开发环境快速切换 | 观察 |
| 7 | **Haystack** | ~21k | Pipeline 式 LLM 编排、PipelineTool 将 Pipeline 暴露为 LLM 工具 | 无直接吸收，架构参考 | 观察 |
| 8 | **TGI** | ~9k | 生产部署推理服务、Flash Attention、已进入维护模式（2025-12） | 生产部署参考，vLLM 作为替代方案更优 | 观察 |
| 9 | **BentoML** | ~8.5k | 模型服务化、动态批处理、多模型 Pipeline | 模型服务化参考，本项目不直接使用 | 观察 |
| 10 | **MLX** | ~25k（框架）/ ~4.3k（mlx-lm） | Apple Silicon 优化推理、统一内存架构、Mac 本地 Agent 栈 | Mac 本地开发时的首选 backend | 观察 |

### 深入项目分析

**litellm**

litellm 是本项目 LLMClient 的核心依赖，提供 100+ 供应商的统一 API 层。其 `acompletion()` 接口与 OpenAI 格式完全兼容，支持模型别名映射（`model_alias_map`）、自动 `drop_params`（忽略模型不支持的参数）、以及内建的回退链（`fallbacks`）。2026 年 litellm 新增了对 MCP 和 Agent 原生协议的支持，与 Quilin 的 MCPBus 天然对齐。最关键的是 `litellm.drop_params = True` 这一全局开关，允许 LLMClient 向所有模型统一传递相同参数集，不支持的参数自动忽略，无需为每个 provider 维护参数白名单。

**LangChain LLM**

LangChain 的回调系统（`on_llm_start` / `on_llm_end` / `on_llm_error`）是 LLM 可观测性的最佳实践参考。这套设计将"LLM 调用的监控关注点"与"业务逻辑"完全解耦：业务层调用 `chat()`，监控系统通过注册 `CallbackHandler` 自动收集日志、token 使用量、延迟指标，无需侵入调用路径。LangChain 的 `InMemoryCache` 和 `SQLiteCache` 设计提供了相同输入的响应缓存，对于开发环境调试和减少重复 API 调用极为有用。本项目的 `LLMCallbackHandler` Protocol 直接借鉴这套接口命名规范。

**LlamaIndex LLM**

LlamaIndex 的 `LLMTextCompletionProgram` 和 `PydanticOutputParser` 组合提供了"结构化输出 + 自动重试"的完整解决方案：当 LLM 返回不符合 Pydantic schema 的内容时，系统自动将验证错误信息附加到 prompt 中重新调用。这套"错误信息反馈重试"机制（Error-Augmented Retry）比简单的固定次数重试更智能，错误 prompt 给 LLM 提供了纠正方向。此外，LlamaIndex 实现的指数退避重试（`RetryCallable`）设计简洁，直接启发了 `InferenceConfig.retry_base_s` 字段的设计。

**vLLM**

vLLM 的 `AsyncLLMEngine` 提供了本地部署高性能推理的标准对接模式：通过 OpenAI 兼容 API（`--api-base http://localhost:8000/v1`）暴露服务，litellm 直接对接，无需修改 `LLMClient` 代码。vLLM 的连续批处理（Continuous Batching）设计启发了 LLMClient 的并发模型：多个 `asyncio.create_task(client.chat(...))` 可以并发发出，底层 vLLM 通过连续批处理合并处理，吞吐量线性提升。本项目在本地部署场景（`config.yaml` 中设置 `api_base`）时优先推荐 vLLM 作为推理后端。

**SGLang**

SGLang 的 RadixAttention 核心思想是"前缀 KV 缓存自动复用"——具有相同前缀的多次调用共享一份 KV 缓存，多轮对话的系统提示只需计算一次。这与云端模型的 Prompt Caching（Anthropic / OpenAI）理念完全一致。对 LLMClient 的启发：**system prompt 应该固定在消息列表最前面**，且每次调用保持不变（不动态修改 system prompt），以最大化命中 prompt cache。此外，SGLang 在 2026 年作为 SGLang/RadixArk 商业化后，vLLM 已成为本地推理的主要开源替代方案。

---

## 四、吸收内化方案

### 4.1 从 litellm 吸收：provider 归一化与异步调用

**吸收点**：`acompletion()` 异步接口、`drop_params` 全局开关、模型别名映射、内建 fallbacks

**融入方式**：

`LiteLLMClient.chat()` 直接封装 `litellm.acompletion()`，所有 provider 差异由 litellm 在下层处理。LLMClient 只需维护一套统一的参数传递逻辑：

```python
# 伪代码：LiteLLMClient.chat() 核心逻辑
async def chat(self, messages, tools=None, config=InferenceConfig.STANDARD):
    kwargs = {
        "model": self._model,
        "messages": [m.to_litellm() for m in messages],
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        # thinking 参数由 _build_thinking_params() 按模型差异生成
        **self._build_thinking_params(config),
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    # litellm 的 drop_params=True 确保不支持的参数不会引发错误
    response = await litellm.acompletion(**kwargs)
    return self._parse_response(response)
```

模型别名映射允许 config.yaml 中用语义化名称（`fast`、`local`）引用模型，切换模型时只改配置文件，无需改代码：

```python
# LiteLLMClient 初始化时处理别名
model = config["llm"]["aliases"].get(model_name, model_name)
```

litellm 的 `fallbacks` 参数直接传递 fallback 模型列表，当主模型不可用时自动切换：

```python
kwargs["fallbacks"] = [{"model": config["llm"]["fallback"]["model"]}]
```

### 4.2 从 LangChain 吸收：回调钩子与缓存设计

**吸收点**：`on_llm_start` / `on_llm_end` / `on_llm_error` 回调接口设计、`InMemoryCache` 缓存策略

**融入方式**：

`LiteLLMClient` 维护一个 `list[LLMCallbackHandler]`，在调用生命周期各阶段依次触发：

```python
# 伪代码：回调触发逻辑
async def chat(self, messages, tools=None, config=InferenceConfig.STANDARD):
    # 触发 on_llm_start
    for handler in self._callbacks:
        await handler.on_llm_start(messages, config)

    try:
        response = await self._call_litellm(messages, tools, config)
        # 触发 on_llm_end
        for handler in self._callbacks:
            await handler.on_llm_end(response, elapsed_s)
        return response
    except Exception as e:
        # 触发 on_llm_error
        for handler in self._callbacks:
            await handler.on_llm_error(e, attempt=attempt)
        raise
```

可观测性层（Harness 的 Observability 组件）通过注册 `ObservabilityCallbackHandler` 自动收集所有 LLM 调用的指标，无需修改 `LiteLLMClient` 代码。

LangChain 的 `InMemoryCache` 设计启发了开发环境下的响应缓存：相同 messages hash + 相同 config → 直接返回缓存响应，避免开发调试中重复消耗 API 配额：

```python
# 缓存键 = hash(messages) + hash(config) + model_name
cache_key = _compute_cache_key(messages, config, self._model)
if cached := self._cache.get(cache_key):
    return cached
```

### 4.3 从 LlamaIndex 吸收：结构化输出与指数退避重试

**吸收点**：`PydanticOutputParser` 的错误反馈重试机制、`RetryCallable` 指数退避

**融入方式**：

LLMClient 的重试逻辑采用指数退避，且在 LLM API 错误和结构化输出验证错误两种场景下均可触发：

```python
# 伪代码：指数退避重试
async def _call_with_retry(self, call_fn, config: InferenceConfig):
    for attempt in range(config.retry_max):
        try:
            return await call_fn()
        except (RateLimitError, APITimeoutError) as e:
            if attempt == config.retry_max - 1:
                raise
            delay = config.retry_base_s * (2 ** attempt)
            await asyncio.sleep(min(delay, 30.0))
            await self._callbacks_on_error(e, attempt)
```

对于需要结构化输出的场景（如 Harness 的 plan 阶段），LLMClient 提供 `chat_structured()` 方法，集成 Pydantic 验证 + 错误反馈重试（受 LlamaIndex 的 Error-Augmented Retry 启发）：

```python
# 伪代码：结构化输出调用
async def chat_structured(
    self,
    messages: list[Message],
    output_cls: type[T],          # Pydantic 模型类
    config: InferenceConfig = InferenceConfig.STANDARD,
) -> T:
    for attempt in range(config.retry_max):
        response = await self.chat(messages, config=config)
        try:
            return output_cls.model_validate_json(response.content)
        except ValidationError as e:
            # LlamaIndex 启发：将验证错误反馈给 LLM
            messages = messages + [
                Message.assistant(response.content),
                Message.user(f"输出格式错误，请重新生成：{e}"),
            ]
    raise StructuredOutputError(f"结构化输出失败，已重试 {config.retry_max} 次")
```

### 4.4 从 vLLM 吸收：本地部署 AsyncEngine 对接模式

**吸收点**：通过 OpenAI 兼容 API 对接 vLLM、连续批处理对并发设计的启发

**融入方式**：

vLLM 部署后暴露 `http://localhost:8000/v1` 端点，litellm 通过 `api_base` 参数对接，LLMClient 代码零修改：

```yaml
# config.yaml — 切换到本地 vLLM
llm:
  model: "openai/Qwen3-14B"       # model 名称匹配 vLLM 加载的模型
  api_base: "http://localhost:8000/v1"
  api_key: "not-needed"
```

vLLM 的连续批处理设计验证了 LLMClient 并发调用的可行性：多个 `asyncio.create_task(client.chat(...))` 并发发出的请求，vLLM 在服务端批处理，整体吞吐量接近线性提升。这意味着 Harness 的并发子 Agent 可以安全地并发调用 LLMClient，无需自建请求队列。

```python
# Harness 中的并发 LLM 调用示例（受 vLLM 连续批处理启发）
results = await asyncio.gather(
    client.chat(messages_agent_1, config=InferenceConfig.QUICK),
    client.chat(messages_agent_2, config=InferenceConfig.QUICK),
    client.chat(messages_agent_3, config=InferenceConfig.STANDARD),
)
```

### 4.5 从 SGLang 吸收：RadixAttention 前缀缓存策略

**吸收点**：前缀 KV 缓存复用的思想 → 对齐云端 Prompt Caching 的使用规范

**融入方式**：

SGLang 的 RadixAttention 自动复用具有相同前缀的 KV 缓存；云端模型（Anthropic、OpenAI）的 Prompt Caching 在系统提示和长上下文前缀相同时自动命中缓存，节省 50-90% 的输入 token 成本。

LLMClient 的实现规范受此启发，制定以下**消息构建规则**：

1. **System prompt 永远是 messages[0]**，且内容保持固定（不插入动态变量）
2. **工具 schema 紧跟 system prompt 注入**，保持内容稳定
3. **动态内容（用户输入、工具结果）附加在消息末尾**，前缀部分不变

这样同一 session 的多次调用可以最大化命中 Anthropic / OpenAI 的 prompt cache：

```python
# LiteLLMClient 内部的消息构建规范（伪代码注释）
def _build_messages(self, system: str, history: list[Message], new_input: str):
    return [
        Message.system(system),           # 固定前缀，命中 prompt cache
        *history,                         # 历史消息（稳定前缀）
        Message.user(new_input),          # 动态部分永远在末尾
    ]
```

此外，SGLang 的 Router Cache 设计（基于 URL 路由到共享前缀的 GPU worker）启发了 Harness 在多 Agent 场景下共享 system prompt 的设计：所有子 Agent 使用相同的 base system prompt，差异化指令附加在末尾，最大化 prefix cache 命中率。

---

## 五、与 Harness 组件映射

### 5.1 组件文件映射

> **状态校准（2026-04-30）**：下表是早期 Python Harness 映射快照。当前实现路径在 `packages/agent-core/src/llm/`，Python LLM client / LiteLLMClient 不再作为 Quilin runtime 目标；Python 仅承载 03-Memory / ML providers。

| 组件 | 文件路径 | 接口 | 状态 |
|------|---------|------|------|
| LLMClient Protocol | `packages/agent-core/src/llm/types.ts` | `chat()` + streaming event callback | ✅ 当前实现 |
| ThinkingMode | `packages/agent-core/src/llm/types.ts` | `enabled / disabled / auto` | ✅ 当前实现 |
| InferenceConfig | `packages/agent-core/src/llm/types.ts` | temperature / maxTokens / thinkingMode / thinkingBudget | ✅ 当前实现 |
| AI SDK wrapper | `packages/agent-core/src/llm/client.ts` | provider options + reasoning extraction + stream handling | ✅ 当前实现 |
| Cache adapter | `packages/agent-core/src/llm/cache-adapter.ts` | prompt-cache breakpoint + outbound message serialization | ✅ 当前实现；reasoning replay deferred |
| Message / ToolCall / LLMResponse | `packages/agent-core/src/state/types.ts` / `packages/agent-core/src/llm/types.ts` | runtime message + response shape | ✅ 当前实现 |

### 5.2 完整接口定义

```python
# quilin/core/llm.py — 完整 Protocol 定义（伪代码）

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, AsyncIterator, Protocol, TypeVar

import litellm
from pydantic import BaseModel, ValidationError

from quilin.core.messages import LLMResponse, Message, ToolCall

T = TypeVar("T", bound=BaseModel)

# ─────────────────────────────────────────────
# ThinkingMode
# ─────────────────────────────────────────────

class ThinkingMode(str, Enum):
    """推理深度控制（GLM-5.1 三模式设计）。"""
    OFF         = "off"
    INTERLEAVED = "interleaved"
    PRESERVED   = "preserved"


# ─────────────────────────────────────────────
# InferenceConfig
# ─────────────────────────────────────────────

@dataclass(frozen=True)
class InferenceConfig:
    """LLM 单次调用参数（不可变，按需 replace 派生新配置）。"""
    temperature:     float        = 0.0
    max_tokens:      int          = 4096
    thinking_mode:   ThinkingMode = ThinkingMode.INTERLEAVED
    thinking_budget: int          = 2000
    timeout_s:       float        = 30.0
    stream_thinking: bool         = False
    retry_max:       int          = 3
    retry_base_s:    float        = 1.0

    def replace(self, **kwargs) -> InferenceConfig:
        return replace(self, **kwargs)


# 类级预设（在类定义后赋值，Python dataclass 惯用法）
InferenceConfig.QUICK    = ...  # OFF, max_tokens=512, timeout=10s
InferenceConfig.STANDARD = ...  # INTERLEAVED, max_tokens=4096, timeout=30s
InferenceConfig.DEEP     = ...  # PRESERVED, max_tokens=16384, timeout=120s


# ─────────────────────────────────────────────
# 回调 Protocol
# ─────────────────────────────────────────────

class LLMCallbackHandler(Protocol):
    async def on_llm_start(self, messages: list[Message], config: InferenceConfig) -> None: ...
    async def on_llm_end(self, response: LLMResponse, elapsed_s: float) -> None: ...
    async def on_llm_error(self, error: Exception, attempt: int) -> None: ...


# ─────────────────────────────────────────────
# LLMClient Protocol
# ─────────────────────────────────────────────

class LLMClient(Protocol):
    async def chat(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None = None,
        config: InferenceConfig = InferenceConfig.STANDARD,
    ) -> LLMResponse: ...

    async def chat_stream(
        self,
        messages: list[Message],
        config: InferenceConfig = InferenceConfig.STANDARD,
    ) -> AsyncIterator[str]: ...

    async def chat_structured(
        self,
        messages: list[Message],
        output_cls: type[T],
        config: InferenceConfig = InferenceConfig.STANDARD,
    ) -> T: ...

    def count_tokens(self, messages: list[Message]) -> int: ...

    def add_callback(self, handler: LLMCallbackHandler) -> None: ...


# ─────────────────────────────────────────────
# 错误类型
# ─────────────────────────────────────────────

class LLMError(Exception):
    """LLM 调用基础异常。"""

class LLMTimeoutError(LLMError):
    """调用超时（所有重试耗尽）。"""

class LLMRateLimitError(LLMError):
    """速率限制（所有重试耗尽）。"""

class LLMStructuredOutputError(LLMError):
    """结构化输出验证失败（所有重试耗尽）。"""
```

### 5.3 错误处理策略

```
错误类型          重试策略                      降级策略
──────────────────────────────────────────────────────────
RateLimitError    指数退避（1s, 2s, 4s）最多 3 次   超出后切换 fallback 模型
APITimeoutError   指数退避，最多 3 次               超出后切换 fallback 模型
APIConnectionError 立即重试，最多 2 次              超出后切换 fallback 模型
ValidationError   Error-Augmented 重试，最多 3 次   超出后抛出 LLMStructuredOutputError
AuthenticationError 不重试，直接抛出               检查 API key 配置
InvalidRequestError 不重试，直接抛出              检查参数/模型名称

fallback 触发条件：
  - 主模型连续失败 retry_max 次
  - 切换到 config["llm"]["fallback"]["model"]
  - 记录 on_llm_error 回调，触发可观测性告警
  - fallback 也失败 → 抛出 LLMError，Harness 决策层处理
```

### 5.4 性能约束

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 首 token 延迟（本地模型） | < 500ms | vLLM / Ollama 本地部署 |
| 首 token 延迟（云端 API） | < 2s | OpenAI / Anthropic / GLM 等 |
| 流式输出 | token-by-token | `chat_stream()` 逐 token yield |
| 并发支持 | 无限制（asyncio） | 底层 vLLM 连续批处理支撑并发 |
| `count_tokens()` 延迟 | < 10ms | 本地 tiktoken 计算，无网络调用 |
| 重试总超时 | max(timeout_s) × retry_max | QUICK: 30s, STANDARD: 90s, DEEP: 360s |

---

## 六、验证标准

### 6.1 单元测试

```python
# tests/core/test_llm.py

# ── ThinkingMode ──────────────────────────────────────────────────────
# TC-01: ThinkingMode.OFF 时不传递 thinking 参数给 litellm
# TC-02: ThinkingMode.INTERLEAVED 时传递 thinking_budget
# TC-03: ThinkingMode.PRESERVED 时传递 preserve=True（或模型对应参数）
# TC-04: 切换 ThinkingMode 不影响其他 InferenceConfig 字段

# ── InferenceConfig ───────────────────────────────────────────────────
# TC-05: InferenceConfig.QUICK 默认值校验（temperature=0.0, max_tokens=512 等）
# TC-06: InferenceConfig.STANDARD 默认值校验
# TC-07: InferenceConfig.DEEP 默认值校验
# TC-08: replace() 不可变性 — 原始 config 不被修改
# TC-09: replace() 正确覆盖指定字段

# ── LLMClient.chat() ──────────────────────────────────────────────────
# TC-10: mock litellm.acompletion，验证返回 LLMResponse 结构正确
# TC-11: tool_calls 正确解析为 tuple[ToolCall, ...] 对象
# TC-12: usage 字段包含 prompt/completion/thinking/total 四个 key
# TC-13: tools=None 时不传递 tools 参数给 litellm

# ── count_tokens ──────────────────────────────────────────────────────
# TC-14: 空消息列表返回 0
# TC-15: 单条 user 消息 token 数在合理范围内（tiktoken 结果校验）
# TC-16: 相同内容的消息 token 数幂等（多次调用结果一致）

# ── 回调钩子 ─────────────────────────────────────────────────────────
# TC-17: 正常调用触发 on_llm_start → on_llm_end（on_llm_error 不触发）
# TC-18: 调用失败触发 on_llm_error（包含正确的 attempt 编号）
# TC-19: 多个 callback handler 均被触发

# ── 重试逻辑 ─────────────────────────────────────────────────────────
# TC-20: RateLimitError 触发指数退避重试（mock asyncio.sleep 验证 delay）
# TC-21: retry_max 耗尽后抛出 LLMRateLimitError
# TC-22: 第 2 次重试成功 → 正常返回响应
```

### 6.2 集成测试

```python
# tests/integration/test_llm_integration.py

# ── litellm + 真实 API ─────────────────────────────────────────────────
# IT-01: litellm + OpenAI API 端到端（需要 OPENAI_API_KEY 环境变量）
#        发送 "Say hello." → 响应包含 hello 相关内容
# IT-02: litellm + Anthropic API 端到端（需要 ANTHROPIC_API_KEY）
#        验证 provider 差异被正确归一化

# ── litellm + 本地 Ollama ──────────────────────────────────────────────
# IT-03: 本地 Ollama 端到端（需要本地 Ollama 服务运行）
#        config: model="ollama/qwen3:7b", api_base="http://localhost:11434"
#        发送简单问题 → 正确响应

# ── 流式输出 ─────────────────────────────────────────────────────────
# IT-04: chat_stream() AsyncIterator 完整性
#        收集所有 chunks → 拼接结果与 chat() 响应内容语义一致
# IT-05: 流式输出中思考 token 默认不暴露（stream_thinking=False）
# IT-06: stream_thinking=True 时思考 token 正确推送

# ── 工具调用 ─────────────────────────────────────────────────────────
# IT-07: 传入 1 个 tool schema → 模型返回 tool_calls → 正确解析为 ToolCall 对象
# IT-08: 工具调用跨多轮对话（tool_result 正确回填）

# ── ThinkingMode 集成 ─────────────────────────────────────────────────
# IT-09: ThinkingMode.INTERLEAVED 时 usage 包含 thinking_tokens > 0
# IT-10: ThinkingMode.OFF 时 usage 中 thinking_tokens == 0

# ── 错误处理集成 ──────────────────────────────────────────────────────
# IT-11: 无效 API key → 抛出 LLMError（不重试）
# IT-12: fallback 模型切换（主模型超时 → 切换本地 Ollama）
```

### 6.3 端到端验证

```bash
# E2E-01: 基础问答
python -m quilin "What is 2+2?"
# 期望：LLMClient 调用模型 → 响应包含 "4" → 正确退出

# E2E-02: 工具调用端到端
python -m quilin "List files in the current directory"
# 期望：LLMClient 返回 tool_call(bash, {command: "ls"})
#        → ToolRouter 执行 → 结果回填 → 最终响应包含文件列表

# E2E-03: ThinkingMode 验证
QUILIN_THINKING_MODE=deep python -m quilin "Explain the P vs NP problem"
# 期望：usage.thinking_tokens > 1000 → 响应质量明显更高

# E2E-04: 流式输出验证
python -m quilin --stream "Write a haiku about AI"
# 期望：逐字输出，无卡顿，最终内容完整

# E2E-05: 本地模型回退
OPENAI_API_KEY=invalid python -m quilin "Hello"
# 期望：主模型失败 → 自动切换 Ollama fallback → 正常响应（需本地 Ollama 运行）

# E2E-06: Token 计数报告
python -m quilin --show-usage "What is the capital of France?"
# 期望：输出 usage = {prompt_tokens: N, completion_tokens: M, thinking_tokens: K}
```

---

*文档版本：v1.0 | 撰写日期：2026-04-13 | 对应实现文件：`quilin/core/llm.py`*
