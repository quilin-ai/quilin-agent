#!/bin/sh
# =============================================================================
# Quilin Agent — One-line installer / 一键安装脚本
# =============================================================================
# Pipe-friendly POSIX installer for end users.
# 面向最终用户的 POSIX 兼容一键安装脚本。
#
# Typical usage / 典型用法:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/quilin-agent/master/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --upgrade
#   curl -fsSL .../install.sh | sh -s -- --version v0.3.0
#   curl -fsSL .../install.sh | sh -s -- --prefix /opt/quilin --no-deps
#
# Flags / 选项:
#   --upgrade            Overwrite an existing install (with confirmation)
#                        覆盖已有安装（需确认）
#   --dry-run            Print actions without doing them / 仅打印步骤、不执行
#   --prefix=DIR         Install dir override (else QUILIN_HOME / default)
#                        覆盖安装目录（否则使用 QUILIN_HOME 或默认值）
#   --version=vX.Y.Z     Pin a specific release / 锁定指定版本
#   --no-deps            Skip Bun / uv auto-install / 跳过 Bun / uv 自动安装
#   --yes / -y           Assume "yes" to all confirmations / 自动同意所有确认
#   --help / -h          Show usage / 显示帮助
#
# Environment overrides / 环境变量覆盖:
#   QUILIN_HOME              Install root (default: $XDG_DATA_HOME/quilin
#                            or $HOME/.local/share/quilin)
#                            安装根目录（默认 $XDG_DATA_HOME/quilin
#                            或 $HOME/.local/share/quilin）
#   QUILIN_BIN               Wrapper bin dir (default: $HOME/.local/bin)
#                            wrapper 安装目录（默认 $HOME/.local/bin）
#   QUILIN_GITHUB_OWNER      GitHub owner (default: raysonmeng)
#                            GitHub owner（默认 raysonmeng）
#   QUILIN_GITHUB_REPO       GitHub repo (default: quilin-agent)
#                            GitHub repo（默认 quilin-agent）
#   QUILIN_RELEASE_VERSION   Version tag override / 版本 tag 覆盖
#   QUILIN_TARBALL_URL       Direct tarball URL (skips release lookup)
#                            直接指定 tarball URL（跳过 release 查询）
#   QUILIN_CHECKSUM_URL      Direct sha256 URL (default: tarball URL + .sha256)
#                            直接指定 sha256 URL（默认在 tarball URL 后加 .sha256）
#
# Exit codes / 退出码:
#   0  success / 成功
#   1  user error (bad flag, unsupported OS) / 用户输入错误（参数 / 系统不支持）
#   2  required dependency missing and user declined auto-install
#      必备依赖缺失且用户拒绝自动安装
#   3  download failure / 下载失败
#   4  extract / checksum failure / 解压或校验失败
#   5  dependency install failure / 依赖安装失败
# =============================================================================

# POSIX strict mode. `pipefail` is not POSIX, only set when running under bash.
# POSIX 严格模式。`pipefail` 不在 POSIX 范围内，仅在 bash 下启用。
set -eu
# shellcheck disable=SC3040
(set -o pipefail 2>/dev/null) && set -o pipefail || true

# -------- Defaults / 默认值 --------------------------------------------------
QUILIN_GITHUB_OWNER="${QUILIN_GITHUB_OWNER:-raysonmeng}"
QUILIN_GITHUB_REPO="${QUILIN_GITHUB_REPO:-quilin-agent}"
DEFAULT_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEFAULT_INSTALL_DIR="${QUILIN_HOME:-$DEFAULT_DATA_HOME/quilin}"
DEFAULT_BIN_DIR="${QUILIN_BIN:-$HOME/.local/bin}"

UPGRADE=0
DRY_RUN=0
NO_DEPS=0
ASSUME_YES=0
PREFIX=""
VERSION="${QUILIN_RELEASE_VERSION:-}"
TARBALL_URL_OVERRIDE="${QUILIN_TARBALL_URL:-}"
CHECKSUM_URL_OVERRIDE="${QUILIN_CHECKSUM_URL:-}"

