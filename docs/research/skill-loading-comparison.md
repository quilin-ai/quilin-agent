# Skill Loading 机制四仓库对比研究

> **状态**：完成（四仓库研究全部完成，2026-04-15；Codex adversarial review 通过，2026-04-17）
>
> **目标**：为 Quilin Agent 设计独立的 Skill Loading 迭代提供决策依据
>
> **定位**：本研究独立于 B2 Safety Policy，作为新迭代的输入。B2 仍需在此研究完成后继续推进。
>
> **研究对象**：Claude Code、Hermes Agent、OpenClaw、Codex CLI

## 决策请求（Ask）

请就以下三项拍板，以便把本研究落成可执行 spec：

1. **立项命名与位置**：独立迭代命名为 **Iter B3 "Skill Loading"**（紧贴 B1/B2 工具/安全链路）还是 **Iter C-Skills**（独立于 B 组、作为新顶级能力线）？
2. **M0 范围确认**：是否按 §6.4 M0 的五项（SKILL.md 格式 / 多源发现 / catalog 注入 / 按需加载 / 路径+大小安全）作为首期验收？
3. **M1 优先级**：条件激活、post-compact 恢复、CRUD 工具、skills_guard 四项中，是否按此顺序在 M1 实施，还是需要重新排序？

拍板后：**B2 Safety Policy spec revision 可立即续作**（仍有 2 HIGH + 2 MEDIUM 待修），Skill Loading iter 按上述命名开 spec。

---

## 1. 核心发现概览

| 维度 | Claude Code | Hermes Agent | OpenClaw | Codex |
|------|-------------|--------------|----------|-------|
| **Skill 定义** | Markdown + frontmatter（.claude/skills/） | YAML frontmatter + Markdown（~/.hermes/skills/） | SKILL.md + 重 frontmatter（轻量 manifest） | SKILL.md + 可选 agents/openai.yaml（双层定义） |
| **注册/发现** | 4 源（bundled / file / MCP / managed），ToolSearch 按需发现 | 文件系统扫描 + 3 层 LRU 缓存，条件过滤 | 多源覆盖（6 级优先级）+ 安全加固 | 分层 root registry + 受限 BFS 遍历 + plugin 贡献 |
| **加载策略** | 延迟加载（shouldDefer）+ 按需 ToolSearch + 全量 alwaysLoad | 索引注入 system prompt + skill_view() 按需加载全文 | prompt catalog 先注入 + 模型决定是否读全文 | startup catalog + per-turn lazy body injection |
| **LLM 暴露** | skill_listing + skill_discovery attachment，deferred tool name-only | Layer 6 system prompt 索引（60 字摘要），skill_view() 工具调用 | `<available_skills>` XML catalog + 模型自选读取 | developer message skills section + turn-scoped explicit injection |
| **安全/权限** | 2 阶段 XML classifier + 4 fast-path bypass + checkPermissions() | skills_guard 30+ 威胁模式扫描 + 4 级信任策略 | realpath containment + symlink/大文件拒绝 + candidate 数量限制 | 受限目录遍历（最大深度 + 目录数限制） |
| **生命周期** | POST_COMPACT 恢复 + prefetch + write-pivot 信号 | 背景 nudge 自进化（每 10 轮）+ CRUD 工具 + 热发现 | snapshot 复用 / 实时加载切换 + plugin hook 注入 | plugin bundle 管理 + skills_watcher 文件监听 |

---

## 2. Claude Code — 详细分析

### 2.1 Skill 定义格式

**四种来源**：

| 来源 | 格式 | 位置 | 特点 |
|------|------|------|------|
| Bundled | TS `BundledSkillDefinition` | 编译进 CLI binary | 带 `files` 字段，首次调用时解压到磁盘 |
| File-based | Markdown + YAML frontmatter | `.claude/skills/` | 用户或项目级，通过 `loadSkillsFromDirectory()` 加载 |
| MCP | 动态注册 | MCP server 提供 | 写一次注册表，解决循环依赖 |
| Managed | Markdown + frontmatter | `~/.anthropic/managed/.claude/skills/` | 组织级统一下发 |

