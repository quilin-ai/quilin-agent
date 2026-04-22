---
title: Vitest v4 configLoader=runner 固化决策
status: completed
owner: Claude + Codex
created: 2026-04-22
last_updated: 2026-04-22
completed_at: 2026-04-22
closure_commits: []
predecessors:
  - docs/planning/2026-04-22-07-skills-b3b-phase-4.md  # P4-b 实证触发这条固化
---

# Vitest v4 `configLoader=runner` 固化决策

## 背景

Phase 4 P4-b 本地闸门环节出现三种 runner 入口行为分叉：

| 命令 | runtime | 结果 | 根因 |
|------|---------|------|------|
| `bunx vitest run` | Node（bunx 默认委托 node 启动 npm bin） | ❌ `ERR_REQUIRE_ESM` | vitest v4 默认 `configLoader: "bundle"`（esbuild→CJS `require()`）遇到 ESM-only 依赖链（zod v4 / `@ai-sdk/*` 全 `"type": "module"`） |
| `bunx --bun vitest run` | Bun | ❌ 大量 zod 失配 | Bun 模块解析走 zod v4 conditional exports 的另一条分支，vitest v4 transformer 假设不成立 |
| `bun run vitest run` | Bun | ✅（CI / justfile 用这条，358/358 绿） | Bun runtime 的 ESM↔CJS 边界容错覆盖了 bundle loader 的 `require(ESM)` 路径 |
| `./node_modules/.bin/vitest run --configLoader runner` | Node | ✅（358/358 绿） | `runner` loader 走 Vite transform，绕开 `require(ESM)` |

CI 走 `bun run vitest run`，本来没事——但本地开发反射式 `bunx vitest run` 在 Phase 4 P4-b session 里首次暴露此问题（P4-a session 同命令曾经通过，差异来自 node_modules / lockfile / Bun 缓存解析路径的抖动）。

## 决策

**把 `--configLoader runner` 固化到 `packages/agent-core/package.json` 的 `test` / `test:watch` 脚本里**，`justfile` 和 CI 统一通过 `bun run test` 调用它——script 作为 runner flag 的**单一真相源**，不在 just / CI 里重复内联底层命令（避免三处漂移）。

影响面（精确 diff）：

- `packages/agent-core/package.json`
  - `"test": "vitest run"` → `"test": "vitest run --configLoader runner"`
  - `"test:watch": "vitest"` → `"test:watch": "vitest --configLoader runner"`
- `justfile:60`
  - `cd packages/agent-core && QUILIN_ENV=test bun run vitest run` → `cd packages/agent-core && QUILIN_ENV=test bun run test`
- `.github/workflows/ci.yml:26`
  - `cd packages/agent-core && bun run vitest run` → `cd packages/agent-core && bun run test`

### 为什么不三处都内联 `--configLoader runner`

最初草案是三处分别加 flag，Codex 在独立 review 时指出这会留下"本地一套、CI 一套、文档又一套"的漂移面。把 flag 收拢到 `package.json` script 让 just / CI 只调 `bun run test`，日后 vitest v5+ 默认切回 runner 时只需删除**一处** flag，其余入口不用动。Codex 本机实证 `cd packages/agent-core && bun run test` 在 Bun 1.3.11 下 flag 正常透传（41 files / 358 passed），不会被 `bun run` 吞掉。

## 为什么是 runner 而不是别的方案

**备选 A：降级 vitest v4 → v3**
- v3 默认就是 runner loader
- 但会丢失 v4 的若干改进（并发、报告器），不值当

**备选 B：在 `vitest.config.ts` 写死 `configLoader: "runner"`**
- vitest v4 当前不支持 config 文件自声明 loader（要引导 config 加载的就是 loader 自己，鸡生蛋问题）
- 必须在 CLI 层或环境变量层固化

**备选 C：加 `VITEST_CONFIG_LOADER=runner` 环境变量**
- vitest v4 目前未暴露此环境变量读取，只能 CLI flag
- 未来若暴露可以迁移，代价一致

**采纳：显式 CLI flag**——成本 3 行 diff，入口统一，未来 v5 若切换默认语义可一键移除。

## 实证

本决策落地前：
- `./node_modules/.bin/vitest run --configLoader runner` → 41 files / 358 tests passed（Phase 4 P4-b closure 基线）
- `bunx vitest run` → `ERR_REQUIRE_ESM`
- `bunx --bun vitest run` → zod global failures

本决策落地后（双机实证）：
- Claude 本机 `cd packages/agent-core && bun run vitest run --configLoader runner` → 41 files / 358 passed ✅
- Codex 本机 `cd packages/agent-core && bun run test`（即走 `package.json` script）→ 41 files / 358 passed ✅（Bun 1.3.11 + Node v22.11.0，确认 `bun run` 不吞 flag）
- Codex 本机 `cd packages/agent-core && ../../node_modules/.bin/vitest run --configLoader runner` → 41 files / 358 passed ✅

## 未来退出条件

- Vitest v5+ 若把默认 loader 切回 runner，或补上 "bundle 模式下 require(ESM) 可降级"，即可在 `package.json` / `justfile` / `ci.yml` 删除 `--configLoader runner`
- 届时跟着升级 PR 同步移除即可

## Open Questions

- [x] **`runner` loader 是否比 `bundle` 明显慢？** NO（Codex 独立判断）——这是稳定性修复，不是性能提案。未观测到可感知回归，暂不做正式 benchmark；若未来 test startup 成为痛点再补。
- [ ] Bun runtime 下 `runner` loader 是否有已知 regression？暂无 upstream issue；若出现，回退到 `bun run vitest run` 不带 flag（和决策前一致）

## 关联

- 触发 session：`docs/planning/2026-04-22-07-skills-b3b-phase-4.md` P4-b 闸门环节
- 影响：本决策不改变任何生产代码、测试代码、测试结果；纯 runner 入口固化
