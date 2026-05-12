# 安装指南 / Install Guide

> 本指南面向最终用户，介绍如何用一条命令安装 Quilin Agent（麒麟），以及自定义路径、升级、卸载、离线安装与故障排查。
>
> This guide is for end users. It covers the one-line install command, custom paths, upgrade / uninstall flows, offline install, and troubleshooting. Bilingual paragraphs are pair-aligned: English first, Chinese second.

---

## 一键安装 / One-Line Install

The fastest path to a working installation is the curl-pipe installer hosted in the repository at `scripts/install.sh`:

最快的安装方式是通过仓库内 `scripts/install.sh` 提供的 curl 一键脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/raysonmeng/quilin-agent/master/scripts/install.sh | sh
```

The script performs these steps in order: detect OS / arch, ensure `git` / `curl` / `tar` are present, prompt to auto-install Bun and uv if missing, resolve the latest GitHub release tag, download `quilin-core-vX.Y.Z.tar.gz` plus its `.sha256`, verify the checksum, extract into the install directory, run `pnpm install --frozen-lockfile` (via `bun x pnpm`) and `uv sync --frozen` for each Python provider, then drop a wrapper script at `~/.local/bin/quilin`.

脚本依次执行：检测操作系统与架构，确认存在 `git` / `curl` / `tar`，缺少 Bun 或 uv 时询问是否自动安装，解析 GitHub 最新发布版本，下载 `quilin-core-vX.Y.Z.tar.gz` 与对应 `.sha256`，校验 sha256，解压到安装目录，对每个 Python provider 执行 `uv sync --frozen` 并通过 `bun x pnpm` 跑 `pnpm install --frozen-lockfile`，最后在 `~/.local/bin/quilin` 放一个 wrapper 脚本。

After the install finishes, simply run `quilin` and the existing first-run welcome flow will prompt for model + API key + trust mode.

安装完成后直接运行 `quilin`，已有的首次运行欢迎流程会提示选择模型、配置 API key 与信任模式。

---

## 系统要求 / System Requirements

| 项目 / Item | 支持范围 / Supported |
|---|---|
| 操作系统 / OS | macOS (Darwin), Linux |
| CPU 架构 / Arch | `arm64`, `x86_64` (amd64) |
| 必备工具 / Required tools | `git`, `curl`, `tar`, POSIX `sh` |
| 自动安装运行时 / Auto-installed runtimes | Bun (latest), uv (latest) |
| 不支持 / Not supported | 原生 Windows（请使用 WSL）/ Native Windows (use WSL) |

`git` is never auto-installed — install it via your OS package manager first (`xcode-select --install` on macOS, `apt-get install git` / `dnf install git` on Linux). Bun and uv are pulled from their official installers (`https://bun.sh/install` and `https://astral.sh/uv/install.sh`) when missing, and only after an interactive `[y/N]` confirmation.

`git` 不会被自动安装，请先用系统包管理器装好（macOS 用 `xcode-select --install`；Linux 用 `apt-get install git` 或 `dnf install git`）。Bun 与 uv 缺失时会通过官方安装脚本（`https://bun.sh/install`、`https://astral.sh/uv/install.sh`）下载，并且只在交互式 `[y/N]` 确认后才执行。

---

## 自定义安装位置 / Custom Install Location

The install dir defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/quilin`. The wrapper bin dir defaults to `$HOME/.local/bin`. Override either via environment variables or flags:

默认安装目录为 `${XDG_DATA_HOME:-$HOME/.local/share}/quilin`；wrapper 默认放在 `$HOME/.local/bin`。可通过环境变量或命令行参数覆盖：

```bash
# 方式一 / Option 1: env var (sticky across upgrades when set in shell profile)
QUILIN_HOME=/opt/quilin QUILIN_BIN=/usr/local/bin \
    curl -fsSL https://raw.githubusercontent.com/raysonmeng/quilin-agent/master/scripts/install.sh | sh

# 方式二 / Option 2: --prefix flag (one-off)
curl -fsSL .../install.sh | sh -s -- --prefix /opt/quilin
```

If the wrapper bin dir is not on `$PATH`, the script prints a warning telling you exactly what to add to your shell profile. Add this once and Quilin becomes invokable as `quilin` from any new shell:

如果 wrapper 目录不在 `$PATH` 上，脚本会打印警告并给出需要追加到 shell profile 的命令。加完后新开 shell 即可在任何位置以 `quilin` 调用：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
# zsh users: ~/.zprofile 或 ~/.zshrc
```

---

## 首次运行 / First Run

