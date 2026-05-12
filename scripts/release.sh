#!/usr/bin/env bash
# =============================================================================
# Quilin Agent — Release script / 自动发布脚本
# =============================================================================
# Two responsibilities / 两大职责:
#   1) Publish mode (default behaviour): commit + tag + push the release.
#      发布模式（默认行为）：commit + 打 tag + push。
#   2) Tarball mode (--core / --full): build a distributable tarball with sha256.
#      Tarball 模式（--core / --full）：构建可分发的 tarball 与 sha256 校验文件。
#
# Tarball modes / Tarball 模式:
#   --core   (default tarball)   Excludes upstreams/, .claude/worktrees/, .git/,
#                                node_modules/, dist/, target/, __pycache__/,
#                                .logs/, .patches/, test files. Suitable for the
#                                public one-line installer.
#                                排除 upstreams/、.claude/worktrees/、.git/、
#                                node_modules/、dist/、target/、__pycache__/、
#                                .logs/、.patches/ 与测试文件，适合公共一键安装。
#   --full                       Tracks the full working tree (excluding only
#                                obviously generated dirs). For advanced users
#                                who want every submodule.
#                                打包完整工作区（仅排除生成目录），面向需要
#                                全部 submodule 的高级用户。
#
# Usage / 用法:
#   bash scripts/release.sh                          # auto patch bump + publish
#   bash scripts/release.sh --minor                  # minor bump + publish
#   bash scripts/release.sh --major                  # major bump + publish
#   bash scripts/release.sh --version 1.2.3          # explicit version
#   bash scripts/release.sh --dry-run                # preview only
#   bash scripts/release.sh --core                   # build core tarball
#   bash scripts/release.sh --core --dry-run         # list tarball contents only
#   bash scripts/release.sh --full --version 1.2.3   # build full tarball
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# -------- Defaults / 默认值 --------------------------------------------------
BUMP_TYPE="patch"
CUSTOM_VERSION=""
DRY_RUN=false
PUSH_REMOTE=true
TARBALL_MODE=""           # "" | "core" | "full"
DIST_DIR="${QUILIN_DIST_DIR:-$ROOT_DIR/dist}"

# -------- Argument parsing / 参数解析 ----------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --major)        BUMP_TYPE="major"; shift ;;
        --minor)        BUMP_TYPE="minor"; shift ;;
        --patch)        BUMP_TYPE="patch"; shift ;;
        --version)      CUSTOM_VERSION="$2"; shift 2 ;;
        --dry-run)      DRY_RUN=true; shift ;;
        --no-push)      PUSH_REMOTE=false; shift ;;
        --core)         TARBALL_MODE="core"; shift ;;
        --full)         TARBALL_MODE="full"; shift ;;
        --dist-dir)     DIST_DIR="$2"; shift 2 ;;
        --dist-dir=*)   DIST_DIR="${1#--dist-dir=}"; shift ;;
        -h|--help)
            sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

cd "$ROOT_DIR"

log() {
    echo "[release] $*"
}

# =============================================================================
# Helpers shared by both modes / 两种模式共用辅助
# =============================================================================

# Resolve target version from --version, current git tag, or bump rule.
# 根据 --version / git tag / bump 规则解析目标版本。
resolve_version() {
    LATEST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")"
    CURRENT_VERSION="${LATEST_TAG#v}"

    if [[ -n "$CUSTOM_VERSION" ]]; then
        NEW_VERSION="${CUSTOM_VERSION#v}"
    else
        IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
        MAJOR=${MAJOR:-0}
        MINOR=${MINOR:-0}
        PATCH=${PATCH:-0}
        # Strip pre-release / build suffixes like "-iter-b1" so arithmetic works.
        # 去掉类似 "-iter-b1" 的预发布 / 构建后缀，确保算术运算可用。
        MAJOR="${MAJOR%%[!0-9]*}"; MAJOR="${MAJOR:-0}"
        MINOR="${MINOR%%[!0-9]*}"; MINOR="${MINOR:-0}"
        PATCH="${PATCH%%[!0-9]*}"; PATCH="${PATCH:-0}"
        case "$BUMP_TYPE" in
            major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
            minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
            patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
        esac
    fi
    NEW_TAG="v$NEW_VERSION"
}

# =============================================================================
# Tarball mode / Tarball 模式
# =============================================================================