# Temp dir for tarball download — populated in `prepare_workspace`.
# Tarball 下载临时目录，由 `prepare_workspace` 创建。
WORK_DIR=""

# -------- Logging helpers / 日志辅助函数 -------------------------------------
# All status / progress / error output goes to stderr so functions that
# `printf` real data to stdout (e.g. download_and_verify, resolve_latest_version)
# can be safely captured via `$(...)` without log lines polluting the return.
# 所有状态 / 进度 / 错误信息都写到 stderr；这样 download_and_verify、
# resolve_latest_version 等通过 `$(...)` 捕获返回值的函数不会把日志混进结果。
info() {
    printf '%s\n' "[quilin-install] $*" >&2
}

warn() {
    printf '%s\n' "[quilin-install] WARN: $*" >&2
}

err() {
    printf '%s\n' "[quilin-install] ERROR: $*" >&2
}

# Execute or print depending on --dry-run.
# Callers pass a single shell command string; we evaluate it via `sh -c`.
# 根据 --dry-run 决定打印还是执行。调用方传入单条 shell 命令字符串，通过
# `sh -c` 解析，避免 `eval` 带来的引号陷阱。
run() {
    cmd="$*"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s\n' "[quilin-install] [DRY-RUN] $cmd" >&2
    else
        sh -c "$cmd"
    fi
}

# Yes/no prompt; auto-yes when --yes or non-interactive (no /dev/tty).
# 是/否确认；--yes 或没有 /dev/tty 时自动同意。
confirm() {
    prompt="$1"
    if [ "$ASSUME_YES" -eq 1 ]; then
        return 0
    fi
    if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
        info "Non-interactive shell, assuming 'yes' for: $prompt"
        return 0
    fi
    printf '%s [y/N]: ' "$prompt" >&2
    if [ -r /dev/tty ]; then
        # shellcheck disable=SC2162
        read ans < /dev/tty || ans=""
    else
        # shellcheck disable=SC2162
        read ans || ans=""
    fi
    case "$ans" in
        y|Y|yes|YES|Yes) return 0 ;;
        *) return 1 ;;
    esac
}

# -------- Cleanup on exit / 退出清理 -----------------------------------------
cleanup() {
    rc=$?
    if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR" 2>/dev/null || true
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'err "Interrupted"; exit 130' INT TERM HUP

# -------- Help / 帮助 ---------------------------------------------------------
print_help() {
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

# -------- Argument parsing / 参数解析 ----------------------------------------
# Single-pass POSIX parser; supports --flag and --flag=value.
# 单次 POSIX 解析；支持 --flag 与 --flag=value 两种形式。
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --upgrade)        UPGRADE=1; shift ;;
            --dry-run)        DRY_RUN=1; shift ;;
            --no-deps)        NO_DEPS=1; shift ;;
            --yes|-y)         ASSUME_YES=1; shift ;;
            --help|-h)        print_help; exit 0 ;;
            --prefix)         PREFIX="$2"; shift 2 ;;
            --prefix=*)       PREFIX="${1#--prefix=}"; shift ;;
            --version)        VERSION="$2"; shift 2 ;;
            --version=*)      VERSION="${1#--version=}"; shift ;;
            --)               shift; break ;;
            *)
                err "Unknown option: $1"
                err "Run with --help for usage"
                exit 1
                ;;
        esac
    done
}

