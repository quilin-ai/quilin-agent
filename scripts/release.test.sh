#!/usr/bin/env bash
# =============================================================================
# Tests for scripts/release.sh / release.sh 的测试
# =============================================================================
# Runs the tarball builder in --dry-run mode and asserts:
#   - the would-be include list does NOT contain upstreams/ or .claude/worktrees/
#   - it DOES contain packages/, providers/, docs/, scripts/, justfile
#   - sha256 sibling file path is printed
# 干跑 tarball 构建模式，断言：
#   - 文件列表 不包含 upstreams/、.claude/worktrees/
#   - 文件列表 包含 packages/、providers/、docs/、scripts/、justfile
#   - 打印出 sha256 同名 .sha256 文件路径
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_SH="$SCRIPT_DIR/release.sh"

if [[ ! -x "$RELEASE_SH" ]]; then
    echo "[release.test] ERROR: $RELEASE_SH is not executable" >&2
    exit 1
fi

PASS=0
FAIL=0

assert_contains() {
    local label="$1"
    local haystack="$2"
    local needle="$3"
    # `-e -- PATTERN` keeps BSD grep happy when PATTERN starts with `-`.
    # `-e -- PATTERN` 让 BSD grep 在模式以 `-` 开头时也能正常工作。
    if grep -qF -e "$needle" <<< "$haystack"; then
        printf '  [PASS] %s\n' "$label"
        PASS=$((PASS + 1))
    else
        printf '  [FAIL] %s\n' "$label" >&2
        printf '         expected to find: %s\n' "$needle" >&2
        FAIL=$((FAIL + 1))
    fi
}

assert_not_contains() {
    local label="$1"
    local haystack="$2"
    local needle="$3"
    if grep -qF -e "$needle" <<< "$haystack"; then
        printf '  [FAIL] %s\n' "$label" >&2
        printf '         expected NOT to find: %s\n' "$needle" >&2
        FAIL=$((FAIL + 1))
    else
        printf '  [PASS] %s\n' "$label"
        PASS=$((PASS + 1))
    fi
}

# -------- Test 1: --core --dry-run prints expected file list ----------------
echo "[release.test] Test 1: release.sh --core --dry-run"
CORE_OUT="$("$RELEASE_SH" --core --dry-run --version 0.0.0-test 2>&1)"

# Sanity: header prints
assert_contains "tarball mode header" "$CORE_OUT" "Tarball mode: core"
assert_contains "version printed" "$CORE_OUT" "Version: 0.0.0-test"
assert_contains "tarball path printed" "$CORE_OUT" "quilin-core-v0.0.0-test.tar.gz"

# Include list
assert_contains "includes packages" "$CORE_OUT" "./packages"
assert_contains "includes providers" "$CORE_OUT" "./providers"
assert_contains "includes docs" "$CORE_OUT" "./docs"
assert_contains "includes scripts" "$CORE_OUT" "./scripts"
assert_contains "includes justfile" "$CORE_OUT" "./justfile"
assert_contains "includes package.json" "$CORE_OUT" "./package.json"
assert_contains "includes pnpm-lock.yaml" "$CORE_OUT" "./pnpm-lock.yaml"

# Exclude list
assert_contains "excludes upstreams" "$CORE_OUT" "--exclude=./upstreams"
assert_contains "excludes .claude" "$CORE_OUT" "--exclude=./.claude"
assert_contains "excludes node_modules" "$CORE_OUT" "--exclude=./node_modules"
assert_contains "excludes .git" "$CORE_OUT" "--exclude=./.git"
assert_contains "excludes .logs" "$CORE_OUT" "--exclude=./.logs"
assert_contains "excludes .env" "$CORE_OUT" "--exclude=./.env"
assert_contains "excludes test files" "$CORE_OUT" "--exclude=*.test.ts"

# Critical: the resolved would-be content listing also must not show upstreams/
# 关键：实际打包列表也不能出现 upstreams/
# Filter the "resolved file list" block to avoid matching the worktree path
# the test itself runs from (the CWD may contain `.claude/worktrees`).
# 过滤"resolved file list"块，避免误匹配测试运行所在的 worktree 路径
# （当前 CWD 自身可能包含 `.claude/worktrees`）。
RESOLVED_BLOCK="$(printf '%s\n' "$CORE_OUT" | sed -n '/resolved file list/,$p' | grep -E '^  \.\/' || true)"
assert_not_contains "actual content list excludes ./upstreams/" "$RESOLVED_BLOCK" "./upstreams/"
assert_not_contains "actual content list excludes ./.claude/" "$RESOLVED_BLOCK" "./.claude/"

# -------- Test 2: --full --dry-run includes upstreams/ (when present) -------
echo "[release.test] Test 2: release.sh --full --dry-run"
FULL_OUT="$("$RELEASE_SH" --full --dry-run --version 0.0.0-full-test 2>&1)"
assert_contains "full mode header" "$FULL_OUT" "Tarball mode: full"
assert_contains "full tarball path" "$FULL_OUT" "quilin-full-v0.0.0-full-test.tar.gz"
# --full uses the always-exclusions but does NOT exclude upstreams/.
# --full 仅应用始终排除清单，不排除 upstreams/。
assert_not_contains "full mode does not add --exclude=./upstreams" "$FULL_OUT" "--exclude=./upstreams"

# -------- Test 3: unknown flag rejected -------------------------------------
echo "[release.test] Test 3: unknown flag rejection"
set +e
BAD_OUT="$("$RELEASE_SH" --not-a-real-flag 2>&1)"
BAD_EC=$?
set -e
if [[ "$BAD_EC" -eq 1 ]]; then
    echo "  [PASS] exit code 1 on unknown flag"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] exit code $BAD_EC, expected 1" >&2
    FAIL=$((FAIL + 1))
fi
assert_contains "stderr mentions unknown option" "$BAD_OUT" "Unknown option"

# -------- Summary -----------------------------------------------------------
echo ""
echo "[release.test] PASS=$PASS  FAIL=$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
    exit 1
fi
exit 0