# Build tar exclusion args based on TARBALL_MODE.
# 根据 TARBALL_MODE 构建 tar 的 --exclude 参数。
build_exclusions() {
    # Always-excluded: build artifacts, secrets, caches, VCS internals.
    # 始终排除：构建产物、密钥、缓存、VCS 内部目录。
    EXCLUDES=(
        "--exclude=./.git"
        "--exclude=./.gitmodules"
        "--exclude=./.github"
        "--exclude=./.claude"
        "--exclude=./.devcontainer"
        "--exclude=./.logs"
        "--exclude=./.patches"
        "--exclude=./.env"
        "--exclude=./.env.local"
        "--exclude=./dist"
        "--exclude=./target"
        "--exclude=./node_modules"
        "--exclude=*/node_modules"
        "--exclude=*/__pycache__"
        "--exclude=*/.pytest_cache"
        "--exclude=*/.ruff_cache"
        "--exclude=*/.mypy_cache"
        "--exclude=*/.venv"
        "--exclude=*/dist"
        "--exclude=*/target"
        "--exclude=*.pyc"
        "--exclude=*.pyo"
        "--exclude=*.log"
        "--exclude=*.tmp"
    )

    # --core also excludes upstreams/ (the 100-submodule, multi-GB tree) and
    # test fixtures + benchmarks that are not needed at runtime.
    # --core 模式额外排除 upstreams/（100 个 submodule，数 GB）与运行期不需要
    # 的测试文件 + benchmark 目录。
    if [[ "$TARBALL_MODE" == "core" ]]; then
        EXCLUDES+=(
            "--exclude=./upstreams"
            "--exclude=./benchmarks"
            "--exclude=*/tests"
            "--exclude=*.test.ts"
            "--exclude=*.test.js"
            "--exclude=*.test.py"
            "--exclude=*_test.go"
            "--exclude=*.bench.ts"
        )
    fi
}

# Whitelist of paths included in a --core tarball. Anything outside this list
# is implicitly excluded by the explicit include list passed to `tar`.
# --core tarball 的白名单。除此之外的内容由显式 include 列表隐含排除。
core_include_paths() {
    # Each path is relative to ROOT_DIR. Files / dirs that do not exist are
    # silently dropped (we filter below).
    # 每条路径相对 ROOT_DIR；不存在的条目下面会被过滤。
    cat <<'EOF'
packages
providers
crates
docs
scripts
justfile
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
Cargo.toml
Cargo.lock
tsconfig.base.json
vitest.config.ts
vitest.workspace.ts
config.example.toml
.env.example
quilin.md
CLAUDE.md
AGENTS.md
agent-bridge.md
readme.md
EOF
}

# Pick existing include paths only. Prints relative paths, one per line.
# 仅选择实际存在的路径，每行输出一个相对路径。
filter_existing_includes() {
    while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        if [[ -e "$ROOT_DIR/$p" ]]; then
            printf '%s\n' "$p"
        fi
    done
}

# Compute the platform-correct sha256 command.
# 计算当前平台可用的 sha256 命令。
sha256_cmd() {
    if command -v shasum >/dev/null 2>&1; then
        echo "shasum -a 256"
    elif command -v sha256sum >/dev/null 2>&1; then
        echo "sha256sum"
    else
        echo "" # caller handles missing tool
    fi
}

