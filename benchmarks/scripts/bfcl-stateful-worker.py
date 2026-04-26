#!/usr/bin/env python3
"""Long-session BFCL v4 multi-turn backend worker.

The worker is intentionally small: it owns one task's BFCL backend objects,
accepts JSONL command envelopes on stdin, and returns JSONL responses on stdout.
It does not query models and it does not evaluate arbitrary Python call strings.
"""

from __future__ import annotations

import copy
import importlib
import json
import os
import re
import sys
import traceback
from collections.abc import Mapping
from typing import Any


SUPPORTED_BACKEND_CLASSES = {
    "GorillaFileSystem",
    "MathAPI",
    "MessageAPI",
    "TwitterAPI",
    "TicketAPI",
    "TradingBot",
    "TravelAPI",
    "VehicleControlAPI",
}

UNSUPPORTED_BACKEND_CLASSES = {
    "WebSearchAPI",
    "MemoryAPI_kv",
    "MemoryAPI_vector",
    "MemoryAPI_rec_sum",
}

FORBIDDEN_METHOD_NAMES = {
    "kill",
    "exit",
    "quit",
    "remove",
    "unlink",
    "popen",
    "Popen",
    "run",
}

ERROR_BACKEND_CLASS_NOT_FOUND = "backend_class_not_found"
ERROR_TOOL_METHOD_NOT_FOUND = "tool_method_not_found"
ERROR_TOOL_ARGS_INVALID = "tool_args_invalid"
ERROR_TOOL_RUNTIME = "tool_runtime_error"
ERROR_EVAL_SECURITY = "eval_security_violation"

IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PROTOCOL_VERSION = 1
MAX_SNAPSHOT_DEPTH = 6
MAX_SNAPSHOT_ITEMS = 128


