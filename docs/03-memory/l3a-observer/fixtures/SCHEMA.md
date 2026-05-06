# Rule-first Observer — Dataset Schema

**目标**: 为 D-20 quilin-mem v2 L3a Observation 层的 rule-first 两级架构提供可复用的评估数据集。第一用途是 Task #97 spike v2 重跑（≥1000 样本替代 Codex 自造的 70 样本）；第二用途是 M0 Sprint 1 实现后的回归测试集。

## 职责分离

- **Claude（Planner）**: 造数据 + 标注（本 schema）
- **Codex（Implementer）**: 拿 `dataset.json` 跑规则原型 + 出报告

造数据和跑规则**不同一只手**——避免样本分布与规则设计共变的偏差。

## JSON Schema

每条样本一个 object，全量 `dataset.json` 是顶层 array。

```json
{
  "id": "string (unique, format: <category>-<lang>-<seq>)",
  "source": "hand | msc | personachat | locomo | noise-variant",
  "source_ref": "string | null (origin ID when source != hand)",
  "text": "string (conversation turn or standalone utterance)",
  "language": "en | zh | mixed",
  "should_extract": "boolean",
  "type": "entity | time | preference | emotion | intent | none",
  "difficulty": "explicit | implicit | trap | noisy",
  "gold_observation": "string | null (canonical observation text; null if should_extract=false)",
  "trap_reason": "string | null (only when difficulty=trap)",
  "noise_features": ["typo" | "emoji" | "code" | "short" | "long" | "mixed-lang"] | null
}
```

### 字段约定

| 字段 | 约定 |
|------|------|
| `id` | 格式 `<type>-<lang>-<3-digit-seq>`，例如 `entity-en-001`、`none-zh-047`。必须全集唯一。 |
| `source` | `hand` = Claude 手写；`msc` / `personachat` / `locomo` = 公开数据重标注；`noise-variant` = 从已有样本派生加噪 |
| `source_ref` | 公开数据时记原始 ID / URL fragment，便于追溯；噪音变体记 base ID（如 `noise-of:entity-en-003`） |
| `text` | 单条对话 turn，可多句，最长 300 字符；不带说话者前缀 |
| `language` | `en` 全英 / `zh` 全中 / `mixed` 中英混杂（例: "这个 bug 要 review 下"） |
| `should_extract` | 是否应该从这条抽出 observation。`type=none` 时必为 false |
| `type` | 六分类（见下），`should_extract=false` 时用 `none` |
| `difficulty` | `explicit` 表面直述 / `implicit` 需要推理（代词、省略、暗示）/ `trap` 看起来像但不该抽 / `noisy` 带噪音 |
| `gold_observation` | 第三人称 canonical form（例: "Works at Stripe"），不是原文复述。`should_extract=false` 时为 null |
| `trap_reason` | 陷阱类型枚举（见下） |
| `noise_features` | 噪音类型枚举（见下） |

## 六类 observation type

| type | 定义 | 例子 |
|------|------|------|
| `entity` | 人、组织、地点、产品、技术栈等实体陈述 | "I work at Stripe" / "我在字节跳动" |
| `time` | 绝对或相对时间陈述 | "每周五下午开会" / "三天后交付" |
| `preference` | 喜好、选择倾向、习惯 | "I prefer tea" / "我讨厌开视频会" |
| `emotion` | 情绪陈述（不含推测，必须是明确的情绪词或典型短语） | "I'm exhausted" / "最近压力好大" |
| `intent` | 意图、计划、决定（明确的 modal verb 或等价中文表达） | "I'll switch jobs next month" / "我打算明年去日本" |
| `none` | 不该抽的句子（闲聊、问题、指令、泛泛议论、陷阱） | "What's the weather?" / "今天天气真好" |

## 难度分级

| difficulty | 定义 | 占比目标（全集） |
|------|------|-----------------|
| `explicit` | 句子里有显式 NER 实体 / 时间表达 / 偏好关键词 / 情绪词 / modal verb | ~45% |
| `implicit` | 需要代词消解、省略恢复、暗示推理 | ~25% |
| `trap` | 句法像 observation 但语义不该抽（反问 / 假设 / 引用他人 / 泛指 / 否定） | ~15% |
| `noisy` | 带现实噪音（typo / emoji / 代码片段 / 极短 / 极长 / 中英混杂） | ~15% |

