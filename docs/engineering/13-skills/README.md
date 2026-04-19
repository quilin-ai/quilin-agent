# 技能工程（Skill Engineering）

> **实现状态（R-07，2026-04-18）**
> - ✅ **已实现**：无
> - 🚧 **进行中**：无（B3a 排期开启后进入 M0）
> - 💭 **未开始**：SKILL.md frontmatter 解析器、SkillsManager（扫描/缓存/懒加载）、CatalogRenderer（system prompt 索引）、skill_manage 工具（读/写单写口，D-05）、路径/大小安全校验、skill → Sub-Agent 桥接。Iter 排期 = M0（B3a） → M1（后续）；Self-Evolution 写入路径依赖 M1 完成。

> **ADR-001 对齐说明**：技能系统（Skill Loading）用 TS 实现，作为 Agent Core 内的独立子系统。Skill 与 Tool 严格分离：Tool 是运行时可执行动作，Skill 是可被 LLM 读取的知识/指令资产。本文档中的 Python 代码示例仅表达设计意图，实施时以 TS 落地。

> **研究依据**：[docs/research/skill-loading-comparison.md](../../research/skill-loading-comparison.md) — 四仓库对比（Claude Code / Hermes / OpenClaw / Codex CLI），已由 Codex adversarial review 通过。

Tool 让 Agent 做得到一件事；Skill 让 Agent 知道该怎么做这件事。**Skill ≠ Tool** 是四仓库研究的核心共识，本领域专门处理知识/指令资产的发现、索引、加载与生命周期。

---

## 一、问题定义

### 1.1 技能工程的 6 个维度

```
技能工程
├── 1. 技能格式（Format）         — SKILL.md + frontmatter schema
├── 2. 技能发现（Discovery）      — 多源扫描 + 优先级覆盖
├── 3. 目录注入（Catalog）        — system prompt 索引先行
├── 4. 按需加载（On-demand Load） — LLM 需要时才读全文
├── 5. 技能安全（Safety）         — 路径/大小/内容多层校验
└── 6. 生命周期（Lifecycle）      — 热发现、CRUD、post-compact、自进化
```

#### 维度 1：技能格式（Format）

- **事实标准**：YAML frontmatter + Markdown body（四仓库无例外）
- **核心字段**：`name`、`description`（必需）；`whenToUse`、`allowedTools`、`requires` 等（扩展）
- **文件树**：`skill-name/SKILL.md` + 可选 `references/` / `templates/` / `scripts/`
- **大小上限**：内容 ≤100K 字符、单文件 ≤1MiB（参照 Hermes）

#### 维度 2：技能发现（Discovery）

- **多源扫描**：bundled（内置） / user（`~/.quilin/skills`） / project（`.quilin/skills`）
- **优先级覆盖**：同名 skill 按来源优先级合并（project > user > bundled）
- **安全扫描**：realpath containment 防路径逃逸、拒绝 symlink、candidate 数量上限

#### 维度 3：目录注入（Catalog）

- **索引先行**：system prompt 中注入 `<available_skills>` 列表（name + 60 字描述）
- **token 预算**：单个 skill 描述 ≤60 字符、整份 catalog 预算可配置（默认 1K tokens）
- **排序（D-13 2026-04-20 NEW-15 KV-cache 稳定性约束）**：
  - **稳定前缀段**（bundled + user + mandatory skills）按 `skill_id` lexicographic 排序，放进 system prompt 稳定前缀，满足 [harness-engineering §十](../../architecture/harness-engineering.md) KV-cache 命中率 >80% 目标
  - **热门段**（`<hot_skills>`，≤10 条）按 `recency × relevance` 排序，放在稳定前缀**之后**，作为每轮可变的独立 XML 块
  - 违反约束的后果：每轮 prefix hash 漂移 → KV-cache miss → 10x 成本放大

#### 维度 4：按需加载（On-demand Load）

