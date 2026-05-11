# Spike — 框架探测真数据 / Framework Detection Real-Data Findings (2026-05-12)

> 本文档是 [QUI-102 灵魂导入 / Soul Import](https://linear.app/quilin-agent/issue/QUI-102) spike 的实证产物，回答 [README.md §九 Open Question 2](README.md) — "OpenClaw / Hermes export 格式稳定性"。所有数据点来自单一开发机的本地探测；不包含个人身份信息或敏感凭证内容，只记录结构与文件类型。
>
> This document is the evidence artifact from the [QUI-102 Soul Import](https://linear.app/quilin-agent/issue/QUI-102) spike, answering [README.md §9 Open Question 2](README.md) — "OpenClaw / Hermes export-format stability". All datapoints come from local probing on a single development machine; no personal-identifying information or sensitive credential content is recorded, only structure and file types.

---

## 一、探测结果总览 / Detection Results Summary

A scan of the six target frameworks on a typical macOS developer machine found all six binaries on `$PATH`, and five out of six have a populated config directory under `$HOME`. OpenCode has a binary but no `~/.opencode` directory (suggesting it stores config elsewhere or had not been launched yet on this machine).

在一台典型的 macOS 开发机上探测六个目标框架，发现六个二进制全部在 `$PATH` 上，六个里有五个在 `$HOME` 下有非空的 config 目录。OpenCode 只有 binary，没有 `~/.opencode` 目录（说明它要么把 config 放在别处，要么这台机器还没启动过它）。

| Framework | Config Dir | Binary | Status |
|-----------|-----------|--------|--------|
| Claude Code | ✅ `~/.claude/` (46 top-level entries) | ✅ `~/.local/bin/claude` | Both present |
| Codex | ✅ `~/.codex/` (37 top-level entries) | ✅ via nvm | Both present |
| Gemini CLI | ✅ `~/.gemini/` (14 top-level entries) | ✅ via nvm | Both present |
| OpenClaw | ✅ `~/.openclaw/` (24 top-level entries) | ✅ via nvm | Both present |
| Hermes | ✅ `~/.hermes/` (33 top-level entries) | ✅ `~/.local/bin/hermes` | Both present |
| OpenCode | ❌ no dir | ✅ via homebrew | **Binary-only** |

This means the QUI-102 implementation must treat **all three cases** as first-class — config-only, binary-only, and both-present — combined as `(hasConfig || hasBinary) → present`. The binary-only case (OpenCode here) is real, not an edge case.

也就是说 QUI-102 实现必须把**三种情况都当成一等公民**处理 —— 仅 config、仅 binary、两者都有，按 `(hasConfig || hasBinary) → present` 合并。仅 binary 的情况（这里的 OpenCode）是真实场景，不是 edge case。

---

## 二、按框架观察到的数据形态 / Per-framework Observed Data Shape

### Claude Code

The richest source. Top-level entries include `agents/` (14 custom agents), `projects/*/memory/` (per-project memory directories, 12 projects observed), global `CLAUDE.md`, `AGENTS.md`, `settings.json`, `commands/`, `cache/`, `channels/`, `chrome/`, `backups/`, `debug/`. Project-level memory is in `projects/<encoded-path>/memory/<key>.md` form — one Markdown file per memory key, per project.

最丰富的数据源。顶层包括 `agents/`（14 个自定义 agent）、`projects/*/memory/`（每项目独立的 memory 目录，本机观察到 12 个项目）、全局 `CLAUDE.md`、`AGENTS.md`、`settings.json`、`commands/`、`cache/`、`channels/`、`chrome/`、`backups/`、`debug/`。项目级 memory 是 `projects/<encoded-path>/memory/<key>.md` 的形态 —— 每项目每条 memory 各一个 Markdown 文件。

**Implication for adapter**: Claude Code adapter will need to handle (a) global CLAUDE.md as user profile fragment, (b) per-project memory directories mapping to per-project QUILIN.md inputs, (c) agents directory mapping to Quilin skills, (d) settings.json mapping to Quilin config. This is multi-target import — the richest mapping work of the six.

**对 adapter 的影响**：Claude Code adapter 需要处理 (a) 全局 CLAUDE.md 作为用户画像片段，(b) 项目级 memory 目录映射到项目级 QUILIN.md 输入，(c) agents 目录映射到 Quilin skills，(d) settings.json 映射到 Quilin 配置。这是多目标导入 —— 六个里映射工作最重的。

### Codex

Config is `config.toml` (TOML format), session data in `archived_sessions/`, `AGENTS.md` as a global agent guide. Has multiple `config.toml.bak.*` backup files. Auth in `auth.json`.

配置是 `config.toml`（TOML 格式），session 数据在 `archived_sessions/`，全局 `AGENTS.md`。有多个 `config.toml.bak.*` 备份文件。auth 在 `auth.json`。

**Implication**: Adapter needs a TOML parser. Backup files should be ignored. `auth.json` is a secret — must redact.

**对 adapter 的影响**：需要 TOML 解析器。备份文件忽略。`auth.json` 是敏感凭证 —— 必须脱敏。

### Gemini CLI

Smaller config: 14 entries. Notable files: `GEMINI.md` (project guide), `settings.json` (config, JSON), `projects.json` (project list, JSON), `history/` (6 entries on this machine — small dataset), `oauth_creds.json` (OAuth tokens — secret), `google_accounts.json` (account metadata — likely secret).

配置较小：14 个条目。关键文件：`GEMINI.md`（项目指南）、`settings.json`（配置，JSON）、`projects.json`（项目列表，JSON）、`history/`（本机 6 条 —— 数据量小）、`oauth_creds.json`（OAuth token —— 敏感）、`google_accounts.json`（账户元数据 —— 可能敏感）。

**Implication**: JSON parsers (already in Node stdlib). Both `oauth_creds.json` and `google_accounts.json` must redact by default. History is short — likely safe to import wholesale after redaction.

**对 adapter 的影响**：JSON 解析（Node 标准库自带）。`oauth_creds.json` 和 `google_accounts.json` 默认脱敏。history 短 —— 脱敏后整体导入应该安全。

### OpenClaw

24 top-level entries. Notable: `agents/` (1 file observed), `memory/` (1 file observed), `completions/` (4 files), `identity/` (2 files), `credentials/` (sensitive — redact), `canvas/`, `cron/`, `delivery-queue/`, `devices/`, `extensions/`, `feishu/`. Schema is **not publicly documented** (closed-source framework); files in `memory/` and `completions/` appear to be opaque to outside observers without reverse engineering.

24 个顶层条目。关键：`agents/`（本机观察到 1 个文件）、`memory/`（1 个文件）、`completions/`（4 个文件）、`identity/`（2 个文件）、`credentials/`（敏感 —— 脱敏）、`canvas/`、`cron/`、`delivery-queue/`、`devices/`、`extensions/`、`feishu/`。schema **未公开**（闭源框架）；`memory/` 和 `completions/` 里的文件在不做逆向工程的情况下对外部观察者是不透明的。

**Implication & Open Question 2 verdict**: **OpenClaw export schema is NOT stable for programmatic consumption** — we cannot rely on documented contracts. Recommended approach: adapter does **best-effort import** by treating any `.md` / `.json` / `.yaml` file in known subdirs as opaque text content, attaches `source: "openclaw"` and `confidence: "low"` provenance, and surfaces to user in preview with "schema is undocumented — review before import". Do not invest in deep parsing.

**对 adapter 的影响 + Open Question 2 结论**：**OpenClaw export schema 不稳定到可编程消费** —— 没有公开契约可依赖。建议做法：adapter 走**尽力而为**导入，把已知子目录里的 `.md` / `.json` / `.yaml` 文件当不透明文本，附 `source: "openclaw"` 和 `confidence: "low"` provenance，预览时明确告诉用户"schema 未公开 —— 导入前请审核"。不做深度解析。

### Hermes Agent

33 top-level entries. Notable: `config.yaml` (YAML config), `BOOT.md` (boot rules), `channel_directory.json`, `gateway_state.json`, `auth.json` + `auth.lock` (secret), `cache/`, `cron/`, `audio_cache/`. Memory equivalent appears to live in `channel_directory.json` + per-channel state files. Schema is **also not publicly documented**.

33 个顶层条目。关键：`config.yaml`（YAML 配置）、`BOOT.md`（启动规则）、`channel_directory.json`、`gateway_state.json`、`auth.json` + `auth.lock`（敏感）、`cache/`、`cron/`、`audio_cache/`。记忆等价物似乎在 `channel_directory.json` + 各 channel 状态文件里。schema **同样未公开**。

**Implication & Open Question 2 verdict**: Same as OpenClaw — undocumented schema, best-effort import with low-confidence provenance. The `BOOT.md` is human-readable Markdown and is the highest-quality user-profile signal here; should be prioritized in the adapter.

**对 adapter 的影响 + Open Question 2 结论**：与 OpenClaw 一致 —— schema 未公开，走低置信度尽力导入。`BOOT.md` 是人类可读的 Markdown，是这里质量最高的用户画像信号；adapter 应优先处理它。

### OpenCode

Binary-only on this machine — no config dir. The adapter correctly reports `present: true, configPath: undefined, binaryPath: <path>`. Preview phase should report "OpenCode binary found but no config to import; skipping".

本机只有 binary —— 没有 config 目录。adapter 正确报告 `present: true, configPath: undefined, binaryPath: <path>`。preview 阶段应报告"找到 OpenCode binary 但没有 config 可导入；跳过"。

**Implication**: This case (binary-without-config) is real and must be supported by all six adapters, not treated as an edge case.

**对 adapter 的影响**：这种情况（仅 binary，无 config）真实存在，六个 adapter 都必须支持，不能当作 edge case。

---

## 三、安全观察 / Security Observations

Five out of six frameworks (everyone except OpenCode, which has no config dir on this machine) store **secrets in plaintext or near-plaintext** inside their config directories:

六个框架里有五个（除 OpenCode，因为它在这台机器上没 config 目录）在 config 目录里**以明文或近明文形式存储 secrets**：

- Claude Code: `settings.json` may contain API keys depending on user config
- Codex: `auth.json`
- Gemini CLI: `oauth_creds.json`, `google_accounts.json`
- OpenClaw: `credentials/` directory
- Hermes: `auth.json` (+ `auth.lock`)

This **validates the spec's "redact by default" requirement** as non-optional. Soul Import's redaction layer must intercept these paths/files **before they reach the dry-run preview**, not just at import time, to ensure secrets never appear in any user-facing display.

这**验证了 spec 中"默认脱敏"要求是不可妥协的**。灵魂导入的脱敏层必须**在 dry-run preview 之前**拦截这些路径/文件，而不是只在 import 时拦截，以确保 secrets 永不出现在任何面向用户的展示里。

Concrete redaction file/path list for the production implementation:

生产实现的具体脱敏文件/路径清单：

```
~/.codex/auth.json
~/.gemini/oauth_creds.json
~/.gemini/google_accounts.json
~/.openclaw/credentials/**
~/.hermes/auth.json
~/.hermes/auth.lock
**/settings.json   (regex-scan only, since may or may not contain keys)
**/.aws/credentials
**/.ssh/**
**/.gnupg/**
```

---

## 四、Open Question 答案 / Open Question Answers

| Question (from README.md §9) | Verdict |
|------------------------------|---------|
| **Q2 — OpenClaw / Hermes export 格式稳定性** | **Not stable / undocumented.** Adapter must use best-effort opaque-text import with low-confidence provenance. Do not invest in deep parsing. |
| Q4 — QUILIN.md 合成的 LLM 调用预算 | Partial answer: Claude Code's per-project memory + AGENTS.md + CLAUDE.md alone may exceed simple-concat budget. A small LLM call (Haiku-class) is likely needed for dedupe+merge. Full answer deferred to QUILIN.md generator implementation. |

Q1 (UI form) and Q3 (cross-framework dedupe granularity) remain unanswered — they need a richer dataset (multiple machines, multiple users) before deciding.

Q1（UI 形态）和 Q3（跨框架去重粒度）尚未回答 —— 需要更丰富的数据集（多机、多用户）才能决定。

---

## 五、调研范围 / Investigation Scope

This spike is **investigation-only — no production code landed**. The findings here are intended as input to QUI-102's design phase; the actual `FrameworkScanner` + 6 adapters will be built as part of that issue's implementation, informed by the data points above.

本 spike 是**纯调研 —— 没有生产代码落地**。本文的发现作为 QUI-102 设计阶段的输入；真正的 `FrameworkScanner` 和 6 个 adapter 会在 QUI-102 实现阶段构建，参考本文的数据点。

Items investigated:

调研过的事项：

- Default config path under `$HOME` for each of the six frameworks
- Binary presence on `$PATH` for each
- Top-level directory structure and entry count per framework
- File-type composition (TOML / YAML / JSON / Markdown) of each framework's config
- Identified secret-bearing files/paths that the redaction layer must intercept
- Schema-stability assessment for OpenClaw and Hermes (answering Open Question 2)

Items deliberately not investigated (deferred to implementation phase):

刻意未调研的事项（延后到实现阶段）：

- Full content parsing of each framework's memory files
- Cross-framework deduplication of overlapping user-profile fragments
- LLM budget for QUILIN.md synthesis
- Linux / Windows path conventions (this spike was macOS-only)
