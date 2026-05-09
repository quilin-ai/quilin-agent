"""Quilin offline optimizer MCP server — Stage A+B placeholder.

This package exposes a single MCP tool, ``optimize``, that returns a
deterministic stub matching the TS-side ``DspyOfflineOptimizer`` contract.
Stage C will swap the placeholder body for a real DSPy/GEPA optimization
loop without changing the tool surface.

本包暴露唯一的 MCP 工具 ``optimize``，返回与 TS 端 ``DspyOfflineOptimizer``
契约一致的占位结果。Stage C 将在保持工具签名不变的前提下，把占位逻辑
替换为真实的 DSPy/GEPA 优化循环。
"""

from .server import OPTIMIZER_ID, SCHEMA_VERSION, create_server, main, optimize

__all__ = [
    "OPTIMIZER_ID",
    "SCHEMA_VERSION",
    "create_server",
    "main",
    "optimize",
]
__version__ = "0.0.1"
