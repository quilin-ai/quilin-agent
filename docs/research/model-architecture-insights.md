# 模型架构洞察 — 六大开源模型设计参考

从 MiniMax M2.7、GLM-5.1、Qwen3-VL、MAI-UI、UI-TARS-2、DeepSeek V3.2 六个模型的架构设计中提炼出的 Agent 框架设计参考。

## 六大模型概览

| 模型 | 参数量（总/激活） | 强项 | 核心创新 |
|------|-------------------|------|---------|
| **MiniMax M2.7** | 230B/10B | 编程/推理/自进化 | 自主修改自身 scaffold 代码（100+ 轮自进化） |
| **GLM-5.1** | 744B/40B | Function Calling / 异步 Agent RL | 三种思考模式 + 异步 RL 解耦生成与训练 |
| **Qwen3-VL 235B** | 235B/22B | Computer Use / 视觉理解 | DeepStack 多层视觉特征 + 统一视觉-语言-动作管线 |
| **MAI-UI 32B** | 32B | GUI 精确定位 | Zoom-In 两段式坐标预测 + Device-Cloud 协作 |
| **UI-TARS-2** | 230B/23B | 移动端自动化 / 多平台 GUI | 分层记忆 + PPO 多轮 RL + 数据飞轮 |
| **DeepSeek V3.2** | 671B/37B | 高效低成本 | MLA KV 压缩 + 稀疏注意力 + 自验证 |

## 跨模型设计模式提炼

以下 7 个设计模式是从 6 个模型中反复出现的共性，应直接融入 Harness 架构。

### 模式 1: 分层记忆（Hierarchical Memory）

**来源**：UI-TARS-2 + GLM-5.1 + MAI-UI

```
UI-TARS-2 的设计：
┌─────────────────────────────────────────────┐
│  Working Memory（工作记忆）                    │
│  最近几步的完整截图 + 动作 + 推理             │
│  高保真，不压缩                              │
├─────────────────────────────────────────────┤
│  Episodic Memory（情景记忆）                  │
│  更早历史的语义压缩摘要                      │
│  保留关键决策点，丢弃重复步骤                 │
└─────────────────────────────────────────────┘

GLM-5.1 的补充策略：
  - Keep-recent-k（k=5）：保留最近 5 轮完整观测
  - Discard-all at T=32K：超过阈值时丢弃全部旧观测
  - 效果：BrowseComp 从 55.3% → 62.0%
```

**对 Harness 的启示**：
- OmniMem 的 SHORT/MID/LONG/ULTRA 四层已经对了方向
- 但需要加入 **Keep-recent-k 策略**：短时记忆保留最近 k 轮完整内容
- 需要加入 **阈值丢弃策略**：上下文超过阈值时主动丢弃而非压缩
- Working Memory 和 Episodic Memory 的区分比简单的时间衰减更有效

### 模式 2: 混合动作空间（Hybrid Action Space）

**来源**：MAI-UI + UI-TARS-2

```
MAI-UI 的动作空间（最完整）：
├── GUI 操作
│   ├── click(x, y)
│   ├── long_press(x, y)
│   ├── type(text)
│   ├── swipe(x1, y1, x2, y2)
│   ├── drag(x1, y1, x2, y2)
│   ├── system_button(back/home/recent)
│   └── wait(seconds)
│
├── 程序化操作
│   ├── mcp_call(tool, params)     ← 直接调用 MCP 工具
│   └── terminal(command)          ← 终端命令
│
├── 交互操作
│   ├── ask_user(question)         ← 请求用户澄清
│   └── answer(response)           ← 回答问题
│
└── 控制操作
    └── terminate(reason)          ← 结束任务
```

**对 Harness 的启示**：
- ToolRouter 不应该只有 "调用工具" 一种动作类型
- 应该支持 **GUI 操作 + 程序化工具 + 用户交互 + 流程控制** 四类动作
- `ask_user` 作为一等公民动作，而非事后补丁
- `mcp_call` 与 GUI 操作在同一个动作空间中统一调度

### 模式 3: 自进化闭环（Self-Evolution Loop）

**来源**：MiniMax M2.7 + UI-TARS-2 + MAI-UI

```
MiniMax M2.7 的自进化循环（100+ 轮）：
  分析失败轨迹 → 规划修改 → 修改 scaffold 代码
      → 运行评估 → 对比结果 → 决定保留/回滚
  结果：性能提升 30%

UI-TARS-2 的数据飞轮（无数据浪费）：
  执行任务 → 成功轨迹 → SFT 数据
           → 失败轨迹 → 预训练数据
  → 更新模型 → 执行更多任务 → 循环

MAI-UI 的迭代拒绝采样：
  微调模型 → 部署 → 生成新轨迹
  → 筛选好轨迹 → 加入训练集 → 重新微调 → 循环
```