## 陷阱类型枚举（`trap_reason`）

当 `difficulty=trap` 时必填。下列之一:

- `rhetorical_question` — 反问 ("Who wouldn't love coffee?"）
- `hypothetical` — 假设 ("If I worked at Google...")
- `quoted_other` — 引用他人 ("My mom says she hates tea")
- `generic_statement` — 泛指、非个人陈述 ("People usually prefer coffee")
- `negation_of_fact` — 否定 ("I don't work at Stripe anymore" 的判定取决于语境，这里限"明确否定过去陈述")
- `past_abandoned` — 明确抛弃的过去 ("I used to live in Berlin but not anymore and it's irrelevant")
- `command_or_request` — 指令或请求 ("Please remind me about Stripe")
- `meta_conversation` — 关于对话本身 ("Let's not talk about my company")

## 噪音类型枚举（`noise_features`）

当 `difficulty=noisy` 时 `noise_features` 至少含一个:

- `typo` — 拼写错误（"I wrk at Strip e"）
- `emoji` — 插入 emoji（"I love coffee ☕"）
- `code` — 掺代码片段（"Fixed bug in `user.ts:42`, still stuck"）
- `short` — ≤ 3 词极短句
- `long` — ≥ 40 词的散漫长句
- `mixed-lang` — 中英混杂

## 六类 × 四难度 × 双语 目标分布（全集 1000+）

| 分类 | explicit | implicit | trap | noisy | 合计 |
|------|---------|---------|------|-------|-----|
| entity | 80 | 40 | 25 | 25 | 170 |
| time | 80 | 40 | 25 | 25 | 170 |
| preference | 80 | 40 | 25 | 25 | 170 |
| emotion | 60 | 40 | 20 | 20 | 140 |
| intent | 60 | 40 | 20 | 20 | 140 |
| none | — | — | 60 | 40 | 100（none 默认难 = trap）|
| **合计** | **360** | **200** | **175** | **155** | **890** |

缺 ~110 条在 batch 2/3 时动态补齐（优先补实验暴露的薄弱类型）。

**双语拆分**: 每类每难度按 en : zh ≈ 6:4 分配，`mixed-lang` 独立归入 `noisy`。

## 反样本池 vs 正样本池

- **正样本**（`should_extract=true`）: 约 840 条，分布在 `explicit` / `implicit` / `noisy` 难度
- **负样本**（`should_extract=false`）: 约 260 条，几乎都是 `trap` 或 `noisy` (none 类型)

负样本数量刻意抬高到 ~24%，逼规则层在召回与精准之间真实权衡。

## 标注原则

1. **Gold 用第三人称 canonical form**，不是原文复述。例: `"I work at Stripe"` → `"Works at Stripe"`
2. **Implicit 样本的 gold 要写出推理后的信息**，而不是"不可抽"。例: `"Still at Stripe."` → `"Works at Stripe"`
3. **复合信息拆分**：一条文本包含多个 observation 时，`gold_observation` 用分号拼接，如 `"Works at Stripe; based in Singapore"`
4. **Trap 不给 gold**，`gold_observation=null`
5. **陷阱的 trap_reason 必填**，让 Codex 能出"各陷阱类型的规则识别率"

## 文件位置

- `docs/03-memory/l3a-observer/fixtures/SCHEMA.md`（本文件）
- `docs/03-memory/l3a-observer/fixtures/dataset.json`（分批产出）
- `docs/03-memory/l3a-observer/fixtures/README.md`（数据来源说明 + 版本历史）

## 版本

- **v1**: Codex 自造 70 条（`.spike/observer/fixtures/dataset.json`，不入库），第一次 #97 spike 使用
- **v2**（本 schema 目标）: Claude 造 1000+ 条，Task #97 v2 重跑使用，committed

## 非目标（不在本数据集里）

- 多轮对话上下文（每条样本是独立 turn，上下文感知能力由 L1 working memory 负责）
- 代词消解的 gold entity 链接（如 "He works at Stripe" 需要知道 "He" 是谁——这超出规则层的职责）
- 多模态输入（图文混合）
