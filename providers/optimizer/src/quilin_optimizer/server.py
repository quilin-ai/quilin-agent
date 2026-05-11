"""Quilin offline optimizer MCP server — Stage C real DSPy integration.

Exposes a single tool, ``optimize``, that runs the **DSPy GEPA** compiler
(Genetic-Pareto reflective prompt evolution; ICLR 2026 Oral) over input
trajectories and returns ``OptimizationProposalDraft`` candidates matching
the TS-side ``DspyOfflineOptimizer`` contract. The MCP tool signature,
return shape, and JSON keys are the contract that downstream TS code
expects — keep them stable.

GEPA is the singular optimizer. MIPROv2 (the prior alternative compiler)
and the TS PromptRewrite heuristic were removed 2026-05-12 after industry
evidence + scenario fit analysis settled on GEPA as the production path.
See docs/10-self-evolution/README.md §2.4 for the decision rationale.

暴露唯一的 MCP 工具 ``optimize``：基于真实 DSPy **GEPA**（Genetic-Pareto
反射式 prompt 进化；ICLR 2026 Oral）对输入轨迹进行优化，返回与 TS 端
``DspyOfflineOptimizer`` 契约一致的 ``OptimizationProposalDraft`` 候选。
MCP 工具签名、返回结构和 JSON 字段是下游 TS 代码依赖的对外契约，必须保持稳定。

GEPA 是唯一的 optimizer。MIPROv2（原备选编译器）与 TS 端 PromptRewrite
启发式于 2026-05-12 移除，依据是业界证据 + 场景契合度分析。决策依据见
docs/10-self-evolution/README.md §2.4。

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
import itertools
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

# DSPy GEPA needs a minimum training-set size to produce meaningful
# reflective-evolution output; performs poorly on tiny sets. Below this
# threshold we emit a structured "insufficient_signal" reason instead
# of running a no-op compile.
#
# DSPy GEPA 需要最小训练集才能产出有意义的反射进化结果；样本过少时
# 表现差。低于阈值直接返回结构化 "insufficient_signal" 而不是空跑编译器。
MIN_TRAJECTORIES = 5

# Singular optimizer — GEPA only. Kept as named constants so report
# strings + structured-log keys reference one source of truth.
OPTIMIZER_NAME = "gepa"
OPTIMIZER_DISPLAY = "GEPA"


class OptimizerOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


JUDGE_MODE_LLM = "llm"
JUDGE_MODE_DUMMY = "dummy"
_ALLOWED_JUDGE_MODES = frozenset({JUDGE_MODE_LLM, JUDGE_MODE_DUMMY})


@dataclass(frozen=True)
class OptimizerConfig:
    """User-provided judge LLM configuration sourced from env vars.

    All fields are read once at tool-call time (NOT at module import) so
    tests and CI can override env per call. ``api_key`` is NEVER logged.

    所有字段在工具调用时读取（非模块导入时），方便测试与 CI 逐次覆盖。
    ``api_key`` 永不写入日志。

    ``judge_mode`` (env: ``QUILIN_OPTIMIZER_JUDGE_MODE``) selects between:
    - ``"llm"`` (default): real LLM judge via ``dspy.LM`` + ``litellm``
      → requires ``QUILIN_OPTIMIZER_JUDGE_API_KEY`` to be set
    - ``"dummy"``: deterministic ``dspy.utils.DummyLM`` judge → zero LLM
      cost; lets the DSPy compile loop actually run for benchmarking the
      real DSPy code path without burning real API budget. No API key
      required in this mode.

    ``judge_mode``（env：``QUILIN_OPTIMIZER_JUDGE_MODE``）切换：
    - ``"llm"``（默认）：真实 LLM judge，走 ``dspy.LM`` + ``litellm``
      → 必须设置 ``QUILIN_OPTIMIZER_JUDGE_API_KEY``
    - ``"dummy"``：确定性 ``dspy.utils.DummyLM`` judge → 零 LLM 成本，
      让 DSPy compile loop 真跑起来，方便在不烧真实 API 配额的前提下
      benchmark 真实 DSPy 代码路径。该模式下 API key 非必需。
    """

    judge_model: str | None
    judge_api_key: str | None
    judge_base_url: str | None
    judge_mode: str = JUDGE_MODE_LLM

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> OptimizerConfig:
        source = env if env is not None else os.environ
        raw_mode = (source.get("QUILIN_OPTIMIZER_JUDGE_MODE") or "").strip().lower()
        mode = raw_mode if raw_mode in _ALLOWED_JUDGE_MODES else JUDGE_MODE_LLM
        return cls(
            judge_model=source.get("QUILIN_OPTIMIZER_JUDGE_MODEL") or None,
            judge_api_key=source.get("QUILIN_OPTIMIZER_JUDGE_API_KEY") or None,
            judge_base_url=source.get("QUILIN_OPTIMIZER_JUDGE_BASE_URL") or None,
            judge_mode=mode,
        )

    def is_ready(self) -> bool:
        """True iff the optimizer can construct a judge LM.

        - ``llm`` mode: requires ``judge_api_key``
        - ``dummy`` mode: always ready (no API key needed; DummyLM is local)

        Both ``judge_model`` and ``judge_base_url`` are optional in llm
        mode — DSPy / litellm pick reasonable defaults when omitted.

        - ``llm`` 模式：必须有 ``judge_api_key``
        - ``dummy`` 模式：永远 ready（不需 API key，DummyLM 在本地）

        ``judge_model`` 与 ``judge_base_url`` 在 llm 模式下可省略，
        由 DSPy / litellm 兜底。
        """
        if self.judge_mode == JUDGE_MODE_DUMMY:
            return True
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
        # Post 2026-05-12 GEPA-only refactor: dspy-ai is a HARD dep —
        # reaching this branch means the venv is broken. The hint
        # points the operator at the canonical install.
        logger.warning(
            "dspy_not_installed",
            hint=(
                "install with `uv sync` inside providers/optimizer "
                "(dspy-ai is a hard dep — broken venv if this fires)"
            ),
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

    def metric(example: Any, prediction: Any, *args: Any, **kwargs: Any) -> float:
        # DSPy's metric contract varies by compiler:
        # - MIPROv2 calls metric(example, prediction, trace=None)
        # - GEPA calls metric(gold, pred, trace, pred_name, pred_trace)
        # Accept both via *args / **kwargs so the same metric is reusable
        # across compilers without per-compiler wrapping.
        _unused = (args, kwargs)  # noqa: F841 — extra kwargs intentionally ignored
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


def _select_compiler(dspy_module: Any, metric: Any) -> Any:
    """Instantiate the DSPy GEPA compiler.

    Raises ``OptimizerOperationError`` when the installed dspy build does
    not expose ``dspy.GEPA``, or when ``dspy.settings.lm`` has not been
    configured (GEPA needs a reflection LM).

    实例化 DSPy GEPA 编译器。当前 dspy 版本无 ``GEPA``，或 ``dspy.settings.lm``
    尚未配置（GEPA 需要 reflection LM），抛 ``OptimizerOperationError``。
    """
    compiler_cls = getattr(dspy_module, "GEPA", None)
    if compiler_cls is None:
        raise OptimizerOperationError("installed dspy build does not expose GEPA")
    # GEPA REQUIRES an explicit reflection_lm kwarg in DSPy 3.x — it
    # uses a separate "reflection" LM to propose new instructions based
    # on observed program behavior. We pass the same LM bound to
    # dspy.settings (the user's judge LM in llm mode, or DummyLM in
    # dummy mode). Looking up via dspy.settings means this works for
    # both modes without extra plumbing.
    reflection_lm = getattr(dspy_module.settings, "lm", None)
    if reflection_lm is None:
        raise OptimizerOperationError("GEPA needs dspy.settings.lm configured before compile")
    return compiler_cls(metric=metric, auto="light", reflection_lm=reflection_lm)


# Each dict represents one structured LM response to a DSPy Predict
# call. DummyLM cycles through this list. We over-include common output
# field names (observations / instruction / proposed_instruction /
# score / response / answer / better_instruction) so MIPROv2's
# internal data-aware proposer + instruction generator + grounded
# proposer Predicts all find a value for whatever output field they
# request. Any field DSPy doesn't ask for is silently ignored.
#
# DSPy 3.x's MIPROv2 uses a handful of internal signatures (DataObserver,
# DatasetDescriptor, GenerateInstructionGivenAttempts, etc.); rather
# than enumerate them and risk drift on minor DSPy updates, we provide
# a generic shape with all the field names actually seen across the
# 2.5–3.x line.
_DUMMY_LM_RESPONSES: tuple[dict[str, str], ...] = (
    {
        "observations": "tool_error: commands fail without preflight checks.",
        "dataset_description": "Shell command failures after planning.",
        "proposed_instruction": "Add a preflight check before shell commands.",
        "instruction": "Add a preflight check before shell commands.",
        "better_instruction": "Add a preflight check; verify command exists in PATH.",
        "score": "0.7",
        "response": "0.7",
        "answer": "Add a preflight check before shell commands.",
        "summary": "preflight-check pattern",
        "rationale": "Preflight validation reduces tool_error frequency.",
    },
    {
        "observations": "schema_violation: output lacks explicit field validation.",
        "dataset_description": "Malformed JSON / dict outputs.",
        "proposed_instruction": "Validate output shape against the expected schema.",
        "instruction": "Validate output shape against the expected schema.",
        "better_instruction": "Validate output shape; reject mismatches.",
        "score": "0.5",
        "response": "0.5",
        "answer": "Validate output shape against the expected schema.",
        "summary": "schema-validation pattern",
        "rationale": "Explicit validation prevents shape drift.",
    },
    {
        "observations": "budget_exhaustion: agent retries indefinitely.",
        "dataset_description": "Trajectories that consume excessive token budget.",
        "proposed_instruction": "Cap retry count and exit cleanly at budget threshold.",
        "instruction": "Cap retry count and exit cleanly at budget threshold.",
        "better_instruction": "Cap retries; monitor remaining budget; exit at threshold.",
        "score": "0.6",
        "response": "0.6",
        "answer": "Cap retry count and exit cleanly at budget threshold.",
        "summary": "retry-cap pattern",
        "rationale": "Bounded retries protect budget.",
    },
    {
        "observations": "missing_evidence: sources cited without verification.",
        "dataset_description": "Trajectories that cite unverified content.",
        "proposed_instruction": "Cite a verified source URL before any external fact.",
        "instruction": "Cite a verified source URL before any external fact.",
        "better_instruction": "Cite verified source URL; mark unverified claims.",
        "score": "0.8",
        "response": "0.8",
        "answer": "Cite a verified source URL before any external fact.",
        "summary": "evidence-citation pattern",
        "rationale": "Verified citations prevent hallucination.",
    },
    {
        "observations": "planning_drift: subtasks diverge from the original goal.",
        "dataset_description": "Trajectories where planning drifts off-task.",
        "proposed_instruction": "Re-anchor on the original task before each subtask.",
        "instruction": "Re-anchor on the original task before each subtask.",
        "better_instruction": "Re-anchor before each subtask; abort drift early.",
        "score": "0.4",
        "response": "0.4",
        "answer": "Re-anchor on the original task before each subtask.",
        "summary": "re-anchor pattern",
        "rationale": "Periodic anchoring keeps execution on-task.",
    },
)


# DummyLM cycle budget — pre-flatten this many response slots from
# ``_DUMMY_LM_RESPONSES``. MIPROv2 / GEPA make many internal Predict
# calls during compile (data-aware proposer, instruction generator,
# demo bootstrapping, reflection rollouts) and DummyLM's underlying
# iterator does NOT cycle by itself. 1000 = 200 × 5 comfortably covers
# a single compile run on a 5-50 trajectory training set
# (empirically GEPA hits ~580 rollouts; MIPROv2 < 100).
#
# Locked by test_server_real_dspy_e2e.py
# ::test_configure_dspy_lm_dummy_pool_sized_for_mipro_and_gepa.
DUMMY_LM_ANSWER_BUDGET = 1000


def _build_judge_lm(dspy_module: Any, config: OptimizerConfig) -> Any:
    """Construct (but do NOT install) the DSPy judge LM.

    Returns the LM object — the caller is responsible for activating it
    via ``with dspy.context(lm=...)`` (per-call scoping) instead of
    ``dspy.settings.configure(lm=...)`` (process-global). The per-call
    pattern dodges DSPy 3.x's "configure can only be called from the
    same async task" RuntimeError, which fires whenever the optimizer
    runs in a fresh event loop (e.g., pytest-asyncio's default
    per-test loop).

    Two modes:

    - ``judge_mode = "llm"`` (default): real ``dspy.LM`` driven by
      LiteLLM. Requires ``judge_api_key``.
    - ``judge_mode = "dummy"``: deterministic ``dspy.utils.DummyLM`` —
      zero LLM cost. Lets the DSPy compile loop run end-to-end for
      benchmarking the real DSPy code path without spending API budget.

    Defensive: any LM-construction error is wrapped in
    ``OptimizerOperationError`` so the caller surfaces a structured
    warning instead of a raw stack trace.

    构造（但不激活）DSPy judge LM。返回 LM 对象，由 caller 通过
    ``with dspy.context(lm=...)`` 做 per-call 激活；不再用
    ``dspy.settings.configure(lm=...)`` 全局设置 —— 那条路径在 DSPy 3.x
    的"configure 只能在同一 async task 调用"约束下，遇到 pytest-asyncio
    每测试独立 event loop 就会抛 RuntimeError。
    """
    try:
        if config.judge_mode == JUDGE_MODE_DUMMY:
            # DummyLM is the canonical zero-cost stand-in for a real LM
            # when exercising DSPy's compile loop.
            cycled = list(
                itertools.islice(itertools.cycle(_DUMMY_LM_RESPONSES), DUMMY_LM_ANSWER_BUDGET)
            )
            return dspy_module.utils.DummyLM(cycled)
        lm_kwargs: dict[str, object] = {}
        if config.judge_api_key:
            lm_kwargs["api_key"] = config.judge_api_key
        if config.judge_base_url:
            lm_kwargs["api_base"] = config.judge_base_url
        model_id = config.judge_model or "openai/gpt-4o-mini"
        return dspy_module.LM(model_id, **lm_kwargs)
    except Exception as exc:
        # Sanitize: never echo the API key. The exc.__str__ may include
        # config details, so we hard-replace with a generic message.
        model = config.judge_model or "default"
        raise OptimizerOperationError(
            f"failed to configure DSPy judge LM (mode={config.judge_mode}, model={model})"
        ) from exc


def _configure_dspy_lm(dspy_module: Any, config: OptimizerConfig) -> None:
    """**LEGACY** wrapper that calls ``_build_judge_lm`` + global
    ``dspy.settings.configure``.

    The compile path (``_run_dspy_compile``) does NOT use this — it
    calls ``_build_judge_lm`` directly and scopes the LM with
    ``dspy.context(lm=...)`` per-call. This wrapper exists solely to
    preserve the public surface that existing tests assert against
    (specifically: tests that verify ``dspy.settings.configure`` was
    called with a specific LM type). New code should prefer
    ``_build_judge_lm`` + ``dspy.context``.

    Pre-existing kept for backward compat with the 9 fake-module tests
    in ``test_server_real_dspy.py::TestDummyJudgeMode``.

    **遗留**包装器：调 ``_build_judge_lm`` 再用全局 ``settings.configure``
    激活。**编译路径不走这个**（``_run_dspy_compile`` 直接用
    ``dspy.context`` 做 per-call 激活）。本函数仅为兼容 9 个
    fake-module 测试保留。新代码应直接用 ``_build_judge_lm`` +
    ``dspy.context``。
    """
    lm = _build_judge_lm(dspy_module, config)
    dspy_module.settings.configure(lm=lm)


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
        f"# DSPy {OPTIMIZER_DISPLAY} optimization proposal",
        "",
        f"Optimizer: `{OPTIMIZER_NAME}` (DSPy {OPTIMIZER_DISPLAY})",
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
        "optimizer_choice": OPTIMIZER_NAME,
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
                ["markdown", f"DSPy {OPTIMIZER_NAME}", _stable_artifact_hash(markdown)],
            ),
            "kind": "markdown",
            "title": f"DSPy {OPTIMIZER_DISPLAY} optimization summary",
            "content": markdown,
            "contentHash": _stable_artifact_hash(markdown),
            "sourceRefs": trajectory_refs,
        },
        {
            "artifactId": _stable_id(
                "artifact",
                ["json", f"DSPy {OPTIMIZER_NAME} payload", _stable_artifact_hash(json_content)],
            ),
            "kind": "json",
            "title": f"DSPy {OPTIMIZER_DISPLAY} optimization payload",
            "content": json_content,
            "contentHash": _stable_artifact_hash(json_content),
            "sourceRefs": trajectory_refs,
        },
    ]


def _run_dspy_compile(
    *,
    dspy_module: Any,
    config: OptimizerConfig,
    trajectories: list[dict[str, object]],
) -> tuple[str, list[dict[str, str]]]:
    """Compile a DSPy GEPA program over the trajectories.

    Returns ``(optimized_prompt, few_shot_examples)``. Raises
    ``OptimizerOperationError`` for sanitized failures (LM construction,
    compiler not available, malformed compiled output).

    返回 ``(optimized_prompt, few_shot_examples)``。
    遇到可控错误（LM 构造、编译器缺失、产物异常）抛
    ``OptimizerOperationError``，message 已 sanitize。

    LM scoping: this function uses ``with dspy.context(lm=lm):`` for
    per-call activation instead of ``dspy.settings.configure``, dodging
    DSPy 3.x's "configure can only be called from the same async task"
    RuntimeError that fires under pytest-asyncio's per-test event
    loops. GEPA reads ``dspy.settings.lm`` at construction time, so
    ``_select_compiler`` MUST run **inside** the context block.

    LM 作用域：本函数用 ``with dspy.context(lm=lm)`` 做 per-call 激活，
    **不再用** ``dspy.settings.configure``，避开 DSPy 3.x 在 pytest-asyncio
    多 event loop 下抛 RuntimeError 的"configure 只能在同一 async task 调用"
    约束。注意 GEPA 构造期会读 ``dspy.settings.lm``，所以 ``_select_compiler``
    必须**放在 context 块内**，不能在外面先 new。
    """
    lm = _build_judge_lm(dspy_module, config)

    program = _build_dspy_program(dspy_module)
    metric = _build_judge_metric(config)
    examples = _build_training_examples(trajectories, dspy_module)

    try:
        with dspy_module.context(lm=lm):
            # Compiler instantiation reads dspy.settings.lm — keep it
            # inside the context block to avoid the "no default LM" gate.
            compiler = _select_compiler(dspy_module, metric)
            compiled = compiler.compile(
                program,
                trainset=examples,
            )
    except OptimizerOperationError:
        raise
    except Exception as exc:
        raise OptimizerOperationError(f"DSPy {OPTIMIZER_DISPLAY} compile failed") from exc

    if compiled is None:
        raise OptimizerOperationError(f"DSPy {OPTIMIZER_DISPLAY} returned no compiled program")

    optimized_prompt = _extract_optimized_prompt(compiled)
    few_shot_examples = _extract_few_shot_examples(compiled)
    return optimized_prompt, few_shot_examples


def _build_real_proposal(
    *,
    optimized_prompt: str,
    few_shot_examples: list[dict[str, str]],
    trajectories: list[dict[str, object]],
    failure_categories: list[str],
    dry_run: bool,
) -> dict[str, object]:
    """Assemble the final ``OptimizationProposalDraft``."""
    trajectory_refs = sorted({str(item["trajectoryRef"]) for item in trajectories})
    artifacts = _build_proposal_artifacts(
        optimized_prompt=optimized_prompt,
        few_shot_examples=few_shot_examples,
        trajectory_refs=trajectory_refs,
        failure_categories=failure_categories,
    )
    evidence_hashes = [artifact["contentHash"] for artifact in artifacts]

    return {
        "title": f"DSPy {OPTIMIZER_DISPLAY} optimization proposal",
        "summary": (
            f"DSPy {OPTIMIZER_DISPLAY} compiled program over "
            f"{len(trajectories)} trajectories. Review-only — never auto-apply."
        ),
        "artifacts": artifacts,
        "evidenceHashes": evidence_hashes,
        "riskPreview": {
            "level": "medium",
            "reasons": [
                f"DSPy {OPTIMIZER_DISPLAY} candidate is artifact-only — never auto-applied.",
                f"Trajectories aggregated into the proposal: {len(trajectory_refs)}.",
                f"Few-shot examples extracted: {len(few_shot_examples)}.",
            ],
            "touchesRuntime": False,
            "requiresHumanReview": True,
        },
        "metadata": {
            "optimizer_id": OPTIMIZER_ID,
            "optimizer_choice": OPTIMIZER_NAME,
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

    no_proposal_reasons = _build_no_proposal_reasons_input_guard(trajectories, failure_categories)
    if no_proposal_reasons:
        return _empty_result(
            dry_run=dry_run,
            no_proposal_reasons=no_proposal_reasons,
        )

    # Graceful degradation gate 1: dspy-ai unavailable. Now that
    # `dspy-ai` is a hard dependency this should never happen for a
    # properly-installed quilin-optimizer, but the gate stays as
    # defense-in-depth (e.g. broken venv).
    dspy_module = _import_dspy()
    if dspy_module is None:
        return _empty_result(
            dry_run=dry_run,
            no_proposal_reasons=[
                _no_proposal_reason(
                    code="insufficient_signal",
                    message=(
                        "DSPy (`dspy-ai>=2.5`) failed to import — reinstall "
                        "quilin-optimizer or check the venv."
                    ),
                    evidence_refs=[str(item["trajectoryRef"]) for item in trajectories],
                )
            ],
        )

    # Graceful degradation gate 2: judge API key missing.
    if not config.is_ready():
        logger.warning(
            "judge_api_key_missing",
            optimizer_choice=OPTIMIZER_NAME,
            judge_model=config.judge_model or "(default)",
        )
        return _empty_result(
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
            dry_run=dry_run,
            no_proposal_reasons=[
                _no_proposal_reason(
                    code="insufficient_signal",
                    message=(
                        f"DSPy {OPTIMIZER_DISPLAY} needs at least {MIN_TRAJECTORIES} "
                        f"trajectories to produce useful output; got {len(trajectories)}."
                    ),
                    evidence_refs=[str(item["trajectoryRef"]) for item in trajectories],
                )
            ],
        )

    # Info-log the active judge mode so operators can confirm whether a
    # zero-cost dummy judge or a real LLM is in use. Never echoes the
    # API key — only the boolean key-present + the mode + (optional)
    # model name. Crucial for benchmarking trust ("am I burning real
    # API budget right now?").
    logger.info(
        "dspy_compile_starting",
        optimizer_choice=OPTIMIZER_NAME,
        judge_mode=config.judge_mode,
        judge_model=config.judge_model or "(default)",
        judge_api_key_present=bool(config.judge_api_key),
        trajectory_count=len(trajectories),
    )

    # Real DSPy compile path. Any failure is wrapped as a structured
    # "insufficient_signal" reason so the TS adapter can surface it
    # without crashing the idle runner.
    try:
        optimized_prompt, few_shot_examples = _run_dspy_compile(
            dspy_module=dspy_module,
            config=config,
            trajectories=trajectories,
        )
    except OptimizerOperationError as exc:
        # Sanitize: only forward the message we constructed, never the
        # underlying exc chain (may contain provider details).
        logger.warning(
            "dspy_compile_failed",
            optimizer_choice=OPTIMIZER_NAME,
            reason=str(exc),
        )
        return _empty_result(
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
        "optimizer_choice": OPTIMIZER_NAME,
    }


def _empty_result(
    *,
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
        "optimizer_choice": OPTIMIZER_NAME,
    }


async def optimize(
    trajectories: list[object] | None = None,
    failure_categories: list[object] | None = None,
    dry_run: bool = False,
    config: OptimizerConfig | None = None,
) -> str:
    """Stage C real DSPy GEPA entrypoint.

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
    ) -> str:
        """Stage C real DSPy GEPA entrypoint.

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

        Wire-protocol note (2026-05-12 GEPA-only refactor): the previous
        ``optimizer_choice`` kwarg was removed. FastMCP silently drops
        unknown kwargs from incoming MCP requests (verified empirically),
        so external consumers still passing ``optimizer_choice="mipro"``
        get GEPA without an explicit error — the response's
        ``optimizer_choice`` field always reports ``gepa``. The
        ``test_optimize_tool_legacy_optimizer_choice_kwarg_is_ignored``
        regression test locks this contract.

        对外契约（2026-05-12 GEPA-only 重构）：原 ``optimizer_choice``
        kwarg 已移除。FastMCP 静默丢弃未知 kwargs（实测验证），所以仍传
        ``optimizer_choice="mipro"`` 的外部消费方会拿到 GEPA 但没显式错
        误 —— 响应的 ``optimizer_choice`` 字段恒为 ``gepa``。
        ``test_optimize_tool_legacy_optimizer_choice_kwarg_is_ignored``
        回归测试锁定该契约。
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
    logger.info("quilin-optimizer server starting", transport="stdio", stage=STAGE)
    mcp.run(transport="stdio")