# -------- OS / arch detection / 系统与架构检测 -------------------------------
# Detect supported platforms; Windows is rejected with a WSL pointer.
# 检测受支持平台；Windows 拒绝并提示使用 WSL。
detect_platform() {
    uname_s="$(uname -s 2>/dev/null || echo unknown)"
    uname_m="$(uname -m 2>/dev/null || echo unknown)"

    case "$uname_s" in
        Darwin)  OS="macos" ;;
        Linux)   OS="linux" ;;
        MINGW*|MSYS*|CYGWIN*)
            err "Windows native shells are not supported."
            err "Please install via WSL (Windows Subsystem for Linux), or follow"
            err "the manual setup in docs/09-deployment-runtime/install-guide.md."
            exit 1
            ;;
        *)
            err "Unsupported OS: $uname_s"
            err "Supported: macOS (Darwin), Linux."
            exit 1
            ;;
    esac

    case "$uname_m" in
        arm64|aarch64) ARCH="arm64" ;;
        x86_64|amd64)  ARCH="x86_64" ;;
        *)
            err "Unsupported CPU architecture: $uname_m"
            err "Supported: arm64, x86_64."
            exit 1
            ;;
    esac

    info "Detected platform: $OS/$ARCH"
}

# -------- Dependency probing / 依赖探测 --------------------------------------
have_cmd() {
    command -v "$1" >/dev/null 2>&1
}

# Auto-install Bun via the official installer.
# 通过官方脚本自动安装 Bun。
install_bun() {
    info "Installing Bun via https://bun.sh/install ..."
    if [ "$DRY_RUN" -eq 1 ]; then
        info "[DRY-RUN] curl -fsSL https://bun.sh/install | bash"
        return 0
    fi
    if ! curl -fsSL https://bun.sh/install | bash; then
        err "Bun installer failed."
        return 1
    fi
    # Bun installs to ~/.bun; expose it on PATH for the rest of this script.
    # Bun 默认装到 ~/.bun，这里把它加入当前脚本 PATH。
    if [ -d "$HOME/.bun/bin" ]; then
        PATH="$HOME/.bun/bin:$PATH"
        export PATH
    fi
    return 0
}

# Auto-install uv via the official installer.
# 通过官方脚本自动安装 uv。
install_uv() {
    info "Installing uv via https://astral.sh/uv/install.sh ..."
    if [ "$DRY_RUN" -eq 1 ]; then
        info "[DRY-RUN] curl -LsSf https://astral.sh/uv/install.sh | sh"
        return 0
    fi
    if ! curl -LsSf https://astral.sh/uv/install.sh | sh; then
        err "uv installer failed."
        return 1
    fi
    if [ -d "$HOME/.local/bin" ]; then
        PATH="$HOME/.local/bin:$PATH"
        export PATH
    fi
    if [ -d "$HOME/.cargo/bin" ]; then
        PATH="$HOME/.cargo/bin:$PATH"
        export PATH
    fi
    return 0
}

# Check / install required tooling.
# 检查并按需安装必备工具。
ensure_dependencies() {
    # git is non-negotiable and not auto-installed.
    # git 是硬依赖，不做自动安装。
    if ! have_cmd git; then
        err "git is required but not found."
        err "Install git first:"
        err "  macOS:        xcode-select --install   # or: brew install git"
        err "  Debian/Ubuntu: sudo apt-get install git"
        err "  Fedora/RHEL:   sudo dnf install git"
        exit 2
    fi

    # curl is required for download and provider installers.
    # curl 必须存在，否则连下载安装脚本都无法做。
    if ! have_cmd curl; then
        err "curl is required but not found. Install curl, then re-run."
        exit 2
    fi

    # tar is required for extraction.
    # tar 用于解压发布包。
    if ! have_cmd tar; then
        err "tar is required but not found."
        exit 2
    fi

    if [ "$NO_DEPS" -eq 1 ]; then
        info "Skipping Bun / uv auto-install (--no-deps)"
        return 0
    fi

    if ! have_cmd bun; then
        if confirm "Bun runtime not found. Install it now?"; then
            install_bun || exit 5
        else
            err "Bun is required to run Quilin. Aborting."
            exit 2
        fi
    fi

    if ! have_cmd uv; then
        if confirm "uv (Python package manager) not found. Install it now?"; then
            install_uv || exit 5
        else
            err "uv is required for the Python providers. Aborting."
            exit 2
        fi
    fi
}

