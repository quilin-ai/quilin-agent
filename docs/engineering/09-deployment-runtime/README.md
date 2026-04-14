# 部署运行时工程（Deployment & Runtime Engineering）

> 本文档是 Quilin Agent 工程规格系列的第 9 篇，定义部署运行时层的设计方案、参考来源与验证标准。
>
> **ADR-001 对齐说明**：旧路径 `quilin/plugins/deploy/` 已删除。本文档中的 Python 代码示例仅表达设计意图，实施时将以 TS 重写。`quilin/` 路径为规划参考。详见 [ADR-001](../../adr/adr-001-core-loop-and-language.md)。
>
> **热更新需求**：Agent 必须支持热更新 + 更新后主动告知用户变更内容，解决 OpenClaw/Hermes 更新断连痛点。详见记忆记录。

---

## 一、问题定义

### 1.1 Agent 代码执行的安全隔离需求

Quilin Agent 的核心能力之一是让 Agent 能够编写并运行代码来完成任务：生成 Python 脚本分析数据、执行 shell 命令验证系统状态、运行 JavaScript 片段处理 JSON。然而，**Agent 生成的代码本质上是不可信代码**，直接在宿主进程执行将引入严重的安全风险：

| 风险类别 | 具体场景 | 危害等级 |
|----------|---------|---------|
| 文件系统破坏 | `rm -rf /`、覆盖关键配置 | 致命 |
| 数据泄露 | 读取 `~/.ssh/`、环境变量中的密钥 | 高危 |
| 网络滥用 | 向外部 IP 发送请求、DDoS 攻击 | 高危 |
| 资源耗尽 | 无限循环消耗 CPU、内存炸弹 | 中危 |
| 进程逃逸 | 利用内核漏洞提权 | 高危 |
| 依赖污染 | 安装恶意包污染宿主环境 | 中危 |

**核心安全要求**：
- Agent 生成的代码必须在隔离边界内执行，不得直接访问宿主文件系统的任意路径
- 网络访问必须可配置（默认禁止外网）
- 执行时间、内存、CPU 必须有硬性上限
- 执行完毕后隔离环境必须被彻底销毁

### 1.2 本地开发 vs 生产部署的不同约束

同一套 Agent 框架需要在两个截然不同的环境中运行：

**本地开发环境**：
- 开发者希望快速迭代，不愿等待容器拉取
- 可以接受相对宽松的安全策略（已知信任的代码）
- 需要访问本地文件系统方便调试
- Docker 不一定可用（轻量笔记本、CI 环境）
- 优先考虑：**启动速度 > 安全隔离**

**生产部署环境**：
- 多租户场景，不同用户的 Agent 在同一宿主机运行
- 必须严格隔离，任何逃逸都是严重事故
- 可接受更高的启动延迟换取更强的安全保证
- 资源配额必须精确，防止一个 Agent 拖垮整个系统
- 优先考虑：**安全隔离 > 启动速度**

框架需要同一套 `Sandbox` 协议，在不同环境下自动选择合适的后端实现。

### 1.3 CLI 交互设计的用户体验

用户与 Quilin Agent 的交互方式决定了其使用体验。三种典型场景的需求各不相同：

**单次命令模式**（Headless）：
```bash
python -m quilin "分析 data.csv 并找出异常值"
```
用户期望：执行完毕后立即退出，适合脚本集成和 CI/CD

**交互式会话模式**（REPL）：
```bash
python -m quilin
>>> 帮我读取 ./logs/ 下的所有错误日志
>>> 好，现在统计每种错误的出现频次
```
用户期望：持续对话，上下文保持，历史可滚动查看

**后台守护进程模式**（Daemon）：
```bash
python -m quilin --daemon --port 8080
```
用户期望：以 HTTP API 服务形式运行，供其他系统调用

三种模式共用同一个核心 `Quilin` 对象，仅入口层不同。

### 1.4 配置管理的多维度需求

Agent 框架的可配置维度极广：

- **模型选择**：主模型、备用模型、各层 Provider 的模型偏好
- **工具启用/禁用**：哪些工具可用，哪些被安全策略禁止
- **安全策略**：沙箱类型、网络访问权限、文件系统白名单
- **记忆系统**：各层记忆的容量、TTL、后端选择
- **可观测性**：日志级别、追踪采样率、指标导出目标
- **资源配额**：CPU、内存、磁盘、执行超时

这些配置需要支持：
1. **分层覆盖**：CLI 参数覆盖环境变量，环境变量覆盖配置文件，配置文件覆盖代码默认值
2. **运行时热更新**：部分配置（如日志级别）无需重启即可生效
3. **敏感配置隔离**：API Key 等机密信息只从环境变量读取，永远不写入 yaml 文件

---

## 二、设计方案

### 2.1 沙箱架构总览

```
Agent 生成代码（str）
        │
        ▼
┌──────────────────────────────┐
│       SandboxRouter          │  根据环境探测选择沙箱实现
│  - 探测 Docker daemon 可用性  │
│  - 读取配置中 sandbox.type    │
│  - 返回对应 Sandbox 实例      │
└──────────┬───────────────────┘
           │
           ├── sandbox.type == "docker" 且 Docker 可用？
           │       │
           │       └──→ DockerSandbox
           │               ├── 网络模式：none（默认）/ bridge（受限）
           │               ├── 文件系统：只读挂载代码，读写挂载 /tmp
           │               ├── CPU 配额：nano_cpus（默认 1 core）
           │               ├── 内存上限：mem_limit（默认 512MB）
           │               ├── 磁盘写入：storage-opt（默认 1GB）
           │               └── 执行超时：全局 300s + 单命令 60s
           │
           ├── sandbox.type == "local" 或 Docker 不可用？
           │       │
           │       └──→ LocalSandbox（降级方案）
           │               ├── asyncio.wait_for + subprocess
           │               ├── tempfile.mkdtemp() 隔离工作目录
           │               ├── 清洗敏感环境变量（API_KEY、TOKEN 等）
           │               └── 警告：非真实沙箱，仅用于受信任环境
           │
           └── sandbox.type == "cloud" 且配置了 API Key？
                   │
                   └──→ CloudSandbox（可选扩展）
                           ├── E2B Sandbox API
                           ├── Modal Function（按需实例化）
                           └── Daytona Workspace API
```

### 2.2 DockerSandbox 详细设计

DockerSandbox 是生产推荐的沙箱实现，基于 Docker SDK for Python（docker-py）构建。

**容器生命周期**：

