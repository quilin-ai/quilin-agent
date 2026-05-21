#!/usr/bin/env bash
# quilin-daemon control script — start / stop / status.
#
# justfile recipes 的 `\\` 续行 + `$$` escape 在 just shell wrap 下不稳,
# 单独 shell script 更可靠。被 justfile 的 `daemon-start/stop/status` 调用。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="/tmp/quilin-daemon.pid"
LOG_FILE="/tmp/quilin-daemon.log"

cmd_start() {
    if [ -f "$PID_FILE" ]; then
        local existing_pid
        existing_pid="$(cat "$PID_FILE" 2>/dev/null || echo)"
        if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
            echo "quilin-daemon already running (PID $existing_pid)"
            exit 1
        fi
    fi
    cd "$REPO_ROOT/providers/memory"
    QUILIN_DAEMON_ENABLED=true QUILIN_ENV=dev \
        nohup uv run python -m quilin_mem.daemon_main > "$LOG_FILE" 2>&1 &
    local new_pid=$!
    echo "$new_pid" > "$PID_FILE"
    sleep 1
    echo "quilin-daemon started (PID $new_pid) — log: $LOG_FILE"
}

cmd_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "no $PID_FILE — daemon not running?"
        exit 0
    fi
    local pid
    pid="$(cat "$PID_FILE")"
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "PID $pid not alive"
        rm -f "$PID_FILE"
        exit 0
    fi
    kill -TERM "$pid"
    echo "SIGTERM to PID $pid, wait up to 10s..."
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        sleep 1
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "stopped"
            rm -f "$PID_FILE"
            exit 0
        fi
    done
    echo "still alive, SIGKILL"
    kill -KILL "$pid"
    rm -f "$PID_FILE"
}

cmd_status() {
    if [ ! -f "$PID_FILE" ]; then
        echo "quilin-daemon NOT running (no $PID_FILE)"
        exit 0
    fi
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
        echo "quilin-daemon RUNNING (PID $pid)"
        echo "log: $LOG_FILE"
        if [ -f "$LOG_FILE" ]; then
            echo "--- last 5 log lines ---"
            tail -5 "$LOG_FILE"
        fi
    else
        echo "quilin-daemon NOT running (stale PID $pid in $PID_FILE)"
        rm -f "$PID_FILE"
    fi
}

case "${1:-}" in
    start)  cmd_start ;;
    stop)   cmd_stop ;;
    status) cmd_status ;;
    *)
        echo "usage: $0 {start|stop|status}" >&2
        exit 2
        ;;
esac
