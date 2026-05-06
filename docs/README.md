# 文档 / Docs

This directory only carries current project facts.

本目录只承载当前项目事实。

## 入口 / Entry Points

| 你要看什么 | 入口 |
|---|---|
| 全局状态快照 | [STATUS.md](STATUS.md) |
| 任务管理 / backlog | [Linear: QuiLin Agent](https://linear.app/quilin-agent) |
| Runtime split、Core Loop、docs 规则 | [00-core-loop](00-core-loop/README.md) |
| 某个组件的架构 / 当前事实 | 对应组件 README |

## 组件 / Components

| 组件 | 负责内容 |
|---|---|
| [00-core-loop](00-core-loop/README.md) | Core Loop、运行时切分、Harness 原则、术语表 |
| [01-llm-integration](01-llm-integration/README.md) | AI SDK v6、模型/provider 抽象、thinking/reasoning 控制 |
| [02-context](02-context/README.md) | Prompt assembly、token budgets、temporal awareness、parked conversation engineering |
| [03-memory](03-memory/README.md) | quilin-mem、profiles、scratchpad、L3a observer reports |
| [04-planning](04-planning/README.md) | Intent、task decomposition、strategy/audit contracts |
| [05-tool](05-tool/README.md) | Built-in tools、MCP、browser/CLI tool surfaces |
| [06-multi-agent](06-multi-agent/README.md) | 内部 sub-agent orchestration 和 supervisor model |
| [07-safety-guardrails](07-safety-guardrails/README.md) | WriteAuthority、trust tiers、classifiers、sandbox threat model |
| [08-observability](08-observability/README.md) | OTel、metrics、logs、coverage gates |
| [09-deployment-runtime](09-deployment-runtime/README.md) | CLI/runtime、config cascade、hot update |
| [10-self-evolution](10-self-evolution/README.md) | Trajectory analysis、skills/profile/soul prerequisites、future scaffold patch loop |
| [11-agent-mesh](11-agent-mesh/README.md) | Mesh SDK stub 和未来 AgentMesh runtime 边界 |
| [13-skills](13-skills/README.md) | SKILL.md、catalog、`skill_view`、CRUD、guard、restore、watcher |
| [14-benchmark-harness](14-benchmark-harness/README.md) | Frozen Benchmark implementation snapshot; read-only unless the user explicitly asks |

## 写入规则 / Writing Rules

1. **任务管理只写 Linear。** `docs/` 不再承载 TODO board、backlog 或 phase tracking。
2. **全局状态快照只写 [STATUS.md](STATUS.md)。**
3. **组件当前事实只写该组件的 `README.md`。**
4. 不再保留 `evidence/` 档案目录；历史快照通过 git history 追溯。
5. 不再恢复顶层 `planning/`、`iterations/`、`adr/`、`architecture/`、`research/`、`review/` 目录。
6. 历史材料仍有当前价值时，只把结论摘要写进对应组件 README。
7. phase done / capability landed / contract satisfied 这类声明必须带 commit hash、测试数、lint/check 结果或实测值。
8. **新增或重写项目文档必须中英双语。** 标题优先中文，可在同一标题中补英文；正文按段落对照写作，顺序为英文段落后一段中文翻译，避免只写英文造成阅读负担。

## 导航模型 / Navigation Model

The old structure split planning, iterations, ADR, architecture, research, and review into separate top-level docs areas, which made multiple files look like competing sources of truth.

旧结构把 planning、iterations、ADR、architecture、research、review 分开，容易出现多个文件同时像“真相源”的问题。

The current structure is fixed as:

当前结构固定为：

```text
docs/
  README.md
  STATUS.md      # 当前状态快照；任务链接到 Linear
  <component>/
    README.md      # 当前架构、约束、实现状态
```
