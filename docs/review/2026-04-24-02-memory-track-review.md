# Memory-track Review (Iter M, M0.1–M0.10) — 2026-04-24

> Reviewer: Claude (Opus 4.7), independent.
> Scope: 11 commits on `providers/memory/**` plus ADR / planning evidence,
> from `cc125ca` through `dce589a`.
> Method: 先用 git show / pytest / 1000-row reproduce 跑实证，再 cross-check
> ADR-005 / ADR-004 / 03-memory spec / planning §11.3。

## 总评

- 风险评分：**低（LOW）**。
- Blocking 数量：**0**。
- 可进入第三轮切片：**YES**（保留 §"Findings" §3 一条 MEDIUM 建议，不阻塞）。
- 整体结论：第二轮 M0.6 / M0.8 / M0.10 + S4 blocked gate 的实证链是可复现的。
  M-track 第二轮没有出现契约违反、tier 语义污染或把 blocked 误判为 pass/fail
  的情况。Performance claims 在我本机的 1000-row 复现里全部 << 100ms 门槛。

## Contract cross-check 表

| 契约项 | 来源 | 实现位置 | 验证证据 | 结论 |
|---|---|---|---|---|
| `MemoryItem` 字段集 (id/content/content_type/layer/metadata/embedding/created_at/last_accessed/access_count/importance_score) | ADR-005 §3.1 | `providers/memory/src/omnimem/types.py:56-103` | dataclass `slots=True, frozen=True`；显式 `__init__` 覆盖 10 个字段；`tier` 仍以别名 `MemoryRecord = MemoryItem` 兼容 | ✅ |
| `layer` 枚举固定为 working/episodic/semantic/skill | ADR-005 §3.1 | `types.py:9-18`；`store.py:575-577` (CHECK 约束) | `validate_memory_layer` + SQLite CHECK 双重校验；测试 `test_store_rejects_invalid_tier` 覆盖 | ✅ |
| `metadata.schema_version: int`（必填）+ source/score/staleness 可选 | ADR-005 §3.1 | `types.py:21-25,36-43`；`retriever.py:198-203` | `_normalize_metadata` 强制 int；fused recall 始终回填 source/score/staleness/layer | ✅ |
| JSON 往返 (Python ↔ TS fixture) | ADR-005 §3.1 落点 | `types.py:112-159` + `tests/test_smoke.py::test_memory_item_fixture_roundtrip` | fixture 4 条记录 layer 全覆盖；`from_dict` 接受 `layer` 或 legacy `tier`；`to_wire_dict(include_legacy_tier=True)` 同时输出两者 | ✅ |
| `MemoryStore` Protocol：add/search/get/update/delete/list_by_layer/count/clear_layer | ADR-005 §3.1 | `store.py:40-74` | 8 方法全 async；`@runtime_checkable`；`test_omnimem_store_implements_memory_store_protocol` 通过 | ✅ |
| L1 working：keep-recent-k + FIFO + episodic 候选 | 03-memory §A.6 / planning M0.3 | `working.py:29-65` | `WorkingMemory(k)` deque；越界时 `_build_episodic_candidate` 写 `origin_layer` + `source=working_memory_eviction`；测试覆盖 FIFO/eviction | ✅ |
| L2 episodic：原文不压缩 + session/user/time 过滤 | planning M0.5 | `episodic.py:14-58` | `compress_and_add` 直接 `add`（注释/语义都是 verbatim）；`_build_search_filters` 拼 metadata + created_after/before；测试 verbatim + 时间窗 | ✅ |
| L3c BM25/FTS：1000-row p95 < 100ms | planning M0.6 / 03-memory §A.6 | `retriever.py:91-119` + `store.py:901-953` | 见 §"Performance claim 复核"；测试 `test_bm25_fts_retriever_p95_under_100ms_with_1000_items` 通过 | ✅ |
| 融合召回 v0：working 直拼 + episodic BM25 + RRF + source/score | planning M0.8 | `retriever.py:54-80,142-143,187-216` | working 项 `score=1.0 source=working_direct`；BM25 项 `score=RRF, source=bm25_fts`，元数据保留原 source 为 `memory_source` | ✅ |
| Observer no-op 接口冻结，失败不阻塞 L1/L2 | ADR-005 §3.3 / planning M0.7 | `observer.py:138-157` | `NoOpMemoryObserver.observe()` 永远返回 []；`observe_safely` 吞所有 `Exception` 返 []；测试 `test_observer_failure_does_not_affect_main_path` 覆盖 | ✅ |
| Checkpoint 写入：`run_id/event_seq/phase/task_hash/schema_version`；失败用独立事件不用 `storageRef:null` | ADR-005 §3.3 / planning S2 / O5 | `episodic.py:59-93` | metadata 五字段全冻结；`save_checkpoint` 显式注入；checkpoint_failed 事件本轮在 TS planning 侧落地（C1.6），Memory 侧无歧义 | ✅ |
| MCP server `recall/store` wire 兼容（layer 与 legacy tier） | planning M0.4 | `server.py:36-56,131-150`；`store.py:474-524` | `memory_store(content, tier=..., layer=...)`；`layer` 优先；`recall` 走 `to_wire_dict(include_legacy_tier=True)` | ✅ |
| AMB 四轴硬门槛 + LongMemEval 目标门槛 blocked 写明原因 | planning M0.10 / O3 | `benchmarks/amb_baseline.py:96-119`；`tests/test_memory_baseline.py` | accuracy=1.0 / speed sample/iter / cost 全 0 / usability deterministic；`longmemeval.status="blocked"` + `reason` + `alternative_evidence` | ✅ |
| Tier 语义：working↔episodic 不污染 semantic | ADR-005 §3.2 | 全文件 grep `"semantic"` | semantic 仅在 store CRUD 测试 / 默认 metadata.schema_version 出现，无任何 working/episodic 写入路径会落到 semantic；`WorkingMemory._build_episodic_candidate` 写死 `layer="episodic"` | ✅ |
| Skill tier 不被污染（不写正文） | ADR-005 §3.2 | 全 src grep `layer="skill"` | 仅出现在 fixture 与 SQL CHECK 枚举里，不存在生产代码写入路径；本轮 M-track 完全没碰 skill tier | ✅（后续 M1.7 进入时再 review） |