class WorkerError(Exception):
    def __init__(
        self,
        error_type: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.details = dict(details or {})


class BfclStatefulWorker:
    def __init__(self) -> None:
        self.task_id: str | None = None
        self.instances: dict[str, Any] = {}
        self.method_to_class: dict[str, str] = {}
        self.initialized = False

    def init_task(self, command: Mapping[str, Any]) -> dict[str, Any]:
        task_id = require_string(command.get("task_id"), "task_id")
        involved_classes = require_string_list(
            command.get("involved_classes"), "involved_classes"
        )
        initial_config = require_mapping(
            command.get("initial_config", {}), "initial_config"
        )
        long_context = bool(command.get("long_context", False))

        self.instances = {}
        self.method_to_class = {}
        self.task_id = task_id
        for class_name in involved_classes:
            self.instances[class_name] = self._create_instance(
                class_name, initial_config, long_context
            )
        self._refresh_method_mapping()
        self.initialized = True
        return {
            "type": "ready",
            "task_id": task_id,
            "classes": sorted(self.instances.keys()),
            "protocol_version": PROTOCOL_VERSION,
        }

    def call_tool(self, command: Mapping[str, Any]) -> dict[str, Any]:
        self._require_initialized()
        call = require_mapping(command.get("call"), "call")
        function_name = require_string(call.get("function"), "call.function")
        arguments = require_mapping(call.get("arguments", {}), "call.arguments")
        class_name, method_name = self._resolve_method(function_name)
        instance = self.instances[class_name]
        method = getattr(instance, method_name)
        try:
            value = method(**dict(arguments))
        except TypeError as exc:
            raise WorkerError(
                ERROR_TOOL_ARGS_INVALID,
                str(exc),
                details={"class": class_name, "method": method_name},
            ) from exc
        except Exception as exc:  # noqa: BLE001 - backend tool errors are data.
            raise WorkerError(
                ERROR_TOOL_RUNTIME,
                str(exc),
                details={"class": class_name, "method": method_name},
            ) from exc
        return {
            "type": "result",
            "class": class_name,
            "function": method_name,
            "return_value": to_json_safe(value),
            "state_snapshot": self.snapshot()["state"],
        }

    def snapshot(self) -> dict[str, Any]:
        self._require_initialized()
        return {
            "type": "snapshot",
            "task_id": self.task_id,
            "state": {
                class_name: to_json_safe(instance)
                for class_name, instance in sorted(self.instances.items())
            },
        }

    def close(self) -> dict[str, Any]:
        self.instances = {}
        self.method_to_class = {}
        self.task_id = None
        self.initialized = False
        return {"type": "closed"}

    def _create_instance(
        self,
        class_name: str,
        initial_config: Mapping[str, Any],
        long_context: bool,
    ) -> Any:
        if class_name in UNSUPPORTED_BACKEND_CLASSES:
            raise WorkerError(
                ERROR_BACKEND_CLASS_NOT_FOUND,
                f"{class_name} is outside E3c1b1 scope",
                details={"class": class_name},
            )
        if class_name not in SUPPORTED_BACKEND_CLASSES:
            raise WorkerError(
                ERROR_BACKEND_CLASS_NOT_FOUND,
                f"Unsupported BFCL backend class: {class_name}",
                details={"class": class_name},
            )

        config = load_executable_backend_config()
        class_mapping = getattr(config, "CLASS_FILE_PATH_MAPPING", {})
        stateless_classes = set(getattr(config, "STATELESS_CLASSES", []))
        module_name = class_mapping.get(class_name)
        if not isinstance(module_name, str):
            raise WorkerError(
                ERROR_BACKEND_CLASS_NOT_FOUND,
                f"BFCL backend mapping missing for {class_name}",
                details={"class": class_name},
            )

        try:
            module = importlib.import_module(module_name)
            class_ = getattr(module, class_name)
            instance = class_()
        except Exception as exc:  # noqa: BLE001 - import failures are setup errors.
            raise WorkerError(
                ERROR_BACKEND_CLASS_NOT_FOUND,
                f"Failed to import BFCL backend class {class_name}: {exc}",
                details={"class": class_name, "module": module_name},
            ) from exc

        if class_name not in stateless_classes:
            scenario = copy.deepcopy(initial_config.get(class_name, {}))
            load_scenario = getattr(instance, "_load_scenario", None)
            if not callable(load_scenario):
                raise WorkerError(
                    ERROR_BACKEND_CLASS_NOT_FOUND,
                    f"BFCL backend class {class_name} has no _load_scenario",
                    details={"class": class_name},
                )
            try:
                load_scenario(scenario, long_context=long_context)
            except TypeError:
                load_scenario(scenario)
            except Exception as exc:  # noqa: BLE001 - setup failures are class errors.
                raise WorkerError(
                    ERROR_BACKEND_CLASS_NOT_FOUND,
                    f"Failed to initialize BFCL backend class {class_name}: {exc}",
                    details={"class": class_name},
                ) from exc
        return instance

    def _refresh_method_mapping(self) -> None:
        self.method_to_class = {}
        for class_name, instance in self.instances.items():
            for method_name in dir(instance):
                if method_name.startswith("_"):
                    continue
                attr = getattr(instance, method_name)
                if callable(attr):
                    self.method_to_class.setdefault(method_name, class_name)

    def _resolve_method(self, function_name: str) -> tuple[str, str]:
        class_name: str | None = None
        method_name = function_name
        if "." in function_name:
            parts = function_name.split(".")
            if len(parts) != 2:
                raise WorkerError(
                    ERROR_EVAL_SECURITY,
                    f"Invalid tool function path: {function_name}",
                )
            class_name, method_name = parts

        validate_identifier(method_name, "method")
        if method_name in FORBIDDEN_METHOD_NAMES:
            raise WorkerError(
                ERROR_EVAL_SECURITY,
                f"Method {method_name} is blocked by the BFCL worker policy",
            )

        if class_name is not None:
            validate_identifier(class_name, "class")
            if class_name not in self.instances:
                raise WorkerError(
                    ERROR_BACKEND_CLASS_NOT_FOUND,
                    f"Backend class is not active for this task: {class_name}",
                    details={"class": class_name},
                )
            if not callable(getattr(self.instances[class_name], method_name, None)):
                raise WorkerError(
                    ERROR_TOOL_METHOD_NOT_FOUND,
                    f"Tool method not found: {function_name}",
                    details={"class": class_name, "method": method_name},
                )
            return class_name, method_name

        owner = self.method_to_class.get(method_name)
        if owner is None:
            raise WorkerError(
                ERROR_TOOL_METHOD_NOT_FOUND,
                f"Tool method not found: {method_name}",
                details={"method": method_name},
            )
        return owner, method_name

    def _require_initialized(self) -> None:
        if not self.initialized:
            raise WorkerError(
                ERROR_TOOL_RUNTIME,
                "BFCL worker has not received init_task",
            )


def main() -> int:
    configure_python_path()
    worker = BfclStatefulWorker()
    write_message(
        {
            "type": "ready",
            "protocol_version": PROTOCOL_VERSION,
            "supported_classes": sorted(SUPPORTED_BACKEND_CLASSES),
        }
    )

    for line in sys.stdin:
        if line.strip() == "":
            continue
        keep_running = handle_line(worker, line)
        if not keep_running:
            return 0
    return 0


def handle_line(worker: BfclStatefulWorker, line: str) -> bool:
    command_id: Any = None
    try:
        command = json.loads(line)
        if not isinstance(command, dict):
            raise WorkerError(ERROR_TOOL_ARGS_INVALID, "Command must be an object")
        command_id = command.get("id")
        command_type = require_string(command.get("type"), "type")
        if command_type == "init_task":
            response = worker.init_task(command)
        elif command_type == "call_tool":
            response = worker.call_tool(command)
        elif command_type == "snapshot":
            response = worker.snapshot()
        elif command_type == "close":
            response = worker.close()
        else:
            raise WorkerError(
                ERROR_TOOL_ARGS_INVALID,
                f"Unsupported command type: {command_type}",
            )
        if command_id is not None:
            response["id"] = command_id
        write_message(response)
        return command_type != "close"
    except WorkerError as exc:
        write_error(command_id, exc.error_type, str(exc), exc.details)
    except Exception as exc:  # noqa: BLE001 - keep worker protocol structured.
        write_error(
            command_id,
            ERROR_TOOL_RUNTIME,
            str(exc),
            {"traceback": traceback.format_exc(limit=5)},
        )
    return True


def configure_python_path() -> None:
    checker_root = os.environ.get("BFCL_CHECKER_ROOT")
    if not checker_root:
        raise SystemExit("BFCL_CHECKER_ROOT is required")
    sys.path.insert(0, checker_root)
    mpmath_wheel = os.path.join(
        checker_root, "vendor", "mpmath-1.4.1-py3-none-any.whl"
    )
    if os.path.exists(mpmath_wheel):
        sys.path.insert(0, mpmath_wheel)


def load_executable_backend_config() -> Any:
    return importlib.import_module("bfcl_eval.constants.executable_backend_config")


def require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError(ERROR_TOOL_ARGS_INVALID, f"{label} must be an object")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise WorkerError(ERROR_TOOL_ARGS_INVALID, f"{label} must be a string")
    return value


def require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise WorkerError(ERROR_TOOL_ARGS_INVALID, f"{label} must be a string list")
    return list(value)


def validate_identifier(value: str, label: str) -> None:
    if not IDENTIFIER_RE.match(value) or value.startswith("_"):
        raise WorkerError(
            ERROR_EVAL_SECURITY,
            f"Invalid {label} identifier: {value}",
            details={label: value},
        )


def to_json_safe(
    value: Any,
    *,
    depth: int = MAX_SNAPSHOT_DEPTH,
    seen: set[int] | None = None,
) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if depth <= 0:
        return repr(value)
    seen = seen or set()
    value_id = id(value)
    if value_id in seen:
        return {"$ref": type(value).__name__}
    seen.add(value_id)
    if isinstance(value, (list, tuple, set)):
        return [
            to_json_safe(item, depth=depth - 1, seen=seen)
            for item in list(value)[:MAX_SNAPSHOT_ITEMS]
        ]
    if isinstance(value, dict):
        return {
            str(key): to_json_safe(item, depth=depth - 1, seen=seen)
            for key, item in list(value.items())[:MAX_SNAPSHOT_ITEMS]
        }
    if hasattr(value, "__dict__"):
        return {
            "class": type(value).__name__,
            "state": {
                key: to_json_safe(item, depth=depth - 1, seen=seen)
                for key, item in list(vars(value).items())[:MAX_SNAPSHOT_ITEMS]
                if not callable(item) and not key.startswith("__")
            },
        }
    return repr(value)


def write_message(message: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, sort_keys=True, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def write_error(
    command_id: Any,
    error_type: str,
    message: str,
    details: Mapping[str, Any] | None = None,
) -> None:
    response: dict[str, Any] = {
        "type": "error",
        "error_type": error_type,
        "message": message,
    }
    if command_id is not None:
        response["id"] = command_id
    if details:
        response["details"] = dict(details)
    write_message(response)


if __name__ == "__main__":
    raise SystemExit(main())
