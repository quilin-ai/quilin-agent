---
title: <feature name>
status: planning  # planning | in-progress | blocked | done
owner: <Claude | Codex | human>
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
threat_surface_delta:
  # 本 phase / 本 plan 新引入的外部可接触面。开工前必填，review 时据此做 threat walk。
  # 留空（`[]`）表示显式宣告"本 phase 不新增此类表面"；缺省字段视为未审计 → CI/review 应拒。
  # 非空 item 采用以下 schema（ingress / egress 用前者，persistence 用后者）：
  #   new_ingress / new_egress:
  #     - source|sink: <字符串，数据来源或去向>
  #       trust: untrusted | semi-trusted | trusted
  #       mitigations: [<拦截/净化手段，如 injection-scanner / strip-on-outbound / signature-verify>]
  #   new_persistence:
  #     - location: <字符串，如 sessions.db / .claude/state.json>
  #       sensitive: [<字段名，如 reasoning.signature / encryptedContent>]
  #       migration: <schemaVersion bump / none / 迁移策略>
  new_ingress: []        # 新增的"外部数据能进来"的入口（provider 字段、用户输入、MCP 返回、cache replay 等）
  new_egress: []         # 新增的"数据能出去"的通道（outbound API payload、日志、checkpoint 上传等）
  new_persistence: []    # 新增的"数据落盘"的位置（sessions.db 新列、新文件、新 schemaVersion 等）
---

# <Feature Name>

## 目标

一段话说清楚这个 feature 解决什么问题 / 为什么做。

## Phases

| # | 名称 | 状态 | Owner | Commit | 备注 |
|---|---|---|---|---|---|
| 0 | 调研 / probe | pending / in-progress / completed / blocked | Codex | `abc1234` | 备注 |
| 1 | 实现 | pending | Codex | — | |

每个 phase 展开：

### Phase 0 — <name>

- **做什么**：...
- **不做什么**：...
- **威胁面 delta**（本 phase 独立填；必须是 frontmatter `threat_surface_delta` 的子集或全量）：
  - 新增 ingress：... 或 `无`
  - 新增 egress：... 或 `无`
  - 新增 persistence：... 或 `无`
  - 缓解措施：... 或 `沿用上 phase 的 X/Y/Z`
- **依赖**：前置 phase / 外部条件
- **验证**：如何确认完成
- **产出**：文件路径 / commit

## Decisions

按时间倒序记录关键决策，特别是**推翻之前假设**的 pivot。

### YYYY-MM-DD — <decision title>

- **Before**：原计划是...
- **After**：现在改为...
- **证据**：链接到 probe / doc / commit

## Open Questions

- [ ] 待决问题 1
- [ ] 待决问题 2

## Blockers

- 当前阻塞点（如凭证缺失、外部依赖未就绪等）

## Next Action

下一步具体要做什么，由谁做。
