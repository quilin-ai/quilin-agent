# Prompt Cache Spike

Date: 2026-04-21

## Executive Summary

This spike answered two runtime questions with live DeepSeek calls:

1. Can current DeepSeek + AI SDK v6 surface cache metrics in a form we can trust?
2. Does the Step 1-4 prompt lifecycle refactor actually stabilize the system prefix while keeping precise temporal outside the cached prefix?

My independent view is:

- Yes, DeepSeek exposes usable native cache counters.
- Yes, the Step 1-4 runtime refactor produces a byte-stable system prefix across turns.
- The provider-agnostic design is still the right abstraction boundary.
- One earlier assumption was wrong: `includeUsage: true` is not a strict prerequisite for DeepSeek streaming usage visibility in the current runtime, although we still keep it enabled for explicitness and portability.

## 三路径字段确认

Live DeepSeek responses now expose cache usage through three independently readable paths:

| Path | Field(s) | Live status | Notes |
|---|---|---|---|
| Provider metadata | `providerMetadata.deepseek.cacheReadTokens`, `providerMetadata.deepseek.cacheWriteTokens` | Available | Produced by the `metadataExtractor` in [`provider.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/llm/provider.ts) |
| Generic AI SDK usage | `usage.inputTokenDetails.cacheReadTokens`, `usage.inputTokenDetails.noCacheTokens` | Available | Returned on both `generateText()` and `streamText()` in current DeepSeek runs |
| Raw provider payload | `usage.raw.prompt_cache_hit_tokens`, `usage.raw.prompt_cache_miss_tokens` | Available | Best source for proving the original DeepSeek field names |

Observed invariant in every successful probe:

- `providerMetadata.deepseek.cacheReadTokens === usage.raw.prompt_cache_hit_tokens`
- `providerMetadata.deepseek.cacheWriteTokens === usage.raw.prompt_cache_miss_tokens`
- `usage.inputTokenDetails.cacheReadTokens === usage.raw.prompt_cache_hit_tokens`

This is strong enough to use native provider metrics as the primary Step 6 acceptance signal.

## 关于 `includeUsage: true`

The original Step 0 assumption was:

- `includeUsage: true` is required for streaming cache metrics to appear.

The live result was more nuanced:

- With `metadataExtractor` enabled and `includeUsage` omitted, DeepSeek still returned `usage.raw.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
- The same run also produced `providerMetadata.deepseek.cacheReadTokens` / `cacheWriteTokens`.

Therefore the corrected statement is:

- `includeUsage: true` is **not strictly required** for current DeepSeek streaming cache visibility in this runtime.
- We still keep `includeUsage: true` in [`provider.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/llm/provider.ts) because it makes intent explicit and is the safer default for portability across OpenAI-compatible providers.

## DeepSeek Cache Threshold Probes

### Short Prefix Probe

Prompt shape:

- single short user message
- no stable long prefix
- repeated 3 times

Observed result:

| Turn | Input tokens | Cache read | Cache write | Raw hit | Raw miss |
|---|---:|---:|---:|---:|---:|
| 1 | 10 | 0 | 10 | 0 | 10 |
| 2 | 10 | 0 | 10 | 0 | 10 |
| 3 | 10 | 0 | 10 | 0 | 10 |

Conclusion:

- very short prompts do not trigger useful cache reuse

### Long Stable Prefix Probe

Prompt shape:

- one long stable prefix with a session-unique nonce
- short round-specific suffix
- repeated 5 times

Observed result from the rerun in this session:

| Turn | Input tokens | Cache read | Cache write | Raw hit | Raw miss |
|---|---:|---:|---:|---:|---:|
| 1 | 535 | 0 | 535 | 0 | 535 |
| 2 | 535 | 512 | 23 | 512 | 23 |
| 3 | 535 | 512 | 23 | 512 | 23 |
| 4 | 535 | 512 | 23 | 512 | 23 |
| 5 | 535 | 512 | 23 | 512 | 23 |

Earlier live probe in the same work session, using a shorter stable prefix, observed the same qualitative pattern at a smaller scale:

- cold call: `miss = 380`
- warm calls: `hit = 320`, `miss = 60`

Conclusion:

- DeepSeek behaves like a prefix cache.
- Once the stable prefix is long enough, cold-call miss is followed by consistent warm-call reuse.
- The exact hit/miss split depends on how much of the request remains outside the stable prefix.

## REPL Integration Probe

### Setup

This probe exercised the actual Step 1-5 path, not a synthetic bare-provider prompt:

- `PromptBuilder`
- default prompt sections
- `PromptSessionAssembler`
- bucket temporal in the system prefix
- precise temporal on the latest outbound user message only
- `adaptMessagesForModel()` with DeepSeek noop behavior
- `streamText()` against DeepSeek

Probe controls:

- a session-unique `probe-nonce` was inserted at the very front of the system prompt to guarantee a cold prefix on turn 1
- the nonce was frozen for the whole session, so it did not perturb later turns
- current time advanced by 2 minutes per turn, keeping the temporal bucket stable (`morning`, `normal`)
- each turn asked for a short `ok-N` response to keep the assistant suffix small

### Data Table

`system hash` below is `sha256(system_message)[0:16 bytes]`, shown as 32 hex chars.

| Turn | system hash (first 16 bytes) | `providerMetadata.deepseek.cacheReadTokens` | `providerMetadata.deepseek.cacheWriteTokens` | `raw.prompt_cache_hit_tokens` | `usage.inputTokenDetails.cacheReadTokens` | TTFT (ms) |
|---|---|---:|---:|---:|---:|---:|
| 1 | `71f14a135b16df9dc9cd20192d2b827c` | 0 | 409 | 0 | 0 | 1142.23 |
| 2 | `71f14a135b16df9dc9cd20192d2b827c` | 320 | 107 | 320 | 320 | 929.20 |
| 3 | `71f14a135b16df9dc9cd20192d2b827c` | 320 | 125 | 320 | 320 | 865.64 |
| 4 | `71f14a135b16df9dc9cd20192d2b827c` | 320 | 143 | 320 | 320 | 1109.29 |

### Invariants

Confirmed:

- the outbound system message hash was byte-identical across all 4 turns
- the three cache-read paths matched exactly on every turn
- DeepSeek reused a stable 320-token prefix starting at turn 2
- latest user input plus precise temporal stayed outside the cached prefix

Important nuance:

- `cacheWriteTokens` did **not** collapse to zero on turns 2-4
- this is expected with a growing transcript
- DeepSeek is still writing the newly extended uncached suffix, which includes the current latest-user block and request framing

So the runtime-correctness signal is:

- stable system hash
- stable cache-read plateau from turn 2 onward
- exact equality across provider metadata, generic usage, and raw fields

It is **not**:

- `cacheWriteTokens === 0`

## Extractor Registry Contract

Current contract after Step 0:

- provider-specific usage extraction stays in `llm/provider.ts`
- normalized cache usage stays in `llm/token-usage.ts`
- upper layers only see:
  - `TokenUsage.cache.readTokens`
  - `TokenUsage.cache.writeTokens`
  - `TokenUsage.cache.source`

The registry shape is now:

```ts
const metadataExtractorRegistry = {
  deepseek: deepSeekMetadataExtractor,
  "openai-compatible-default": undefined,
} as const;
```

This is the right extension point for future OpenAI-compatible providers such as:

- GLM
- Kimi
- Qwen
- Minimax

Each new provider can add one extractor entry without changing loop logic.

## Tooling Pitfall

`bun test` is not a drop-in replacement for Vitest in this package.

Observed failure:

- `bun test src/llm/provider.test.ts`
- failed because `vi.mocked` is undefined under Bun's built-in test runner

Implication:

- use `bunx vitest run` for all tests that rely on Vitest-specific helpers

## Decision

This spike is sufficient to proceed with:

- Step 5 provider-specific cache adapter work
- Step 6 before/after cache validation using native DeepSeek metrics as the primary signal

It is not necessary to gate the architecture on wall-clock-only heuristics first.