```
create_container()
    │  ├── 选择基础镜像（python:3.11-slim / node:20-slim / golang:1.22）
    │  ├── 设置资源限制（CPU、内存、磁盘）
    │  ├── 配置网络模式（none / bridge）
    │  ├── 挂载文件系统（只读代码 + 读写临时目录）
    │  └── 返回 Container 对象
    │
start_container()
    │  └── container.start()，等待 Running 状态
    │
execute(code, language, timeout)
    │  ├── 写入代码到临时文件（容器内 /tmp/）
    │  ├── container.exec_run(f"python /tmp/code.py", timeout=timeout)
    │  └── 捕获 stdout / stderr / exit_code
    │
cleanup()
    │  ├── container.stop(timeout=5)
    │  └── container.remove(force=True)
```

**镜像管理策略**：
- 预构建语言基础镜像，存入本地 registry 避免每次拉取
- 镜像命名约定：`quilin/sandbox-python:3.11`、`quilin/sandbox-node:20`
- 启动前检查镜像是否存在，不存在则触发 pull（有超时保护）
- 支持自定义镜像（`config.sandbox.docker.custom_image`）

**网络隔离策略**：

| 模式 | Docker 参数 | 适用场景 |
|------|-----------|---------|
| `none`（默认） | `network_mode="none"` | 纯计算任务，不需要网络 |
| `restricted` | 自定义 bridge + iptables 规则 | 需要访问特定内部服务 |
| `full`（不推荐） | `network_mode="bridge"` | 调试模式，需要外网访问 |

**资源配额配置**：

```yaml
sandbox:
  docker:
    mem_limit: "512m"          # 内存上限
    nano_cpus: 1_000_000_000   # 1 个 CPU core
    pids_limit: 256            # 最大进程数
    storage_opt:
      size: "1G"               # 磁盘写入上限
    read_only_rootfs: true     # 根文件系统只读
    cap_drop: ["ALL"]          # 丢弃所有 Linux capabilities
    security_opt:
      - "no-new-privileges"    # 禁止提权
```

### 2.3 LocalSandbox 降级方案

当 Docker 不可用时（纯 Python 环境、受限 CI）自动降级为 LocalSandbox。
**明确声明**：LocalSandbox 不提供真实的安全隔离，仅适用于开发阶段或已信任的代码执行。

**实现细节**：
```python
async def execute(self, code: str, language: str, timeout: int) -> ExecutionResult:
    # 1. 在临时目录创建隔离工作区
    workdir = tempfile.mkdtemp(prefix="omni_sandbox_")

    # 2. 清洗危险环境变量
    env = {k: v for k, v in os.environ.items()
           if not any(k.startswith(p) for p in SENSITIVE_PREFIXES)}

    # 3. 写入代码文件
    code_file = Path(workdir) / f"code.{LANG_EXT[language]}"
    code_file.write_text(code)

    # 4. 带超时执行
    proc = await asyncio.create_subprocess_exec(
        LANG_CMD[language], str(code_file),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=workdir, env=env
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise SandboxTimeoutError(f"Execution exceeded {timeout}s")
    finally:
        # 5. 清理临时目录
        shutil.rmtree(workdir, ignore_errors=True)
```

敏感前缀白名单（`SENSITIVE_PREFIXES`）：`ANTHROPIC_`, `OPENAI_`, `AWS_`, `GOOGLE_`, `GITHUB_TOKEN`, `DATABASE_URL` 等。

### 2.4 CLI 入口设计

CLI 入口位于 `quilin/__main__.py`，支持三种运行模式：

**模式一：单次执行（默认）**
```bash
python -m quilin "What is 2+2?"
python -m quilin --model claude-opus-4 --max-steps 10 "分析这份报告"
```
行为：初始化 Harness → 执行单轮 → 打印结果 → 退出（exit code 0/1）

**模式二：交互式 REPL**
```bash
python -m quilin                 # 无参数时自动进入交互模式
python -m quilin --interactive   # 显式指定
```
行为：显示欢迎信息 → readline 支持的输入循环 → `exit`/`Ctrl-D` 退出
支持：多行输入（`\` 续行）、历史记录持久化（`~/.quilin_history`）、会话 ID 显示

**模式三：守护进程 / API Server**
```bash
python -m quilin --daemon --port 8080 --workers 4
```
行为：启动 FastAPI 服务 → 暴露 `/v1/chat`、`/v1/sessions`、`/health` 端点 → 前台运行直到 SIGTERM

**参数体系**（基于 `argparse`）：

```
python -m quilin [OPTIONS] [PROMPT]

执行控制:
  --model MODEL          使用的 LLM 模型（覆盖 config.yaml）
  --temperature FLOAT    生成温度（0.0-2.0）
  --max-steps INT        最大步骤数（防止死循环）
  --timeout INT          单次工具调用超时秒数

安全策略:
  --permission-level LEVEL   none/minimal/standard/full
  --sandbox-type TYPE        docker/local/cloud
  --no-network               强制禁止沙箱内网络访问

运行模式:
  --interactive / -i         交互式 REPL 模式
  --daemon                   守护进程模式
  --port INT                 守护进程监听端口（默认 8080）
  --workers INT              并发 worker 数量

会话管理:
  --session-id ID            恢复指定会话
  --new-session              强制创建新会话（不恢复）

输出控制:
  --output-format FORMAT     text/json/markdown
  --verbose / -v             详细日志
  --log-level LEVEL          DEBUG/INFO/WARNING/ERROR
```

### 2.5 配置管理设计

**config.yaml 完整结构**：

```yaml
# quilin/config.yaml
version: "1.0"

llm:
  default_model: "claude-sonnet-4-6"
  fallback_model: "claude-haiku-4-5"
  temperature: 0.7
  max_tokens: 8192
  thinking:
    enabled: true
    budget_tokens: 10000

memory:
  short_term:
    max_tokens: 4096
  mid_term:
    backend: "hindsight"
    reflection_interval: 5  # 每 5 轮触发一次 reflect
  long_term:
    backend: "mem0"
    index: "quilin-{session_id}"
  ultra_long:
    backend: "gbrain"
    sync_interval: 3600

sandbox:
  type: "docker"            # docker / local / cloud
  timeout_global: 300       # 秒
  timeout_per_command: 60
  docker:
    image_python: "quilin/sandbox-python:3.11"
    image_node: "quilin/sandbox-node:20"
    mem_limit: "512m"
    nano_cpus: 1_000_000_000
    network_mode: "none"    # none / restricted / full
  cloud:
    provider: "e2b"         # e2b / modal / daytona
    # API key 只从环境变量读取，不写此处

tools:
  enabled:
    - file_read
    - file_write
    - code_execute
    - web_search
  disabled:
    - shell_exec_raw        # 需要更高权限才能启用

observability:
  log_level: "INFO"
  tracing:
    enabled: true
    backend: "otlp"
    endpoint: "http://localhost:4317"
  metrics:
    enabled: true
    port: 9090

session:
  storage: "sqlite"
  db_path: "~/.quilin/sessions.db"
  max_history_tokens: 32000
  auto_save_interval: 30    # 秒

