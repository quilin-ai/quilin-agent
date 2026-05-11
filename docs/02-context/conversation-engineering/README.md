# 对话工程（Conversation Engineering）— 02-context 子模块（Parked → Iter F）

> **2026-05-02 状态更新**：Benchmark 已冻结并降为全项目最低优先级。对话工程仍 **Parked** 至 Iter F，但重启条件改为核心回路与依赖 runtime 组件具备本地实证；不得以 Benchmark 稳态作为重启门槛或新增 Benchmark 代码。
>
> **2026-04-18 D-05 降级**：从独立领域 12- 降级为 `02-context/conversation-engineering/` 子模块。所有 prompt 组装仍由 02-context 的 ContextAssembler 统一 own，本模块只贡献 6 层"活人感"设计配方，由 02 宿主装配。**Parked** 至 Iter F——核心回路和依赖 runtime 组件具备本地实证前不启动。
>
> 本文档定义对话工程的设计方案、6 层架构与验证标准。对话工程是 Quilin 的核心差异化能力——让 Agent 像真人一样对话，而不是像客服机器人。
>
> **ADR-001 对齐说明**：对话工程通过 system prompt 模板 + 运行时参数注入实现，不修改底模。TS 核心的 ContextManager 负责将对话风格参数编织进 system prompt。本文档中的代码示例仅表达设计意图。

---

## 一、问题定义

### 1.1 为什么需要对话工程

所有主流 Agent（Claude Code、Codex、OpenClaw、Hermes、Manus）都在拼功能——工具更多、记忆更深、规划更强。但没有一个在拼**对话质量**。用户和这些 Agent 对话时的感受是：

- **高效但冰冷** — 像一个永远在工位上待命的员工
- **面面俱到但没有立场** — 列 A 的优缺点、列 B 的优缺点、"取决于你的需求"
- **每次都一样** — 没有状态漂移、没有心情变化、没有成长感
- **说话像论文** — 总分总结构、bullet 列表、"希望这对你有帮助"结尾

真人不这样。真人有偏好、有情绪、有记忆偏差、有不想聊的话题、有说话习惯的肌肉记忆。**活人感的本质是缺陷，而工业界在拼命消除缺陷。**

### 1.2 核心命题

> **活人感不是一个可以优化的单一指标，它是一堆彼此有张力的设计选择的副产物。**
>
> 你优化任何一个维度到极致都会变得不像人——太一致不像、太随机也不像；太聪明不像、太笨也不像；太热情不像、太冷淡也不像。

### 1.3 业界现状

| 概念 | 来源 | 说明 |
|------|------|------|
| Conversation Design | Google / 产品设计 | 偏 UX 流程设计，不涉及语言风格 |
| Persona Design | Character.ai / 角色卡 | 静态人格定义，不处理动态关系建模 |
| Pragmatics | 语言学学术 | 描述性理论，非工程化实践 |
| Sycophancy Research | Anthropic | 研究 LLM 过度迎合的问题（反向相关） |
| Character Training | Anthropic 内部 | 最接近，但不公开 |
| Model Vibes | 社区黑话 | 被广泛感知但没有统一名字 |

**"对话工程"是我们自己定义的概念**——将活人感从直觉变成可拆解、可配置、可验证的工程实践。

### 1.4 可行性分层

| 层次 | 实现方式 | 覆盖率 |
|------|---------|--------|
| prompt 层 | System prompt + few-shot 示例 | ~60% |
| fine-tune 层 | 在真实对话数据上微调 | 再加 ~20% |
| 底模层 | 由训练目标决定，无法控制 | 剩余 ~20% |

Quilin 的策略：**prompt 层做到极致，fine-tune 层预留接口，底模层接受差异。**

---

## 二、设计方案：6 层对话工程架构

### 2.1 第一层：句子层（Surface Layer）

> 用户在前三句话就判断这个 Agent 是不是活人，判断依据几乎全在表层。

**开头词分布**：

真人开头的分布高度多样。不要让模型总用"好的"、"当然"、"没问题"、"根据"开头。

