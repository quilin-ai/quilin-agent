# ADR-007: Identity Files — user.md 与 soul.md 契约

> **状态**: Draft (M1.7 precondition)
> **日期**: 2026-04-24
> **决策者**: Quilin Agent 团队
> **前置**: [ADR-005](./adr-005-memory-contracts.md)（Memory Contracts）

---

## 1. 状态

本文冻结 Quilin identity files 的最小契约，作为 M1.7 UserProfile Store、M1.8 `user.md` 镜像、M2.6/M2.7 `soul.md` 只读加载的前置 draft。

本文是 draft：M1.7/M1.8/M2.6/M2.7 可据此实现；Iter F 自进化写路径启动前，需要把本文升级为 Accepted 或另起修订 ADR。

---

## 2. Context

Quilin 需要两类长期身份材料：

1. **User identity**：关于用户的稳定偏好、工作习惯、约束和非敏感画像，供 Memory 与 Context 使用。
2. **Agent identity**：关于 Quilin 自身的稳定人格、沟通风格和价值约束，供 ContextAssembler 只读加载，并为 Iter F 自进化留下受控写路径。

风险来自四个方向：

- **敏感信息泄露**：用户真实姓名、联系方式、位置、生日、tokens/secrets 等不应默认写入 Markdown 文件。
- **写入口漂移**：多个模块若直接改 identity 文件，会绕过审计和 WriteAuthority。
- **git 边界不清**：身份文件既可能是个人本地状态，也可能被项目明确共享；默认策略必须安全。
- **跨项目共享失控**：用户画像可能跨项目复用，但项目私有偏好不应自动传播到全局画像。

---

## 3. Decision

### 3.1 文件位置

冻结两个项目级 identity 文件路径：

| 文件 | Owner | 本期行为 |
|---|---|---|
| `.quilin/user.md` | 03-memory / UserProfile Store | M1.8 支持 export/sync；默认不提交 git |
| `.quilin/soul.md` | 10-self-evolution | M2.6/M2.7 只读加载；本期不实现自进化写路径 |

全局用户画像可在后续实现中使用用户级存储，但不得替代项目级 `.quilin/user.md`。项目级文件用于覆盖或补充当前 repo 的上下文，不自动写回全局画像。

### 3.2 `.quilin/user.md` 格式

`user.md` 使用 YAML frontmatter + Markdown body。

Frontmatter schema version 固定从 `1` 开始，字段为：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema_version` | 是 | 当前为 `1` |
| `profile_id` | 是 | 稳定 profile id，不包含敏感明文 |
| `updated_at` | 是 | ISO timestamp |
| `updated_by` | 是 | `profile_updater` / `user_edit` / `import` 等 |
| `scope` | 是 | `project` 或 `global_projection` |
| `sensitive_export` | 是 | 默认 `false` |

Markdown body 只允许导出非敏感、可读偏好，例如：

- 沟通偏好
- 工作流偏好
- 技术栈偏好
- 用户明确允许长期保存的项目约束

默认不得导出以下敏感字段：真实姓名、联系方式、精确位置、tokens/secrets、生日、证件号、付款信息、健康信息。若用户显式传入 `--include-sensitive`，只允许单次导出白名单字段，并必须在审计记录中标记 `sensitive_export=true`。

### 3.3 `.quilin/soul.md` 格式

`soul.md` 使用 YAML frontmatter + Markdown body。

Frontmatter schema version 固定从 `1` 开始，字段为：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema_version` | 是 | 当前为 `1` |
| `persona_name` | 是 | Agent persona 名称 |
| `core_values` | 是 | 字符串数组 |
| `communication_style` | 是 | 稳定沟通风格摘要 |
| `created_at` | 是 | ISO timestamp |
| `last_updated_by` | 是 | `human` / `migration` / future WriteAuthority actor |

Markdown body 为自由文本，用于描述人格边界、长期原则和产品语气。本期只读加载，不实现自动写入。

### 3.4 写入权与审批

`user.md` 写路径：

