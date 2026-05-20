from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Literal, Protocol

from .idle_budget import IdleBudgetProvider, IdleBudgetResult
from .reflector import ReflectionProposal, Reflector, TaskOutcome
from .store import QuilinMemStore
from .types import MemoryItem, MemoryLayer, validate_memory_layer

if TYPE_CHECKING:
    from .consolidation_log import ConsolidationLogStore

ConsolidationActionKind = Literal["dedupe", "reflect", "prune_kg", "recompress_verbatim"]
ConsolidationStrategy = Literal["dedupe", "reflect", "kg-prune", "all"]
JudgeDecision = Literal["duplicate", "supersedes", "distinct"]
CONSOLIDATOR_SCHEMA_VERSION = 1
DEFAULT_CONSOLIDATION_TASK = "quilin_mem.consolidator.propose"
DIRECT_SIMILARITY_THRESHOLD = 0.85
# QUI-187 Reviewer F follow-up (2026-05-20):LLM 灰区阈值 0.4 — 实证 9 条记忆
# 之间 cosine 相似度分布,关键 4 对 entity 演化("老孟→孟哥"0.575 / "小明→
# 小花"0.825 / "我是小明助手→我是麒麟也叫小花"0.471 / "用户名小明→我是麒麟
# 也叫小花"0.499)都 ≥ 0.4 能进 LLM judge。
# 0.0 让 36 pair 都跑 LLM ~36s > MCP tool 30s timeout 死。0.4 减到 ~10 pair
# ~10s 内完成。后续 batch LLM call follow-up issue 解决性能。
LLM_SIMILARITY_THRESHOLD = 0.4
_LOCAL_EMBEDDING_DIM = 128
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def _utcnow() -> datetime:
    return datetime.now(UTC)


_CONSOLIDATION_PRIOR_MAP: dict[tuple[ConsolidationActionKind, str], dict[str, float]] = {
    ("dedupe", "semantic"): {"vector_semantic": +0.05, "direct_recall": +0.03},
    ("reflect", "semantic"): {"kg_subgraph": +0.08, "direct_recall": -0.05},
    ("reflect", "skill"): {"hybrid_rrf": +0.06, "vector_semantic": +0.04},
    ("prune_kg", "episodic"): {"direct_recall": +0.05, "kg_subgraph": -0.06},
    ("recompress_verbatim", "episodic"): {"bm25_fts": +0.06, "working_direct": -0.04},
}


class EmbeddingProvider(Protocol):
    def embed_many(self, texts: Sequence[str]) -> list[list[float]]: ...


@dataclass(frozen=True, slots=True)
class DedupeJudgeResult:
    decision: JudgeDecision
    reason: str


DedupeJudge = Callable[[MemoryItem, MemoryItem, float], DedupeJudgeResult]


@dataclass(slots=True, frozen=True)
class ConsolidationAction:
    kind: ConsolidationActionKind
    target_layer: Literal["episodic", "semantic", "skill"]
    reason: str
    dry_run: bool = True
    writes_semantic: bool = False
    writes_skill: bool = False
    metadata: dict[str, object] = field(default_factory=dict)

    def to_wire_dict(self) -> dict[str, object]:
        if self.kind == "dedupe":
            return {
                "kind": "dedupe",
                "tier": self.target_layer,
                "keepId": self.metadata.get("keep_id"),
                "deleteIds": list(_string_tuple(self.metadata.get("delete_ids"))),
                "reason": self.reason,
                "strategy": self.metadata.get("strategy"),
                "score": self.metadata.get("score"),
                "memoryIds": list(_string_tuple(self.metadata.get("memory_ids"))),
            }
        if self.kind == "prune_kg":
            return {
                "kind": "kg-prune",
                "tier": self.target_layer,
                "deleteIds": [],
                "reason": self.reason,
                "memoryIds": [],
            }
        return {
            "kind": "reflect-insight",
            "tier": self.target_layer,
            "deleteIds": [],
            "reason": self.reason,
            "memoryIds": [],
        }


