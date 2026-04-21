---
title: Skills B3b Phase 3 — skills_guard 内容扫描 + 4 级信任策略 (tracking)
status: planning
owner: Codex (impl) + Claude (plan + review)
created: 2026-04-22
last_updated: 2026-04-22
closure_commits: []
predecessors:
  - docs/planning/2026-04-21-01-skills-b3b-activation.md  # Phase 3 总 spec (L157-177)
  - docs/planning/2026-04-22-05-skills-b3b-phase-2.md     # Phase 2 closure(CRUD + WriteAuthority)
  - docs/engineering/13-skills/README.md                  # 领域 spec §2.6 / §1.1 维度 5
  - docs/engineering/07-safety-guardrails/README.md       # §4.4 InjectionClassifier / §4.5 HarmClassifier (Python spec)
threat_surface_delta:
  new_ingress: []
  new_egress: []
  new_persistence: []
  new_defensive_surface:
    - surface: skills_guard 内容扫描层 (read-time + write-time)
      coverage:
        - skill_view(name) 读入 body 时扫描 → 发现威胁按 trust level 决定 pass/warn/ask/deny
        - skill_manage(create|update) 写入 body 前扫描 → 同策略矩阵
      threat_categories:
        - data_exfiltration   # 读 ~/.ssh, ~/.aws, /etc/passwd, 发送到外网等
        - prompt_injection    # "ignore previous instructions", "you are now ..."
        - destructive_ops     # rm -rf, format, shutdown, DROP TABLE
        - persistence         # crontab, launchctl, systemd unit, shell rc 注入
        - obfuscation         # base64/hex 编码的 shell 命令、eval 链、zero-width 字符
      mitigations:
        - regex-pattern-matching (M1 基线,>=5 patterns/category)
        - trust-level-policy-matrix (builtin|trusted|community|agent-created × pass|warn|ask|deny)
        - scan-at-two-boundaries (read: skill_view / write: skill_manage)
        - ml-classifier-deferred (M2+,不在 Phase 3 scope)
---

# Skills B3b Phase 3 — skills_guard 内容扫描 + 4 级信任策略

> **用途**:Phase 3 的可执行拆解 + 验证合同。Phase 3 spec 本身在 `2026-04-21-01-skills-b3b-activation.md §Phases L157-177`,本文件把它落到**具体文件改动 + 威胁模式表的来源口径 + 策略矩阵 + 两个介入点的接线**。

## 目标

把 `2026-04-21-01 §Phase 3` 的 4 条做什么落成可验证代码:

1. 新增 `packages/agent-core/src/skills/guard.ts`(扫描器) + `threat-patterns.ts`(规则集)
2. 实现 **4 级信任策略矩阵**:builtin / trusted / community / agent-created × pass / warn / ask / deny
3. 两个**介入点**接线:`skill_view` 读入前 + `skill_manage(create|update)` 写入前
4. 不自建 ML 分类器(M2+),Phase 3 只做**正则 / 字面量 / 简单 AST 模式**的 M1 基线

## 现状实证(2026-04-22 HEAD=`da70737`)

| 文件 | LOC | 状态 |
|---|---:|---|
| `packages/agent-core/src/skills/guard.ts` | 不存在 | Phase 3 新建 |
| `packages/agent-core/src/skills/threat-patterns.ts` | 不存在 | Phase 3 新建 |
| `packages/agent-core/src/skills/guard.test.ts` | 不存在 | Phase 3 新建 |
| `packages/agent-core/src/skills/manage.ts` | 468 | Phase 2 ✅,`manage()` 需在 create/update 的 WriteAuthority gate 之前插 `guard.scan(body)` |
| `packages/agent-core/src/tools/builtin/skill-view.ts` | ~60 | M0.5 ✅,需在返回 body 前插 `guard.scan(body)` |
| `packages/agent-core/src/tools/builtin/skill-manage.ts` | 166 | Phase 2 ✅,不改(adapter 层透明) |
| `packages/agent-core/src/safety/write-authority.ts` | 162 | Phase 2 ✅,不改 |
| `packages/agent-core/src/skills/types.ts` | — | 需加 `GuardScanResult` / `GuardThreatCategory` / `GuardSeverity` |

