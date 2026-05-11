# 融合索引（Fusion Index）

> 标注每个功能的来源项目、commit、相关代码路径，便于上游更新时同步跟进。
>
> 最近更新：2026-04-14（历史种子快照）
>
> **状态（2026-05-01 校准）**：本文是 upstream fusion 的初始 watchlist，不再表达 Quilin 当前实现进度。表中的 `📋 / 👀` 是 2026-04-14 的候选吸收状态；Phase / Iter 实现进度以 [`../STATUS.md`](../STATUS.md) 与各组件 README 顶部状态块为准。
>
> **注意**：ADR-001 已决策核心语言为 TypeScript（详见 [Core Loop](../00-core-loop/README.md)）。本文档中的参考代码路径指向上游项目源码，不是 Quilin 的实现路径。

## 索引说明

- 状态：📋 规划中 | 🔄 吸收中 | ✅ 已内化 | 👀 观察中
- 深度：深入（前 3-5）| 观察（后 5-7）
- 版本/Commit 记录参考时的具体版本，用于上游更新时做 diff 对比
- 首次创建时，所有"深入"项目状态为 📋 规划中，"观察"项目为 👀 观察中；这些状态现在只代表历史初始队列，不代表当前已实现 / 未实现清单。

## 统计概览

> **历史快照说明**：下表保留 2026-04-14 初始统计，未随后续 Iter A/B/C/M/D/E 实现逐项回填。不要用这里的"已内化 0"判断当前代码状态。

| 领域 | 深入项目 | 观察项目 | 功能点总数 | 已内化 | 规划中 |
|------|---------|---------|-----------|--------|--------|
| 01 LLM 接入 | 5 | 5 | 16 | 0 | 11 |
| 02 上下文 | 5 | 5 | 15 | 0 | 10 |
| 03 记忆 | 5 | 5 | 15 | 0 | 10 |
| 04 规划 | 5 | 5 | 15 | 0 | 10 |
| 05 工具 | 5 | 5 | 15 | 0 | 10 |
| 06 多 Agent | 5 | 5 | 13 | 0 | 8 |
| 07 安全护栏 | 5 | 5 | 16 | 0 | 11 |
| 08 可观测性 | 5 | 5 | 14 | 0 | 9 |
| 09 部署运行时 | 5 | 5 | 15 | 0 | 10 |
| 10 自进化 | 5 | 5 | 16 | 0 | 11 |
| 11 Agent Mesh | 5 | 6 | 15 | 0 | 9 |
| 13 技能工程 | 4 | — | 5 | 0 | 5 |
| **合计** | **59** | **56** | **170** | **0** | **114** |

> 说明：12 对话工程的上游监控尚未录入（计划随 Phase 2 落地补齐）。13 技能工程的深入项目来自四仓库研究（Claude Code / Hermes / OpenClaw / Codex）。

> 说明：功能点总数 = 深入功能点数 + 观察项目数（每个观察项目计 1 行）。规划中仅含深入功能点；观察项目均为 👀 观察中（不计入规划中）。

---

## 01 — LLM 接入

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| provider 归一化与 acompletion 异步调用 | litellm | latest (2026-04) | `github.com/BerriAI/litellm` → `litellm/main.py` | 📋 | 深入 |
| `drop_params` 全局开关（参数自动裁剪） | litellm | latest (2026-04) | `github.com/BerriAI/litellm` → `litellm/utils.py` | 📋 | 深入 |
| 模型别名映射与内建 fallbacks 回退链 | litellm | latest (2026-04) | `github.com/BerriAI/litellm` → `litellm/router.py` | 📋 | 深入 |
| 回调钩子设计（on_llm_start/end/error） | LangChain | latest (2026-04) | `github.com/langchain-ai/langchain` → `langchain_core/callbacks/` | 📋 | 深入 |
| InMemoryCache 响应缓存策略 | LangChain | latest (2026-04) | `github.com/langchain-ai/langchain` → `langchain_core/caches/` | 📋 | 深入 |
| 结构化输出 PydanticOutputParser 错误反馈重试 | LlamaIndex | latest (2026-04) | `github.com/run-llama/llama_index` → `llama_index/core/output_parsers/` | 📋 | 深入 |
| 指数退避重试（RetryCallable） | LlamaIndex | latest (2026-04) | `github.com/run-llama/llama_index` → `llama_index/core/llms/utils.py` | 📋 | 深入 |
| 本地部署 AsyncEngine 对接模式（OpenAI 兼容 API） | vLLM | latest (2026-04) | `github.com/vllm-project/vllm` → `vllm/entrypoints/openai/` | 📋 | 深入 |
| 连续批处理对并发 LLM 调用设计的启发 | vLLM | latest (2026-04) | `github.com/vllm-project/vllm` → `vllm/core/scheduler.py` | 📋 | 深入 |
| RadixAttention 前缀 KV 缓存复用策略（Prompt Caching 对齐） | SGLang | latest (2026-04) | `github.com/sgl-project/sglang` → `sglang/srt/managers/radix_cache.py` | 📋 | 深入 |
| system prompt 固定前缀规范（最大化 prompt cache 命中） | SGLang | latest (2026-04) | `github.com/sgl-project/sglang` → `sglang/lang/interpreter.py` | 📋 | 深入 |
| 本地模型 fallback 对接（开发环境快速切换） | Ollama | latest (2026-04) | `github.com/ollama/ollama` | 👀 | 观察 |
| 整体观察（Pipeline 式 LLM 编排） | Haystack | latest (2026-04) | `github.com/deepset-ai/haystack` | 👀 | 观察 |
| 整体观察（生产推理服务参考） | TGI | latest (2026-04) | `github.com/huggingface/text-generation-inference` | 👀 | 观察 |
| 整体观察（模型服务化动态批处理） | BentoML | latest (2026-04) | `github.com/bentoml/BentoML` | 👀 | 观察 |
| 整体观察（Apple Silicon 本地推理） | MLX | latest (2026-04) | `github.com/ml-explore/mlx` | 👀 | 观察 |