**Skill frontmatter schema**：

```typescript
interface ParsedSkillFrontmatter {
  displayName?: string;
  description: string;
  allowedTools: string[];          // 限制可用工具
  argumentHint?: string;
  argumentNames: string[];
  whenToUse?: string;
  version?: string;
  model?: UserSpecifiedModel;      // 可覆盖 Claude 模型
  disableModelInvocation: boolean; // 只读 skill
  userInvocable: boolean;
  hooks?: HooksSettings;
  executionContext?: 'fork';       // 隔离执行
  agent?: string;                  // 委派给特定 agent
  effort?: EffortValue;
  shell?: FrontmatterShell;
}
```

### 2.2 Tool 自声明协议

每个 Tool 通过接口声明自身属性（`Tool.ts`, 792 行）：

```typescript
// 延迟加载协议
shouldDefer?: boolean;       // 延迟 schema 加载
alwaysLoad?: boolean;        // 永不延迟
searchHint?: string;         // 3-10 词 ToolSearch 匹配关键词

// 安全自声明
isConcurrencySafe(input): boolean;   // 可并行
isReadOnly(input): boolean;          // 只读
isDestructive(input): boolean;       // 不可逆（删除/覆盖/发送）
interruptBehavior(): 'cancel'|'block';

// 权限 + 分类器
checkPermissions(input, context): Promise<PermissionResult>;
toAutoClassifierInput(input): unknown;  // 给 2 阶段分类器的紧凑表示
```

**安全默认值**（`buildTool()` 应用）：
- `isConcurrencySafe` → `false`（保守）
- `isReadOnly` → `false`（假设写入）
- `isDestructive` → `false`
- `checkPermissions` → `{ behavior: 'allow' }`

### 2.3 延迟加载协议

**核心机制**：`shouldDefer` + `ToolSearch` + `alwaysLoad`

1. Tool 声明 `shouldDefer: true` → schema 以 `defer_loading: true` 发送（name-only）
2. MCP 工具默认 deferred（除非 `alwaysLoad: true`）
3. Model 需要 deferred tool 时 → 调用 `ToolSearch`
4. ToolSearch 返回完整 JSONSchema → model 可正常调用

**ToolSearch 查询形式**：
- `"select:Read,Edit,Grep"` — 按名精确获取
- `"notebook jupyter"` — 关键词搜索
- `"+slack send"` — 名称必须含 "slack"，其余词排序

**Token 阈值自动启用**（`toolSearch.ts`）：
- 默认阈值：context window 的 10%
- 超过阈值时 deferred tools 才真正延迟
- 通过 `ENABLE_TOOL_SEARCH` 环境变量控制模式

### 2.4 Skill 发现 & LLM 暴露

**两种 attachment 机制**：

| Attachment | 触发时机 | 内容 |
|-----------|---------|------|
| `skill_listing` | Turn 0 / 每次会话 | 格式化 skill 列表（名称 + 描述，token 预算内） |
| `skill_discovery` | Turn 0（用户输入触发）/ inter-turn（write-pivot 检测） | 推荐的 skill 列表 + 信号源 |

- `skill_listing` 按 recency 和 relevance 排序，控制 ~600 tokens
- `skill_discovery` 支持 prefetch（与 model 调用并发运行）
- Resume 场景抑制重复注入（`sentSkillNames` Set 追踪）

### 2.5 POST_COMPACT 恢复

Context 压缩后的 skill 恢复策略：

```typescript
POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000;   // 每个 skill 上限
POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000;     // 总预算（~5 个 skill）
```

恢复流程：
1. 获取 `getInvokedSkillsForAgent()` → 按最近使用排序
2. 每个 skill 截断到 5K tokens（保留 HEAD，setup 指令优先）
3. 追加截断标记 + Read 提示
4. 总量超 25K → 丢弃最旧的 skill
5. 注入 `invoked_skills` attachment

### 2.6 权限系统

**2 阶段 XML 分类器**（`permissions.ts` + `yoloClassifier.ts`）：