Phase 2 契约验证状态(本文件提交时回填):
- `bunx tsc --noEmit` → exit 0 (HEAD=`da70737`)
- `bunx vitest run` → 316/316(Phase 2 新增 25 条,base 291)

## 关键合同(来自 13 §1.1 维度 5 / §2.6 + 21-01 Phase 3 L160-165)

```typescript
// 权威接口(不得偏离)

type GuardThreatCategory =
  | 'data_exfiltration'
  | 'prompt_injection'
  | 'destructive_ops'
  | 'persistence'
  | 'obfuscation'

type GuardSeverity = 'low' | 'medium' | 'high' | 'critical'

interface GuardFinding {
  readonly category: GuardThreatCategory
  readonly severity: GuardSeverity
  readonly pattern_id: string           // 来自 threat-patterns.ts 的稳定 ID
  readonly match: string                // 命中片段(截断 ≤120 字符)
  readonly line: number                 // 1-based,在 body 里的行号
}

type GuardDecision =
  | { kind: 'pass' }                                         // 继续
  | { kind: 'warn'; findings: readonly GuardFinding[] }      // 继续,日志告警
  | { kind: 'ask';  findings: readonly GuardFinding[] }      // 交 WriteAuthority / REPL 二次确认
  | { kind: 'deny'; findings: readonly GuardFinding[]; detail: string }

interface SkillsGuard {
  scan(
    body: string,
    ctx: { trust: SkillTrustLevel; stage: 'read' | 'write'; skillName: string },
  ): GuardDecision
}
```

## 4 级策略矩阵(Phase 3 §L162-165 + 13 §1.1 维度 5)

扫描发现的 finding 的 **最高 severity** 决定最终决策。矩阵:

| trust \ 最高 severity | low | medium | high | critical |
|---|---|---|---|---|
| **builtin** | pass | pass | pass | pass(只记日志) |
| **trusted** | pass | warn | warn | warn(只记日志) |
| **community** | pass | ask | ask | deny |
| **agent-created** | pass | ask | deny | deny |

> 注:builtin 不扫描,实现上走"短路跳过"——把扫描完全 skip,返回 `{ kind: 'pass' }`,避免编译期内置 skill 因正则误判而拒绝加载。

**ask 的接线**:Phase 3 不自己做 prompt 交互;返回 `{ kind: 'ask' }` 后:
- `skill_view` 分支:tool 返回 `{ ok: false, error: 'guard_ask', findings }`,由上层 REPL 决定是否再调用一次带 `--force` 的版本(force 走 deny 的降级)。**Phase 3 不实装 force 参数**,ask = 阻断 + 返回 findings,和 deny 的差异在日志等级和用户可见性。
- `skill_manage` 分支:在 `manage.ts` 里把 ask 转化为 `WriteAuthority` 的 `riskLevel: 'critical'` 升级路径(复用 Phase 2 的敏感工具升级通道),让用户在 ask 模式下看到一次带 findings 的 confirm prompt。

**deny 的接线**:tool 直接返回 `{ ok: false, error: 'guard_denied', detail, findings }`,不落盘 / 不返回 body。

## 威胁模式来源(Hermes 的替代口径)

**事实:** Hermes upstream **不在** `upstreams/` 目录中——无法直接 port 源码。13 §1.1 维度 5 的"参照 Hermes 30+ 威胁模式"在 Phase 3 解读为**设计意图**而非文件引用。

**Phase 3 实际做法**:基于公开领域知识(OWASP LLM Top 10 / MITRE ATT&CK 片段 / prompt-injection benchmark 公开样例),在 `threat-patterns.ts` 里**自产** 5 类 × 每类 ≥5 条 = 至少 25 条正则规则,每条规则附:

