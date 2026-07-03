# 外部 agent 接 quilin-mem 指南 / Connect External Agents to quilin-mem

> **目标 / Goal**:让 Claude Code / Codex / Gemini CLI / OpenCode / 任何 MCP-compatible agent 用上 Quilin 的完美记忆系统 v2(QUI-191 epic ship)。
>
> **方式 / Method**:Quilin 的 quilin-mem 是标准 MCP server(stdio),任何 MCP 客户端都能接。

---

## 1. 前置依赖 / Prerequisites

| 依赖 | 版本 | 说明 |
|---|---|---|
| **Python** | 3.14+ | quilin-mem provider 跑 |
| **uv** | latest | Python 包管理 |
| **SQLite** | 内置 | 自动建本地 `~/.quilin/memory.db` |
| **DeepSeek API key** | 可选 | LLM observer / dedupe / batch judge / safety gate 用;**没 key 会退到 exact-only**(去重/检索仍能跑,只是没语义判断) |
| **MCP-compatible client** | stdio | Claude Code / Codex / Gemini CLI 等 |

---

## 2. 安装 / Install

```bash
# 1. clone quilin-agent
git clone https://github.com/quilin-ai/quilin-agent.git ~/repo/quilin-agent
cd ~/repo/quilin-agent

# 2. 装 Python 依赖
cd providers/memory
uv sync

# 3. 设 LLM key(可选,推荐设)
export DEEPSEEK_API_KEY="sk-..."
# 或者持久化到 shell 配置文件

# 4. 测试 quilin-mem 能跑
uv run python -m quilin_mem
# 应该看到 MCP server 在 stdio 上 listen,Ctrl+C 退出
```

---

## 3. MCP 客户端配置

### Claude Code(`~/.claude/claude_desktop_config.json` 或 `~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "quilin-mem": {
      "command": "uv",
      "args": [
        "run",
        "--project",
        "/Users/<你的用户名>/repo/quilin-agent/providers/memory",
        "python",
        "-m",
        "quilin_mem"
      ],
      "env": {
        "DEEPSEEK_API_KEY": "sk-...",
        "QUILIN_RETRIEVAL_SAFETY_ENABLED": "true",
        "QUILIN_DEDUPE_BATCH_ENABLED": "true"
      }
    }
  }
}
```

### Codex(`~/.codex/config.toml` 或类似)

```toml
[mcp.servers.quilin-mem]
command = "uv"
args = [
  "run",
  "--project",
  "/Users/<你的用户名>/repo/quilin-agent/providers/memory",
  "python",
  "-m",
  "quilin_mem"
]
env = { DEEPSEEK_API_KEY = "sk-..." }
```

### Gemini CLI(`~/.gemini/mcp.json`)

```json
{
  "servers": {
    "quilin-mem": {
      "command": "uv",
      "args": ["run", "--project", "<absolute path>/providers/memory", "python", "-m", "quilin_mem"]
    }
  }
}
```

### Quilin 自己(已 wire 好,无需配置)

`packages/agent-core` 内部自动 spawn quilin-mem 子进程。

---

## 4. 可用 MCP 工具 / Available MCP Tools

接进去之后 agent 能调以下工具(全部 wire shape 稳定,语义 stable):

### 4.1 写入 / Write

| Tool | 用途 | 经过 WriteAuthority gate? |
|---|---|---|
| `memory_store` | 存一条记忆(自动分 tier:working / episodic / semantic) | ✅ |
| `memory_update` | 改一条记忆(走 supersede chain,旧版本保留) | ✅ |
| `memory_delete` | 删一条记忆(默认 soft-delete,72h 内可 recover) | ✅ |
| `memory_recover` | 恢复 soft-deleted 记忆(72h 窗口内) | ✅ |
| `memory_delete_preview` | 删除前预览影响范围 | ❌(纯读)|

### 4.2 读取 / Read

| Tool | 用途 |
|---|---|
| `memory_recall` | 召回相关记忆(混合检索 + safety gate scrub + project scope 加权) |
| `memory_list_by_layer` | 按 tier 列记忆(分页) |
| `memory_evidence_graph` | 拿某条记忆的证据链(原始观察 / 版本链 / 责任人) |
| `memory_prospective_list_due` | 列到期的前瞻记忆(待办 / 提醒) |

### 4.3 整理 / Consolidate

| Tool | 用途 |
|---|---|
| `memory_consolidate_plan` | 提议整理方案(batch LLM judge + 时间感知 dedupe + 破坏防护) |
| `memory_consolidate_execute` | 执行整理方案(走 WriteAuthority) |

### 4.4 灵魂导入 / Soul Import(QUI-81)

`packages/agent-core` 内部 API,**不通过 MCP 暴露**。在 Quilin install 时触发,扫 6 框架(OpenClaw / Hermes / Claude Code / Codex / Gemini CLI / OpenCode)生成 user.md / soul.md / QUILIN.md 候选。外部 agent 不直接调。

---

## 5. 安全模型 / Security Model

### 5.1 WriteAuthority gate(关键限制)

Quilin 的 14 类敏感操作(包括 `memory_store` 写入语义层 / `memory_update` 改主体记忆 / `memory_delete` 删除 / `memory_consolidate_execute` 等)**默认要经过 WriteAuthority 审批门**。

但 **WriteAuthority gate 只在 Quilin 自己的 agent-core 内部 wire 好**。**外部 agent(Claude Code / Codex / 等)直连 quilin-mem 会绕过 gate**。

这意味着:
- ✅ 外部 agent 读记忆(`memory_recall` / `list_by_layer`)— 完全安全
- ⚠️ 外部 agent **写记忆 / 删记忆** — 没经过 WriteAuthority 审批,可能造成:
  - 未授权的记忆写入(LLM 误判 importance,写垃圾进去)
  - 未授权的删除(没 72h 撤销窗口走完整流程,但底层 soft-delete + recover 仍生效)
  - 整理时绕过 idle budget 防护

### 5.2 推荐做法

**短期(v2 限制)**:外部 agent **只配读权限**(在 MCP 客户端 config 里 disable 写工具),让 Quilin 自己做写入。

**未来(v3 follow-up)**:开发外部 WriteAuthority stub — 让外部 agent 也能通过简化 gate 写入(prompt 用户确认,或者写入审计日志)。

---

## 6. Env 配置 / Environment Variables

| Env | Default | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 没 key 关掉 LLM observer / dedupe / safety gate(去重退到 exact-only)。检索始终是 FTS5 关键词 + 规则重排,无向量语义,与本 key 无关 |
| `QUILIN_RETRIEVAL_SAFETY_ENABLED` | `false` | 开 QUI-194 安全检索门(低置信拒答 + 多重验证 + 投毒隔离)|
| `QUILIN_DEDUPE_BATCH_ENABLED` | `true` | 开 QUI-189 batch LLM judge(20x 提速 vs per-pair)|
| `QUILIN_DEDUPE_BATCH_MAX_TOKENS` | `10000` | batch 单次 LLM call token 上限 |
| `QUILIN_DEDUPE_BATCH_MAX_RECORDS` | `150` | batch 单次最多 records 数 |
| `QUILIN_STALENESS_THRESHOLD_DAYS` | `30` | QUI-197 过期记忆 staleness marker 阈值 |
| `QUILIN_INTEGRITY_DB` | 临时目录 | QUI-192 完整性评测隔离用 |

---

## 7. 验证安装 / Verify Installation

```bash
# 1. 启动客户端(以 Claude Code 为例)
claude