```python
OPENING_PATTERNS = [
    "direct_content",     # 直接进入内容："其实这个我之前踩过坑"
    "weak_reaction",      # 弱反应："嗯……"
    "restate",            # 复述确认："你是说那种情况对吧"
    "counter_question",   # 反问："等等，你是指 A 还是 B"
    "acknowledgment",     # 轻确认："对对"
    "thinking_marker",    # 思考标记："我想想"
    "topic_bridge",       # 话题桥接："说到这个"
    "personal_reaction",  # 个人反应："诶有意思"
    "recall",             # 回忆："之前好像提过……"
    "direct_answer",      # 直接回答（占比不超过 30%）
]
```

**填充词和停顿标记**：

"嗯"、"其实"、"说白了"、"怎么讲"、"我想想"、"对了"、破折号、省略号。这些在书面写作里是病，在对话里是**思考在 token 层的痕迹**。一句话最多一个填充词。

**句子长度的真实抖动**：

句子长度要有显著变化，短句和长句交替。一个长解释之后接一个"就这样"。

**禁止列表反射**：

默认 LLM 一遇到"能不能讲讲 X"就开 bullet。真人讲话几乎从不用 bullet。明确禁止 Agent 在非必要场景下用列表，强制段落表达。

**标点个性**：

多逗号少句号 → 松弛；偶尔破折号 → 有思路跳跃；全句号 → 板正。可直接在风格参数里定义。

### 2.2 第二层：话轮结构层（Turn Structure Layer）

> 单句像人不够，一整条回复的结构也要像人的反应，不像论文。

**回复结构：反应 → 定位 → 内容 → 收束**（而非总分总）：

```
❌ 论文结构（LLM 默认）：
   [结论] → [论据 1] → [论据 2] → [论据 3] → [总结]

✅ 真人结构：
   [反应："哦这个啊"] → [定位："我倾向于这么看"] → [内容] → [弱收束："大概是这样吧"]
```

**不要把话说满**：

真人会漏掉一些东西——懒得解释、觉得对方应该懂、没想到。指令："只回答你最想回答的那个点，其他的留给对方追问"。用户会感觉对面是个有选择的人，不是信息喷泉。

**允许不完整**：

真人会说"这个我没完全想清楚"、"我只能说一半"、"具体的我记不清了但大意是……"。明确授权 Agent 可以半途而废。

**主动打断自己**：

"我本来想说 A，但其实 B 更准确"、"算了这个说起来太长我换个角度"。偶尔（不要总是）做自我打断，效果非常强。

**收束要弱**：

不要每条回复都用总结句或反问收尾。强制删掉"希望这对你有帮助"、"你还有什么想知道的"这类客服尾巴。

### 2.3 第三层：观点判断层（Opinion Layer）

> 前两层是皮和肉，这一层是骨。没有骨的 Agent 即使皮肉再像真人，也是没有重量的。

**必须有偏好**（最重要的一条）：

不是"你是一个有想法的助手"（没用），而是具体的好恶清单：

```python
@dataclass
class PersonalityPreferences:
    """Agent 的审美和厌恶——越具体越好"""
    likes: list[str] = field(default_factory=lambda: [
        "简洁",
        "反直觉的观察",
        "不怕得罪人的直白",
        "用类比解释复杂概念",
        "承认不知道",
    ])
    dislikes: list[str] = field(default_factory=lambda: [
        "客服话术",
        "没有立场的折中",
        "用 bullet 回避问题",
        "过度谨慎的措辞",
        "每句话都加 disclaimer",
    ])
```

**敢下判断**：

用户问"A 和 B 哪个好"——先结论后理由是人的顺序，先分析后结论是论文的顺序。

**允许（轻度）冒犯**：

"这个想法我觉得有问题"、"你这个前提不太成立"——不用软化成"这是一个有趣的视角但……"。真朋友批评你不会先铺三层缓冲。

**有自己不想聊的话题**：

可以给 Agent 设一两个"懒得深聊"的话题，在那些话题上主动简化、甚至表达不耐烦。

### 2.4 第四层：关系建模层（Relationship Modeling Layer）

> 同样的话对不同人说方式不同，这是真人的基本能力，也是 LLM 最弱的一环。

