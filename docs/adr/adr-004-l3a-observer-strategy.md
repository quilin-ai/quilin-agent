# ADR-004: L3a Observer 策略决策 — rule-first vs. ML-first vs. opt-in

> **状态**: Proposed (pending review)
> **日期**: 2026-04-23
> **决策者**: Quilin Agent 团队

---

## 1. 背景与问题

OmniMem §A.7 L3a Observation Layer 的 spec 定义 observer 走两级：

- **Tier 1**：零 LLM 成本的 rule-based 检测器，识别"观察候选"
- **Tier 2**：tiny LLM 兜底对 Tier 1 低置信度 / 歧义样本做精判

2026-04-20 的 v2-r3 formal gate 给出 **NO**（详见 [rule-first-observer-spike-report.md](../research/rule-first-observer-spike-report.md)）：

- recall `21.4%`（gate `>= 40%`）
- FPR `2.8%`（gate `<= 5%`）
- p95 `4.19 ms`（gate `< 20 ms`）
- zh recall `0%`（新增 gate `>= 25%`）

2026-04-23 的 v3 在修复了四个 v2-r3 失败模式后重新跑 gate（详见 [rule-first-observer-v3-report.md](../research/rule-first-observer-v3-report.md)）：

- recall `44.8%`（pass）
- FPR `10.2%`（**fail**）
- p95 `3.90 ms`（pass）
- zh recall `39.1%`（pass）

本 ADR 的核心决策：基于 v2-r3 + v3 两次实证，**Memory M0 Sprint 1 的 L3a Observer 应该走哪条路**？

---

## 2. 证据

### 2.1 v2-r3 baseline（2026-04-20）

`docs/research/rule-first-observer-spike-report.md` 详细记录：

| 维度 | v2-r3 |
|---|---|
| Overall recall | `21.4%` |
| Overall FPR | `2.8%` |
| p95 latency | `4.19 ms` |
| zh recall | `0.0%` |
| Tier 2 escalation rate | `1.1%` |
| 失败模式 | 窄实体短语 / 单语言假设 / 弱升级 / 情绪稀疏 |

### 2.2 v3 实测（2026-04-23）

`docs/research/rule-first-observer-v3-report.md` 详细记录：

| 维度 | v3 | Delta vs v2-r3 |
|---|---|---|
| Overall recall | `44.8%` | `+23.4` pts |
| Overall FPR | `10.2%` | `+7.4` pts（gate ceiling = `5%`） |
| p95 latency | `3.90 ms` | `-0.29 ms` |
| zh recall | `39.1%` | `+39.1` pts |
| Tier 2 escalation rate | `28.2%` | `+27.1` pts |
| Entity recall | `19.9%` | `+2.1` pts（未明显改善） |
| Emotion recall | `47.5%` | `+45.5` pts |
| `past_abandoned` trap mis-extract | `45.5%` | 从 `9.1%` 恶化 |

关键发现：

- rule-first 在 1039 样本上可以达到 recall `44.8%` / zh recall `39.1%`，但 **FPR 会跨过 5% 红线**
- FPR overshoot 的主要来源是 `no-rule-match-but-observational` escalation 哨兵（289 / 293 次 escalation 的 65%）
- `past_abandoned` trap 回归表明扩展规则面后，需要加 tense-aware 防守才稳定

### 2.3 Arm L (tier-1 tiny LLM) 状态

**Arm L 当前 blocked**。直接触发前置资源 checklist：

| 资源 | 当前状态 |
|---|---|
| `ANTHROPIC_API_KEY` 环境变量 | 不存在（未设置） |
| 本地 `ollama` 二进制 | 未安装 |
| `curl http://localhost:11434/api/tags` | 连接失败（没有 ollama 服务） |
| 本地 Haiku-class 模型权重 | 无 |

Arm L 在本次 spike 未运行。v3 report §"Recommended Next Step" 明确列出了 Arm L 的前置条件。

### 2.4 与 spec 对齐

03-memory §A.7 L3a 要求：

- Tier 1 零 LLM 成本（v3 符合，p95 `3.90 ms`）
- Tier 2 LLM 兜底（v3 通过 `AMBIGUITY_MARGIN` + `_looks_observational` 配置了 escalation，但 escalation rate `28.2%` 过高）
- L3a 是 OmniMem 的观察层，默认启用

v3 的高 escalation rate (`28.2%`) 意味着 Tier 2 LLM 会被频繁调用，违反"零 LLM 成本主路径"的 spec 承诺，即使 FPR 被压回 `5%`。

---

## 3. 决策矩阵

基于上述证据，给出三个候选决策：

### (d1) 保留 rule-first，Memory M0 Sprint 1 按 rule-first 走

**前提**：v3 能通过 gate（recall ≥ 40% + FPR ≤ 5% + p95 < 20ms + zh recall ≥ 25%）。

**实测**：v3 在 FPR 上 fail（`10.2%` vs `5%` 上限）。

**结论**：**(d1) 条件未满足**，不采纳。

### (d2) 切 ML-first（Arm L tier-1 tiny LLM）

**前提**：v3 fail gate，且 Arm L 的前置资源可用。

**实测**：Arm L 当前 blocked（见 §2.3），必须先解前置 blocker。

**需要先完成的准备清单**：

