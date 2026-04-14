#!/usr/bin/env bash
# =============================================================================
# Quilin Agent — Cron 自动同步配置脚本
# =============================================================================
# 配置 crontab 使 sync-upstreams.py 每 5 分钟自动运行
#
# 用法：
#   bash scripts/setup-cron.sh          # 安装 cron 任务
#   bash scripts/setup-cron.sh --remove # 移除 cron 任务
#   bash scripts/setup-cron.sh --status # 查看当前状态
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SYNC_SCRIPT="$ROOT_DIR/scripts/sync-upstreams.py"
LOG_FILE="$ROOT_DIR/.logs/cron-sync.log"
CRON_TAG="# Quilin Agent auto-sync"

# 检测 Python
PYTHON_BIN=""
for candidate in python3 python; do
    if command -v "$candidate" &>/dev/null; then
        PYTHON_BIN="$candidate"
        break
    fi
done

if [[ -z "$PYTHON_BIN" ]]; then
    echo "ERROR: Python not found. Install Python 3.11+ first."
    exit 1
fi

PYTHON_PATH=$(command -v "$PYTHON_BIN")

log() {
    echo "[setup-cron] $*"
}

install_cron() {
    log "Installing cron job..."

    # 创建日志目录
    mkdir -p "$(dirname "$LOG_FILE")"

    # cron 表达式：每 5 分钟执行一次
    CRON_ENTRY="*/5 * * * * cd $ROOT_DIR && $PYTHON_PATH $SYNC_SCRIPT >> $LOG_FILE 2>&1 $CRON_TAG"

    # 检查是否已安装
    if crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
        log "Cron job already installed, updating..."
        remove_cron_silent
    fi

    # 追加到 crontab
    (crontab -l 2>/dev/null || true; echo "$CRON_ENTRY") | crontab -

    log "Cron job installed successfully!"
    log ""
    log "  Schedule:  Every 5 minutes"
    log "  Script:    $SYNC_SCRIPT"
    log "  Log:       $LOG_FILE"
    log "  Python:    $PYTHON_PATH"
    log ""
    log "Verify with: crontab -l | grep Quilin"
    log "Remove with: bash $0 --remove"
}

remove_cron_silent() {
    crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab - 2>/dev/null || true
}

remove_cron() {
    log "Removing cron job..."
    if crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
        remove_cron_silent
        log "Cron job removed"
    else
        log "No Quilin Agent cron job found"
    fi
}

show_status() {
    log "Current cron status:"
    echo ""
    if crontab -l 2>/dev/null | grep -F "$CRON_TAG"; then
        echo ""
        log "Status: ACTIVE"
    else
        log "Status: NOT INSTALLED"
    fi

    echo ""
    if [[ -f "$LOG_FILE" ]]; then
        log "Last 10 log lines:"
        tail -10 "$LOG_FILE"
    else
        log "No log file yet"
    fi
}

# 解析参数
case "${1:-}" in
    --remove)  remove_cron ;;
    --status)  show_status ;;
    *)         install_cron ;;
esac