```
Stage 1 (xml_s1_h2): 快速判断（64 tokens）
  → "明显安全" → allow（快速路径）
  
Stage 2 (xml_s2_t2): 深度审查（带 thinking）
  → Stage 1 怀疑 → 仔细审查
```

**4 个快速路径绕过**：
1. `acceptEdits` 模式模拟
2. 只读工具白名单（Read, Grep, Glob 等）
3. Tool 的 `checkPermissions()` 返回 'allow'
4. Denial 追踪 + fallback-to-prompting

---

## 3. Hermes Agent — 详细分析

### 3.1 双层架构：Tool vs Skill

**关键洞察**：Hermes 将 Tool 和 Skill 严格分离。

| | Tool（Tier 1） | Skill（Tier 2） |
|--|---------------|----------------|
| 本质 | 可执行动作 | 知识文档 |
| 注册方式 | `registry.register()` import 时自注册 | 文件系统扫描 |
| Schema | OpenAI function format → LLM | 无 schema，索引注入 system prompt |
| 加载 | 全量（按 toolset 过滤） | 按需（`skill_view()` 工具调用） |
| 运行时 | `registry.dispatch(name, args)` | LLM 读取后融入推理 |

### 3.2 Skill 定义格式

**文件结构**：
```
~/.hermes/skills/
├── skill-name/
│   ├── SKILL.md              (必需)
│   ├── DESCRIPTION.md        (可选，category 描述)
│   ├── references/
│   ├── templates/
│   ├── scripts/
│   └── assets/
```

**Frontmatter schema**：
```yaml
---
name: web-scraping                     # 必需，≤64 字符
description: Extract data from web     # 必需，≤1024 字符
platforms: [macos, linux]              # 可选，平台过滤
metadata:
  hermes:
    requires_toolsets: [browser]       # 条件激活：需要这些 toolset
    fallback_for_toolsets: [web]       # 提供替代
    requires_tools: [web_search]       # 需要这些具体工具
    fallback_for_tools: [web_extract]
    config:                            # 配置变量声明
      - key: scrape.timeout
        description: Browser timeout
        default: 30
---
```

**大小限制**：
- MAX_SKILL_CONTENT_CHARS: 100,000（~36k tokens）
- MAX_SKILL_FILE_BYTES: 1,048,576（1 MiB/文件）
- MAX_NAME_LENGTH: 64 字符
- MAX_DESCRIPTION_LENGTH: 1,024 字符

### 3.3 Tool 注册机制

**自注册单例**（`registry.py`, 386 行）：

```python
# 每个 tool 文件在 import 时调用
registry.register(
    name="my_tool",
    toolset="web",                    # 单一 toolset 归属
    schema={...},                     # OpenAI function schema
    handler=my_tool_handler,          # callable
    check_fn=lambda: HAS_API_KEY,     # 可用性检查（懒执行）
    requires_env=["MY_API_KEY"],
    is_async=False,
    max_result_size_chars=50000,
)
```

**线程安全**：RLock 保护，支持 MCP 动态刷新（nuke-and-repave）。

**Import 链**（无循环依赖）：
```
registry.py (不导入任何 tool)
    ↑
tools/*.py (import registry 并 register)
    ↑
model_tools.py (导入 registry + 所有 tool 模块)
```

### 3.4 Toolset 组合

**三层层级**（`toolsets.py`, ~400 行）：
```
basic → composite → scenario

"web" (basic)
  → "safe" (composite: web + vision + image_gen, 排除 terminal)
  → "debugging" (composite: terminal + process + web + file)
```

**平台适配**：
- `hermes-cli`: 30+ 核心工具
- `hermes-telegram`: 同 CLI（terminal 有安全检查）
- `hermes-acp`: 编辑器集成（排除消息、音频、交互 UI）
- `hermes-api-server`: API 模式（无交互 UI 工具）

### 3.5 Skill 发现 & 注入

