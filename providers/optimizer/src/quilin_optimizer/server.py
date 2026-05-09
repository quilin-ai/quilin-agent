"""Quilin offline optimizer MCP server (Stage A+B placeholder).

Exposes a single tool, ``optimize``, that returns a deterministic stub
mirroring the shape consumed by the TS-side ``DspyOfflineOptimizer``.
The body never invokes a real LLM, never imports ``dspy``, and never
emits a generated patch proposal — Stage A is wire-only.

暴露唯一的 MCP 工具 ``optimize``，返回与 TS 端 ``DspyOfflineOptimizer``
预期形状一致的确定性占位。Stage A 不调用 LLM、不引入 ``dspy`` 依赖、
不生成 patch proposal——只对齐通信契约。

Stage C will replace ``_build_placeholder_proposal`` and
``_build_no_proposal_reasons`` with the real DSPy / GEPA pipeline.
The MCP tool signature, return shape, and JSON keys defined here are
the contract that downstream TS code expects — keep them stable.

Stage C 将替换 ``_build_placeholder_proposal`` 和
``_build_no_proposal_reasons`` 的实现为真实 DSPy / GEPA 流程。
本文件定义的 MCP 工具签名、返回结构和 JSON 字段是下游 TS 代码依赖的
对外契约，必须保持稳定。
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from mcp.server.fastmcp import FastMCP

from .logging import configure_once, logger

# Schema version mirrors SELF_EVOLUTION_SCHEMA_VERSION in
# packages/agent-core/src/self-evolution/types.ts. Bump in lockstep.
SCHEMA_VERSION = 1
OPTIMIZER_ID = "dspy-stub"
OPTIMIZER_MODE = "prompt_rewrite"

# Hard caps on inputs accepted by ``optimize``. The placeholder never
# materializes large payloads, but we still validate so a misconfigured
# caller cannot DoS the server with multi-megabyte trajectory blobs.
MAX_TRAJECTORIES = 256
MAX_FAILURE_CATEGORIES = 32
MAX_STRING_LENGTH = 1024


class OptimizerOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _validate_string_field(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise OptimizerOperationError(f"{field} must be a string")
    if len(value) > MAX_STRING_LENGTH:
        raise OptimizerOperationError(f"{field} must be at most {MAX_STRING_LENGTH} characters")
    return value


def _validate_trajectory_entry(entry: object, index: int) -> dict[str, object]:
    if not isinstance(entry, dict):
        raise OptimizerOperationError(f"trajectories[{index}] must be an object")

    trajectory_ref = _validate_string_field(
        entry.get("trajectoryRef", ""),
        f"trajectories[{index}].trajectoryRef",
    )
    if trajectory_ref == "":
        raise OptimizerOperationError(f"trajectories[{index}].trajectoryRef must be non-empty")

    run_id = _validate_string_field(
        entry.get("runId", ""),
        f"trajectories[{index}].runId",
    )
    if run_id == "":
        raise OptimizerOperationError(f"trajectories[{index}].runId must be non-empty")

    task_ref_raw = entry.get("taskRef")
    if task_ref_raw is not None:
        _validate_string_field(task_ref_raw, f"trajectories[{index}].taskRef")

    return {
        "trajectoryRef": trajectory_ref,
        "runId": run_id,
        "taskRef": task_ref_raw if isinstance(task_ref_raw, str) else None,
    }


def _validate_failure_category(value: object, index: int) -> str:
    return _validate_string_field(value, f"failure_categories[{index}]")


def _stable_artifact_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _stable_id(prefix: str, parts: list[str]) -> str:
    """Deterministic id derived from the joined parts.

    Mirrors the TS-side ``createStableRef`` helper so the placeholder
    output collides with reused trajectory refs the way the real
    optimizer should once Stage C lands.

    与 TS 端 ``createStableRef`` 保持一致的确定性 id：让占位输出在重复
    轨迹参考时与 Stage C 真实优化器输出一样可去重。
    """
    payload = "\n".join(parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}:{digest}"


def _build_placeholder_artifacts(
    trajectories: list[dict[str, object]],
    failure_categories: list[str],
) -> list[dict[str, object]]:
    """Construct stub markdown / json artifacts.

    Stage C will fill ``content`` with real DSPy compilation output;
    the hashes/ids stay stable so review tooling indexes them deterministically.

    Stage C 会用真实的 DSPy 编译输出替换 ``content``；
    哈希和 id 保持确定性，便于评审工具稳定索引。
    """
    trajectory_refs = [str(item["trajectoryRef"]) for item in trajectories]
    source_refs = sorted({ref for ref in trajectory_refs if ref})

    markdown_lines = [
        "# DSPy stub placeholder proposal",
        "",
        "Stage A placeholder — Stage C will swap in real DSPy/GEPA output.",
        "",
        "## Trajectories considered",
        *(f"- {ref}" for ref in source_refs),
        "",
        "## Failure categories observed",
        *(f"- {cat}" for cat in failure_categories),
    ]
    markdown = "\n".join(markdown_lines)
    payload = {
        "stage": "A",
        "schema_version": SCHEMA_VERSION,
        "optimizer_id": OPTIMIZER_ID,
        "trajectories_considered": source_refs,
        "failure_categories": list(failure_categories),
        "note": "Stage C will replace this body with real DSPy/GEPA optimization output.",
    }
    json_content = json.dumps(payload, ensure_ascii=False, sort_keys=True)

    return [
        {
            "artifactId": _stable_id(
                "artifact",
                ["markdown", "DSPy stub placeholder", _stable_artifact_hash(markdown)],
            ),
            "kind": "markdown",
            "title": "DSPy stub placeholder summary",
            "content": markdown,
            "contentHash": _stable_artifact_hash(markdown),
            "sourceRefs": source_refs,
        },
        {
            "artifactId": _stable_id(
                "artifact",
                [
                    "json",
                    "DSPy stub placeholder payload",
                    _stable_artifact_hash(json_content),
                ],
            ),
            "kind": "json",
            "title": "DSPy stub placeholder payload",
            "content": json_content,
            "contentHash": _stable_artifact_hash(json_content),
            "sourceRefs": source_refs,
        },
    ]


def _build_placeholder_proposal(
    trajectories: list[dict[str, object]],
    failure_categories: list[str],
    *,
    dry_run: bool,
) -> dict[str, object] | None:
    # Stage A placeholder gate: emit at most one proposal, only when we
    # have both trajectories and at least one failure category. Stage C
    # will replace this with real cluster-based selection.
    #
    # Stage A 占位门控：仅当同时存在轨迹与至少一个失败类别时才产出
    # 一个占位提案。Stage C 将替换为真实的聚类选择逻辑。
    if not trajectories or not failure_categories:
        return None

    artifacts = _build_placeholder_artifacts(trajectories, failure_categories)
    trajectory_refs = sorted({str(item["trajectoryRef"]) for item in trajectories})
    evidence_hashes = [artifact["contentHash"] for artifact in artifacts]

    return {
        "title": "DSPy placeholder optimization proposal",
        "summary": (
            "Stage A placeholder. Stage C will replace this body with real "
            "DSPy / GEPA optimization output. Review-only — never auto-apply."
        ),
        "artifacts": artifacts,
        "evidenceHashes": evidence_hashes,
        "riskPreview": {
            "level": "medium",
            "reasons": [
                "DSPy stub proposal is a deterministic placeholder and must "
                "not be applied automatically.",
                f"Trajectories aggregated into the placeholder: {len(trajectory_refs)}.",
                "Stage C will swap in a real optimizer; until then this "
                "candidate is artifact-only.",
            ],
            "touchesRuntime": False,
            "requiresHumanReview": True,
        },
        "metadata": {
            "optimizer_id": OPTIMIZER_ID,
            "stage": "A",
            "trajectory_refs": trajectory_refs,
            "failure_categories": list(failure_categories),
            "application_mode": "proposal_only",
            "dry_run": dry_run,
        },
    }


def _build_no_proposal_reasons(
    trajectories: list[dict[str, object]],
    failure_categories: list[str],
) -> list[dict[str, object]]:
    reasons: list[dict[str, object]] = []

    if not trajectories:
        reasons.append(
            {
                "code": "no_failure_detected",
                "message": ("DSPy stub received no trajectories; nothing to optimize."),
                "evidenceRefs": [],
            }
        )
        return reasons

    if not failure_categories:
        reasons.append(
            {
                "code": "insufficient_signal",
                "message": (
                    "DSPy stub requires at least one failure category to "
                    "produce a placeholder proposal."
                ),
                "evidenceRefs": sorted({str(item["trajectoryRef"]) for item in trajectories}),
            }
        )

    return reasons


async def _optimize(
    trajectories_raw: list[object] | None,
    failure_categories_raw: list[object] | None,
    *,
    dry_run: bool,
) -> dict[str, object]:
    trajectories_input: list[object] = list(trajectories_raw or [])
    if len(trajectories_input) > MAX_TRAJECTORIES:
        raise OptimizerOperationError(f"trajectories must contain at most {MAX_TRAJECTORIES} items")

    failure_categories_input: list[object] = list(failure_categories_raw or [])
    if len(failure_categories_input) > MAX_FAILURE_CATEGORIES:
        raise OptimizerOperationError(
            f"failure_categories must contain at most {MAX_FAILURE_CATEGORIES} items"
        )

    trajectories = [
        _validate_trajectory_entry(entry, index) for index, entry in enumerate(trajectories_input)
    ]
    failure_categories = [
        _validate_failure_category(entry, index)
        for index, entry in enumerate(failure_categories_input)
    ]

    proposal = _build_placeholder_proposal(trajectories, failure_categories, dry_run=dry_run)
    no_proposal_reasons = _build_no_proposal_reasons(trajectories, failure_categories)
    proposals: list[dict[str, object]] = [proposal] if proposal is not None else []

    return {
        "schema_version": SCHEMA_VERSION,
        "optimizer_id": OPTIMIZER_ID,
        "mode": OPTIMIZER_MODE,
        "created_at": _now_iso(),
        "proposals": proposals,
        "no_proposal_reasons": no_proposal_reasons,
        "stage": "A",
        "dry_run": dry_run,
    }


async def optimize(
    trajectories: list[object] | None = None,
    failure_categories: list[object] | None = None,
    dry_run: bool = False,
) -> str:
    """Stage A placeholder.

    Returns a deterministic stub mirroring the TS-side
    ``OfflineOptimizerResult`` shape. Stage C will swap in real DSPy.

    返回与 TS 端 ``OfflineOptimizerResult`` 形状一致的确定性占位。
    Stage C 将把占位实现替换为真实 DSPy 流程。
    """
    try:
        result = await _optimize(
            trajectories,
            failure_categories,
            dry_run=dry_run,
        )
    except OptimizerOperationError:
        raise
    except Exception as exc:
        logger.error("optimize failed", error=str(exc))
        raise OptimizerOperationError("optimize failed") from exc

    return json.dumps(result, ensure_ascii=False, sort_keys=True)


def create_server() -> FastMCP:
    """Build a configured FastMCP server exposing the ``optimize`` tool.

    Tests call ``create_server()`` and probe the FastMCP tool manager
    rather than spinning up the full stdio transport.

    测试通过 ``create_server()`` 直接探查 FastMCP 工具管理器，
    而不是启动完整的 stdio 传输栈。
    """

    server = FastMCP("quilin-optimizer")

    @server.tool(name="optimize")
    async def optimize_tool(
        trajectories: list[object] | None = None,
        failure_categories: list[object] | None = None,
        dry_run: bool = False,
    ) -> str:
        """Stage A placeholder. Stage C will swap in a real DSPy run.

        Args:
            trajectories: Recent stored trajectories (each a dict with at
                least ``trajectoryRef`` and ``runId``). The placeholder
                only reads identifiers — Stage C will consume the full
                trajectory body.
            failure_categories: Failure category strings observed across
                ``trajectories``. Used by the placeholder to populate
                metadata and to decide whether to emit a proposal.
            dry_run: Forwarded as metadata. The placeholder's output is
                identical regardless of value; the flag is recorded so
                downstream auditors can verify caller intent.
        """
        return await optimize(
            trajectories=trajectories,
            failure_categories=failure_categories,
            dry_run=dry_run,
        )

    return server


mcp = create_server()


def main() -> None:
    configure_once()
    logger.info("quilin-optimizer server starting", transport="stdio")
    mcp.run(transport="stdio")
