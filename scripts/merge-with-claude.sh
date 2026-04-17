#!/usr/bin/env bash
# =============================================================================
# Quilin Agent — Claude 智能缝合脚本
# =============================================================================
# 当 upstream 有更新时，自动：
#   1. 生成变更 diff
#   2. 收集当前 quilin 相关代码
#   3. 调用 Claude Code 分析 diff 并生成融合 patch
#   4. 自动 apply patch
#
# 用法：
#   bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]
#   bash scripts/merge-with-claude.sh memory-hindsight "3 files changed"
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
QUILIN_DIR="$ROOT_DIR/quilin"
UPSTREAMS_DIR="$ROOT_DIR/upstreams"
PATCHES_DIR="$ROOT_DIR/.patches"
LOG_DIR="$ROOT_DIR/.logs"

# 参数
SUBMODULE_NAME="${1:-}"
DIFF_SUMMARY="${2:-}"

if [[ -z "$SUBMODULE_NAME" ]]; then
    echo "Usage: $0 <submodule-name> [diff-summary]"
    echo "Example: $0 memory-hindsight '3 files changed, 50 insertions'"
    exit 1
fi

# 创建必要目录
mkdir -p "$PATCHES_DIR" "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/merge_${SUBMODULE_NAME}_${TIMESTAMP}.log"
PATCH_FILE="$PATCHES_DIR/${SUBMODULE_NAME}_${TIMESTAMP}.patch"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

# =============================================================================
# Step 1: 生成详细 diff
# =============================================================================
log "=== Merge with Claude: $SUBMODULE_NAME ==="
log "Step 1: Generating diff..."

SUBMODULE_PATH="$UPSTREAMS_DIR/$SUBMODULE_NAME"

if [[ ! -d "$SUBMODULE_PATH" ]]; then
    log "ERROR: Submodule path not found: $SUBMODULE_PATH"
    exit 1
fi

# 获取详细 diff（最近一次更新）
DETAILED_DIFF=$(cd "$SUBMODULE_PATH" && git diff HEAD~1..HEAD 2>/dev/null || echo "No diff available")
DIFF_STAT=$(cd "$SUBMODULE_PATH" && git diff --stat HEAD~1..HEAD 2>/dev/null || echo "No stats available")
COMMIT_MSG=$(cd "$SUBMODULE_PATH" && git log -1 --pretty=format:"%s%n%n%b" 2>/dev/null || echo "No commit message")

log "Diff stat: $DIFF_STAT"
log "Commit: $COMMIT_MSG"

# =============================================================================
# Step 2: 收集当前 quilin 相关代码
# =============================================================================
log "Step 2: Collecting relevant quilin code..."

# 根据 submodule 名称确定对应的能力层
LAYER=""
case "$SUBMODULE_NAME" in
    memory-*)      LAYER="memory" ;;
    llm-*)         LAYER="llm" ;;
    perception-*)  LAYER="perception" ;;
    planning-*)    LAYER="planning" ;;
    tools-*)       LAYER="tools" ;;
    orch-*)        LAYER="orchestration" ;;
    obs-*)         LAYER="observability" ;;
    guard-*)       LAYER="guardrails" ;;
    deploy-*)      LAYER="deployment" ;;
    *)             LAYER="unknown" ;;
esac

log "Detected layer: $LAYER"

# 收集对应层的适配器代码
LAYER_CODE=""
if [[ -d "$QUILIN_DIR/layers/$LAYER" ]]; then
    LAYER_CODE=$(find "$QUILIN_DIR/layers/$LAYER" -name "*.py" -exec cat {} \; 2>/dev/null || echo "")
fi

# 收集核心 Harness 代码
CORE_CODE=$(cat "$QUILIN_DIR/core/Harness.py" 2>/dev/null || echo "")

# =============================================================================
# Step 3: 调用 Claude Code 生成融合 patch
# =============================================================================
log "Step 3: Invoking Claude Code for intelligent merge..."

# 构造 prompt
PROMPT="你是 Quilin Agent 的 AI 辅助融合引擎（D-03：最终合并由人类 PR 审批决定）。