---

## 02 — 上下文

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| 三类消息模型设计（System/Human/AI Message） | LangChain | latest (2026-04) | `github.com/langchain-ai/langchain` → `langchain_core/messages/` | 📋 | 深入 |
| MessagesPlaceholder 模板结构与运行时数据解耦 | LangChain | latest (2026-04) | `github.com/langchain-ai/langchain` → `langchain_core/prompts/chat.py` | 📋 | 深入 |
| 句子边界分块与 top-K 相关片段召回（SentenceSplitter） | LlamaIndex | latest (2026-04) | `github.com/run-llama/llama_index` → `llama_index/core/node_parser/` | 📋 | 深入 |
| 多记忆片段 Refine 策略合并（减少冗余） | LlamaIndex | latest (2026-04) | `github.com/run-llama/llama_index` → `llama_index/core/response_synthesizers/` | 📋 | 深入 |
| 签名式声明式 Prompt 编程（Signature/Module） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/signatures/` | 📋 | 深入 |
| 自动 Prompt 优化（Teleprompter/BootstrapFewShot） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/teleprompt/` | 📋 | 深入 |
| 双占位符机制（变量注入 + 函数内联） | Semantic Kernel | latest (2026-04) | `github.com/microsoft/semantic-kernel` → `python/semantic_kernel/prompt_template/` | 📋 | 深入 |
| 多后端记忆存储设计（开发/生产切换） | Semantic Kernel | latest (2026-04) | `github.com/microsoft/semantic-kernel` → `python/semantic_kernel/memory/` | 📋 | 深入 |
| Pydantic 驱动结构化输出约束 + 错误反馈重试 | Instructor | latest (2026-04) | `github.com/567-labs/instructor` → `instructor/patch.py` | 📋 | 深入 |
| ValidationError 构造新上下文触发重试（错误信息驱动上下文增强） | Instructor | latest (2026-04) | `github.com/567-labs/instructor` → `instructor/retry.py` | 📋 | 深入 |
| 整体观察（Pipeline 式上下文组装 + RAG） | Haystack | latest (2026-04) | `github.com/deepset-ai/haystack` | 👀 | 观察 |
| 整体观察（多角色对话上下文管理） | AutoGen | latest (2026-04) | `github.com/microsoft/autogen` | 👀 | 观察 |
| 整体观察（角色+任务 prompt 模板） | CrewAI | latest (2026-04) | `github.com/crewAIInc/crewAI` | 👀 | 观察 |
| 整体观察（类型安全 prompt + 依赖注入式上下文） | PydanticAI | latest (2026-04) | `github.com/pydantic/pydantic-ai` | 👀 | 观察 |
| 整体观察（约束解码 + token 级别模板控制） | Guidance | latest (2026-04) | `github.com/guidance-ai/guidance` | 👀 | 观察 |

---

