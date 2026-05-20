# QUI-197 重要性多维 + 类型标签 + 过期感知 / Multi-dim Importance + Kind + Staleness

> **Status**: 📋 Planned(等 QUI-195 schema ship 后启动)
> **Plane**: QUI-197
> **Estimate**: 原估 2 联合日,实测预测 0.5-1 小时
> **Dependencies**: QUI-193 ship + QUI-195 ship

## 背景

调研显示:单一 `importance_score` scalar 把"新颖性 / 实用性 / 个人相关度 / 可操作性 / 时效性 / 稳定性"6 维信息压成一个数,**用户当前意图无法对单维加权**。Claude Code 风格的 staleness 提示("47 天前的记忆")也缺。

## Scope

### 1. Schema additions(additive)

`memory_records` 加 2 个字段(全 optional,backwards-compatible):
- `salience_json` TEXT NULL — JSON,6 维 importance vector
  ```json
  {"novelty": 0.7, "utility": 0.9, "personal_relevance": 0.8,
   "actionability": 0.5, "temporal_relevance": 0.6, "stability": 0.4}
  ```
- `kind` TEXT NULL — 类型标签(`preference` / `feedback` / `project_note` / `reference` /
  `pattern` / `bug` / `workflow` / `prospective` / `resource`)

保留旧 `importance_score` scalar field 兼容性(取 6 维平均做 fallback)。

### 2. Retrieval weighting by intent

`MemoryRetriever.recall(query, task_context)`:
- 从 `task_context["intent_kind"]` 拿当前用户意图类型(`coding_task` / `research` /
  `casual_chat` 等)
- 按 intent → salience dim 映射加权(`coding_task` → utility + actionability 加权)
- 默认配置在 `salience_intent_weights.json`

### 3. Staleness wrapping

retriever 返回结果时,如果 `created_at` 距离 now > `staleness_threshold_days`(默认 30):
- metadata 加 `staleness_marker: "47 天前 / 47 days ago"`
- LLM prompt 注入 system-reminder "下面记忆 47 天前写入,可能不准"
- 通过 env `QUILIN_STALENESS_THRESHOLD_DAYS` 调

## 实现路径

### 必改文件

- `providers/memory/src/quilin_mem/store_schema.py` additive migration(2 字段)
- `providers/memory/src/quilin_mem/store_records.py` insert 接 salience_json + kind
- `providers/memory/src/quilin_mem/types.py` `MemoryItem` dataclass 加 optional 属性
- `providers/memory/src/quilin_mem/retriever.py` 加 multi-dim weighting + staleness wrapping
- 新 `providers/memory/src/quilin_mem/salience.py`(6 维 importance + intent mapping)
- 新 `providers/memory/tests/test_salience.py`

### 不动

- TS 客户端 0 修改(MemoryItem.to_wire_dict() 保 backward compat)
- WriteAuthority gate 不变

## 测试要求

6+ pytest case:
- migration backfill:旧 records `importance_score` → salience_json 6 维平均 fallback
- intent weighting:`coding_task` 让 utility/actionability 加权
- staleness:30 天前 record 加 marker
- kind 分类:WriteAuthority 区分不同 kind 的 risk level(`pattern` 高,`casual` 低)
- 不传 salience_json 时 fallback 到 importance_score
- coverage ≥ 95%

## 验收

1. 6 维 salience 可独立加权
2. 9 种 kind 全覆盖
3. staleness marker 自动加(env 可调)
4. cross-review 2 fresh × 0 REAL × 2
5. 现有 ~580+ pytest 不回归

## 关联

- 调研 §5.6 重要性多维 + 类型 + 过期
- Plane QUI-197
- 依赖:QUI-193 schema + QUI-195 schema
