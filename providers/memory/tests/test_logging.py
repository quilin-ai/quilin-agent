from __future__ import annotations

from quilin_mem import logging as logging_module


def test_configure_once_returns_when_structlog_already_configured(monkeypatch) -> None:
    configure_calls: list[dict[str, object]] = []

    monkeypatch.setattr(logging_module.structlog, "is_configured", lambda: True)
    monkeypatch.setattr(
        logging_module.structlog,
        "configure",
        lambda **kwargs: configure_calls.append(kwargs),
    )

    logging_module.configure_once()

    assert configure_calls == []


def test_configure_once_installs_json_stderr_logger(monkeypatch) -> None:
    configure_calls: list[dict[str, object]] = []

    monkeypatch.setattr(logging_module.structlog, "is_configured", lambda: False)
    monkeypatch.setattr(
        logging_module.structlog,
        "configure",
        lambda **kwargs: configure_calls.append(kwargs),
    )

    logging_module.configure_once()

    assert len(configure_calls) == 1
    config = configure_calls[0]
    assert config["context_class"] is dict
    assert config["wrapper_class"] is logging_module.structlog.BoundLogger
    assert len(config["processors"]) == 3
