#!/usr/bin/env python3
"""
Quilin Agent — Upstream 自动同步脚本
==========================================

每 5 分钟轮询所有 upstream submodule，检测是否有新 commit。
如果有更新，自动 pull 最新代码并触发 merge-with-claude.sh。

依赖：
  - git
  - gh CLI (GitHub CLI)
  - Python 3.11+

用法：
  python scripts/sync-upstreams.py              # 单次检查
  python scripts/sync-upstreams.py --daemon     # 守护进程模式（每 5 分钟轮询）
  python scripts/sync-upstreams.py --interval 60  # 自定义间隔（秒）
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("sync-upstreams")

# 项目根目录
ROOT = Path(__file__).resolve().parent.parent
UPSTREAMS_DIR = ROOT / "upstreams"
MERGE_SCRIPT = ROOT / "scripts" / "merge-with-claude.sh"


@dataclass(frozen=True)
class SubmoduleStatus:
    """单个 submodule 的同步状态。"""

    path: str
    name: str
    local_sha: str
    remote_sha: str
    has_update: bool
    error: str | None = None


def run_cmd(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    """执行 shell 命令并返回结果。"""
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def get_submodules() -> list[dict[str, str]]:
    """获取所有已注册的 submodule 列表。"""
    result = run_cmd(["git", "submodule", "status"], cwd=ROOT)
    if result.returncode != 0:
        logger.error("Failed to list submodules: %s", result.stderr)
        return []

    submodules = []
    for line in result.stdout.strip().splitlines():
        if not line.strip():
            continue
        # 格式: " <sha> <path> (<describe>)" 或 "-<sha> <path>"
        parts = line.strip().lstrip("-+").split()
        if len(parts) >= 2:
            submodules.append({
                "sha": parts[0],
                "path": parts[1],
                "name": Path(parts[1]).name,
            })
    return submodules


def check_submodule_update(submodule: dict[str, str]) -> SubmoduleStatus:
    """检查单个 submodule 是否有远程更新。"""
    sub_path = ROOT / submodule["path"]
    name = submodule["name"]
    local_sha = submodule["sha"]

    if not sub_path.exists():
        return SubmoduleStatus(
            path=submodule["path"],
            name=name,
            local_sha=local_sha,
            remote_sha="",
            has_update=False,
            error="submodule directory not found",
        )

    # fetch 远程最新
    fetch_result = run_cmd(["git", "fetch", "origin", "--depth=1"], cwd=sub_path, timeout=60)
    if fetch_result.returncode != 0:
        return SubmoduleStatus(
            path=submodule["path"],
            name=name,
            local_sha=local_sha,
            remote_sha="",
            has_update=False,
            error=f"fetch failed: {fetch_result.stderr.strip()}",
        )

    # 获取远程 HEAD
    remote_result = run_cmd(["git", "rev-parse", "origin/HEAD"], cwd=sub_path)
    if remote_result.returncode != 0:
        # fallback: 尝试 origin/main 或 origin/master
        for branch in ["origin/main", "origin/master"]:
            remote_result = run_cmd(["git", "rev-parse", branch], cwd=sub_path)
            if remote_result.returncode == 0:
                break

    if remote_result.returncode != 0:
        return SubmoduleStatus(
            path=submodule["path"],
            name=name,
            local_sha=local_sha,
            remote_sha="",
            has_update=False,
            error="cannot resolve remote HEAD",
        )

    remote_sha = remote_result.stdout.strip()
    has_update = local_sha != remote_sha

    return SubmoduleStatus(
        path=submodule["path"],
        name=name,
        local_sha=local_sha,
        remote_sha=remote_sha,
        has_update=has_update,
    )


def pull_submodule(submodule_path: str) -> bool:
    """拉取 submodule 的最新代码。"""
    sub_path = ROOT / submodule_path
    result = run_cmd(["git", "pull", "origin", "--depth=1"], cwd=sub_path, timeout=120)
    if result.returncode != 0:
        logger.error("Pull failed for %s: %s", submodule_path, result.stderr)
        return False
    return True


def generate_diff(submodule_path: str) -> str:
    """生成 submodule 更新的 diff 摘要。"""
    sub_path = ROOT / submodule_path
    result = run_cmd(["git", "diff", "--stat", "HEAD~1..HEAD"], cwd=sub_path)
    return result.stdout.strip() if result.returncode == 0 else ""


def trigger_merge(submodule_name: str, diff_summary: str) -> bool:
    """触发 Claude 智能缝合脚本。"""
    if not MERGE_SCRIPT.exists():
        logger.warning("merge-with-claude.sh not found, skipping merge trigger")
        return False

    result = run_cmd(
        ["bash", str(MERGE_SCRIPT), submodule_name, diff_summary],
        cwd=ROOT,
        timeout=300,
    )
    if result.returncode != 0:
        logger.error("Merge script failed: %s", result.stderr)
        return False

    logger.info("Merge triggered for %s", submodule_name)
    return True


def sync_once() -> dict[str, int]:
    """执行一次完整的同步检查。"""
    stats = {"checked": 0, "updated": 0, "errors": 0, "merged": 0}

    submodules = get_submodules()
    if not submodules:
        logger.warning("No submodules found")
        return stats

    logger.info("Checking %d submodules for updates...", len(submodules))

    for sub in submodules:
        stats["checked"] += 1
        status = check_submodule_update(sub)

        if status.error:
            logger.warning("[%s] Error: %s", status.name, status.error)
            stats["errors"] += 1
            continue

        if not status.has_update:
            logger.debug("[%s] Up to date", status.name)
            continue

        logger.info("[%s] Update detected: %s -> %s", status.name, status.local_sha[:8], status.remote_sha[:8])

        if pull_submodule(status.path):
            stats["updated"] += 1
            diff = generate_diff(status.path)
            if diff:
                logger.info("[%s] Changes:\n%s", status.name, diff)
                if trigger_merge(status.name, diff):
                    stats["merged"] += 1

    logger.info(
        "Sync complete: checked=%d, updated=%d, merged=%d, errors=%d",
        stats["checked"], stats["updated"], stats["merged"], stats["errors"],
    )
    return stats


def daemon_loop(interval: int) -> None:
    """守护进程模式：定期轮询。"""
    logger.info("Starting daemon mode (interval=%ds)...", interval)
    while True:
        try:
            sync_once()
        except KeyboardInterrupt:
            logger.info("Daemon stopped by user")
            break
        except Exception:
            logger.exception("Unexpected error during sync")

        logger.info("Next check in %d seconds...", interval)
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="Quilin Agent Upstream Sync")
    parser.add_argument("--daemon", action="store_true", help="Run in daemon mode")
    parser.add_argument("--interval", type=int, default=300, help="Polling interval in seconds (default: 300)")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    args = parser.parse_args()

    if args.daemon:
        daemon_loop(args.interval)
    else:
        stats = sync_once()
        if args.json:
            print(json.dumps(stats, indent=2))
        sys.exit(0 if stats["errors"] == 0 else 1)


if __name__ == "__main__":
    main()
