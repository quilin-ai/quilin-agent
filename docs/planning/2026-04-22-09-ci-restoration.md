---
title: CI 恢复闭合 — 4 笔连推让 master CI 首次跑到 vitest 并绿
status: completed
owner: Claude (write) + Codex (cross-review)
created: 2026-04-22
last_updated: 2026-04-22
completed_at: 2026-04-22
closure_commits:
  - 2df9800  # ruff I001
  - 14e34cf  # pnpm version 冲突
  - 4afe58b  # biome 53 errors auto-fix
  - 9081eea  # upstream fixture skipIf
predecessors:
  - docs/planning/2026-04-22-08-vitest-configloader-runner.md  # 固化的 --configLoader runner 这轮首次 CI-verified
  - docs/planning/2026-04-22-07-skills-b3b-phase-4.md  # B3b 闭合后 master CI 才有东西可跑
verified_at: 2026-04-22
threat_surface_delta:
  new_ingress: []
  new_egress: []
  new_persistence: []
---

# CI 恢复闭合 — master 首次真正跑到 vitest step

## 背景

`5f9dd22`（固化 `--configLoader runner`）推上 master 后，用户追问"这个稳定性你们是怎么验证的？"，我 `gh run view --log-failed` 一查发现 **CI 从 `5f9dd22` 起连续红，甚至退回几 commit 都红**。即本轮之前"双机 358/358 本地绿"的 verification 从未经过 CI 确认——`--configLoader runner` 的 CI-verified 声明是**premature**。

## 定位：4 个前置 blocker 叠加

CI 失败的表面错误在 Python / TypeScript / biome / vitest 四处，实际是**4 个独立 blocker 叠加**，前三个都卡在 CI 更靠前的 step，所以 `bun run test` 根本没机会跑：

| # | Blocker | 报错 step | 根因 | Fix commit |
|---|---|---|---|---|
| 1 | ruff I001 | Python → `uv run ruff check src/` | `providers/memory/src/omnimem/store.py` 的 `from .types import MemoryRecord, MemoryTier, VALID_MEMORY_TIERS` 内名字非字母顺序 | `2df9800` — `ruff check --fix` autofix |
| 2 | pnpm 版本冲突 | TypeScript → `pnpm/action-setup@v4` | Action config `version: 10` 和 `package.json#packageManager: "pnpm@10.8.1"` 双源 | `14e34cf` — 删 Action config 的 `version: 10`，让 action 读 `packageManager` |
| 3 | biome 53 errors | TypeScript → `bun run biome check src/` | `pnpm blocker 从未放 CI 跑到 biome`，drift 积累到 53 条 `useImportType` + `noUnusedImports`（全 FIXABLE） | `4afe58b` — `biome check --write src/` 一次性 auto-fix 43 files |
| 4 | upstream fixture 缺失 | TypeScript → `bun run test` → `frontmatter.test.ts > parses real upstream skill fixtures` | CI 不 init `upstreams/` submodule，test 读 `upstreams/llm-vercel-ai/skills/**/SKILL.md` ENOENT | `9081eea` — `it.skipIf(!upstreamsAvailable)`，本地 dev 有 submodule 时照跑，CI skip clean |

每修一个就多跑一次 CI，下一个 blocker 才会暴露，俄罗斯套娃。

## 四笔 fix 详情

### 1. `2df9800` — ruff I001

```diff
-from .types import MemoryRecord, MemoryTier, VALID_MEMORY_TIERS
+from .types import VALID_MEMORY_TIERS, MemoryRecord, MemoryTier
```

`ruff check --fix src/` 自动应用。1 行改动，纯 hygiene。

### 2. `14e34cf` — pnpm/action-setup 版本冲突

```diff
       - uses: pnpm/action-setup@v4
-        with:
-          version: 10
```

pnpm action 支持 `version` 输入 OR `packageManager` 字段作为版本源，但禁止双源（防 drift）。删 Action config 的 `version: 10`，统一由 `package.json#packageManager` 驱动。这和 `docs/planning/2026-04-22-08-vitest-configloader-runner.md` 里"flag 收拢到 package.json script 当单一真相源"的原则一致。

### 3. `4afe58b` — biome 53 errors 一次性清零

CI blocker 3 暴露时，本地 `biome check src/` 一跑 53 errors。全部 FIXABLE（useImportType 和 noUnusedImports，都是 biome 的 safe fix category）。`biome check --write src/` 一次清零，43 files 改动 +868/-664。