- 唯一写入口是 M1.7 `ProfileUpdater`。
- `sync_from_markdown(path)` 不得直接覆写 SQLite profile；必须转成 `ProfileSignal` 后走 `ProfileUpdater.apply_signal()`。
- 所有写入必须记录审计字段：`who / when / why / diff / source`。

`soul.md` 写路径：

- 本期 M2.6/M2.7 只读。
- Iter F 若实现自进化写路径，必须经过 WriteAuthority。
- Agent-initiated soul 变更只能 propose patch，不能自动 apply。
- human edit 可以直接修改文件，但加载器必须 validate schema，失败时安全回退。

审批边界：

| 操作 | 默认审批 |
|---|---|
| 读 `.quilin/user.md` / `.quilin/soul.md` | 允许 |
| 导出非敏感 `user.md` | 需要 WriteAuthority 普通写入审批 |
| 导出敏感字段到 `user.md` | 必须显式用户确认，单次有效 |
| 修改 `soul.md` | 本期禁止 agent apply；Iter F 必须 human-in-loop |

### 3.5 git 入/出策略

默认策略：

- `.quilin/user.md` 默认不提交 git。
- `.quilin/soul.md` 默认不提交 git，除非项目明确希望共享 agent persona。
- `.quilin/*.local.md` 永远不提交 git。

项目若要共享 identity 文件，必须显式修改 `.gitignore` 并在 PR 中说明原因。共享前必须确认不含敏感字段。

推荐 `.gitignore` 规则由 M1.8/M2.7 落地时添加：

```gitignore
.quilin/user.md
.quilin/soul.md
.quilin/*.local.md
```

如果项目需要提交模板，应使用无敏感内容的示例文件，例如：

- `.quilin/user.example.md`
- `.quilin/soul.example.md`

### 3.6 跨项目共享策略

全局 profile 与项目 profile 分层：

| 层级 | 用途 | 写入 |
|---|---|---|
| Global UserProfile | 用户跨项目稳定偏好 | 只通过 ProfileUpdater 写 |
| Project `.quilin/user.md` | 当前项目覆盖与补充 | export/sync 均走 ProfileSignal |
| Project `.quilin/soul.md` | 当前项目 agent persona | 本期只读 |

跨项目传播规则：

- 项目级偏好不得自动提升为 global。
- global profile 可投影到项目，但敏感字段默认不投影。
- 项目 `user.md` 回流 global 前必须生成候选 `ProfileSignal`，由 ProfileUpdater 审计合并。

---

## 4. Consequences

### 正向后果

- M1.7/M1.8 可在清晰的安全边界内实现 UserProfile Store 与 Markdown 镜像。
- M2.6/M2.7 可实现 `soul.md` schema 与只读加载，不阻塞 Iter F 写路径设计。
- 默认 git 策略保护个人身份文件，项目共享需要显式选择。

### 约束

- Identity 文件不是自由写 scratch；所有 agent 写入都必须走 owner 模块与 WriteAuthority。
- `user.md` 不是完整数据库 dump；敏感字段默认保留在 SQLite 或后续安全存储中。
- `soul.md` 本期只读；任何自动演化写入必须留到 Iter F。

### 后续工作

- M1.7：实现 `UserProfile`、`ProfileSignal`、`ProfileUpdater` 与审计记录。
- M1.8：实现 `user.md` export/sync，默认不导出敏感字段。
- M2.6：实现 `soul.md` frontmatter schema validator。
- M2.7：实现 `soul.md` 只读加载并接入 ContextAssembler。

---

## 5. References

- [Iter C × Iter M 并行任务拆分](../planning/2026-04-23-01-iter-c-m-parallel-breakdown.md) — O8/O9、M1.7/M1.8、M2.6/M2.7
- [ADR-005 Memory Contracts](./adr-005-memory-contracts.md)
- [03-memory](../engineering/03-memory/README.md) — User Profile Store
- [10-self-evolution](../engineering/10-self-evolution/README.md) — soul.md 写路径归属与 Iter F 自进化边界
