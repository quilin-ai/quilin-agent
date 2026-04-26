#!/usr/bin/env python3
"""Run the pinned BFCL v4 multi-turn checker over a decoded trajectory."""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        checker_root = os.environ.get("BFCL_CHECKER_ROOT")
        if not checker_root:
            raise ValueError("BFCL_CHECKER_ROOT is required")
        sys.path.insert(0, checker_root)

        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import (
            multi_turn_checker,
            multi_turn_irrelevance_checker,
        )

        task = _require_dict(payload.get("task"), "task")
        expected = _require_dict(task.get("expected"), "task.expected")
        metadata = _require_dict(task.get("metadata", {}), "task.metadata")
        trajectory = payload.get("model_output_trajectory")
        category = str(metadata.get("category") or expected.get("category") or "")
        decoded = _decode_trajectory(trajectory)
        possible_answer = _require_list(
            expected.get("possible_answer"), "task.expected.possible_answer"
        )
        test_entry = {
            "id": task.get("task_id"),
            "initial_config": _require_dict(
                expected.get("initial_config"), "task.expected.initial_config"
            ),
            "involved_classes": _require_list(
                expected.get("involved_classes"), "task.expected.involved_classes"
            ),
        }

        result = multi_turn_checker(
            decoded,
            possible_answer,
            test_entry,
            category,
            "quilin_fixture",
        )
        if result.get("valid"):
            irrelevance = multi_turn_irrelevance_checker(decoded, possible_answer)
            if not irrelevance.get("valid"):
                result = irrelevance

        output = {
            "valid": bool(result.get("valid")),
            "score": 1 if result.get("valid") else 0,
            "breakdown": result,
        }
        sys.stdout.write(json.dumps(output, sort_keys=True))
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI wrapper returns structured error.
        sys.stdout.write(
            json.dumps(
                {
                    "valid": False,
                    "score": 0,
                    "breakdown": {
                        "error_message": str(exc),
                        "error_type": "quilin_checker_adapter_error",
                    },
                },
                sort_keys=True,
            )
        )
        sys.stdout.write("\n")
        return 0


def _decode_trajectory(value: Any) -> list[list[list[str]]]:
    turns = _require_list(value, "model_output_trajectory")
    decoded: list[list[list[str]]] = []
    for turn in turns:
        steps = _require_list(turn, "trajectory turn")
        decoded_steps: list[list[str]] = []
        for step in steps:
            if isinstance(step, str):
                continue
            if _is_call_string_list(step):
                decoded_steps.append(list(step))
                continue
            if isinstance(step, list):
                decoded_steps.append(_decode_step_calls(step))
                continue
            if isinstance(step, dict):
                decoded_steps.append(_decode_step_calls([step]))
                continue
            raise ValueError(f"Unsupported trajectory step: {type(step).__name__}")
        decoded.append(decoded_steps)
    return decoded


def _decode_step_calls(step: list[Any]) -> list[str]:
    calls: list[str] = []
    for entry in step:
        if isinstance(entry, str):
            calls.append(entry)
            continue
        if not isinstance(entry, dict):
            raise ValueError(f"Unsupported tool call entry: {type(entry).__name__}")
        for function_name, raw_arguments in entry.items():
            calls.append(_format_call(str(function_name), raw_arguments))
    return calls


def _format_call(function_name: str, raw_arguments: Any) -> str:
    if isinstance(raw_arguments, str):
        try:
            raw_arguments = json.loads(raw_arguments)
        except json.JSONDecodeError:
            return f"{function_name}({raw_arguments})"
    if not isinstance(raw_arguments, dict):
        return f"{function_name}()"
    args = ", ".join(
        f"{key}={repr(value)}" for key, value in sorted(raw_arguments.items())
    )
    return f"{function_name}({args})"


def _is_call_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(entry, str) for entry in value)


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a list")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