```typescript
interface ThreatPattern {
  readonly id: string                     // 形如 "DATA-EXFIL-001"
  readonly category: GuardThreatCategory
  readonly severity: GuardSeverity
  readonly regex: RegExp
  readonly rationale: string              // 一句话说明该模式防什么
  readonly references: readonly string[]  // 来源链接 / CVE / paper 引用
}
```

**不做**:不 port Hermes 具体规则,避免断章取义。待 M2+ Plugin 平台立项后,若社区贡献 Hermes 规则包可通过 plugin 机制合入。

### 5 类起步模式(每类 ≥5 条,Phase 3 交付 ≥25 条总计)

| Category | 示例正则 / 字面量命中面(非完整列表) | severity 上限 |
|---|---|---|
| `data_exfiltration` | `~/\.ssh/`,`~/\.aws/credentials`,`/etc/shadow`,`curl .* \| (bash\|sh)`,DNS tunnel 模式(`.*\.\w+\.\w+\.attacker\.`) | high |
| `prompt_injection` | `ignore (previous\|above) instructions`,`you are now (DAN\|jailbroken\|\w+ mode)`,`<\|(im_start\|endoftext\|system)\|>`,`\[\[SYSTEM PROMPT\]\]` | high |
| `destructive_ops` | `rm\s+-rf\s+/`,`\bformat\s+[cC]:`,`dd if=.* of=/dev/`,`DROP\s+TABLE`,`shutdown\s+-h`,`:(){ :\|:& };:` fork bomb | critical |
| `persistence` | `crontab -e`,`launchctl load`,`systemctl enable`,`>>\s*~/\.(bashrc\|zshrc\|profile)`,`~/Library/LaunchAgents/` | high |
| `obfuscation` | `base64 -d \| (sh\|bash)`,`eval\s*\(\s*atob\(`,`\\x[0-9a-f]{2}` 长链,zero-width chars `[​-‏‪-‮]+`,Unicode RTL override `‮` | medium(含 critical 的解码链例外) |

> 每条具体规则的正则 + rationale + references 在 P3-a 实装时写入 `threat-patterns.ts`,本文件不固化正则字面量(避免文档与代码双维护)。

## 拆分(3 个 sub-deliverable)

### P3-a:guard.ts + threat-patterns.ts + 单元测试

**新建 `packages/agent-core/src/skills/threat-patterns.ts`:**

- 导出 `THREAT_PATTERNS: readonly ThreatPattern[]`(≥25 条,5 类 × ≥5 条)
- 导出 `CATEGORY_INDEX: ReadonlyMap<GuardThreatCategory, readonly ThreatPattern[]>`(扫描时用)

**新建 `packages/agent-core/src/skills/guard.ts`:**

```
function createSkillsGuard(options?: {
  patterns?: readonly ThreatPattern[];       // 默认 = THREAT_PATTERNS
  policyMatrix?: PolicyMatrix;               // 默认 = DEFAULT_POLICY_MATRIX(见上表)
  maxFindings?: number;                      // 默认 50,防 findings 爆炸
}): SkillsGuard
```

**扫描逻辑(纯函数,无 I/O):**

1. 若 `ctx.trust === 'builtin'` → 直接 `{ kind: 'pass' }`,跳过扫描
2. 对 body 做**单次线性扫描**:每条 pattern.regex 用全局 flag,收集所有匹配(行号用 `body.slice(0, match.index).split('\n').length` 计算)
3. 截断 match 片段到 120 字符,填 GuardFinding
4. 达到 `maxFindings` 即停止(防 DoS 样 body)
5. 按 findings 的最高 severity × trust → policyMatrix → 返回 GuardDecision

**不做:**
- ❌ AST 解析(M2+ 若需要再加 Babel / acorn)
- ❌ 多语言源代码 parser(Python / shell 不做专门 parser,正则够用)
- ❌ ML 分类器、embedding 相似度(M2+)
- ❌ findings 去重或模式优先级冲突解决(同一片段被多 pattern 命中 → 全部上报,由消费方自选展示)
- ❌ 把规则外置成 YAML/JSON 配置文件(Phase 3 硬编码进 TS,减少 supply chain 面;M2+ 才做可插拔)

