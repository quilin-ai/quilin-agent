# Iteration C: Planning Core — 规划引擎

> **状态**：待启动（依赖 Iter A + B 完成）
>
> **主轴**：04-Planning　**搭配**：01-dynamic（InferenceConfig 动态调整）
>
> **全局路线图**：[implementation-plan.md](../../planning/00-implementation-plan.md)

---

## 为什么第三

Planning 的价值建立在 context（A）和 tool space（B）之上。没有好的 context 喂给 LLM，规划不稳定；没有工具，规划只能空转。

## 范围

### 规划引擎（04）

- 意图识别：判断用户请求是"简单问答"还是"多步任务"
  - 简单问答：直接回答，不走 planning
  - 多步任务：生成 plan → 逐步执行 → 汇报结果
- 任务分解：将复杂任务拆成可执行的 step 序列
- Step budget：限制单个任务最大步数，防止无限循环
- Retry budget：单步失败后的重试策略（最多 N 次）
- 进度跟踪：每步执行后更新 state，支持中断恢复

### 动态推理配置（01-dynamic）

- 按任务复杂度自动调整 InferenceConfig
  - 简单问答：低 temperature、少 maxTokens
  - 复杂推理：高 temperature、多 maxTokens、开启 ThinkingMode
- ThinkingMode 动态切换：thinking / non-thinking
- 成本感知：预估本轮 token 消耗，余量不足时建议拆分

## 依赖关系

- 依赖 Iter A（context 质量决定 plan 质量）
- 依赖 Iter B（工具空间决定 plan 可执行性）
- 01-dynamic 是横切能力，在此迭代嵌入而非单独起专项

## 验收标准

- [ ] 简单问答不触发 planning，多步任务自动分解
- [ ] Step budget 生效：达到上限后终止并汇报
- [ ] 工具调用失败后自动重试（≤ retry budget）
- [ ] InferenceConfig 按任务类型动态切换
- [ ] Token 预估：任务前给出消耗预估

## 参考 Spec

- [04-planning/README.md](../../engineering/04-planning/README.md)
- [01-llm-integration/README.md](../../engineering/01-llm-integration/README.md)