# Build the tarball + sha256 file. Honors $DRY_RUN.
# 构建 tarball 与 sha256 校验文件，遵守 $DRY_RUN。
build_tarball() {
    resolve_version
    build_exclusions

    mode_label="$TARBALL_MODE"
    base_name="quilin-${mode_label}-v${NEW_VERSION}"
    tarball_path="$DIST_DIR/${base_name}.tar.gz"
    checksum_path="${tarball_path}.sha256"

    log "Tarball mode: $mode_label"
    log "Version: $NEW_VERSION"
    log "Output: $tarball_path"

    # Build the path argument list.
    # 计算要打包的路径列表。
    if [[ "$TARBALL_MODE" == "core" ]]; then
        # shellcheck disable=SC2207
        INCLUDE_PATHS=( $(core_include_paths | filter_existing_includes) )
        if [[ ${#INCLUDE_PATHS[@]} -eq 0 ]]; then
            log "ERROR: No core include paths exist under $ROOT_DIR"
            exit 1
        fi
        # Prepend ./ for tar exclude pattern matching consistency.
        # 给路径加上 ./ 前缀，便于 --exclude 模式匹配。
        TAR_PATHS=()
        for p in "${INCLUDE_PATHS[@]}"; do
            TAR_PATHS+=("./$p")
        done
    else
        # --full: pack the entire working tree (with always-exclusions applied).
        # --full：打包整棵工作区（仍应用始终排除规则）。
        TAR_PATHS=( "." )
    fi

    if $DRY_RUN; then
        log "[DRY RUN] tarball would be: $tarball_path"
        log "[DRY RUN] checksum would be: $checksum_path"
        log "[DRY RUN] include paths:"
        for p in "${TAR_PATHS[@]}"; do
            echo "  $p"
        done
        log "[DRY RUN] exclude patterns:"
        for e in "${EXCLUDES[@]}"; do
            echo "  $e"
        done
        log "[DRY RUN] resolved file list (top-level summary):"
        # Show the would-be contents so tests can assert on them. For brevity
        # we only print the unique top-level directories that would be packed.
        # The full file list is too large to be useful inline; the assertions
        # care about top-level membership.
        # 输出将被打包的内容；为可读性只列出唯一的顶层目录，完整文件列表过长。
        # 测试只关心顶层成员，足够覆盖断言。
        tar -czf /dev/null \
            -C "$ROOT_DIR" \
            "${EXCLUDES[@]}" \
            --verbose \
            "${TAR_PATHS[@]}" 2>&1 \
            | awk '{print $NF}' \
            | sed -e 's|^|./|' -e 's|^\./\./|./|' \
            | awk -F/ '{ if (NF>=2) { print "./" $2 } else { print $0 } }' \
            | sort -u \
            | sed 's/^/  /' || true
        log "[DRY RUN] done"
        return 0
    fi

    mkdir -p "$DIST_DIR"
    log "Packaging ..."
    tar -czf "$tarball_path" \
        -C "$ROOT_DIR" \
        "${EXCLUDES[@]}" \
        "${TAR_PATHS[@]}"

    log "Computing sha256 ..."
    sha_cmd="$(sha256_cmd)"
    if [[ -z "$sha_cmd" ]]; then
        log "ERROR: Neither shasum nor sha256sum is available."
        exit 1
    fi
    # Format: "<hex>  <filename>" — the standard `shasum -c` line format.
    # 格式为 `<hex>  <filename>`，即 `shasum -c` 默认期待的格式。
    ( cd "$DIST_DIR" && $sha_cmd "$(basename "$tarball_path")" ) > "$checksum_path"

    log ""
    log "=========================================="
    log " Tarball ready / Tarball 已生成"
    log "=========================================="
    log " File:     $tarball_path"
    log " Checksum: $checksum_path"
    log " Size:     $(du -h "$tarball_path" | awk '{print $1}')"
    log "=========================================="
}

# =============================================================================
# Tarball-mode short-circuit / Tarball 模式短路返回
# =============================================================================
# When the user asks for a tarball, do that and exit. Publish flow is reserved
# for invocations without --core / --full.
# 用户请求 tarball 时直接构建并退出；publish 流程仅在未传 --core / --full 时执行。
if [[ -n "$TARBALL_MODE" ]]; then
    build_tarball
    exit 0
fi

# =============================================================================
# Publish mode (legacy behaviour) / 发布模式（原有逻辑）
# =============================================================================

# -------- Step 1: working-tree check / 步骤 1: 工作区检查 --------------------
log "Checking working directory..."

if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    CHANGES=true
else
    CHANGES=false
fi

UNTRACKED=$(git ls-files --others --exclude-standard | head -20)

if [[ "$CHANGES" == "false" ]] && [[ -z "$UNTRACKED" ]]; then
    log "No changes to release"
    exit 0
fi

log "Changes detected, proceeding with release..."

# -------- Step 2: version / 步骤 2: 版本号 -----------------------------------
log "Calculating version..."
resolve_version
log "Version: $CURRENT_VERSION -> $NEW_VERSION ($NEW_TAG)"

if $DRY_RUN; then
    log "[DRY RUN] Would commit, tag $NEW_TAG, and push"
    git status --short
    exit 0
fi

# -------- Step 3: changelog / 步骤 3: 变更摘要 -------------------------------
log "Generating changelog..."

SUBMODULE_CHANGES=""
if [[ "$LATEST_TAG" != "v0.0.0" ]]; then
    SUBMODULE_CHANGES=$(git diff "$LATEST_TAG"..HEAD --submodule=short 2>/dev/null || echo "")
fi

CORE_CHANGES=$(git diff "$LATEST_TAG"..HEAD --stat -- quilin/ 2>/dev/null || echo "Initial release")

# -------- Step 4: stage + commit / 步骤 4: 暂存与提交 ------------------------
log "Staging changes..."
git add -A upstreams/ 2>/dev/null || true
git add -A quilin/ scripts/ 2>/dev/null || true
git add -A ./*.yaml ./*.yml ./*.toml Dockerfile .gitmodules 2>/dev/null || true

COMMIT_MSG="release: $NEW_TAG

Upstream updates:
${SUBMODULE_CHANGES:-  (none)}

Core changes:
${CORE_CHANGES:-  (initial release)}

Auto-generated by Quilin Agent release.sh"

log "Committing..."
git commit -m "$COMMIT_MSG" || {
    log "Nothing to commit"
    exit 0
}

# -------- Step 5: tag / 步骤 5: 打 Tag ---------------------------------------
log "Tagging $NEW_TAG..."

TAG_MSG="Quilin Agent $NEW_TAG

Released: $(date -u '+%Y-%m-%d %H:%M:%S UTC')
Changes since $LATEST_TAG:
$(git log "$LATEST_TAG"..HEAD --oneline 2>/dev/null || echo "  Initial release")"

git tag -a "$NEW_TAG" -m "$TAG_MSG"

# -------- Step 6: push / 步骤 6: 推送 ----------------------------------------
if $PUSH_REMOTE; then
    log "Pushing to remote..."
    if git remote get-url origin &>/dev/null; then
        git push origin HEAD
        git push origin "$NEW_TAG"
        log "Pushed $NEW_TAG to origin"
    else
        log "WARN: No remote 'origin' configured, skipping push"
        log "Run: git remote add origin <url> && git push -u origin main --tags"
    fi
else
    log "Skipping push (--no-push)"
fi

log ""
log "=========================================="
log " Release $NEW_TAG complete!"
log "=========================================="
log " Tag:    $NEW_TAG"
log " Commit: $(git rev-parse --short HEAD)"
log " Date:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
log "=========================================="
