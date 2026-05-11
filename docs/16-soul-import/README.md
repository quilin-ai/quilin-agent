# 灵魂导入（Soul Import）

> **状态（2026-05-12）**：spec draft。代码尚未实现 — `~/.quilin/soul.md` 和 `~/.quilin/user.md` 的 schema 与默认值生成已在 `packages/agent-core/src/config/soul-profile.ts`（QUI-108，commit `1d57d08`）落地，**框架导入填充 body / 项目级 QUILIN.md 生成器 / 安装期扫描器三块尚未实现**。落地工作由 [QUI-102](https://linear.app/quilin-agent/issue/QUI-102) 承接（已从原 2 框架 scope 扩展到 6 框架 + QUILIN.md generator + install scanner）。

---

## 一、定位 / One-line Positioning

When the user installs Quilin for the first time, Quilin must already feel like it *knows* the user — not greet them as a stranger. Soul Import achieves this by scanning the user's existing agent-framework installations on the local machine and seeding Quilin's three durable identity artifacts (global `soul.md`, global `user.md`, per-project `QUILIN.md`) from that prior context.

用户第一次安装麒麟时，麒麟必须已经"认识"用户，而不是把用户当陌生人重新打招呼。灵魂导入通过扫描用户本机上已安装的其他 Agent 框架，把它们沉淀的上下文喂给麒麟的三个长期身份文件（全局 `soul.md`、全局 `user.md`、项目级 `QUILIN.md`），让麒麟从 day 1 就具备对用户的初始感知。

This domain is the **install-time bootstrap** counterpart to the runtime-time `observer → ProfileUpdater → user.md` chain owned by Iter H. Soul Import handles the cold start; Iter H handles continuous evolution.

本领域是与 Iter H 的运行期 `observer → ProfileUpdater → user.md` 链路对偶的**安装期 bootstrap** 路径。灵魂导入处理冷启动；Iter H 处理持续进化。

---

## 二、两层架构 / Two-layer Architecture

Soul Import deliberately separates global identity from per-project context. Mixing them is the single biggest design risk for this domain.

灵魂导入刻意把全局身份和项目上下文分开。混在一起是本领域设计上最大的风险。

| 层 / Layer | 文件路径 / Path | 跨项目? / Cross-project? | 拥有者 / Owner |
|-----------|---------------|------------------------|---------------|
| 全局 / Global | `~/.quilin/soul.md` | ✅ | 麒麟人格（zodiac/MBTI/沟通风格） |
| 全局 / Global | `~/.quilin/user.md` | ✅ | 用户全局画像（身份/偏好/习惯） |
| 项目 / Project | `<project-root>/QUILIN.md` | ❌ | 该项目的协作指南 |

The global layer answers *"who is Quilin"* and *"who is the user"* — the same answers across every project. The project layer answers *"how should Quilin behave inside this specific repository"* — language conventions, commit style, test thresholds, warning zones.

全局层回答"麒麟是谁"和"用户是谁"，跨项目共享。项目层回答"在这个具体仓库里麒麟该怎么做"，覆盖语言约定、commit 风格、测试门槛、警告区域。

### 2.1 全局层：复用 soul-profile.ts / Global Layer: Reuse soul-profile.ts

The artifact format and default-value scaffolding already exist in `packages/agent-core/src/config/soul-profile.ts` (369 LOC, 18 tests, commit `1d57d08`). Soul Import **must not redefine these schemas** — it only populates the `body` field of each artifact with imported content.

文件格式和默认值脚手架已经存在于 `packages/agent-core/src/config/soul-profile.ts`（369 行，18 测试，commit `1d57d08`）。灵魂导入**不得重新定义 schema**，只负责往两个文件的 `body` 字段灌入导入后的内容。

Current placeholders that Soul Import will replace:

灵魂导入要替换掉的当前占位内容：

- `soul.md` body — hardcoded 5-line "我是 Quilin，你的本地 AI 伙伴..." default
- `user.md` body — 4-section "（待发现）" placeholder

The frontmatter fields (`zodiac` / `mbti` / `gender` / `core_values` / `communication_style`) remain random-generated on first install, since they represent Quilin's own persona, not derivable from user data. Imported framework data may adjust `communication_style` only (e.g., if Claude Code memory shows the user prefers terse responses, set `communication_style: "terse"`).

frontmatter 字段（`zodiac` / `mbti` / `gender` / `core_values` / `communication_style`）首次安装时仍然随机生成，因为它们代表麒麟自己的人格，无法从用户数据推导。导入的框架数据只允许调整 `communication_style`（例如 Claude Code memory 显示用户偏好简洁回复 → 设为 `terse`）。

### 2.2 项目层：QUILIN.md 生成器 / Project Layer: QUILIN.md Generator

When Quilin first attaches to a user project, it scans the project root for sibling agent-guide files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, etc.), synthesizes a unified `QUILIN.md`, and writes it to the project root. The user reviews/edits it once; Quilin auto-loads it as part of every system prompt in that project (analogous to Claude Code loading project-level `CLAUDE.md`).

