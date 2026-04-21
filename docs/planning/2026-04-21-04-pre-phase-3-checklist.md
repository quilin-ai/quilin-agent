---
title: Pre-Phase-3 Gate Checklist (1-page)
date: 2026-04-21
owner: Claude (plan) + Codex (impl)
status: active
source: Codex msg_209 提议 + Opus 4.7 Round 3 gate 分层
---

# Pre-Phase-3 Gate Checklist

> **用途**：session 丢失也不用重新判断。B3b / Phase 3 / 本周同步三类 gate 压成一页。

## Gate A — B3b Phase 0 开工前（Codex 手）

### A.1 ✅ loop.ts 减行（CC-01）— 已完成（commit `0464377`）
- **现状**：**212 LOC**（契约 `<220`）
- **抽出产出**：
  - `context/reasoning-sanitizer.ts`（sanitize / strip）
  - `state/checkpoint-writer.ts`（writer 边界）
  - `loop-tool-calls.ts` + `loop-types.ts`（tool-call 分发 + 共享类型）
  - `context/injection-scanner.ts`（trust helpers）
- **验证**：`wc -l loop.ts` = 212；`pnpm --filter @quilin/agent-core test` 266/267 绿（唯一红灯 web-fetch 老债，不在本写集）

### A.2 ✅ skill_view 工具实现（CC-02）— 已完成（commit `0464377`）
- **落地**：`packages/agent-core/src/tools/builtin/skill-view.ts` 接入 `index.ts` 和 `repl.ts`
- **复用**：`SkillsManager.loadBody()` on-demand load，新增 root 越界 + body size guard
- **测试覆盖**：happy-path / 缺参 / 越界 / 超限

## Gate B — Phase 3 Reasoning carry-over 开工前（Claude 手）

### B.1 🟠 Planning 模板加威胁面字段（PB-01）
- **文件**：`docs/planning/_template.md`
- **新增 frontmatter 必填字段**：
  ```yaml
  threat_surface_delta:
    new_ingress: []        # 本 phase 新增的"外部数据能进来"的入口
    new_egress: []         # 本 phase 新增的"数据能出去"的通道
    new_persistence: []    # 本 phase 新增的"数据落盘"的位置
  ```
- **为什么**：Phase 2 靠事后 review 救了 3 条 CRITICAL；Phase 3 cache-adapter outbound replay 会同时新增 ingress + egress + persistence 三条，不能再事后补

### B.2 ⚪ Phase 3 开工第一步走一遍 threat walk
- 把 `cache-adapter.adaptOutgoingReasoning` 的三个新暴露面填进 template
- Claude 或 adversarial reviewer 独立检查一遍再让 Codex 动手

## Gate C — 本周同步（不 gate push，但本周必须做）

### C.1 🔴 AA-01 + 同步 03-memory
- ✅ **已完成**（2026-04-21 session）：`docs/engineering/03-memory/README.md:197-205` 从 v2-r1 7.3% 更新为 v2-r3 21.4% gate failed
- ✅ **已完成**（2026-04-21 后续 session）：`docs/planning/00-implementation-plan.md` 已在 Iter D 区块新增 "Memory Sprint 0 Pre-Work (D-21 follow-up)" 小节，记录 gate failed / 1-week spike / 分支决策
- ⏳ **待做**：如果下一次 Sprint 仍不过 40%，起草 ADR-004（切 ML-first 或 L3a 降级 opt-in）

### C.2 🟡 CC-03 bun-types typecheck — 半闭合（commit `0464377`）
- ✅ **作用域窄化**：`tsconfig.base.json` 删 `"types": ["bun-types"]`；`packages/agent-core` 本地 `"types": ["bun"]`
- ✅ **依赖对齐**：`packages/agent-core` 装 `@types/bun`（lockfile 快照已入 commit 2）
- ⚠️ **未闭合**：tsc 仍报 89 errors（bun-types 伪装被拆后暴露的既有技术债）
- 📋 **老债追踪**：新建 `docs/planning/2026-04-21-06-ai-sdk-type-debt.md`，4 cluster 分类（Cluster 1 AI SDK v6 漂移 63 err → Iter D；Cluster 2/3/4 低成本杂项 26 err → Iter C 前清理）
- ⏳ **待做**：CI 里把 `tsc --noEmit` 上 blocking gate 必须等 Cluster 1 修完，否则会阻塞所有 PR

## 不 gate 任何事（Phase 4 合并时再做）

- L-01：stderr 多通道分流（reasoning / error / chrome）
- L-03：`startRepl` 结构化拆分
- PB-02：`docs/review/README.md` cross-ref 矩阵
- PB-03：`CLAUDE.md` 加 Token starvation fallback 一节

## 一眼看哪条是最紧迫的

**最紧迫 = 影响下一步实现的是哪条**：

1. 如果下一个动作是 B3b Phase 0 → 先过 **Gate A**
2. 如果下一个动作是 Phase 3 → 先过 **Gate B**
3. 如果下一个动作是 push 到 origin → Gate A/B 都不 block，但 Gate C 建议一起推

**当前实际下一步（按 Codex msg_209 共识）**：Gate A 先做，Phase 3 等 Gate B。

## 责任归属一览

| Gate | 动作 | 谁做 | 状态 |
|---|---|---|---|
| A.1 loop.ts 减行 | 重构抽函数 | Codex | ✅ commit `0464377`（212 LOC） |
| A.2 skill_view 实现 | 新建 tool + 单测 | Codex | ✅ commit `0464377` |
| B.1 威胁面字段 | 改 template | Claude | ✅ commit `b967d1c` |
| B.2 Phase 3 threat walk | 填 template | Claude 或 adversarial reviewer | ⏳ 待 Phase 3 开工时做 |
| C.1 implementation-plan 同步 | 改文档 | Claude | ✅ commit `b967d1c` |
| C.2 bun-types fix | 改 package.json + CI | Codex | 🟡 commit `0464377` 半闭合；老债 → `2026-04-21-06-ai-sdk-type-debt.md` |