## 03 — 记忆

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| 三级记忆范围独立管理（用户级/Agent 级/会话级） | Mem0 | latest (2026-04) | `github.com/mem0ai/mem0` → `mem0/memory/main.py` | 📋 | 深入 |
| 冲突检测与自适应更新（避免记忆矛盾并存） | Mem0 | latest (2026-04) | `github.com/mem0ai/mem0` → `mem0/memory/storage.py` | 📋 | 深入 |
| 混合存储架构（向量 + 图 + 键值三套协同） | Mem0 | latest (2026-04) | `github.com/mem0ai/mem0` → `mem0/vector_stores/` | 📋 | 深入 |
| Episode → 实体抽取 → 关系建立 → 时序标注流水线 | Graphiti | latest (2026-04) | `github.com/getzep/graphiti` → `graphiti_core/` | 📋 | 深入 |
| 时序知识图谱（valid_from/valid_until 时效性标注） | Graphiti | latest (2026-04) | `github.com/getzep/graphiti` → `graphiti_core/edges.py` | 📋 | 深入 |
| Working Memory 分页管理启发（Block 系统 → 自动 FIFO） | Letta | latest (2026-04) | `github.com/letta-ai/letta` → `letta/memory.py` | 📋 | 深入 |
| 记忆作为 LangGraph 状态图持久化 Checkpoint | LangMem | latest (2026-04) | `github.com/langchain-ai/langmem` → `langmem/` | 📋 | 深入 |
| Memory Manager 节点（程序性记忆/Agent 自修改行为规则） | LangMem | latest (2026-04) | `github.com/langchain-ai/langmem` → `langmem/memory_manager.py` | 📋 | 深入 |
| 向量相似度 + KG 子图匹配 + Reranking 三阶段混合检索 | Cognee | latest (2026-04) | `github.com/topoteretes/cognee` → `cognee/api/v1/search/` | 📋 | 深入 |
| Memify 反馈回路（使用评分更新知识节点权重） | Cognee | latest (2026-04) | `github.com/topoteretes/cognee` → `cognee/modules/graph/` | 📋 | 深入 |
| 整体观察（反思驱动记忆，retain/recall/reflect 三核操作） | Hindsight | latest (2026-04) | `github.com/vectorize-io/hindsight` | 👀 | 观察 |
| 整体观察（零 schema 自动事实提取） | Zep | latest (2026-04) | `github.com/getzep/zep` | 👀 | 观察 |
| 整体观察（空间记忆宫殿层次化组织） | MemPalace | latest (2026-04) | `github.com/milla-jovovich/mempalace` | 👀 | 观察 |
| 整体观察（统一记忆 API / MCP Server 接口） | SuperMemory | latest (2026-04) | `github.com/supermemoryai/supermemory` | 👀 | 观察 |
| 整体观察（轻量高精度记忆操作系统） | AgentMemory | latest (2026-04) | `github.com/JordanMcCann/agentmemory` | 👀 | 观察 |

---

## 04 — 规划

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| 状态图（StateGraph）显式状态机与条件边路由 | LangGraph | latest (2026-04) | `github.com/langchain-ai/langgraph` → `langgraph/graph/state.py` | 📋 | 深入 |
| 检查点持久化（MemorySaver/SqliteSaver）与中断恢复 | LangGraph | latest (2026-04) | `github.com/langchain-ai/langgraph` → `langgraph/checkpoint/` | 📋 | 深入 |
| 策略可编程化（Strategy 枚举 + 配置矩阵驱动） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/predict/` | 📋 | 深入 |
| 意图分类 Signature 化（Predict 模块 + BootstrapFewShot 自动优化） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/teleprompt/bootstrap.py` | 📋 | 深入 |
| Runner 循环简洁性（while + state transition 模式） | OpenAI Agents SDK | latest (2026-04) | `github.com/openai/openai-agents-python` → `src/agents/run.py` | 📋 | 深入 |
| Handoff 任务转交声明式设计（上下文自动传递） | OpenAI Agents SDK | latest (2026-04) | `github.com/openai/openai-agents-python` → `src/agents/handoffs.py` | 📋 | 深入 |
| 工具定义类型安全（Pydantic 模型约束工具输入输出） | Pydantic AI | latest (2026-04) | `github.com/pydantic/pydantic-ai` → `pydantic_ai/tools.py` | 📋 | 深入 |
| 依赖注入模式（RunContext[Dependencies]，便于测试替换） | Pydantic AI | latest (2026-04) | `github.com/pydantic/pydantic-ai` → `pydantic_ai/dependencies.py` | 📋 | 深入 |
| 多轮对话历史完整保存与规划循环 | AutoGen | latest (2026-04) | `github.com/microsoft/autogen` → `autogen/agentchat/conversable_agent.py` | 📋 | 深入 |
| 执行验证循环（每步执行后对照预期验证，不符则重规划） | AutoGen | latest (2026-04) | `github.com/microsoft/autogen` → `autogen/coding/` | 📋 | 深入 |
| 整体观察（Role-based planning / 角色+任务+流程编排） | CrewAI | latest (2026-04) | `github.com/crewAIInc/crewAI` | 👀 | 观察 |
| 整体观察（Planner + Stepwise 规划） | Semantic Kernel | latest (2026-04) | `github.com/microsoft/semantic-kernel` | 👀 | 观察 |
| 整体观察（蒙特卡洛树搜索规划） | LATS | latest (2026-04) | `github.com/lapisrocks/LanguageAgentTreeSearch` | 👀 | 观察 |
| 整体观察（LLM 作为 Controller 的模型选择即规划） | HuggingGPT (JARVIS) | latest (2026-04) | `github.com/microsoft/JARVIS` | 👀 | 观察 |
| 整体观察（SOP 驱动规划） | MetaGPT | latest (2026-04) | `github.com/geekan/MetaGPT` | 👀 | 观察 |

---