麒麟第一次接入一个用户项目时，扫描项目根目录里其他 Agent 框架的指南文件（`CLAUDE.md`、`AGENTS.md`、`GEMINI.md` 等），综合生成一份统一的 `QUILIN.md` 写到项目根。用户审核/编辑一次；之后麒麟在该项目内的每轮 system prompt 都自动加载它（类比 Claude Code 加载项目级 `CLAUDE.md`）。

Synthesis rules (v1):

合成规则（v1）：

- **Dedupe** — identical rules across sibling files keep only one copy
- **Merge** — overlapping rules consolidated with provenance tag (e.g., `<!-- from: CLAUDE.md, AGENTS.md -->`)
- **Conflict** — divergent rules surfaced to user for manual choice, never silently merged
- **Quilin-specific section** — always append a `## 麒麟约定 / Quilin Conventions` section covering AUTO/CRITICAL gate, cross-review loop, Linear discipline (project-relevant subset of the global rules)

QUILIN.md generation is **never silent**: even with `--trust auto`, the user sees a diff preview and confirms before write. The file is project-local data and counts as CRITICAL under 07-safety.

QUILIN.md 生成**永远不静默**：即使 `--trust auto` 模式，用户也会看到 diff preview 并确认后才写入。该文件属于项目本地数据，按 07-safety 计入 CRITICAL。

---

## 三、六个源框架 / Six Source Frameworks

| # | 框架 / Framework | 默认路径 / Default Path | 主要采集 / What We Read |
|---|-----------------|----------------------|---------------------|
| 1 | OpenClaw | `~/.openclaw/` | memory store, config, agent definitions |
| 2 | Hermes Agent | `~/.hermes/` | persistent memory, skill bundle, prefs |
| 3 | Claude Code | `~/.claude/` | `CLAUDE.md`（global）, `settings.json`, `projects/*/memory/`, project-local `CLAUDE.md` |
| 4 | Codex | `~/.codex/` | `AGENTS.md`, config, session history |
| 5 | Gemini CLI | `~/.gemini/` | `GEMINI.md`, config, history |
| 6 | OpenCode | `~/.opencode/` | rules, config, history |

Detection is path-based with a fallback `which`/binary probe for each framework's CLI. A framework counts as "present" if either the config directory exists **or** the binary is on `$PATH`. Both signals are reported to the user during the scan preview.

检测以路径为主，每个框架的 CLI 用 `which`/binary 探针做兜底。只要配置目录存在**或**二进制在 `$PATH` 上，该框架就计为"已安装"。两路信号都会在扫描预览里展示给用户。

Per-framework adapter contract (TypeScript):

每个框架 adapter 的契约（TypeScript）：

```typescript
interface FrameworkAdapter {
  readonly id: "openclaw" | "hermes" | "claude-code" | "codex" | "gemini-cli" | "opencode";
  detect(): Promise<DetectResult>;
  preview(): Promise<ImportPlan>;          // dry-run, returns what would be imported
  importData(plan: ImportPlan): Promise<ImportResult>;
}

interface DetectResult {
  readonly present: boolean;
  readonly configPath?: string;
  readonly binaryPath?: string;
  readonly version?: string;
}

interface ImportPlan {
  readonly globalMemoryItems: readonly MemoryItem[];   // → quilin-mem
  readonly userProfileFragments: readonly string[];    // → user.md body
  readonly projectGuides: readonly ProjectGuide[];     // → per-project QUILIN.md inputs
  readonly redactedSecrets: readonly RedactedItem[];   // never imported, just reported
}
```

