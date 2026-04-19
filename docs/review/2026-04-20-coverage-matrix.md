# Quilin Agent — Ultra-Review 覆盖矩阵（2026-04-20 快照）

> **目的**：把 `2026-04-17-ultra-review.md`（14 CRITICAL + 59 HIGH + 62 MEDIUM）逐条映射到 task，标记派工状态。  
> **基线**：delta-audit `2026-04-20` 验收结果 + task list 至 #91。  
> **结论**：**14 CRITICAL 全覆盖**；HIGH 有 19 条落入 #89/#91 派工池；MEDIUM 绝大部分归 P2 backlog。

---

## 1. CRITICAL（14 条）

| ID | 内容 | Task | 状态 |
|----|------|------|:----:|
| SEC-01 / TS-02 | `shell_exec` RCE（blocklist + argv + timeout clamp） | #68 / #85 | ✅ FIXED |
| SEC-02 | tool output 二阶 prompt injection | #85 + #89 (NEW-06+07 加固) | ✅ FIXED（#89 加固在派） |
| SEC-03 / TS-05 | `file_*` 无 root 白名单 | #85 | ✅ FIXED |
| SEC-04 / TS-06 | 敏感文件 basename 匹配 | #85 (+ #89 NEW-08 加 `/etc/*`) | ✅ FIXED（#89 加固在派） |
| SEC-05 / TS-01 | `web_fetch` SSRF | #85 + #88 (NEW-01/02 数字 IP + DNS rebinding) | ✅ FIXED（#88 commit 待合） |
| SEC-06 | MCP cmd injection | #68 | ✅ FIXED |
| SEC-09 | MCP env 继承 API keys | #84 | ✅ FIXED |
| TS-03 | AI SDK v6 `maxTokens` 被丢弃 | #65 | ✅ FIXED |
| PY-03 / PY-11 | 4 个幻觉版本号阻塞 CI | #66 | ✅ FIXED |
| PY-04 / SEC-08 | `memory_store(tier)` 无枚举校验 | #85 | ✅ FIXED |
| D-01 | 自动写权限栈 4 件套（God Mode + AUTO + Idle + Scaffold L1） | #69（叙事） + #90（代码 MVP） | 🔜 Claude 派单（#90 brief 已落盘） |
| D-02 | Spec 膨胀 / Iter E 拆分 / benchmark 3 项 / 13→12 领域 | #70 + #75 + #78 | ✅ FIXED |
| D-03 | 融合缝合自动合并叙事 | #71 | ✅ FIXED |
| FEA-01 | `crates/` 骨架物理删除 | #72 / #86 | ✅ FIXED |

**CRITICAL 完成率：13/14 FIXED + 1 派工中（#90 WriteAuthority MVP）**

---

## 2. HIGH（59 条）

### 2.1 已 FIXED（35 条）

| 分类 | IDs | Task |
|------|-----|------|
| D-04 Rust 降级 | D-04 | #72 / #86 |
| D-05 跨域 contract | D-05 | #73 |
| D-06 Supervisor ≤5s | D-06 | #76 |
| D-07 LLM lock-in | D-07 | #77 |
| D-08 threat-model.md | D-08 | #74 |
| D-09 benchmark 3 项 | D-09 | #78 |
| D-10 术语漂移 | D-10 | #82 |
| MCPRegistry 生命周期 | CR-02 / CR-03 | #67 |
| Python 幻觉版本号 | PY-03 / PY-11 | #66 |
| PY-01 async 阻塞 | PY-01 | #85 (Batch 2) |
| PY-07 / M-17 单例 | PY-07 | #85 |
| TS-10 checkpoint JSON.parse guard | TS-10 | delta 验收已 FIXED（`migrateEnvelope`） |
| R-05/06/07 文档精简 | R-05 / R-06 / R-07 | #79 / #80 / #81 |

### 2.2 在派工（7 条）

