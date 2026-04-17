# 工具工程（Tool Engineering）

> **ADR-001 对齐说明**：工具系统用 TS 实现（MCP Client Manager），Python ML 工具封装为独立 MCP Server。本文档中的 Python 代码示例仅表达设计意图，实施时将以 TS 重写。`quilin/` 路径为规划参考。详见 [ADR-001](../../adr/adr-001-core-loop-and-language.md)。

工具使用是 Agent 区别于普通 LLM 的核心能力。上下文工程让 LLM 想得好，工具工程让 Agent 做得到。

---

## 一、问题定义

### 1.1 工具使用的 6 个维度

```
工具工程
├── 1. 工具发现（Discovery）      — Agent 怎么知道有哪些工具可用
├── 2. 工具描述（Description）    — 怎么让 LLM 正确理解和调用
├── 3. 工具编排（Orchestration）  — 单步 / 多步 / 并行 / 嵌套
├── 4. 结果处理（Result Handling）— 返回值怎么回填上下文
├── 5. 工具安全（Safety）         — 权限、确认、限流
└── 6. 工具协议（Protocol）       — 标准化调用方式
```

#### 维度 1：工具发现（Discovery）

- **静态注册**：启动时把所有工具 schema 写死
- **动态发现**：运行时通过 MCP 协议自动发现可用工具
- **按需加载**：上下文装不下 500 个工具描述，根据任务只暴露相关的

#### 维度 2：工具描述（Description）

- 工具的 name / description / 参数 schema 写得好不好，直接决定调用成功率
- 工具描述本身也是上下文工程的一部分——占多少 token、怎么排布
- 差的描述 → LLM 乱调用 → 浪费 token + 错误结果

#### 维度 3：工具编排（Orchestration）

```
简单：  查天气 → 一次调用搞定
串行：  搜索 → 读文档 → 总结 → 回答
并行：  同时查 3 个数据库，合并结果
嵌套：  Agent A 调用 Agent B 作为工具
条件：  如果搜索无结果 → 换一个工具重试
循环：  反复执行直到满足退出条件
```

#### 维度 4：结果处理（Result Handling）

- **裁剪**：结果太大时截断或只取关键字段（SQL 查出 10 万行？）
- **格式转换**：HTML → 纯文本、图片 → 文本描述
- **错误处理**：超时、限流、格式错误的重试策略
- **结果缓存**：相同参数的调用结果可以缓存复用

#### 维度 5：工具安全（Safety）

- **读写分级**：只读工具（搜索）vs 写入工具（发邮件、删文件）
- **人类确认**：高危操作（转账、删库）需要人类审批
- **速率限制**：防止 Agent 无限循环调用
- **成本控制**：每个工具调用的 token/API 成本追踪
- **沙箱隔离**：Code Interpreter 必须在沙箱中运行

#### 维度 6：工具协议（Protocol）

见下文"6 种工具调用方式"及 MCP 客户端设计。

### 1.2 核心挑战

| 挑战 | 描述 | 影响 |
|------|------|------|
| 工具爆炸 | 100+ 工具时上下文装不下所有描述 | 需要按需加载 + 语义搜索 |
| 调用准确率 | 参数格式错误、工具选错 | 浪费 token，任务失败 |
| 结果过大 | 网页/DB 结果动辄数万 token | 需要智能截断 + 摘要 |
| 安全边界 | Agent 误操作破坏性工具 | 需要权限分级 + 人类确认 |
| 会话持久化 | 浏览器登录态跨会话丢失 | 需要 SessionManager |
| 工具成本 | 每次截图 + VLM 分析成本高 | 需要分层路由降级策略 |

---

## 二、设计方案

### 2.1 4 类混合动作空间（MAI-UI/UI-TARS-2 启发）

```
ToolRouter 混合动作空间
├── 程序化工具（Programmatic）
│   file_read / file_write / file_edit / bash / glob / grep
│   web_search / web_fetch / db_query / code_execute
│
├── 交互操作（Interactive）
│   ask_user（一等公民，人类确认高危操作）
│   show_progress（长任务进度汇报）
│
├── 控制操作（Control）
│   terminate（终止任务）
│   pause（暂停等待外部事件）
│   resume（恢复执行）
│
└── GUI 操作（GUI）
    browser_click / browser_type / browser_scroll
    screenshot / computer_use（屏幕级操作）
```

**设计原则**：优先使用程序化工具（低成本、高稳定性），GUI 操作作为最后兜底。

### 2.2 Tool Protocol 伪代码

```python
from enum import Enum
from typing import Protocol, Any
from dataclasses import dataclass

class ToolCategory(Enum):
    PROGRAMMATIC = "programmatic"   # 文件/系统/搜索
    INTERACTIVE  = "interactive"    # 用户交互
    CONTROL      = "control"        # 流程控制
    GUI          = "gui"            # 浏览器/桌面

@dataclass
class ToolResult:
    success: bool
    data: Any           # 工具返回数据
    error: str | None   # 错误信息（失败时非空）
    cost_tokens: int    # 本次调用消耗 token 数
    metadata: dict      # 额外元数据（执行时间、来源等）

@dataclass
class ExecutionContext:
    session_id: str
    agent_id: str
    budget_remaining: int   # 剩余 token 预算
    allowed_categories: list[ToolCategory]
    require_confirmation: bool  # 高危操作是否需要确认

class Tool(Protocol):
    name: str
    description: str
    parameters: dict        # JSON Schema
    category: ToolCategory

    async def execute(
        self,
        params: dict,
        context: ExecutionContext,
    ) -> ToolResult: ...

    def validate_params(self, params: dict) -> bool: ...
```

### 2.3 ToolRegistry 接口

```python
class ToolRegistry:
    """工具注册中心：注册 / 发现 / 过滤 / 查找"""

    def register(self, tool: Tool) -> None:
        """注册工具（静态启动时 + Agent 运行时动态注册）"""

    def discover_mcp(self, server_url: str) -> list[Tool]:
        """连接 MCP Server，自动发现并注册远端工具"""

    def find(self, name: str) -> Tool | None:
        """按名称精确查找"""

    def filter_by_category(
        self,
        category: ToolCategory,
    ) -> list[Tool]:
        """按类别过滤，构建受限工具集"""

    def search(self, query: str, top_k: int = 10) -> list[Tool]:
        """语义搜索——当工具数量超过 50 时按需加载"""

    def list_all(self) -> list[dict]:
        """返回所有工具的 JSON Schema 列表（用于填充系统提示）"""
```