## 05 — 工具

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| MCPClient 三步调用模式（initialize + list_tools + call_tool） | MCP SDK | latest (2026-04) | `github.com/modelcontextprotocol/python-sdk` → `src/mcp/client/session.py` | 📋 | 深入 |
| stdio/SSE 双 transport 支持与 MCPToolAdapter 封装 | MCP SDK | latest (2026-04) | `github.com/modelcontextprotocol/python-sdk` → `src/mcp/client/` | 📋 | 深入 |
| 混合 DOM + Vision 策略与会话管理（storage_state 持久化） | browser-use | latest (2026-04) | `github.com/browser-use/browser-use` → `browser_use/browser/context.py` | 📋 | 深入 |
| 内置 TOTP 2FA 与 keep_alive 跨任务复用 | browser-use | latest (2026-04) | `github.com/browser-use/browser-use` → `browser_use/browser/browser.py` | 📋 | 深入 |
| A11y Tree 访问（page.accessibility.snapshot()，节省 60-80% token） | Playwright | latest (2026-04) | `github.com/microsoft/playwright` → `playwright/async_api/_generated.py` | 📋 | 深入 |
| BrowserContext.storage_state 标准 Cookie/Storage 导出 | Playwright | latest (2026-04) | `github.com/microsoft/playwright` → `playwright/async_api/` | 📋 | 深入 |
| 异步批量爬取（arun_many）与 LLM 友好 Markdown 输出 | Crawl4AI | latest (2026-04) | `github.com/unclecode/crawl4ai` → `crawl4ai/async_webcrawler.py` | 📋 | 深入 |
| SQLite 内置缓存（CacheMode，相同 URL 不重复请求） | Crawl4AI | latest (2026-04) | `github.com/unclecode/crawl4ai` → `crawl4ai/cache_context.py` | 📋 | 深入 |
| act/extract/observe 三步式 AI 原生浏览器操作 API | Stagehand | latest (2026-04) | `github.com/browserbase/stagehand` → `lib/` | 📋 | 深入 |
| Browserbase Contexts 云端持久化会话（context.persist: true） | Stagehand | latest (2026-04) | `github.com/browserbase/stagehand` → `lib/browserbase.ts` | 📋 | 深入 |
| 整体观察（网页结构化数据提取 + /agent 端点） | Firecrawl | latest (2026-04) | `github.com/firecrawl/firecrawl` | 👀 | 观察 |
| 整体观察（Anthropic 屏幕级操作参考实现） | Computer Use Demo | latest (2026-04) | `github.com/anthropics/anthropic-quickstarts` | 👀 | 观察 |
| 整体观察（语义搜索 API，神经网络链接预测） | exa-py | latest (2026-04) | `github.com/exa-labs/exa-py` | 👀 | 观察 |
| 整体观察（Agent 优化搜索，LangChain 集成） | Tavily | latest (2026-04) | `github.com/tavily-ai/tavily-python` | 👀 | 观察 |
| 整体观察（搜索引擎结构化数据，40+ 引擎） | SerpAPI | latest (2026-04) | `github.com/serpapi/google-search-results-python` | 👀 | 观察 |

---

## 06 — 多 Agent

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| ConversableAgent 对话循环（is_termination_msg 终止条件） | AutoGen | latest (2026-04) | `github.com/microsoft/autogen` → `autogen/agentchat/conversable_agent.py` | 📋 | 深入 |
| GroupChat speaker_selection 机制（round_robin/auto/custom） | AutoGen | latest (2026-04) | `github.com/microsoft/autogen` → `autogen/agentchat/groupchat.py` | 📋 | 深入 |
| 角色定义三要素（role/goal/backstory） | CrewAI | latest (2026-04) | `github.com/crewAIInc/crewAI` → `crewai/agent.py` | 📋 | 深入 |
| 任务委托机制（delegation=True）与 Process.hierarchical 层级编排 | CrewAI | latest (2026-04) | `github.com/crewAIInc/crewAI` → `crewai/crew.py` | 📋 | 深入 |
| Command(goto, update) 路由模式与 MessagesState 共享消息历史 | LangGraph | latest (2026-04) | `github.com/langchain-ai/langgraph` → `langgraph/graph/state.py` | 📋 | 深入 |
| Handoff 声明式设计（Agent 声明 handoffs 列表，上下文自动传递） | OpenAI Agents SDK | latest (2026-04) | `github.com/openai/openai-agents-python` → `src/agents/agent.py` | 📋 | 深入 |
| SOP 工作流映射（Role/Action/Environment 三层架构） | MetaGPT | latest (2026-04) | `github.com/geekan/MetaGPT` → `metagpt/roles/` | 📋 | 深入 |
| Action 产出文档的中间传递模式（Environment 共享消息板） | MetaGPT | latest (2026-04) | `github.com/geekan/MetaGPT` → `metagpt/environment/` | 📋 | 深入 |
| 整体观察（Orchestrator 动态选 Agent + 任务进度跟踪） | Magentic-One | latest (2026-04) | `github.com/microsoft/autogen/tree/main/python/packages/autogen-magentic-one` | 👀 | 观察 |
| 整体观察（A2A 协议规范：Agent Card / Task / Artifact） | Google A2A | latest (2026-04) | `github.com/google/a2a` | 👀 | 观察 |
| 整体观察（角色扮演通信框架，思维链传递） | CAMEL | latest (2026-04) | `github.com/camel-ai/camel` | 👀 | 观察 |
| 整体观察（软件公司组织映射多 Agent） | ChatDev | latest (2026-04) | `github.com/OpenBMB/ChatDev` | 👀 | 观察 |
| 整体观察（Agent 间工具共享与通信拓扑定义） | Agency Swarm | latest (2026-04) | `github.com/VRSEN/agency-swarm` | 👀 | 观察 |

