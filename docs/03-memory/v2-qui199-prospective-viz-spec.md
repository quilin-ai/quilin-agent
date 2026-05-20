# QUI-199 前瞻记忆 + 证据可视化 + 资源指针 / Prospective + Evidence Viz + Resource Pointers

> **Status**: 📋 Planned(第四周,跨 Python 后端 + Web 前端)
> **Plane**: QUI-199
> **Estimate**: 原估 2-3 联合日,实测预测 1-1.5 小时
> **Dependencies**: QUI-193 + QUI-195 + QUI-197(kind=prospective)

## 背景

调研三块合并:
1. **前瞻记忆**:用户承诺 / 待办 / 提醒 / 有时间边界的意图("下周二见客户")— 主动提醒
2. **证据可视化**:Web 端 reactflow 节点图显示记忆 → 原始观察证据 → 版本链
3. **资源指针**:截图 / PDF / 多模态资源占位字段(实际索引推后)

反向灵魂导出已**明确不做**(user 决定)。

## Scope

### 1. Prospective Memory(前瞻)

复用 QUI-197 的 `kind="prospective"` 标签。新加字段:
- `deadline_at` DATETIME NULL — 触发提醒时间
- `prospective_action` TEXT NULL — 触发时建议的 action 摘要

启动时(or daemon 定期)扫所有 `kind="prospective" AND deadline_at <= now()` 的 records,
触发提醒(通过现有 `narrate_aside` interaction primitive,Iter F web 已 ship)。

### 2. Evidence Visualization(Web 端)

`apps/web/app/memory/page.tsx` 加新 tab "Evidence Graph":
- reactflow 显示节点 = memory record / 边 = supersede / source / evidence
- 点开一条 memory 可看:
  - 出处对话片段(原始 observation)
  - 覆盖的旧版本(supersede chain)
  - 责任人(`actor` / `last_writer_client`)
  - 当前置信度 + 6 维 salience(QUI-197)

后端 `/api/memory/evidence-graph?id=X` 返 JSON:
```json
{
  "nodes": [{"id": "...", "kind": "memory|observation|source"}],
  "edges": [{"from": "...", "to": "...", "kind": "supersedes|evidence_of|source_of"}]
}
```

复用 QUI-193 `memory_sources` + `memory_observations` 侧表。

### 3. Resource Pointer Preparation

`memory_records` 加 `resource_pointer_json` TEXT NULL — JSON 占位:
```json
{
  "kind": "screenshot|pdf|image|video",
  "uri": "file:///path/to/asset.png",
  "checksum": "sha256:...",
  "indexed": false
}
```

**当前 v1 不做真实索引**(等用户需求出现),只预留 schema 给未来。

## 实现路径

### Python 后端(必改)

- `providers/memory/src/quilin_mem/store_schema.py` additive migration(2 字段:
  `deadline_at` + `resource_pointer_json`)
- `providers/memory/src/quilin_mem/store.py` 加 `list_due_prospective(now)` API
- 新 `providers/memory/src/quilin_mem/prospective.py`(扫描 + 触发提醒)
- `providers/memory/src/quilin_mem/server.py` 新 MCP tool `memory_evidence_graph`
- 新 tests

### Web 前端(可选,follow-up)

- `apps/web/app/api/memory/evidence-graph/route.ts` 新 API endpoint
- `apps/web/app/memory/components/EvidenceGraphTab.tsx`(reactflow)
- 复用 KG tab pattern(`apps/web/app/memory/components/KgTab.tsx` 已 ship Iter F)

### 不动

- TS 客户端 local-client.ts 0 修改(只读 graph API)
- 现有 KG tab 0 修改

## 测试要求

后端 10+ pytest case:
- prospective 触发:deadline_at < now 进入 due list
- prospective 不重复触发(once-only flag)
- evidence_graph 返完整 JSON
- supersede chain 在 graph 内可见
- resource_pointer_json 序列化 round-trip
- migration backfill

前端 3+ Playwright e2e(等 Python ship 后):
- Evidence Graph tab 显示节点
- 点 supersede 边显示历史链
- 空 record 显示空 placeholder

## 验收

1. prospective 提醒在 daemon 跑时自动触发
2. Web Evidence Graph 显示完整链路
3. resource_pointer 占位字段 backwards-compatible
4. cross-review 2 fresh × 0 REAL × 2
5. 反向导出 0 痕迹(代码 + docs 全清)

## 关联

- 调研 §5.7 前瞻记忆 + §5.8 证据可视化 + §5.9 资源指针(反向导出已移除)
- Plane QUI-199
- 依赖:QUI-193 + QUI-195 + QUI-197(kind=prospective)