**scope 判断**（Codex cross-review 同意）：
- 不拆 commit：43 files 看起来大，但都是 biome 自动生成的 type-only import rewrite + unused import removal。拆只会制造更多 diff。
- 不 `--unsafe`：只应用 safe fixes。剩下 4 warnings（`noNonNullAssertion` × 1 + 3 条 unsafe unused-import fix）不阻塞 CI，留给后续单独处理。
- **无语义改动**：本地 358/358 tests 绿，Codex 抽查 `prompt-builder.ts` / `prompt-session-assembler.ts` / `index.test.ts` 确认都是格式和类型标注，没有行为级改写。

### 4. `9081eea` — upstream fixture skipIf

```typescript
const upstreamFixturePaths = [ /* ... */ ];
const upstreamsAvailable = upstreamFixturePaths.every((p) => existsSync(p));

it.skipIf(!upstreamsAvailable)(
  "parses real upstream skill fixtures without translation",
  () => { /* ... */ },
);
```

**方向选择**（Codex cross-review 同意）：
- ✅ **skipIf**：本地有 submodule 时跑 coverage，CI 没有 submodule 时 skip clean。保留 "packages 测 packages，upstreams 不作为 CI 硬依赖" 边界（[CLAUDE.md](../../CLAUDE.md) "No upstream tests"）。
- ❌ **CI 加 `git submodule update --init`**：会引入 ~100 个 submodule 的 clone 成本、网络依赖、`upstreams/` shallow clone 不稳定性。CI 应该验证产品代码，不应该替 dev 拉外部内容。
- ❌ **copy fixture 进 `packages/`**：每次 upstream submodule 升级都要手动同步 fixture，制造第二份真相源。

## 验证

- **`9081eea` 触发的 CI run `24765031873`**: `completed success`，49s，Python + TypeScript 两 job 都过（Python 15s / TypeScript 34s）
- **本地全量 vitest**: `numTotalTests: 358, numPassedTests: 358, numFailedTests: 0, success: true`（带 `--configLoader runner`）
- **本地 biome**: `Checked 94 files in 31ms. No fixes applied. Found 4 warnings.` exit 0
- **CI 首次跑到 vitest step 并 pass** = `--configLoader runner` 的 CI-verified 声明现在有实证
- **1 test skipped（CI） / 358 passed（local）**：upstream fixture test 在两边行为都符合预期

## 与 08-vitest-configloader-runner 的关系

08 doc 写成那会儿声明 "双机本地实证 41 files / 358 passed"，但没 CI-verified——因为 CI 那时在 pnpm blocker 前就挂了，根本没到 vitest。本次闭合**真正**补上 CI-verified：`9081eea` 的 CI run 显式跑了 `bun run test`（走 `package.json#test` 的 `vitest run --configLoader runner`）并 pass。

08 doc 的决策结论**不变**（runner 固化到 package.json script 仍是正确的），但"验证声明"的证据基础从"双机本地"升级到"双机本地 + CI"。

## 教训

1. **"本地绿"不等于"CI 绿"**。用户的追问逼出了真 blocker。以后声明 CI-verified 前先 `gh run list --branch master --limit 3 | grep success`。
2. **CI 长期前置 blocker 会掩盖后续 drift**。pnpm 冲突挡住 biome step 后，biome 可以偷偷 drift 到 53 errors 而没人发现。本轮暴露出的 53 错都是在 biome 从未在 CI 跑过期间积累的——**一条红的 gate 比一条禁用的 gate 更危险，因为没人知道它后面还挡着什么**。
3. **CI-FIX 不是 scope 扩**。当 CI 的多个 gate 因为前置挂而从未跑过时，修复前置后一次性暴露的 downstream 清理不能视为"额外治理"——它们是已经欠下的债。拒绝人为拆分只会让 CI 继续欠债。
4. **对称异步 cross-review 生效**：Codex 抽查 `4afe58b` 的 diff sample 后同意"不拆"、抽查 `9081eea` 的 `existsSync → skipIf` 路径后同意"不补 submodule init"。`agent-bridge.md §7.4` 机制第二次（前一次是 2026-04-21 round 3 follow-up）产生可度量质量信号。

## 残留（非本轮 scope）

biome `--write` 后剩 4 warnings：3 条 unsafe unused-import fix + 1 条 `noNonNullAssertion` on `src/tools/builtin/shell-exec.ts:189`。均不阻塞 CI（warning 非 error）。留给独立小 session 清。

## Blockers

- 无