## 证据抽样

```text
$ git log --oneline cc125ca^..dce589a -- providers/memory/
dce589a test(memory): add M0 baseline evidence harness
a1800c6 docs(memory): close S4 as Arm L blocked pending resources
de3fb31 feat(memory): add fused recall reranker v0
1797737 feat(memory): add BM25 FTS baseline retriever
1a3957d feat(memory): add verbatim episodic store (M0.5)
a5640ac feat(memory): add L1 working memory buffer (M0.3)
66fc714 feat(memory): harden SQLite store contract (M0.2)
bb76f9f docs(memory): record Arm L observer spike blocker (M0.9a)
b515dfa feat(memory): freeze observer no-op contract (M0.7)
33e7466 feat(memory): MCP server recall/store compatibility (M0.4)
cc125ca feat(memory): MemoryItem + MemoryStore Protocol + fixture (M0.1)

$ cd providers/memory && uv run pytest -q
....................................................................... [100%]
71 passed in 0.89s

$ wc -l providers/memory/src/omnimem/{types,store,working,episodic,observer,retriever,server}.py providers/memory/benchmarks/amb_baseline.py
163 types.py
953 store.py            # 单文件超过 800 行（见 Findings #3）
 87 working.py
166 episodic.py
157 observer.py
219 retriever.py
160 server.py
217 amb_baseline.py
```

S4 blocked gate 复核：

```text
$ test -n "$ANTHROPIC_API_KEY"; echo $?
1
$ command -v ollama; echo $?
1
$ curl -sSf http://localhost:11434/api/tags; echo $?
curl: (7) Failed to connect to localhost port 11434 ...
7
$ wc -l docs/research/fixtures/rule-first-observer/dataset.json
14236
```

→ 与 `bb76f9f` / `a1800c6` 报告里记录的 exit `1/1/7` 完全一致；1039 样本 dataset
仍可读。S4 记录为 **blocked**，不是 pass/fail，符合 ADR-004 §"d2 条件性采纳"
分支：必须先解资源 blocker 再决定 d2 vs d3。无误判。

## Performance claim 复核

| 声明 (planning §11.3 row 71) | 来源文件 | 实测复核命令 | 结果 (本机 reproduce) |
|---|---|---|---|
| 1000-row BM25 p95 `0.349ms` | `tests/test_retriever.py::test_bm25_fts_retriever_p95_under_100ms_with_1000_items` (lines 74-97) | `cd providers/memory && uv run pytest tests/test_retriever.py -q` (P) + ad-hoc 30-iter loop | pytest pass；ad-hoc `BM25 1000-row p95=0.151ms max=0.157ms`（同量级，远低于 100ms 门槛；commit message 里的 0.349ms 是 commit `1797737` 当时一次跑的结果） |
| fused recall p95 `0.174ms` | `tests/test_retriever.py::test_fused_retrieval_*` + commit `de3fb31` 的 message | ad-hoc 30-iter `MemoryRetriever(store, working).retrieve(...)` | `fused recall 1000-row p95=0.142ms max=0.160ms`（同量级，验真） |
| AMB harness p95 `5.795ms` | `benchmarks/amb_baseline.py:172-192`；test `test_memory_baseline.py` | `cd providers/memory && uv run python benchmarks/amb_baseline.py --sample-size 1000 --iterations 30` | 输出 `speed.p95_ms=5.829, max_ms=5.955`，accuracy top3 = 1.0（5/5 命中），cost 全 0；与声明同量级 |

