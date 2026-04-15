# Iteration F: Scale-Out — 多 Agent + Mesh + 全量自进化

> **状态**：待启动（依赖 Iter A ~ E 全部完成）
>
> **主轴**：06-Multi-Agent + 11-Agent-Mesh　**搭配**：10-Self-Evolution（全量）
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么最后

Scale-Out 是整个架构的"乘法器"——把单 Agent 的能力放大到多 Agent 协作网络。但乘法器的价值取决于被乘数的质量：

- 一个 context 不好、工具残缺、不会规划的 Agent，复制 10 个也只是 10 倍的混乱
- 一个记忆深度不够、没有个性的 Agent，组网也只是无差别的并行

**先把单 Agent 做到极致，再做规模化**——这是整个迭代路线的核心原则。

## 范围

### 多 Agent 编排（06）

- 同构 spawn
  - 主 Agent spawn 子 Agent（同模型、同框架）
  - 子 Agent 继承父 Agent 的 memory 访问权限（只读 / 读写可配）
  - 并行执行 + 结果聚合
- 非阻塞 Supervisor 模式
  - 主 Agent 永远响应用户，不因子任务阻塞
  - 子 Agent 进度通过 checkpoint + heartbeat 上报
  - 超时 / 失败自动回收，不影响主 Agent
- 任务分配策略
  - 基于能力声明的路由（子 Agent 声明自己擅长什么）
  - 基于负载的均衡（避免单个 Agent 过载）
  - 基于优先级的调度（紧急任务优先分配）
- 结果聚合
  - 多数投票（适合判断类任务）
  - 最佳选择（适合生成类任务，由 Supervisor 评估）
  - 流式合并（适合分段任务，按顺序拼接）

### Agent Mesh 接入（11）

- AgentMesh SDK 集成（Rust crate）
  - 启动即自动加入 mesh 网络
  - 服务发现：能看到网络中的其他 Agent
  - 能力广播：向网络声明自己的能力
- 跨 Agent 通信
  - 消息传递（request / response / stream）
  - 任务委派（将子任务发给网络中更合适的 Agent）
  - 结果回收（异步等待远端 Agent 返回）
- 异构 Agent 互操作
  - 与 Claude Code、Codex、Gemini CLI 等异构 Agent 通信
  - 通过标准协议（A2A / MCP）桥接不同 Agent 框架
  - 不做编排决策——Quilin 提供网络能力，用户决定怎么用

### 全量自进化（10-full）

- 完整自进化闭环（7 步）
  - ① 运行任务 → ② 记录轨迹 → ③ 分析失败 → ④ 规划修改
  - ⑤ 执行修改 → ⑥ 评估对比 → ⑦ 决定保留/回滚
- Scaffold 自修改
  - 系统提示词自动调优（DSPy 优化器集成）
  - 工具配置自动调整（基于使用频率和成功率）
  - 工作流拓扑自动优化（基于任务完成效率）
- 数据飞轮
  - 成功轨迹 → 训练数据 → fine-tune 评估
  - A/B 测试框架：新版 scaffold vs 旧版 scaffold
  - 渐进部署：新版先在 10% 流量验证，再全量切换
- User Insight Engine
  - 用户行为模式挖掘（常用操作序列、时间模式、偏好漂移）
  - 主动洞察推送（"你最近频繁做 X，要不要我自动化这个流程？"）
  - Aha Moment 生成（"我发现你的代码风格和 3 个月前有明显变化"）
- Idle Evolution Budget
  - 空闲时自动消耗闲置配额进行自进化
  - 范围：记忆整理、scaffold 微调、技能扩展、信息浏览
  - 下次会话开始时透明汇报自进化结果

## 依赖关系

- 依赖 Iter A ~ E 全部完成（单 Agent 能力完备）
- 06-Multi-Agent 和 11-Agent-Mesh 是一对互补模块（内部 spawn vs 外部 mesh）
- 10-Self-Evolution 全量版依赖 08-Observability（评估需要 metrics）
- Idle Evolution 依赖 09-Deployment（需要配额管理和后台运行能力）

## 验收标准

- [ ] 主 Agent 能 spawn ≥3 个子 Agent 并行执行任务
- [ ] 非阻塞 Supervisor：子 Agent 执行期间主 Agent 仍可响应用户
- [ ] 子 Agent 超时 / 失败后主 Agent 自动回收，不崩溃
- [ ] 启动后自动加入 AgentMesh 网络，能被其他 Agent 发现
- [ ] 能向网络中的其他 Agent 发送任务并接收结果
- [ ] 自进化闭环跑通：失败轨迹 → 分析 → 修改 scaffold → 评估 → 保留/回滚
- [ ] A/B 测试能对比新旧 scaffold 的性能差异
- [ ] 空闲自进化能在用户不在时自动运行，下次会话汇报结果
- [ ] User Insight Engine 至少产生 1 类主动洞察

## 参考 Spec

- [06-multi-agent/README.md](../../engineering/06-multi-agent/README.md)
- [11-agent-mesh/README.md](../../engineering/11-agent-mesh/README.md)
- [10-self-evolution/README.md](../../engineering/10-self-evolution/README.md)
