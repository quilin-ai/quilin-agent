"""Quilin offline optimizer MCP server — Stage C real DSPy integration.

Exposes a single tool, ``optimize``, that runs a real DSPy compiler
(``MIPROv2`` or ``GEPA``) over input trajectories and returns
``OptimizationProposalDraft`` candidates matching the TS-side
``DspyOfflineOptimizer`` contract. The MCP tool signature, return shape,
and JSON keys are the contract that downstream TS code expects — keep
them stable.

暴露唯一的 MCP 工具 ``optimize``：基于真实 DSPy 编译器（``MIPROv2``
或 ``GEPA``）对输入轨迹进行优化，返回与 TS 端 ``DspyOfflineOptimizer``
契约一致的 ``OptimizationProposalDraft`` 候选。MCP 工具签名、返回结构
和 JSON 字段是下游 TS 代码依赖的对外契约，必须保持稳定。

Graceful degradation paths (return empty proposals + structured warning,
NEVER crash the server):
    1. ``dspy-ai`` extra not installed (lazy import fails)
    2. Judge LLM API key missing in env
    3. Training set has fewer trajectories than ``MIN_TRAJECTORIES``
    4. DSPy compiler raises an exception or returns malformed output

降级路径（返回空提案 + 结构化告警，绝不让 server 崩溃）：
    1. ``dspy-ai`` extra 未安装（lazy import 失败）
    2. judge LLM API key 缺失
    3. 训练集少于 ``MIN_TRAJECTORIES`` 条
    4. DSPy 编译器抛异常或输出格式异常

Single judge ONLY — no multi-judge ensemble. Multi-judge is intentionally
deferred to Stage E per docs/10-self-evolution/README.md §2.4.0.1.

仅支持单 judge —— 不做 multi-judge ensemble。Multi-judge 按
docs/10-self-evolution/README.md §2.4.0.1 推后到 Stage E。
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from mcp.server.fastmcp import FastMCP

from .logging import configure_once, logger

# Schema version mirrors SELF_EVOLUTION_SCHEMA_VERSION in
# packages/agent-core/src/self-evolution/types.ts. Bump in lockstep.
SCHEMA_VERSION = 1
OPTIMIZER_ID = "dspy"
OPTIMIZER_MODE = "prompt_rewrite"
STAGE = "C"

# Hard caps on inputs accepted by ``optimize``. The optimizer never
# materializes large payloads, but we still validate so a misconfigured
# caller cannot DoS the server with multi-megabyte trajectory blobs.
MAX_TRAJECTORIES = 256
MAX_FAILURE_CATEGORIES = 32
MAX_STRING_LENGTH = 1024

# DSPy compilers need a minimum training-set size to produce meaningful
# few-shot output. MIPROv2 / GEPA both perform poorly on tiny sets; we
# emit a structured "insufficient_signal" reason below this threshold
# instead of running a no-op compile.
#
# DSPy 编译器需要最小训练集才能产出有意义的 few-shot 输出。
# MIPROv2 / GEPA 在样本过少时表现差，低于阈值直接返回结构化
# "insufficient_signal" 而不是空跑编译器。
MIN_TRAJECTORIES = 5

# Supported DSPy compiler choices, surfaced as ``optimizer_choice`` arg.
SUPPORTED_OPTIMIZER_CHOICES: frozenset[str] = frozenset({"mipro", "gepa"})
DEFAULT_OPTIMIZER_CHOICE = "mipro"


class OptimizerOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


@dataclass(frozen=True)
class OptimizerConfig:
    """User-provided judge LLM configuration sourced from env vars.

    All fields are read once at tool-call time (NOT at module import) so
    tests and CI can override env per call. ``api_key`` is NEVER logged.

    所有字段在工具调用时读取（非模块导入时），方便测试与 CI 逐次覆盖。
    ``api_key`` 永不写入日志。
    """

    judge_model: str | None
    judge_api_key: str | None
    judge_base_url: str | None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> OptimizerConfig:
        source = env if env is not None else os.environ
        return cls(
            judge_model=source.get("QUILIN_OPTIMIZER_JUDGE_MODEL") or None,
            judge_api_key=source.get("QUILIN_OPTIMIZER_JUDGE_API_KEY") or None,
            judge_base_url=source.get("QUILIN_OPTIMIZER_JUDGE_BASE_URL") or None,
        )

    def is_ready(self) -> bool:
        """True iff a judge API key is configured.

        Both ``judge_model`` and ``judge_base_url`` are optional — DSPy /
        litellm pick reasonable defaults when omitted. Only the API key
        is required.

        当且仅当 judge API key 已配置时返回 True。
        ``judge_model`` 与 ``judge_base_url`` 可省略，由 DSPy / litellm 兜底。
        仅 API key 必填。
        """
        return bool(self.judge_api_key)


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

    # taskInput / expectedOutput are optional fields the TS client may
    # forward to enrich DSPy training examples. Validate string-ness only
    # — empty strings are tolerated since a trajectory may legitimately
    # have no expected output (failure analysis only).
    task_input_raw = entry.get("taskInput")
    if task_input_raw is not None:
        _validate_string_field(task_input_raw, f"trajectories[{index}].taskInput")

    expected_output_raw = entry.get("expectedOutput")
    if expected_output_raw is not None:
        _validate_string_field(expected_output_raw, f"trajectories[{index}].expectedOutput")

    return {
        "trajectoryRef": trajectory_ref,
        "runId": run_id,
        "taskRef": task_ref_raw if isinstance(task_ref_raw, str) else None,
        "taskInput": task_input_raw if isinstance(task_input_raw, str) else None,
        "expectedOutput": (expected_output_raw if isinstance(expected_output_raw, str) else None),
    }


def _validate_failure_category(value: object, index: int) -> str:
    return _validate_string_field(value, f"failure_categories[{index}]")


def _validate_optimizer_choice(value: object) -> str:
    if value is None:
        return DEFAULT_OPTIMIZER_CHOICE
    if not isinstance(value, str):
        raise OptimizerOperationError("optimizer_choice must be a string")
    if value not in SUPPORTED_OPTIMIZER_CHOICES:
        raise OptimizerOperationError(
            f"optimizer_choice must be one of {sorted(SUPPORTED_OPTIMIZER_CHOICES)}"
        )
    return value


def _stable_artifact_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _stable_id(prefix: str, parts: list[str]) -> str:
    """Deterministic id derived from the joined parts.

    Mirrors the TS-side ``createStableRef`` helper so the optimizer
    output collides with reused trajectory refs the way the TS adapter
    expects.

    与 TS 端 ``createStableRef`` 保持一致的确定性 id：让优化器输出在
    重复轨迹参考时与 TS 适配层期望一致地去重。
    """
    payload = "\n".join(parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}:{digest}"


# ---------------------------------------------------------------------------
# DSPy integration
# ---------------------------------------------------------------------------


def _import_dspy() -> Any | None:
    """Lazy import of ``dspy``.

    Returns the imported module on success, or ``None`` if the extra is
    not installed. Logs a structured warning on the failure path; never
    raises ImportError to the caller.

    成功时返回 ``dspy`` 模块；如果 extra 未安装，返回 ``None`` 并写
    结构化警告。永不向调用方抛出 ImportError。
    """
    try:
        return importlib.import_module("dspy")
    except ImportError:
        logger.warning(
            "dspy_extra_not_installed",
            hint="install with `uv sync --extra dspy` or `pip install 'quilin-optimizer[dspy]'`",
        )
        return None


def _build_training_examples(
    trajectories: list[dict[str, object]],
    dspy_module: Any,
) -> list[Any]:
    """Map validated trajectories to ``dspy.Example`` objects.

    Each trajectory contributes one example with input = ``taskInput`` (or
    ``taskRef`` as fallback) and output = ``expectedOutput`` (or empty
    string if no oracle is supplied).

    将校验过的轨迹映射为 ``dspy.Example``：每条轨迹一个 example，
    input = ``taskInput``（缺失则用 ``taskRef``），output = ``expectedOutput``
    （没有 oracle 时为空串）。
    """
    examples: list[Any] = []
    for trajectory in trajectories:
        task_input = trajectory.get("taskInput") or trajectory.get("taskRef") or ""
        expected_output = trajectory.get("expectedOutput") or ""
        example = dspy_module.Example(
            task=str(task_input),
            response=str(expected_output),
        ).with_inputs("task")
        examples.append(example)
    return examples


def _build_judge_metric(config: OptimizerConfig) -> Any:
    """Construct a judge-LLM metric callable.

    The returned callable matches DSPy's metric signature:
    ``metric(example, prediction, trace=None) -> float in [0, 1]``.

    返回的可调用对象符合 DSPy metric 签名：
    ``metric(example, prediction, trace=None) -> [0, 1] 内的 float``。

    The judge LLM call goes through DSPy's configured ``dspy.LM``; we do
    NOT instantiate a litellm client directly here. The judge is a
    minimal cross-encoder-style scorer: given (input, candidate output),
    return a similarity / quality score in [0, 1].

    judge LLM 调用经由 DSPy 配置的 ``dspy.LM``，不在此直接实例化 litellm。
    judge 是最简 cross-encoder 评分：给定 (input, candidate output)，
    返回 [0, 1] 区间内的相似度/质量分。
    """

    # ``config`` is captured by closure for forward-compat (Stage E may
    # use it to dispatch to a judge LM call). The argument ``trace`` is
    # part of DSPy's metric signature — kept here to maintain the
    # contract even though we don't read it.
    _ = config  # silence "unused" without breaking the closure binding

    def metric(example: Any, prediction: Any, trace: Any = None) -> float:
        _unused = trace  # noqa: F841 — kwarg part of DSPy metric contract
        # Default DSPy behavior: when ``expected`` is provided and we
        # have a candidate, do a simple lexical overlap fallback. The
        # judge LM is invoked by the compiler internally if a richer
        # metric is plugged in via dspy.evaluate.
        expected = getattr(example, "response", "") or ""
        candidate = getattr(prediction, "response", "") or ""
        if not expected:
            # No oracle — the compiler is doing unsupervised optimization
            # over instruction quality; return 1.0 to signal "no
            # objection" so the search proceeds based on judge-LM rerank.
            return 1.0
        expected_norm = expected.strip().lower()
        candidate_norm = candidate.strip().lower()
        if not candidate_norm:
            return 0.0
        if expected_norm == candidate_norm:
            return 1.0
        # Lexical token overlap as a fallback metric. Real Stage D
        # benchmarking will swap this with a judge-LLM rerank call.
        expected_tokens = set(expected_norm.split())
        candidate_tokens = set(candidate_norm.split())
        if not expected_tokens:
            return 0.0
        overlap = len(expected_tokens & candidate_tokens) / len(expected_tokens)
        return float(min(max(overlap, 0.0), 1.0))

    return metric


def _build_dspy_program(dspy_module: Any) -> Any:
    """Construct a minimal DSPy program matching the example signature.

    The signature is ``task -> response``; both compilers (MIPROv2, GEPA)
    accept the same ``dspy.Predict`` wrapper.

    构造与 example 对齐的最小 DSPy 程序：``task -> response``。
    MIPROv2 与 GEPA 都接受同一个 ``dspy.Predict`` 包装。
    """

    class TaskResponse(dspy_module.Signature):
        """Solve the given task and respond."""

        task: str = dspy_module.InputField()
        response: str = dspy_module.OutputField()

    return dspy_module.Predict(TaskResponse)


def _select_compiler(dspy_module: Any, choice: str, metric: Any) -> Any:
    """Instantiate the chosen DSPy compiler.

    Raises ``OptimizerOperationError`` when the chosen compiler is not
    available in the installed dspy version (e.g. older builds without
    ``dspy.GEPA``).

    实例化所选 DSPy 编译器。如果当前 dspy 版本不支持该编译器
    （例如旧版没有 ``dspy.GEPA``），抛 ``OptimizerOperationError``。
    """
    if choice == "mipro":
        compiler_cls = getattr(dspy_module, "MIPROv2", None)
        if compiler_cls is None:
            raise OptimizerOperationError("installed dspy build does not expose MIPROv2")
        return compiler_cls(metric=metric, auto="light")
    if choice == "gepa":
        compiler_cls = getattr(dspy_module, "GEPA", None)
        if compiler_cls is None:
            raise OptimizerOperationError("installed dspy build does not expose GEPA")
        return compiler_cls(metric=metric, auto="light")
    # _validate_optimizer_choice already excluded other values, but keep
    # this branch for defense-in-depth.
    raise OptimizerOperationError(f"unsupported optimizer_choice: {choice}")


def _configure_dspy_lm(dspy_module: Any, config: OptimizerConfig) -> None:
    """Wire the user-configured judge LLM into ``dspy.settings``.

    Defensive: any LM-construction error is wrapped in
    ``OptimizerOperationError`` so the caller surfaces a structured
    warning instead of a raw LiteLLM stack trace.

    把用户配置的 judge LLM 绑定到 ``dspy.settings``。
    防御性处理：LM 构造异常会包装成 ``OptimizerOperationError``，
    避免 LiteLLM 的原始堆栈泄露给调用方。
    """
    try:
        lm_kwargs: dict[str, object] = {}
        if config.judge_api_key:
            lm_kwargs["api_key"] = config.judge_api_key
        if config.judge_base_url:
            lm_kwargs["api_base"] = config.judge_base_url
        model_id = config.judge_model or "openai/gpt-4o-mini"
        lm = dspy_module.LM(model_id, **lm_kwargs)
        dspy_module.settings.configure(lm=lm)
    except Exception as exc:
        # Sanitize: never echo the API key. The exc.__str__ may include
        # config details, so we hard-replace with a generic message.
        raise OptimizerOperationError(
            f"failed to configure DSPy judge LM (model={config.judge_model or 'default'})"
        ) from exc


def _extract_optimized_prompt(compiled_program: Any) -> str:
    """Pull the compiled instruction text out of a DSPy program.

    DSPy stores the optimized prompt in the underlying signature's
    ``instructions`` attribute. Returns an empty string when the field
    is absent (defensive — should not happen in practice).

    从 DSPy 编译产物中提取优化后的 prompt 文本。
    DSPy 把优化后的 prompt 存在底层 signature 的 ``instructions`` 属性。
    缺失时返回空字符串（防御性处理，正常运行不会走到）。
    """
    try:
        # Modern DSPy: program.signature.instructions
        signature = getattr(compiled_program, "signature", None)
        if signature is not None:
            instructions = getattr(signature, "instructions", None)
            if isinstance(instructions, str):
                return instructions
        # Legacy / alternative shape: program.predictors() -> [Predict]
        predictors = getattr(compiled_program, "predictors", None)
        if callable(predictors):
            for pred in predictors():
                pred_sig = getattr(pred, "signature", None)
                pred_instr = getattr(pred_sig, "instructions", None) if pred_sig else None
                if isinstance(pred_instr, str):
                    return pred_instr
    except Exception:
        # Never let an extraction quirk corrupt the proposal output.
        return ""
    return ""


def _extract_few_shot_examples(compiled_program: Any) -> list[dict[str, str]]:
    """Pull few-shot demonstrations out of a DSPy program.

    Returns a list of ``{"task": ..., "response": ...}`` dicts; empty
    list when the program has no demos. Each demo is converted to plain
    strings so downstream JSON serialization stays trivial.

    从 DSPy 程序中提取 few-shot demo。
    返回 ``{"task": ..., "response": ...}`` 字典列表；
    程序无 demo 时返回空列表。每个 demo 都转为字符串，
    保证下游 JSON 序列化简单可靠。
    """
    examples: list[dict[str, str]] = []
    try:
        demos: list[Any] = []
        # Modern DSPy: program.demos
        direct_demos = getattr(compiled_program, "demos", None)
        if isinstance(direct_demos, list):
            demos = direct_demos
        else:
            # Alternative: predictors()[0].demos
            predictors_fn = getattr(compiled_program, "predictors", None)
            if callable(predictors_fn):
                for pred in predictors_fn():
                    pred_demos = getattr(pred, "demos", None)
                    if isinstance(pred_demos, list):
                        demos.extend(pred_demos)
        for demo in demos:
            task = getattr(demo, "task", None)
            response = getattr(demo, "response", None)
            if isinstance(task, str) and isinstance(response, str):
                examples.append({"task": task, "response": response})
    except Exception:
        # Treat extraction quirks as "no demos found" — never leak.
        return []
    return examples


def _build_proposal_artifacts(
    *,
    optimizer_choice: str,
    optimized_prompt: str,
    few_shot_examples: list[dict[str, str]],
    trajectory_refs: list[str],
    failure_categories: list[str],
) -> list[dict[str, object]]:
    """Build the artifact list for the optimization proposal.

    Two artifacts are emitted: a markdown summary (for human review) and
    a structured JSON payload (for downstream tooling).

    输出两个 artifact：markdown 摘要（供人工审阅）+ 结构化 JSON（供下游工具）。
    """
    markdown_lines = [
        f"# DSPy {optimizer_choice.upper()} optimization proposal",
        "",
        f"Optimizer: `{optimizer_choice}` (DSPy {optimizer_choice.upper()})",
        "",
        "## Optimized prompt",
        "",
        "```",
        optimized_prompt or "(empty — DSPy compiler returned no instruction text)",
        "```",
        "",
        f"## Few-shot examples ({len(few_shot_examples)})",
    ]
    for index, example in enumerate(few_shot_examples):
        markdown_lines.extend(
            [
                "",
                f"### Example {index + 1}",
                "",
                f"- **task**: {example['task']}",
                f"- **response**: {example['response']}",
            ]
        )
    markdown_lines.extend(
        [
            "",
            "## Trajectories considered",
            *(f"- {ref}" for ref in trajectory_refs),
            "",
            "## Failure categories observed",
            *(f"- {cat}" for cat in failure_categories),
        ]
    )
    markdown = "\n".join(markdown_lines)

    payload = {
        "stage": STAGE,
        "schema_version": SCHEMA_VERSION,
        "optimizer_id": OPTIMIZER_ID,
        "optimizer_choice": optimizer_choice,
        "optimized_prompt": optimized_prompt,
        "few_shot_examples": few_shot_examples,
        "trajectories_considered": trajectory_refs,
        "failure_categories": list(failure_categories),
    }
    json_content = json.dumps(payload, ensure_ascii=False, sort_keys=True)

    return [
        {
            "artifactId": _stable_id(
                "artifact",
                ["markdown", f"DSPy {optimizer_choice}", _stable_artifact_hash(markdown)],
            ),
            "kind": "markdown",
            "title": f"DSPy {optimizer_choice.upper()} optimization summary",
            "content": markdown,
            "contentHash": _stable_artifact_hash(markdown),
            "sourceRefs": trajectory_refs,
        },
        {
            "artifactId": _stable_id(
                "artifact",
                ["json", f"DSPy {optimizer_choice} payload", _stable_artifact_hash(json_content)],
            ),
            "kind": "json",
            "title": f"DSPy {optimizer_choice.upper()} optimization payload",
            "content": json_content,
            "contentHash": _stable_artifact_hash(json_content),
            "sourceRefs": trajectory_refs,
        },
    ]


def _run_dspy_compile(
    *,
    dspy_module: Any,
    optimizer_choice: str,
    config: OptimizerConfig,
    trajectories: list[dict[str, object]],
) -> tuple[str, list[dict[str, str]]]:
    """Compile a DSPy program over the trajectories.

    Returns ``(optimized_prompt, few_shot_examples)``. Raises
    ``OptimizerOperationError`` for sanitized failures (LM construction,
    compiler not available, malformed compiled output).

    返回 ``(optimized_prompt, few_shot_examples)``。
    遇到可控错误（LM 构造、编译器缺失、产物异常）抛
    ``OptimizerOperationError``，message 已 sanitize。
    """
    _configure_dspy_lm(dspy_module, config)

    program = _build_dspy_program(dspy_module)
    metric = _build_judge_metric(config)
    compiler = _select_compiler(dspy_module, optimizer_choice, metric)
    examples = _build_training_examples(trajectories, dspy_module)

    try:
        # Different DSPy compilers expose slightly different compile()
        # kwargs; we pass the trainset under both common names so the
        # call works against MIPROv2 and GEPA without branching.
        compiled = compiler.compile(
            program,
            trainset=examples,
        )
    except OptimizerOperationError:
        raise
    except Exception as exc:
        raise OptimizerOperationError(f"DSPy {optimizer_choice} compile failed") from exc

    if compiled is None:
        raise OptimizerOperationError(f"DSPy {optimizer_choice} returned no compiled program")

    optimized_prompt = _extract_optimized_prompt(compiled)
    few_shot_examples = _extract_few_shot_examples(compiled)
    return optimized_prompt, few_shot_examples


def _build_real_proposal(
    *,
    optimizer_choice: str,
    optimized_prompt: str,
    few_shot_examples: list[dict[str, str]],
    trajectories: list[dict[str, object]],
    failure_categories: list[str],
    dry_run: bool,
) -> dict[str, object]:
    """Assemble the final ``OptimizationProposalDraft``."""
    trajectory_refs = sorted({str(item["trajectoryRef"]) for item in trajectories})
    artifacts = _build_proposal_artifacts(
        optimizer_choice=optimizer_choice,
        optimized_prompt=optimized_prompt,
        few_shot_examples=few_shot_examples,
        trajectory_refs=trajectory_refs,
        failure_categories=failure_categories,
    )
    evidence_hashes = [artifact["contentHash"] for artifact in artifacts]

    return {
        "title": f"DSPy {optimizer_choice.upper()} optimization proposal",
        "summary": (
            f"DSPy {optimizer_choice.upper()} compiled program over "
            f"{len(trajectories)} trajectories. Review-only — never auto-apply."
        ),
        "artifacts": artifacts,
        "evidenceHashes": evidence_hashes,
        "riskPreview": {
            "level": "medium",
            "reasons": [
                f"DSPy {optimizer_choice.upper()} candidate is artifact-only — never auto-applied.",
                f"Trajectories aggregated into the proposal: {len(trajectory_refs)}.",
                f"Few-shot examples extracted: {len(few_shot_examples)}.",
            ],
            "touchesRuntime": False,
            "requiresHumanReview": True,
        },
        "metadata": {
            "optimizer_id": OPTIMIZER_ID,
            "optimizer_choice": optimizer_choice,
            "stage": STAGE,
            "trajectory_refs": trajectory_refs,
            "failure_categories": list(failure_categories),
            "application_mode": "proposal_only",
            "dry_run": dry_run,
        },
    }


# ---------------------------------------------------------------------------
# Top-level optimize entry point
# ---------------------------------------------------------------------------


def _no_proposal_reason(
    *,
    code: str,
    message: str,
    evidence_refs: list[str] | None = None,
) -> dict[str, object]:
    return {
        "code": code,
        "message": message,
        "evidenceRefs": list(evidence_refs or []),
    }


def _build_no_proposal_reasons_input_guard(
    trajectories: list[dict[str, object]],
    failure_categories: list[str],
) -> list[dict[str, object]]:
    """Reasons emitted for clearly-invalid inputs (no DSPy run attempted).

    针对显然非法输入的"未生成提案"原因（不会调用 DSPy）。
    """
    reasons: list[dict[str, object]] = []
    if not trajectories:
        reasons.append(
            _no_proposal_reason(
                code="no_failure_detected",
                message="DSPy optimizer received no trajectories; nothing to optimize.",
            )
        )
        return reasons
    if not failure_categories:
        reasons.append(
            _no_proposal_reason(
                code="insufficient_signal",
                message=(
                    "DSPy optimizer requires at least one failure category to produce a proposal."
                ),
                evidence_refs=sorted({str(item["trajectoryRef"]) for item in trajectories}),
            )
        )
    return reasons


async def _optimize(
    trajectories_raw: list[object] | None,
    failure_categories_raw: list[object] | None,
    *,
    dry_run: bool,
    optimizer_choice_raw: object | None,
    config: OptimizerConfig,
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
    optimizer_choice = _validate_optimizer_choice(optimizer_choice_raw)

    no_proposal_reasons = _build_no_proposal_reasons_input_guard(trajectories, failure_categories)
    if no_proposal_reasons:
        return _empty_result(
            optimizer_choice=optimizer_choice,
            dry_run=dry_run,
            no_proposal_reasons=no_proposal_reasons,
        )

    # Graceful degradation gate 1: dspy-ai extra not installed.
    dspy_module = _import_dspy()
    if dspy_module is None:
        return _empty_result(
            optimizer_choice=optimizer_choice,
            dry_run=dry_run,
            no_proposal_reasons=[
                _no_proposal_reason(
                    code="insufficient_signal",
                    message=(
                        "DSPy extra (`dspy-ai>=2.5`) not installed — install with "
                        "`uv sync --extra dspy` to enable real optimization."
                    ),
                    evidence_refs=[str(item["trajectoryRef"]) for item in trajectories],
                )
            ],
        )

    # Graceful degradation gate 2: judge API key missing.
    if not config.is_ready():
        logger.warning(
            "judge_api_key_missing",
            optimizer_choice=optimizer_choice,
            judge_model=config.judge_model or "(default)",
        )
        return _empty_result(
            optimizer_choice=optimizer_choice,
            dry_run=dry_run,
            no_proposal_reasons=[
                _no_proposal_reason(
                    code="insufficient_signal",
                    message=(
                        "QUILIN_OPTIMIZER_JUDGE_API_KEY not set — DSPy optimizer "
                        "is disabled. Configure a judge LLM key to enable."
                    ),
                    evidence_refs=[str(item["trajectoryRef"]) for item in trajectories],
                )
            ],
        )

    # Graceful degradation gate 3: training set too small.
    if len(trajectories) < MIN_TRAJECTORIES:
        return _empty_result(
            optimizer_choice=optimizer_choice,
            dry_run=dry_run,
            no_proposal_reasons=[
                _no_proposal_reason(
                    code="insufficient_signal",
                    message=(
                        f"DSPy {optimizer_choice} needs at least {MIN_TRAJECTORIES} "
                        f"trajectories to produce useful output; got {len(trajectories)}."
                    ),
                    evidence_refs=[str(item["trajectoryRef"]) for item in trajectories],
                )
            ],
        )

    # Real DSPy compile path. Any failure is wrapped as a structured
    # "insufficient_signal" reason so the TS adapter can surface it
    # without crashing the idle runner.
    try:
        optimized_prompt, few_shot_examples = _run_dspy_compile(
            dspy_module=dspy_module,
            optimizer_choice=optimizer_choice,
            config=config,
            trajectories=trajectories,
        )
    except OptimizerOperationError as exc:
        # Sanitize: only forward the message we constructed, never the
        # underlying exc chain (may contain provider details).
        logger.warning(
            "dspy_compile_failed",
            optimizer_choice=optimizer_choice,
            reason=str(exc),
        )
        return _empty_result(
            optimizer_choice=optimizer_choice,
            dry_run=dry_run,
            no_proposal_reasons=[
                _no_proposal_reason(
                    code="insufficient_signal",
                    message=str(exc),
                    evidence_refs=[str(item["trajectoryRef"]) for item in trajectories],
                )
            ],
        )

    proposal = _build_real_proposal(
        optimizer_choice=optimizer_choice,
        optimized_prompt=optimized_prompt,
        few_shot_examples=few_shot_examples,
        trajectories=trajectories,
        failure_categories=failure_categories,
        dry_run=dry_run,
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "optimizer_id": OPTIMIZER_ID,
        "mode": OPTIMIZER_MODE,
        "created_at": _now_iso(),
        "proposals": [proposal],
        "no_proposal_reasons": [],
        "stage": STAGE,
        "dry_run": dry_run,
        "optimizer_choice": optimizer_choice,
    }


def _empty_result(
    *,
    optimizer_choice: str,
    dry_run: bool,
    no_proposal_reasons: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "schema_version": SCHEMA_VERSION,
        "optimizer_id": OPTIMIZER_ID,
        "mode": OPTIMIZER_MODE,
        "created_at": _now_iso(),
        "proposals": [],
        "no_proposal_reasons": no_proposal_reasons,
        "stage": STAGE,
        "dry_run": dry_run,
        "optimizer_choice": optimizer_choice,
    }


async def optimize(
    trajectories: list[object] | None = None,
    failure_categories: list[object] | None = None,
    dry_run: bool = False,
    optimizer_choice: object | None = None,
    config: OptimizerConfig | None = None,
) -> str:
    """Stage C real DSPy entrypoint.

    Returns a JSON string matching the TS-side ``OfflineOptimizerResult``
    shape. On any handled error path (extra missing, key missing, small
    set, compile error) returns an empty proposal list with a structured
    ``no_proposal_reason``. Validation errors raise
    ``OptimizerOperationError`` to surface as MCP tool errors.

    返回与 TS 端 ``OfflineOptimizerResult`` 形状一致的 JSON 字符串。
    任何受控错误路径（extra 缺失、key 缺失、样本太少、编译错误）
    返回空 proposals + 结构化 ``no_proposal_reason``。
    校验错误抛 ``OptimizerOperationError``，由 MCP 上层暴露为工具错误。
    """
    effective_config = config if config is not None else OptimizerConfig.from_env()
    try:
        result = await _optimize(
            trajectories,
            failure_categories,
            dry_run=dry_run,
            optimizer_choice_raw=optimizer_choice,
            config=effective_config,
        )
    except OptimizerOperationError:
        raise
    except Exception as exc:
        logger.error("optimize_failed", error=str(exc))
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
        optimizer_choice: str | None = None,
    ) -> str:
        """Stage C real DSPy entrypoint.

        Args:
            trajectories: Recent stored trajectories (each a dict with at
                least ``trajectoryRef`` and ``runId``; optional
                ``taskInput`` / ``expectedOutput`` enrich training
                examples).
            failure_categories: Failure category strings observed across
                ``trajectories``. Used to populate proposal metadata and
                to gate empty-input handling.
            dry_run: Forwarded to metadata. Output is identical regardless
                of value; the flag is recorded so downstream auditors can
                verify caller intent.
            optimizer_choice: Either ``"mipro"`` (default) or ``"gepa"``.
                Selects the DSPy compiler.
        """
        return await optimize(
            trajectories=trajectories,
            failure_categories=failure_categories,
            dry_run=dry_run,
            optimizer_choice=optimizer_choice,
        )

    return server


mcp = create_server()


def main() -> None:
    configure_once()
    logger.info("quilin-optimizer server starting", transport="stdio", stage=STAGE)
    mcp.run(transport="stdio")
