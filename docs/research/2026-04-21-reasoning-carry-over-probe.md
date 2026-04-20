# Reasoning Carry-Over Probe

Date: 2026-04-21

## Executive Summary

This probe answered one architecture question for Phase 2/3:

1. Which providers actually let us carry hidden reasoning/thinking across turns, in what shape, and with what evidence?

My independent view is:

- DeepSeek must not be treated as "strip reasoning on outbound" by default.
- On the current `deepseek-reasoner` runtime, replaying `reasoning_content` is accepted in both plain multi-turn chat and tool-use continuation, and usually reduces second-turn reasoning tokens.
- Anthropic's contract is the cleanest and strictest on paper: thinking blocks are replayable, signatures matter, and tool-use replay must preserve the original block.
- OpenAI splits cleanly by API:
  - Chat Completions exposes reasoning usage but not replayable reasoning content.
  - Responses API is the real carry-over path via `previous_response_id` or reasoning items with encrypted content.
- The adapter boundary is still the right design:
  - internal transcript keeps reasoning
  - provider-specific filtering/replay happens only at the transport edge

## Runtime Environment

Live probe status by provider:

- `DEEPSEEK_API_KEY`: present
- `ANTHROPIC_API_KEY`: not present in shell
- `OPENAI_API_KEY`: not present in shell
- repo `.env`: Anthropic/OpenAI keys are only commented placeholders

Evidence:

```bash
env | rg '^(DEEPSEEK|ANTHROPIC|OPENAI)_'
# => DEEPSEEK_API_KEY=...
```

```bash
rg -n 'ANTHROPIC_API_KEY|OPENAI_API_KEY' .env
# 7:# ANTHROPIC_API_KEY=
# 8:# OPENAI_API_KEY=
```

Implication:

- DeepSeek: live runtime probe completed
- Anthropic: documentation + SDK-shape only, no live validation
- OpenAI: documentation + SDK-shape only, no live validation

## Capability Matrix

| Provider | Model / API path | Live probe | Hidden reasoning returned to client | Replay shape | Replay accepted? | Benefit signal | Current judgment |
|---|---|---:|---|---|---|---|---|
| DeepSeek | `deepseek-reasoner` / Chat Completions | Yes | `message.reasoning_content` | assistant message `{ content, reasoning_content }` or `{ content, reasoning_content, tool_calls }` | Yes in current runtime | Yes, positive but provider docs conflict | Keep reasoning in transcript; adapter should support optional replay |
| Anthropic | Claude 3.7+ / Messages + extended thinking | No | content block `{ type: "thinking", thinking, signature }` | replay original thinking block with `signature` | Docs say yes; modified block errors | Docs say token-efficient because prior thinking is stripped from context | Adapter should preserve provider metadata/signature exactly |
| OpenAI | `o4-mini` / Chat Completions | No | usage only (`reasoning_tokens`), not raw reasoning text | None on Chat Completions | Effectively no raw reasoning replay path | No live signal available | Chat path should not expect replayable reasoning payload |
| OpenAI | `o4-mini` / Responses API | No | reasoning item with encrypted content / item id | `previous_response_id` or reasoning item with `encrypted_content` | Docs + SDK say yes | Docs position this as the multi-turn reasoning path | Phase 3 should treat this as a separate adapter strategy, not reuse Chat rules |

## DeepSeek

Official docs reviewed:

- `https://api-docs.deepseek.com/guides/reasoning_model`
- `https://api-docs.deepseek.com/guides/thinking_mode`

Important documentation conflict:

- `reasoning_model` says:
  - previous-turn CoT is not concatenated into next-turn context
  - if `reasoning_content` is included in input messages, the API returns `400`
- `thinking_mode` says:
  - in a new turn, passing only `content` is the recommended bandwidth-saving pattern
  - within thinking-mode tool invocation, users must pass back `reasoning_content`, otherwise the API returns `400`

Observed runtime on 2026-04-21 differs from both documents:

- non-tool multi-turn replay did not `400`
- tool-use continuation without replay also did not `400`
- replaying `reasoning_content` lowered second-turn `reasoning_tokens` in the strongest samples

### Probe A: Plain Two-Turn Conversation

Turn 1 request:

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {
      "role": "user",
      "content": "9.11 and 9.8, which is greater? Answer briefly."
    }
  ],
  "stream": false
}
```

Turn 1 response excerpt:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "9.8 is greater than 9.11 because 9.8 equals 9.80, which is larger than 9.11.",
        "reasoning_content": "We are asked ... So final answer: 9.8 is greater."
      }
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 251,
    "completion_tokens_details": {
      "reasoning_tokens": 220
    },
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 20
  }
}
```

Turn 2A request without replay:

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {
      "role": "user",
      "content": "9.11 and 9.8, which is greater? Answer briefly."
    },
    {
      "role": "assistant",
      "content": "9.8 is greater than 9.11 because 9.8 equals 9.80, which is larger than 9.11."
    },
    {
      "role": "user",
      "content": "Add 3 to the greater number. Answer briefly."
    }
  ],
  "stream": false
}
```

Turn 2A response excerpt:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "12.8",
        "reasoning_content": "We are given ... So final answer: 12.8"
      }
    }
  ],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 270
    },
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 65
  }
}
```

Turn 2B request with replay:

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {
      "role": "user",
      "content": "9.11 and 9.8, which is greater? Answer briefly."
    },
    {
      "role": "assistant",
      "content": "9.8 is greater than 9.11 because 9.8 equals 9.80, which is larger than 9.11.",
      "reasoning_content": "We are asked ... So final answer: 9.8 is greater."
    },
    {
      "role": "user",
      "content": "Add 3 to the greater number. Answer briefly."
    }
  ],
  "stream": false
}
```

Turn 2B response excerpt:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "12.8",
        "reasoning_content": "We are given ... So answer: 12.8."
      }
    }
  ],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 208
    },
    "prompt_cache_hit_tokens": 64,
    "prompt_cache_miss_tokens": 1
  }
}
```

Result:

- replay accepted
- no `400`
- single sample showed lower `reasoning_tokens` on replay path (`270 -> 208`)

### Probe B: Repeated Plain-Turn Pairs

To reduce single-sample noise, I ran three paired trials at `temperature: 0`.

| Trial | Turn 2 without replay | Turn 2 with replay | Delta |
|---|---:|---:|---:|
| 1 | 74 | 84 | +10 |
| 2 | 214 | 41 | -173 |
| 3 | 132 | 65 | -67 |
| Avg | 140.0 | 63.3 | -76.7 |

Interpretation:

- one trial regressed slightly
- two trials improved sharply
- the average strongly favors replay
- signal is positive, but this is still a small-sample runtime probe rather than a benchmark-grade study

### Probe C: Tool-Use Continuation

This is the probe that matters most for our agent loop.