The first time you run `quilin`, the welcome ceremony in `packages/agent-core/src/cli/first-run-welcome.ts` walks you through the required + recommended onboarding steps: model provider selection, API key entry, trust mode (AUTO / ASK), and basic memory / safety preferences.

首次运行 `quilin` 时，`packages/agent-core/src/cli/first-run-welcome.ts` 中的欢迎流程会引导你完成必填与推荐步骤：模型 provider 选择、API key 录入、信任模式（AUTO / ASK）、基本记忆与安全偏好。

The agent stores its config at `${XDG_CONFIG_HOME:-$HOME/.config}/quilin/config.toml` and writable state at `$HOME/.quilin/`. The install directory itself is read-only from the agent's perspective — re-running the installer with `--upgrade` will replace it cleanly.

Agent 配置位于 `${XDG_CONFIG_HOME:-$HOME/.config}/quilin/config.toml`，可写状态位于 `$HOME/.quilin/`。从 agent 视角看安装目录是只读的，重新运行带 `--upgrade` 的安装脚本会完整替换它。

---

## 升级 / Upgrade

Re-run the installer with `--upgrade` to overwrite the install dir in-place. The script prompts before deleting, unless `--yes` is passed:

加 `--upgrade` 参数重新运行安装脚本即可原地覆盖。删除旧目录前会提示确认，加 `--yes` 跳过：

```bash
curl -fsSL .../install.sh | sh -s -- --upgrade
# 非交互场景 / Non-interactive:
curl -fsSL .../install.sh | sh -s -- --upgrade --yes
```

Pin a specific version with `--version`:

通过 `--version` 锁定版本：

```bash
curl -fsSL .../install.sh | sh -s -- --upgrade --version v0.3.0
```

A built-in `quilin update` command is planned for Phase 1+ (Linear: QUI-21 follow-ups). For now, re-running the installer is the supported upgrade path.

内建的 `quilin update` 子命令是 Phase 1+ 计划（Linear: QUI-21 后续）。当前阶段请直接重跑安装脚本。

---

## 卸载 / Uninstall

There is no scripted uninstall yet; remove these three locations to clean up everything:

目前没有专门的卸载脚本，删除以下三处即可彻底清理：

```bash
# 1) Install dir (binaries + node_modules + uv venvs)
#    安装目录（含 node_modules 与 uv 虚拟环境）
rm -rf "${QUILIN_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/quilin}"

# 2) Wrapper command
#    wrapper 启动脚本
rm -f "${QUILIN_BIN:-$HOME/.local/bin}/quilin"

# 3) User config + state (KEEP this if you plan to reinstall and want to
#    preserve memory / API keys)
#    用户配置与状态（计划重装且想保留记忆 / API key 时请不要删）
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/quilin"
rm -rf "$HOME/.quilin"
```

If you also auto-installed Bun or uv during the install and no longer need them, follow their own uninstall instructions (`rm -rf ~/.bun` for Bun; `uv self uninstall` for uv).

如果安装过程顺手装了 Bun 或 uv 现在想一并清掉，请按它们的官方卸载方式处理（Bun: `rm -rf ~/.bun`；uv: `uv self uninstall`）。

---

## 离线安装 / Offline Install

On a machine with no outbound internet to GitHub, you can fetch the tarball elsewhere and copy it over. The install dir layout is just the extracted tarball plus dependency installs.

如果目标机器无法访问 GitHub，可在其他机器下载好 tarball 再拷贝过来。安装目录的本质就是解压后的 tarball 加上依赖安装。

```bash
# 1) Download from a connected machine / 在能联网的机器下载
curl -fSL -O https://github.com/raysonmeng/quilin-agent/releases/download/v0.3.0/quilin-core-v0.3.0.tar.gz
curl -fSL -O https://github.com/raysonmeng/quilin-agent/releases/download/v0.3.0/quilin-core-v0.3.0.tar.gz.sha256

# 2) Transfer both files to the target machine, then verify
#    把两个文件拷贝到目标机器后校验
shasum -a 256 -c quilin-core-v0.3.0.tar.gz.sha256

# 3) Extract into the install dir
#    解压到安装目录
QUILIN_HOME="$HOME/.local/share/quilin"
mkdir -p "$QUILIN_HOME"
tar -xzf quilin-core-v0.3.0.tar.gz -C "$QUILIN_HOME" --strip-components=1

# 4) Install JS + Python deps (Bun + uv must already be present)
#    安装 JS 与 Python 依赖（前提是 Bun 与 uv 已经在机器上）
cd "$QUILIN_HOME" && bun x --bun pnpm install --frozen-lockfile
for d in providers/*/; do (cd "$d" && uv sync --frozen); done

# 5) Create the wrapper / 创建 wrapper
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/quilin" <<EOF
#!/bin/sh
set -eu
QUILIN_HOME="\${QUILIN_HOME:-$QUILIN_HOME}"
exec bun "\$QUILIN_HOME/packages/agent-core/src/index.ts" "\$@"
EOF
chmod +x "$BIN_DIR/quilin"
```