## 上游更新
- **Submodule**: $SUBMODULE_NAME
- **Layer**: $LAYER
- **Commit 信息**: $COMMIT_MSG

## Diff 统计
$DIFF_STAT

## 详细 Diff（截取前 3000 字符）
${DETAILED_DIFF:0:3000}

## 当前 Layer 适配器代码
${LAYER_CODE:0:2000}

## 任务
1. 分析上游更新的核心变化（新特性 / bugfix / API 变更）
2. 判断是否需要同步到我们的 quilin 代码
3. 如果需要，生成一个 unified diff patch 文件
4. 如果不需要，说明原因

请输出：
- VERDICT: MERGE / SKIP / MANUAL_REVIEW
- REASON: 一句话说明
- PATCH: (如果 MERGE) unified diff 格式的 patch"

# 检查是否安装了 claude CLI
if command -v claude &>/dev/null; then
    log "Using Claude Code CLI..."
    echo "$PROMPT" | claude --print 2>>"$LOG_FILE" > "$PATCH_FILE" || {
        log "WARN: Claude Code invocation failed, saving for manual review"
        echo "$PROMPT" > "$PATCHES_DIR/${SUBMODULE_NAME}_${TIMESTAMP}_prompt.txt"
    }
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    log "Using Anthropic API directly..."
    # 使用 curl 直接调用 API
    RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
        -H "content-type: application/json" \
        -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -d "$(jq -n \
            --arg prompt "$PROMPT" \
            '{
                model: "claude-sonnet-4-20250514",
                max_tokens: 4096,
                messages: [{role: "user", content: $prompt}]
            }')" 2>>"$LOG_FILE") || {
        log "WARN: API call failed"
        RESPONSE=""
    }

    if [[ -n "$RESPONSE" ]]; then
        echo "$RESPONSE" | jq -r '.content[0].text // empty' > "$PATCH_FILE" 2>/dev/null || {
            log "WARN: Failed to parse API response"
        }
    fi
else
    log "WARN: Neither Claude CLI nor ANTHROPIC_API_KEY available"
    log "Saving prompt for manual review..."
    echo "$PROMPT" > "$PATCHES_DIR/${SUBMODULE_NAME}_${TIMESTAMP}_prompt.txt"
fi

# =============================================================================
# Step 4: 尝试自动 apply patch
# =============================================================================
log "Step 4: Analyzing merge result..."

if [[ -f "$PATCH_FILE" ]] && [[ -s "$PATCH_FILE" ]]; then
    # 检查 Claude 的 verdict
    VERDICT=$(grep -oP 'VERDICT:\s*\K\w+' "$PATCH_FILE" 2>/dev/null | head -1 || echo "UNKNOWN")

    case "$VERDICT" in
        MERGE)
            log "VERDICT: MERGE — Attempting to apply patch..."
            # 提取 patch 内容（在 PATCH: 之后的 diff 块）
            sed -n '/^---/,$ p' "$PATCH_FILE" > "${PATCH_FILE}.diff" 2>/dev/null || true
            if [[ -s "${PATCH_FILE}.diff" ]]; then
                cd "$ROOT_DIR"
                if git apply --check "${PATCH_FILE}.diff" 2>/dev/null; then
                    git apply "${PATCH_FILE}.diff"
                    log "Patch applied successfully!"
                else
                    log "WARN: Patch cannot be applied cleanly, saved for manual review"
                fi
            else
                log "No extractable diff block found in Claude response"
            fi
            ;;
        SKIP)
            log "VERDICT: SKIP — No changes needed"
            ;;
        MANUAL_REVIEW)
            log "VERDICT: MANUAL_REVIEW — Saved to $PATCH_FILE"
            ;;
        *)
            log "VERDICT: UNKNOWN — Saved response to $PATCH_FILE for review"
            ;;
    esac
else
    log "No patch generated"
fi

log "=== Merge complete for $SUBMODULE_NAME ==="
log "Log: $LOG_FILE"
log "Patch: $PATCH_FILE"