@dataclass(slots=True, frozen=True)
class ConsolidationProposal:
    task: str
    dry_run: bool
    budget: IdleBudgetResult
    actions: list[ConsolidationAction]
    writes_performed: int
    created_at: datetime
    strategy: ConsolidationStrategy = "all"
    reflections: tuple[ReflectionProposal, ...] = ()
    schema_version: int = CONSOLIDATOR_SCHEMA_VERSION

    def to_wire_dict(self) -> dict[str, object]:
        proposals = [action.to_wire_dict() for action in self.actions]
        proposals.extend(
            {
                "kind": "reflect-insight",
                "tier": "semantic",
                "deleteIds": [],
                "insertContent": reflection.proposedContent,
                "reason": reflection.reason,
                "score": reflection.confidence,
                "memoryIds": list(reflection.sourceIds),
            }
            for reflection in self.reflections
        )
        total_delete = sum(
            len(item.get("deleteIds", []))
            for item in proposals
            if isinstance(item.get("deleteIds"), list)
        )
        return {
            "task": self.task,
            "dryRun": self.dry_run,
            "strategy": self.strategy,
            "budget": {
                "decision": self.budget.decision,
                "granted": self.budget.granted,
                "reason": getattr(self.budget, "reason", None),
            },
            "proposals": proposals,
            "totalDelete": total_delete,
            "totalKeep": sum(1 for item in proposals if item.get("keepId") is not None),
            "totalInsert": len(self.reflections),
            "writesPerformed": self.writes_performed,
            "createdAt": self.created_at.isoformat(),
            "schemaVersion": self.schema_version,
        }


@dataclass(frozen=True, slots=True)
class DedupeGroup:
    tier: MemoryLayer
    keep_id: str
    delete_ids: tuple[str, ...]
    reason: str
    strategy: Literal["exact", "embedding", "llm"]
    score: float
    memory_ids: tuple[str, ...]

    def to_wire_dict(self) -> dict[str, object]:
        return {
            "tier": self.tier,
            "keepId": self.keep_id,
            "deleteIds": list(self.delete_ids),
            "reason": self.reason,
            "strategy": self.strategy,
            "score": self.score,
            "memoryIds": list(self.memory_ids),
        }


@dataclass(frozen=True, slots=True)
class DedupePlan:
    groups: tuple[DedupeGroup, ...]
    total_delete: int
    total_keep: int

    def to_wire_dict(self) -> dict[str, object]:
        return {
            "groups": [group.to_wire_dict() for group in self.groups],
            "totalDelete": self.total_delete,
            "totalKeep": self.total_keep,
        }


@dataclass(frozen=True, slots=True)
class _PairEvidence:
    left_id: str
    right_id: str
    score: float
    strategy: Literal["exact", "embedding", "llm"]
    reason: str


class _LocalEmbeddingProvider:
    def embed_many(self, texts: Sequence[str]) -> list[list[float]]:
        return [_hash_embedding(text) for text in texts]