Adapter ordering does not matter; conflicts between frameworks are surfaced to the user (not silently resolved by a precedence rule). Empirically, Claude Code is expected to produce the richest dataset; the user is likely to weight it highest.

Adapter 之间没有先后顺序；框架之间的冲突由用户决定，不靠预设优先级静默合并。经验上 Claude Code 数据最丰富，用户大概率会给它最高权重。

---

## 四、安装期流程 / Install-time Flow

```
$ quilin install
  │
  ├─ 1. ensureDefaultConfigs()            # 已实现（QUI-108）
  │    ↳ ~/.quilin/soul.md  + ~/.quilin/user.md（占位 body）
  │
  ├─ 2. FrameworkScanner.detect()         # 本域新增
  │    ↳ 并行跑 6 个 adapter.detect()
  │    ↳ 输出："发现 4 个框架: Claude Code, Codex, OpenClaw, Hermes"
  │
  ├─ 3. user 确认是否导入                  # 默认全选；可逐项取消
  │
  ├─ 4. adapter.preview() 并行             # dry-run
  │    ↳ 汇总展示：导入 X 条记忆 / Y 段画像 / Z 个项目指南
  │    ↳ 标注 redacted secrets（不导入）
  │    ↳ 标注框架间冲突（user 选择保留哪边）
  │
  ├─ 5. WriteAuthority gate（CRITICAL）   # 07-safety
  │    ↳ AUTO mode 也必须显式确认
  │
  ├─ 6. adapter.importData() 顺序执行      # 顺序便于回滚
  │    ├─ 写 quilin-mem 4 层（带 source provenance）
  │    ├─ 重写 ~/.quilin/user.md body（保留 frontmatter）
  │    ├─ 调整 ~/.quilin/soul.md communication_style（仅此一字段）
  │    └─ 缓存 ProjectGuide → 等用户首次 attach 到项目时触发 QUILIN.md 生成
  │
  └─ 7. 完成报告 + 撤销提示                # 写入 import-receipt.json，支持 undo
```

The flow is **never re-run silently**. If the user re-runs `quilin install` later, Soul Import detects existing receipts and asks before doing anything (re-import vs incremental vs skip).

整个流程**绝不静默重跑**。用户后续再跑 `quilin install`，灵魂导入识别到已存在的 import-receipt 后会询问（重新导入 / 增量 / 跳过）。

QUILIN.md generation for a specific project is **lazy**: triggered only when Quilin first attaches to that project (`quilin attach .` or first `quilin run` in that directory). The cached `ProjectGuide` from step 6 is the seed input.

针对某个项目的 QUILIN.md 生成是**惰性**的：只在麒麟第一次接入该项目时触发（`quilin attach .` 或在该目录第一次跑 `quilin run`）。第 6 步缓存的 `ProjectGuide` 是种子输入。

---

## 五、安全门 / Safety Gate

All Soul Import write operations are classified **CRITICAL** under 07-safety and route through `WriteAuthority.ask()`:

灵魂导入所有写操作按 07-safety 归类为 **CRITICAL**，统一走 `WriteAuthority.ask()`：

- Write to `~/.quilin/user.md` / `~/.quilin/soul.md`（cross-session global state）
- Write to `<project-root>/QUILIN.md`（user repository file）
- Bulk write to `quilin-mem`（hundreds-to-thousands of memory items at once）

`origin: "install"` writes require **explicit user keystroke confirmation** even under `--trust auto`. There is no silent path. This is stricter than the default `--trust auto` policy for ordinary tool calls — install-time is a one-shot, high-impact event and deserves the friction.

`origin: "install"` 的写入即使在 `--trust auto` 下也必须**用户明确按键确认**，没有静默路径。这比一般工具调用的 `--trust auto` 策略更严格 — 安装是一次性的高影响事件，值得这点摩擦。

Redaction rules (run inside each adapter before `preview()`):

脱敏规则（在每个 adapter 的 `preview()` 之前运行）：

