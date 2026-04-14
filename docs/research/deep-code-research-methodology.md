# 深度代码调研方法论（Deep Code Research Methodology）

> 本文档定义 Quilin 项目对上游仓库进行深度代码级调研的标准化流程。
> 每个被纳入 `upstreams/` 的仓库都应经历此流程，输出结构化的调研报告。
> 此流程同时适用于**官方调研**和**用户自助吸收**两种场景。

---

## 一、为什么需要标准化调研

当前问题：
- `fusion-index.md` 记录了 165 个功能点的来源，但大多只到"知道这个项目有什么"层面
- ADR-001 对四大标杆做了架构级调研，但没有深入到每一行代码
- Claude Code 2.1.88 源码泄露、OpenClaw/Hermes/Codex 完全开源——我们有机会做到代码级理解
- 每次拿进一个新仓库，调研深度和质量参差不齐

目标：**每个上游仓库都经历同等深度的标准化调研，输出可机器处理的结构化报告。**

---

## 二、调研流程定义

### 2.1 输入

```
输入：
  repo_url: string          # GitHub 仓库 URL
  target_domains: string[]  # 关注的 Quilin 领域（如 ["03-memory", "02-context"]）
  depth: "scan" | "deep"    # 扫描级（快速评估）或 深入级（逐文件分析）
  context: string?          # 可选：用户为什么想吸收这个仓库
```

### 2.2 流程（6 步）

```
Step 1: 仓库概览（Reconnaissance）
    │   - README、架构文档、目录结构
    │   - 语言分布、依赖项、构建系统
    │   - Star/Fork/Issues/Contributors 活跃度
    │   - License 兼容性检查
    │
    ▼
Step 2: 架构映射（Architecture Mapping）
    │   - 入口文件、核心抽象、数据流
    │   - 分层结构、模块边界
    │   - 关键设计决策（为什么这样做而不是那样做）
    │
    ▼
Step 3: 逐文件深度分析（Code-Level Deep Dive）
    │   - 核心文件逐行阅读（按重要性排序，不是每个文件都读）
    │   - 标注：创新点、设计模式、hack/workaround、性能技巧
    │   - 提取：可复用的接口定义、算法、数据结构
    │
    ▼
Step 4: 创新点识别（Innovation Extraction）
    │   - 这个仓库做了什么别人没做的事？
    │   - 哪些设计决策是反直觉但有效的？
    │   - 哪些 hack 暴露了底层平台的限制？
    │
    ▼
Step 5: Quilin 关联评估（Relevance Scoring）
    │   - 逐领域评分：对 Quilin 11 个领域各有多大价值？（0-5）
    │   - 具体映射：哪些功能可以直接吸收？哪些需要改造？
    │   - 冲突检测：与 Quilin 现有设计是否矛盾？
    │
    ▼
Step 6: 吸收计划（Absorption Plan）
        - 具体要吸收哪些功能
        - 吸收方式：直接移植 / 借鉴思路重写 / 仅参考
        - 预估工作量
        - 对现有设计的影响
```

### 2.3 输出

```
输出：
  report: markdown          # 结构化调研报告（见模板）
  fusion_entries: yaml[]    # 更新 fusion-index.md 的条目
  absorption_patches: []    # 建议的吸收补丁（设计级，非代码级）
  relevance_scores: map     # { domain: score } 11 个领域的关联评分
```

---

## 三、调研报告模板

