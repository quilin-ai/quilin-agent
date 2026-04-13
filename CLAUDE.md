# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Quilin Agent（拼布麒麟）is a dynamic, self-evolving Agent framework that monitors 10 capability domains (LLM Integration, Context, Memory, Planning, Tools, Multi-Agent, Safety, Observability, Deployment, Self-Evolution) x Top 10 open-source projects each (~100 total upstreams). It auto-syncs upstream changes, uses Claude Code to intelligently analyze diffs, generates fusion patches, and publishes new versions.

## Architecture

- **Central Orchestration**: LangGraph as the state graph core
- **Layered Memory**: in-prompt (short) -> Hindsight Reflect (mid) -> OmniMem + KG (long) -> gbrain (ultra-long)
- **Plugin System**: Each layer's Top 10 projects implement a unified `LayerProvider` Protocol interface
- **Protocol**: All inter-layer communication via MCP (Model Context Protocol) through `MCPBus`
- **Core Pattern**: E-T-C-S-L-V six-component architecture (Execution / Tools / Context / State / Lifecycle / Verification)

## Commands

```bash
# Run core harness
python -m quilin.core.Harness

# Sync upstreams (single check)
python scripts/sync-upstreams.py

# Sync upstreams (daemon mode, every 5 min)
python scripts/sync-upstreams.py --daemon

# Claude-powered merge for a specific upstream update
bash scripts/merge-with-claude.sh <submodule-name> [diff-summary]

# Release new version
bash scripts/release.sh              # auto patch bump
bash scripts/release.sh --minor      # minor version
bash scripts/release.sh --dry-run    # preview only

# Initialize all submodules (first time setup)
bash scripts/init-all-submodules.sh
git submodule update --init --recursive

# Setup cron for auto-sync
bash scripts/setup-cron.sh
bash scripts/setup-cron.sh --status
bash scripts/setup-cron.sh --remove

# Docker
docker build -t quilin-agent .
docker run -d -e ANTHROPIC_API_KEY=your_key quilin-agent
```

## Directory Structure

```
quilin-agent/
├── upstreams/                  # ~100 git submodules (auto-synced, --depth 1)
│   ├── memory-*/               # Domain: Memory
│   ├── llm-*/                  # Domain: LLM Brain / Inference
│   ├── perception-*/           # Domain: Perception / Multimodal
│   └── ...                     # Domains 4-10
├── quilin/                     # Core fused code
│   ├── core/Harness.py         # Main entry: Quilin class + LangGraph state machine
│   ├── core/messages.py        # Message/ToolCall/ToolResult dataclasses
│   ├── core/llm.py             # LLM 接入（待重写为单一模型 + litellm）
│   ├── layers/                 # Per-layer provider adapters
│   ├── plugins/                # Pluggable Top10 implementations
│   └── config.yaml             # SOTA combination config
├── docs/
│   ├── architecture/
│   │   ├── overview.md         # 架构总览（10 领域全景图 + 导航）
│   │   └── fusion-index.md     # 融合索引（功能来源追踪）
│   ├── engineering/
│   │   ├── 01-llm-integration.md   # LLM 接入工程
│   │   ├── 02-context.md           # 上下文工程
│   │   ├── 03-memory.md            # 记忆工程
│   │   ├── 04-planning.md          # 规划工程
│   │   ├── 05-tool.md              # 工具工程
│   │   ├── 06-multi-agent.md       # 多 Agent 工程
│   │   ├── 07-safety-guardrails.md # 安全护栏工程
│   │   ├── 08-observability.md     # 可观测性工程
│   │   ├── 09-deployment-runtime.md # 部署运行时工程
│   │   └── 10-self-evolution.md    # 自进化工程
│   ├── research/
│   │   └── model-architecture-insights.md  # 6 模型设计参考
│   └── implementation-plan.md  # 8 Phase 实施计划
├── scripts/
│   ├── init-all-submodules.sh  # First-time: add all submodules
│   ├── sync-upstreams.py       # Poll upstreams for new commits
│   ├── merge-with-claude.sh    # Claude-powered diff analysis + fusion patch
│   ├── release.sh              # Auto commit / tag / push
│   └── setup-cron.sh           # Install/remove crontab for auto-sync
├── Dockerfile
├── requirements.txt
└── readme.md
```

## Key Abstractions in Harness.py

- `LayerProvider` — Protocol interface all upstream adapters must implement
- `MCPBus` — Inter-layer message bus using MCP protocol
- `OmniMem` — Hierarchical memory (4-tier: short/mid/long/ultra) with auto-reflect
- `PluginRegistry` — Central registry for all layer providers
- `Quilin.run()` — Main agent loop following the state graph: verify_input -> build_context -> plan -> execute_tools -> verify_output -> reflect -> decide

## Important Constraints

- Do not modify local language environment versions (Go, Python, Node, etc.)
- Never execute SQL scripts directly
- Primary language: Python 3.11+ (core harness code)
- All Provider adapters must implement the `LayerProvider` Protocol
- Submodules use `--depth 1` (shallow clone) to save disk space
