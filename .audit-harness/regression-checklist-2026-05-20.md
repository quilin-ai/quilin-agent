# Web 端 8-fix 回归测试 checklist / Regression test checklist after 8 fixes

> 等 8 个 subagent 全部 ✅ + cherry-pick 进 master 后,主线跑这份回归
> Run this regression after all 8 subagents ✅ + cherry-pick to master

## Pre-flight

- [ ] 杀掉旧 web dev / agent-core service
- [ ] `pnpm install`(若有新依赖)
- [ ] 启动 quilin-mem + agent-core + web dev(端口 3000)
- [ ] curl http://127.0.0.1:3000/ → 200,加载完(>10s 首次编译)

## Fix #1 (streaming stall + polling 风暴 + 工具卡片) - SC-1

- [ ] Navigate /
- [ ] 输入框输入"请用 web_fetch 抓取 https://example.com 然后用一句中文报告 HTTP 状态"
- [ ] 发送
- [ ] **5-10 秒内**看到 `web_fetch` 工具卡片(展开/折叠按钮)
- [ ] 工具卡片显示 "✓ HTTP 200"
- [ ] **30 秒内**看到 assistant 文字回复
- [ ] `/api/agents?parent=xxx` polling 在 done 后立即停止(不超过 5 个请求)
- [ ] 刷新页面,工具卡片 + assistant 消息仍正确显示

## Fix #2 (sessions 列表点击 → 不回放) - SC-4

- [ ] Navigate /sessions
- [ ] 点任一会话项
- [ ] **3 秒内**完整历史消息显示(工具卡片 + assistant + markdown 表格 + 列表)
- [ ] 不能再出现 "开始对话 · session id ..." 空状态

## Fix #3 (sessions delete) - SA-2

- [ ] Navigate /sessions(36 条 baseline)
- [ ] 找某条会话,hover 看到 delete 按钮
- [ ] 点 delete → 确认弹窗 → 文案"确定删除会话..."
- [ ] 点"取消" → 列表不变
- [ ] 点 delete → 确认 → 列表少一条 + API 返 200
- [ ] 刷新 → DB 确实少了

## Fix #4 (memory batch delete + 去重) - SA-3

- [ ] Navigate /memory(54 条 baseline)
- [ ] 列表 tab 每条左侧 checkbox
- [ ] 选 3 条 → 顶部 sticky bar 出现 "已选 3 条"
- [ ] 点"删除选中" → 确认 → 列表少 3 条
- [ ] 刷新 → DB 少 3 条
- [ ] 点"一键去重" → 预览弹窗 "将删除 X 条,保留 Y 条"
- [ ] 确认 → 列表更新

## Fix #5 (MCP/Tools 重连入口) - SA-4

- [ ] Navigate /mcp(11 个服务,5 失败)
- [ ] 失败的每个 server 项右侧"↻ 重连"按钮
- [ ] 点 plane 的"↻ 重连" → loading → 失败状态(token 仍然过期)
- [ ] 点"📋 复制错误" → 剪贴板有完整 error JSON
- [ ] Navigate /tools → MCP 服务器连接区也有重连按钮
- [ ] grep 确认 /mcp 和 /tools 共享 McpServerCard component

## Fix #6 (config 编辑) - SC-2

- [ ] Navigate /config
- [ ] "灵魂与画像" 区域不再有"只读 viewer"提示(或者改为可编辑提示)
- [ ] 点 user.md 旁边的 "编辑" 按钮
- [ ] 编辑器打开,改一个字段
- [ ] 点"保存" → approval gate 弹窗 → 显示要写入路径 + diff 预览
- [ ] 确认 → file_write API 调用 → 200
- [ ] 刷新 /config → 改动生效

## Fix #7 (/api/mcp 慢) - SC-3

- [ ] 重启 web dev 完后,第一次 Navigate /mcp
- [ ] **2 秒内**显示骨架 + 服务名(即使 status 还在 loading)
- [ ] 不再卡 >15s

## Fix #8 (移动端 overflow) - SA-4 追加

- [ ] Playwright `browser_resize(width=390, height=844)`
- [ ] Navigate /mcp → document.scrollingElement.scrollWidth ≤ 390(不溢出)
- [ ] Navigate /tools → 同样不溢出
- [ ] 长 MCP 错误文本 wrap 不撑容器
- [ ] /sessions /memory /skills /config / 也都同 viewport 验证(顺手回归)

## Fix #9 (Skills YAML 多行) - SA-1

- [ ] 重启后 Navigate /skills
- [ ] 显示 ≥ 150 个 skill(目标:160,如果还有几个 broken 真问题就保留)
- [ ] 顶部 "⚠ 未加载" 数应该是 0 或接近 0

## Fix #10 (favicon + shiki) - SA-1

- [ ] curl http://127.0.0.1:3000/favicon.ico → 200
- [ ] 浏览器 tab title 旁有 icon 显示
- [ ] tail -50 .logs/web.log 无 shiki package warning

## 全局非回归检查

- [ ] 跑一遍 `pnpm --dir packages/agent-core test`(全过)
- [ ] 跑一遍 `pnpm --dir packages/agent-core exec tsc --noEmit`(EXIT=0)
- [ ] 跑一遍 `pnpm --dir packages/agent-core exec biome check src/`(无 error)
- [ ] 跑一遍 `pnpm --dir apps/web exec tsc --noEmit`(EXIT=0)
- [ ] 跑一遍 `pnpm --dir apps/web exec biome check .`(无 error)
- [ ] 跑一遍 `pnpm --dir apps/web exec playwright test`(全过)
- [ ] Monitor `.logs/web.log` + `.logs/agent-core.log` 无新 ERROR / WARN spike