```markdown
# [仓库名] 深度调研报告

> 调研日期：YYYY-MM-DD
> 仓库：{url}
> 版本/Commit：{version}
> 调研深度：scan | deep
> 关注领域：{domains}

## 1. 仓库概览

- **定位**：一句话描述
- **语言**：{lang} ({loc} 行)
- **核心依赖**：...
- **活跃度**：{stars} stars, {last_commit} 最近提交, {contributors} 贡献者
- **License**：{license}（与 Apache 2.0 兼容：是/否）

## 2. 架构映射

### 入口与核心抽象
（架构图 + 关键类/函数说明）

### 设计决策
| 决策 | 选择 | 理由 | 我们的评价 |
|------|------|------|-----------|

## 3. 核心文件分析

### {file_path} ({lines} 行)
- **职责**：...
- **创新点**：...
- **可吸收**：...
- **注意事项**：...

（按重要性排序，列出 Top N 核心文件）

## 4. 创新点清单

| # | 创新点 | 描述 | 对 Quilin 的价值 | 关联领域 |
|---|--------|------|-----------------|---------|

## 5. Quilin 关联评分

| 领域 | 评分 (0-5) | 具体关联 |
|------|-----------|---------|
| 01-LLM 接入 | | |
| 02-上下文 | | |
| ... | | |
| 11-Agent Mesh | | |

## 6. 吸收计划

### 建议吸收
| 功能 | 吸收方式 | 预估工作量 | 优先级 |
|------|---------|-----------|--------|

### 明确不吸收
| 功能 | 理由 |
|------|------|

### 与现有设计的冲突
| 冲突点 | 现有设计 | 新发现 | 建议 |
|--------|---------|--------|------|
```

---

## 四、两种使用场景

### 4.1 官方调研（Quilin 团队）

用于 `upstreams/` 中的 ~100 个仓库和新发现的有价值项目。

- 由 Quilin 自进化系统（10-SelfEvolution）中的 upstream monitor 触发
- 当检测到上游仓库有重大更新（major version、架构变更），自动启动调研
- 调研报告存入 `docs/research/` 目录
- 经审核后更新 `fusion-index.md`

### 4.2 用户自助吸收（User Self-Evolution）

用户发现一个有用的 GitHub 仓库，想让自己的 Quilin 实例吸收它的能力。

```
用户："吸收 https://github.com/xxx/yyy"
    │
    ▼
Quilin 运行标准调研流程（本文档定义的 6 步）
    │
    ▼
生成调研报告 + 吸收计划
    │
    ▼
用户确认（"吸收第 1、3、5 项"）
    │
    ▼
Quilin 应用本地补丁（修改 scaffold：提示词/工具配置/工作流）
    │
    ▼
本地验证（运行测试任务验证吸收后表现不退化）
    │
    ▼
变更上报官方（可选）
    │
    ├── 官方接受 → 合入主线，所有用户受益
    │
    └── 官方不接受 → 用户保留本地版本
         │
         └── 未来官方更新时，本地需要冲突检测与解决
```

**关键设计约束**：
- 用户自助吸收**只修改 scaffold**（提示词、工具配置、工作流定义），不修改核心代码
- 每次吸收都有**回滚点**——如果吸收后表现变差，一键回退
- 吸收过程完全透明——用户能看到"改了什么、为什么改、预期效果是什么"
- 与 10-SelfEvolution 的 scaffold 自修改机制共享同一套基础设施

---

## 五、与现有系统的关系

| 现有系统 | 关系 |
|---------|------|
| `scripts/sync-upstreams.py` | 监控上游更新，触发调研 |
| `scripts/merge-with-claude.sh` | Claude-powered diff 分析，调研的自动化执行 |
| `fusion-index.md` | 调研产出更新此索引 |
| 10-SelfEvolution | 自助吸收 = 用户触发的自进化 |
| `upstreams/` 子模块 | 深入项目的源码入口 |

---

## 六、已完成的调研

| # | 调研 | 文档 | 状态 |
|---|------|------|------|
| 1 | 6 模型架构设计参考 | [model-architecture-insights.md](./model-architecture-insights.md) | 已完成 |
| 2 | 4 标杆 Agent Loop 架构 | [ADR-001](../adr/adr-001-core-loop-and-language.md) | 已完成 |
| 3 | 11 领域 × Top 10 上游功能扫描 | [fusion-index.md](../architecture/fusion-index.md) | 已完成（scan 级） |
| 4 | 四大标杆源码深度调研 | 见下方 | ✅ **已完成** |

### 调研 #4：四大标杆源码深度调研

