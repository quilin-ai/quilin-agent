# Quilin Agent — 跨语言开发编排
# 使用: just <command>

set dotenv-load := true

# ============ 一键操作 ============

# 一键初始化（新机器第一次）
init:
    pnpm install
    cd providers/memory && uv sync --extra dev
    cp -n .env.example .env 2>/dev/null || true
    @echo '✅ All dependencies installed. Edit .env with your API keys.'

# 一键启动全部服务（后台）
start:
    mkdir -p .logs
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"Starting all services..."}'
    @nohup sh -c 'cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m quilin_mem' > .logs/quilin-mem.log 2>&1 &
    @sleep 2
    @nohup env LOG_LEVEL=debug QUILIN_ENV=dev QUILIN_RUNTIME_MODE=service bun run packages/agent-core/src/index.ts > .logs/agent-core.log 2>&1 &
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"All services started. Use Monitor to watch."}'

# 一键停止全部
stop:
    @pkill -f "bun run.*agent-core" || true
    @pkill -f "python -m quilin_mem" || true
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"All services stopped."}'

# 一键重启
restart: stop start

# 一键测试全部
test-all: test web-test test-py test-rs

# 一键质量检查
check: lint fmt lint-docs-process

# 一键清理
clean:
    pnpm -r exec -- rm -rf dist
    cd providers/memory && rm -rf .venv __pycache__

# ============ TS (packages/) ============

# 日志档语义（所有 dev 系列 recipe 共用）：
#   不传     → 默认级别日志（info） — 评估能力 / 跟 agent 对话用
#   quiet    → 没有日志（silent）   — 演示 / 截图 / 日志噪音掩盖回答时
#   verbose  → 详细日志（debug）    — 找 bug / 排查 LLM provider 问题
#   也接受任意 LOG_LEVEL 原始值：silent / fatal / error / warn / info / debug / trace

# 开发模式（默认 ASK 模式：CRITICAL 才确认）
# 例：just dev / just dev quiet / just dev verbose
dev log="info":
    LOG_LEVEL={{ if log == "quiet" { "silent" } else if log == "verbose" { "debug" } else { log } }} QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun --env-file=.env --watch packages/agent-core/src/index.ts

# 兼容别名：dev-quiet / dev-debug 仍可用
dev-quiet:
    @just dev quiet

dev-debug:
    @just dev verbose

# Yolo 模式：全自动放行，不询问任何确认（CRITICAL 操作仍会确认）
# 例：just dev-yolo / just dev-yolo quiet / just dev-yolo verbose
dev-yolo log="info":
    LOG_LEVEL={{ if log == "quiet" { "silent" } else if log == "verbose" { "debug" } else { log } }} QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun --env-file=.env --watch packages/agent-core/src/index.ts -- --yolo

# 一次性模式（不带 --watch）：评估对话能力时用
# 当并行有别的 agent / 编辑器在改源码，bun --watch 会反复 reload entry，
# 触发 capabilities hot-reload 死循环（重打 banner / 清屏 / 反复 spawn MCP /
# 旧 Python 子进程变孤儿）。dev-once 关掉 watch，源码改动不再触发 reload，
# 适合真实评估 REPL 行为或并发开发场景。yolo 模式（不询问 non-CRITICAL）。
# 例：just dev-once / just dev-once quiet / just dev-once verbose
dev-once log="info":
    LOG_LEVEL={{ if log == "quiet" { "silent" } else if log == "verbose" { "debug" } else { log } }} QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun --env-file=.env packages/agent-core/src/index.ts -- --yolo

# Ask 模式：所有写入都需确认
# 例：just dev-ask / just dev-ask quiet / just dev-ask verbose
dev-ask log="info":
    LOG_LEVEL={{ if log == "quiet" { "silent" } else if log == "verbose" { "debug" } else { log } }} QUILIN_TRUST_MODE=ask QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun --env-file=.env --watch packages/agent-core/src/index.ts

# 恢复最近会话（前台，带 watch）
# 例：just dev-resume / just dev-resume quiet / just dev-resume verbose
dev-resume log="info":
    LOG_LEVEL={{ if log == "quiet" { "silent" } else if log == "verbose" { "debug" } else { log } }} QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun --env-file=.env --watch packages/agent-core/src/index.ts --resume-latest