Turn 1 request:

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {
      "role": "user",
      "content": "Use the multiply tool to compute 6 * 7, then answer with the result only."
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "multiply",
        "description": "Multiply two numbers",
        "parameters": {
          "type": "object",
          "properties": {
            "a": { "type": "number" },
            "b": { "type": "number" }
          },
          "required": ["a", "b"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
```

Turn 1 response excerpt:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "",
        "reasoning_content": "I need to multiply 6 and 7. Let me use the multiply tool.",
        "tool_calls": [
          {
            "id": "call_00_niAWCiAdYQUbT1qBqTIE4XNF",
            "type": "function",
            "function": {
              "name": "multiply",
              "arguments": "{\"a\": 6, \"b\": 7}"
            }
          }
        ]
      }
    }
  ],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 17
    }
  }
}
```

Turn 2A request without replay:

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {
      "role": "user",
      "content": "Use the multiply tool to compute 6 * 7, then answer with the result only."
    },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "call_00_niAWCiAdYQUbT1qBqTIE4XNF",
          "type": "function",
          "function": {
            "name": "multiply",
            "arguments": "{\"a\": 6, \"b\": 7}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_00_niAWCiAdYQUbT1qBqTIE4XNF",
      "content": "42"
    }
  ]
}
```

Turn 2A response excerpt:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "42"
      }
    }
  ],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 63
    },
    "prompt_cache_hit_tokens": 320,
    "prompt_cache_miss_tokens": 82
  }
}
```

Turn 2B request with replay:

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {
      "role": "user",
      "content": "Use the multiply tool to compute 6 * 7, then answer with the result only."
    },
    {
      "role": "assistant",
      "content": "",
      "reasoning_content": "I need to multiply 6 and 7. Let me use the multiply tool.",
      "tool_calls": [
        {
          "id": "call_00_niAWCiAdYQUbT1qBqTIE4XNF",
          "type": "function",
          "function": {
            "name": "multiply",
            "arguments": "{\"a\": 6, \"b\": 7}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_00_niAWCiAdYQUbT1qBqTIE4XNF",
      "content": "42"
    }
  ]
}
```

Turn 2B response excerpt:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "42"
      }
    }
  ],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 14
    },
    "prompt_cache_hit_tokens": 320,
    "prompt_cache_miss_tokens": 100
  }
}
```

Result:

- omission did not `400`
- replay also did not `400`
- replay reduced reasoning tokens sharply (`63 -> 14`)

### DeepSeek Conclusion

Current consensus from live evidence:

- DeepSeek runtime currently accepts replayed `reasoning_content`.
- Replay is useful enough to matter, especially in tool-use continuation.
- Official docs are internally inconsistent and do not match current runtime exactly.

Design implication:

- do not hard-strip DeepSeek reasoning in the checkpoint/loop model
- keep reasoning in the internal transcript
- let the DeepSeek adapter decide, per outbound step, whether to replay or drop
- make that policy configurable, because DeepSeek documentation drift suggests runtime behavior may change again

## Anthropic

Official docs reviewed:

- `https://docs.anthropic.com/en/docs/build-with-claude/context-windows`
- `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking`

SDK evidence reviewed:

- `packages/agent-core/node_modules/@ai-sdk/anthropic/src/convert-to-anthropic-messages-prompt.ts`
- `packages/agent-core/node_modules/@ai-sdk/anthropic/src/anthropic-messages-api.ts`

What the docs say:

- previous thinking blocks are automatically stripped from the context window when passed back
- for normal multi-turn chat, you do not need to strip them yourself
- for tool use with extended thinking, the original unmodified thinking block must be returned with tool results
- signatures are cryptographic authenticity markers; modifying/removing them can cause an API error

Representative request shape:

```json
{
  "model": "claude-3-7-sonnet-20250219",
  "max_tokens": 1024,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  },
  "messages": [
    {
      "role": "user",
      "content": "Solve this carefully."
    }
  ]
}
```

Representative response shape from docs + SDK:

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "...",
      "signature": "sig_..."
    },
    {
      "type": "text",
      "text": "final answer"
    }
  ]
}
```

Representative replay shape:

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "...",
      "signature": "sig_..."
    },
    {
      "type": "text",
      "text": "tool request or prior assistant text"
    }
  ]
}
```

Current judgment:

- Anthropic definitely supports replayable hidden thinking
- replay must preserve provider-specific metadata, especially `signature`
- adapter must never synthesize or mutate Anthropic thinking blocks

Live-probe blocker:

- no `ANTHROPIC_API_KEY` available in this environment, so I did not validate:
  - intact signature replay
  - missing-signature replay
  - exact HTTP error body on malformed replay

## OpenAI

Official docs reviewed:

- `https://platform.openai.com/docs/guides/reasoning`
- `https://platform.openai.com/docs/api-reference/chat/create`
- `https://platform.openai.com/docs/api-reference/responses/create`

SDK evidence reviewed:

- `packages/agent-core/node_modules/@ai-sdk/openai/src/chat/openai-chat-api.ts`
- `packages/agent-core/node_modules/@ai-sdk/openai/src/chat/openai-chat-options.ts`
- `packages/agent-core/node_modules/@ai-sdk/openai/src/responses/openai-responses-options.ts`
- `packages/agent-core/node_modules/@ai-sdk/openai/src/responses/openai-responses-provider-metadata.ts`
- `packages/agent-core/node_modules/@ai-sdk/openai/src/responses/convert-to-openai-responses-input.ts`

### Chat Completions (`o4-mini`)

What the SDK shape shows:

- Chat Completions usage includes `completion_tokens_details.reasoning_tokens`
- assistant message schema does not expose a replayable hidden-reasoning payload analogous to DeepSeek `reasoning_content`

Representative request shape:

```json
{
  "model": "o4-mini",
  "messages": [
    {
      "role": "user",
      "content": "Solve this carefully."
    }
  ],
  "reasoning_effort": "medium"
}
```

Representative response shape:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "..."
      }
    }
  ],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 123
    }
  }
}
```

Current judgment:

- Chat Completions gives us reasoning cost visibility
- Chat Completions does not give us a raw reasoning replay channel we can depend on
- Phase 3 should not try to invent one

### Responses API

This is the actual OpenAI carry-over path.

Representative request shape:

```json
{
  "model": "o4-mini",
  "input": "Follow up on the previous answer.",
  "previous_response_id": "resp_..."
}
```

When not relying on server-side previous response storage, the SDK also supports reasoning items with encrypted content:

```json
{
  "type": "reasoning",
  "encrypted_content": "...",
  "summary": [
    {
      "type": "summary_text",
      "text": "..."
    }
  ]
}
```

Current judgment:

- OpenAI reasoning carry-over belongs to the Responses adapter path
- it should not share the same outbound replay logic as Chat Completions

Live-probe blocker:

- no `OPENAI_API_KEY` available in this environment
- I did not validate:
  - whether `o4-mini` Chat Completions rejects injected reasoning-like fields with a 400 or silently ignores them
  - exact runtime behavior of `previous_response_id`
  - whether replay measurably lowers reasoning tokens in a live Responses flow

## SDK Notes That Matter For Implementation

DeepSeek / OpenAI-compatible:

- `@ai-sdk/openai-compatible` serializes internal reasoning parts back to `reasoning_content` on assistant messages
- this matches the current DeepSeek runtime contract closely enough to keep the feature in the adapter

Anthropic:

- `@ai-sdk/anthropic` serializes reasoning parts as `thinking` blocks
- signatures live in provider metadata and are required to reconstruct those blocks

OpenAI:

- Chat path exposes reasoning token usage
- Responses path supports `previousResponseId`, `reasoningEncryptedContent`, and reasoning item replay

## Conclusions For Phase 2/3

1. Internal data model should preserve reasoning for all providers.
2. Outbound replay policy must stay provider-specific and adapter-local.
3. DeepSeek should start as `replay-supported`, not `replay-forbidden`.
4. Anthropic should start as `replay-required-when-provider-metadata-present`, with strict signature preservation.
5. OpenAI needs split strategies:
   - Chat Completions: no raw reasoning replay
   - Responses: replay/continuation via `previous_response_id` or encrypted reasoning items
6. Configuration should allow fast rollback for DeepSeek because docs and runtime disagree.

## Open Questions

1. DeepSeek docs and runtime disagree on both non-tool and tool-use replay. Is the current runtime behavior model-version specific, region specific, or simply newer than the docs?
2. For Anthropic, do we want a dedicated live probe once credentials exist, specifically to capture the exact malformed-signature error body?
3. For OpenAI, should Phase 3 include Responses API support immediately, or explicitly scope v1 to Chat Completions + no replay?
4. If we standardize `Message.reasoning`, do we also want a provider-tagged sub-structure to avoid lossy round-trips for signatures / encrypted content / item ids?
