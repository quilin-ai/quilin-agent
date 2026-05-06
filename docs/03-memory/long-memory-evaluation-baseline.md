# 长期记忆评测基线 / Long-Memory Evaluation Baseline

Evidence checked on 2026-05-02 Asia/Shanghai. This document defines the first measurable long-memory baseline for quilin-mem（Quilin 的四层记忆系统，包含 working / episodic / semantic / skill memory）before QUI-65（Memory observer、fact stream 与长期记忆评测实现任务；observer 是观察器，用于从会话中提取可复用事实；fact stream 是事实事件流；vector backend 是向量检索后端）lands the real observer and vector backend.

证据已在 2026-05-02 Asia/Shanghai 校准。本文定义 quilin-mem（Quilin 的四层记忆系统，包含 working / episodic / semantic / skill memory）在 QUI-65（Memory observer、fact stream 与长期记忆评测实现任务；observer 是观察器，用于从会话中提取可复用事实；fact stream 是事实事件流；vector backend 是向量检索后端）落地真实 observer 和 vector backend 前的第一条可测长期记忆基线。

Benchmark freeze note: public LongMemEval（长期记忆能力评测，用于评估聊天助手跨多会话保存和使用信息的公开 benchmark；benchmark 是基准评测，用统一输入和评分比较系统能力）, LoCoMo（Long-term Conversational Memory，一个用长对话、多会话和多模态线索评估长期记忆的 benchmark）, and BEAM（Beyond a Million Tokens，一个把对话长度扩到 128K 到 10M tokens 的长期记忆 benchmark）lanes are historical references only unless the user explicitly asks for Benchmark work. The active baseline is the local fixture set（固定样例集，一组可重复运行的小型本地样例）and local memory evidence.

Benchmark 冻结说明：公开 LongMemEval（长期记忆能力评测，用于评估聊天助手跨多会话保存和使用信息的公开 benchmark；benchmark 是基准评测，用统一输入和评分比较系统能力）、LoCoMo（Long-term Conversational Memory，一个用长对话、多会话和多模态线索评估长期记忆的 benchmark）与 BEAM（Beyond a Million Tokens，一个把对话长度扩到 128K 到 10M tokens 的长期记忆 benchmark）通道只作为历史参考，除非用户明确要求 Benchmark 工作。活跃基线是 local fixture set（固定样例集，一组可重复运行的小型本地样例）和本地记忆实证。

## 决策 / Decision

QUI-65 is gated（门禁约束，用明确通过条件决定任务能否关闭）by a deterministic local fixture lane（评测通道，一组共享输入、运行方式和评分方式的测试集合）and local memory evidence. Public benchmark lanes are frozen and must not be added as implementation scope unless the user explicitly asks.

QUI-65 的 gate（门禁约束，用明确通过条件决定任务能否关闭）是确定性的本地 fixture lane（评测通道，一组共享输入、运行方式和评分方式的测试集合）和本地记忆实证。公开 benchmark lane 已冻结；除非用户明确要求，不得加入实现范围。

The first hard gate is the local fixture lane because QUI-65 acceptance allows LongMemEval, LoCoMo, or an equivalent local slice, and because the current repository already records LongMemEval as blocked when external data or model access is absent.

第一道硬 gate 使用本地 fixture lane，因为 QUI-65 验收允许 LongMemEval、LoCoMo 或等价本地切片，并且当前仓库已有记录：当外部数据或模型访问不可用时，LongMemEval 处于 blocked 状态。

Public benchmark scores are frozen. If the user later restarts this work, Quilin must not publish a LongMemEval, LoCoMo, or BEAM score unless the run stores the dataset version, source hash or commit, model name, judge model, prompt, seed or sampling config, and raw per-case outputs.

公开 benchmark 分数已冻结。如果用户未来重启这项工作，Quilin 不得发布 LongMemEval、LoCoMo 或 BEAM 分数，除非运行产物记录 dataset version、source hash 或 commit、model name、judge model、prompt、seed 或 sampling config，以及逐 case 原始输出。

