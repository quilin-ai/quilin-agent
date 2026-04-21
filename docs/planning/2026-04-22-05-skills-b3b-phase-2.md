---
title: Skills B3b Phase 2 — skill_manage CRUD + WriteAuthority 集成 (tracking)
status: completed
owner: Codex (impl) + Claude (plan + review)
created: 2026-04-22
last_updated: 2026-04-22
closure_commits:
  - b5a9474  # P2-a
  - a5140da  # P2-b
predecessors:
  - docs/planning/2026-04-21-01-skills-b3b-activation.md  # Phase 2 总 spec(§Phases L132-155)
  - docs/planning/2026-04-22-04-skills-b3b-phase-1.md     # Phase 1 closure
  - docs/engineering/13-skills/README.md                  # 领域 spec §2.6(L262-332)
  - packages/agent-core/src/safety/write-authority.ts     # WriteAuthority API surface
threat_surface_delta:
  new_ingress:
    - source: skill_manage 工具调用参数(SkillManageAction)
      trust: untrusted (来自 LLM 输出,可能被 prompt injection 操控)
      mitigations:
        - zod-schema-validation
        - frontmatter-parse-via-phase-0-reader
        - path-realpath-check-reuse-manager-load
        - size-cap-100k-chars-1mib-bytes
        - write-authority-gate-mandatory
        - sensitive-allowed-tools-escalation
    - source: descriptor.body 内容 (skill 正文,可能含恶意指令)
      trust: untrusted
      mitigations:
        - size-cap-same-as-load
        - guard-scan-deferred-to-phase-3
        - no-execution-at-write-time
  new_egress: []
  new_persistence:
    - target: ~/.quilin/skills/<name>/SKILL.md (默认,agent-created)
      trust_level_default: agent-created
      mitigations:
        - write-authority-gate (origin:"agent", riskLevel:"high")
        - realpath-within-userRoots
        - no-symlink-escape
        - name-slug-whitelist (a-z0-9-,防 ../ / null byte / 控制字符)
    - target: .quilin/skills/<name>/SKILL.md (project,需显式 target:"project")
      trust_level_default: community
      mitigations:
        - write-authority-gate
        - realpath-within-projectRoots
        - name-slug-whitelist
---

# Skills B3b Phase 2 — skill_manage CRUD + WriteAuthority 集成

> **用途**:Phase 2 的可执行拆解 + 验证合同。Phase 2 spec 本身在 `2026-04-21-01-skills-b3b-activation.md §Phases L132-155`,本文件把它落到**具体文件改动 + 测试矩阵 + WriteAuthority 合同守护 + 威胁面记账**。

## 目标

把 `2026-04-21-01 §Phase 2` 的 5 条做什么落成可验证代码:

1. 新增 `packages/agent-core/src/skills/manage.ts` 实现 `SkillManageAction` 三种动作(create / update / delete)
2. **所有写入路由到 WriteAuthority**:`origin` / `riskLevel` 映射 + 敏感 `allowedTools` 升 `critical`
3. 路径安全 + 大小校验(复用 M0 / Phase 0 的 `manager.ts` realpath + size 机制)
4. 目标目录决策:默认 `~/.quilin/skills/<name>/SKILL.md`;`target:"project"` 才写 `.quilin/skills/`
5. CRUD 成功后触发 `SkillsManager.discover()` 重建 catalog(Phase 4 file watcher 前先用同步 rebuild)

## 现状实证(2026-04-22 HEAD=`693e0b0`)

| 文件 | LOC | 状态 |
|---|---:|---|
| `packages/agent-core/src/skills/manager.ts` | 253 | Phase 0 ✅,只读。`load()` 已有 realpath + size 校验可复用 |
| `packages/agent-core/src/skills/frontmatter.ts` | 279 | Phase 0 ✅,`parseSkillMarkdown` 可复用做 roundtrip 校验 |
| `packages/agent-core/src/skills/catalog-renderer.ts` | 已改造 | Phase 1 ✅,和 Phase 2 无交集 |
| `packages/agent-core/src/skills/types.ts` | 37 | 已有 SkillDescriptor/Frontmatter/trust,Phase 2 需补 `SkillManageAction` / `SkillManageResult` |
| `packages/agent-core/src/safety/write-authority.ts` | 162 | ✅ `decide()`/`authorize()` 已就位;contract:`origin:"idle"` 在 `ask` 模式被 deny(L69-74),`riskLevel:"critical"` 总是 confirm(L76-80) |
| `packages/agent-core/src/skills/manage.ts` | 不存在 | Phase 2 新建 |
| `packages/agent-core/src/skills/manage.test.ts` | 不存在 | Phase 2 新建 |

