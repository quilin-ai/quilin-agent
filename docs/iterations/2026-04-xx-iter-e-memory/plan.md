# Iteration E: Memory Depth & Personality — 记忆深度 + 个性化

> **状态**：待启动（依赖 Iter A + B + C 完成）
>
> **主轴**：03-Memory（深化）　**搭配**：12-Conversation、10-Self-Evolution（基础）
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么第五

前四个迭代把单 Agent 的"能力骨架"搭完（context + tools + planning + observability）。Iter E 开始给 Agent 注入"灵魂"——深度记忆让 Agent 真正认识用户，对话工程让 Agent 像真人一样交流，自进化基础让 Agent 能从经验中成长。

这些能力建立在前序基础之上：
- 没有好的 context 组装（A），记忆检索结果无处安放
- 没有工具系统（B），自进化无法执行修改
- 没有规划引擎（C），复杂的记忆整理任务无法分解
- 没有可观测性（D），记忆系统的效果无法量化

## 范围

### 记忆深化（03-deep）

当前 OmniMem 只有 Semantic Memory（Layer 3）的基础版本（SQLite + FTS5）。本迭代补全：

- Working Memory（Layer 1）
  - 最近 k=5 轮完整对话内容，不压缩，直接注入上下文
  - FIFO 淘汰策略：超过 k 轮自动移入 Episodic
- Episodic Memory（Layer 2）
  - LLM 驱动的语义摘要压缩（每轮对话 → 一句话摘要）
  - 保留关键决策点标记（用户显式确认 / 任务成功 / 任务失败）
  - 时间衰减：超过 T 天的 episodic 记忆自动降级或合并
- Semantic Memory 增强（Layer 3）
  - 向量索引（embedding + cosine similarity）
  - 知识图谱三元组存储（subject-predicate-object）
  - 混合检索：FTS5 + 向量 + KG 联合排序
- User Profile Store
  - 独立于对话记忆的用户画像存储
  - 结构化字段：名字、角色、偏好、常用工具、工作习惯
  - 自动从对话中提取并更新（不需要用户显式操作）

### 对话工程（12-basic）

- 6 层活人感架构的 prompt 层实现
  - 句面层：避免"希望对你有帮助"类模板话
  - 轮次结构层：不总用总分总，允许碎片化表达
  - 观点判断层：有偏好、有立场、会说"我觉得 A 比 B 好"
- 3 种风格模式
  - native：最接近底模原始风格
  - custom：用户自定义风格参数
  - alive：最大化活人感
- 风格参数注入 system prompt（通过 ContextManager）

### 自进化基础（10-basic）

- Reflector 机制
  - 会话结束时自动触发反思：本次做了什么、哪些成功、哪些失败
  - 反思结果写入 Semantic Memory（元知识层）
- 失败轨迹记录
  - 工具调用失败 / LLM 输出被用户否定 → 记录完整轨迹
  - 轨迹格式：context + action + result + user_feedback
- 基础 Skill Memory（Layer 4）
  - 成功轨迹模板化：重复成功 ≥3 次的操作序列提取为 skill
  - Skill 存储格式：trigger_condition + action_sequence + success_rate

## 依赖关系

- 依赖 Iter A（context 组装能力）
- 依赖 Iter B（工具系统，自进化需要工具执行修改）
- 依赖 Iter C（规划引擎，复杂记忆操作需要任务分解）
- 依赖 Iter D（可观测性，记忆效果需要 metrics 量化）
- 03-Memory 深化与 12-Conversation 互相配合（记忆提供个性化数据，对话工程消费它）
- 10-Self-Evolution 基础为后续全量自进化铺路

## 验收标准

- [ ] OmniMem 4 层记忆全部可用（Working → Episodic → Semantic → Skill）
- [ ] 向量检索 + FTS5 + KG 混合检索，recall 精度优于纯 FTS5
- [ ] User Profile Store 能自动从对话中提取用户信息
- [ ] 3 种对话风格可切换，alive 模式明显区别于 native
- [ ] 会话结束时自动触发反思，反思结果可检索
- [ ] 失败轨迹完整记录，包含 context + action + result
- [ ] 成功操作序列被提取为 skill 模板（≥3 次重复后）

## 参考 Spec

- [03-memory/README.md](../../engineering/03-memory/README.md)
- [12-conversation-engineering/README.md](../../engineering/12-conversation-engineering/README.md)
- [10-self-evolution/README.md](../../engineering/10-self-evolution/README.md)