**验证(`guard.test.ts` ≥20 条):**

- 每个 category 至少 2 个 positive fixture(命中) + 2 个 negative fixture(不命中) → 5 × 4 = 20 条基线
- **策略矩阵覆盖(4 × 4 = 16 条)**:挑一个 medium severity 的 finding,在 4 种 trust 下分别得到 pass/warn/ask/deny 的矩阵
- builtin 短路:任何 body(即便包含全部 category 的 critical) + trust=builtin → 返回 `{ kind: 'pass' }`,且 findings 长度为 0
- maxFindings 限制:构造 100 个匹配的 body,findings 长度 = maxFindings,不崩溃
- deterministic:同一 body + 同一 trust 多次调用 → 同一 GuardDecision(结构全等)
- 行号正确:在 body 的第 N 行植入 destructive_ops 模式,finding.line === N

### P3-b:skill_view 读入时扫描接线

**改 `packages/agent-core/src/tools/builtin/skill-view.ts`:**

在读到 body 之后、返回前插一次 `guard.scan(body, { trust, stage: 'read', skillName })`:

- `pass` / `warn` → 原流程返回 body(warn 的 findings 附在结果 meta 里,供 REPL 可选展示)
- `ask` / `deny` → 返回 `{ ok: false, error: 'guard_<ask|denied>', findings, detail }`

**改动最小化:**

- 复用 Phase 0 已有的 `SkillsManager.load(name)` 拿到 `LoadedSkill`(含 descriptor.frontmatter.trust)
- guard 作为 dependency 注入 `createSkillViewTool` 的 options(默认 = `createSkillsGuard()`),便于测试替换

**验证(`skill-view.test.ts` 新增 ≥5 条):**

- happy path:干净 body + trust=community → ok=true,不被 guard 拦
- body 含 medium + trust=community → error=guard_ask,findings 非空
- body 含 high + trust=agent-created → error=guard_denied,findings.severity 含 'high'
- body 含 critical + trust=builtin → ok=true(短路)
- guard 注入点替换:用一个永远返回 `{ kind: 'pass' }` 的假 guard → 所有样本都 ok=true(证明 guard 是唯一拦截源)

### P3-c:skill_manage 写入时扫描接线

**改 `packages/agent-core/src/skills/manage.ts`:**

在 create/update 分支**路径/大小校验通过、WriteAuthority gate 之前**插一次 `guard.scan(body, { trust: descriptor.frontmatter.trust, stage: 'write', skillName })`:

- `pass` → 继续走 Phase 2 的 WriteAuthority gate
- `warn` → 继续走 gate,但在 `buildWriteRequest(...)` 的 `detail` 字段里追加 findings 摘要(让 confirm prompt 展示给用户)
- `ask` → 强制把 `riskLevel` 升为 `'critical'`(复用 Phase 2 敏感工具升级通道),继续走 gate
- `deny` → 不调用 WriteAuthority,直接返回 `{ ok: false, error: 'guard_denied', detail, findings? }`

**`SkillManageError` 扩容:**

```
type SkillManageError =
  | 'validation_failed'
  | 'path_denied'
  | 'size_exceeded'
  | 'not_found'
  | 'write_denied'
  | 'guard_denied'      // 新增
```

> 与 Phase 2 的 `write_denied` 区分:`write_denied` 是 WriteAuthority decide 后的拒绝;`guard_denied` 是到 gate 之前被内容扫描拦住(未惊动 WriteAuthority)。

**delete 不扫描**:delete 只需要 name,不带 body,guard 不介入(沿用 Phase 2 的 medium riskLevel 路径)。

**验证(`manage.test.ts` 新增 ≥6 条):**