---

## 07 — 安全护栏

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| Guard + Validator 组合模式（链式多 Validator 串联） | Guardrails AI | v0.10.0 (2026-04) | `github.com/guardrails-ai/guardrails` → `guardrails/guard.py` | 📋 | 深入 |
| `reask` 机制（验证失败时将错误反馈给 LLM 要求重新生成） | Guardrails AI | v0.10.0 (2026-04) | `github.com/guardrails-ai/guardrails` → `guardrails/validators/` | 📋 | 深入 |
| on_fail 策略（exception/fix/reask/noop 四种失败策略） | Guardrails AI | v0.10.0 (2026-04) | `github.com/guardrails-ai/guardrails` → `guardrails/run/` | 📋 | 深入 |
| Colang 声明式安全策略语言（事件驱动 DSL） | NeMo Guardrails | latest (2026-04) | `github.com/NVIDIA-NeMo/Guardrails` → `nemoguardrails/colang/` | 📋 | 深入 |
| 并行 Rails 执行（IORails，多安全检查并行降低延迟） | NeMo Guardrails | latest (2026-04) | `github.com/NVIDIA-NeMo/Guardrails` → `nemoguardrails/rails/llm/` | 📋 | 深入 |
| 推理链守护（对 Chain of Thought 中间思考过程应用 Rails） | NeMo Guardrails | latest (2026-04) | `github.com/NVIDIA-NeMo/Guardrails` → `nemoguardrails/actions/` | 📋 | 深入 |
| InputScanner/OutputScanner 模块化扫描器（独立可组合） | LLM Guard | latest (2026-04) | `github.com/protectai/llm-guard` → `llm_guard/input_scanners/` | 📋 | 深入 |
| Vault 匿名化机制（Anonymize → 内部处理 → Deanonymize） | LLM Guard | latest (2026-04) | `github.com/protectai/llm-guard` → `llm_guard/input_scanners/anonymize.py` | 📋 | 深入 |
| 三分类注入检测（直接注入/间接注入/正常指令 + Source-aware 分类） | Lakera Guard | latest (2026-04) | `api.lakera.ai/v2/guard` | 📋 | 深入 |
| Analyzer → Anonymizer 两阶段 PII 流水线 | Presidio | v2.2.362 (2026-03) | `github.com/microsoft/presidio` → `presidio_analyzer/` | 📋 | 深入 |
| 多种脱敏算子（replace/mask/hash/encrypt/redact，随机盐 Hash） | Presidio | v2.2.362 (2026-03) | `github.com/microsoft/presidio` → `presidio_anonymizer/operators/` | 📋 | 深入 |
| 整体观察（4 层 Prompt Injection 防御 + 金丝雀词检测） | Rebuff | v0.1.1 | `github.com/protectai/rebuff` | 👀 | 观察 |
| 整体观察（86M 轻量分类器，Jailbreak/Injection 两类） | Llama Prompt Guard 2 | latest (2026-04) | `meta-llama/Llama-Prompt-Guard-2-86M` | 👀 | 观察 |
| 整体观察（多模态安全分类，图像+文本） | ShieldGemma | latest (2026-04) | `google/shieldgemma-2-4b-it` | 👀 | 观察 |
| 整体观察（LLM 输出质量监控与情感分析） | LangKit | latest (2026-04) | `github.com/whylabs/langkit` | 👀 | 观察 |
| 整体观察（LLM 漏洞扫描器 / 红队自动化，100+ 攻击探针） | Garak | v0.14.0 | `github.com/NVIDIA/garak` | 👀 | 观察 |

---

