# Iteration D: Operability — 可运维

> **状态**：待启动（CI 部分与 Iter A 并行）
>
> **主轴**：08-Observability　**搭配**：09-lite、CI
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么在这

前三个迭代把单 Agent 做强之后，后续扩展（多 Agent / 自进化）没有 observability 不可调、不可诊断。这是扩展层的工程前置。

**CI 特别说明**：CI 是工程 guardrail，建议与 Iter A 并行补上最小版本，不等 Iter D 才做。

## 范围

### 可观测性（08）

- OTel 集成：spans + traces + metrics
  - 每次 LLM 调用一个 span（模型、tokens、延迟、finish reason）
  - 每次工具调用一个 span（工具名、耗时、成功/失败）
  - 每轮 agent loop 一个 trace（串联 LLM + 工具调用链）
- Request ID：每次用户输入分配唯一 ID，贯穿整个处理链路
- 结构化 metrics
  - token 消耗统计（累计 / 每轮 / 每次调用）
  - 工具调用频次和成功率
  - 响应延迟分布

### 配置管理（09-lite）

- 统一配置文件：`~/.quilin/config.toml`
  - LLM provider + model + API key
  - Memory 路径
  - 权限模式（auto / confirm）
  - 日志级别
- 环境变量覆盖（已有基础，需规范化）
- `quilin config show` / `quilin config set` CLI 命令

### CI/CD（工程保障）

- GitHub Actions workflow：`.github/workflows/ci.yml`
  - TS：`bun run vitest run`
  - Python：`uv run pytest`
  - Rust：`cargo test`
  - 触发条件：push to master + PR
- Lint 检查：Biome（TS）+ Ruff（Python）+ Clippy（Rust）

## 依赖关系

- 08-Observability 是 06/10/11 的前置
- 09-Deployment 依赖一定程度的 08
- CI 应尽早补，可与 Iter A 并行

## 验收标准

- [ ] LLM 调用和工具调用有 OTel span
- [ ] Request ID 贯穿完整调用链
- [ ] `~/.quilin/config.toml` 可配置 provider / model / 权限模式
- [ ] CI 在 GitHub Actions 上三语言测试全绿
- [ ] `quilin config show` 输出当前配置

## 参考 Spec

- [08-observability/README.md](../../engineering/08-observability/README.md)
- [09-deployment-runtime/README.md](../../engineering/09-deployment-runtime/README.md)