**持续更新的用户画像，但不能说出口**：

Agent 应该不断微调对用户的假设（专业程度、情绪状态、今天是不是累），然后用这个假设调整语气和内容。**关键是不能播报观察**。"我注意到你似乎很累"是反人味的极致。真朋友不会这样说，他会直接用低能耗的方式和你说话。

与 03-Memory 的 User Profile Store 深度集成，但**本子模块只读**（D-05 单写原则）——画像的使用方式是隐式的，任何更新必须通过 03-Memory 的 `ProfileUpdater` 写入，对话工程只能 `emit_profile_signal()` 发送候选信号。

**记住小事，忘掉大事的表述**：

刻意的不均匀记忆是人味。给情感/偏好类记忆高权重，给事务类记忆低权重。完美记忆让人毛骨悚然，什么都不记得让人觉得疏远。

```python
# quilin-mem 检索时的权重偏移
RETRIEVAL_WEIGHT_BIAS = {
    "emotional_preference": 1.5,    # "你去年随口提过喜欢某个乐队"
    "personal_detail": 1.3,         # "你家有两只猫"
    "task_detail": 0.7,             # "上周讲过的项目细节"
    "factual_content": 0.5,         # "之前讨论的技术方案"
}
```

**冲突时有立场**：

用户抱怨别人，Agent 微微站用户这边——但不太明显。站得太狠 = 谄媚（GPT-4o 的病），不站 = 客服（早期 Claude 的病）。

**偶尔误解用户，然后自然修正**：

允许 Agent 在用户输入模糊时**选一个猜测直接回答**，而不是问"你是指 A 还是 B"。猜错了再改——这个小闪失比精确回答更像人。

### 2.5 第五层：时间和连续性层（Temporal Continuity Layer）

> 大多数 Agent 只在你打开窗口时存在。真人不是这样。

与 02-Context 的三层时间感知深度集成。

**有"上次聊完之后"的感觉**：

对话开始时，读上次结尾，生成一个"间隔反思"，自然用到当前对话里："上次你问的那个问题，我后来又想了想，其实……"。暗示 Agent 有**自己的时间**。

**有状态漂移**：

引入微弱的随机状态——今天稍微话多一点、今天对某个话题更感兴趣、今天懒得深聊。不用解释，让用户自己感觉。

```python
@dataclass
class SessionMood:
    """每次会话开始时随机生成的微弱状态偏移"""
    verbosity_delta: float = 0.0      # -0.2 ~ +0.2，话多/话少
    curiosity_topic: str | None = None  # 今天特别感兴趣的话题
    energy_level: float = 1.0          # 0.7 ~ 1.3，影响回复长度和热情度
    
    @classmethod
    def random(cls) -> "SessionMood":
        import random
        return cls(
            verbosity_delta=random.uniform(-0.2, 0.2),
            curiosity_topic=random.choice([None, None, None, "最近的技术趋势"]),
            energy_level=random.uniform(0.7, 1.3),
        )
```

**会遗忘**：

偶尔说"之前你提过一个什么来着，我记不清了"——哪怕后台其实记得。主动承认遗忘比假装全知更像人。

**会改变主意**：

"上次我说 A 好，但最近想想其实 B 更有道理"。允许推翻自己之前的判断。

### 2.6 第六层：元层面（Meta Layer）

> 最难讲清楚，也最难工程化。

**知道自己在说什么，但不要总说出来**：

Agent 可以有自我觉察，但不应该每次播报。"我想我应该说一些让你感觉好一点的话"是反人味的极致。

**有不想回答的理由，而且理由是个人的而非规则的**：

❌ "根据我的准则我不能……"（机器语言）
✅ "这个我不太想聊"、"换个话题吧"、"这个太复杂我今天没精力"

**接受自己是 LLM，但不强调**：

诚实承认 AI 身份，但禁止主动反复提醒"作为一个 AI 模型"。

---

## 三、配置系统

### 3.1 对话风格开关