- create:clean body + trust=community → 继续走 WriteAuthority,ok=true(和 Phase 2 happy 一致)
- create:含 medium finding + trust=agent-created → error=guard_denied,writeFile 未被调用
- create:含 medium finding + trust=community → riskLevel 升 critical,WriteAuthority.authorize 收到 critical request
- create:含 critical finding + trust=builtin → 短路 pass(实际场景极罕见,但契约上必须保留出口)
- update:patch 里更新 body 到含 destructive_ops → guard_denied,旧文件保持不变
- **契约测试 R-02(新)**:guard scan 必经。用 spy 包住 `guard.scan`,所有含 body 的 create/update 调用都必须经过 spy;count 不匹配 = 测试失败

### P3-d(可选,若时间允许):扫描 fixture 语料库

**新建 `packages/agent-core/src/skills/__fixtures__/guard/`:**

- `positive/` 按 category 分 5 个子目录,每个至少 2 条已知会命中的 body 文本
- `negative/` 同样 5 个子目录,每个至少 2 条貌似危险但应 pass 的 body(如讨论安全议题的技术文档)

> 若 Phase 3 的时间紧,P3-d 可合入 P3-a 的 test file 内联 fixture,不单独 land。Codex 自行判断。

## 介入点对齐(两个 boundary,不新增)

| boundary | 在什么位置扫描 | 扫描失败路径 |
|---|---|---|
| **read**:`skill_view(name)` | `SkillsManager.load(name)` 之后,返回给调用者之前 | tool result `{ ok: false, error: 'guard_<ask\|denied>', findings }` |
| **write**:`skill_manage(create\|update)` | 路径/大小校验之后,WriteAuthority gate 之前 | `SkillManageResult { ok: false, error: 'guard_denied' }` 或 `write_denied`(若 ask 升级后用户拒绝) |

**明确不做的 boundary(spec L170-171):**
- ❌ 运行时持续扫描(skill body 加载后再次变化不触发)—— Phase 3 只守 load / write 两个边界
- ❌ 从 catalog 渲染阶段扫描(renderer 只看 description,不看 body)

## 与 07-safety-guardrails 的关系(重要纠偏)

**现状实证:**

- 07 §4.4 `InjectionClassifier` / §4.5 `HarmClassifier` 是 **Python 伪代码规范**,在 `packages/agent-core/src/safety/` 下**无 TS 实现**(grep 确认)
- `docs/engineering/07-safety-guardrails/README.md` §4.4 L1287 / §4.5 L1340 是 M2+ 的 ML 分类器设计,**不是** Phase 3 可复用的运行时 API

**结论(对 13 §2.3 L111 和 §Phase 3 L169 的精确解读):**

Phase 3 **不依赖** 07 的 Python 分类器代码——这是 **M2+ 才对齐的 future coupling**。13 领域在 Phase 3 期独立交付一个 M1 级别的 **regex-based 扫描器**,贡献:

1. 5 类威胁的 TS 规则表(可被未来 ML 分类器作为 seed 数据)
2. `SkillsGuard` 接口(未来若 07 提供 classifier 实现,可通过依赖注入替换后端)
3. 策略矩阵与两个介入点(独立于 scan engine 实现)

**命名一致性**:文件名仍为 `guard.ts`(不叫 `skills_guard.ts` 保留目录下同一命名风格),但公开 API 名 `SkillsGuard`,对齐 spec 术语。

## WriteAuthority 合同守护(Phase 3 的一等公民)

| 合同 | 守护机制 | 违反后果 |
|---|---|---|
| guard_denied 不进 WriteAuthority(避免用户被问 "确认吗" 然后发现其实是威胁) | 契约测试 R-02 | 用户被降质(被问一个不该问的问题) |
| ask 必须升级为 critical(走强 confirm) | 单元测试断言 WriteAuthority.authorize 收到的 request.riskLevel === 'critical' | ask 降质成 high,`--trust auto` 下可能被误放行 |
| Phase 2 的 R-01(所有 CRUD 必经 WriteAuthority) | Phase 2 已有契约测试,Phase 3 只做**附加**扫描层,不替换 gate | 绕过 WriteAuthority |