## 08 — 可观测性

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| Trace/Generation/Span/Score 数据模型（LLM 调用语义化建模） | Langfuse | latest (2026-04) | `github.com/langfuse/langfuse` → `packages/shared/src/server/` | 📋 | 深入 |
| Langfuse Generation 字段映射（cost/tokens/model/input/output） | Langfuse | latest (2026-04) | `github.com/langfuse/langfuse` → `packages/python/langfuse/` | 📋 | 深入 |
| Instrumentor 自动埋点模式（import 时自动 patch LLM 库） | OpenLLMetry | latest (2026-04) | `github.com/traceloop/openllmetry` → `packages/opentelemetry-instrumentation-openai/` | 📋 | 深入 |
| ObservabilityMiddleware 业务代码无感知注入 Span | OpenLLMetry | latest (2026-04) | `github.com/traceloop/openllmetry` → `packages/traceloop-sdk/` | 📋 | 深入 |
| 评估框架（Evaluator 为每个 Span 提供量化评分） | Arize Phoenix | latest (2026-04) | `github.com/Arize-ai/phoenix` → `src/phoenix/evals/` | 📋 | 深入 |
| RunTree 树状 Span 数据结构与时间线可视化（Gantt 风格） | LangSmith | latest (2026-04) | `github.com/langchain-ai/langsmith-sdk` → `python/langsmith/` | 📋 | 深入 |
| 单步重放调试（trace_id + span_id 重新执行验证修复效果） | LangSmith | latest (2026-04) | `github.com/langchain-ai/langsmith-sdk` → `python/langsmith/run_trees.py` | 📋 | 深入 |
| Agent 专用 Span 类型（session/agent/operation/workflow） | AgentOps | latest (2026-04) | `github.com/AgentOps-AI/agentops` → `agentops/` | 📋 | 深入 |
| 任务级指标体系（step_count/tool_usage/cost_per_step/success_rate） | AgentOps | latest (2026-04) | `github.com/AgentOps-AI/agentops` → `agentops/client.py` | 📋 | 深入 |
| 整体观察（代理层语义缓存 + 按用户/模型维度成本分摊） | Helicone | latest (2026-04) | `github.com/Helicone/helicone` | 👀 | 观察 |
| 整体观察（实验对比 + CI 回归检测） | Braintrust | latest (2026-04) | `braintrustdata.com` | 👀 | 观察 |
| 整体观察（@weave.op 装饰器自动追踪，W&B 生态） | Weave | latest (2026-04) | `github.com/wandb/weave` | 👀 | 观察 |
| 整体观察（开源 GenAI 监控 + 聊天回放） | Lunary | latest (2026-04) | `github.com/lunary-ai/lunary` | 👀 | 观察 |
| 整体观察（细粒度 OTel instrumentation 分包按需引入） | OpenLLMetry SDK (分离版) | latest (2026-04) | `github.com/traceloop/openllmetry` | 👀 | 观察 |

---

## 09 — 部署运行时

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| Sandbox API 设计（run_code/files.read/files.write，有状态执行） | E2B | latest (2026-04) | `github.com/e2b-dev/code-interpreter` → `python/e2b_code_interpreter/` | 📋 | 深入 |
| Jupyter Kernel 有状态执行（变量跨调用保持） | E2B | latest (2026-04) | `github.com/e2b-dev/code-interpreter` → `python/e2b_code_interpreter/main.py` | 📋 | 深入 |
| Image 预构建 + 缓存机制（避免每次重建安装依赖） | Modal | latest (2026-04) | `modal.com` → `modal/image.py` | 📋 | 深入 |
| Volume 持久化存储（跨函数调用共享数据，commit/reload 显式同步） | Modal | latest (2026-04) | `modal.com` → `modal/volume.py` | 📋 | 深入 |
| Snapshot 机制（预制环境 + 秒级恢复）与 Sandbox Daemon（Toolbox API） | Daytona | latest (2026-04) | `github.com/daytonaio/daytona` → `pkg/api/` | 📋 | 深入 |
| MCP 原生集成（沙箱操作通过 MCP 协议暴露） | Daytona | latest (2026-04) | `github.com/daytonaio/daytona` → `pkg/mcp/` | 📋 | 深入 |
| 容器安全加固参数（read_only/cap_drop/pids_limit/network_mode） | Docker SDK (docker-py) | latest (2026-04) | `github.com/docker/docker-py` → `docker/api/container.py` | 📋 | 深入 |
| exec_run demux=True 分离 stdout/stderr 流 | Docker SDK (docker-py) | latest (2026-04) | `github.com/docker/docker-py` → `docker/models/containers.py` | 📋 | 深入 |
| 预创建 + 延迟启动模式（SandboxPool 预热，300ms 冷启动目标） | Fly.io Machines | latest (2026-04) | `fly.io/docs/machines/api/` | 📋 | 深入 |
| Suspend/Resume 快照（长会话沙箱状态保存，< 100ms resume） | Fly.io Machines | latest (2026-04) | `fly.io/docs/machines/api/` | 📋 | 深入 |
| 整体观察（MicroVM 基础技术，< 125ms 启动，5MB 内存/VM） | Firecracker | latest (2026-04) | `github.com/firecracker-microvm/firecracker` | 👀 | 观察 |
| 整体观察（用户态内核沙箱，拦截所有系统调用） | gVisor | latest (2026-04) | `github.com/google/gvisor` | 👀 | 观察 |
| 整体观察（OCI 兼容容器运行时，轻量 VM 替代 namespace 隔离） | Kata Containers | latest (2026-04) | `github.com/kata-containers/kata-containers` | 👀 | 观察 |
| 整体观察（进程级 Linux 沙箱，seccomp-bpf + namespace） | Nsjail | latest (2026-04) | `github.com/google/nsjail` | 👀 | 观察 |
| 整体观察（macOS 内核级访问控制 / 开发环境安全增强） | Seatbelt (macOS) | latest (2026-04) | `man sandbox-exec` | 👀 | 观察 |

---