# 空闲自进化配置（详细定义见 10-self-evolution 2.12 + config.yaml）
idle_evolution:
  enabled: true
  mode: "api"                    # "subscription" | "api"
  min_idle_minutes: 30           # 用户至少空闲 N 分钟才触发
  allowed_hours: "08:00-23:00"   # 允许运行的时间窗口
  api:
    daily_budget_tokens: 100000  # 每日自进化 token 上限
```

**配置加载优先级**（从高到低）：

```
CLI 参数（--model gpt-4o）
    > 环境变量（OMNI_LLM_DEFAULT_MODEL=gpt-4o）
        > config.yaml（llm.default_model: gpt-4o）
            > 代码内置默认值（claude-sonnet-4-6）
```

**环境变量映射约定**：
- 前缀：`OMNI_`
- 路径分隔：`_`（对应 yaml 中的 `.`）
- 示例：
  - `OMNI_LLM_DEFAULT_MODEL` → `config.llm.default_model`
  - `OMNI_SANDBOX_TYPE` → `config.sandbox.type`
  - `OMNI_MEMORY_MID_TERM_BACKEND` → `config.memory.mid_term.backend`
- API Key 专用环境变量（不遵循前缀约定）：
  - `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`E2B_API_KEY`

**运行时热更新**支持项：
- `log_level`：通过 `PUT /admin/config` API 动态修改
- `tools.enabled/disabled`：会话级别可临时调整
- `llm.temperature`：每轮调用可单独覆盖
- `idle_evolution.enabled/mode/daily_budget_tokens`：空闲自进化开关和预算可实时调整
- `progress_reporting.*`：进度汇报配置（心跳间隔、IM 推送开关）可实时调整

### 2.6 会话管理设计

**SessionManager** 负责会话的完整生命周期：

```
创建会话
  └── 生成 UUID session_id
  └── 初始化空的对话历史、记忆快照
  └── 持久化到 SQLite（sessions.db）
  └── 返回 Session 对象

恢复会话
  └── 从 SQLite 读取 session_id 对应记录
  └── 反序列化对话历史
  └── 恢复记忆状态（短期直接加载，中长期延迟加载）
  └── 返回 Session 对象

销毁会话
  └── 触发记忆持久化（flush to long-term）
  └── 删除 SQLite 记录
  └── 清理关联的沙箱资源

列出会话
  └── 返回所有会话的摘要（id、创建时间、最后活跃、轮次数）
```

**多会话隔离保证**：
- 不同会话的沙箱容器完全独立，共享文件系统挂载使用不同前缀的 tmpdir
- 记忆系统按 `session_id` 命名空间隔离（Mem0 的 `user_id` / 向量库的 namespace）
- 浏览器 Cookie 持久化：每个会话维护独立的 browser profile 目录

**SQLite 会话表结构**：

```sql
CREATE TABLE sessions (
    session_id    TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    config_json   TEXT,              -- SessionConfig 快照
    history_json  TEXT,             -- 压缩的对话历史
    memory_json   TEXT,             -- 短期记忆快照
    metadata_json TEXT              -- 自定义元数据
);
```

### 2.7 核心接口定义

```python
# quilin/layers/deploy/protocol.py

from typing import Protocol, runtime_checkable
from dataclasses import dataclass

@dataclass
class ExecutionResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: float
    resource_usage: dict          # {"cpu_percent": 45.2, "mem_mb": 128}

@dataclass
class CommandResult:
    exit_code: int
    output: str
    duration_ms: float

@dataclass
class SessionConfig:
    session_id: str
    model: str
    permission_level: str
    sandbox_type: str
    tools_enabled: list[str]
    custom_config: dict

@dataclass
class SessionInfo:
    session_id: str
    created_at: int
    updated_at: int
    turn_count: int
    model: str

@dataclass
class Session:
    config: SessionConfig
    history: list[dict]
    metadata: dict

@runtime_checkable
class Sandbox(Protocol):
    """所有沙箱实现必须遵循此协议"""

    async def execute(
        self,
        code: str,
        language: str,          # "python" / "javascript" / "bash"
        timeout: int = 60,
        env: dict | None = None
    ) -> ExecutionResult: ...

    async def execute_command(
        self,
        command: str,
        timeout: int = 30,
        cwd: str | None = None
    ) -> CommandResult: ...

    async def upload_file(
        self,
        local_path: str,
        sandbox_path: str
    ) -> None: ...

    async def download_file(
        self,
        sandbox_path: str
    ) -> bytes: ...

    async def list_files(
        self,
        sandbox_path: str = "/"
    ) -> list[str]: ...

    async def cleanup(self) -> None: ...

    @property
    def sandbox_id(self) -> str: ...

    @property
    def is_alive(self) -> bool: ...


@runtime_checkable
class SessionManager(Protocol):
    """会话管理器协议"""

    async def create_session(
        self,
        config: SessionConfig
    ) -> Session: ...

    async def resume_session(
        self,
        session_id: str
    ) -> Session: ...

    async def save_session(
        self,
        session: Session
    ) -> None: ...

    async def destroy_session(
        self,
        session_id: str
    ) -> None: ...

    async def list_sessions(
        self,
        limit: int = 50,
        offset: int = 0
    ) -> list[SessionInfo]: ...


@runtime_checkable
class SandboxRouter(Protocol):
    """沙箱路由器协议：根据环境选择合适的沙箱实现"""

    async def get_sandbox(
        self,
        session_id: str,
        language: str
    ) -> Sandbox: ...

    async def release_sandbox(
        self,
        sandbox_id: str
    ) -> None: ...
```

### 2.8 DockerSandbox 完整实现框架