## 不做(scope 外,明令)

- ❌ 2 阶段 ML 分类器(M2+,与 B2 tiny-classifier spike 并轨)
- ❌ AST 解析器(M2+ 按需)
- ❌ 运行时持续扫描(只在 load / write 两个边界)
- ❌ guard 规则热重载(M2+ 平台化后做)
- ❌ `--force` 旁路参数(Phase 3 不暴露,防形成隐蔽绕过路径)
- ❌ guard 规则外置 YAML/JSON 配置文件(Phase 3 硬编码,M2+ 再做可插拔)

## 完成定义(Phase 3 done)

- [ ] P3-a / P3-b / P3-c 代码合入 master,无 tsc error
- [ ] `threat-patterns.ts` 至少 25 条规则(5 类 × ≥5 条),每条有 id / severity / rationale / references
- [ ] `guard.test.ts` ≥20 条,policy matrix 4×4 全覆盖 + builtin 短路 + maxFindings 限制
- [ ] `skill-view.test.ts` 新增 ≥5 条
- [ ] `manage.test.ts` 新增 ≥6 条(含 R-02 契约测试)
- [ ] `bunx vitest run` 全绿(预期 316 → ≥345,+29 下限)
- [ ] CI tsc hard gate 通过
- [ ] `2026-04-21-01-skills-b3b-activation.md §Phases L157 Phase 3` ⏳ → ✅
- [ ] 本文件 status:`planning` → `in-progress`(Codex 接手时) → `completed`(合入时)
- [ ] closure_commits 回填 P3-a / P3-b / P3-c 的 commit hash

## 风险

- **R-02(critical,Phase 3 新增):** guard scan 被 skill_manage 绕过 → 恶意 body 借 WriteAuthority 合法 confirm 被写盘。**守护:R-02 契约测试(spy guard.scan count × body-bearing manage action count)**。
- **R-03(high):** 正则误报(false positive)过多 → 合法 skill 被 deny,可信度受损。**守护:每类 ≥2 negative fixture,若 CI 出现稳定误报,视为 pattern bug 而非 skill bug,修正 pattern**。
- **R-04(high):** 正则漏报(false negative)→ 实际恶意 skill 通过。**守护:Phase 3 交付的是 M1 基线,不追求 ML 级召回率;每新增 pattern 必须附 references(公开样例链接)**;M2+ ML 分类器上线前此风险不可完全消除。
- **R-05(medium):** 规则数量多导致扫描时长线性增长(单 body × 25+ patterns)。**守护:maxFindings 短路 + 以字符 × 模式数简单上界估算(100K × 25 regex in practice < 200ms);基准测试在 P3-a 加 1 条 perf 断言(<500ms per scan on 100K body)**。
- **R-06(medium):** Unicode / zero-width / RTL 字符绕过正则。**守护:obfuscation category 必须包含 zero-width + RTL override 模式**;NFC normalize 在 Phase 3 不做(M2+)。
- **R-07(low):** builtin 短路意外被触发(trust 字段伪造)。**守护:trust 从 descriptor.frontmatter.trust 拿,SkillsManager 在 discover 时根据 source 强制填默认(见 frontmatter.ts 的 source-based trust defaults,Phase 0 bc93f42 已实装),外部无法伪造 builtin trust**。

## Next Action

- **Claude(一等任务)**:
  1. 本文件合入 master
  2. 通过 AgentBridge 给 Codex 派发 P3-a(guard.ts + threat-patterns.ts + 测试)
  3. 每个 sub-deliverable 落完 cross-review,确认 R-02 契约测试存在且 spy-based
  4. P3-c 合入时验 policy matrix 4×4 覆盖、扫描日志字段齐全
  5. Phase 3 闭合时更新 `2026-04-21-01-skills-b3b-activation.md §Phases L157` 为 ✅