## 10 — 自进化

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| 签名式 Prompt 模块化（功能区分离为独立签名，精准定位优化目标） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/signatures/` | 📋 | 深入 |
| BootstrapFewShot（从成功轨迹自动提取高质量少样本示例） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/teleprompt/bootstrap.py` | 📋 | 深入 |
| ~~MIPROv2 贝叶斯搜索~~（2026-05-12 已弃用，由 GEPA 取代；详见 [README §2.4](./README.md#stage-d-outcome--dspy--gepa-as-the-singular-optimizer-2026-05-12)） | DSPy | — | — | ❌ | — |
| GEPA Genetic-Pareto 反射式 prompt 进化（ICLR 2026 Oral；Quilin 自进化的唯一 optimizer） | DSPy | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/teleprompt/gepa/` | 📋 | 深入 |
| Skill Library 技能库（成功代码按 embedding 索引 + 技能组合） | Voyager | latest (2026-04) | `github.com/MineDojo/Voyager` → `voyager/skill_manager.py` | 📋 | 深入 |
| Automatic Curriculum（递增难度任务自动生成，推动持续探索） | Voyager | latest (2026-04) | `github.com/MineDojo/Voyager` → `voyager/curriculum_agent.py` | 📋 | 深入 |
| Action/Observation 配对记录模式（严格轨迹格式） | OpenHands | latest (2026-04) | `github.com/All-Hands-AI/OpenHands` → `openhands/core/main.py` | 📋 | 深入 |
| 轨迹回放功能（沙箱回放历史轨迹验证修改效果） | OpenHands | latest (2026-04) | `github.com/All-Hands-AI/OpenHands` → `openhands/runtime/` | 📋 | 深入 |
| ACI 设计原则（工具描述对 Agent 友好化，减少工具误用） | SWE-agent | latest (2026-04) | `github.com/princeton-nlp/SWE-agent` → `sweagent/agent/agents.py` | 📋 | 深入 |
| 搜索/编辑/测试三步工作流技能模板（代码修改标准技能） | SWE-agent | latest (2026-04) | `github.com/princeton-nlp/SWE-agent` → `sweagent/tools/` | 📋 | 深入 |
| Meta Agent Search（搜索空间定义 + 元 Agent 宏观审视工作流） | ADAS | latest (2026-04) | `github.com/ShengranHu/ADAS` → `adas/` | 📋 | 深入 |
| Archive 档案积累（存档所有修改结果为后续修改提供参考） | ADAS | latest (2026-04) | `github.com/ShengranHu/ADAS` → `adas/search.py` | 📋 | 深入 |
| 整体观察（Agent 基准框架，标准化评估接口） | AutoGPT Forge | latest (2026-04) | `github.com/Significant-Gravitas/AutoGPT` | 👀 | 观察 |
| 整体观察（LLM 驱动奖励函数生成 + 进化式优化循环） | Eureka | latest (2026-04) | `github.com/eureka-research/Eureka` | 👀 | 观察 |
| 整体观察（蒙特卡洛树搜索 + 价值函数 + 自我反思） | LATS | latest (2026-04) | `github.com/lapisrocks/LanguageAgentTreeSearch` | 👀 | 观察 |
| 整体观察（Agent 指令微调数据集，多任务泛化） | AgentTuning | latest (2026-04) | `github.com/THUDM/AgentTuning` | 👀 | 观察 |
| 整体观察（通用自进化协议框架，DSPy 内置实验性优化器） | GEPA (Hermes Agent) | latest (2026-04) | `github.com/stanfordnlp/dspy` → `dspy/teleprompt/` | 👀 | 观察 |

---

## 11 — Agent Mesh

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| Agent Card 规范（能力声明 + 发现端点） | Google A2A Protocol | latest (2026-04) | `github.com/google/A2A` → `specification/` | 📋 | 深入 |
| Task 生命周期状态机（submitted → working → completed）+ SSE 推送 | Google A2A Protocol | latest (2026-04) | `github.com/google/A2A` → `samples/python/` | 📋 | 深入 |
| CLI Agent 标准连接握手（session/new → session/prompt → stream） | ACP Protocol (Zed) | latest (2026-04) | `github.com/ACP-Foundation/acp-spec` → `specification/` | 📋 | 深入 |
| 控制面/数据面分离 + AgentPod 生命周期 + Channel 广播 | AgentsMesh | latest (2026-04) | `github.com/AgentsMesh/AgentsMesh` → `control-plane/` | 📋 | 深入 |
| daemon 持久化进程 + MCP adapter 双向桥接 + 消息缓冲队列 | AgentBridge | latest (2026-04) | `github.com/nicobailey/AgentBridge` → `src/` | 📋 | 深入 |
| SOP 驱动角色分工 + 共享消息池 + Agent 角色 system prompt 设计 | MetaGPT | latest (2026-04) | `github.com/geekan/MetaGPT` → `metagpt/roles/` | 📋 | 深入 |
| GroupChat Manager 动态发言权 + 发言者选择策略 | AutoGen | latest (2026-04) | `github.com/microsoft/autogen` → `autogen/agentchat/` | 📋 | 深入 |
| WireGuard mesh 零配置 NAT 穿透 + MagicDNS | Tailscale | latest (2026-04) | `github.com/tailscale/tailscale` → `wgengine/` | 📋 | 深入 |
| 多 agent 编排（handoff + 并行/路由/辩论）+ MCP 多协议通信（stdio/WS/SSE/HTTP） | PraisonAI | latest (2026-04) | `github.com/MervinPraison/PraisonAI` → `praisonai/` | 📋 | 深入 |
| 整体观察（IDE 内实时协作桥、WebSocket 双向协议） | Bridge IDE | latest (2026-04) | `bridge.dev` | 👀 | 观察 |
| 整体观察（SaaS Agent 编排、Webhook 集成） | Composio | latest (2026-04) | `github.com/composio/composio` | 👀 | 观察 |
| 整体观察（Headscale 开源 Tailscale 控制面） | Headscale | latest (2026-04) | `github.com/juanfont/headscale` | 👀 | 观察 |
| 整体观察（多 Agent 角色+任务模板协作） | CrewAI | latest (2026-04) | `github.com/crewAIInc/crewAI` | 👀 | 观察 |
| 整体观察（多机 agent 实时监控 TUI、HTTP+WS 跨网订阅、provider adapter） | Agent Cow | latest (2026-04) | `github.com/h0ngcha0/agent-cow` | 👀 | 观察 |
| 整体观察（daemon 事件路由器、异构 CLI agent hook 协调、Discord/Slack 投递） | clawhip | latest (2026-04) | `github.com/Yeachan-Heo/clawhip` | 👀 | 观察 |

---

## 13 — 技能工程

> 本表列出四仓库中用于对比研究的关键代码路径。

| 功能点 | 来源项目 | 版本/Commit | 参考代码路径 | 状态 | 深度 |
|--------|---------|-------------|-------------|------|------|
| Bundled / File / MCP / Managed 四源发现 + ToolSearch 延迟加载 | Claude Code | latest (2026-04) | `src/skills/loadSkillsDir.ts` + `src/utils/toolSearch.ts` | 📋 | 深入 |
| 文件系统扫描 + 3 层 LRU 缓存 + skills_guard 30+ 威胁模式 + background nudge | Hermes Agent | latest (2026-04) | `agent/prompt_builder.py` + `tools/skills_guard.py` + `run_agent.py` | 📋 | 深入 |
| 6 级优先级发现 + realpath containment + plugin 贡献 skill roots | OpenClaw | latest (2026-04) | `src/agents/skills/workspace.ts` + `src/agents/skills/plugin-skills.ts` | 📋 | 深入 |
| 分层 root registry + startup catalog + per-turn lazy injection + model-driven file open | Codex CLI | latest (2026-04) | `codex-rs/core-skills/src/manager.rs` + `loader.rs` + `render.rs` + `injection.rs` | 📋 | 深入 |

---

## 附录：上游监控优先级

| 领域 | 高优先级监控 | 中优先级监控 |
|------|------------|------------|
| 01 LLM 接入 | litellm（MCP/Agent 原生协议更新）、vLLM（新版本性能优化） | LangChain、LlamaIndex、SGLang |
| 02 上下文 | LangChain（消息模型变更）、Instructor（结构化输出新特性） | DSPy、Semantic Kernel |
| 03 记忆 | Mem0（自适应更新算法）、Graphiti（时序 KG 新特性） | LangMem、Cognee |
| 04 规划 | LangGraph（状态图 API 变更）、OpenAI Agents SDK（Handoff 更新） | DSPy、Pydantic AI |
| 05 工具 | MCP SDK（协议版本升级）、browser-use（会话管理新特性） | Playwright、Crawl4AI |
| 06 多 Agent | LangGraph（多 Agent 路由）、Google A2A（协议规范更新） | AutoGen、CrewAI |
| 07 安全护栏 | Guardrails AI（新 Validator 生态）、Presidio（PII 算子更新） | NeMo Guardrails、LLM Guard |
| 08 可观测性 | Langfuse（Generation 模型变更）、OpenLLMetry（新 instrumentation） | AgentOps、Arize Phoenix |
| 09 部署运行时 | E2B（Sandbox API 变更）、Docker SDK（安全参数更新） | Modal、Daytona |
| 10 自进化 | DSPy（Optimizer 更新）、OpenHands（轨迹格式变更） | Voyager、SWE-agent、ADAS |
| 11 Agent Mesh | Google A2A（协议规范更新）、ACP（CLI 连接标准更新）、AgentsMesh（编排模式）、PraisonAI（多协议通信更新） | AgentBridge、Tailscale、MetaGPT、Agent Cow、clawhip |
| 13 技能工程 | Claude Code（skill loader + ToolSearch 变更）、Hermes（skills_guard 威胁模式 + nudge 策略） | OpenClaw（plugin-skills 桥接）、Codex（core-skills 模块） |

> **与脚本集成**：`sync-upstreams.py` 扫描本文件中的来源项目，优先对"深入"状态项目的上游变更触发 `merge-with-claude.sh` 进行智能 diff 分析与融合补丁生成。观察项目的上游变更仅记录，不自动触发融合。