# -------- Path resolution / 路径解析 -----------------------------------------
# Resolve install dir (--prefix > QUILIN_HOME > default) and bin dir.
# 解析安装目录（--prefix > QUILIN_HOME > 默认值）与 bin 目录。
resolve_paths() {
    if [ -n "$PREFIX" ]; then
        INSTALL_DIR="$PREFIX"
    else
        INSTALL_DIR="$DEFAULT_INSTALL_DIR"
    fi
    BIN_DIR="$DEFAULT_BIN_DIR"

    info "Install dir: $INSTALL_DIR"
    info "Wrapper bin dir: $BIN_DIR"

    # Warn if bin dir isn't on PATH so the user knows to add it.
    # 如果 bin 目录不在 PATH 上，提醒用户手动加入。
    case ":$PATH:" in
        *":$BIN_DIR:"*)  : ;;
        *)
            warn "$BIN_DIR is not on your \$PATH."
            warn "Add it to your shell profile, e.g.:"
            warn "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile"
            ;;
    esac
}

# -------- Release lookup / 发布版本解析 --------------------------------------
# GitHub redirects /releases/latest to /releases/tag/<tag>; follow it to learn
# the latest tag without authentication or jq.
# GitHub 会把 /releases/latest 重定向到 /releases/tag/<tag>，跟随重定向即可
# 取到最新 tag，无需 API token 或 jq。
resolve_latest_version() {
    latest_url="https://github.com/$QUILIN_GITHUB_OWNER/$QUILIN_GITHUB_REPO/releases/latest"
    info "Resolving latest version from $latest_url ..."
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s' "v0.0.0-dryrun"
        return 0
    fi
    final_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$latest_url" 2>/dev/null || true)"
    if [ -z "$final_url" ]; then
        err "Could not resolve latest release URL. Specify --version explicitly."
        exit 3
    fi
    tag="${final_url##*/}"
    if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
        err "Failed to parse tag from $final_url"
        exit 3
    fi
    printf '%s' "$tag"
}

# Build the tarball URL for a given version, honoring overrides.
# 根据版本号构造 tarball URL，遵循环境变量覆盖。
build_tarball_url() {
    ver="$1"
    if [ -n "$TARBALL_URL_OVERRIDE" ]; then
        printf '%s' "$TARBALL_URL_OVERRIDE"
        return 0
    fi
    printf 'https://github.com/%s/%s/releases/download/%s/quilin-core-%s.tar.gz' \
        "$QUILIN_GITHUB_OWNER" "$QUILIN_GITHUB_REPO" "$ver" "$ver"
}

build_checksum_url() {
    tarball_url="$1"
    if [ -n "$CHECKSUM_URL_OVERRIDE" ]; then
        printf '%s' "$CHECKSUM_URL_OVERRIDE"
        return 0
    fi
    printf '%s.sha256' "$tarball_url"
}

# -------- Workspace + download / 工作区与下载 --------------------------------
prepare_workspace() {
    WORK_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t quilin-install)"
    info "Workspace: $WORK_DIR"
}