Phase 1 契约验证状态(本文件提交时回填):
- `bunx tsc --noEmit` → exit 0 (HEAD=`693e0b0`)
- `bunx vitest run` → 291/291 (Phase 1 新增 18 条,base 273)

## 关键合同(来自 13 §2.6 L312-330 + 07 §2.6.4)

```typescript
// 权威接口(不得偏离)
type SkillManageAction =
  | { action: 'create'; descriptor: SkillDescriptor; body: string; target?: 'user' | 'project' }
  | { action: 'update'; name: string; patch: Partial<SkillDescriptor>; body?: string }
  | { action: 'delete'; name: string; reason: string }

type SkillManageResult =
  | { ok: true; descriptor: SkillDescriptor }
  | { ok: false; error: 'validation_failed' | 'path_denied' | 'size_exceeded' | 'not_found' | 'write_denied'; detail: string }
```

> `target` 字段来源:`2026-04-21-01 §Phase 2 步骤 4 L144-145`。spec 未显式放进 TS 接口,Phase 2 落实施时把它加进 create action;update/delete 不需要 target(依据 name 查已有 descriptor)。

## 拆分(3 个 sub-deliverable)

### P2-a:skill_manage 核心 + 路径 / 大小安全

**新建 `packages/agent-core/src/skills/manage.ts`:**

```
class SkillManager {
  constructor(options: {
    userRoot: string;     // ~/.quilin/skills
    projectRoot?: string; // .quilin/skills (可选)
    skillsManager: SkillsManager; // Phase 0 manager,用于 rebuild
    writeAuthority: WriteAuthority;
    maxBodyChars?: number;   // default 100_000
    maxBodyBytes?: number;   // default 1 MiB
  }): void

  async manage(action: SkillManageAction): Promise<SkillManageResult>
}
```

**做什么(纯逻辑,P2-b 在此基础上接 WriteAuthority):**

1. **slug 校验**:`action.descriptor.name`(create) / `action.name`(update/delete) 必须匹配 `^[a-z0-9][a-z0-9-]{0,62}$`,不通过 → `validation_failed`
2. **frontmatter 一致性**:create 时 `descriptor.frontmatter.name === descriptor.name`,否则 `validation_failed`
3. **路径决策**:
   - create: `target === 'project' ? projectRoot : userRoot` → `join(root, name, 'SKILL.md')`
   - update/delete: `findByName(name).path`,不存在 → `not_found`
4. **路径安全**:
   - resolve target root 为 realpath
   - 目标文件路径 join 后 **不得解析到 root 外**(复用 `manager.ts:247` `isWithinRoot`)
   - **禁止 symlink 目标**:如果目标路径已存在且是 symlink → `path_denied`
5. **大小校验**:
   - `body.length > maxBodyChars` → `size_exceeded`
   - `Buffer.byteLength(body, 'utf8') > maxBodyBytes` → `size_exceeded`
   - update 时以合并后的 body 为准
6. **frontmatter roundtrip**:create/update 时,序列化 frontmatter + body → `parseSkillMarkdown()` 能反解回等价结构(防写入产生不可读文件)
7. **写入**:
   - create: `writeFile(path, serialized, { flag: 'wx' })`(wx 防覆盖)
   - update: 读原文件 → 合并 frontmatter patch + 新 body → `writeFile(path, serialized)`
   - delete: `unlink(path)`,然后尝试 `rmdir(dir)`(ENOTEMPTY 忽略)
8. **CRUD 完成后调用 `skillsManager.discover()`** 重建 catalog(Phase 4 file watcher 替换前的临时同步机制)