- **路线 A 共识**：无一仓库做 eager full-load，全部 "catalog 先行、按需拉全文"
- **触发方式**：提供 `skill_view(name)` 工具，LLM 主动调用读取全文
- **预算**：单次加载 ≤36K tokens（Hermes 的 100K 字符 ≈ 36K token 上限）

#### 维度 5：技能安全（Safety）

- **路径安全**：realpath containment、拒绝 `..` 跨越、拒绝 symlink（OpenClaw 模型）
- **大小保护**：文件字节上限、内容字符上限，防止内存爆炸
- **内容扫描**（M1）：参照 Hermes `skills_guard` 的 30+ 威胁模式（数据外泄、prompt 注入、破坏性操作、持久化、混淆）
- **信任策略**（M1）：builtin / trusted / community / agent-created 四级，dangerous 内容走 deny 或 ask

#### 维度 6：生命周期（Lifecycle）

- **热发现**：文件监听（watcher）→ 新增/删除 skill 立即生效
- **CRUD**：提供 `skill_manage(create/update/delete)` 工具让 agent 创建 skill
- **post-compact 恢复**：context 压缩后保留最近 5 个 skill、各 5K token 上限、总预算 25K（Claude Code 模型）
- **自进化**（M2+）：与 Idle Evolution Budget 对齐，空闲时 background nudge 审视对话并沉淀新 skill

### 1.2 核心挑战

| 挑战 | 描述 | 影响 |
|------|------|------|
| Skill ≠ Tool 边界 | 历史上易被误设计为 Tool 的一种 | 注册表、调用协议、安全模型都会走偏 |
| 索引膨胀 | 100+ skill 时 catalog 本身占用大量 token | 需条件激活 + token 预算 |
| 按需加载错误 | LLM 不知道何时该读全文 | whenToUse 字段 + 强提示 |
| 路径逃逸 | 恶意 skill 用 symlink 读取 `~/.ssh` | realpath + symlink 拒绝 |
| Prompt 注入 | Skill 内容可能含 "ignore previous instructions" | 内容扫描（M1）+ 信任策略 |
| 压缩丢失 | context compact 后 skill 上下文消失 | post-compact 恢复（M1） |
| 自进化失控 | agent 无节制创建 skill | nudge 间隔 + CRUD 工具权限 |

---

## 二、设计方案

### 2.1 分层路线图（M0 / M1 / M2+）

本领域按 Skill Loading Iter 的节奏分三期落地。M0 聚焦"加载/注册边界"，M1 补齐长对话与安全加固，M2+ 进入自进化与平台化。

```
M0（首期）：基本可用
├── SKILL.md 格式 + frontmatter schema
├── 多源发现（bundled / user / project）
├── Catalog 注入 system prompt
├── 按需加载（skill_view 工具）
└── 路径 + 大小安全校验

M1（二期）：长对话与扩展
├── 条件激活（requires_tools / toolsets）
├── Post-compact skill 恢复
├── Skill CRUD 工具（skill_manage）
└── skills_guard 内容扫描 + 4 级信任策略

M2+（延后）：平台化与自进化
├── Plugin 贡献 skill roots（依赖 Plugin 平台立项）
├── Background nudge 自进化（依赖 Planning + Idle Evolution）
├── ToolSearch 式延迟加载（工具数 > 100 时启用）
├── Manifest-first plugin 平台
└── 2 阶段 ML 安全分类器
```

### 2.2 Skill 定义格式（M0）

```yaml
---
name: web-scraping                     # 必需，kebab-case，≤64 字符
description: Extract structured data from websites  # 必需，≤1024 字符
whenToUse: User asks to scrape or extract from a URL   # 可选，触发提示
allowedTools: [web_fetch, web_search]  # 可选，限制可用工具
version: 1.0.0                         # 可选
userInvocable: true                    # 可选，默认 true
disableModelInvocation: false          # 可选，只读 skill 设 true
metadata:
  quilin:
    requires_tools: [web_fetch]        # M1：条件激活
    requires_toolsets: []              # M1：toolset 条件
    platforms: [macos, linux]          # 可选：平台过滤
    trust: trusted                     # M1：builtin/trusted/community/agent-created
---

# Web Scraping Skill

<markdown body — LLM 按需读取>
```