## 一手来源 / Primary Sources

The source set below is the authoritative baseline input for this document. Secondary leaderboard pages and vendor benchmark pages are intentionally excluded from gate thresholds.

下列来源是本文的权威输入。二级 leaderboard 页面和厂商 benchmark 页面不进入 gate 阈值制定。

| Source | Use in this baseline |
|---|---|
| [LongMemEval paper](https://arxiv.org/abs/2410.10813) and [official repository](https://github.com/xiaowu0162/LongMemEval) | Long-term chat memory abilities, data schema, QA output format, official evaluator path |
| [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | Current official cleaned data package and split names |
| [LoCoMo paper](https://arxiv.org/abs/2402.17753), [official project page](https://snap-research.github.io/locomo/), and [official repository](https://github.com/snap-research/locomo) | Long conversation QA, event summarization, multimodal dialogue generation, repository schema |
| [LoCoMo raw README](https://raw.githubusercontent.com/snap-research/locomo/main/README.MD) | Compact machine-readable schema details for `data/locomo10.json` |
| [BEAM paper](https://arxiv.org/abs/2510.27246), [official repository](https://github.com/mohammadtavakoli78/BEAM), and [Hugging Face dataset](https://huggingface.co/datasets/Mohammadta/BEAM) | Multi-scale memory abilities, probing categories, evaluation flow, data fields |

| 来源 | 在本基线中的用途 |
|---|---|
| [LongMemEval paper](https://arxiv.org/abs/2410.10813) 与 [official repository](https://github.com/xiaowu0162/LongMemEval) | 长期聊天记忆能力、数据 schema、QA 输出格式、官方 evaluator 路径 |
| [LongMemEval cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | 当前官方 cleaned 数据包与 split 名称 |
| [LoCoMo paper](https://arxiv.org/abs/2402.17753)、[official project page](https://snap-research.github.io/locomo/) 与 [official repository](https://github.com/snap-research/locomo) | 长对话 QA、事件总结、多模态对话生成、仓库 schema |
| [LoCoMo raw README](https://raw.githubusercontent.com/snap-research/locomo/main/README.MD) | `data/locomo10.json` 的紧凑机器可读 schema 细节 |
| [BEAM paper](https://arxiv.org/abs/2510.27246)、[official repository](https://github.com/mohammadtavakoli78/BEAM) 与 [Hugging Face dataset](https://huggingface.co/datasets/Mohammadta/BEAM) | 多尺度记忆能力、probing category、evaluation flow、数据字段 |

## 总体 Harness 契约 / Shared Harness Contract

All lanes write a normalized JSONL（JSON Lines，一行一个 JSON 对象的文件格式）output so that local fixtures, public benchmark smoke runs（小样本冒烟验证，用少量代表性 case 验证组件连接正确）, and full benchmark runs（完整评测运行，覆盖目标数据集或目标 split；split 是数据集子集）can share one scorer adapter（评分适配器，把输出转换为统一指标）.

所有 lane 都写统一的 JSONL（JSON Lines，一行一个 JSON 对象的文件格式）输出，使本地 fixture、公开 benchmark smoke run（小样本冒烟验证，用少量代表性 case 验证组件连接正确）和 full benchmark run（完整评测运行，覆盖目标数据集或目标 split；split 是数据集子集）能共用同一个 scorer adapter（评分适配器，把输出转换为统一指标）。

The harness（评测执行框架，负责加载输入、运行系统、收集输出并调用 scorer）has two phases: ingest（写入或吸收输入事件到记忆系统）events into memory, then query（在记忆系统中检索并回答问题）after the required delay or session boundary. The query phase must not receive the raw full history unless the lane is explicitly marked as a long-context baseline（长上下文对照组，把完整历史直接放入模型上下文，而不是检索记忆）.

Harness（评测执行框架，负责加载输入、运行系统、收集输出并调用 scorer）分为两个阶段：先把事件 ingest（写入或吸收输入事件到记忆系统）到 memory，再在要求的延迟或 session 边界之后 query（在记忆系统中检索并回答问题）。Query 阶段不得收到完整原始历史，除非该 lane 明确标记为 long-context baseline（长上下文对照组，把完整历史直接放入模型上下文，而不是检索记忆）。

```json
{
  "case_id": "local-browser-update-001",
  "lane": "local_browser_fixture",
  "phase": "query",
  "timestamp": "2026-05-02T10:30:00+08:00",
  "input": {
    "question": "Which pricing limit did the release note update most recently?",
    "available_context_policy": "memory_only"
  },
  "expected": {
    "answer": "The limit changed to 500 projects.",
    "evidence_ids": ["browse-2026-05-02-release-note-v2"],
    "should_abstain": false,
    "profile_patch": {}
  }
}
```

Every system output must include the answer, retrieved evidence identifiers, memory writes, user-profile patch, timing, and any abstention reason. Evidence identifiers are the bridge between recall（召回率，应该找回的证据被找回的比例）and precision（精确率，返回证据中真正相关的比例）.

每条系统输出必须包含 answer、retrieved evidence identifiers、memory writes、user-profile patch、timing，以及 abstention reason。Evidence identifiers 是 recall（召回率，应该找回的证据被找回的比例）与 precision（精确率，返回证据中真正相关的比例）之间的桥。

```json
{
  "case_id": "local-browser-update-001",
  "hypothesis": "The latest release note says the limit is 500 projects.",
  "retrieved_evidence_ids": ["browse-2026-05-02-release-note-v2"],
  "memory_writes": [
    {
      "memory_id": "mem-release-limit-v2",
      "layer": "episodic",
      "operation": "upsert",
      "valid_from": "2026-05-02T10:10:00+08:00",
      "supersedes": ["mem-release-limit-v1"]
    }
  ],
  "profile_patch": {},
  "latency_ms": 42,
  "abstention_reason": null
}
```

## LongMemEval Lane

LongMemEval is the public lane for personal chat memory. The official repository defines five core abilities: information extraction, multi-session reasoning, knowledge updates, temporal reasoning, and abstention; its cleaned Hugging Face package currently exposes `longmemeval_oracle`, `longmemeval_s_cleaned`, and `longmemeval_m_cleaned`.

LongMemEval 是个人聊天记忆的公开 lane。官方仓库定义了五类核心能力：information extraction、multi-session reasoning、knowledge updates、temporal reasoning 和 abstention；当前 cleaned Hugging Face 包暴露 `longmemeval_oracle`、`longmemeval_s_cleaned` 与 `longmemeval_m_cleaned`。

Input format follows the official data fields: `question_id`, `question_type`, `question`, `answer`, `question_date`, `haystack_session_ids`, `haystack_dates`, `haystack_sessions`, and `answer_session_ids`. Each `haystack_sessions` entry is ingested as ordered turns with `role`, `content`, timestamp, session id, and optional `has_answer` labels.

输入格式遵循官方数据字段：`question_id`、`question_type`、`question`、`answer`、`question_date`、`haystack_session_ids`、`haystack_dates`、`haystack_sessions` 与 `answer_session_ids`。每个 `haystack_sessions` 条目按有序 turn ingest，保留 `role`、`content`、timestamp、session id 和可选 `has_answer` label。

Expected output is the official QA JSONL shape with `question_id` and `hypothesis`, plus Quilin evidence metadata in a sidecar file（旁路文件，与官方输出并排保存 Quilin 专用证据元数据）. The sidecar records `retrieved_session_ids`, `retrieved_turn_ids`, memory write ids, and latency so that retrieval quality can be scored independently from final answer quality.

期望输出采用官方 QA JSONL 形态，包含 `question_id` 与 `hypothesis`，同时写一个 Quilin evidence sidecar file（旁路文件，与官方输出并排保存 Quilin 专用证据元数据）。Sidecar 记录 `retrieved_session_ids`、`retrieved_turn_ids`、memory write ids 和 latency，使检索质量能独立于最终答案质量计分。

Scoring uses the official LongMemEval LLM-as-a-judge（大模型裁判，用另一个模型按 rubric 判断答案是否正确）path for answer accuracy, and the official retrieval metrics for session-level and turn-level recall or NDCG（Normalized Discounted Cumulative Gain，考虑排序位置的检索质量指标）when retrieval logs are available. Abstention examples are excluded from retrieval-location scoring because they intentionally lack answer evidence.

计分使用官方 LongMemEval 的 LLM-as-a-judge（大模型裁判，用另一个模型按 rubric 判断答案是否正确）路径评估 answer accuracy；当 retrieval logs 可用时，使用官方 retrieval metrics 计算 session-level 与 turn-level recall 或 NDCG（Normalized Discounted Cumulative Gain，考虑排序位置的检索质量指标）。Abstention 样例不进入检索位置计分，因为它们有意没有 answer evidence。

For QUI-65, LongMemEval is a frozen public lane. Do not implement smoke or full runs unless the user explicitly asks for Benchmark work.

对于 QUI-65，LongMemEval 是冻结的公开 lane。除非用户明确要求 Benchmark 工作，不得实现 smoke 或 full run。

Failure examples for this lane are stale knowledge update, missing multi-session synthesis, temporal off-by-source errors, and unsafe hallucination on abstention. A stale knowledge-update failure occurs when an older user fact is returned after a later session superseded it.

此 lane 的失败样例包括 stale knowledge update、missing multi-session synthesis、temporal off-by-source errors 与 abstention 上的 unsafe hallucination。Stale knowledge-update failure 指后续 session 已替换事实，但系统仍返回旧用户事实。

## LoCoMo Lane

LoCoMo is the public lane for long, sessioned, partially multimodal conversations. The official release currently uses `data/locomo10.json`, where each sample has `sample_id`, a `conversation` object with ordered sessions and timestamps, generated `observation`, generated `session_summary`, annotated `event_summary`, and annotated `qa`.

LoCoMo 是面向长对话、分 session、部分多模态对话的公开 lane。当前官方发布使用 `data/locomo10.json`，每个 sample 包含 `sample_id`、带有有序 sessions 和 timestamps 的 `conversation` 对象、生成的 `observation`、生成的 `session_summary`、标注的 `event_summary` 与标注的 `qa`。

Input format maps each session turn into a memory ingest event with `sample_id`, `session_id`, session timestamp, `speaker`, `dia_id`, `text`, and optional image metadata. Image files are not part of the official release, so Quilin stores `img_url`, `blip_caption`, and search query as text evidence instead of trying to fetch images in CI.

输入格式把每个 session turn 映射为 memory ingest event，字段包括 `sample_id`、`session_id`、session timestamp、`speaker`、`dia_id`、`text` 与可选 image metadata。官方发布不包含图片文件，因此 Quilin 在 CI 中只把 `img_url`、`blip_caption` 和 search query 作为文本证据存储，不尝试抓取图片。

Expected output for the first LoCoMo gate is QA-only: each item returns `sample_id`, `qa_index`, `category`, `hypothesis`, and retrieved `dia_id` or session evidence ids. Event summarization and multimodal dialogue generation remain follow-up lanes for QUI-16 unless QUI-65 explicitly needs them.

第一道 LoCoMo gate 的期望输出只覆盖 QA：每条输出 `sample_id`、`qa_index`、`category`、`hypothesis` 与检索到的 `dia_id` 或 session evidence ids。Event summarization 与 multimodal dialogue generation 留给 QUI-16 的后续 lane，除非 QUI-65 明确需要。

Scoring reports QA F1（F1 score，precision 与 recall 的调和平均）、exact-match where applicable, retrieval recall over evidence ids, and category breakdown for single-hop, multi-hop, temporal, commonsense or world knowledge, and adversarial questions. The official code includes RAG（Retrieval-Augmented Generation，检索增强生成，即先检索再回答）evaluation scripts over dialogs, observations, and session summaries; Quilin should record which database mode was used.

计分报告 QA F1（F1 score，precision 与 recall 的调和平均）、适用时的 exact-match、基于 evidence ids 的 retrieval recall，并按 single-hop、multi-hop、temporal、commonsense or world knowledge 与 adversarial questions 分组。官方代码包含基于 dialogs、observations 和 session summaries 的 RAG（Retrieval-Augmented Generation，检索增强生成，即先检索再回答）评估脚本；Quilin 必须记录使用了哪种 database mode。

For QUI-65, LoCoMo is a frozen public lane. If local fixtures lack multi-hop or temporal coverage, add local fixtures instead of starting LoCoMo unless the user explicitly asks for Benchmark work.

对于 QUI-65，LoCoMo 是冻结的公开 lane。如果本地 fixture 缺少 multi-hop 或 temporal coverage，应增加本地 fixture，而不是启动 LoCoMo；除非用户明确要求 Benchmark 工作。

Failure examples for this lane are speaker attribution drift, image-caption overreach, temporal order reversal, and adversarial non-abstention. Speaker attribution drift occurs when evidence from one speaker is used as if it belonged to the other speaker.

此 lane 的失败样例包括 speaker attribution drift、image-caption overreach、temporal order reversal 与 adversarial non-abstention。Speaker attribution drift 指系统把一个 speaker 的证据错误归属给另一个 speaker。

## BEAM-Style 浏览记忆 Lane / BEAM-Style Browsing-Memory Lane

BEAM itself is a conversational benchmark, not a browser benchmark. Quilin therefore uses BEAM-style browsing-memory checks as a local adaptation: keep BEAM's idea of multi-scale evidence and diverse memory abilities, but replace chat turns with browsing events produced by the browser/tool layer.

BEAM 本身是对话 benchmark，不是浏览器 benchmark。因此 Quilin 使用 BEAM-style 浏览记忆检查作为本地改造：保留 BEAM 的多尺度证据和多类记忆能力思想，但把 chat turns 替换为 browser/tool layer 产生的浏览事件。

Input format is a local JSONL fixture with `browse_event`, `tool_result`, `note`, and `query` records. A `browse_event` must include `url`, `title`, `visited_at`, `visible_text_digest`, `source_hash`, and optional `extracted_facts`; a `query` must include `question`, `expected.answer`, `expected.evidence_ids`, `expected.should_abstain`, and optional `expected.profile_patch`.

输入格式是本地 JSONL fixture，包含 `browse_event`、`tool_result`、`note` 与 `query` records。`browse_event` 必须包含 `url`、`title`、`visited_at`、`visible_text_digest`、`source_hash` 与可选 `extracted_facts`；`query` 必须包含 `question`、`expected.answer`、`expected.evidence_ids`、`expected.should_abstain` 与可选 `expected.profile_patch`。

The initial fixture set should cover seven categories: information extraction, multi-source reasoning, temporal update, contradiction resolution, abstention, instruction following, and user-profile stability. Contradiction resolution（矛盾处理，识别并使用最新或最高可信来源而不是混用冲突事实）is mandatory because QUI-65 explicitly asks for contradiction handling.

初始 fixture set 应覆盖七类：information extraction、multi-source reasoning、temporal update、contradiction resolution、abstention、instruction following 与 user-profile stability。Contradiction resolution（矛盾处理，识别并使用最新或最高可信来源而不是混用冲突事实）是必选项，因为 QUI-65 明确要求 contradiction handling。

Expected output uses the shared harness contract and must cite browser evidence ids. A correct answer without a supporting `url` and timestamp is counted as ungrounded, because browsing memory is only useful if the agent can explain what page established the fact.

期望输出使用共享 harness contract，并且必须引用 browser evidence ids。没有支持性 `url` 和 timestamp 的正确答案计为 ungrounded，因为浏览记忆只有在 agent 能解释哪个页面建立了该事实时才有用。

Scoring is deterministic: answer exact match or rubric match, evidence recall@5, precision@5, contradiction pass rate, abstention pass rate, profile false-positive count, and p95 retrieval latency. No external network or judge model is allowed in this lane.

计分是确定性的：answer exact match 或 rubric match、evidence recall@5、precision@5、contradiction pass rate、abstention pass rate、profile false-positive count 与 p95 retrieval latency。此 lane 不允许外部网络或 judge model。

Failure examples for this lane are stale page recall, no-source answer, overbroad profile write, and browser-event leakage. Browser-event leakage means the agent answers from raw test fixture context instead of retrieved memory.

此 lane 的失败样例包括 stale page recall、no-source answer、overbroad profile write 与 browser-event leakage。Browser-event leakage 指 agent 直接从测试 fixture 原始上下文作答，而不是从 retrieved memory 作答。

## 本地 Fixture Set / Local Fixture Set

The local fixture set is the hard CI gate for QUI-65. It must be small enough to run on every PR, deterministic enough to debug, and broad enough to prove the observer, fact stream, dedupe/merge policy, retrieval, and user profile update path are wired without creating public Benchmark scope.

本地 fixture set 是 QUI-65 的硬性 CI gate。它必须足够小，可以在每个 PR 运行；足够确定，方便 debug；同时覆盖足够广，以证明 observer、fact stream、dedupe/merge policy、retrieval 与 user profile update path 已接通，且不创建公开 Benchmark 范围。

The first version should contain at least 24 cases: 4 information extraction, 4 multi-hop, 4 temporal update, 4 contradiction, 4 abstention, and 4 user-profile stability cases. At least one case per category should be bilingual EN/ZH（English and Chinese，英文与中文混合）or Chinese-only.

第一版至少应包含 24 条 case：4 条 information extraction、4 条 multi-hop、4 条 temporal update、4 条 contradiction、4 条 abstention 与 4 条 user-profile stability。每类至少一条应为 bilingual EN/ZH（English and Chinese，英文与中文混合）或中文-only。

Fixtures should live under `providers/memory/benchmarks/datasets/long_memory_local/` when implemented. Large public raw datasets should not be vendored; use manifest files（清单文件，记录数据来源、版本和校验信息的小文件）with source URL, version, hash, selected case ids, and download or generation commands.

实现时，fixture 应放在 `providers/memory/benchmarks/datasets/long_memory_local/`。大型公开 raw dataset 不应 vendored；应使用 manifest files（清单文件，记录数据来源、版本和校验信息的小文件）记录 source URL、version、hash、selected case ids，以及 download 或 generation commands。

The fixture schema should be versioned with `schema_version`, because future observer changes will otherwise make old failures hard to interpret.

Fixture schema 应带 `schema_version`，否则未来 observer 变更会让旧失败难以解释。

```json
{
  "schema_version": 1,
  "case_id": "profile-stability-zh-001",
  "category": "user_profile_stability",
  "events": [
    {
      "event_id": "turn-1",
      "kind": "chat_turn",
      "timestamp": "2026-05-02T09:00:00+08:00",
      "role": "user",
      "content": "这次临时 demo 用红色按钮，但不要把红色当成我的长期偏好。"
    }
  ],
  "query": {
    "question": "What should Quilin remember as the user's long-term button color preference?",
    "expected": {
      "answer": "No long-term preference was stated.",
      "evidence_ids": ["turn-1"],
      "should_abstain": true,
      "profile_patch": {}
    }
  }
}
```

## 计分方式 / Scoring

The scoring report must include answer, retrieval, write-path, timing, and stability metrics. A lane may add official benchmark metrics, but it must not remove the shared metrics.

计分报告必须包含 answer、retrieval、write-path、timing 与 stability metrics。某个 lane 可以增加官方 benchmark metrics，但不得删除共享 metrics。

| Metric | Definition | QUI-65 minimum |
|---|---|---:|
| Answer accuracy | Fraction of cases with correct `hypothesis` under exact match, rubric match, or official judge | local fixture >= 0.90 |
| Evidence recall@5 | Fraction of required `evidence_ids` present in top 5 retrieved ids | local fixture >= 0.90 |
| Evidence precision@5 | Fraction of top 5 retrieved ids that are relevant | local fixture >= 0.60 |
| Contradiction pass rate | Fraction of contradiction/update cases using the latest valid fact and suppressing superseded facts | local fixture = 1.00 |
| Abstention pass rate | Fraction of unanswerable cases where the model refuses or states insufficient evidence | local fixture = 1.00 |
| Profile false positives | Count of profile writes not present in `expected.profile_patch` | local fixture = 0 |
| Update timing | New or superseding fact is queryable after the configured ingest boundary | local fixture = 1.00 |
| p95 retrieval latency | 95th percentile memory retrieval time on the local fixture; 100K stress inherits existing `amb_100k` target | <= 300 ms for 100K stress |

| 指标 | 定义 | QUI-65 最低要求 |
|---|---|---:|
| Answer accuracy | 在 exact match、rubric match 或官方 judge 下 `hypothesis` 正确的 case 比例 | local fixture >= 0.90 |
| Evidence recall@5 | 必需 `evidence_ids` 出现在前 5 个 retrieved ids 中的比例 | local fixture >= 0.90 |
| Evidence precision@5 | 前 5 个 retrieved ids 中真正相关的比例 | local fixture >= 0.60 |
| Contradiction pass rate | contradiction/update cases 中使用最新有效事实并抑制过期事实的比例 | local fixture = 1.00 |
| Abstention pass rate | 不可回答 case 中模型拒答或说明证据不足的比例 | local fixture = 1.00 |
| Profile false positives | 不在 `expected.profile_patch` 中的 profile writes 数量 | local fixture = 0 |
| Update timing | 新事实或替换事实在配置的 ingest boundary 后可 query | local fixture = 1.00 |
| p95 retrieval latency | 本地 fixture 上 memory retrieval 的 95 分位延迟；100K stress 继承现有 `amb_100k` 目标 | 100K stress <= 300 ms |

When official LongMemEval or BEAM judge scoring is used, the report must include judge model, prompt version, and raw judge response. When LoCoMo F1 or exact match is used, the report must include category-level breakdown and evidence recall.

使用官方 LongMemEval 或 BEAM judge scoring 时，报告必须包含 judge model、prompt version 与 raw judge response。使用 LoCoMo F1 或 exact match 时，报告必须包含 category-level breakdown 与 evidence recall。

## QUI-65 Gate

QUI-65 cannot be closed unless the local fixture lane passes and the report artifact is stored under the local evidence output convention. Blocked public benchmark lanes should be recorded as frozen, not as next actions.

除非 local fixture lane 通过，且报告产物按本地实证输出约定存储，否则 QUI-65 不得关闭。被阻塞的公开 benchmark lane 应记录为冻结，而不是下一步行动。

The minimum close condition is: local fixture pass, 100K recall stress pass or explicitly unchanged from the existing `amb_100k` gate, and normalized JSONL outputs generated. Do not select a public-lane smoke plan unless the user explicitly asks for Benchmark work.

最低关闭条件是：local fixture pass、100K recall stress pass 或明确复用现有 `amb_100k` gate 且未改变，并生成 normalized JSONL outputs。除非用户明确要求 Benchmark 工作，不得选择 public-lane smoke plan 作为后续。

The earlier public smoke lane recommendations are frozen. LongMemEval oracle and LoCoMo QA should not be started unless the user explicitly asks for Benchmark work.

此前的 public smoke lane 建议已冻结。除非用户明确要求 Benchmark 工作，不得启动 LongMemEval oracle 或 LoCoMo QA。

BEAM full-scale runs are not a QUI-65 close requirement and remain frozen. The BEAM-style browsing fixture is a local-memory idea only, not permission to start public BEAM work.

BEAM full-scale runs 不是 QUI-65 关闭要求，并保持冻结。BEAM-style 浏览 fixture 只是本地记忆思路，不授权启动公开 BEAM 工作。

## 失败样例 / Failure Examples

The examples below should appear as concrete fixtures, not only as prose. Each failure maps to a metric and a likely subsystem owner.

下面的样例应作为具体 fixtures 出现，而不只写在文档里。每个 failure 都映射到一个 metric 和一个可能的 subsystem owner。

| Failure | Example | Metric hit | Likely owner |
|---|---|---|---|
| Stale update | User first says the deploy target is staging, later changes it to production; answer still says staging | contradiction pass rate | dedupe/merge policy |
| Missing evidence | Answer is correct but `retrieved_evidence_ids` omits the source turn or page | evidence recall@5 | retriever / evidence mapper |
| Profile over-write | Temporary demo style is stored as permanent user preference | profile false positives | profile updater |
| Cross-speaker drift | LoCoMo answer uses speaker A's event as speaker B's memory | answer accuracy and evidence precision | observer / entity resolver |
| Unsafe abstention | System invents an answer when no evidence exists | abstention pass rate | reader prompt / safety gate |
| Browser stale page | Later release note supersedes an earlier page, but answer cites the earlier page | contradiction pass rate | temporal index / source ranking |
| Raw-context leakage | Test passes only because raw fixture text is in prompt | harness validity | benchmark harness |

| 失败 | 样例 | 影响指标 | 可能 owner |
|---|---|---|---|
| Stale update | 用户先说 deploy target 是 staging，后来改成 production；回答仍说 staging | contradiction pass rate | dedupe/merge policy |
| Missing evidence | 答案正确，但 `retrieved_evidence_ids` 没有包含来源 turn 或 page | evidence recall@5 | retriever / evidence mapper |
| Profile over-write | 临时 demo 样式被写成永久用户偏好 | profile false positives | profile updater |
| Cross-speaker drift | LoCoMo 回答把 speaker A 的事件当成 speaker B 的记忆 | answer accuracy and evidence precision | observer / entity resolver |
| Unsafe abstention | 没有证据时系统编造答案 | abstention pass rate | reader prompt / safety gate |
| Browser stale page | 后来的 release note 已替换早期页面，但回答引用了早期页面 | contradiction pass rate | temporal index / source ranking |
| Raw-context leakage | 测试只因 prompt 中包含原始 fixture 文本而通过 | harness validity | benchmark harness |

## 产物与记录 / Artifacts and Logging

Local memory evidence inputs may reuse the existing `providers/memory/benchmarks/datasets/` path only as current repository convention; this does not reopen Benchmark scope. Outputs belong under `.output/` or another ignored output directory, then summarized in docs or Linear comments only after the raw artifact path and command are recorded.

本地记忆实证输入可以沿用既有 `providers/memory/benchmarks/datasets/` 路径作为当前仓库约定；这不代表重开 Benchmark 范围。输出应放在 `.output/` 或其他被 ignore 的输出目录；只有在记录 raw artifact path 和 command 后，才把摘要写入 docs 或 Linear comments。

Each run report should include command, git commit, dirty-worktree note, dataset manifest hash, scorer version, model and judge config, metric table, and failure rows. If the run is blocked, the report should include a blocked reason and a smallest next unblock action.

每次运行报告应包含 command、git commit、dirty-worktree note、dataset manifest hash、scorer version、model and judge config、metric table 与 failure rows。如果运行 blocked，报告应包含 blocked reason 和最小下一步 unblock action。

## 后续吸收 / Follow-Up Absorption

QUI-65 should implement the local fixture and normalized scorer. QUI-16 should not track public benchmark expansion unless the user explicitly asks; LongMemEval full run, LoCoMo QA full run, and BEAM-scale ingestion proof are frozen.

QUI-65 应实现本地 fixture 与 normalized scorer。除非用户明确要求，QUI-16 不应追踪公开 benchmark 扩展；LongMemEval full run、LoCoMo QA full run，以及 BEAM-scale ingestion proof 已冻结。

Do not create a new Linear issue for these follow-ups unless they need separate ownership, blockers, or acceptance criteria. Prefer comments on QUI-73, QUI-65, or QUI-16 to preserve the free-plan issue budget.

除非后续工作需要独立 owner、blocker 或 acceptance criteria，否则不要为这些 follow-ups 新建 Linear issue。优先在 QUI-73、QUI-65 或 QUI-16 comment，节省 Linear 免费版 issue 额度。