# 恢复最近会话（前台，无 watch）
# 例：just resume / just resume quiet / just resume verbose
resume log="info":
    LOG_LEVEL={{ if log == "quiet" { "silent" } else if log == "verbose" { "debug" } else { log } }} QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun --env-file=.env packages/agent-core/src/index.ts --resume-latest

# 测试
test:
    cd packages/agent-core && QUILIN_ENV=test bun run test

# Lint + Format
lint:
    cd packages/agent-core && bun run biome check src/
fmt:
    cd packages/agent-core && bun run biome format --write src/

# Docs/process lint
lint-docs-process:
    python3 scripts/test_lint_docs_process.py
    python3 scripts/lint-glossary.py
    python3 scripts/lint-docs-process.py --strict-warnings

# 构建
build:
    cd packages/agent-core && bun build src/index.ts --outdir dist --target node

# ============ Web UI (apps/web — Next.js 15) ============

# 前端 + API 路由开发服务器（Next.js dev，默认 127.0.0.1:3000）
dev-web:
    pnpm --filter @quilin/web dev

# 生产构建
web-build:
    pnpm --filter @quilin/web build

# 单元测试（vitest）
web-test:
    pnpm --filter @quilin/web test

# 单元测试 + 覆盖率（≥95% gate）
web-test-coverage:
    pnpm --filter @quilin/web exec vitest run --coverage

# 端到端测试（playwright）
web-e2e:
    pnpm --filter @quilin/web exec playwright test

# 类型检查
web-typecheck:
    pnpm --filter @quilin/web exec tsc --noEmit

# Lint（biome）
web-lint:
    pnpm --filter @quilin/web exec biome check

# ============ Python (providers/) ============

dev-memory:
    cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m quilin_mem

# Python Crawl4AI MCP provider (providers/web)。前端 Next.js 用 `just dev-web`。
dev-web-py:
    cd providers/web && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m quilin_web

test-py:
    cd providers/memory && QUILIN_ENV=test uv run pytest
    cd providers/web && QUILIN_ENV=test uv run pytest
    cd providers/optimizer && QUILIN_ENV=test uv run pytest

test-memory-integrity:
    tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT; cd providers/memory && QUILIN_INTEGRITY_DB="$tmpdir" QUILIN_ENV=test uv run pytest tests/test_memory_integrity.py -v --no-cov

lint-py:
    cd providers/memory && uv run ruff check src/ tests/
    cd providers/web && uv run ruff check src/ tests/
    cd providers/optimizer && uv run ruff check src/ tests/
fmt-py:
    cd providers/memory && uv run ruff format src/ tests/
    cd providers/web && uv run ruff format src/ tests/
    cd providers/optimizer && uv run ruff format src/ tests/

# ============ Rust (crates/) ============

build-rs:
    cargo check --workspace

test-rs:
    cargo test --workspace

lint-rs:
    cargo clippy --workspace --all-targets -- -D warnings
fmt-rs:
    cargo fmt --all

# ============ 发布 / 分发 ============

# Build the public core tarball + sha256 (excludes upstreams/, build artifacts).
# 构建对外发布的 core tarball 与 sha256（排除 upstreams/ 与构建产物）。
release-tarball:
    bash scripts/release.sh --core

# Dry-run the installer against an ephemeral prefix to sanity-check the flow.
# `mktemp -d` already creates the dir, so we pass `--upgrade --yes` to let the
# dry-run pass the "dir exists" guard without prompting.
# 用临时目录干跑安装脚本，验证流程不出错。`mktemp -d` 已经创建了目录，
# 需要 `--upgrade --yes` 让 dry-run 越过"目录已存在"的安全检查。
install-local:
    bash scripts/install.sh --prefix=$(mktemp -d) --no-deps --dry-run --upgrade --yes

# ============ 生产 ============

prod:
    LOG_LEVEL=info QUILIN_ENV=prod QUILIN_RUNTIME_MODE=service bun run packages/agent-core/dist/index.js

# ============ 内部 ============

_start-core:
    LOG_LEVEL=debug QUILIN_ENV=dev QUILIN_RUNTIME_MODE=service bun run packages/agent-core/src/index.ts

_start-memory:
    cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m quilin_mem