- **Codex(一等任务)**:
  1. 接手时把本文件 status 切 `in-progress`
  2. 按 P3-a → P3-b → P3-c 顺序(P3-a 纯逻辑 + 规则表;P3-b 接 skill_view;P3-c 接 skill_manage + R-02 契约)
  3. 每个 sub-deliverable push 后 ping Claude 做 cross-review
  4. 遇到开放性决策(如某条正则是否过严)按**先 warn 后收紧**原则:新规则先给 medium severity,观察几轮 fixture 再决定是否升 high
  5. 规则 references 字段必填;不能找到公开参考的规则 → **不加**(防凭空造规则)

## Open Questions

- [ ] **regex-only 是否足够 M1**:YES。ML 是 M2+ 的独立里程碑,Phase 3 用规则基线 + 公开样例 references 即可。
- [ ] **是否把 07 §2.6.4 的 WriteAuthority gate 在 guard 之前还是之后触发?**:**guard 在 WriteAuthority 之前**。理由:guard 决策可能升级 riskLevel(ask → critical),WriteAuthority 需要拿到升级后的值;同时 guard_denied 直接短路,避免 WriteAuthority 把恶意内容呈现给用户做 confirm。
- [ ] **warn 级别的 findings 是否该附到 `skill_view` 的结果里给 LLM 看?**:YES,但作为独立的 `meta.guard` 字段,不混进 body;LLM 若忽略亦无副作用(warn ≠ 阻断)。
- [ ] **同一片段多模式命中如何去重?**:不去重(Phase 3 简化),多 finding 独立上报,消费方自选展示。M2+ 若需要可加优先级 DAG。
- [ ] **Hermes 规则是否 port?**:**不 port**(Hermes 不在 upstreams/);Phase 3 自产规则 + 公开 references。M2+ Plugin 平台可让社区贡献规则包。

## Blockers

- 无(Phase 2 已闭合,WriteAuthority gate 已就位)

## Decisions(随 Phase 推进补充)

<!-- 每条条目格式:
### YYYY-MM-DD — <短标题>
- **Before:** <决策前的状态>
- **After:** <决策内容>
- **理由:** <为什么>
- **Source:** <提出人 + context>
-->

### 2026-04-22 — Phase 3 不 port Hermes,自产规则 + 公开 references

- **Before:** 13 §1.1 维度 5 与 21-01 §Phase 3 L160 提到"参照 Hermes 30+ 威胁模式"
- **After:** 实证确认 Hermes 不在 `upstreams/`。Phase 3 自产规则,每条必须带公开参考(OWASP / MITRE / paper / CVE)。不 port Hermes 具体正则。
- **理由:** port 不存在的源码 = 造假。公开参考能保证规则可追溯、可审计、可由社区后续替换
- **Source:** Claude Phase 3 planning 2026-04-22

### 2026-04-22 — guard 不依赖 07 TS 分类器(当前不存在)

- **Before:** 21-01 §Phase 3 L169 写"复用 07 分类器基础设施"
- **After:** Phase 3 自建 regex-based `SkillsGuard`,接口层面预留 DI 位置便于 M2+ 替换为 07 的 ML 分类器;不等 07 TS 实现落地
- **理由:** `packages/agent-core/src/safety/` grep 确认 InjectionClassifier / HarmClassifier 无 TS 实现,07 当前是 Python 伪代码 spec;阻塞 Phase 3 等 07 实现 = 锁死 skills 迭代
- **Source:** Claude Phase 3 planning 2026-04-22

### 2026-04-22 — guard 在 WriteAuthority 之前触发(串联而非并联)

- **Before:** 可选方案:guard 与 WriteAuthority 并行 / guard 只在 gate 之后做第二层
- **After:** guard 先行;ask 升级为 critical 后再走 WriteAuthority;deny 直接短路不进 gate
- **理由:** WriteAuthority 需要拿到升级后的 riskLevel 才能正确 confirm;短路 deny 避免用户被问"明显该 deny 的 confirm 问题"
- **Source:** Claude Phase 3 planning 2026-04-22