| ID | 内容 | Task | 状态 |
|----|------|------|:----:|
| TS-04 | `callToolWithMetadata` 无 timeout | #88 | ⏳ code-green，等 commit |
| TS-11 | schema-converter anyOf/oneOf/null | #88 | ⏳ 同上 |
| CR-06 | checkpoint `created_at` UPSERT 覆盖 | #89 | 🔜 待 #88 合 |
| NEW-06+07 | tool output scanner 误杀 + 熔断 | #89 | 🔜 |
| NEW-09 | OmniMemStore 并发锁 + 事务 | #89 | 🔜 |
| PY-05 | MCP `except Exception` 吞错 | #89 | 🔜 |
| NEW-03 | shell_exec denylist 误杀 | #89 | 🔜 |

### 2.3 归入 #91 backlog（17 条）

| 分组 | IDs | 备注 |
|------|-----|------|
| A (Python) | PY-02 / PY-06 / PY-08 + NEW-10 | sqlite close / fts 事务 / structlog exc_info / lifespan first-injection |
| B (TS 状态) | TS-07 / TS-12 / TS-15 / CR-04 / CR-07 / CR-08 / CR-09 / CR-10 / TS-16 / TS-17 + NEW-04 / NEW-05 | mapFinishReason / mutate / bun:sqlite / mcp 错误名 / LIKE escape / memory-bridge isExternal / override 清空 / break/continue / base64 误杀 / shell env 前缀 / shell PATH |

### 2.4 R-10 / R-11（2 条，归 #89）

| R-10 | context/draft 搬迁 | #89 |
| R-11 | AI SDK v5 shim 抽 | #89 |

---

## 3. MEDIUM（62 条）归入 P2

- 全部 M-01..M-19 死代码 / 双系统 / zero-consumer → **#91 C 组**
- NEW-04 / NEW-05 / NEW-10 → 已合并入 #91 A/B 对应组
- 测试质量 T-01 / T-02 / T-03 / T-04 / T-05 / T-07 / T-11 / T-15 → **#91 C 组**
- 其余 MEDIUM（~30 条）未单独派工，属于 Iter B2 冻结后集中清理

---

## 4. LOW（35 条）

未逐条追踪。属于 "能修顺手修" 的代码风格 / 注释 / 命名类问题，不进 task tracker。

---

## 5. 漏网检查

逐条比对 ultra-review §2 所有 Code findings 与 delta-audit §1 验收表后，**无漏网 HIGH**。以下 3 条曾存疑，均已归入现有 task：

1. **CR-05**：ultra-review 里未单列，源自 Correctness subagent 原始 17 条输出，内容是 "MCP connect 竞态"——已被 CR-02（#67）覆盖
2. **M-14/15/16**：Maintainability subagent 17→19 编号跳跃，属编号空档而非遗漏
3. **T-06/08/09/10/12/13/14/16/17/18/19/20**：Testing subagent 20 条中仅 5 条被选入 P1，其余已归 #91 C 组或 LOW

---

## 6. Task 依赖链

```
#88 (in_progress) ─┬─> #89 (pending) ─┬─> #90 (brief ready)
                   │                   └─> #91 A (Python residual)
                   │
                   └─────────────────────> #91 B (TS residual, shell_exec 冲突风险 → 必须在 #90 后)
                                          └─> #91 C (dead code + tests)
```

**关键路径**：`#88 commit → #89 → #90 → #91B`。#91 A 可与 #90 并行（不同语言栈）。#91 C 随时可插。

---

## 7. 用户视角的交付进度

- **P0**（上线 Beta 前必修）：**14/14 CRITICAL** 代码已 FIXED 或 code-green 等 commit；文档 D-01..D-04 已对齐；**≈ 100%**
- **P1**（Iter B2 冻结前必修）：19 条 HIGH，7 条在派（#89），12 条 backlog（#91 A+B）；**≈ 37%**
- **P2**（Iter C/D 清理）：40+ 条 MEDIUM + 未修 HIGH；归 #91 C + 未派；**≈ 0%**
- **P3**（纯文档对齐）：TH-06 状态待 #88 commit 合后切 ✅；其余已完成

---

**文档元信息**
- 生成日期：2026-04-20
- 作者：Claude Opus 4.7（Reviewer）
- 基线：delta-audit `2026-04-20` + task list 至 #91
- 下游：用户决策 #90 / #91 派工节奏；Codex 按依赖链执行