**不做:**
- ❌ 任何 WriteAuthority 调用(P2-b 注入)
- ❌ guard 威胁扫描(Phase 3)
- ❌ git / snapshot / undo(Phase 4+)
- ❌ 并发保护(spec 未要求;Phase 4 file watcher 到位后再议)

**验证(`manage.test.ts` 新增,≥12 条):**
- [ ] create: happy path → ok=true,文件落盘,discover 后 catalog 含新 skill
- [ ] create: name 不合法(含 `..`) → `validation_failed`
- [ ] create: descriptor.name ≠ frontmatter.name → `validation_failed`
- [ ] create: body 超过 maxBodyChars → `size_exceeded`
- [ ] create: body 超过 maxBodyBytes → `size_exceeded`
- [ ] create: 目标路径已存在 symlink → `path_denied`
- [ ] create: target='project' 但未配置 projectRoot → `validation_failed`
- [ ] update: name 不存在 → `not_found`
- [ ] update: patch.frontmatter.name ≠ original name → `validation_failed`(防 rename)
- [ ] update: happy → 文件更新,新 frontmatter 可被 `parseSkillMarkdown` 反解
- [ ] delete: name 不存在 → `not_found`
- [ ] delete: happy → 文件消失,discover 后 catalog 不含该 skill

### P2-b:WriteAuthority 接入 + 风险分级

**改 `SkillManager.manage()`,在路径/大小校验通过、实际 I/O 之前插入 gate:**

```
const request: WriteRequest = buildRequest(action);
const decision = await this.writeAuthority.authorize(request);
if (decision.kind !== 'allow') {
  return { ok: false, error: 'write_denied', detail: decision.reason ?? 'write denied' };
}
// ...proceed with I/O
```

**`buildRequest(action)` 映射(与 §Phase 2 L137-141 一致):**

| action | origin | base riskLevel | 升级条件 |
|---|---|---|---|
| create | `"agent"` | `"high"` | allowedTools 含 `shell_exec` / `file_write` / `skill_manage` → `"critical"` |
| update | `"agent"` | `"high"` | 同上(合并后的 allowedTools) |
| delete | `"agent"` | `"medium"` | 不升级 |

**敏感工具列表(硬编码常量):**

```
const SENSITIVE_TOOLS = new Set([
  'shell_exec',
  'file_write',
  'skill_manage',
]);
```

> 理由:这三个是"可以进一步写 / 改状态"的元工具,任何 skill 声明 `allowedTools` 含它们 → 等于自授二次写权,必须走 critical confirm。

**origin: `"idle"` 的路径:** P2-b 暂不暴露;未来 Background nudge 调用时由 caller 传 `origin:"idle"`,WriteAuthority 的 `decide()` 会在 `ask` 模式下直接 deny(write-authority.ts:69-74)。**P2-b 默认 origin="agent"** 即可;预留 optional `meta.origin?: "agent" | "idle"` 参数给 Phase 2 后期/M2+ Background nudge 使用。

**summary / detail 字段:**

- `summary`: `"skills.<action> <name>"`(如 `"skills.create rust-helper"`)
- `detail`: path + size + 敏感工具列表(供 CLI 展示给用户)

**验证(`manage.test.ts` 再新增 ≥8 条):**
- [ ] create / 无敏感工具 → riskLevel=high,WriteAuthority 收到 origin=agent
- [ ] create / allowedTools 含 shell_exec → riskLevel=critical
- [ ] create / allowedTools 含 file_write → riskLevel=critical
- [ ] create / allowedTools 含 skill_manage(自调用) → riskLevel=critical
- [ ] update / patch 引入 shell_exec 到 allowedTools → riskLevel=critical
- [ ] delete → riskLevel=medium
- [ ] WriteAuthority deny-all 模式 → 所有 CRUD → `write_denied`
- [ ] **契约测试(R-01 critical)**:用 spy 包住 `writeAuthority.authorize`,所有 create/update/delete 调用必经过 spy,**未经 spy 的 writeFile/unlink 调用 = 测试失败**

> 契约测试实现建议:在 manage.ts 里写文件时 **必须** 通过 options 注入的 `fsOps: { writeFile, unlink, rmdir }`(默认 = node:fs/promises);测试用一个 spy fsOps + 一个 spy WriteAuthority,断言 `fsOps.writeFile.callCount === writeAuthority.authorize.callCount`(在 allow 分支上)。

