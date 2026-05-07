from __future__ import annotations

import json

from .types import MemoryLayer

PLANNING_REVIEW_SOURCE = "planning_review"
PLANNING_STATE_SOURCE = "planning_state"
PLANNING_REVIEW_SCHEMA_VERSION = 1
FORBIDDEN_PLANNING_RUNTIME_KEYS = frozenset(
    {
        "budget",
        "checkpoints",
        "currentLeafId",
        "events",
        "phase",
        "plan",
    }
)


def validate_semantic_ingestion_contract(
    *,
    layer: MemoryLayer,
    content_type: str,
    metadata: dict[str, object],
    content: str,
) -> None:
    if metadata.get("source") == PLANNING_STATE_SOURCE and layer == "semantic":
        raise ValueError("planning_state runtime payloads cannot be stored in semantic memory")

    if layer == "semantic":
        _reject_semantic_runtime_payload(content_type=content_type, content=content)
        _require_semantic_stability_metadata(metadata)

    if metadata.get("source") == PLANNING_STATE_SOURCE:
        return

    if metadata.get("source") != PLANNING_REVIEW_SOURCE:
        return

    if layer != "semantic":
        raise ValueError("planning_review records must be stored in the semantic layer")
    if content_type != "json":
        raise ValueError("planning_review records must use content_type=json")
    if metadata.get("schema_version") != PLANNING_REVIEW_SCHEMA_VERSION:
        raise ValueError("planning_review metadata.schema_version must be 1")

    run_id = metadata.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise ValueError("planning_review metadata.run_id must be a non-empty string")

    _validate_planning_review_payload(content, run_id=run_id)


def _reject_semantic_runtime_payload(*, content_type: str, content: str) -> None:
    if content_type != "json":
        return

    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return

    if not isinstance(payload, dict):
        return

    if _has_planning_state_shape(payload) or _contains_forbidden_runtime_keys(payload):
        raise ValueError("running PlanningState payloads cannot be stored in semantic memory")


def _validate_planning_review_payload(content: str, *, run_id: str) -> None:
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError("planning_review semantic content must be valid JSON") from exc

    if not isinstance(payload, dict):
        raise ValueError("planning_review semantic content must be a top-level object")

    if payload.get("run_id") != run_id:
        raise ValueError("planning_review payload.run_id must match metadata.run_id")
    if payload.get("source") != PLANNING_REVIEW_SOURCE:
        raise ValueError("planning_review payload.source must be planning_review")
    if payload.get("schema_version") != PLANNING_REVIEW_SCHEMA_VERSION:
        raise ValueError("planning_review payload.schema_version must be 1")

    summary = payload.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("planning_review payload.summary must be a non-empty string")

    stable_strategy = payload.get("stable_strategy")
    if not isinstance(stable_strategy, dict):
        raise ValueError("planning_review payload.stable_strategy must be an object")

    if _contains_forbidden_runtime_keys(payload):
        raise ValueError("running PlanningState payloads cannot be stored in semantic memory")


def _require_semantic_stability_metadata(metadata: dict[str, object]) -> None:
    source = metadata.get("source")
    if not isinstance(source, str) or not source.strip():
        raise ValueError("semantic memory metadata.source must be a non-empty string")

    stability_reason = metadata.get("stability_reason")
    if not isinstance(stability_reason, str) or not stability_reason.strip():
        raise ValueError("semantic memory metadata.stability_reason must be a non-empty string")


def _contains_forbidden_runtime_keys(payload: object) -> bool:
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in FORBIDDEN_PLANNING_RUNTIME_KEYS:
                return True
            if _contains_forbidden_runtime_keys(value):
                return True
        return False

    if isinstance(payload, list):
        return any(_contains_forbidden_runtime_keys(item) for item in payload)

    return False


def _has_planning_state_shape(payload: dict[str, object]) -> bool:
    return (
        isinstance(payload.get("runId"), str)
        and isinstance(payload.get("events"), list)
        and isinstance(payload.get("checkpoints"), list)
        and isinstance(payload.get("phase"), str)
    )