**对 Harness 的启示**：
- 已有的上游监控 + Claude 缝合是一种自进化，但粒度太粗
- 应该加入 **Agent 级自进化**：Agent 自己分析失败原因 → 修改自己的提示词/工具配置/工作流
- **技能自创**：Agent 执行复杂任务时自动创建可复用的技能（类似 Hermes 的 skills）
- **数据飞轮**：每次 Agent 运行的轨迹都应该被记录，成功的用于优化，失败的用于学习

### 模式 4: 两段式精确定位（Zoom-In Grounding）

**来源**：MAI-UI

```
MAI-UI 的 Zoom-In 策略：

第 1 步：粗定位
  整张截图 → 模型预测大概坐标 (x̂, ŷ)

第 2 步：精定位
  以 (x̂, ŷ) 为中心裁剪出半尺寸窗口
  → 裁剪图 → 模型重新预测精确坐标

效果：ScreenSpot-Pro 67.9% → 73.5%（+5.6%）
```

**对 Harness 的启示**：
- BrowserProvider 的 VisualBrowser 模式应该实现两段式定位
- 第一轮用低分辨率截图获取大致位置，第二轮裁剪放大获取精确坐标
- 这个模式可以推广到所有需要精确定位的场景（不只是 GUI）

### 模式 5: Device-Cloud 协作（Local + Cloud）

**来源**：MAI-UI

```
MAI-UI 的双角色架构：

┌──────────────────────────────────┐
│  本地 Agent（轻量模型）            │
│  双重角色：                       │
│    1. 执行器 — 执行 GUI 操作      │
│    2. 监控器 — 检测轨迹是否偏离    │
│                                  │
│  本地统一轨迹记忆                  │
│  (截图 + 动作 + 指令历史)          │
└──────────────┬───────────────────┘
               │ 偏离检测触发
               ▼
┌──────────────────────────────────┐
│  云端 Agent（大模型）             │
│  接收错误摘要 + 上下文            │
│  重新规划 → 返回修正指令           │
└──────────────────────────────────┘
```

**对 Harness 的启示**：
- LLMRouter 不只是根据任务类型选模型，还应该支持 **本地-云端协作模式**
- 简单操作由小模型（DeepSeek/本地模型）快速执行
- 偏离检测时升级到大模型重新规划
- 这比 "所有步骤都用大模型" 便宜 10-100 倍

### 模式 6: 三种思考模式（Thinking Modes）

**来源**：GLM-5.1

```
GLM-5.1 的三种思考模式：

1. Interleaved（交错思考）
   用户消息 → <think>推理</think> → 响应/工具调用
   每轮都独立思考

2. Preserved（保留思考）
   跨多轮保留 <think> 块，思考链跨轮延续
   适合需要连续推理的复杂任务

3. Turn-level（轮级控制）
   由调用方决定哪些轮开启/关闭思考
   简单任务关闭思考节省 token
```

**对 Harness 的启示**：
- Agent 不应该总是 "想" 或总是 "不想"
- 应该支持 **按任务复杂度动态调整思考深度**
- 简单工具调用（读文件）→ 关闭思考
- 复杂规划（多步任务分解）→ 开启保留式思考
- 这直接影响 token 成本和响应速度

### 模式 7: 内建验证（Built-in Verification）

**来源**：DeepSeek V3.2 + UI-TARS-2 + MAI-UI

```
DeepSeek 的自验证 + 元验证：
  生成答案 → 自验证（答案对吗？）→ 元验证（验证过程对吗？）
  核心洞察："正确的答案不保证正确的推理"

UI-TARS-2 的 VLM-as-Verifier：
  同一个模型既执行又验证
  F1 = 83.8%

MAI-UI 的 MLLM-as-Judge：
  用多模态模型评判轨迹质量
  与人类评估 83% 一致
```

**对 Harness 的启示**：
- Verifier 层不应该只是 "过滤有害内容"
- 应该加入 **每步验证**：每次工具调用后验证结果是否符合预期
- 应该加入 **元验证**：验证过程本身是否正确
- Agent 自身可以作为 Verifier（不需要额外模型）

## 对 Harness 架构的具体影响

### 1. OmniMem 记忆系统（受 UI-TARS-2 + GLM-5.1 影响）

```
OmniMem（更新后的设计）
├── Working Memory（工作记忆）
│   ├── 最近 k 轮完整内容（k=5，GLM-5.1 策略）
│   ├── 当前任务的截图/工具结果
│   └── 不压缩，高保真
│
├── Episodic Memory（情景记忆）
│   ├── 更早轮次的语义压缩摘要
│   ├── 保留关键决策点
│   └── Discard-all at threshold（GLM-5.1 策略）
│
├── Semantic Memory（语义记忆）
│   ├── 向量索引 + KG 三元组
│   ├── 跨会话持久化
│   └── 相关性检索
│
└── Skill Memory（技能记忆）
    ├── Agent 自创的技能/工具
    ├── 成功轨迹模板
    └── 可复用的工作流
```