```python
# quilin/plugins/deploy/docker_sandbox.py

import docker
import asyncio
import uuid
from quilin.layers.deploy.protocol import Sandbox, ExecutionResult, CommandResult

LANG_CMD = {
    "python": ["python3"],
    "javascript": ["node"],
    "bash": ["bash"],
    "go": ["go", "run"],
}

class DockerSandbox:
    """DockerSandbox：基于 docker-py 的生产级代码执行沙箱"""

    def __init__(self, config: dict):
        self._client = docker.from_env()
        self._config = config
        self._container = None
        self._sandbox_id = str(uuid.uuid4())[:8]

    async def _ensure_container(self, language: str) -> None:
        if self._container and self._container.status == "running":
            return
        image = self._config["docker"].get(
            f"image_{language}",
            f"quilin/sandbox-{language}:latest"
        )
        self._container = self._client.containers.run(
            image=image,
            detach=True,
            network_mode=self._config["docker"]["network_mode"],
            mem_limit=self._config["docker"]["mem_limit"],
            nano_cpus=self._config["docker"]["nano_cpus"],
            pids_limit=256,
            read_only=True,                      # 根文件系统只读
            tmpfs={"/tmp": "size=256m,exec"},    # 临时目录可执行
            volumes={},
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            name=f"omni-sandbox-{self._sandbox_id}",
            auto_remove=False,                   # 手动清理，保证审计
        )

    async def execute(
        self, code: str, language: str, timeout: int = 60, env: dict | None = None
    ) -> ExecutionResult:
        await self._ensure_container(language)
        import time
        # 写入代码到容器内 tmpfs
        ext = {"python": "py", "javascript": "js", "bash": "sh"}.get(language, "txt")
        code_path = f"/tmp/code_{self._sandbox_id}.{ext}"
        self._container.exec_run(
            f"sh -c 'cat > {code_path}'",
            stdin=True, socket=False
        )
        # exec 执行（带超时）
        start = time.monotonic()
        result = self._container.exec_run(
            cmd=LANG_CMD[language] + [code_path],
            environment=env or {},
            workdir="/tmp",
            demux=True,
        )
        duration_ms = (time.monotonic() - start) * 1000
        stdout, stderr = result.output or (b"", b"")
        return ExecutionResult(
            exit_code=result.exit_code,
            stdout=(stdout or b"").decode(errors="replace"),
            stderr=(stderr or b"").decode(errors="replace"),
            duration_ms=duration_ms,
            resource_usage={},
        )

    async def cleanup(self) -> None:
        if self._container:
            try:
                self._container.stop(timeout=5)
                self._container.remove(force=True)
            except Exception:
                pass
            self._container = None

    @property
    def sandbox_id(self) -> str:
        return self._sandbox_id

    @property
    def is_alive(self) -> bool:
        if not self._container:
            return False
        self._container.reload()
        return self._container.status == "running"
```

---

## 三、Top 10 参考项目

### 深度分析（前 5）

#### 3.1 E2B — 云端代码沙箱基础设施