### 2.4 MCP 客户端设计

MCP（Model Context Protocol）是 Anthropic 提出的标准化工具协议，允许 Agent 动态发现并调用外部工具服务。

```
Agent ──MCPClient──► MCP Server（stdio / SSE）
                          │
                     工具自动发现
                          │
                     注册到 ToolRegistry
                          │
                     像本地工具一样调用
```

```python
class MCPClient:
    """连接外部 MCP Server，自动发现工具并注册"""

    async def connect(
        self,
        transport: str,       # "stdio" | "sse" | "http"
        endpoint: str,        # 命令行或 URL
    ) -> None: ...

    async def list_tools(self) -> list[MCPToolSchema]: ...

    async def call_tool(
        self,
        name: str,
        params: dict,
    ) -> ToolResult: ...

    async def disconnect(self) -> None: ...

# 使用示例：接入 Playwright MCP Server
client = MCPClient()
await client.connect("stdio", "npx playwright-mcp")
tools = await client.list_tools()          # 自动发现 browser_* 工具
for t in tools:
    registry.register(MCPToolAdapter(client, t))  # 注册为本地 Tool
```

### 2.5 CLI-Anything 集成（GUI 工具 → CLI Wrapper）

> **Skill ≠ Tool**：本领域定义的是**可执行动作层**（Tool = LLM 发 `tool_call` → 有副作用的 side effect）。知识/提示类资产（SKILL.md 目录 + YAML frontmatter + 按需加载）由 [13-技能工程](../13-skills/README.md) 统一管理。本节下述的 CLI wrapper 产出的 `SKILL.md` 只是**元数据清单**，用于自动派生 Tool schema；技能的索引、加载、沙箱安全策略走 13-skills 的管道。

**问题**：大量桌面软件（GIMP、Blender、LibreOffice 等）仅有 GUI 界面，Agent 无法直接调用。工具能力不应受限于工具本身是否提供 CLI 接口。