# Download tarball + sha256, verify, return tarball path via stdout.
# 下载 tarball 与 sha256，校验通过后通过 stdout 返回 tarball 路径。
download_and_verify() {
    ver="$1"
    tarball_url="$(build_tarball_url "$ver")"
    checksum_url="$(build_checksum_url "$tarball_url")"

    tarball_path="$WORK_DIR/quilin-core.tar.gz"
    checksum_path="$WORK_DIR/quilin-core.tar.gz.sha256"

    info "Downloading tarball: $tarball_url"
    if [ "$DRY_RUN" -eq 1 ]; then
        info "[DRY-RUN] curl -fSL -o '$tarball_path' '$tarball_url'"
        info "[DRY-RUN] curl -fSL -o '$checksum_path' '$checksum_url'"
        info "[DRY-RUN] Verify sha256 of '$tarball_path'"
        printf '%s' "$tarball_path"
        return 0
    fi

    if ! curl -fSL --retry 3 --retry-delay 2 -o "$tarball_path" "$tarball_url"; then
        err "Failed to download tarball from $tarball_url"
        exit 3
    fi

    info "Downloading checksum: $checksum_url"
    if ! curl -fSL --retry 3 --retry-delay 2 -o "$checksum_path" "$checksum_url"; then
        err "Failed to download checksum from $checksum_url"
        exit 3
    fi

    info "Verifying sha256 ..."
    expected="$(awk '{print $1}' "$checksum_path")"
    if [ -z "$expected" ]; then
        err "Checksum file is empty or malformed: $checksum_path"
        exit 4
    fi

    # Prefer shasum (macOS / portable). Fall back to sha256sum (Linux).
    # 优先使用 shasum (macOS / 通用)；不可用时退回 sha256sum (Linux)。
    if have_cmd shasum; then
        actual="$(shasum -a 256 "$tarball_path" | awk '{print $1}')"
    elif have_cmd sha256sum; then
        actual="$(sha256sum "$tarball_path" | awk '{print $1}')"
    else
        err "Neither shasum nor sha256sum is available."
        exit 4
    fi

    if [ "$expected" != "$actual" ]; then
        err "Checksum mismatch!"
        err "  expected: $expected"
        err "  actual:   $actual"
        exit 4
    fi
    info "Checksum OK"
    printf '%s' "$tarball_path"
}

# -------- Install steps / 安装步骤 -------------------------------------------
# Remove a prior install if present (after --upgrade confirmation).
# 如已存在旧安装，在 --upgrade 确认后删除。
maybe_clear_existing() {
    if [ ! -e "$INSTALL_DIR" ]; then
        return 0
    fi
    if [ "$UPGRADE" -ne 1 ]; then
        err "Install dir already exists: $INSTALL_DIR"
        err "Re-run with --upgrade to overwrite, or use --prefix to install elsewhere."
        exit 1
    fi
    if ! confirm "Remove existing install at $INSTALL_DIR ?"; then
        err "Aborted by user."
        exit 1
    fi
    info "Removing $INSTALL_DIR ..."
    run "rm -rf \"$INSTALL_DIR\""
}

# Extract the tarball into INSTALL_DIR. Supports payloads with or without a
# top-level directory: if the archive has a single top-level dir, strip it.
# 解压 tarball 到 INSTALL_DIR。兼容是否包含顶层目录：若只有单一顶层目录，自动 strip。
extract_tarball() {
    tarball_path="$1"
    info "Extracting to $INSTALL_DIR ..."
    run "mkdir -p \"$INSTALL_DIR\""

    if [ "$DRY_RUN" -eq 1 ]; then
        info "[DRY-RUN] tar -xzf '$tarball_path' -C '$INSTALL_DIR' --strip-components=1"
        return 0
    fi

    # Detect top-level directory layout.
    # 检测顶层目录布局。
    top_count="$(tar -tzf "$tarball_path" | awk -F/ '{print $1}' | sort -u | wc -l | tr -d ' ')"
    if [ "$top_count" = "1" ]; then
        tar -xzf "$tarball_path" -C "$INSTALL_DIR" --strip-components=1
    else
        tar -xzf "$tarball_path" -C "$INSTALL_DIR"
    fi
}

