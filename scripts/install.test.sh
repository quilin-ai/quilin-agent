#!/bin/sh
# =============================================================================
# Tests for scripts/install.sh / install.sh 的测试
# =============================================================================
# Runs the installer in --dry-run mode (no network, no writes) and asserts the
# stdout contains the expected step lines. Intended to run in CI and locally.
# 以 --dry-run 模式运行安装脚本（不联网、不写入），断言 stdout 中包含预期步骤。
# 用于 CI 与本地校验。
# =============================================================================

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"

if [ ! -x "$INSTALL_SH" ]; then
    echo "[install.test] ERROR: $INSTALL_SH is not executable" >&2
    exit 1
fi

TMP_PREFIX="$(mktemp -d)"
trap 'rm -rf "$TMP_PREFIX"' EXIT

PASS=0
FAIL=0

assert_contains() {
    label="$1"
    haystack="$2"
    needle="$3"
    # `-e -- PATTERN` is portable; bare PATTERN breaks BSD grep when PATTERN
    # starts with `-` (e.g. `--upgrade`).
    # 用 `-e -- PATTERN` 的写法兼容 BSD grep；裸传以 `-` 开头的模式（如 --upgrade）
    # 会被 BSD grep 当成参数。
    if printf '%s' "$haystack" | grep -qF -e "$needle"; then
        printf '  [PASS] %s\n' "$label"
        PASS=$((PASS + 1))
    else
        printf '  [FAIL] %s\n' "$label" >&2
        printf '         expected to find: %s\n' "$needle" >&2
        FAIL=$((FAIL + 1))
    fi
}

assert_not_contains() {
    label="$1"
    haystack="$2"
    needle="$3"
    if printf '%s' "$haystack" | grep -qF -e "$needle"; then
        printf '  [FAIL] %s\n' "$label" >&2
        printf '         expected NOT to find: %s\n' "$needle" >&2
        FAIL=$((FAIL + 1))
    else
        printf '  [PASS] %s\n' "$label"
        PASS=$((PASS + 1))
    fi
}

# -------- Test 1: --dry-run with pinned version on macOS/Linux ---------------
echo "[install.test] Test 1: dry-run with --version=v0.0.0 --prefix=tmp --no-deps"
OUT="$(QUILIN_GITHUB_OWNER=quilin-org QUILIN_GITHUB_REPO=quilin-agent \
    "$INSTALL_SH" \
        --dry-run \
        --version=v0.0.0 \
        --prefix="$TMP_PREFIX/install" \
        --no-deps \
        --yes 2>&1)"

assert_contains "platform detection prints" "$OUT" "Detected platform:"
assert_contains "version target prints" "$OUT" "Target version: v0.0.0"
assert_contains "install dir prints" "$OUT" "Install dir: $TMP_PREFIX/install"
assert_contains "wrapper bin dir prints" "$OUT" "Wrapper bin dir:"
assert_contains "dry-run extract step" "$OUT" "[DRY-RUN] tar -xzf"
assert_contains "dry-run wrapper step" "$OUT" "[DRY-RUN] write"
assert_contains "skips bun/uv with --no-deps" "$OUT" "Skipping Bun / uv auto-install"
assert_contains "dry-run curl line printed" "$OUT" "[DRY-RUN] curl -fSL -o"

# -------- Test 2: --help prints flags ----------------------------------------
echo "[install.test] Test 2: --help"
HELP_OUT="$("$INSTALL_SH" --help 2>&1)"
assert_contains "--help mentions --upgrade" "$HELP_OUT" "--upgrade"
assert_contains "--help mentions --dry-run" "$HELP_OUT" "--dry-run"
assert_contains "--help mentions --prefix" "$HELP_OUT" "--prefix"
assert_contains "--help mentions --version" "$HELP_OUT" "--version"
assert_contains "--help mentions --no-deps" "$HELP_OUT" "--no-deps"

# -------- Test 3: unknown flag rejected --------------------------------------
echo "[install.test] Test 3: unknown flag rejection"
set +e
BAD_OUT="$("$INSTALL_SH" --not-a-real-flag 2>&1)"
BAD_EC=$?
set -e
if [ "$BAD_EC" -eq 1 ]; then
    echo "  [PASS] exit code 1 on unknown flag"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] exit code $BAD_EC, expected 1" >&2
    FAIL=$((FAIL + 1))
fi
assert_contains "stderr mentions unknown option" "$BAD_OUT" "Unknown option"

# -------- Test 4: tarball URL override -----------------------------------------
echo "[install.test] Test 4: QUILIN_TARBALL_URL skips release lookup"
OUT4="$(QUILIN_TARBALL_URL="https://example.invalid/quilin-core.tar.gz" \
    QUILIN_CHECKSUM_URL="https://example.invalid/quilin-core.tar.gz.sha256" \
    "$INSTALL_SH" \
        --dry-run \
        --prefix="$TMP_PREFIX/install2" \
        --no-deps \
        --yes 2>&1)"
assert_contains "honors QUILIN_TARBALL_URL" "$OUT4" "https://example.invalid/quilin-core.tar.gz"
assert_not_contains "does not call /releases/latest" "$OUT4" "/releases/latest"

# -------- Summary -------------------------------------------------------------
echo ""
echo "[install.test] PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
exit 0
