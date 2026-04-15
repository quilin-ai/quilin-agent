# Quilin Agent — 跨语言开发编排
# 使用: just <command>

set dotenv-load := true

# ============ 一键操作 ============

# 一键初始化（新机器第一次）
init:
    pnpm install
    cd providers/memory && uv sync --extra dev
    cargo build --workspace
    cp -n .env.example .env 2>/dev/null || true
    @echo '✅ All dependencies installed. Edit .env with your API keys.'

# 一键启动全部服务（后台）
start:
    mkdir -p .logs
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"Starting all services..."}'
    @nohup sh -c 'cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m omnimem' > .logs/omnimem.log 2>&1 &
    @sleep 2
    @nohup env LOG_LEVEL=debug QUILIN_ENV=dev QUILIN_RUNTIME_MODE=service bun run packages/agent-core/src/index.ts > .logs/agent-core.log 2>&1 &
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"All services started. Use Monitor to watch."}'

# 一键停止全部
stop:
    @pkill -f "bun run.*agent-core" || true
    @pkill -f "python -m omnimem" || true
    @echo '{"ts":"'"$(date -Iseconds)"'","level":"info","service":"quilin","msg":"All services stopped."}'

# 一键重启
restart: stop start

# 一键测试全部
test-all: test test-py test-rs

# 一键质量检查
check: lint fmt

# 一键清理
clean:
    pnpm -r exec -- rm -rf dist
    cd providers/memory && rm -rf .venv __pycache__
    cargo clean

# ============ TS (packages/) ============

# 开发模式（前台，直接看日志）
dev:
    cd packages/agent-core && LOG_LEVEL=debug QUILIN_ENV=dev QUILIN_RUNTIME_MODE=repl bun run --watch src/index.ts

# 测试
test:
    cd packages/agent-core && QUILIN_ENV=test bun run vitest run

# Lint + Format
lint:
    cd packages/agent-core && bun run biome check src/
fmt:
    cd packages/agent-core && bun run biome format --write src/

# 构建
build:
    cd packages/agent-core && bun build src/index.ts --outdir dist --target node

# ============ Python (providers/) ============

dev-memory:
    cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m omnimem

test-py:
    cd providers/memory && QUILIN_ENV=test uv run pytest

lint-py:
    cd providers/memory && uv run ruff check src/ tests/
fmt-py:
    cd providers/memory && uv run ruff format src/ tests/

# ============ Rust (crates/) ============

build-rs:
    cargo build --workspace

test-rs:
    cargo test --workspace

lint-rs:
    cargo clippy --workspace -- -D warnings
fmt-rs:
    cargo fmt --all

# ============ 生产 ============

prod:
    LOG_LEVEL=info QUILIN_ENV=prod QUILIN_RUNTIME_MODE=service bun run packages/agent-core/dist/index.js

# ============ 内部 ============

_start-core:
    LOG_LEVEL=debug QUILIN_ENV=dev QUILIN_RUNTIME_MODE=service bun run packages/agent-core/src/index.ts

_start-memory:
    cd providers/memory && LOG_LEVEL=debug QUILIN_ENV=dev uv run python -m omnimem