**发现流程**：
1. 扫描 `~/.hermes/skills/` + config.yaml 中的 external_dirs
2. 平台过滤 → disabled 列表过滤 → toolset/tool 条件过滤
3. 3 层缓存：进程内 LRU（8 条）→ 磁盘快照 → 全量扫描

**注入位置**：7 层 system prompt 的 Layer 6

```markdown
## Skills (mandatory)
Before replying, scan the skills below. If a skill matches...

<available_skills>
general:
  - skill-1: Short description (截断到 60 字符)
category-a:
  - skill-3: ...
</available_skills>
```

**加载方式**：Agent 调用 `skill_view(name)` → 从磁盘读取完整 SKILL.md → 注入对话

### 3.6 安全扫描（skills_guard）

**30+ 威胁模式**检测：

| 类别 | 示例 |
|------|------|
| 数据外泄 | curl/wget + 密钥环境变量；读取 ~/.ssh、~/.aws |
| Prompt 注入 | "ignore previous instructions"；角色劫持 |
| 破坏性操作 | `rm -rf /`；格式化设备 |
| 持久化 | cron job；systemd unit；~/.bashrc 修改 |
| 混淆 | Base64 链；不可见 Unicode |

**4 级信任策略**：
```python
INSTALL_POLICY = {
    #              safe      caution    dangerous
    "builtin":   ("allow",  "allow",   "allow"),
    "trusted":   ("allow",  "allow",   "block"),
    "community": ("allow",  "block",   "block"),
    "agent-created": ("allow", "allow", "ask"),
}
```

### 3.7 自进化（Background Nudge）

**触发**：每 10 轮对话

**机制**：
- 生成后台 review agent（daemon thread）
- 同模型、max_iterations=8、quiet_mode=true
- 审查完整对话快照
- 可调用 `skill_manage(action='create')` 或 `skill_manage(action='patch')`
- 递归防护：`_memory_nudge_interval=0, _skill_nudge_interval=0`

**Review prompt 聚焦**：
- 记忆审查：用户偏好、行为期望
- Skill 审查：非平凡方法、试错经验、课程修正

---

## 4. OpenClaw — 详细分析

### 4.1 双系统：Skill + Plugin

OpenClaw 同时具备 Skill 系统和 Plugin 系统，两者协作但职责不同：

| | Skill | Plugin |
|--|-------|--------|
| 本质 | prompt/context 资产 | runtime capability bundle |
| 定义 | SKILL.md + frontmatter | `openclaw.plugin.json` manifest |
| 暴露 | `<available_skills>` catalog → 模型自选 | hook 注入 + runtime capability 注册 |
| 激活 | prompt-time catalog 参与 | manifest-first + lazy runtime activation |

### 4.2 Skill 定义格式

`SKILL.md` + YAML frontmatter，比 Codex/Claude Code 的 frontmatter 更重：

- 基础字段：`name`、`description`
- OpenClaw 扩展：`primaryEnv`、`requires`、install spec
- 调用策略：`user-invocable`、`disable-model-invocation`

**关键文件**：
- `src/agents/skills/frontmatter.ts` — frontmatter 解析
- `src/agents/skills/local-loader.ts` — 本地加载器

### 4.3 Skill 发现机制

**多源覆盖 + 6 级优先级**（`workspace.ts`）：

```
extra < bundled < managed < personal < project < workspace
```

来源：
- `extraDirs`（外部目录）
- bundled skills（内置）
- managed skills（组织下发）
- `~/.agents/skills`（个人级）
- `.agents/skills`（项目级）
- `skills/`（workspace 级）

**安全约束**（比 Codex 更防御式）：
- `realpath` containment 防止路径逃逸
- 拒绝 symlink 和超大文件
- candidate 数量限制

### 4.4 加载策略：Prompt Catalog → 模型自选

```
1. resolveEmbeddedRunSkillEntries() — 决定实时加载还是复用 snapshot
2. buildWorkspaceSkillsPrompt() — 生成 <available_skills> catalog
3. 注入 system prompt
4. 模型决定是否读取 SKILL.md 全文
```

**关键设计**：不是 eager full-load，而是"catalog 先注入，模型决定要不要读全文"。