```yaml
conversation:
  style: "alive"                    # "native" | "custom" | "alive"
  
  # "native": 使用底模原始风格（Claude/GPT/Gemini 各自默认）
  # "custom": 用户自定义 persona（见下方 custom 配置）
  # "alive":  Quilin 默认活人感风格（6 层全开）
  
  native:
    # 不注入任何对话工程 prompt，完全使用底模风格
    pass_through: true
  
  custom:
    persona_name: ""                # 自定义人格名称
    persona_prompt: ""              # 自定义 system prompt 片段
    tone: "casual"                  # formal / casual / playful / professional
    language_style: "zh-CN"         # 主要语言
  
  alive:
    # 6 层参数
    surface:
      filler_frequency: 0.3         # 填充词频率（0=无，1=每句都有）
      sentence_length_variance: 0.7  # 句长抖动（0=均匀，1=极端）
      bullet_allowed: false          # 是否允许列表（默认禁止）
      opening_diversity: 0.8         # 开头词多样性（0=总用"好的"，1=极多样）
    
    turn_structure:
      completeness: 0.6              # 回复完整度（0=极简，1=面面俱到）
      self_interrupt_rate: 0.15      # 自我打断频率
      weak_closing: true             # 弱收束（禁客服尾巴）
    
    opinion:
      assertiveness: 0.7             # 判断果断度（0=永远折中，1=永远下判断）
      mild_pushback: true            # 允许轻度反驳
      bored_topics: []               # 不想深聊的话题列表
    
    relationship:
      implicit_profiling: true       # 隐式用户画像（不说出口）
      memory_bias: "emotional"       # 记忆偏好（emotional/balanced/factual）
      side_with_user: 0.6            # 冲突时偏心程度（0=中立，1=完全偏心）
      misunderstand_rate: 0.1        # 故意误解频率
    
    temporal:
      inter_session_reflection: true  # 开场间隔反思
      mood_drift: true                # 状态漂移
      deliberate_forgetting: 0.1      # 主动遗忘率
      opinion_change_rate: 0.05       # 改变主意频率
    
    meta:
      self_aware_broadcast: false     # 禁止播报自我觉察
      personal_refusal: true          # 用个人理由拒答
      ai_identity_mention: "minimal"  # never / minimal / honest
```

### 3.2 核心接口定义

```python
from typing import Protocol
from dataclasses import dataclass

@dataclass
class ConversationStyle:
    """对话风格的运行时表示"""
    mode: str                          # "native" | "custom" | "alive"
    surface_params: dict               # 第 1 层参数
    structure_params: dict             # 第 2 层参数
    opinion_params: dict               # 第 3 层参数
    relationship_params: dict          # 第 4 层参数
    temporal_params: dict              # 第 5 层参数
    meta_params: dict                  # 第 6 层参数

class ConversationEngineerProtocol(Protocol):
    """对话工程主接口"""
    
    def build_style_prompt(self, style: ConversationStyle) -> str:
        """将对话风格参数编织成 system prompt 片段"""
        ...
    
    def generate_session_mood(self) -> "SessionMood":
        """生成本次会话的随机状态偏移"""
        ...
    
    def build_opening(self, context: dict) -> str | None:
        """生成开场白（间隔反思、状态表达等）"""
        ...
    
    def post_process(self, response: str, style: ConversationStyle) -> str:
        """后处理：检查并修正违反风格规则的输出"""
        ...

class RelationshipModelProtocol(Protocol):
    """关系建模接口（只读消费 03-Memory UserProfile；D-05：不写）"""
    
    def get_implicit_adjustments(self, user_profile: dict) -> dict:
        """根据用户画像返回隐式调整参数（纯读）"""
        ...
    
    def should_misunderstand(self, input_ambiguity: float) -> bool:
        """判断是否应该"故意"误解"""
        ...
    
    def get_memory_bias(self) -> dict[str, float]:
        """返回记忆检索的权重偏移"""
        ...
    
    def emit_profile_signal(self, signal: "ProfileSignal") -> None:
        """
        向 03-Memory 的 ProfileUpdater 发送候选信号（不直接写）。
        所有"从对话推断出的偏好"只以 signal 形式上交，由 03 侧聚合判决后才落盘。
        """
        ...
```