→ 三条声明都不是凭空写出来的，跑得动、测得到，都满足"硬门槛 < 100ms / 离线
零网络"的 M0.10 验收标准。我没有发现 unverifiable 的性能声明。

## Findings

| # | Severity | 说明 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | LOW | `recall_with_fts` 用 `OR` 拼所有 query terms（含中文 expansion 集合 `{记得, 记忆, 名字, ...}`），中文场景召回宽容度可能偏高，未来加 IDF 时要注意噪音。 | `store.py:115-125,102-108` | M1.3 引入 reranker 时一并收紧；本轮不阻塞。 |
| 2 | LOW | `MemoryRetriever.retrieve` 当 `working_items >= effective_limit` 时直接 short-circuit，不做 BM25 一次 warm-up；这是正确取舍但会让性能数字"看起来比真实场景好"。 | `retriever.py:64-69` | 后续做 M1.3 混合检索基线时，benchmark 里加一组"working 不命中"的 query 防止性能误读。 |
| 3 | MEDIUM (非 blocking) | `providers/memory/src/omnimem/store.py = 953 lines`，超过 common/coding-style.md 的 800 行上限 (`< 800`)，且本轮新增了 ~700 行 schema 迁移逻辑（M0.2 加固）。 | `wc -l store.py` = 953 | 进入 M1 前考虑拆出 `store_schema.py`（schema_version 迁移 + `_ensure_*`）和 `store_search.py`（FTS / LIKE fallback / `_candidate_rows`），把核心 CRUD 留在 `store.py`。不阻塞第三轮，但 M1.2 KG schema 加进来前应该先拆。 |
| 4 | LOW | Episodic `EpisodicMemory.search` 透传给 store 的 `filters` 里 `metadata` 字段是部分匹配（`_matches_filters` 里子集判断），但 schema 里并没有显式说明"metadata 过滤是子集语义"。 | `store.py:885-889`；`episodic.py:138-158` | 在 03-memory §A.5 / ADR-005 注一句 metadata filter = subset match，避免下游 (Planning C1.6 checkpoint load) 误用。 |
| 5 | LOW (positive) | `_with_retrieval_metadata` 在覆盖 `source` 时把原 source 备份到 `memory_source`；同时 `staleness="fresh"` 默认填回 — S1 元数据契约执行得比 ADR-005 §3.3 仅"可以带 staleness"严格。 | `retriever.py:194-203` | 无需动作；建议把这层语义补进 ADR-005 验收标准里。 |

## Unblock 建议（第三轮切片启动前）

1. **不需要 blocking change**。可以直接进入 §15 第三轮切片（M1.2/M1.3/M1.7 等）。
2. 入第三轮第一件事建议先做 Finding #3 的拆分（store.py 800+ → 三文件），
   防止 M1.2 KG schema 把单文件推到 1200+ 行。预计 < 2h，纯 refactor + 现有
   71 个测试全跑过即可。
3. ADR-005 §3.3 的"recall 可带 staleness"已经被实现成"始终带 staleness"，
   建议把这条收口写进 ADR-005，让后续 retriever 不会回退到 "可选填" 语义。
4. S4 / M0.9b 维持 blocked/deferred；第三轮**不要**把 ML-first observer
   的实现放进 in-scope。Arm L 资源到位后再开 spike，不要先写代码。
5. M-track 第二轮的所有 commit message 都附了 LOC + pytest exit + 性能复现
   命令，符合"状态声明实证纪律"。建议第三轮继续保持，特别是 M1.3 引入
   reranker / 向量占位时，benchmark 数字附 commit message + 测试两处。

## 引用与方法

- 直接 `Read` 了 7 个 src 文件 + 4 个测试 + AMB harness 全文。
- `git show --stat` 抽样 5 个核心 commit (`cc125ca / 33e7466 / 1a3957d /
  1797737 / de3fb31`)。
- `uv run pytest -q` 全跑：71 passed。
- 三条性能声明各跑一次本机复现脚本。
- ADR-005 §3.1/§3.2/§3.3、ADR-004 §2.3/§3、planning §11.3 / §6.1 全文核对。
- 没有读 TS 侧 `packages/agent-core/src/memory/*`（Planning-track review 范围）。