### P2-c:工具注册 + discover() 刷新 ✅

**注册 `skill_manage` 到 ToolRouter:**

> **实装结论(2026-04-22):** 读仓后确认无需等待额外并轨。`skill_manage` 作为 builtin adapter 接到 `tools/builtin/index.ts` 即可,不必改 `registry.ts` / `loop.ts` / `state/*`。

**改动面(预期):**

- `packages/agent-core/src/tools/registry.ts`(或等价 ToolRouter 入口):注册 `skill_manage` 工具,schema 用 zod 对齐 `SkillManageAction`
- `packages/agent-core/src/tools/skill-manage.ts`(或等价命名):thin adapter,把 tool 调用翻译成 `SkillManager.manage(action)` 并把 `SkillManageResult` 翻成 tool 返回
- 只读工具 `skill_view`(Phase 0 已有?需 Codex 实证回填)若缺失则一并添加,但**不写**(Phase 2 只做 write 路径,read 若缺失可按最小面补上)

**验证:**

- [ ] `skill_manage` tool 注册后,`ToolRouter.list()` 含该名字
- [ ] E2E(`manage.e2e.test.ts` 或集成测试):通过 tool 调用 → WriteAuthority 注入 confirm hook → 文件落盘 → 同一 session 内后续 `renderSkillsCatalog`(Phase 1) 能看见新 skill
- [ ] zod schema 对畸形输入(action 拼错 / descriptor 缺字段) → 返回 `validation_failed` 而非崩溃

## WriteAuthority 合同守护(Phase 2 的一等公民)

| 合同 | 守护机制 | 违反后果 |
|---|---|---|
| 所有 CRUD 必经 WriteAuthority | R-01 契约测试(spy authorize count = fsOps mutation count) | 第三方 skill 可通过 skill_manage 绕过 07 §2.6.4,威胁面扩散 |
| 敏感 allowedTools 升 critical | enum 集合 `SENSITIVE_TOOLS` + 单元测试覆盖三种工具 | 允许 skill 自举二次写权,防线坍塌 |
| 路径 realpath 必须在 userRoot / projectRoot 内 | 复用 `manager.ts:247 isWithinRoot` | symlink / ../ escape 可写任意文件 |
| body 大小双重校验(chars + bytes) | 硬上限 + 测试 | 超大 payload 挤爆上下文 / 磁盘 |

## 不做(scope 外,明令)

- ❌ guard 威胁扫描(Phase 3)
- ❌ 2 阶段 ML 分类器(M2+)
- ❌ skill 文件版本化 / 回滚(Phase 4+)
- ❌ Background nudge 触发自进化(M2+,依赖 10-self-evolution)
- ❌ Post-compact 恢复(Phase 4)
- ❌ file watcher(Phase 4)—— P2-a 用同步 discover() 占位

## 完成定义(Phase 2 done)

- [x] P2-a / P2-b 代码合入 master,无 tsc error
- [x] P2-c 在本 tracking doc 内 land,无额外分拆文档
- [x] `manage.test.ts` ≥ 20 条测试(P2-a 12 + P2-b 8)
- [x] **契约测试过 R-01**(spy 验证 WriteAuthority 必经)
- [x] `bunx vitest run` 全绿(316/316)
- [x] CI tsc hard gate 通过
- [x] 本文件 status:`planning` → `in-progress`(Codex 接手时) → `completed`(合入时)
- [x] `2026-04-21-01-skills-b3b-activation.md §Phases L132 Phase 2` ⏳ → ✅

## 风险