1. 在开发环境设置 `ANTHROPIC_API_KEY` 或安装本地 `ollama`
2. 如果走 ollama 路线：拉取 Haiku-class 模型（例如 `ollama pull llama3.2:3b` 或 `ollama pull qwen2.5:3b`）
3. 验证 `curl http://localhost:11434/api/tags` 返回 200
4. 在 `.spike/observer-arm-L/` 内实现对 1039 样本的推理管线
5. 跑 gate，与 v3 对比

**决策**：**条件性采纳 (d2)**，但必须先完成前置 4 项 + 跑出 Arm L 数字。本 ADR 不能闭环 (d2)，需要一个后续 spike。

### (d3) L3a 降级为 opt-in，默认关

**前提**：v3 fail gate + Arm L 也 fail（未来验证）。

**实现**：

- 修改 03-memory §A.7 L3a spec：L3a 从"默认启用"改为"opt-in，需要 `--trust auto` 显式开启"
- L3a 作为 OmniMem 的可选增强能力，不影响 M0 基础路径
- 用户想要自动观察提取，就接受一定的 FPR / LLM 成本

**决策**：作为 (d2) 的回退选项保留，不作为当前首推。

---

## 4. 推荐

**推荐采纳 (d2)**，理由：

1. v3 证明 rule-first 在 recall / zh / latency 三个维度都能达到 gate，只在 FPR 上差 5 个百分点。这不是结构性失败，是"哨兵过于宽松"的局部问题。
2. 但 v3 的 `28.2%` escalation rate 本身就违反"零 LLM 成本主路径"的 spec 承诺。即使 v4 把 FPR 压回 `5%`，只要仍然通过 escalation 触发 Tier 2，就等价于 LLM-first（只是多了一层 rule 先筛）。
3. 与其再做一轮 v4 rule-first 挤 FPR（预计又是 2-3 天），不如直接跑 Arm L 拿到 tier-1 tiny LLM 的 ground-truth 数字，再做最终选型。
4. Arm L 的数字会直接决定后续方向：
   - 如果 Arm L 能在 `<= 50ms p95` 内达到 recall `>= 60%` / FPR `<= 3%`，ML-first 是明确答案
   - 如果 Arm L 也做不到，才考虑 (d3) opt-in 降级

**决策路径**：

```
当前决策：(d2) 条件性采纳，触发 Arm L spike
  └─ Arm L spike 结果 = PASS → 采纳 ML-first，M0 Sprint 1 走 Arm L
  └─ Arm L spike 结果 = FAIL → 触发后续 ADR，采纳 (d3) opt-in
```

---

## 5. Open Questions

下一个 spike 开始前必须先解的问题：

1. **API key / ollama 二选一**：决定 Arm L 使用 Anthropic API 还是本地 ollama。Anthropic API 有成本但部署简单；ollama 零成本但需要本地 GPU / CPU 推理能力。
2. **模型选择**：Haiku 3.5 / Haiku 4.5 / Qwen 2.5 3B / Llama 3.2 3B 中选一个作为 Arm L 的 tier-1 tiny LLM。
3. **Prompt 预算**：每个样本 Tier 1 判断的 token 预算（建议上限 200 input + 50 output）。
4. **Fallback 策略**：Arm L LLM 超时 / 报错时，是回退 rule-first 还是直接放弃该样本？
5. **数据集复用**：直接用同一份 `docs/research/fixtures/rule-first-observer/dataset.json`，保证 v3 vs Arm L 可比较。

---

## 6. 后果

### 如果最终采纳 (d1)（rule-first，本 ADR 当前不推荐）

- Memory M0 Sprint 1 的 L3a 按 rule-first 实现
- Tier 2 LLM 可以不接，或只接低置信度旁路
- spec §A.7 不改

### 如果最终采纳 (d2)（ML-first，当前推荐）

- 触发 Iter D Sprint 1 或独立的 Arm L spike
- 需要引入 Anthropic API 或 ollama 作为新运行时依赖
- Memory M0 Sprint 1 的 L3a 按 tier-1 tiny LLM 实现，rule 仅作为预过滤或 zero-LLM 场景的 fallback
- spec §A.7 可能需要补充 "Tier 1 = tiny LLM with rule prefilter" 的细化

### 如果最终采纳 (d3)（opt-in，回退）

- 修改 `docs/engineering/03-memory/README.md` §A.7：L3a 降级为 opt-in 能力
- 默认 OmniMem 的 L3 层不做自动 observation 提取
- 用户通过 `--trust auto` 或其他显式配置启用
- 07-safety.md 需要同步更新权限描述（`origin:"idle"` 且 `l3a:true` 的 write 需要 explicit opt-in）
- 这是最保守的回退，但也最不满足 "有人味 Agent" 的原始目标

---

## 7. 相关文档

- [rule-first-observer-spike-report.md](../research/rule-first-observer-spike-report.md) — v2-r3 baseline（295 行）
- [rule-first-observer-v3-report.md](../research/rule-first-observer-v3-report.md) — v3 实测（本次）
- [ADR-001](./adr-001-core-loop-and-language.md) — 核心 Agent Loop 与语言架构
- [ADR-002](./adr-002-project-skeleton.md) — 项目骨架蓝图
- `docs/engineering/03-memory/README.md` §A.7 — L3a Observation Layer spec
- `docs/engineering/07-safety-guardrails/README.md` §2.6.4 — WriteAuthority gate（涉及 `origin:"idle"` 的 opt-in 判定）
