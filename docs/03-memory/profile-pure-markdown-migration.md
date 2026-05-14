# Profile files 纯 markdown 化迁移 / Profile files pure-markdown migration

> 状态 / Status:**Plan(spec)** · 待 quilin-mem 后端排期
> 触发 / Trigger:用户指令 2026-05-15 — `user.md / soul.md 都用纯 markdown 吧,别搞 yaml 了`
> 关联 / Related:UX-5 viewer(`apps/web/components/config/ProfileFilesSection.tsx`)、`providers/memory/src/quilin_mem/profile_store.py`

---

## 背景 / Background

English: Today the quilin-mem provider serializes `~/.quilin/user.md` and `~/.quilin/soul.md` with a YAML frontmatter block (schema_version / profile_id / scope / created_at / last_updated for user, plus persona_name / zodiac / mbti / core_values for soul) followed by a short markdown body. The viewer correctly parses both frontmatter and body, but the user-facing perception is that the page is "all schema noise, no real content" — exactly because the body is one placeholder line.

中文:目前 quilin-mem provider 把 `~/.quilin/user.md` 和 `soul.md` 序列化成 YAML frontmatter + 简短 markdown 正文。viewer 端虽然已经把 frontmatter 抽出来做 KV 表格,但用户看到的核心信息全在 schema 行,真正的"画像"和"灵魂"段没东西 —— 体验上像是只有结构没有内容。

## 目标 / Goal

English: Switch both `user.md` and `soul.md` to pure markdown documents — no YAML frontmatter, no rigid schema. The agent reads / writes them as freeform bilingual notes, with section headings (`## 基本背景 / Background`, `## 沟通偏好 / Communication preferences`, …) replacing typed fields. The agent's self-evolution loop appends timestamped observations to a `## Quilin 观察 / Agent-observed notes` section.

中文:把 user.md 和 soul.md 改成**纯 markdown 自由文档**(无 YAML、无强 schema),用二级标题段落代替原来的键值字段。agent 的自演化循环把每次会话观察到的新偏好以带时间戳的条目追加到"Quilin 观察 / Agent-observed notes"段落。

## 迁移步骤 / Migration steps

1. **Web viewer**(已完成 / done — Iter F UX-5 polish):
   - `apps/web/components/config/ProfileFilesSection.tsx` 增加 `parseFrontmatter` 解析,既支持遗留 YAML frontmatter(backward compat)又支持纯 markdown。
   - `~/.quilin/user.md` 和 `~/.quilin/soul.md` 内容已替换成纯 markdown 模板(commit 540022d 之后)。

2. **`providers/memory/src/quilin_mem/profile_store.py` 改造**(已落 / done — 2026-05-15):
   - 用**不可见 HTML 注释**作为顶部元数据载体:`<!-- quilin-profile schema=1 profile_id="..." scope=... updated_at="..." updated_by="..." sensitive_export=false -->`。纯 markdown 渲染器(Streamdown / GitHub)忽略它,但 Python 可以 round-trip 解析回 `UserProfile`。
   - `UserProfile.to_markdown` / `from_markdown` 走 `parse_profile_header`(新增),旧的 `parse_frontmatter` 保留(`soul_schema.py` 还在用 YAML)。
   - `_format_user_md` / `_default_user_md` 对齐 `to_markdown` 的 key 集(`updated_at` 而非 `last_updated`,新增 `updated_by` + `sensitive_export`)。
   - 防御 / Defensive:`_safe_metadata_value` + `UserProfile.to_markdown` inline guard 拒绝值里的 `-->`、NUL(`\x00`)、U+2028、U+2029,防止 comment escape 或文件畸形。`_split_header_tokens` 处理 JSON `\"` 转义;`_find_comment_close` 跳过引号内的 `-->`。
   - SoulDocument(`soul_schema.py`)目前还吃 YAML,无 production caller(只有测试用),迁移延后到独立 commit。
   - 测试新增 round-trip / 边界 / 控制字符 case,coverage 95%+。
   - **未做 / Still open**:TS profile-evolution.ts 的 append 和 Python `sync_user_md` 的整体 overwrite 之间的 race(见 task #14)。

3. **Agent self-evolution 写回**(待办 / TODO, 关联 [[project_user_self_evolution]] memory):
   - 在 `apps/web/app/api/chat/route.ts` POST handler 中,session 终态(`session.completed` / `turn.completed`)后异步触发一次 profile 更新流程:
     - 把本轮 user 消息 + assistant 回答送给一个 small/cheap 模型(deepseek-chat)
     - prompt:"从下面对话里抽取 1-3 条用户的**新观察**(语言偏好、技术倾向、回答风格、长期目标、敏感话题…),每条 ≤ 50 字"
     - 返回的 JSON list append 到 `~/.quilin/user.md` 的 "Quilin 观察" 段(带时间戳)
   - 类似地,soul.md 的 "Quilin 自我修正记录" 段在用户**直接给反馈**(纠错 / 重申偏好)时 append。
   - **安全门 / Safety gate**:写 `~/.quilin/*.md` 是 CRITICAL 操作(跨项目影响),按 `docs/07-safety-guardrails/README.md` §2.6 经过 WriteAuthority。当前 AUTO 信任模式下可自动追加(只 append 不删 / 不改既有段落);未来 ask 模式时弹 InlineApproval。

## 不做 / Out of scope

- 不引入新的 markdown DSL(标签、宏、metadata 块)。只用原生 markdown 段落 + 列表。
- 不强制 schema 一致性。两份文档跨用户、跨项目可以完全不同。
- 不删除既有的 SQLite-side `profile_store` 表 — 它继续做索引和跨进程查询。markdown 文件是"人类友好层",数据库是"机器可查询层"。

## 验收 / Acceptance

- `~/.quilin/user.md` 和 `soul.md` 内容里**不再出现 `---` fence 或 YAML key**;
- viewer 渲染时**完全不显示 schema · frontmatter 块**(因为没 frontmatter 可抽);
- `pnpm --filter @quilin/web exec vitest run` + `uv run pytest providers/memory/` 全过;
- 用一次真实对话(单 turn 即可)后,user.md 的 "Quilin 观察" 段出现新条目;
- 用一次"我不喜欢这种回答方式"反馈后,soul.md 的 "Quilin 自我修正记录" 段出现新条目。