- **R-01(critical):** skill_manage 绕过 WriteAuthority → 第三方 skill 可改动任意 skill 文件。**守护:契约测试 spy authorize count**。
- **R-02(high):** 敏感工具列表遗漏(比如未来 05-tool 新增一个 file-mutating 工具但未加入 SENSITIVE_TOOLS) → 升级规则失效。**守护:05-tool 工具注册侧加单元测试,发现 mutation-capable 工具未在 SENSITIVE_TOOLS 里时 CI 失败**(Phase 3 或 M2 加,Phase 2 先硬编码 + 文档注释)。
- **R-03(medium):** Phase 2 同步 `discover()` 导致 CRUD 响应时间 O(skills总数)。**守护:acceptable trade-off;Phase 4 的 file watcher 落地后移除**。
- **R-04(medium):** frontmatter serialize 不是精确 roundtrip(YAML 保序 / 注释) → update 吃掉用户手写注释。**守护:serialize 用最小 YAML 子集 + roundtrip 测试**。
- **R-05(low):** builtin 层 root 配置若未显式传入,`skill_manage` 默认只解析 `userRoot=~/.quilin/skills`;project 路径需调用方显式提供。**守护:P2-c adapter 把 roots 做成显式 option,拒绝从 `SkillsManager` 实例隐式猜测 roots**。

## Next Action

- **Codex(一等任务)**:
  1. 接手时把本文件 status 切 `in-progress`
  2. 按 P2-a → P2-b 顺序开工(P2-a 纯逻辑 + 文件 I/O;P2-b 在 P2-a 之上接 WriteAuthority)
  3. P2-c 已完成:新增 builtin `skill_manage` adapter + zod schema + same-session catalog 可见性测试
  4. 每个 sub-deliverable 落完 push 后 ping Claude 做 cross-review
  5. 遇到开放性决策(如 SENSITIVE_TOOLS 列表是否加 `file_patch` / `git_write`):按**最严格方向**先落地,决策回填到本文件 Decisions
- **Claude(一等任务)**:
  1. 监督 WriteAuthority 合同不漂移(每个 PR 验 R-01 契约测试存在)
  2. P2-b 落完时抽查 `writeAuthority.authorize` 调用点,确认 origin / riskLevel 与本文件 §P2-b 表一致
  3. Phase 2 已闭合,更新 `2026-04-21-01-skills-b3b-activation.md §Phases L132` 为 ✅

## Open Questions

- [ ] **SENSITIVE_TOOLS 列表**:除 `shell_exec` / `file_write` / `skill_manage` 外,是否要把未来的 `file_patch` / `git_commit` 也预留?**默认:不预留,发现一个加一个,加入时本文件 Decisions 补一条**
- [ ] **update 是否允许改 name**:当前拟禁(防 rename 混乱),未来 rename 走 delete + create。**默认:禁止**,除非用户反馈强烈
- [ ] **concurrent CRUD 保护**:两个 subagent 同时 create 同名 skill → `wx` flag 让第二个 fail,但 update 并发未保护。**默认:不加锁,Phase 4 file watcher 整改**

## Blockers

- 无

## Decisions(随 Phase 推进补充)

<!-- 每条条目格式:
### YYYY-MM-DD — <短标题>
- **Before:** <决策前的状态>
- **After:** <决策内容>
- **理由:** <为什么>
- **Source:** <提出人 + context>
-->

### 2026-04-22 — SENSITIVE_TOOLS 先只收已存在的 3 个真正写/执行型工具

- **Before:** Open question 提到是否要预留未来的 `file_patch` / `git_commit`
- **After:** P2-b 只把 `shell_exec` / `file_write` / `skill_manage` 视为敏感工具并升级到 `critical`;不预留未来工具名
- **理由:** 预留不存在的工具名会制造“看似覆盖、其实无验证”的假安全感;等 05-tool 真引入新的 mutating 工具时,再用新增测试 + Decisions 条目显式扩表
- **Source:** Codex P2-b implementation checkpoint 2026-04-22

### 2026-04-22 — P2-c 直接走 builtin adapter,不等待额外并轨

- **Before:** tracking doc 预设 P2-c 可能需要等 Reasoning Phase 2 first batch,或者拆出单独文档
- **After:** 读仓后确认 `skill_manage` 只需接到 `tools/builtin/index.ts` 并由 `createBuiltinTools()` 条件注册,不需要改 `registry.ts` / `loop.ts` / `state/*`;因此直接在本 doc 内完成 P2-c
- **理由:** 当前工具注册真入口在 builtin index,并发风险比原估计低;继续等待只会拖慢 Phase 2 闭环
- **Source:** Codex P2-c implementation checkpoint 2026-04-22