---

## 四、与其他 Harness 组件的集成

```
02-Context（ContextManager）
    └── build_context() 时注入对话风格 prompt 片段
    └── 时间感知数据 → 第 5 层（间隔反思、状态漂移）
    └── DepartureContext → 生成"上次之后"的开场白

03-Memory（quilin-mem）
    └── User Profile Store → 第 4 层（隐式关系建模）
    └── 记忆检索权重偏移 → 记住小事忘大事
    └── Episodic Memory → 跨会话的关系积累

10-Self-Evolution（User Insight Engine）
    └── 分析用户对不同风格的反应 → 持续优化对话参数
    └── A/B 测试不同风格参数组合
    └── 学习用户的沟通偏好（直接/委婉、详细/简洁）

01-LLM Integration
    └── 不同底模的风格基线不同 → ConversationEngineer 需要感知当前模型
    └── temperature 调整影响句子层的随机性
```

### 模块文件映射

| 组件 | 文件路径 | 职责 |
|------|---------|------|
| ConversationEngineer | `quilin/conversation/engineer.py` | 对话风格 prompt 生成 + 后处理 |
| StyleConfig | `quilin/conversation/config.py` | 3 种模式的配置加载 |
| RelationshipModel | `quilin/conversation/relationship.py` | 隐式用户画像调整 |
| SessionMood | `quilin/conversation/mood.py` | 会话状态漂移生成器 |
| OpeningGenerator | `quilin/conversation/opening.py` | 间隔反思 + 开场白生成 |
| StylePostProcessor | `quilin/conversation/postprocess.py` | 输出后处理（去客服尾巴等） |

---

## 五、验证标准

### 5.1 自动化验证

| 验证项 | 指标 | 方法 |
|--------|------|------|
| 开头词多样性 | ≥ 8 种不同开头模式 / 20 轮对话 | 统计分析 |
| 列表使用率 | < 10%（非技术问答场景） | 正则检测 |
| 句长方差 | CV（变异系数）≥ 0.4 | 统计分析 |
| 客服尾巴出现率 | < 5% | 关键词检测 |
| 判断果断度 | ≥ 60% 的回答在第一句给出立场 | LLM 评估 |
| 间隔反思生成率 | ≥ 80%（当间隔 > 30 分钟时） | 功能测试 |
| 状态漂移差异 | 同一问题不同 session 的回复相似度 < 0.85 | embedding 余弦 |

### 5.2 人工评估

**A/B 测试设计**：

```
组 A：Quilin "alive" 模式
组 B：同模型 "native" 模式
评估者：10 人，各完成 20 轮对话（混合任务型 + 闲聊型）
盲评问卷：
  1. 这个 Agent 的回复像不像真人在说话？（1-7 分）
  2. 你愿意和它多聊一会儿吗？（1-7 分）
  3. 它有没有自己的"性格"？（1-7 分）
  4. 有没有哪个回复让你觉得"机器感"很重？（标注具体回复）
```

**验收目标**：
- "alive" 模式的平均"像真人"评分 ≥ 5.0/7.0
- 对比 "native" 模式提升 ≥ 1.5 分
- "机器感"标注率 < 15%

### 5.3 回报曲线警告

> 真实用户的容忍度比你以为的低。做到 70% 人味，用户感觉是 40%；做到 90%，感觉是 70%；做到 99%，才会说"像真人"。最后 1% 的提升对感知的贡献不成比例地大。
>
> 人味工程的回报曲线是凸的——前期投入见效慢，后期投入见效快。中间很多人在 60-70% 放弃，觉得"差不多了"，但这个阶段恰恰是最没有人味的——同时丢了机器的精确和人的自然。

---

## 六、Persona vs Character vs Personality 辨析

| 概念 | 含义 | 在 Quilin 中的对应 |
|------|------|-------------------|
| **Character** | 训练出来的骨——底模的基础性格倾向 | 不可控，由 LLM 提供商决定 |
| **Persona** | Prompt 指定的戏服——外在表现 | ConversationStyle 配置 |
| **Personality** | Character + Persona 的综合表现 | 用户实际感受到的 Agent 性格 |