- **仓库**：[e2b-dev/code-interpreter](https://github.com/e2b-dev/code-interpreter)（Stars：2.2k+）
- **语言**：Python / TypeScript
- **定位**：专为 AI Agent 设计的云端沙箱 SDK，提供安全的代码执行环境

**核心抽象**：

```python
from e2b_code_interpreter import Sandbox

# 创建沙箱（约 200-500ms 冷启动）
with Sandbox.create() as sbx:
    # 有状态执行：变量跨调用保持
    sbx.run_code("x = 42")
    result = sbx.run_code("x * 2")   # result.text == "84"

    # 文件操作
    sbx.files.write("/tmp/data.csv", csv_content)
    output = sbx.files.read("/tmp/result.json")

    # 多语言支持
    sbx.run_code("console.log('hello')", language="javascript")
```

**架构特点**：
- **有状态执行**：基于 Jupyter Kernel，变量跨次调用保持（不像 subprocess 每次重启）
- **上下文隔离**：通过 `createCodeContext()` 创建多个独立命名空间
- **文件系统 API**：`files.list()` / `files.read()` / `files.write()` / `files.remove()`
- **WebSocket 流式输出**：实时返回 stdout/stderr，不等执行完成
- **自动沙箱生命周期**：超时自动销毁，防止资源泄露
- **Template 机制**：预构建带特定依赖的镜像（Data Analysis / Node.js 等）

**关键 API 设计**（被 Quilin 吸收）：
```
Sandbox.create()              → 统一入口，屏蔽底层细节
sbx.run_code(code, language)  → 简洁的执行接口
sbx.files.{read,write,list}() → 文件操作正交设计
sbx.commands.run(cmd)         → 命令执行独立接口
context.id                    → 上下文标识符
```

---

#### 3.2 Modal — Serverless 容器化函数平台

- **官网**：[modal.com](https://modal.com)
- **语言**：Python
- **定位**：以函数为单位的 Serverless 计算平台，擅长 GPU 工作负载

**核心抽象**：

```python
import modal

app = modal.App("omni-worker")

# 定义执行环境（Image）
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("numpy", "pandas", "scikit-learn")
    .run_commands("apt-get install -y git")
)

# 定义持久化存储（Volume）
data_volume = modal.Volume.from_name("analysis-data", create_if_missing=True)

# 函数即部署单元
@app.function(
    image=image,
    gpu="T4",                    # 按需 GPU
    timeout=600,
    volumes={"/data": data_volume},
    memory=2048,
)
def analyze_data(dataset_path: str) -> dict:
    import pandas as pd
    df = pd.read_csv(f"/data/{dataset_path}")
    return {"rows": len(df), "summary": df.describe().to_dict()}

# 调用（自动容器化，自动扩缩容）
with app.run():
    result = analyze_data.remote("sales.csv")
```

**架构特点**：
- **`@app.function` 装饰器模式**：函数即基础设施，零运维负担
- **Image 预构建**：`pip_install()` / `run_commands()` 流式构建，结果缓存
- **Volume 持久化**：跨函数调用共享数据，`commit()` + `reload()` 显式同步语义
- **GPU 按需分配**：无 GPU 空闲成本，`gpu="A10G"` 字符串声明
- **自动冷启动**：函数空闲时销毁容器，调用时重建（默认 < 500ms）
- **`keep_warm=N`**：保持 N 个热容器消除冷启动

**被 Quilin 吸收的设计**：
- Image 预构建 + 缓存机制（避免每次沙箱重建安装依赖）
- Volume 持久化存储（跨会话的长期记忆后端）
- 函数级资源声明（GPU / Memory / Timeout）

---

#### 3.3 Daytona — 开发环境即服务（沙箱平台）

- **仓库**：[daytonaio/daytona](https://github.com/daytonaio/daytona)（Stars：71k+）
- **语言**：Go（后端）/ Python + TypeScript（SDK）
- **定位**：为 AI Agent 提供完整的开发环境沙箱，支持从 DevContainer 配置一键创建

**架构分层**：
```
Interface Plane（SDK / CLI / Dashboard / MCP）
         ↓
Control Plane（API / Proxy / Snapshot Builder / Sandbox Manager）
         ↓
Compute Plane（Sandbox Runners / Sandbox Daemon / Snapshot Store）
```

**Workspace 设计**：

```python
from daytona import Daytona, CreateSandboxParams

daytona = Daytona()

# 从 DevContainer 配置创建完整开发环境
sandbox = daytona.create(CreateSandboxParams(
    language="python",
    snapshot="omni-python-3.11",   # 预制快照，秒级启动
    resources={"cpu": 2, "memory": 4096, "disk": 10240},
))

# 文件系统操作
sandbox.fs.upload_file(local_path="./data.csv", remote_path="/workspace/data.csv")
content = sandbox.fs.download_file("/workspace/result.json")

# 代码执行
result = sandbox.process.code_run("print('hello from sandbox')")

# 关闭（状态快照保存，下次秒级恢复）
sandbox.close()
```

**关键特性**：
- **Snapshot Store**：OCI-compliant 镜像 registry，存储沙箱快照实现秒级恢复
- **Sandbox Daemon（Toolbox API）**：运行在每个沙箱内的 agent runtime，提供文件/进程/网络操作接口
- **Volume 持久化**：跨沙箱共享持久存储，S3 兼容后端
- **MCP 集成**：原生支持 Model Context Protocol，AI Agent 可直接调用沙箱工具
- **Linux 命名空间隔离**：每个沙箱独立 PID/NET/FS namespace

**被 Quilin 吸收的设计**：
- Workspace 模板化（预制快照 + DevContainer 配置）
- Sandbox Daemon 模式（运行在容器内的 agent runtime）
- MCP 协议集成（与 Quilin 的 MCPBus 天然对齐）

---

#### 3.4 Docker SDK for Python（docker-py）

- **仓库**：[docker/docker-py](https://github.com/docker/docker-py)
- **语言**：Python
- **定位**：Docker Engine API 的 Python 客户端，Quilin DockerSandbox 的底层支撑

**核心 API 体系**：

```python
import docker
client = docker.from_env()

# 容器生命周期管理
container = client.containers.run(
    image="python:3.11-slim",
    command="python /tmp/code.py",
    detach=True,
    # 资源限制
    mem_limit="512m",
    nano_cpus=1_000_000_000,
    pids_limit=256,
    # 安全加固
    read_only=True,
    tmpfs={"/tmp": "size=256m"},
    cap_drop=["ALL"],
    security_opt=["no-new-privileges"],
    # 网络隔离
    network_mode="none",
    # 文件系统挂载
    volumes={
        "/host/code": {"bind": "/app/code", "mode": "ro"},
        "/host/output": {"bind": "/app/output", "mode": "rw"},
    },
)

# 容器内执行命令
exit_code, output = container.exec_run(
    cmd=["python", "/tmp/script.py"],
    environment={"PYTHONPATH": "/app"},
    workdir="/tmp",
    demux=True,         # 分离 stdout/stderr
    stream=False,
)

# 网络管理
network = client.networks.create("sandbox-net", driver="bridge", internal=True)
network.connect(container, aliases=["sandbox"])

# 清理
container.stop(timeout=5)
container.remove(force=True)
```

**关键设计决策**：
- `demux=True`：`exec_run` 返回 `(stdout_bytes, stderr_bytes)` 元组，分离输出流
- `read_only=True` + `tmpfs`：根文件系统只读，仅 `/tmp` 可写
- `cap_drop=["ALL"]`：丢弃所有 Linux capabilities，最小权限原则
- `internal=True` 网络：仅容器间互通，不出公网

---

#### 3.5 Fly.io Machines — 轻量 MicroVM 快速启停

- **官网**：[fly.io/docs/machines](https://fly.io/docs/machines/api/)
- **技术基础**：基于 Firecracker MicroVM
- **定位**：以 REST API 控制的快速启停轻量 VM，冷启动约 300ms

**Machines API 设计**：

```bash
# 创建 Machine（预先创建，存储成本极低）
POST /v1/apps/{app}/machines
{
  "config": {
    "image": "registry.fly.io/my-app:latest",
    "env": {"PYTHONPATH": "/app"},
    "resources": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 512}
  }
}

# 快速启动（300ms 冷启动目标）
POST /v1/apps/{app}/machines/{id}/start

# 暂停（状态快照到持久存储，内存保留，resume < 100ms）
POST /v1/apps/{app}/machines/{id}/suspend
POST /v1/apps/{app}/machines/{id}/start   # resume

# 停止
POST /v1/apps/{app}/machines/{id}/stop
```

**性能数据**（实测）：
- 冷启动（从 stopped 到 running）：**~300ms**（同区域）
- Suspend → Resume：**< 100ms**（内存快照恢复）
- 跨区域启动：约 150-200ms 额外网络延迟

**架构亮点**：
- **Region API Server**：每个区域运行本地 API Server，消除中心化数据库瓶颈
- **预创建 + 延迟启动**：Machine 预创建成本极低，按需启动
- **Firecracker 基础**：继承 MicroVM 的强隔离性，同时保持容器级启动速度
- **自动休眠/唤醒**：`auto_stop_machines = true` + 代理在空闲时自动休眠

**被 Quilin 吸收的设计**：
- 预分配 + 延迟启动模式（SandboxPool 预热）
- Suspend/Resume 快照（长会话沙箱状态保存）
- 300ms 冷启动目标（DockerSandbox 的优化方向）

---

### 观察分析（后 5）

#### 3.6 Firecracker（AWS）— MicroVM 基础技术

- **仓库**：[firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker)
- **语言**：Rust
- **定位**：AWS Lambda 和 Fargate 底层的 MicroVM 技术，每个进程封装一个 VM

**核心设计**：每个 Firecracker 进程运行 API 线程 + VMM 线程 + vCPU 线程，通过 KVM 实现硬件虚拟化。Jailer 进程提供最后一道防线（seccomp + cgroups + namespace）。

**Quilin 观察要点**：内存开销约 5MB/VM，启动时间 < 125ms；是 Fly.io Machines 和 Kata Containers 的底层实现；DockerSandbox 的长期升级路径。

---

#### 3.7 gVisor（Google）— 用户态内核沙箱

- **仓库**：[google/gvisor](https://github.com/google/gvisor)
- **语言**：Go
- **定位**：在用户态实现 Linux 内核的 Sentry，拦截所有系统调用

**核心防御模型**：应用的系统调用 → Sentry（用户态 Linux 内核实现）→ 受限的宿主系统调用子集。与容器共享 namespace 不同，gVisor 完全虚拟化系统调用接口。

**Quilin 观察要点**：与 Docker / containerd / Kubernetes 原生集成（`runsc` 作为 OCI runtime）；性能损耗约 10-30%（可接受的安全溢价）；Google Cloud Run 底层使用 gVisor。

---

#### 3.8 Kata Containers — 轻量 VM 容器运行时

- **仓库**：[kata-containers/kata-containers](https://github.com/kata-containers/kata-containers)（Stars：8k+）
- **语言**：Rust（runtime）
- **定位**：OCI 兼容的容器运行时，用轻量 VM 替代 namespace 隔离

**架构**：
```
Kubernetes CRI → Kata Runtime → VM（QEMU / Firecracker / Cloud-Hypervisor）
                                   └── 每个 Pod = 一个独立 VM
```

**Quilin 观察要点**：支持 QEMU / Firecracker / Cloud Hypervisor 多种 hypervisor；与现有 K8s 生态完全兼容；安全要求极高时的 DockerSandbox 替代方案。

---

#### 3.9 Nsjail（Google）— 进程级 Linux 沙箱

- **仓库**：[google/nsjail](https://github.com/google/nsjail)（Stars：3.8k+）
- **语言**：C++
- **定位**：基于 Linux namespace + cgroups + seccomp-bpf 的进程隔离工具

**核心能力**：
```bash
./nsjail \
  --mode once \                          # 单次执行
  --time_limit 10 \                      # 10 秒超时
  --rlimit_as 512 \                      # 512MB 内存
  --cgroup_mem_max $((256*1024*1024)) \  # cgroup 内存
  --cgroup_pids_max 32 \                 # 最大进程数
  --clone_newnet \                       # 新网络命名空间
  --clone_newuser \                      # 新用户命名空间
  --seccomp_policy /etc/nsjail/safe.cfg \
  -- /usr/bin/python3 /tmp/code.py
```

**Quilin 观察要点**：比 Docker 启动更快（无镜像拉取）；Kafel BPF 语言定义精细的 seccomp 策略；LocalSandbox 的安全增强备选（需要 root 权限或特权 Docker 容器）。

---

#### 3.10 Seatbelt（macOS）— macOS 沙箱配置机制

- **工具**：`sandbox-exec` + Seatbelt Profile Language（SBPL）
- **定位**：macOS 内核级访问控制，基于 deny-by-default 白名单

**SBPL 策略示例**：
```scheme
(version 1)
(deny default)                           ; 拒绝一切（默认）

; 允许读取系统必要文件
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/System/Library"))

; 允许写入临时目录
(allow file-write* (subpath "/tmp/omni_sandbox"))

; 禁止所有网络（沙箱模式）
(deny network*)

; 允许进程执行 Python
(allow process-exec* (literal "/usr/bin/python3"))
```

**Quilin 观察要点**：Claude Code 和 Codex 在 macOS 上均使用 Seatbelt；已标记为 deprecated（苹果建议改用 App Sandbox），但 `sandbox-exec` 仍可用；macOS 开发环境下 LocalSandbox 的安全增强方案（不依赖 Docker）。

---

## 四、吸收内化方案

### 4.1 E2B → CloudSandbox 的 API 设计

**核心吸收**：E2B 的 `Sandbox` API 设计极为简洁，是 Quilin `Sandbox` Protocol 的主要参照。

| E2B API | Quilin 对应 |
|---------|----------------|
| `Sandbox.create()` | `SandboxRouter.get_sandbox()` |
| `sbx.run_code(code, language)` | `Sandbox.execute(code, language, timeout)` |
| `sbx.commands.run(cmd)` | `Sandbox.execute_command(cmd, timeout)` |
| `sbx.files.write(path, content)` | `Sandbox.upload_file(local_path, sandbox_path)` |
| `sbx.files.read(path)` | `Sandbox.download_file(sandbox_path)` |
| `sbx.files.list(path)` | `Sandbox.list_files(sandbox_path)` |
| Context (`createCodeContext`) | 多语言上下文隔离 |

**关键设计决策**：
- **有状态执行**：参照 E2B 的 Jupyter Kernel 模式，同一 Session 内变量状态保持（而非每次子进程）
- **语言参数化**：`execute(code, language="python")` 而非为每种语言单独建 API
- **文件操作正交**：upload/download/list 独立于 execute，不耦合

### 4.2 Modal → 容器化函数抽象与 Volume 持久化

**核心吸收**：Modal 的 `@app.function` + `Image` + `Volume` 三元组映射到 Quilin 的沙箱预构建 + 任务执行 + 长期记忆存储。

**Image 预构建迁移**：

```python
# Modal 风格（原）
image = modal.Image.debian_slim().pip_install("pandas", "numpy")

# Quilin 等效实现
class SandboxImageBuilder:
    def build(self, requirements: list[str], base: str = "python:3.11-slim") -> str:
        """预构建包含依赖的沙箱镜像，缓存 image hash 避免重复构建"""
        image_tag = f"omni-sandbox:{hash_requirements(requirements)}"
        if not self._image_exists(image_tag):
            self._docker_build(base, requirements, image_tag)
        return image_tag
```

**Volume 持久化迁移**：
- Modal `Volume.from_name("data")` → Quilin 中的 `LongTermMemoryStore`（Mem0/gbrain）
- `volume.commit()` / `volume.reload()` → Quilin 中的 `memory.flush()` / `memory.sync()`

### 4.3 Daytona → 开发环境模板化与 MCP 集成

**核心吸收**：Daytona 的 Snapshot 机制（预制环境 + 秒级恢复）和 MCP 原生集成。

**Snapshot 机制迁移**：
- DockerSandbox 使用预构建语言基础镜像（类似 Daytona Snapshot）
- 沙箱状态暂停：通过 `docker commit` 保存容器快照（长会话场景）
- `SandboxPool`：预分配热容器，避免每次冷启动延迟

**MCP 集成迁移**：
- Daytona 的 `Sandbox Daemon（Toolbox API）` 对应 Quilin 的 `MCPBus` + `LayerProvider`
- Agent 通过 MCP 协议调用沙箱操作，而非直接调用 docker-py（解耦底层实现）

### 4.4 Docker SDK → DockerSandbox 的容器管理

**核心吸收**：docker-py 的 `containers.run()` / `exec_run()` / `networks` / `volumes` API 直接构成 `DockerSandbox` 的实现基础。

关键安全加固参数（来自 docker-py 文档深度分析）：
- `read_only=True`：根文件系统只读，防止持久化恶意代码
- `tmpfs={"/tmp": "size=256m,exec"}`：只有 tmpfs 可执行，且有大小限制
- `cap_drop=["ALL"]`：最小权限，不授予任何 Linux capability
- `security_opt=["no-new-privileges"]`：禁止 `setuid` 提权
- `pids_limit=256`：防止 fork 炸弹
- `network_mode="none"`：完全断网（默认策略）

### 4.5 Fly.io → 快速启停与 SandboxPool 预热设计

**核心吸收**：Fly.io 的 "预创建 + 延迟启动" 和 Suspend/Resume 机制。

**SandboxPool 设计**：

```python
class SandboxPool:
    """预分配热沙箱，消除冷启动延迟"""

    def __init__(self, config: dict):
        self._pool: dict[str, list[Sandbox]] = {}   # language -> [hot sandboxes]
        self._config = config

    async def warm_up(self, language: str, count: int = 2) -> None:
        """预启动 N 个沙箱等待调度"""
        for _ in range(count):
            sandbox = DockerSandbox(self._config)
            await sandbox._ensure_container(language)
            self._pool.setdefault(language, []).append(sandbox)

    async def acquire(self, language: str) -> Sandbox:
        """从热池取出沙箱，若空则创建新的"""
        if self._pool.get(language):
            return self._pool[language].pop()
        # 冷启动（目标 < 500ms）
        sandbox = DockerSandbox(self._config)
        await sandbox._ensure_container(language)
        return sandbox

    async def release(self, sandbox: Sandbox, reuse: bool = True) -> None:
        """归还沙箱（清理后放回热池或销毁）"""
        if reuse and sandbox.is_alive:
            # 清理沙箱内状态后放回池
            await sandbox.execute_command("rm -rf /tmp/*")
            language = await sandbox.detect_language()
            self._pool.setdefault(language, []).append(sandbox)
        else:
            await sandbox.cleanup()
```

**Suspend/Resume 设计**（长会话优化）：
- 长时间空闲的沙箱（> 10 分钟无操作）触发 `docker pause` 暂停
- 下次请求到来时 `docker unpause` 恢复（< 100ms）
- 超过 1 小时空闲则 `docker commit` 快照后销毁，下次从快照恢复

---

## 五、与 Harness 组件映射

### 5.1 组件映射总览

```
Quilin 运行时组件
├── quilin/
│   ├── __main__.py                 # CLI 入口（三种模式）
│   ├── config.yaml                 # 全局配置（分层覆盖）
│   ├── core/
│   │   ├── Harness.py              # Quilin 主类
│   │   ├── config.py               # ConfigLoader（解析 yaml + env）
│   │   └── session.py              # SessionManager 实现（SQLite）
│   ├── layers/
│   │   └── deploy/
│   │       ├── protocol.py         # Sandbox / SessionManager Protocol
│   │       └── router.py           # SandboxRouter（环境探测 + 路由）
│   └── plugins/
│       └── deploy/
│           ├── docker_sandbox.py   # DockerSandbox（生产推荐）
│           ├── local_sandbox.py    # LocalSandbox（降级方案）
│           ├── cloud/
│           │   ├── e2b_sandbox.py  # CloudSandbox via E2B API
│           │   ├── modal_sandbox.py# CloudSandbox via Modal
│           │   └── daytona_sandbox.py  # CloudSandbox via Daytona
│           └── pool.py             # SandboxPool（预热热池）
```

### 5.2 与 Quilin.run() 状态机的集成

```
Quilin.run() 状态机
├── verify_input
│       └── ConfigLoader.validate()     # 检查必填配置项
├── build_context
│       └── SessionManager.resume/create # 加载或创建会话
├── plan
│       └── [Planning Layer]
├── execute_tools
│       └── SandboxRouter.get_sandbox() → Sandbox.execute()
│                    ↑
│           每次工具调用按需申请沙箱（从 SandboxPool 取）
├── verify_output
│       └── Sandbox 执行结果验证
├── reflect
│       └── SessionManager.save_session() # 持久化对话历史
└── decide
        └── SandboxPool.release(sandbox)  # 归还或清理沙箱
```

### 5.3 与 MCPBus 的集成

沙箱工具通过 MCP 协议暴露给 Agent，而非直接调用 Python API：

```python
# quilin/core/mcp_tools.py

class SandboxMCPTool:
    """将 Sandbox 操作包装为 MCP Tool"""

    name = "code_execute"
    description = "在隔离沙箱中执行代码"

    async def call(self, params: dict) -> dict:
        sandbox = await self._router.get_sandbox(
            session_id=params["session_id"],
            language=params["language"]
        )
        result = await sandbox.execute(
            code=params["code"],
            language=params["language"],
            timeout=params.get("timeout", 60),
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
        }
```

### 5.4 与 LayerProvider Protocol 的关系

部署运行时层作为 `LayerProvider` 注册到 `PluginRegistry`，遵循统一接口：

```python
class DeployRuntimeProvider:
    """部署运行时层的 LayerProvider 实现"""

    layer = "deploy"
    name = "docker"
    priority = 10

    async def initialize(self, config: dict) -> None:
        self._router = SandboxRouter(config["sandbox"])
        self._pool = SandboxPool(config["sandbox"])
        await self._pool.warm_up("python", count=2)

    async def execute(self, request: LayerRequest) -> LayerResponse:
        sandbox = await self._pool.acquire(request.language)
        try:
            result = await sandbox.execute(
                code=request.code,
                language=request.language,
                timeout=request.timeout,
            )
            return LayerResponse(success=True, data=result)
        finally:
            await self._pool.release(sandbox)

    async def shutdown(self) -> None:
        await self._pool.cleanup_all()
```

---

## 六、验证标准

### 6.1 功能验证

**沙箱隔离验证**：

```python
# tests/deploy/test_sandbox_isolation.py

@pytest.mark.asyncio
async def test_file_system_isolation(sandbox: Sandbox):
    """沙箱内无法访问宿主文件系统的任意路径"""
    result = await sandbox.execute(
        code="import os; print(os.listdir('/etc'))",
        language="python"
    )
    # 宿主 /etc 不可见（容器隔离），应返回空或错误
    assert result.exit_code != 0 or "passwd" not in result.stdout

@pytest.mark.asyncio
async def test_network_isolation(sandbox: Sandbox):
    """网络隔离模式下无法访问外网"""
    result = await sandbox.execute(
        code="import urllib.request; urllib.request.urlopen('http://example.com')",
        language="python"
    )
    assert result.exit_code != 0
    assert "Network" in result.stderr or "socket" in result.stderr.lower()

@pytest.mark.asyncio
async def test_execution_timeout(sandbox: Sandbox):
    """超时强制终止"""
    with pytest.raises(SandboxTimeoutError):
        await sandbox.execute(
            code="import time; time.sleep(9999)",
            language="python",
            timeout=2
        )

@pytest.mark.asyncio
async def test_memory_limit(sandbox: Sandbox):
    """内存超限被 OOM 杀死"""
    result = await sandbox.execute(
        code="x = [0] * (1024 * 1024 * 1024)",  # 尝试分配 8GB
        language="python"
    )
    assert result.exit_code != 0   # OOM Killed

@pytest.mark.asyncio
async def test_file_upload_download(sandbox: Sandbox):
    """文件上传下载正常工作"""
    content = b"test data 12345"
    await sandbox.upload_file("/tmp/test_input.bin", content)
    result = await sandbox.execute(
        code="with open('/tmp/test_input.bin', 'rb') as f: print(len(f.read()))",
        language="python"
    )
    assert "15" in result.stdout
    downloaded = await sandbox.download_file("/tmp/test_input.bin")
    assert downloaded == content
```

**CLI 验证**：

```bash
# 单次模式：0 退出码，输出正确
python -m quilin "What is 2+2?" | grep "4"

# 守护进程模式：健康检查通过
python -m quilin --daemon &
curl http://localhost:8080/health | jq '.status == "ok"'

# 会话持久化：恢复后上下文保留
SESSION=$(python -m quilin "记住：密钥是 42" --output-format json | jq -r .session_id)
python -m quilin --session-id $SESSION "刚才的密钥是什么？" | grep "42"
```

**配置加载验证**：

```python
# tests/deploy/test_config.py

def test_cli_overrides_env():
    """CLI 参数优先级高于环境变量"""
    os.environ["OMNI_LLM_DEFAULT_MODEL"] = "gpt-4o"
    config = ConfigLoader.load(cli_args={"model": "claude-sonnet-4-6"})
    assert config.llm.default_model == "claude-sonnet-4-6"

def test_env_overrides_yaml():
    """环境变量优先级高于 yaml 文件"""
    os.environ["OMNI_SANDBOX_TYPE"] = "local"
    config = ConfigLoader.load(config_path="tests/fixtures/config.yaml")
    assert config.sandbox.type == "local"

def test_api_key_not_in_yaml():
    """API Key 不允许写在 yaml 中"""
    with pytest.raises(ConfigSecurityError):
        ConfigLoader.load(config_path="tests/fixtures/config_with_key.yaml")
```

### 6.2 性能验证

| 指标 | DockerSandbox 目标 | LocalSandbox 目标 | CloudSandbox (E2B) 目标 |
|------|-----------------|----------------|----------------------|
| 冷启动时间 | < 500ms | < 100ms | < 2000ms |
| 热启动时间（Pool）| < 50ms | < 10ms | < 200ms |
| 代码执行延迟 | < 100ms（简单代码） | < 50ms | < 300ms |
| 清理时间 | < 200ms | < 50ms | < 500ms |
| 并发沙箱数 | >= 10（单机） | >= 50 | 按 API 配额 |
| 内存开销/沙箱 | < 50MB（容器开销） | < 5MB | N/A（云端） |

**SandboxPool 预热验证**：

```python
@pytest.mark.asyncio
async def test_pool_warm_start_latency():
    """热池中取出沙箱延迟 < 50ms"""
    pool = SandboxPool(config)
    await pool.warm_up("python", count=3)

    start = time.monotonic()
    sandbox = await pool.acquire("python")
    elapsed_ms = (time.monotonic() - start) * 1000

    assert elapsed_ms < 50, f"热启动延迟 {elapsed_ms:.1f}ms 超过 50ms 目标"
    await pool.release(sandbox)
```

### 6.3 安全审计验证

```python
# tests/deploy/test_security.py

@pytest.mark.asyncio
async def test_sensitive_env_cleaned(local_sandbox: LocalSandbox):
    """沙箱内不应能读取宿主的敏感环境变量"""
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test-key"
    result = await local_sandbox.execute(
        code="import os; print(os.environ.get('ANTHROPIC_API_KEY', 'NOT_FOUND'))",
        language="python"
    )
    assert "NOT_FOUND" in result.stdout
    assert "sk-ant-test-key" not in result.stdout

@pytest.mark.asyncio
async def test_container_capabilities_dropped(docker_sandbox: DockerSandbox):
    """容器不应有任何 Linux capabilities"""
    result = await docker_sandbox.execute(
        code="import subprocess; r = subprocess.run(['capsh', '--print'], capture_output=True, text=True); print(r.stdout)",
        language="python"
    )
    # Current capabilities 应为空
    assert "Current: =" in result.stdout or result.exit_code != 0

@pytest.mark.asyncio
async def test_no_privilege_escalation(docker_sandbox: DockerSandbox):
    """容器内不能提权"""
    result = await docker_sandbox.execute(
        code="import os; os.setuid(0)",  # 尝试 setuid root
        language="python"
    )
    assert result.exit_code != 0

def test_config_no_hardcoded_secrets():
    """配置文件中不允许有 API Key 等敏感信息"""
    config_content = Path("quilin/config.yaml").read_text()
    SECRET_PATTERNS = [
        r"sk-ant-[a-zA-Z0-9]+",      # Anthropic key
        r"sk-[a-zA-Z0-9]{48}",        # OpenAI key
        r"e2b_[a-zA-Z0-9]+",          # E2B key
    ]
    for pattern in SECRET_PATTERNS:
        assert not re.search(pattern, config_content), \
            f"配置文件中发现疑似密钥（pattern: {pattern}）"
```

### 6.4 验证矩阵

| 验证类别 | 测试项 | 通过标准 |
|---------|-------|---------|
| 文件系统隔离 | 访问 `/etc/passwd`、宿主家目录 | 全部失败（无法访问） |
| 网络隔离 | HTTP 请求外网，DNS 查询 | 全部失败（连接拒绝） |
| 资源限制 | 内存炸弹、fork 炸弹、磁盘填满 | 被限制，宿主正常 |
| 超时控制 | 无限循环 | 准时终止（误差 < 1s） |
| 环境变量清洗 | 读取 API Key 前缀变量 | 全部返回 NOT_FOUND |
| CLI 单次模式 | 执行简单任务 | exit code 0，输出正确 |
| CLI 守护进程 | /health 端点 | 200 OK，`status: ok` |
| 会话持久化 | 会话恢复，上下文连续 | 历史消息可读，状态一致 |
| 配置优先级 | CLI > ENV > YAML > 默认 | 四层覆盖全部正确 |
| 敏感配置 | YAML 中不含密钥 | 自动检测通过 |
| 冷启动延迟 | DockerSandbox 从 stop 到 ready | < 500ms（p95） |
| 热启动延迟 | SandboxPool 取出 | < 50ms（p95） |
| 并发沙箱 | 10 个沙箱同时执行 | 全部正常，无相互干扰 |

### 6.5 集成测试场景

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_full_agent_loop_with_code_execution():
    """完整的 Agent 循环：规划 → 生成代码 → 沙箱执行 → 验证结果"""
    harness = Quilin.from_config("tests/fixtures/test_config.yaml")
    session = await harness.create_session()

    result = await harness.run(
        prompt="用 Python 计算 1 到 100 的和，输出结果",
        session=session,
        max_steps=5,
    )

    assert result.success
    assert "5050" in result.output
    assert result.steps_taken <= 5
    assert result.sandbox_executions >= 1

@pytest.mark.integration
@pytest.mark.asyncio
async def test_session_persistence_across_restarts():
    """会话在 Harness 重启后可恢复"""
    harness1 = Quilin.from_config("tests/fixtures/test_config.yaml")
    session = await harness1.create_session()
    session_id = session.config.session_id

    await harness1.run("记住：幸运数字是 7", session=session)
    await harness1.shutdown()

    harness2 = Quilin.from_config("tests/fixtures/test_config.yaml")
    restored_session = await harness2.resume_session(session_id)
    result = await harness2.run("刚才我说的幸运数字是什么？", session=restored_session)

    assert "7" in result.output
```