- Secrets matching `(?i)(api[_-]?key|token|password|secret|bearer)\s*[:=]\s*[A-Za-z0-9_\-]{16,}` → drop
- Paths inside `.ssh/` / `.gnupg/` / `.aws/credentials` → drop
- Anything in known secret-managing tools' output (1Password CLI, Doppler, etc.) → drop
- Redacted items are surfaced in the preview as "X items skipped (likely secrets)" with no content — user can override per item if needed

---

## 六、与其他域的边界 / Boundary with Other Domains

| 相关域 / Related | 关系 / Relationship |
|---------------|-------------------|
| **02-context** | `soul.md` + `user.md` body 是 system prompt 装配的素材源（PromptSessionAssembler 读取）。本域只生成内容，组装逻辑归 02。 |
| **03-memory** | 导入的 memory items 落进 quilin-mem 四层，**带 `source` provenance 字段**。schema 改动需经 03 评审。 |
| **07-safety** | WriteAuthority gate + redaction 策略归 07，本域只是调用方。 |
| **09-deployment-runtime** | `quilin install` CLI 是 09 的范畴，本域提供 install hook（`onPostInstall`）。 |
| **10-self-evolution** | 导入数据是 User Insight Engine 的种子；Insight Engine 后续从持续对话里继续提取，跟本域的"一次性安装期"互补。 |
| **13-skills** | 框架自带的 skill bundle（如 Claude Code skills）映射到 `~/.quilin/skills/`，复用 13 的多源扫描策略。 |
| **Iter H** | observer → ProfileUpdater → user.md 是运行期持续更新；本域是安装期 cold start。两者写同一个 user.md，必须共享并发/原子写策略。 |
| **QUI-108** | soul-profile.ts 是 artifact 格式定义；本域是数据填充层。不重定义 schema。 |

---

## 七、实现现状 / Current Implementation Status

| 组件 / Component | 状态 / Status | 实证 / Evidence |
|----------------|--------------|----------------|
| `soul.md` / `user.md` schema + default scaffolding | ✅ 已实现 | `packages/agent-core/src/config/soul-profile.ts`，commit `1d57d08`，18 tests |
| FrameworkScanner（6 adapter） | ⛔ 未实现 | QUI-102 待启动 |
| 安装期扫描 → preview → 确认流程 | ⛔ 未实现 | QUI-102 待启动 |
| user.md / soul.md body 填充 | ⛔ 未实现 | QUI-102 待启动 |
| QUILIN.md 生成器（项目层） | ⛔ 未实现 | QUI-102 待启动 |
| 项目层 QUILIN.md 在 02-context 中的 auto-load | ⛔ 未实现 | 需要 02-context 配套改动 |

---

## 八、相关 Linear / Related Linear

- [QUI-102](https://linear.app/quilin-agent/issue/QUI-102) — 主 issue（已扩 scope 到 6 框架 + QUILIN.md generator + install scanner）
- [QUI-108](https://linear.app/quilin-agent/issue/QUI-108) — soul.md/user.md 显式配置文件（已 Done，本域的 artifact 基础）
- [QUI-83](https://linear.app/quilin-agent/issue/QUI-83) — QUI-102 的 parent（生态集成总 issue）
- [Iter H](https://linear.app/quilin-agent/project/iter-h记忆与感知深度化-memory-and-perception-deepening-2c428c730964) — 运行期 observer → ProfileUpdater 链路（与本域对偶）
- [Iter J](https://linear.app/quilin-agent/project/iter-j生态与连接-ecosystem-and-connectivity-49ac7dda76b7) — 本域所属的生态集成 Iter

---

## 九、Open Questions

These are intentionally left for the implementation phase to answer with evidence rather than upfront design.

这些问题刻意留到实现阶段用实证回答，而不是前置设计。

1. **冲突解决 UI 形态** — TUI checkbox / web preview / JSON 编辑哪种交互最低成本？等 09 的 TUI 决策落定后选。
2. **OpenClaw / Hermes export 格式稳定性** — 这两个框架的 export schema 是否稳定到可以编程读取？需要先做 spike 探测。
3. **跨框架记忆去重粒度** — 同一条用户画像在 4 个框架里都有，按文本相似度去重还是按 source 优先级保留多份？等真数据再决定。
4. **QUILIN.md 合成的 LLM 调用预算** — 综合多份指南文件需要 LLM 推理；首次安装时是否要求联网？还是允许 offline 退化为简单拼接 + dedupe？