### 4.5 LLM 暴露方式

System prompt 中注入 `<available_skills>` XML catalog + 强制性指令：

```markdown
## Skills (mandatory)
Before replying, scan the skills below. If a skill matches...
```

与 Hermes 类似的"先展示索引、按需加载全文"模式。

### 4.6 Plugin 系统

**Manifest**（`openclaw.plugin.json`）字段非常丰富：
- `id`、`name`、`description`、`kind`、`channels`
- `providers`、`skills`、`activation`、`setup`
- `contracts`、`configContracts`、`channelConfigs`

**发现**（两阶段）：
1. `discoverOpenClawPlugins()` — 扫描配置路径/workspace/bundled/global + TTL cache
2. `loadPluginManifestRegistry()` — 规范化 registry，去重、优先级、兼容性校验

**加载**（`loadOpenClawPlugins()`）：
- manifest registry → lazy runtime proxy（Jiti 延迟加载）
- 插件导出 `register(api)` 或 `activate(api)`
- 支持非激活的 snapshot load / validate mode

**暴露给 LLM**（三条路线）：
1. **Prompt hook**：`before_prompt_build` / `before_agent_start` — 在 prompt 构建前注入上下文
2. **Runtime capability**：通过 `register(api)` 注册 provider、channel、hook、context engine
3. **Skill 贡献**：manifest 中 `skills` 字段或约定目录可把 plugin 自带的 skill dirs 反向挂到 skill discovery，让 workspace 的 catalog 一并展示插件 skill（与 Codex plugin 贡献 skill roots 同型）

**关键文件**：
- `src/plugins/manifest.ts` — manifest 定义
- `src/plugins/discovery.ts` — 发现
- `src/plugins/manifest-registry.ts` — registry
- `src/plugins/loader.ts` — 加载器
- `src/plugins/hook-types.ts` — hook 类型
- `src/agents/skills/plugin-skills.ts` — plugin 贡献 skill 的桥接
- `src/agents/skills/workspace.ts`（L507 附近）— plugin skill dirs 并入 catalog

---

## 5. Codex CLI — 详细分析

### 5.1 双层定义模型

Codex 的 skill 定义是"**文档为主，结构化元数据为辅**"：

- **主文件**：`SKILL.md` + YAML frontmatter（`name`、`description`）
- **辅助文件**：可选 `agents/openai.yaml`，承载 `interface`、`dependencies`、`policy`

**关键文件**：`codex-rs/core-skills/src/loader.rs`

### 5.2 发现机制：分层 Root Registry

`SkillsManager` 从多个来源汇总（Rust 实现）：

1. 项目配置层 `skills/`
2. 兼容保留 `$CODEX_HOME/skills`
3. 用户级 `~/.agents/skills`
4. 系统缓存 `skills/.system`
5. repo `.agents/skills`（从 project root 到 cwd）
6. plugin 贡献的 skill roots

底层扫描：`discover_skills_under_root()` — BFS + 最大深度/目录数限制。

**关键文件**：
- `codex-rs/core-skills/src/manager.rs` — SkillsManager
- `codex-rs/core-skills/src/loader.rs` — 加载器
- `codex-rs/core/src/skills_watcher.rs` — 文件监听

### 5.3 加载策略：Startup Catalog + Explicit-Injection Shortcut + Model-Driven File Open

**三层路径**（不是二选一，而是叠加）：

| 路径 | 时机 | 机制 |
|------|------|------|
| 会话级 catalog | session 启动 | 只拿 metadata，render_skills_section 把 name/description/path 注入 developer message |
| 显式 injection shortcut | 用户明确 mention | `build_skill_injections()` 异步读取完整 SKILL.md 并注入当前 turn |
| 模型主动打开 | 任务匹配 catalog 条目 | developer 指令明确要求模型自行 Read 对应 `SKILL.md` 路径 |