# Install JS + Python deps inside the extracted tree.
# 在解压后的目录里安装 JS 与 Python 依赖。
install_dependencies() {
    info "Installing JS dependencies (pnpm install --frozen-lockfile) ..."
    if [ "$DRY_RUN" -eq 1 ]; then
        info "[DRY-RUN] cd '$INSTALL_DIR' && bun x --bun pnpm install --frozen-lockfile"
    else
        # Bun bundles a pnpm-compatible CLI via `bun x pnpm`; this avoids a
        # separate pnpm install step.
        # Bun 自带 pnpm-兼容入口 `bun x pnpm`，免去额外安装。
        (cd "$INSTALL_DIR" && bun x --bun pnpm install --frozen-lockfile) || {
            err "pnpm install failed."
            exit 5
        }
    fi

    # Each Python provider has its own pyproject + uv.lock; sync them all.
    # 每个 Python provider 都有独立 pyproject 与 uv.lock，逐个 sync。
    if [ -d "$INSTALL_DIR/providers" ]; then
        for provider_dir in "$INSTALL_DIR/providers"/*/; do
            [ -d "$provider_dir" ] || continue
            [ -f "${provider_dir}pyproject.toml" ] || continue
            name="$(basename "$provider_dir")"
            info "uv sync provider: $name"
            if [ "$DRY_RUN" -eq 1 ]; then
                info "[DRY-RUN] cd '$provider_dir' && uv sync --frozen"
            else
                (cd "$provider_dir" && uv sync --frozen) || {
                    err "uv sync failed for provider: $name"
                    exit 5
                }
            fi
        done
    fi
}

# Drop the `quilin` shim into BIN_DIR. The shim execs Bun against the entrypoint.
# 在 BIN_DIR 写入 `quilin` 启动脚本，由 Bun 执行入口文件。
install_wrapper() {
    wrapper="$BIN_DIR/quilin"
    info "Installing wrapper: $wrapper"

    if [ "$DRY_RUN" -eq 1 ]; then
        info "[DRY-RUN] mkdir -p '$BIN_DIR'"
        info "[DRY-RUN] write $wrapper (exec bun ... index.ts)"
        info "[DRY-RUN] chmod +x '$wrapper'"
        return 0
    fi

    mkdir -p "$BIN_DIR"
    # Heredoc keeps QUILIN_HOME expansion lazy at exec time, so a user who
    # later moves the dir + updates QUILIN_HOME still gets a working command.
    # 用 heredoc 让 QUILIN_HOME 在执行时再展开，方便后续迁移。
    cat > "$wrapper" <<EOF
#!/bin/sh
# Quilin Agent wrapper / Quilin Agent 启动脚本
# Auto-generated by scripts/install.sh — do not edit by hand.
# 由 scripts/install.sh 自动生成，请勿手工修改。
set -eu
QUILIN_HOME="\${QUILIN_HOME:-$INSTALL_DIR}"
export QUILIN_HOME
exec bun "\$QUILIN_HOME/packages/agent-core/src/index.ts" "\$@"
EOF
    chmod +x "$wrapper"
}

# -------- Main / 主流程 -------------------------------------------------------
main() {
    parse_args "$@"
    detect_platform
    ensure_dependencies
    resolve_paths

    if [ -z "$VERSION" ] && [ -z "$TARBALL_URL_OVERRIDE" ]; then
        VERSION="$(resolve_latest_version)"
    elif [ -z "$VERSION" ]; then
        VERSION="custom"
    fi
    info "Target version: $VERSION"

    prepare_workspace
    maybe_clear_existing

    tarball="$(download_and_verify "$VERSION")"
    extract_tarball "$tarball"
    install_dependencies
    install_wrapper

    info ""
    info "=========================================="
    info " (OK) Quilin installed at $INSTALL_DIR"
    info "=========================================="
    info " Version: $VERSION"
    info " Wrapper: $BIN_DIR/quilin"
    info ""
    info " Next steps / 后续步骤:"
    info "   1) Ensure '$BIN_DIR' is on \$PATH"
    info "   2) Run: quilin"
    info "   3) The first-run welcome will guide you through model + API key + trust mode."
    info ""
}

main "$@"
