# Iteration B: Useful Tools — 工具系统 + 安全基础

> **状态**：待启动（依赖 Iter A 完成）
>
> **主轴**：05-Tool　**搭配**：07-Safety-lite
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么第二

没有更丰富的工具和基本安全分层，agent 的任务上限很低——只能聊天 + 记忆，不能"做事"。工具和安全必须绑定推进：更强的工具没有安全分层 = 风险放大器。

## 范围

### 工具系统（05）

- 多 MCP Server 连接管理（当前只连 OmniMem 一个）
  - 动态注册 / 发现 / 断线重连
  - 工具名冲突解决（namespace 前缀）
- 内置工具（至少实现 3 类）
  - `file_read` / `file_write` / `file_list` — 文件操作
  - `shell_exec` — 命令执行（带 timeout + output capture）
  - `web_fetch` — HTTP 请求（GET/POST，带响应截断）
- 工具分类体系
  - `read` — 只读操作，默认 AUTO 放行
  - `write` — 写操作，默认 AUTO 放行但记日志
  - `exec` — 执行操作，默认 CONFIRM
  - `high-risk` — 危险操作（删除、网络写入等），强制 CONFIRM

### 安全基础（07-lite）

- 权限分级：AUTO / CONFIRM / DENY 三级
- 默认 AUTO 模式（与 Claude Code auto mode 对齐）
- 工具执行前 pre-hook：检查分类 → 决定是否需要确认
- 工具执行后 post-hook：记录执行结果 + 异常检测
- 超时保护：工具执行超时自动中断
- 错误恢复：工具失败不崩溃 agent loop，返回错误信息给 LLM

## 依赖关系

- 依赖 Iter A（context 中注入工具描述）
- 05-Tool 和 07-Safety 是一对绑定模块
- 是 Iter C（Planning）的前置——没有工具，规划空转

## 验收标准

- [ ] 同时连接 ≥2 个 MCP Server（OmniMem + 至少一个新 provider）
- [ ] 内置工具 file_read / shell_exec / web_fetch 可用
- [ ] 工具按 read/write/exec/high-risk 分类
- [ ] AUTO 模式下 read 工具直接执行，high-risk 工具要求确认
- [ ] 工具超时后 agent loop 正常恢复
- [ ] 所有工具有对应的单元测试 + 集成测试

## 参考 Spec

- [05-tool/README.md](../../engineering/05-tool/README.md)
- [07-safety-guardrails/README.md](../../engineering/07-safety-guardrails/README.md)