流程：
1. Session 启动 → 加载 plugin → 计算有效 skill roots
2. `skills_manager.skills_for_config(...)` → 获取可用 skills metadata
3. `render_skills_section()` 把 metadata 和路径写进 developer message，明确告诉模型"匹配时打开 SKILL.md"
4. 每个 turn → 检测用户输入是否 mention 某 skill；如果 mention → `build_skill_injections()` 走显式 shortcut；否则模型按 developer 指令自行决定是否 Read 全文

**关键文件**：
- `codex-rs/core/src/codex.rs` — 会话初始化
- `codex-rs/core-skills/src/loader.rs` — SKILL.md 读取
- `codex-rs/core-skills/src/render.rs` — developer 指令 + 路径注入（模型主动打开的入口）
- `codex-rs/core-skills/src/injection.rs` — turn 级显式注入
- `codex-rs/core/src/thread_manager.rs` — 线程管理

### 5.4 LLM 暴露方式：两层暴露

**第一层**（静态）：developer message 中的 `<skills_instructions>` section
- `render_skills_section()` 渲染当前 session 有哪些 skill、描述、路径

**第二层**（动态）：显式 mention 时的 turn-scoped injection
- 目标 skill 的完整 SKILL.md 内容作为 instruction item 注入

**Plugin 暴露也类似**：
- 静态 `<plugins_instructions>` developer section
- 显式 mention 时额外注入 developer hint（MCP servers、apps、skill 前缀）

**关键文件**：
- `codex-rs/core-skills/src/render.rs` — skill 渲染
- `codex-rs/core/src/plugins/render.rs` — plugin 渲染
- `codex-rs/core/src/plugins/injection.rs` — plugin 注入

### 5.5 Plugin 系统

**Manifest**（`.codex-plugin/plugin.json`）：
- 声明 `skills`、`mcpServers`、`apps` + interface 元数据
- 约定俗成路径自动发现：`skills/`、`.mcp.json`、`.app.json`

**发现 & 注册**：
- `PluginsManager.plugins_for_config()` — 从配置层 stack 解析
- plugin 是 **capability bundle registry**：不直接给模型用，而是把 skill roots / MCP / apps 接入已有系统

**关键文件**：
- `codex-rs/core/src/plugins/manifest.rs` — manifest
- `codex-rs/core/src/plugins/manager.rs` — PluginsManager

---

## 6. 对比分析 & 设计启示

### 6.1 四仓库全景对比

| 设计决策 | Claude Code | Hermes | OpenClaw | Codex |
|---------|-------------|--------|----------|-------|
| **Skill 本质** | prompt Command | 知识文档 | prompt/context 资产 | 局部指令资产 |
| **Skill 是 Tool?** | 否 | 否 | 否 | 否 |
| **定义格式** | MD + frontmatter | MD + YAML frontmatter | MD + 重 frontmatter（轻量 manifest） | MD + 可选 YAML sidecar |
| **发现源数** | 4（bundled/file/MCP/managed） | 2（本地/external） | 6（分优先级覆盖） | 6+（多 root + plugin 贡献） |
| **加载策略** | shouldDefer + ToolSearch 按需 | 索引注入 + skill_view() | catalog 注入 + 模型自选 | startup catalog + explicit-injection shortcut + 模型自行打开 |
| **Token 管理** | 精确计数 + 自动阈值 | 60 字符截断 | 索引限制 | metadata-only catalog |
| **安全模型** | 2 阶段 ML 分类器 | 模式匹配 + 4 级信任 | realpath + 大小限制 | BFS 深度/数量限制 |
| **Post-compact** | 有（5K/skill，25K 总预算） | 无 | snapshot 复用 | 无（turn 级注入天然短生命周期） |
| **自进化** | 无 | 有（每 10 轮 nudge） | 无 | 无 |
| **条件激活** | 无原生支持 | 有（requires_toolsets/tools） | 有（requires、primaryEnv） | 弱支持（policy/products + plugin scope 过滤，非 skill 级 requires） |
| **Plugin 系统** | MCP server 即 plugin | 无独立 plugin | manifest-first + hook + runtime | bundle skills/MCP/apps |
| **实现语言** | TypeScript | Python | TypeScript | Rust |

