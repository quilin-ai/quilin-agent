"""Quilin offline optimizer MCP server — Stage C real DSPy integration.

This package exposes a single MCP tool, ``optimize``, that runs the
**DSPy GEPA** compiler (Genetic-Pareto reflective prompt evolution; ICLR
2026 Oral) over input trajectories. ``dspy-ai`` is a hard dependency
required at install time. MIPROv2 (the prior alternative compiler) and
the TS PromptRewrite heuristic were removed 2026-05-12 — see
docs/10-self-evolution/README.md §2.4 for the decision rationale.

本包暴露唯一的 MCP 工具 ``optimize``：在输入轨迹上跑真实 DSPy **GEPA**
编译器（Genetic-Pareto 反射式 prompt 进化；ICLR 2026 Oral）。
``dspy-ai`` 是装包时的硬依赖。MIPROv2（原备选编译器）与 TS 端 PromptRewrite
启发式于 2026-05-12 移除，决策依据见 docs/10-self-evolution/README.md §2.4。
"""

from .server import (
    JUDGE_MODE_DUMMY,
    JUDGE_MODE_LLM,
    MIN_TRAJECTORIES,
    OPTIMIZER_DISPLAY,
    OPTIMIZER_ID,
    OPTIMIZER_NAME,
    SCHEMA_VERSION,
    OptimizerConfig,
    OptimizerOperationError,
    create_server,
    main,
    optimize,
)

__all__ = [
    "JUDGE_MODE_DUMMY",
    "JUDGE_MODE_LLM",
    "MIN_TRAJECTORIES",
    "OPTIMIZER_DISPLAY",
    "OPTIMIZER_ID",
    "OPTIMIZER_NAME",
    "SCHEMA_VERSION",
    "OptimizerConfig",
    "OptimizerOperationError",
    "create_server",
    "main",
    "optimize",
]
__version__ = "0.0.2"