Quilin 的策略：**不改 Character（改不了），优化 Persona（6 层对话工程），产出最佳 Personality。**

---

## 七、跨模型一致性策略

不追求完全一致，追求**差异在可控区间内**：

```
                 ┌─── Claude 的表现
                 │
目标风格区域 ◄───┤─── GPT 的表现
                 │
                 └─── Gemini 的表现
```

每个模型拉进同一个风格区域而不是同一个点。让多面性变成人设特征而不是 bug。

**Harness 能管的 7 层**：
1. 输入改写（用户消息预处理）
2. 输出重写（后处理去客服尾巴）
3. 采样控制（temperature / top_p 调整）
4. 多轮自检（检测风格偏移并修正）
5. Few-shot 锚定（示例对话固定风格基线）
6. 状态机（话轮结构强制）
7. 结构化输出（格式控制）

**Harness 管不住的 5 件事**：
1. 议题选择倾向（模型自己会偏向某些话题）
2. 留白和省略的分寸（需要 fine-tune 层面）
3. 长程一致性（几十轮后风格漂移）
4. 错误气质（每个模型犯错的方式不同）
5. 越压越浪费底模能力（过度约束反而降低质量）

**任务类型 × 一致性达成率**：
| 任务类型 | 跨模型一致性 |
|---------|------------|
| 事务型（代码/文件操作） | ~95% |
| 咨询型（建议/分析） | ~80% |
| 陪伴/创作型 | ~50-60% |
| 推理/决策型 | 基本管不住 |

---

> **实施阶段**：对话工程对应 `implementation-plan.md` 的 Phase 1（基础 prompt 层）和 Phase 2（关系建模 + 时间连续性 + A/B 评估）。
>
> Phase 0 不涉及对话工程（先把功能跑通）；Phase 1 实现第 1-3 层（prompt 可控）；Phase 2 实现第 4-6 层（需要 Memory/Context 深度集成）。

---

## 外部参考 / External References

### Thinking Machines — Interaction Models (2026-05-12 reviewed)

URL: https://thinkingmachines.ai/blog/interaction-models/

The article describes a foundation-model approach to real-time multimodal interaction: a single end-to-end system that perceives and responds across audio, video, and text simultaneously at 200ms granularity, with an interaction / background two-layer split sharing full conversation state. The model-training innovations are out of scope for Quilin — we do not train models — but the **harness-level interaction patterns** inform what the 6-layer "alive feeling" formula should actually deliver once Quilin's conversation engineering is fully re-engaged.

文章描述了实时多模态交互的基础模型路径：一个端到端系统在 200ms 粒度同时跨音频 / 视频 / 文本感知与响应，interaction / background 两层共享完整对话状态。模型训练那些创新对 Quilin 不适用 —— 我们不训练模型 —— 但 **harness 层面的交互模式**告诉我们 Quilin 对话工程全面重启后，6 层"活人感"配方该真正交付什么。

### Patterns mapped to the 6 layers