### 6.2 两条设计路线（非互斥）

四个仓库的加载模型可以归纳为两条路线，但**不是互斥的二选一**——OpenClaw 是典型的 hybrid 实现：

**路线 A：可发现的技能目录 + 按需注入**（Claude Code、Codex、Hermes、OpenClaw skills 层）
- Skill 是被动的知识文档
- 通过 catalog/listing 让 LLM 知道有什么
- LLM 按需决定是否加载全文
- 适合：agent 主导型场景

**路线 B：Manifest-first 插件平台 + Hook 注入**（OpenClaw plugins 层）
- Plugin 是主动的 capability bundle
- 通过 manifest 声明能力、通过 hook 改 prompt 和 runtime
- 插件可改变 agent 的行为边界，并能反向贡献 skill dirs 接入路线 A 的 catalog
- 适合：平台型/可扩展型场景

**OpenClaw 是 hybrid**：skills 走路线 A，plugins 走路线 B，两套系统通过 plugin-contributed skill dirs 桥接。Codex 也类似，只是 plugin 层更轻。

**对 Quilin 的含义**：Skill 迭代先走路线 A（M0/M1），Plugin 平台以后再补路线 B（M2+），两者不冲突。

### 6.3 四仓库共识（值得采纳）

1. **Skill ≠ Tool**：四个仓库无一例外，全部将 Skill 与 Tool 分离
2. **SKILL.md 作为标准格式**：YAML frontmatter + Markdown body 是事实标准
3. **分级加载**：没有仓库做 eager full-load，全部是"索引先行、按需加载"
4. **多源发现 + 优先级**：至少 2 源，最多 6 源，优先级覆盖是标配
5. **安全边界**：路径验证、大小限制、内容扫描是基本要求

### 6.4 Quilin 设计建议

基于四仓库研究，Quilin Skill Loading 系统的设计方向：

#### 必须做（M0 — Skill 迭代首期）

| 能力 | 参考 | 理由 |
|------|------|------|
| SKILL.md 格式 + frontmatter schema | 全部四仓库 | 事实标准，无争议 |
| 多源发现（bundled / user / project） | Claude Code + Codex | 覆盖内置 + 个人 + 项目三级 |
| Catalog 索引注入 system prompt | Hermes + OpenClaw + Codex | 避免全量加载，节省 token |
| 按需加载全文（skill_view 或类似） | Hermes + OpenClaw | LLM 主动决策加载 |
| 路径安全 + 大小限制 | OpenClaw | 防止路径逃逸和内存爆炸 |

#### 应该做（M1 — Skill 迭代二期）

| 能力 | 参考 | 理由 |
|------|------|------|
| 条件激活（requires_tools/toolsets） | Hermes、OpenClaw | 减少无关 skill 噪音 |
| Post-compact skill 恢复 | Claude Code | 长对话必备 |
| Skill CRUD 工具（agent 可管理 skill） | Hermes | 自进化的基础设施 |
| skills_guard 安全扫描 | Hermes | agent 创建的 skill 需检查 |

#### 可以延后（M2+）

| 能力 | 参考 | 理由 |
|------|------|------|
| Plugin 贡献 skill roots | Codex、OpenClaw | 两仓库均有强证据，但 Quilin 暂无 Plugin 系统，需在 Plugin 平台立项后再接入 |
| Background nudge 自进化 | Hermes | 与 Quilin Idle Evolution Budget 对齐，但需 planning 能力先到位 |
| ToolSearch 延迟加载 | Claude Code | 工具数少时收益不大 |
| Manifest-first plugin 平台 | OpenClaw | 平台化需求，当前阶段过重 |
| 2 阶段 ML 安全分类器 | Claude Code | 需要额外模型，Iter D 安全迭代再做 |
| Skill discovery prefetch | Claude Code | 优化项，非核心 |

#### 不采纳 / 非本迭代范围