---

## 自启服务 / Service Autostart

To run Quilin as a background daemon (macOS `launchd` / Linux `systemd`), use the built-in service command after a successful install:

把 Quilin 作为后台守护进程运行（macOS `launchd` / Linux `systemd`），安装完成后直接调用内建命令：

```bash
quilin service install     # 安装并启动 / install + start
quilin service status      # 查看状态 / show status
quilin service uninstall   # 卸载 / remove
```

The implementation lives in `packages/agent-core/src/cli/service-cmd.ts` and writes a `com.quilin.agent` plist (macOS) or unit file (Linux) under the user scope (no sudo required).

具体实现位于 `packages/agent-core/src/cli/service-cmd.ts`，生成的是用户级 `com.quilin.agent` plist（macOS）或 systemd unit（Linux），不需要 sudo。

---

## 故障排查 / Troubleshooting

### `command not found: quilin`

The wrapper bin dir is not on `$PATH`. Re-read the script's final warning, or add `$HOME/.local/bin` to `$PATH`:

wrapper 目录不在 `$PATH` 上。重看脚本最后的警告，或把 `$HOME/.local/bin` 加进 `$PATH`：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile && source ~/.profile
```

### `Checksum mismatch`

The tarball downloaded but its sha256 doesn't match. Causes: corrupted download, MITM, or a stale `.sha256` file. Retry; if it still fails, download manually from the GitHub release page and verify locally with `shasum -a 256 -c`.

tarball 下载完成但 sha256 不匹配。原因可能是下载损坏、中间人、`.sha256` 与 tarball 版本不一致。重试一次；仍失败则手动从 GitHub release 页面下载并用 `shasum -a 256 -c` 校验。

### `Bun runtime not found` even after install

Bun installs to `~/.bun/bin` and only patches the shell rc files for new shells. Open a new terminal, or `export PATH="$HOME/.bun/bin:$PATH"` in the current shell.

Bun 默认安装在 `~/.bun/bin`，只会写入 shell rc 给新会话用。请新开终端，或在当前会话执行 `export PATH="$HOME/.bun/bin:$PATH"`。

### `pnpm install failed`

The bundled `pnpm-lock.yaml` requires network access to download package tarballs from the npm registry. Check connectivity, proxy variables (`HTTPS_PROXY`), and that you're not behind a firewall that blocks `registry.npmjs.org`.

打包好的 `pnpm-lock.yaml` 仍需通过 npm registry 下载依赖。请确认网络连通性、代理设置（`HTTPS_PROXY`），以及 `registry.npmjs.org` 是否被防火墙封禁。

### `uv sync failed`

Similar story for Python — uv needs PyPI access. If your environment uses a private index, set `UV_INDEX_URL` before running the installer with `--no-deps` and the uv sync step manually.

Python 端同理 — uv 需要 PyPI。若你用的是私有 index，请先设置 `UV_INDEX_URL`，然后用 `--no-deps` 跑安装脚本并自行 `uv sync`。

### `better-sqlite3` native build fails

`pnpm install` builds the `better-sqlite3` native module via `node-gyp`. If you see errors like `Symbol not found: _XML_SetAllocTrackerActivationThreshold` or generic `make` failures, it means your local Python (used by `node-gyp`) is mismatched. Workaround: install Xcode CLT (`xcode-select --install`) and ensure a system Python 3 with intact `xml.parsers.expat` is on `$PATH`. On macOS with Homebrew Python 3.14 you may need `brew reinstall expat` and re-link.

`pnpm install` 会通过 `node-gyp` 编译 `better-sqlite3` 原生模块。若看到 `Symbol not found: _XML_SetAllocTrackerActivationThreshold` 或 `make` 失败这类错误，通常是本地 Python（被 node-gyp 调用）出问题。建议先 `xcode-select --install` 装好 macOS 命令行工具，并确保 `$PATH` 上有自带完好 `xml.parsers.expat` 的 Python 3；Homebrew Python 3.14 用户可能需要 `brew reinstall expat` 重新 link。

### `Permission denied: ~/.local/bin/quilin`

The wrapper was created but its mode isn't `+x`. Re-run the installer with `--upgrade`, or `chmod +x ~/.local/bin/quilin`.

wrapper 已创建但不可执行。重跑 `--upgrade` 或手动 `chmod +x ~/.local/bin/quilin`。

### `Port 3000 already in use` (first run)

`QUILIN_PORT` defaults to 3000. Export a different port in your shell or set `quilin_port` in the user config before running `quilin`.

`QUILIN_PORT` 默认 3000。设置环境变量改端口，或在用户 config 里写 `quilin_port`。

### `API key not set`

The first-run welcome detects missing keys and prompts. If you skipped it, run `quilin config set llm.deepseek.api_key sk-...` (replace with your provider key) or edit `~/.config/quilin/config.toml` directly.

首次运行欢迎流程会检测并提示缺失的 key。跳过了的话可以用 `quilin config set llm.deepseek.api_key sk-...`（替换为你的 provider key），或直接编辑 `~/.config/quilin/config.toml`。

---

## 上游 submodule (可选) / Upstream Submodules (optional)

The public install tarball deliberately excludes `upstreams/` (~100 git submodules, several GB) because the core agent doesn't need them at runtime. They are only required for fusion-PR development workflows like `scripts/sync-upstreams.py` and `scripts/merge-with-claude.sh`.

公共安装包刻意排除 `upstreams/`（约 100 个 git submodule，数 GB），因为运行时 agent 用不到。它们只在 fusion-PR 开发流程里（如 `scripts/sync-upstreams.py` 与 `scripts/merge-with-claude.sh`）需要。

If you want the full source-and-upstream tree (power user / contributor path), clone the repo recursively instead of using the installer:

如果你需要完整的源码 + upstream 树（贡献者 / 高级用户），请直接 recursive clone 而不是用安装脚本：

```bash
git clone --recursive --depth 1 https://github.com/raysonmeng/quilin-agent.git
cd quilin-agent
just init     # pnpm install + uv sync
just dev      # 本地开发模式 / local dev mode
```

---

## 安全说明 / Security Notes

The `curl … | sh` pattern executes arbitrary code from the network and should be inspected before trust. To audit before running:

`curl … | sh` 会从网络上直接执行任意代码。运行前可以这样审计：

```bash
curl -fsSL https://raw.githubusercontent.com/raysonmeng/quilin-agent/master/scripts/install.sh > install.sh
less install.sh                 # 阅读脚本 / read it
shasum -a 256 install.sh        # 与上游 commit 中的 sha256 对比 / compare to upstream
sh install.sh --dry-run         # 预览动作 / preview actions
sh install.sh                   # 真正执行 / actually install
```

What we do to make this safer:

为降低风险，我们做了以下工作：

- The tarball is **checksum-verified** against an adjacent `.sha256` file produced by `scripts/release.sh` and uploaded to the same GitHub release.
- 发布包通过同一 release 中的 `.sha256` 文件进行 **sha256 校验**，由 `scripts/release.sh` 生成并上传。
- Bun and uv are pulled from **official installer scripts** (`bun.sh`, `astral.sh`) and only after **interactive confirmation** — pass `--no-deps` to skip auto-install entirely.
- Bun 与 uv 均来自 **官方安装脚本**（`bun.sh`、`astral.sh`），且必须 **交互式确认** 才会执行 — 传 `--no-deps` 可完全跳过自动安装。
- The installer **never** runs anything as root, never modifies `$PATH` files outside the user's home dir, and never writes outside `$QUILIN_HOME` and `$QUILIN_BIN`.
- 安装脚本 **从不** 以 root 运行，从不修改用户主目录外的 `$PATH` 文件，从不写入 `$QUILIN_HOME` 与 `$QUILIN_BIN` 之外的位置。
- All downloads use `curl -fSL` (`-f` fails on HTTP errors so a hijacked redirect cannot silently succeed).
- 所有下载使用 `curl -fSL`（`-f` 在 HTTP 错误时直接失败，防止被劫持的 302 重定向悄悄成功）。

---

## 相关文档 / Related Docs

- [docs/09-deployment-runtime/README.md](./README.md) — runtime architecture / 运行时整体架构
- [docs/09-deployment-runtime/dev-repl-ux.md](./dev-repl-ux.md) — REPL UX / REPL 用户体验
- [scripts/release.sh](../../scripts/release.sh) — tarball builder / tarball 构建脚本
- [scripts/install.sh](../../scripts/install.sh) — the installer / 安装脚本本体