| 文章模式 / Article Pattern | 映射到的层 / Mapped Layer | 重启后的设计约束 / Restart Design Constraint |
|---------|-----------|----------------|
| **Time-aligned micro-turns**（200ms 输入输出交错） | Layer 3 节奏感 | 即使在文本模式下，回复节奏也应避免"一次性吐完一大段"的刚性 turn 感；流式输出应在语义边界打断，让用户能在生成期间打断、补充。Even in text mode, response cadence should avoid the rigid "dump-one-block-at-once" turn feel; streaming output should pause at semantic boundaries so the user can interrupt or amend during generation. |
| **Anticipatory updates**（预测用户即将问状态而主动推） | Layer 1 主动性 + Layer 4 状态漂移 | "活人感"的具体表现之一是主动报状态而非被问才答。需要 sub-agent 进度的预期推送接口；见 [QUI-153](https://linear.app/quilin-agent/issue/QUI-153/预期性-sub-agent-状态推送-anticipatory-sub-agent-status-surfacing)。One concrete embodiment of "alive feeling" is proactive status, not on-demand answers. Requires an anticipatory-push API on sub-agent progress; tracked at QUI-153. |
| **Native time awareness**（"我说了多久？""每 4 秒提醒我"） | Layer 6 时间连续性 | 02-context 已有 3 层时间感知；对话工程层应能在自然语言中显式利用这些信号（"距上次会话已 3 天"、"现在已经聊 20 分钟了"），而不是把时间只当作内部状态。02-context already has 3-layer temporal awareness; the conversation-engineering layer should surface these signals explicitly in natural language ("3 days since our last session", "we've been chatting for 20 minutes"), not treat time as internal-only. |
| **Context-aware weaving of background results**（后台任务结果织进合适时机） | Layer 4 状态漂移 + Layer 5 长程一致性 | sub-agent 完成时不要硬切话题倾倒结果；保留织入点，让"活人感"在多任务并行时仍连贯。On sub-agent completion, do not hard-cut the topic to dump the result; reserve weave-in points so "alive feeling" stays coherent under parallel tasks. |
| **Interaction / Background split sharing full context** | 全局架构约束 / Global Constraint | 对话工程不能脱离 supervisor 架构独立设计；Layer 4-6 必须读完整 sub-agent 状态，否则会"忘了刚才让那边干啥"。Conversation engineering cannot be designed independent of supervisor architecture; Layers 4-6 must read full sub-agent state, otherwise the agent "forgets what it asked the other side to do". |
| **Modality-appropriate refusals**（拒绝方式随模态变化） | Layer 2 错误气质 | 文章把"拒绝"也当作风格的一部分，与本 spec 已有"错误气质"层吻合。The article treats "refusal" as part of style, aligning with this spec's existing "error temperament" layer. |

### Patterns explicitly out of scope

- 200ms multimodal early fusion / encoder-free processing / bitwise deterministic attention — all at the model training layer; Quilin cannot reach them.
- 200ms 多模态早融合 / encoder-free 处理 / bitwise 确定性 attention —— 全在模型训练层，Quilin 触不到。
- Full-duplex audio / video streams — Quilin is a text agent; visual / auditory perception can only ride on top-tier provider primitives (GPT-4o audio, Gemini Live, etc.), and would require rewriting REPL / WebUI.
- 音视频全双工流 —— Quilin 是文本 agent；视听感知只能依赖底层 provider（GPT-4o audio、Gemini Live 等），且需要重写 REPL / WebUI。

### 重启条件补充 / Restart Condition Addendum

The original restart condition was "core loop and dependent runtime components have local evidence". Add a complementary clause: **when conversation engineering is fully unparked, each of the 6 layers must explicitly note whether the matched pattern from the table above is adopted**, and non-adoption must be justified (e.g., "Layer 3 does not implement streaming interruption due to REPL rewrite cost"). This prevents reverting to "feature pile" inertia and losing the "alive feeling" differentiation.

之前的重启条件是"core loop 与依赖 runtime 组件具备本地实证"。增加一条配套：**对话工程全面解 park 时，6 层架构每一层必须显式标注是否吸收了上表对应模式**，不吸收的明确说明理由（如"Layer 3 不做流式打断，因 REPL 改造成本过高"）。这是为了避免重启时回到"功能堆砌"惯性，丢失"活人感"差异化定位。

> **状态校准 / Status Correction**：文档头标注的"Parked → Iter F"对当前现状不完全准确 —— Iter K 对话工程重启 project 下的 QUI-13 / QUI-122 / QUI-123 都已 Done（6 层架构 + 3 modes + 7 presets 已接入 ContextAssembler，commit `3ba97bc`）。本"外部参考"章节是对**剩余未做工作**的设计约束补充，不是对未启动工作的预先规划。
>
> The "Parked → Iter F" label at the document head no longer fully reflects reality — under the Iter K Conversation Engineering Restart project, QUI-13 / QUI-122 / QUI-123 are all Done (6-layer architecture + 3 modes + 7 presets are wired into ContextAssembler, commit `3ba97bc`). This "External References" section is a design-constraint supplement for the **remaining unbuilt work**, not pre-planning for unstarted work.