| 能力 | 原仓库 | 理由 |
|------|--------|------|
| 全量 skill 注入 system prompt | 无（无仓库这样做） | Token 浪费 |
| Skill 作为 Tool 注册 | 无 | 违背四仓库共识 |
| import-time 自注册（Python 式） | Hermes | Quilin 选择显式注册（对齐 B1 `MCPRegistry` 模式）：隔离副作用、可单元测试、生命周期可控；import 自注册难以在测试里局部初始化 |
| Install spec / setup / dependencies metadata | OpenClaw | 本迭代目标是 loading，不含 environment setup / package install / plugin onboarding；初版 frontmatter 不引入 install/setup 字段以防 scope creep |

---

## 附录：关键文件索引

### Claude Code

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/Tool.ts` | 792 | Tool 接口、延迟协议、ToolUseContext |
| `src/tools.ts` | 350+ | Tool 注册表（getAllBaseTools）、过滤 |
| `src/utils/toolSearch.ts` | 300+ | 延迟加载、ToolSearchMode、token 阈值 |
| `src/skills/loadSkillsDir.ts` | 400+ | 从磁盘加载 skill、frontmatter 解析 |
| `src/skills/bundledSkills.ts` | 200+ | 内置 skill 注册 |
| `src/utils/attachments.ts` | 2800+ | skill_discovery、skill_listing |
| `src/services/compact/compact.ts` | 1700+ | POST_COMPACT 恢复 |
| `src/utils/permissions/permissions.ts` | 1486 | 权限引擎 |
| `src/utils/permissions/yoloClassifier.ts` | 1495 | 2 阶段 XML 分类器 |

### Hermes Agent

| 文件 | 行数 | 职责 |
|------|------|------|
| `tools/registry.py` | 386 | Tool 注册 & dispatch |
| `tools/skill_manager_tool.py` | 761 | Skill CRUD + 验证 |
| `tools/skills_guard.py` | ~700 | 安全扫描（30+ 模式） |
| `agent/prompt_builder.py` | 1043 | System prompt 组装、skill 发现 & 缓存 |
| `agent/skill_utils.py` | 443 | Skill 元数据工具 |
| `toolsets.py` | 400+ | Toolset 层级 |
| `run_agent.py` | 10871 | AIAgent 核心、background nudge |

### OpenClaw

| 文件 | 职责 |
|------|------|
| `src/agents/skills/frontmatter.ts` | Skill frontmatter 解析 |
| `src/agents/skills/local-loader.ts` | 本地 skill 加载器 |
| `src/agents/skills/workspace.ts` | 多源发现 + 优先级 + catalog 生成 |
| `src/agents/pi-embedded-runner/skills-runtime.ts` | Skill 运行时（snapshot / 实时切换） |
| `src/agents/pi-embedded-runner/run/attempt.ts` | embedded runner 入口 |
| `src/agents/system-prompt.ts` | System prompt 组装 |
| `src/plugins/manifest.ts` | Plugin manifest 定义 |
| `src/plugins/discovery.ts` | Plugin 发现 |
| `src/plugins/manifest-registry.ts` | Plugin registry |
| `src/plugins/loader.ts` | Plugin 加载器（Jiti lazy） |
| `src/plugins/hook-types.ts` | Plugin hook 类型 |

### Codex CLI

| 文件 | 职责 |
|------|------|
| `codex-rs/core-skills/src/loader.rs` | Skill 加载器 |
| `codex-rs/core-skills/src/manager.rs` | SkillsManager（多 root 发现） |
| `codex-rs/core-skills/src/injection.rs` | Turn 级 skill 注入 |
| `codex-rs/core-skills/src/render.rs` | Skill prompt 渲染 |
| `codex-rs/core/src/skills_watcher.rs` | 文件监听 |
| `codex-rs/core/src/codex.rs` | 会话初始化 |
| `codex-rs/core/src/thread_manager.rs` | 线程管理 |
| `codex-rs/core/src/plugins/manifest.rs` | Plugin manifest |
| `codex-rs/core/src/plugins/manager.rs` | PluginsManager |
| `codex-rs/core/src/plugins/render.rs` | Plugin prompt 渲染 |
| `codex-rs/core/src/plugins/injection.rs` | Plugin 注入 |
