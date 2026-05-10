"""Quilin offline optimizer MCP server — Stage C real DSPy integration.

This package exposes a single MCP tool, ``optimize``, that runs a real
DSPy compiler (``MIPROv2`` or ``GEPA``) over input trajectories. ``dspy-ai``
is opt-in via the ``dspy`` extra; the server falls back to structured
"DSPy unavailable" warnings when the extra is missing rather than crashing.

本包暴露唯一的 MCP 工具 ``optimize``：在输入轨迹上跑真实 DSPy 编译器
（``MIPROv2`` 或 ``GEPA``）。``dspy-ai`` 通过 ``dspy`` extra 选装；
extra 缺失时返回结构化"DSPy unavailable"告警，不会让 server 崩溃。
"""

from .server import (
    DEFAULT_OPTIMIZER_CHOICE,
    JUDGE_MODE_DUMMY,
    JUDGE_MODE_LLM,
    MIN_TRAJECTORIES,
    OPTIMIZER_ID,
    SCHEMA_VERSION,
    SUPPORTED_OPTIMIZER_CHOICES,
    OptimizerConfig,
    OptimizerOperationError,
    create_server,
    main,
    optimize,
)

__all__ = [
    "DEFAULT_OPTIMIZER_CHOICE",
    "JUDGE_MODE_DUMMY",
    "JUDGE_MODE_LLM",
    "MIN_TRAJECTORIES",
    "OPTIMIZER_ID",
    "SCHEMA_VERSION",
    "SUPPORTED_OPTIMIZER_CHOICES",
    "OptimizerConfig",
    "OptimizerOperationError",
    "create_server",
    "main",
    "optimize",
]
__version__ = "0.0.2"