# 2. 在对话里试:
"用 memory_store 工具存一条:我喜欢用 Vim 写代码"
# 应该看到 LLM 调 memory_store tool,SQLite 落盘

# 3. 验证落盘
sqlite3 ~/.quilin/memory.db "SELECT * FROM memory_records ORDER BY created_at DESC LIMIT 1;"

# 4. 召回测试
"用 memory_recall 工具找:我喜欢什么编辑器"
# 应该召回上面那条
```

---

## 8. 常见问题 / FAQ

### Q1:为啥没语义检索?

A:因为 quilin-mem 的检索本来就是 **FTS5 关键词匹配 + 规则重排**(reranker 按来源 / 新鲜度加权),**没有向量语义检索**。向量语义检索是 roadmap 项,需要 `vector` 扩展(`sentence-transformers` + `chromadb`,默认不装)。`DEEPSEEK_API_KEY` 是给 LLM observer / dedupe / safety gate 用的,**跟检索是否"语义"无关** —— 设了 key 也不会让 `memory_recall` 变成向量检索。

### Q2:外部 agent 写记忆会冲突 Quilin 自己的写吗?

A:会用 QUI-193 supersede chain 保留两版,但 **QUI-196 多客户端 conflict_resolution_pending metadata 只在 Quilin 内部 wire**。外部 agent 不会看到冲突合并 UI(那是 Quilin web 的 follow-up 工作)。

### Q3:能让多个 agent 共享同一个 `~/.quilin/memory.db` 吗?

A:可以。所有 MCP 客户端连到同一 quilin-mem instance(同一 `--project` 路径),共享 SQLite。Quilin 设计就是 4 客户端共享(CLI / REPL / Web / Mac App),外部 agent 算第 5+ 客户端。**但写入会被 last_writer_client metadata 标 generic**(没经过 Quilin 客户端 wrapping)。

### Q4:如何关安全检索门?

A:`export QUILIN_RETRIEVAL_SAFETY_ENABLED=false` 重启 MCP server。默认就是 false。

### Q5:数据库在哪?备份?

A:`~/.quilin/memory.db`(SQLite)。备份直接 `cp` 即可。**重要**:Quilin 还会写 `~/.quilin/user.md` + `~/.quilin/soul.md`(灵魂导入 ship 的 profile 文件),备份时一起。

---

## 9. Quilin 独有 vs 14 个竞品

接入 Quilin 之后,你的 agent 自动获得 14 竞品都没的 3 项能力:

1. **WriteAuthority 全局门禁**:14 类敏感操作经统一审批门(但需要 Quilin agent-core wire,外部直连不享受)
2. **4 客户端共享记忆**:多 agent 共享 `~/.quilin/`(外部 agent 可作第 5+ 客户端)
3. **灵魂导入**:Quilin 安装时扫 6 框架自动生成 profile(外部 agent 不直接调,但通过同一 user.md 共享 Quilin 已导入的)

---

## 10. Follow-up / 后续路线图

| 项 | 状态 |
|---|---|
| 外部 agent 接入 MCP 文档 | ✅ 本文(待补 install 截图/演示)|
| 外部 WriteAuthority stub | 📋 v3 计划 |
| Web 灵魂导入向导 UI | 📋 v3 计划 |
| Web 冲突合并 UI | 📋 v3 计划 |
| 跨 agent 写入审计日志 | 📋 v3 计划 |

---

**文档维护者**:Claude(主 agent)+ Codex(verifier)
**最后更新**:2026-05-21,完美记忆系统 v2 ship 当晚