**方案**：集成 [CLI-Anything](https://github.com/HKUDS/CLI-Anything)（HKUDS），为 GUI-only 软件自动生成 Python Click CLI wrapper。

**工作机制**：
1. 分析目标软件源码，映射 GUI 操作到底层 API/函数调用
2. 生成 Python Click CLI wrapper（支持 `--json` 机器输出 + `--help` 自描述）
3. 每个 CLI 附带 `SKILL.md` 元数据文件，可自动注册进 Quilin ToolRegistry

**双模式集成**：

| 模式 | 触发时机 | 机制 | 适用场景 |
|------|---------|------|---------|
| **Build-time 预生成** | 构建阶段 | 为已知常用工具（ffmpeg、ImageMagick、LibreOffice 等）预先生成 CLI wrapper，打包进 Quilin | 高频工具，零延迟调用 |
| **Runtime 按需生成** | Agent 遇到无 CLI 的工具时 | 动态调用 CLI-Anything SOP 生成 wrapper，缓存供后续复用 | 长尾工具，首次使用有生成延迟 |

**与 Quilin 工具系统的对接**：
- 生成的 CLI 通过 `subprocess.run()` + JSON 解析调用，注册为 `ToolCategory.PROGRAMMATIC` 类型
- `SKILL.md` 中的命令元数据用于自动构建 Tool schema（name、description、parameters）
- 与 Deferred Tools 设计天然匹配：首次调用时按需生成 + 注册

**设计原则**：CLI-first，所有工具都必须可通过命令行调用。GUI 操作（browser_click 等）仅作为最后兜底。

### 2.6 工具自创（Agent-Generated Tools）

沙箱方式让 Agent 能力无上限：

```python
class SandboxExecutor:
    """沙箱代码执行 + Agent 自创工具注册"""

    async def create_sandbox(
        self,
        image: str = "python:3.11-slim",
        resources: dict | None = None,   # CPU/内存/超时限制
    ) -> str: ...   # 返回 sandbox_id

    async def execute(
        self,
        sandbox_id: str,
        code: str,
        language: str = "python",
        timeout: int = 30,
    ) -> ToolResult: ...

    async def install(
        self,
        sandbox_id: str,
        packages: list[str],
    ) -> None: ...

    async def register_tool(
        self,
        name: str,
        code: str,              # Agent 编写的工具代码
        description: str,       # Agent 描述工具用途
    ) -> Tool: ...              # 注册到 ToolRegistry 后返回

    async def destroy(self, sandbox_id: str) -> None: ...
```

**Agent 自创工具流程**：
```
1. Agent 发现缺少某个能力（如：解析 Excel 表格）
2. Agent 编写 Python 函数（import openpyxl; ...）
3. SandboxExecutor 执行验证代码正确性
4. 注册为新 Tool，后续直接复用
5. 好用的工具持久化，供其他 Agent 共享
```

### 2.6 6 种工具调用方式

#### 方式 1：Function Calling（原生函数调用）

LLM 厂商内置的能力，最主流的方式。

```
用户 → LLM → 返回 JSON（tool_name + params）→ 执行 → 结果回填 → LLM 继续
```

- OpenAI / Anthropic / Google 都支持
- 优点：LLM 原生理解，调用准确率最高
- 缺点：工具定义要跟着每次请求发送，占 token

#### 方式 2：MCP（Model Context Protocol）

标准化的工具发现 + 调用协议。

```
Agent ←MCP协议→ MCP Server（工具提供方）
```

- 优点：工具可以独立部署，动态发现，跨 Agent 复用
- 缺点：多一层网络调用，协议还在演进中

#### 方式 3：Code Interpreter / 代码执行

让 LLM 直接写代码来"使用工具"。

```
LLM 生成 Python 代码 → 沙箱执行 → 返回结果
```

- OpenAI Code Interpreter、Anthropic Artifacts 都是这个思路
- 优点：无限灵活，不需要预定义工具
- 缺点：安全风险大，需要沙箱隔离

#### 方式 4：ReAct / 文本解析

最原始的方式，LLM 输出特定格式文本，解析后执行。

```
Thought: 我需要搜索天气
Action: search
Action Input: "北京天气"
Observation: 晴，25°C
```

- LangChain 早期就是这个模式
- 优点：不依赖厂商 Function Calling 能力
- 缺点：解析容易出错，不够结构化

#### 方式 5：Computer Use / GUI 操作

直接操作电脑界面。

```
LLM 看屏幕截图 → 输出鼠标点击/键盘操作坐标 → 执行
```

- Anthropic Computer Use、OpenAI Operator
- 优点：任何软件都能操作，不需要 API
- 缺点：慢、不稳定、成本高

#### 方式 6：API 直连

Agent 直接构造 HTTP 请求调用外部 API。

```
LLM 根据 OpenAPI/Swagger schema 生成请求 → 执行 → 解析响应
```

- 介于 Code Interpreter 和 Function Calling 之间
- 适合调用第三方 SaaS 服务

### 2.7 方式对比

| 方式 | 准确率 | 灵活性 | 安全性 | 适用场景 |
|------|--------|--------|--------|----------|
| Function Calling | 最高 | 中 | 高 | 主力方式，覆盖 80% 场景 |
| MCP | 高 | 高 | 高 | 工具多、动态发现、跨 Agent |
| Code Interpreter | 中 | 最高 | 低 | 数据分析、计算、动态逻辑 |
| ReAct 文本解析 | 低 | 中 | 高 | 兼容老模型 |
| Computer Use | 低 | 最高 | 低 | 没有 API 的软件 |
| API 直连 | 中 | 高 | 中 | 调用第三方 SaaS |

### 2.8 ToolRouter 设计

不是选一种，而是分层支持，由 ToolRouter 自动路由：

```
ToolRouter
├── Function Calling  ← 默认主力（通过 LLM 层的原生能力）
├── MCP              ← 标准化工具协议（通过 MCPBus）
├── Code Executor    ← 沙箱代码执行（需要安全隔离）
├── API Gateway      ← OpenAPI schema 驱动的 HTTP 调用
├── Computer Use     ← GUI 操作（可选，优先级最低）
└── ReAct Parser     ← 文本解析兜底（兼容无 FC 能力的模型）
```

上层调用 `ToolRouter.invoke(tool_name, params)` 时不感知底层用的是哪种方式。

### 2.9 重点专题：浏览器使用（Browser Use）

Agent 使用浏览器是高频刚需，但远比调一个 API 复杂。

#### 能力层级

```
Level 1: 网页抓取（Scraping）
  URL → 获取 HTML/文本内容 → 回填上下文
  工具：requests + BeautifulSoup / Firecrawl / Jina Reader

Level 2: 动态网页交互（Browser Automation）
  打开页面 → 点击/填表/滚动/等待 → 提取结果
  工具：Playwright / Puppeteer / Selenium

Level 3: 视觉理解 + 操作（Visual Browser Use）
  截图 → LLM 看屏幕 → 输出点击坐标 → 执行
  工具：Anthropic Computer Use / Browserbase / AgentQL

Level 4: 完整浏览器 Agent
  自主导航：搜索 → 点击链接 → 阅读 → 提取信息 → 下一步
  持续会话：登录态保持、Cookie 管理、多标签页
```

#### Agent 使用浏览器的 13 种底层方式

```
浏览器使用方式
├── 1.  CDP（Chrome DevTools Protocol）
│       直接操作 Chrome 内核，最底层最灵活
│       工具：Playwright / Puppeteer / 直接 WebSocket
│
├── 2.  WebDriver BiDi（双向协议）
│       W3C 新标准，替代传统 WebDriver，支持事件推送
│       未来方向：Chrome / Firefox / Safari 统一支持
│
├── 3.  WebDriver W3C（经典）
│       Selenium 4+ 默认协议，HTTP 轮询模式
│       工具：Selenium / WebDriverIO / Appium
│
├── 4.  浏览器扩展 API（Extensions）
│       以扩展形式注入页面，可拦截请求/修改 DOM
│       工具：Chrome Extension MV3 / Firefox WebExtension
│
├── 5.  自动化框架（Playwright / Puppeteer / Selenium）
│       高层封装，Agent 最常用的方式
│       优点：API 成熟，社区庞大，支持多浏览器
│
├── 6.  AI 原生浏览器工具
│       专为 Agent 设计的浏览器框架
│       工具：browser-use / Stagehand / Steel / Skyvern
│
├── 7.  视觉/多模态方式
│       截图 → VLM 理解 → 输出坐标操作
│       工具：Anthropic Computer Use / GPT-4V + pyautogui
│
├── 8.  内容提取服务
│       URL → 结构化内容（不操作，只读取）
│       工具：Firecrawl / Jina Reader / Diffbot / Trafilatura
│
├── 9.  云浏览器 / 远程浏览器
│       云端运行完整浏览器实例，通过 API 控制
│       工具：Browserbase / Steel Cloud / BrowserCat / Apify
│
├── 10. Accessibility Tree（无障碍树）
│       解析页面 A11y Tree 作为结构化表示，替代原始 DOM
│       工具：Playwright MCP / WebVoyager
│       优势：比 DOM 更简洁，LLM 理解成本更低
│
├── 11. MITM 代理
│       中间人代理拦截/修改 HTTP 流量
│       工具：mitmproxy / Burp Suite（安全测试场景）
│
├── 12. WASM 沙箱浏览器
│       浏览器在 WASM 中运行，完全隔离
│       工具：Aspect Ratio / browser-in-browser 项目
│
└── 13. 桌面/OS 级自动化
        操作系统级键鼠模拟，不依赖浏览器 API
        工具：pyautogui / xdotool / AppleScript / Computer Use
```

#### 行业主流方案与未来方向

**当前主流（2025-2026）**：
- **DOM 解析 + Playwright/CDP** — 80% 的 Agent 浏览器方案基于此
- **A11y Tree 作为页面表示** — 比原始 DOM 更适合 LLM 理解（Playwright MCP 采用）
- **混合 DOM + Vision** — DOM 优先，视觉兜底（browser-use 的策略）

**行业公认未来方向**：
- **WebDriver BiDi 替代 CDP** — W3C 标准化，跨浏览器统一
- **A11y Tree 成为主流表示层** — 替代 DOM/截图，token 效率最高
- **Hybrid DOM + Vision** — 两种模态互补，DOM 处理结构化内容，Vision 处理 Canvas/动态渲染
- **Agent 专用浏览器** — 内置反检测、会话管理、工具调用（Steel、browser-use 方向）

#### 核心挑战

- **登录态管理**：很多信息需要登录才能获取（Cookie / OAuth / Session / 2FA）
- **动态内容**：SPA 页面、无限滚动、弹窗处理
- **反爬/反检测**：Cloudflare / CAPTCHA / Rate Limit / 浏览器指纹检测
- **成本控制**：每次截图 + LLM 分析的 token 成本很高
- **并发浏览**：同时打开多个页面做对比/汇总
- **结果提取**：整个网页 HTML 太大，要智能提取关键内容
- **跨会话持久化**：Agent 重启后如何恢复登录态和浏览状态

### 2.10 会话管理设计（SessionManager）

登录态持久化是 Agent 浏览器使用的核心难题，需要统一的 SessionManager：

```
SessionManager
├── ProfileStore（浏览器 Profile 管理）
│   ├── local_chrome()          → 复用本地 Chrome Profile（最简单）
│   ├── persistent_dir(path)    → 自定义持久化目录
│   └── cloud_profile(id)      → 云端 Profile（browser-use Cloud）
│
├── StorageState（Cookie/Storage 导入导出）
│   ├── save(path)              → 导出 Cookie + localStorage 到 JSON
│   ├── load(path)              → 从 JSON 恢复登录态
│   └── auto_save(interval)     → 定期自动保存（防丢失）
│
├── CredentialManager（凭证管理）
│   ├── store(site, creds)      → 加密存储用户名/密码
│   ├── totp_generate(secret)   → 生成 TOTP 2FA 验证码
│   └── oauth_flow(provider)    → OAuth 自动化流程
│
├── SessionHealing（会话恢复）
│   ├── detect_expired()        → 检测登录态过期
│   ├── auto_relogin()          → 自动重新登录
│   └── human_handoff()         → 需要人工介入时打开有头浏览器
│
└── AntiDetection（反检测）
    ├── fingerprint(profile)    → 浏览器指纹管理
    ├── proxy(config)           → 代理轮换
    └── stealth_mode()          → 反自动化检测规避
```

### 2.11 BrowserProvider 路由策略

```
ToolRouter
└── BrowserProvider
    ├── SimpleFetch        ← Level 1: 静态页面直接抓（最快最便宜）
    ├── BrowserUseAgent    ← Level 2-4 主力: browser-use（会话管理最强，Python 原生）
    ├── PlaywrightMCP      ← MCP 标准工具: A11y Tree 模式（MCP 生态首选，零成本）
    ├── SteelBrowser       ← 基础设施层: 需要反检测/云浏览器时（免费 100h/月）
    ├── SkyvernVisual      ← 视觉模式: DOM 不可靠时降级到截图+LLM
    └── StagehandTS        ← TypeScript 场景: 前端生态深度集成
    │
    └── SessionManager     ← 统一会话管理（跨所有 Provider 共享）
        ├── ProfileStore
        ├── StorageState
        ├── CredentialManager
        ├── SessionHealing
        └── AntiDetection
```

**路由策略**：Agent 调用 `browse(url, task)` 时，BrowserProvider 根据任务复杂度 + 目标网站特征自动选择：

```
简单内容提取     → SimpleFetch（cost: $0）
需要登录/交互    → BrowserUseAgent + SessionManager（cost: 低）
MCP 集成场景     → PlaywrightMCP（cost: $0）
反检测要求高     → SteelBrowser（cost: 中）
DOM 不可解析     → SkyvernVisual（cost: 高，需要 VLM）
```

### 2.12 执行沙箱（Execution Sandbox）

Agent 需要一个**隔离的执行环境**来编写和运行自己需要的工具，而不是只能用预定义的工具集。

```
传统方式：人类预定义 20 个工具 → Agent 只能用这 20 个
沙箱方式：Agent 自己写代码创建工具 → 能力无上限
```

```
┌─────────────────────────────────────────┐
│  Agent Sandbox（隔离环境）                │
│                                          │
│  ┌──────────┐  ┌──────────┐             │
│  │ 文件系统  │  │ 网络访问  │  ← 受限    │
│  └──────────┘  └──────────┘             │
│  ┌──────────┐  ┌──────────┐             │
│  │ Python   │  │ Node.js  │  ← 预装    │
│  │ Runtime  │  │ Runtime  │             │
│  └──────────┘  └──────────┘             │
│  ┌──────────┐  ┌──────────┐             │
│  │ pip/npm  │  │ 系统工具  │  ← 可安装  │
│  └──────────┘  └──────────┘             │
│                                          │
│  资源限制：CPU / 内存 / 磁盘 / 执行时间    │
└─────────────────────────────────────────┘
        ↕ 受控通信
┌─────────────────────────────────────────┐
│  Quilin（宿主）                      │
│  - 创建/销毁沙箱                           │
│  - 传入任务和数据                           │
│  - 收集执行结果                             │
│  - 监控资源使用                             │
└─────────────────────────────────────────┘
```

| 沙箱方式 | 隔离性 | 启动速度 | 适用场景 |
|---------|--------|---------|----------|
| **Docker 容器** | 高 | 秒级 | 生产环境首选 |
| **gVisor / Firecracker** | 最高 | 秒级 | 安全敏感场景 |
| **Nsjail / Bubblewrap** | 中 | 毫秒级 | 轻量快速执行 |
| **WASM 沙箱** | 高 | 毫秒级 | 浏览器端 / 边缘 |
| **E2B / Modal** | 高 | 秒级 | 托管云沙箱，免运维 |

---

## 三、Top 10 参考项目

### 3.1 总览表（2026.04 调研）

| # | 项目 | Stars | 定位 | 深度 |
|---|------|-------|------|------|
| 1 | [MCP SDK](https://github.com/modelcontextprotocol/python-sdk) | ~22K | 标准工具协议，客户端/服务器实现 | 深入 |
| 2 | [browser-use](https://github.com/browser-use/browser-use) | ~87K | 浏览器自动化，视觉+DOM 混合 | 深入 |
| 3 | [Playwright](https://github.com/microsoft/playwright) | ~84K | 底层浏览器引擎，Python/JS API | 深入 |
| 4 | [Crawl4AI](https://github.com/unclecode/crawl4ai) | ~61K | 异步爬取，LLM 友好 Markdown 输出 | 深入 |
| 5 | [Stagehand](https://github.com/browserbase/stagehand) | ~20K | AI 原生浏览器，act/extract/observe | 深入 |
| 6 | [Firecrawl](https://github.com/firecrawl/firecrawl) | ~70K | 网页 → 结构化数据，/agent 端点 | 观察 |
| 7 | [Computer Use Demo](https://github.com/anthropics/anthropic-quickstarts) | — | Anthropic 屏幕级操作参考实现 | 观察 |
| 8 | [exa-py](https://github.com/exa-labs/exa-py) | ~200 | 语义搜索 API，神经网络链接预测 | 观察 |
| 9 | [Tavily](https://github.com/tavily-ai/tavily-python) | ~1K | Agent 优化搜索，LangChain 集成 | 观察 |
| 10 | [SerpAPI](https://github.com/serpapi/google-search-results-python) | ~1.5K | 搜索引擎结构化数据，40+ 引擎 | 观察 |

### 3.2 浏览器项目全景评测（2026.04）

#### 第一梯队：会话管理最佳

| 项目 | Stars | 会话持久化 | 云 Profile | Cookie 导入导出 | 2FA | MCP | 云/自托管 |
|------|-------|-----------|-----------|----------------|-----|-----|----------|
| **browser-use** | 87K | ★★★★★ | ✅ | ✅（自动保存） | ✅ 内置 TOTP | ✅ | 两者都支持 |
| **Playwright MCP** | 31K | ★★★★☆ | ❌（仅本地） | ✅（v0.0.63+） | ❌ | ✅ 原生 | 仅自托管 |

**browser-use**（⭐ 87K，Python，MIT）— **会话管理最完整**
- `Browser.from_system_chrome()` — 复用本地 Chrome 全部登录态
- `storage_state='auth.json'` — Playwright 格式 Cookie/localStorage 自动导出导入，关闭时自动保存
- 云端 Profile — `client.profiles.create(name="user-id-1")`，跨会话跨机器持久化
- **内置 TOTP 2FA** — 自动生成验证码，唯一一个 OSS 内置此功能的项目
- `keep_alive=True` — 浏览器在任务间保持打开
- 集成：Python SDK、JS/TS SDK、MCP Server（`uvx browser-use --mcp`）

**Playwright MCP**（⭐ 31K，TypeScript，微软官方）— **MCP 生态首选**
- 默认按工作区创建持久化 Profile（`~/.cache/ms-playwright/mcp-{channel}-{hash}`）
- v0.0.63+ 完整 Cookie/Storage API：`cookie-set/get/list/delete`、`localstorage-*`、`sessionstorage-*`
- Chrome 扩展模式：连接已登录的浏览器标签页
- 基于 A11y Tree（不需要视觉模型），token 效率最高
- 社区扩展 `playwright-mcp-sessions`：命名会话管理，自动识别 50+ 认证服务

#### 第二梯队：能力很强

| 项目 | Stars | 会话持久化 | 特点 |
|------|-------|-----------|------|
| **Stagehand** | 20K | ★★★★☆ | TypeScript 首选，`act/extract/observe` API，Browserbase Contexts 持久化 |
| **Skyvern** | 21K | ★★★★☆ | 视觉驱动（截图+LLM），Browser Profiles 快照，`persist_browser_session=true` |
| **Steel Browser** | 6.8K | ★★★★☆ | 基础设施定位，反检测内置，Contexts API，免费 100 小时/月，亚秒启动 |

**Stagehand**（⭐ 20K，TypeScript）
- 本地：`userDataDir` 持久化浏览器数据
- 云端：Browserbase Contexts API — `context: { id: "my-ctx", persist: true }`
- 2026.02 新增 Cookie API：`context.cookies()`、`context.addCookies()`、`context.clearCookies()`
- 集成：TypeScript SDK、CLI（`browse open --context-id <id> --persist`）

**Skyvern 2.0**（⭐ 21K，Python）
- **Route Memorization** — AI 首次探索路径，编译成 Playwright 脚本，站点变化时自动修复
- 2.0 版本比 v1 便宜 2.7x、快 2.3x
- Browser Profiles：浏览器状态快照（Cookie、localStorage），`persist_browser_session=true`
- 凭证管理系统处理登录
- CLI：`skyvern browser login --url ... --credential-id ...`
- 可连接本地 Chrome：`skyvern browser serve --tunnel --use-local-profile`
- Planner/Actor/Validator 三角色架构，WebVoyager 85.85%
- 视觉模式对 DOM 变化容忍度最高

**Steel Browser**（⭐ 6.8K，TypeScript）
- Contexts API：`GET /v1/sessions/{id}/context` 捕获完整状态，新建会话时恢复
- Profiles：持久化浏览器身份（Cookie + 认证 Token + 指纹）
- 会话最长 24 小时
- Docker 自托管 + Steel Cloud（免费 100 小时/月）
- 反检测/指纹伪装内置

#### 第三梯队：可用但有局限

| 项目 | Stars | 问题 |
|------|-------|------|
| **LaVague** | 6.3K | 只支持 `user_data_dir` 复用 Chrome Profile，无专用会话 API |
| **AgentQL** | 商业 | 语义查询好用，但会话偏短期，无跨会话持久化 |
| **MultiOn** | 小 | 会话 10 分钟超时，活跃度下降 |
| **Induced AI** | Beta | 文档稀缺，会话管理能力未知 |
| **Browserable** | 1.2K | JS/Playwright，自托管优先，开发节奏较慢（最后更新 2025.08） |

#### 商业/平台级浏览器方案

| 项目 | 厂商 | 模式 | 登录态 | 特点 |
|------|------|------|--------|------|
| **Browserbase** | Browserbase (YC) | 云浏览器基础设施 | ✅ Contexts API 持久化 | Stagehand 的底层，CAPTCHA 解决，隐身模式，$20-99/月 |
| **Comet** | Perplexity | AI 原生浏览器 App | ✅ 标准浏览器登录 | AI 即浏览器（非插件），支持 Opus 4.6/Sonnet 4.5 选模型，App Store #3 |
| **Claude in Chrome** | Anthropic | Chrome 扩展 | ✅ 复用用户 Chrome 会话 | 实时看/读/操作网页，与 Claude Code CLI 联动，注入防御 11.2%，需 Max 订阅 |
| **Gemini in Chrome** | Google | Chrome 内置 | ✅ 原生 Google 账号 | 深度 Google 生态集成（Gmail/Calendar/Maps），"Auto Browse" 自主浏览，需 AI Pro 订阅 |
| **Manus Browser Operator** | Manus AI (Meta) | Chrome/Edge 扩展 | ✅ 核心设计，复用本地会话 | 云端推理 + 本地浏览器执行，绕过 Bot 检测，每次需用户授权 |
| **Google Project Mariner** | DeepMind | Chrome 扩展（研究） | ✅ 用户 Chrome 中运行 | Gemini 2.0 驱动，WebVoyager 83.5%，Observe-Plan-Act，支持 10 并发任务，正并入 DeepMind 核心 |

**行业趋势观察**：
- **"AI 即浏览器"** — Comet 代表的方向：AI 不是浏览器的插件，而是浏览器本身
- **"扩展模式"** — Claude/Gemini/Manus 的方式：通过 Chrome 扩展复用用户真实登录态，最简单解决认证问题
- **"云推理 + 本地执行"** — Manus 的混合架构：推理在云端，操作在本地浏览器，兼顾安全和能力

#### Benchmark 领先者（研究/前沿方案）

| 项目 | Stars | WebVoyager | WebArena | 架构特点 |
|------|-------|-----------|----------|---------|
| **Surfer 2** (H Company) | CLI 158 | **97.1%** | ✅ | 跨平台（桌面/Web/移动），ReAct + 层级上下文，超越人类表现 |
| **Magnitude** (sagekit) | 4K | **93.9%** | — | 视觉优先，双 Agent（Planner + Executor/Moondream），内置测试框架 |
| **Skyvern 2.0** | 21K | **85.85%** | — | Planner/Actor/Validator，Route Memorization 编译加速 |
| **Project Mariner** | 研究 | **83.5%** | — | Gemini 2.0，Observe-Plan-Act，Teach & Repeat |
| **OpAgent** (CodeFuse/蚂蚁) | 207 | — | **71.6%** | Planner/Grounder/Reflector/Summarizer，Agentic RL 强化学习 |
| **ColorBrowserAgent** | 20 | — | **71.2%** | Progressive Progress Summarization，Human-in-the-Loop |
| **SeeAct** (OSU NLP) | 842 | 研究基线 | — | ICML 2024，GPT-4V + Set of Marks 视觉定位 |

---

## 四、吸收内化方案

### 4.1 MCP SDK → MCPClient 实现

**吸收重点**：MCP Python SDK 提供了标准的 Server/Client 实现，Quilin 需要实现一个 MCPClient，连接任意外部 MCP Server，自动把远端工具发现并注册到 ToolRegistry。

关键学习点：
- `mcp.ClientSession` 的 `initialize()` + `list_tools()` + `call_tool()` 三步调用模式
- 支持 `stdio`（本地进程）和 `sse`（远程 HTTP）两种 transport
- 工具 schema 格式：MCP 返回的 `inputSchema` 即标准 JSON Schema，可直接用于 Function Calling
- 错误处理：MCP 定义了标准的 `McpError` 类型（工具不存在、参数无效、执行失败）
- 实现 `MCPToolAdapter`，将 MCP 工具包装为 `Tool Protocol`，让 ToolRouter 无感知差异

### 4.2 browser-use → BrowserProvider 主力实现

**吸收重点**：browser-use 的混合 DOM + Vision 策略和会话管理是 BrowserProvider 的核心蓝图。

关键学习点：
- `BrowserContext.get_state()` 返回 DOM 树 + 截图两种表示，优先用 DOM（token 少），DOM 解析失败再用截图
- `Agent` 类的 `run(task)` 封装了完整的感知-规划-执行循环，可直接继承扩展
- `storage_state` 机制：序列化 Playwright 的 `BrowserContext` 状态到 JSON，实现 Cookie/localStorage 持久化
- `keep_alive=True`：浏览器实例跨任务复用，避免反复冷启动
- 内置 TOTP：参考 `browser_use/browser/context.py` 中的 2FA 处理逻辑
- 集成 MCP Server：`uvx browser-use --mcp` 暴露为 MCP 工具，Harness 可通过 MCPClient 接入

### 4.3 Playwright → 浏览器操作底层引擎

**吸收重点**：Playwright 是所有主流浏览器框架的底层依赖，Quilin 需要深度掌握其 Python API。

关键学习点：
- `Page` / `Locator` API：`page.locator("css=button")` 封装为 `BrowserClickTool`
- `Page.accessibility.snapshot()` — 获取 A11y Tree，比 `page.content()` 节省 60-80% token
- `BrowserContext.storage_state(path)` — 标准 Cookie/Storage 导出格式，多框架通用
- `Page.screenshot(type="webp", quality=80)` — 压缩截图降低 token 成本
- CDP Session：`page.context.new_cdp_session(page)` — 直接访问低层 Chrome DevTools 协议
- Pytest-playwright：自动重试、并行测试，可用于浏览器工具的集成测试

### 4.4 Crawl4AI → WebFetchTool 异步爬取

**吸收重点**：Crawl4AI 的核心贡献是把网页转为 LLM 友好的 Markdown 格式，并支持高效异步批量抓取。

关键学习点：
- `AsyncWebCrawler.arun(url)` 异步接口，支持并发批量抓取（`arun_many(urls)`）
- `BrowserConfig` + `CrawlerRunConfig`：分离浏览器配置和单次爬取配置
- `LLMExtractionStrategy`：配置 LLM 从页面提取结构化数据，指定 schema → 输出 JSON
- `MarkdownGenerationStrategy`：清理 HTML，去除 nav/footer/广告，输出干净 Markdown
- `CacheMode`：内置 SQLite 缓存，相同 URL 不重复请求
- 集成到 `WebFetchTool`：URL → Crawl4AI → Markdown → 回填上下文，大幅减少 token 消耗

### 4.5 Stagehand → AI 原生操作 API 设计

**吸收重点**：Stagehand 的 `act/extract/observe` 三步式 API 设计是 AI 原生浏览器操作的最佳实践，值得 BrowserProvider 借鉴。

关键学习点：
- `page.act("点击登录按钮")` — 自然语言指令，内部用 LLM 解析意图再执行 DOM 操作
- `page.extract({ schema })` — 声明式结构化提取，输入 Zod/JSON Schema → 输出类型安全对象
- `page.observe()` — 分析当前页面状态，返回可能的操作列表（用于规划）
- 三步分离的好处：observe 成本低（只分析），extract 中等（精准提取），act 最高（需要执行）
- `Browserbase Contexts`：云端持久化会话，`context.persist: true` 跨会话保留登录态
- Python SDK（`stagehand-python`）：与 Harness 的 Python 生态对齐

---

## 五、与 Harness 组件映射

### 5.1 组件映射表

| 组件 | 文件路径 | 接口 | 状态 |
|------|---------|------|------|
| Tool Protocol | `quilin/tools/base.py` | `Tool` Protocol + `ToolCategory` 枚举 | 待实现 |
| ToolRegistry | `quilin/tools/base.py` | 注册/发现/语义搜索/按类别过滤 | 待实现 |
| ToolRouter | `quilin/core/Harness.py` | 4 类动作路由，`invoke(name, params)` | 骨架已有 |
| MCPClient | `quilin/mcp/client.py` | 连接外部 MCP Server，stdio/SSE | 待实现 |
| MCPBus | `quilin/mcp/bus.py` | 层间 MCP 通信总线 | 骨架已有 |
| BrowserProvider | `quilin/browser/provider.py` | 浏览器操作 + 多级路由 | 待实现 |
| SessionManager | `quilin/browser/session.py` | 会话管理、Cookie、2FA | 待实现 |
| SandboxExecutor | `quilin/sandbox/executor.py` | Docker 沙箱 + 工具自创注册 | 待实现 |

### 5.2 完整 Protocol 伪代码

```python
# quilin/tools/base.py

from typing import Protocol, runtime_checkable
from enum import Enum
from dataclasses import dataclass

class ToolCategory(Enum):
    PROGRAMMATIC = "programmatic"
    INTERACTIVE  = "interactive"
    CONTROL      = "control"
    GUI          = "gui"

@dataclass
class ToolResult:
    success: bool
    data: object
    error: str | None = None
    cost_tokens: int  = 0
    metadata: dict    = None

@runtime_checkable
class Tool(Protocol):
    name: str
    description: str
    parameters: dict        # JSON Schema
    category: ToolCategory

    async def execute(self, params: dict, ctx: "ExecutionContext") -> ToolResult: ...
    def validate_params(self, params: dict) -> bool: ...

class ToolRegistry:
    _tools: dict[str, Tool]

    def register(self, tool: Tool) -> None: ...
    async def discover_mcp(self, endpoint: str) -> list[Tool]: ...
    def find(self, name: str) -> Tool | None: ...
    def filter_by_category(self, cat: ToolCategory) -> list[Tool]: ...
    async def search(self, query: str, top_k: int = 10) -> list[Tool]: ...
    def list_schemas(self) -> list[dict]: ...   # 用于系统提示

# quilin/core/Harness.py（ToolRouter 部分）

class ToolRouter:
    registry: ToolRegistry
    mcp_bus: MCPBus

    async def invoke(
        self,
        tool_name: str,
        params: dict,
        ctx: ExecutionContext,
    ) -> ToolResult:
        tool = self.registry.find(tool_name)
        if tool is None:
            raise ToolNotFoundError(tool_name)

        # 安全检查：是否超出允许的 category
        if tool.category not in ctx.allowed_categories:
            raise PermissionError(f"{tool.category} 未授权")

        # 高危操作确认
        if ctx.require_confirmation and tool.category == ToolCategory.GUI:
            await self._ask_user_confirm(tool_name, params)

        return await tool.execute(params, ctx)
```

### 5.3 性能约束

| 操作 | 目标延迟 | 说明 |
|------|---------|------|
| ToolRegistry.find() | < 1ms | 哈希表查找 |
| ToolRegistry.search() | < 100ms | 嵌入向量近似搜索 |
| MCPClient.call_tool() | < 500ms | 网络调用 + 执行 |
| SandboxExecutor.execute() | < 30s | 含超时控制 |
| BrowserProvider.browse() | < 60s | 含页面加载等待 |
| SessionManager.load() | < 200ms | 本地 JSON 读取 |

---

## 六、验证标准

### 6.1 单元测试

**Tool Protocol 合规性：**
```python
def test_tool_protocol_compliance():
    """所有内置工具必须实现 Tool Protocol"""
    tools = [ReadFileTool(), BashTool(), WebSearchTool(), AskUserTool()]
    for tool in tools:
        assert isinstance(tool, Tool)
        assert tool.name and tool.description
        assert isinstance(tool.parameters, dict)
        assert isinstance(tool.category, ToolCategory)

def test_tool_validate_params():
    """工具参数校验必须在执行前拦截非法输入"""
    tool = BashTool()
    assert tool.validate_params({"command": "ls -la"}) is True
    assert tool.validate_params({}) is False            # 缺少必填参数
    assert tool.validate_params({"command": ""}) is False  # 空命令
```

**ToolRegistry 注册/发现/过滤：**
```python
async def test_registry_register_and_find():
    registry = ToolRegistry()
    tool = ReadFileTool()
    registry.register(tool)
    found = registry.find("read_file")
    assert found is tool

async def test_registry_filter_by_category():
    registry = ToolRegistry()
    for t in [ReadFileTool(), BashTool(), BrowserClickTool(), AskUserTool()]:
        registry.register(t)
    gui_tools = registry.filter_by_category(ToolCategory.GUI)
    assert all(t.category == ToolCategory.GUI for t in gui_tools)

async def test_registry_semantic_search():
    registry = ToolRegistry()
    # 注册 10+ 工具后，语义搜索应返回最相关的
    results = await registry.search("读取文件内容", top_k=3)
    assert any(t.name == "read_file" for t in results)
```

### 6.2 集成测试

**MCP 客户端连接外部 Server：**
```python
async def test_mcp_client_connect_and_discover():
    """连接 Playwright MCP Server，发现浏览器工具"""
    client = MCPClient()
    await client.connect("stdio", "npx playwright-mcp --headless")
    tools = await client.list_tools()
    assert len(tools) > 0
    assert any("browser" in t.name for t in tools)
    await client.disconnect()

async def test_mcp_tool_registration():
    """MCP 工具可以注册到 ToolRegistry 并正常调用"""
    registry = ToolRegistry()
    client = MCPClient()
    await client.connect("stdio", "npx playwright-mcp --headless")
    await registry.discover_mcp(client)
    tool = registry.find("browser_navigate")
    assert tool is not None
    result = await tool.execute({"url": "https://example.com"}, ctx)
    assert result.success
```

**浏览器 SessionManager：**
```python
async def test_session_save_and_restore():
    """Cookie 导出后重新加载，登录态保持"""
    manager = SessionManager()
    await manager.save("test_session", "/tmp/session.json")
    await manager.load("test_session", "/tmp/session.json")
    # 验证加载后的 context 包含 Cookie
    assert manager.get_context("test_session").cookies

async def test_bash_tool_timeout():
    """Bash 工具超时必须抛出异常而非阻塞"""
    tool = BashTool()
    result = await tool.execute(
        {"command": "sleep 100", "timeout": 2},
        ctx,
    )
    assert not result.success
    assert "timeout" in result.error.lower()
```

### 6.3 端到端测试

**文件读取任务：**
```bash
# 验证 Agent 能调用 ReadFileTool 完成文件读取和摘要任务
python -m quilin "读取 README.md 并用一段话总结项目是什么"
# 期望：输出中包含 Quilin Agent 的核心描述
```

**浏览器抓取任务：**
```bash
# 验证 BrowserProvider 能打开网页并提取内容
python -m quilin "打开 https://example.com，截图并描述页面内容"
# 期望：输出包含 "Example Domain" 相关描述
```

**MCP 工具调用任务：**
```bash
# 验证通过 MCP 协议发现并调用工具
python -m quilin --mcp-server "npx playwright-mcp" \
  "用浏览器访问 https://github.com 并返回页面标题"
# 期望：输出 "GitHub: Let's build from here"
```

**工具自创任务（Phase 4）：**
```bash
# 验证 Agent 能发现能力缺口，自己编写工具并注册
python -m quilin "处理这个 Excel 文件 data.xlsx，统计每列的均值"
# 期望：Agent 自动 pip install openpyxl，编写解析脚本，注册为 ExcelReadTool，执行并返回结果
```

### 6.4 实现状态追踪

#### 工具核心

| 维度 | 当前状态 | 待实现 | Phase |
|------|---------|--------|-------|
| 工具发现 | PluginRegistry 静态注册 | 加 MCP 动态发现 + 按需加载 | P2 |
| 工具描述 | 未实现 | JSON Schema + token 预算控制 | P2 |
| 工具编排 | 简单顺序执行 | 并行/条件/循环编排 | P2 |
| 结果处理 | 原样返回 | 裁剪、格式转换、缓存 | P2 |
| 工具安全 | 未实现 | 读写分级 + 人类确认 + 限流 | P2 |
| Function Calling | 未实现 | 主力调用方式 | P2 |
| MCP 协议 | MCPBus 骨架已有 | MCPClient 完整实现 | P2 |
| Code Executor | 未实现 | Python/Node 沙箱 | P3 |
| Computer Use | 未实现 | 可选，优先级最低 | P4 |
| ReAct Parser | 未实现 | 兜底兼容老模型 | P3 |
| API Gateway | 未实现 | OpenAPI schema 驱动 | P3 |

#### 浏览器使用

| 能力 | 当前状态 | 待实现 | Phase |
|------|---------|--------|-------|
| SimpleFetch | 未实现 | requests + Firecrawl/Jina Reader | P2 |
| BrowserUseAgent | 未实现 | browser-use 集成，主力浏览器方案 | P3 |
| PlaywrightMCP | 未实现 | MCP Server 接入，A11y Tree 模式 | P2 |
| SteelBrowser | 未实现 | Docker 自托管 + Cloud 切换 | P3 |
| SkyvernVisual | 未实现 | 视觉模式兜底 | P4 |
| StagehandTS | 未实现 | TypeScript 场景可选 | P4 |
| SessionManager | 未实现 | 统一会话管理 | P3 |
| ProfileStore | 未实现 | 本地 Chrome + 持久化目录 + 云 Profile | P3 |
| StorageState | 未实现 | Cookie/localStorage JSON 导入导出 | P3 |
| CredentialManager | 未实现 | 加密凭证存储 + TOTP 2FA | P3 |
| SessionHealing | 未实现 | 过期检测 + 自动重登 + 人工接管 | P4 |
| AntiDetection | 未实现 | 指纹管理 + 代理轮换 + 隐身模式 | P4 |
| BrowserRouter | 未实现 | 根据任务自动选择浏览器策略 | P3 |

#### 执行沙箱

| 能力 | 当前状态 | 待实现 | Phase |
|------|---------|--------|-------|
| SandboxExecutor | 未实现 | Docker 容器隔离 | P3 |
| 代码执行 | 未实现 | Python/Node 沙箱运行 | P3 |
| 依赖安装 | 未实现 | pip/npm 包安装 | P3 |
| 工具自创 | 未实现 | Agent 自写工具注册到 ToolRouter | P4 |
| 资源限制 | 未实现 | CPU/内存/时间限制 | P3 |
| E2B/Modal 集成 | 未实现 | 托管云沙箱可选 | P4 |