### 2. ToolRouter 动作空间（受 MAI-UI + UI-TARS-2 影响）

```
ToolRouter（更新后的设计）
├── 程序化工具（Function Calling）
│   ├── 文件操作（Read/Write/Edit/Glob/Grep）
│   ├── 终端命令（Bash）
│   ├── MCP 工具（动态发现）
│   └── 代码执行（沙箱）
│
├── GUI 操作（Computer Use / Browser Use）
│   ├── 浏览器操作（navigate/click/type/scroll/extract）
│   ├── 桌面 GUI（click/drag/type/screenshot）
│   ├── 移动端（tap/swipe/long_press/system_button）
│   └── Zoom-In 精确定位（MAI-UI 两段式）
│
├── 交互操作
│   ├── ask_user(question)     ← 请求用户澄清
│   ├── show_progress(status)  ← 展示进度
│   └── human_handoff(task)    ← 交接给人类
│
└── 控制操作
    ├── spawn_agent(config)    ← 生成子 Agent
    ├── terminate(reason)      ← 结束任务
    └── self_modify(changes)   ← 自我修改（自进化）
```

### 3. LLMRouter 多模型路由（受 MAI-UI Device-Cloud + GLM-5.1 思考模式影响）

```
LLMRouter（更新后的设计）
├── 路由策略
│   ├── 任务类型路由（编码→M2.7, 视觉→Qwen3-VL, ...）
│   ├── 成本路由（简单任务→DeepSeek, 复杂→大模型）
│   └── Device-Cloud 路由（本地快速执行 + 云端复杂推理）
│
├── 思考模式控制（GLM-5.1 启发）
│   ├── thinking_mode: "off"        ← 简单工具调用
│   ├── thinking_mode: "interleaved" ← 每步独立思考
│   └── thinking_mode: "preserved"   ← 跨轮连续思考
│
├── Fallback 链
│   └── 主力 → 备份 → 低成本
│
└── 监控器（MAI-UI 启发）
    ├── 轨迹偏离检测
    └── 自动升级到更强模型
```

### 4. Verifier 验证层（受 DeepSeek + UI-TARS-2 影响）

```
Verifier（更新后的设计）
├── 输入验证（Guard）
│   ├── 注入检测
│   ├── 有害内容过滤
│   └── 权限检查
│
├── 步骤验证（新增，DeepSeek 启发）
│   ├── 工具结果验证 — 结果是否符合预期
│   ├── 状态一致性检查 — Agent 状态是否合理
│   └── 轨迹偏离检测 — 是否偏离原计划
│
├── 输出验证（Guard）
│   ├── 安全检查
│   ├── 格式校验
│   └── 质量评估
│
└── 元验证（新增，DeepSeek 启发）
    └── 验证过程本身是否正确
```

### 5. 自进化引擎（受 MiniMax M2.7 + UI-TARS-2 影响）

```
SelfEvolution（新增模块）
├── 轨迹记录
│   ├── 每次运行完整记录（任务/动作/结果/评分）
│   └── 成功/失败标注
│
├── 失败分析
│   ├── 自动分析失败原因
│   ├── 识别常见失败模式
│   └── 生成改进建议
│
├── Scaffold 自修改（MiniMax M2.7 启发）
│   ├── 修改系统提示
│   ├── 调整工具配置
│   ├── 优化工作流
│   └── 对比实验 → 保留/回滚
│
├── 技能自创
│   ├── 复杂任务执行后自动提炼为可复用技能
│   ├── 技能库管理（安装/卸载/版本化）
│   └── 跨 Agent 共享
│
└── 数据飞轮（UI-TARS-2 启发）
    ├── 成功轨迹 → 技能模板
    ├── 失败轨迹 → 避坑指南
    └── 持续积累 → 持续改进
```

## 实现优先级

| 设计模式 | 影响的 Harness 组件 | 实现 Phase |
|----------|-------------------|-----------|
| 分层记忆 | OmniMem | Phase 3 |
| 混合动作空间 | ToolRouter | Phase 1 + Phase 5 + Phase 6 |
| 三种思考模式 | LLMRouter | Phase 0 |
| 内建验证 | Verifier | Phase 2 |
| 两段式定位 | BrowserProvider | Phase 6 |
| Device-Cloud 协作 | LLMRouter | Phase 4 |
| 自进化闭环 | 新增 SelfEvolution | Phase 8+ |
| 数据飞轮 | 新增 TrajectoryStore | Phase 8+ |
| 技能自创 | 新增 SkillManager | Phase 8+ |