#### Anthropic 官方 `anthropics/skills` 对齐（D-17 2026-04-20）

为了让社区 skill 能零翻译落盘到 `~/.quilin/skills/**`，SkillsManager 的 frontmatter 解析器必须接受以下**等价键**（kebab-case 为官方首选，camelCase 为内部 alias）：

| Quilin 内部 | Anthropic 官方 | 必需 |
|------------|--------------|------|
| `name` | `name` | ✅ |
| `description` | `description` | ✅ |
| `allowedTools` | `allowed-tools` | 可选 |
| `license` | `license` | 可选 |
| `whenToUse` / `userInvocable` / `disableModelInvocation` / `metadata.quilin.*` | — | Quilin 扩展（官方无对应字段） |

parser 规范化到 camelCase 内部表示；写回时保留原始键名不规范化（避免社区 skill 本地修改后 diff 漂移）。引用：[anthropics/skills README](https://github.com/anthropics/skills/blob/main/README.md)。

### 2.3 核心数据结构

```python
# 以下 Python 仅表达设计意图，实际以 TS 实现

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional

class SkillSource(Enum):
    BUNDLED  = "bundled"     # 编译进 agent-core
    USER     = "user"        # ~/.quilin/skills
    PROJECT  = "project"     # .quilin/skills
    PLUGIN   = "plugin"      # M2+：plugin 贡献

class TrustLevel(Enum):
    BUILTIN        = "builtin"
    TRUSTED        = "trusted"
    COMMUNITY      = "community"
    AGENT_CREATED  = "agent-created"

@dataclass
class SkillFrontmatter:
    name: str
    description: str
    when_to_use: Optional[str] = None
    allowed_tools: list[str] = None
    version: Optional[str] = None
    user_invocable: bool = True
    disable_model_invocation: bool = False
    # M1 扩展
    requires_tools: list[str] = None
    requires_toolsets: list[str] = None
    platforms: list[str] = None
    trust: TrustLevel = TrustLevel.COMMUNITY

@dataclass
class SkillDescriptor:
    """轻量级 catalog 条目，不含全文"""
    name: str
    description: str
    path: Path                         # SKILL.md 绝对路径
    source: SkillSource
    frontmatter: SkillFrontmatter

@dataclass
class LoadedSkill:
    """按需加载后的完整 skill"""
    descriptor: SkillDescriptor
    body: str                          # Markdown body 全文
    token_estimate: int
```

### 2.4 发现与加载管道

```
┌─────────────────────────────────────────────────────────┐
│ Startup / Hot-reload                                     │
│                                                           │
│  SkillsManager.discover()                                │
│    ├── scan bundled / user / project                     │
│    ├── parse frontmatter                                 │
│    ├── apply safety (realpath / size / symlink reject)   │
│    ├── priority merge (project > user > bundled)         │
│    └── produce SkillDescriptor[]                         │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ Per-turn Context Assembly（02-context 协作）             │
│                                                           │
│  CatalogRenderer.render(descriptors, turn_context)       │
│    ├── filter by requires_tools/toolsets（M1）           │
│    ├── filter by platform                                │
│    ├── sort by recency × relevance                       │
│    ├── truncate descriptions to 60 chars                 │
│    └── emit <available_skills> XML block                 │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ On-demand Load（LLM 调用）                                │
│                                                           │
│  skill_view(name) tool                                   │
│    ├── lookup descriptor                                 │
│    ├── read SKILL.md body                                │
│    ├── size check                                        │
│    ├── content scan（M1：skills_guard）                   │
│    └── return LoadedSkill → injected as instruction item │
└─────────────────────────────────────────────────────────┘
```

### 2.5 与四仓库的关键差异

| 决策 | Quilin 选择 | 参照 | 差异说明 |
|------|-------------|------|----------|
| 注册方式 | 显式注册（对齐 B1 `MCPRegistry`） | Hermes | 不采纳 import-time 自注册：显式注册更利于单测与生命周期控制 |
| 加载策略 | Catalog + skill_view | Hermes、OpenClaw | 不采纳 Claude Code 的 shouldDefer：工具数少时 ToolSearch 收益不大 |
| 路线选择 | M0/M1 走路线 A，M2+ 再补路线 B | OpenClaw hybrid | Plugin 平台立项后再接入 plugin-contributed skill roots |
| 自进化 | M2+ 再做 | Hermes background nudge | 依赖 04-planning 能力先到位、10-self-evolution idle budget 对齐 |
| Install spec | 不采纳 | OpenClaw install / setup | 本领域只做 loading，不做 environment setup / package install |

### 2.6 关键接口（TS 伪代码）

> **D-05 跨域合同**：TS 是 Agent Core 的主语言，下列接口为**权威源**；Python 侧（03-Memory、ML providers）通过 MCP 边界以等价 schema 使用。`SkillDescriptor` 是 10-self-evolution ↔ 13-skills 的共享数据结构：10 只**生成草稿并调用 `skill_manage`**，13 负责**路径/大小/frontmatter 校验、落盘、catalog 索引更新**——CRUD 唯一写入方是 13。

```typescript
// packages/agent-core/src/skills/

interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly allowedTools?: readonly string[]
  readonly version?: string
  readonly userInvocable: boolean
  readonly disableModelInvocation: boolean
  // M1
  readonly requiresTools?: readonly string[]
  readonly requiresToolsets?: readonly string[]
  readonly platforms?: readonly string[]
  readonly trust: 'builtin' | 'trusted' | 'community' | 'agent-created'
}

interface SkillDescriptor {
  readonly name: string
  readonly description: string
  readonly path: string                 // SKILL.md 绝对路径
  readonly source: 'bundled' | 'user' | 'project' | 'plugin'
  readonly frontmatter: SkillFrontmatter
}

interface LoadedSkill {
  readonly descriptor: SkillDescriptor
  readonly body: string                 // Markdown body 全文
  readonly tokenEstimate: number
}

interface SkillsManager {
  discover(): Promise<readonly SkillDescriptor[]>
  findByName(name: string): SkillDescriptor | null
  load(name: string): Promise<LoadedSkill>
  watch(onChange: (descriptors: readonly SkillDescriptor[]) => void): () => void
}

interface CatalogRenderer {
  render(
    descriptors: readonly SkillDescriptor[],
    ctx: TurnContext,
  ): string  // <available_skills> XML block
}

// Skill CRUD 工具 — 唯一写入入口
// 安全约束：所有 create/update/delete 必须过 07 §2.6.4 WriteAuthority gate
//   - origin: "agent"（Background nudge 触发时 origin:"idle"，在 ask 模式下强制 deny）
//   - riskLevel: "high"（create/update） / "medium"（delete）
//   - 敏感 frontmatter 字段（如 allowed_tools 含 shell_exec）自动升为 "critical"
type SkillManageAction =
  | { action: 'create'; descriptor: SkillDescriptor; body: string }
  | { action: 'update'; name: string; patch: Partial<SkillDescriptor>; body?: string }
  | { action: 'delete'; name: string; reason: string }

type SkillManageResult =
  | { ok: true; descriptor: SkillDescriptor }
  | { ok: false; error: 'validation_failed' | 'path_denied' | 'size_exceeded' | 'not_found'; detail: string }

interface SkillTool {
  skill_view: Tool<{ name: string }, LoadedSkill>
  skill_manage?: Tool<SkillManageAction, SkillManageResult>  // M1
}
```

> Python 侧（如 10-self-evolution 的 SkillManager.extract）仍可用 `@dataclass` 形式表达 `SkillDescriptor` 草稿，但落盘时**必须**通过 MCP 走 `skill_manage` 到达 TS 侧 SkillsManager——没有直接文件写入通道。

---

## 三、与其他领域的关系

| 领域 | 交互点 | 本领域的责任边界 |
|------|--------|------------------|
| **02-context** | Catalog 注入 system prompt、post-compact 恢复 | 本领域提供 `CatalogRenderer`，02-context 决定插入位置与预算 |
| **05-tool** | `skill_view` / `skill_manage` 作为内置工具注册 | 本领域定义工具语义，05-tool 的 `ToolRouter` 负责执行 |
| **07-safety-guardrails** | skills_guard（M1）复用安全分类器基础设施 | 本领域提供威胁模式表，07-safety 提供分类器与策略引擎 |
| **10-self-evolution** | Background nudge 审视对话并创建 skill（M2+） | 本领域提供 CRUD 接口，10-self 决定何时触发、如何 review |
| **04-planning** | Planning 决定是否需要某个 skill，触发加载 | 本领域只提供 descriptors / load，不做决策 |
| **11-agent-mesh** | 未来可通过 mesh 同步 skill（M2+） | 当前领域不涉及 mesh 传输 |

**明确边界**：
- Skill 不是 Tool — 不进 `ToolRouter` 的普通注册表，有独立 `SkillsManager`
- Skill 不是 Memory — Memory 是 agent 的经验与用户画像，Skill 是人类/agent 可读的指令资产
- Skill 不是 Prompt — Prompt 是系统固定模板，Skill 是可插拔的领域知识

---

## 四、权衡与未来演进

### 4.1 已做出的权衡

| 权衡 | 选择 | 理由 |
|------|------|------|
| 首期是否做 Plugin 平台 | 否（M2+） | Quilin 当前 roadmap 无 Plugin 立项，避免过早平台化 |
| 首期是否做条件激活 | 否（M1） | 首期 skill 数量可控（<20），索引膨胀还不严重 |
| 首期是否做 post-compact | 否（M1） | 首期长对话场景少，但需要预留接口 |
| 首期是否允许 agent 创建 skill | 否（M1） | 需要 skills_guard 一起上线防止失控 |
| 是否采纳 Hermes 的 import-time 自注册 | 否 | TS 生态偏好显式注册，对齐 B1 `MCPRegistry` |
| 是否采纳 OpenClaw 的 install spec | 否（不采纳） | 本领域只做 loading，不含 environment setup |

### 4.2 未来演进方向

- **Plugin 贡献 skill roots（M2+）**：Plugin 平台立项后，manifest 中 `skills` 字段把插件自带的 skill dirs 反向挂进 skill discovery（OpenClaw + Codex 的 hybrid 模型）
- **Background nudge 自进化（M2+）**：对齐 10-self-evolution 的 Idle Evolution Budget，空闲时让 review agent 审视对话并 `skill_manage(create)`
- **ToolSearch 延迟加载（M2+）**：当工具数超过阈值时，借鉴 Claude Code 的 `shouldDefer + ToolSearch` 模式做 skill 语义检索
- **跨 Agent skill 共享（M2+）**：通过 agent-mesh 同步组织级 skill 库

---

## 五、参考资料

- [docs/research/skill-loading-comparison.md](../../research/skill-loading-comparison.md) — 四仓库对比研究（本领域的设计依据）
- [docs/adr/adr-001-core-loop-and-language.md](../../adr/adr-001-core-loop-and-language.md) — 三语言架构
- [docs/engineering/02-context/README.md](../02-context/README.md) — Catalog 注入点
- [docs/engineering/05-tool/README.md](../05-tool/README.md) — Tool vs Skill 边界
- [docs/engineering/07-safety-guardrails/README.md](../07-safety-guardrails/README.md) — 分类器基础设施
- [docs/engineering/10-self-evolution/README.md](../10-self-evolution/README.md) — 自进化触发
- 上游参考：Claude Code（`.claude/skills/`）、Hermes Agent（`~/.hermes/skills/`）、OpenClaw（`src/agents/skills/`）、Codex CLI（`codex-rs/core-skills/`）