# QUI-187 Reviewer F follow-up (2026-05-20): user-facing bug — 9 条明显语义重复
# (老孟/孟哥/小明/小花)显示 0 条整理。根因双重:
#   1. server.py 默认 IdleBudgetProvider(enabled=False) → 永远 denied(已修)
#   2. Codex 迁 dedupe.py 时**漏迁** DeepseekDedupeJudge → LLM judge 路径永远不跑,
#      只 hash embedding(低质,无法识别 entity 演化)
# 这里补回 LLM judge — DeepSeek v4 flash 便宜模型,prompt 严格要求 JSON 输出
# {"decision": "duplicate|supersedes|distinct", "reason": "..."}
class _DeepseekConsolidationJudge:
    """LLM-based dedupe judge for gray-zone pairs (0.5 ≤ similarity < 0.85).

    用便宜的 deepseek-v4-flash 判定两条记忆是否语义重复 / 一条 supersede 另一条 /
    完全独立。返回结构化 JSON 由 Consolidator._build_layer_groups 消费。

    API key 从环境变量按优先级取(QUILIN_DEDUPE_API_KEY → QUILIN_OBSERVER_API_KEY
    → DEEPSEEK_API_KEY),无 key 时 fallback 返 distinct(保守不合并)。
    """

    DEFAULT_MODEL = "deepseek-v4-flash"
    DEFAULT_BASE_URL = "https://api.deepseek.com/v1/chat/completions"

    def __init__(
        self,
        *,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self._model = model or os.environ.get("QUILIN_DEDUPE_MODEL", self.DEFAULT_MODEL)
        self._base_url = base_url or os.environ.get(
            "QUILIN_DEDUPE_BASE_URL", self.DEFAULT_BASE_URL
        )
        self._api_key = api_key or (
            os.environ.get("QUILIN_DEDUPE_API_KEY")
            or os.environ.get("QUILIN_OBSERVER_API_KEY")
            or os.environ.get("DEEPSEEK_API_KEY")
        )

    def judge(self, left: MemoryItem, right: MemoryItem, similarity: float) -> DedupeJudgeResult:
        if not self._api_key:
            return DedupeJudgeResult(decision="distinct", reason="no LLM api key configured")
        try:
            from .observer import _call_deepseek_api as _llm_call

            prompt = self._build_prompt(left, right, similarity)
            payload = json.dumps(
                {
                    "model": self._model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 200,
                    "response_format": {"type": "json_object"},
                }
            ).encode("utf-8")
            # observer._call_deepseek_api 已经提取 choices[0].message.content 返字符串,
            # 不是 raw response。直接 json.loads(raw)。
            raw = _llm_call(self._base_url, self._api_key, payload)
            parsed = json.loads(raw)
            decision = parsed.get("decision", "distinct")
            if decision not in ("duplicate", "supersedes", "distinct"):
                decision = "distinct"
            reason = parsed.get("reason", "")
            return DedupeJudgeResult(decision=decision, reason=str(reason)[:200])
        except Exception as exc:  # noqa: BLE001 — 保守 fallback,不让 LLM 错误中断 dedupe
            return DedupeJudgeResult(
                decision="distinct", reason=f"llm judge fallback: {type(exc).__name__}"
            )

    def _build_prompt(self, left: MemoryItem, right: MemoryItem, similarity: float) -> str:
        return (
            "你是 Quilin Agent 的记忆整理助手。判定两条记忆是否语义重复,"
            "或者一条是否 supersede(更新覆盖)另一条。\n\n"
            f"相似度(embedding cosine): {similarity:.3f}\n\n"
            f"[左] id={left.id} tier={left.layer} created={left.created_at}\n"
            f"内容: {left.content}\n\n"
            f"[右] id={right.id} tier={right.layer} created={right.created_at}\n"
            f"内容: {right.content}\n\n"
            "判定:\n"
            '  - "duplicate": 两条语义重复(同一事实/同一偏好/同一身份),可以合并\n'
            '  - "supersedes": 一条是另一条的更新版本(如"老孟"被"孟哥"取代,'
            '"小明"被"小花"取代),应保留更新版\n'
            '  - "distinct": 语义独立,不该合并\n\n'
            '只输出 JSON: {"decision": "duplicate|supersedes|distinct", '
            '"reason": "中文一句话说明判定依据"}'
        )


@dataclass(slots=True, frozen=True)
class RecallWeightsUpdate:
    source_prior_key: str
    prior_delta: float
    reason: str


class Consolidator:
    def __init__(
        self,
        budget_provider: IdleBudgetProvider | None = None,
        *,
        store: QuilinMemStore | None = None,
        embedding_provider: EmbeddingProvider | None = None,
        dedupe_judge: DedupeJudge | None = None,
        reflector: Reflector | None = None,
        reranker: object | None = None,
        log_store: ConsolidationLogStore | None = None,
    ) -> None:
        self._budget_provider = budget_provider or IdleBudgetProvider()
        self._store = store
        self._embedding_provider = embedding_provider or _LocalEmbeddingProvider()
        self._dedupe_judge = dedupe_judge
        self._reflector = reflector or Reflector()
        self._reranker = reranker
        self._log_store = log_store
        self._last_consolidation: datetime | None = None
        self._consolidation_count = 0

    def propose(
        self,
        *,
        task: str = DEFAULT_CONSOLIDATION_TASK,
        estimated_tokens: int = 0,
        strategy: ConsolidationStrategy = "all",
        tier: MemoryLayer | None = None,
        task_outcome: TaskOutcome = "unknown",
        now: datetime | None = None,
    ) -> ConsolidationProposal:
        budget = self._budget_provider.acquire(task, estimated_tokens)
        actions: list[ConsolidationAction] = []
        reflections: tuple[ReflectionProposal, ...] = ()
        if strategy in {"dedupe", "all"}:
            actions.extend(self._dedupe_actions(tier=tier, budget=budget))
        if strategy in {"reflect", "all"}:
            reflections = self._reflection_proposals(
                budget=budget,
                task_outcome=task_outcome,
                now=now,
            )
        actions.extend(self._proposal_actions(budget, strategy=strategy))
        proposal = ConsolidationProposal(
            task=task,
            dry_run=True,
            budget=budget,
            actions=actions,
            writes_performed=0,
            created_at=now or _utcnow(),
            strategy=strategy,
            reflections=reflections,
        )
        # Persist to the optional log store (UX-4 Slice 4 unblocker).
        # Failures here MUST NOT break the in-memory flow — log_store
        # is purely observational. Swallow + ignore to honor the
        # "Consolidator never fails just because the log is broken"
        # contract.
        if self._log_store is not None:
            with contextlib.suppress(Exception):
                self._log_store.append(proposal)
        return proposal

    def _proposal_actions(
        self,
        budget: IdleBudgetResult,
        *,
        strategy: ConsolidationStrategy,
    ) -> list[ConsolidationAction]:
        blocked = budget.decision == "denied"
        metadata: dict[str, object] = {
            "schema_version": CONSOLIDATOR_SCHEMA_VERSION,
            "budget_decision": budget.decision,
        }
        if blocked:
            metadata["blocked_reason"] = budget.reason

        actions: list[ConsolidationAction] = []
        if strategy in {"reflect", "all"}:
            actions.append(
                ConsolidationAction(
                    kind="reflect",
                    target_layer="semantic",
                    reason="propose stable episodic reflections for future WriteAuthority review",
                    metadata=dict(metadata),
                )
            )
        if strategy in {"kg-prune", "all"}:
            actions.append(
                ConsolidationAction(
                    kind="prune_kg",
                    target_layer="episodic",
                    reason="propose stale temporal edge cleanup without mutating the graph",
                    metadata=dict(metadata),
                )
            )
        # QUI-187 cross-review Reviewer F REAL (2026-05-20):recompress_verbatim
        # placeholder action 之前会经 to_wire_dict 默认 fallback 错标成
        # kind="reflect-insight",前端 KIND_STYLES["reflect-insight"] 用蓝色
        # ✨ "语义抽取" label,但 reason 是 "propose cold verbatim memory
        # recompression" — 语义错位 + UI 误导。recompress_verbatim 是 docs/03-memory
        # 设计的元层三件事之一(line 274 verbatim 差分再压缩),但当前还没真实实现,
        # 不在 propose 里产 placeholder action。保留 ConsolidationActionKind Literal
        # union 不删(docs 要求),等真实实现路径接入时再恢复。
        return actions

    def _dedupe_actions(
        self,
        *,
        tier: MemoryLayer | None,
        budget: IdleBudgetResult,
    ) -> list[ConsolidationAction]:
        plan = self._build_dedupe_plan(tier=tier, allow_expensive=budget.granted)
        return [
            ConsolidationAction(
                kind="dedupe",
                target_layer=group.tier,
                reason=group.reason,
                metadata={
                    "schema_version": CONSOLIDATOR_SCHEMA_VERSION,
                    "budget_decision": budget.decision,
                    "dedupe_groups": [item.to_wire_dict() for item in plan.groups],
                    "keep_id": group.keep_id,
                    "delete_ids": group.delete_ids,
                    "strategy": group.strategy,
                    "score": group.score,
                    "memory_ids": group.memory_ids,
                },
            )
            for group in plan.groups
        ]

    def _reflection_proposals(
        self,
        *,
        budget: IdleBudgetResult,
        task_outcome: TaskOutcome,
        now: datetime | None,
    ) -> tuple[ReflectionProposal, ...]:
        if not budget.granted or self._store is None:
            return ()
        count = self._store._count_sync({"layer": "episodic"})
        if count <= 0:
            return ()
        records = self._store._list_by_layer_sync("episodic", limit=count, offset=0)
        return tuple(self._reflector.propose(records, task_outcome=task_outcome, now=now))

    def _fetch_all_active_records(self) -> list[MemoryItem]:
        """Cross-tier raw fetch of all active records (deleted=0).

        QUI-187 Reviewer F follow-up:绕过 `_list_by_layer_sync` 的 tier Literal 限制,
        覆盖 schema drift tier(如 "short")。`_row_to_record` 内部已经把非法 tier
        值统一映射成合法 MemoryLayer,确保 dedupe 算法能看到所有 active records。
        """
        from .store import _row_to_record
        from .store_search import record_columns

        if self._store is None:
            return []
        try:
            with self._store._lock:  # type: ignore[attr-defined]
                rows = self._store._conn.execute(  # type: ignore[attr-defined]
                    f"SELECT {record_columns()} FROM memory_records "
                    "WHERE deleted = 0 ORDER BY rowid ASC"
                ).fetchall()
        except Exception:
            return []

        items: list[MemoryItem] = []
        now_fn = datetime.now
        for row in rows:
            try:
                item = _row_to_record(row, now=lambda: now_fn(UTC))
            except Exception:
                continue
            items.append(item)
        return items

    def _build_dedupe_plan(
        self,
        *,
        tier: MemoryLayer | None = None,
        allow_expensive: bool = True,
        direct_threshold: float = DIRECT_SIMILARITY_THRESHOLD,
        llm_threshold: float = LLM_SIMILARITY_THRESHOLD,
    ) -> DedupePlan:
        if self._store is None:
            return DedupePlan(groups=(), total_delete=0, total_keep=0)
        all_groups: list[DedupeGroup] = []
        if tier is None:
            # QUI-187 Reviewer F follow-up (2026-05-20):tier=None 走 cross-tier
            # raw SQL,跨所有 active records dedupe。原 `for layer in VALID_MEMORY_LAYERS`
            # 路径只遍历 4 个合法 tier,但 SQLite memory_records 表里可能有 schema drift
            # 的 tier(如旧版 L3a observer 写入的 "short" tier,4 条 entity 演化记录因此
            # 被完全跳过),导致 user-facing"9 条记忆 0 整理"bug。
            records = self._fetch_all_active_records()
            if len(records) >= 2:
                all_groups.extend(
                    self._build_layer_groups(
                        records,
                        allow_expensive=allow_expensive,
                        direct_threshold=direct_threshold,
                        llm_threshold=llm_threshold,
                    )
                )
        else:
            layer = validate_memory_layer(tier)
            count = self._store._count_sync({"layer": layer})
            if count >= 2:
                records = self._store._list_by_layer_sync(layer, limit=count, offset=0)
                all_groups.extend(
                    self._build_layer_groups(
                        records,
                        allow_expensive=allow_expensive,
                        direct_threshold=direct_threshold,
                        llm_threshold=llm_threshold,
                    )
                )

        all_groups.sort(key=lambda group: (-len(group.delete_ids), group.tier, group.keep_id))
        return DedupePlan(
            groups=tuple(all_groups),
            total_delete=sum(len(group.delete_ids) for group in all_groups),
            total_keep=len(all_groups),
        )

    def _build_layer_groups(
        self,
        records: Sequence[MemoryItem],
        *,
        allow_expensive: bool,
        direct_threshold: float,
        llm_threshold: float,
    ) -> list[DedupeGroup]:
        vectors = (
            _vectors_for_records(records, self._embedding_provider) if allow_expensive else []
        )
        parent = {record.id: record.id for record in records}
        evidence: dict[str, list[_PairEvidence]] = {record.id: [] for record in records}
        soft_pairs: list[_PairEvidence] = []

        def find(memory_id: str) -> str:
            root = parent[memory_id]
            if root != memory_id:
                parent[memory_id] = find(root)
            return parent[memory_id]

        def union_exact(left_id: str, right_id: str, pair: _PairEvidence) -> None:
            left_root = find(left_id)
            right_root = find(right_id)
            if left_root != right_root:
                parent[right_root] = left_root
            evidence[left_id].append(pair)
            evidence[right_id].append(pair)

        for i, left in enumerate(records):
            for j in range(i + 1, len(records)):
                right = records[j]
                exact = _normalize_content(left.content) == _normalize_content(right.content)
                if exact:
                    union_exact(
                        left.id,
                        right.id,
                        _PairEvidence(
                            left.id,
                            right.id,
                            1.0,
                            "exact",
                            "normalized content matches exactly",
                        ),
                    )
                    continue
                if not allow_expensive:
                    continue
                assert vectors
                score = cosine_similarity(vectors[i], vectors[j])
                if score >= direct_threshold:
                    soft_pairs.append(
                        _PairEvidence(
                            left.id,
                            right.id,
                            score,
                            "embedding",
                            f"embedding cosine similarity {score:.3f} >= {direct_threshold:.2f}",
                        ),
                    )
                    continue
                if score >= llm_threshold and self._dedupe_judge is not None:
                    verdict = self._dedupe_judge(left, right, score)
                    if verdict.decision in {"duplicate", "supersedes"}:
                        soft_pairs.append(
                            _PairEvidence(left.id, right.id, score, "llm", verdict.reason)
                        )

        by_root: dict[str, list[MemoryItem]] = {}
        for record in records:
            by_root.setdefault(find(record.id), []).append(record)

        groups: list[DedupeGroup] = []
        grouped_ids: set[str] = set()
        for members in by_root.values():
            if len(members) < 2:
                continue
            keep = _pick_keeper(members)
            delete_ids = tuple(record.id for record in members if record.id != keep.id)
            member_ids = {member.id for member in members}
            member_evidence = [
                pair
                for record in members
                for pair in evidence[record.id]
                if pair.left_id in member_ids and pair.right_id in member_ids
            ]
            strongest = max(member_evidence, key=lambda pair: pair.score)
            groups.append(
                DedupeGroup(
                    tier=keep.layer,
                    keep_id=keep.id,
                    delete_ids=delete_ids,
                    reason=_summarize_group_reason(strongest, keep),
                    strategy=strongest.strategy,
                    score=round(strongest.score, 4),
                    memory_ids=tuple(record.id for record in members),
                )
            )
            grouped_ids.update(record.id for record in members)

        records_by_id = {record.id: record for record in records}
        for pair in sorted(soft_pairs, key=lambda item: item.score, reverse=True):
            if pair.left_id in grouped_ids or pair.right_id in grouped_ids:
                continue
            left = records_by_id[pair.left_id]
            right = records_by_id[pair.right_id]
            keep = _pick_keeper([left, right])
            delete = left if keep.id == right.id else right
            groups.append(
                DedupeGroup(
                    tier=keep.layer,
                    keep_id=keep.id,
                    delete_ids=(delete.id,),
                    reason=_summarize_group_reason(pair, keep),
                    strategy=pair.strategy,
                    score=round(pair.score, 4),
                    memory_ids=(left.id, right.id),
                )
            )
            grouped_ids.update((left.id, right.id))

        return groups

    def auto_schedule(
        self,
        *,
        interval_hours: int = 24,
        now: datetime | None = None,
    ) -> ConsolidationProposal | None:
        current_time = now or _utcnow()

        if self._last_consolidation is not None:
            elapsed = current_time - self._last_consolidation
            if elapsed < timedelta(hours=interval_hours):
                return None

        proposal = self.propose(
            task=f"{DEFAULT_CONSOLIDATION_TASK}.auto",
            now=current_time,
        )

        object.__setattr__(self, "_last_consolidation", current_time)
        object.__setattr__(self, "_consolidation_count", self._consolidation_count + 1)

        self._update_recall_weights(proposal)

        return proposal

    def _update_recall_weights(
        self,
        proposal: ConsolidationProposal,
    ) -> list[RecallWeightsUpdate]:
        budget_granted = proposal.budget.granted
        scaling = 1.0 if budget_granted else 0.3

        updates: list[RecallWeightsUpdate] = []
        for action in proposal.actions:
            action_deltas = _CONSOLIDATION_PRIOR_MAP.get(
                (action.kind, action.target_layer)
            )
            if action_deltas is None:
                continue

            for source_key, raw_delta in action_deltas.items():
                scaled_delta = round(raw_delta * scaling, 4)
                updates.append(
                    RecallWeightsUpdate(
                        source_prior_key=source_key,
                        prior_delta=scaled_delta,
                        reason=(
                            f"consolidation action '{action.kind}' "
                            f"targeting '{action.target_layer}' layer"
                        ),
                    )
                )

        self._apply_recall_priors(updates)
        return updates

    def _apply_recall_priors(self, updates: list[RecallWeightsUpdate]) -> None:
        if self._reranker is None:
            return

        source_priors: dict[str, float] | None = getattr(
            self._reranker, "_source_priors", None
        )
        if not isinstance(source_priors, dict):
            return

        for update in updates:
            key = update.source_prior_key
            current = source_priors.get(key, 0.2)
            adjusted = max(0.05, min(0.95, round(current + update.prior_delta, 4)))
            source_priors[key] = adjusted


def propose(
    *,
    task: str = DEFAULT_CONSOLIDATION_TASK,
    estimated_tokens: int = 0,
) -> ConsolidationProposal:
    return Consolidator().propose(task=task, estimated_tokens=estimated_tokens)


def _vectors_for_records(
    records: Sequence[MemoryItem],
    embedding_provider: EmbeddingProvider,
) -> list[list[float]]:
    missing_indexes = [idx for idx, record in enumerate(records) if record.embedding is None]
    vectors: list[list[float] | None] = [
        _normalize_vector(record.embedding) if record.embedding is not None else None
        for record in records
    ]
    if missing_indexes:
        missing_texts = [records[idx].content for idx in missing_indexes]
        generated = embedding_provider.embed_many(missing_texts)
        for idx, vector in zip(missing_indexes, generated, strict=True):
            vectors[idx] = _normalize_vector(vector)

    return [vector if vector is not None else [] for vector in vectors]


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    return max(0.0, min(1.0, dot / (left_norm * right_norm)))


def _normalize_vector(vector: Sequence[float] | None) -> list[float]:
    if vector is None:
        return []
    norm = math.sqrt(sum(float(value) * float(value) for value in vector))
    if norm == 0.0:
        return [0.0 for _ in vector]
    return [float(value) / norm for value in vector]


def _hash_embedding(text: str) -> list[float]:
    vector = [0.0] * _LOCAL_EMBEDDING_DIM
    for token in _tokens(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=4).digest()
        idx = int.from_bytes(digest[:2], "big") % _LOCAL_EMBEDDING_DIM
        sign = 1.0 if digest[2] % 2 == 0 else -1.0
        vector[idx] += sign
    return _normalize_vector(vector)


def _tokens(text: str) -> list[str]:
    normalized = _normalize_content(text).lower()
    tokens = _WORD_RE.findall(normalized)
    cjk_chars = [ch for ch in normalized if "\u4e00" <= ch <= "\u9fff"]
    tokens.extend(cjk_chars)
    tokens.extend("".join(cjk_chars[i : i + 2]) for i in range(max(0, len(cjk_chars) - 1)))
    return tokens


def _normalize_content(content: str) -> str:
    return " ".join(content.strip().split())


def _pick_keeper(records: Sequence[MemoryItem]) -> MemoryItem:
    return max(records, key=lambda record: (record.created_at, len(record.content), record.id))


def _summarize_group_reason(pair: _PairEvidence, keep: MemoryItem) -> str:
    if pair.strategy == "exact":
        return f"精确重复; 保留最新记录 {keep.id}"
    if pair.strategy == "embedding":
        return f"{pair.reason}; 保留最新记录 {keep.id}"
    return f"LLM 判定可合并: {pair.reason}; 保留记录 {keep.id}"


def _string_tuple(value: object) -> tuple[str, ...]:
    if isinstance(value, tuple):
        return tuple(item for item in value if isinstance(item, str))
    if isinstance(value, list):
        return tuple(item for item in value if isinstance(item, str))
    return ()


__all__ = [
    "CONSOLIDATOR_SCHEMA_VERSION",
    "DEFAULT_CONSOLIDATION_TASK",
    "ConsolidationAction",
    "ConsolidationActionKind",
    "ConsolidationProposal",
    "ConsolidationStrategy",
    "Consolidator",
    "DedupeJudgeResult",
    "RecallWeightsUpdate",
    "cosine_similarity",
    "propose",
]