**目标**：对 Claude Code、Codex、OpenClaw、Hermes Agent 四个项目进行代码级深度调研。

**源码位置**（全部本地）：

| 项目 | 本地路径 | 代码量 | 语言 |
|------|---------|--------|------|
| Claude Code v2.1.88 | `/Users/raysonmeng/repo/claude-code` | 512K 行 | TypeScript |
| Codex CLI | `/Users/raysonmeng/repo/codex` | 831K 行（640K Rust + 40K TS） | Rust + TypeScript |
| OpenClaw | `/Users/raysonmeng/repo/openclaw` | 296K 行 | TypeScript |
| Hermes Agent | `/Users/raysonmeng/repo/hermes-agent` | 395K 行 | Python |

**重点调研方向**：

| 项目 | 重点方向 | 核心文件 |
|------|---------|---------|
| **Claude Code** | Agent Loop（async generator）；prompt cache break detection；tool dispatch（concurrent+serial 分批）；LLM classifier 权限模型；streaming 架构 | `query.ts`, `toolOrchestration.ts`, `promptCacheBreakDetection.ts`, `permissions.ts` |
| **Codex CLI** | Rust async 调度（Tokio + async-channel）；submission_loop + Op enum dispatch；平台特定 sandbox（bubblewrap/Seatbelt）；MCP 连接管理；无状态设计 + Prompt Caching | `codex.rs`, `protocol.rs`, `manager.rs`, `exec_policy.rs` |
| **OpenClaw** | ContextEngine 接口（pluggable）；Pi agent 嵌入式集成（非 RPC）；记忆 dreaming 系统（light/deep/REM）；插件 SDK + 通道适配器；记忆 health tracking | `types.ts`, `run.ts`, `attempt.ts`, `dreaming.ts`, `core.ts` |
| **Hermes Agent** | AIAgent 循环（工业级 ReAct）；自进化真实状态（nudge-based，非 DSPy/GEPA）；五层记忆（含 Honcho 辩证式）；迭代预算 + refund 机制；智能模型路由 | `run_agent.py`, `prompt_builder.py`, `context_compressor.py`, `skill_manager_tool.py` |

**配套阅读材料**：

| 来源 | 内容 | 价值 |
|------|------|------|
| [知乎 Hermes 全面解读](https://zhuanlan.zhihu.com/p/2022015752258027715) | 6 大核心能力分析、ReAct 循环工业实现、5 层记忆、RL 闭环 | Hermes 架构全景 |
| [OpenAI: Unrolling the Codex Agent Loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | Responses API、Prompt 构建层次、缓存策略、Compaction、无状态设计 | Codex 官方设计思路 |
| [openclaw-docs](https://github.com/yeuxuan/openclaw-docs) | 276 篇中文教程，函数级源码剖析 | OpenClaw 工程主线 |
| [claude-code-analysis](https://github.com/liuup/claude-code-analysis) | 18 章 + 7 组件详解，完整内部架构 | Claude Code 静态分析 |

**调研产出**：

| # | 文档 | 状态 |
|---|------|------|
| 4a | [claude-code-deep-dive.md](./claude-code-deep-dive.md) | ✅ 已完成（496 行） |
| 4b | [codex-deep-dive.md](./codex-deep-dive.md) | ✅ 已完成（689 行） |
| 4c | [openclaw-deep-dive.md](./openclaw-deep-dive.md) | ✅ 已完成（501 行） |
| 4d | [hermes-agent-deep-dive.md](./hermes-agent-deep-dive.md) | ✅ 已完成（642 行） |
| 4e | [benchmark-comparison.md](./benchmark-comparison.md) | ✅ 已完成（跨项目对比 + 吸收路线图） |
| 4f | [domain-absorption-matrix.md](./domain-absorption-matrix.md) | ✅ 已完成（11 领域 × 66 创新点吸收矩阵 + 可观测指标） |

**预期产出**：每个项目一份完整调研报告（按本文档模板），外加一份跨项目对比总结和领域吸收矩阵。
