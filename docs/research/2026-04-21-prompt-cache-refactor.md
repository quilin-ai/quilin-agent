# Prompt Cache Refactor Notes

Date: 2026-04-21

## Scope

This note records the implementation-level evidence around the Step 1-5 prompt cache refactor:

- session-scoped `PromptSessionAssembler`
- provider-agnostic `AssembledPrompt.segments` + `recommendedBreakpoints`
- transport-only `cache-adapter.ts`
- DeepSeek noop behavior
- Anthropic explicit breakpoint translation

## Anthropic Breakpoint Invariants

Current consensus was:

- provider-specific cache semantics must stay below `llm/`
- Anthropic should receive exactly the recommended breakpoint(s), not invented ones
- the latest user message must not receive `cacheControl`
- precise temporal must remain outside the cached prefix

The current implementation satisfies that shape:

- [`cache-adapter.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/llm/cache-adapter.ts) only applies `providerOptions.anthropic.cacheControl` to the system segment indexes explicitly listed in `prompt.recommendedBreakpoints`
- [`cache-adapter.test.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/llm/cache-adapter.test.ts) now locks the following behavior:
  - only the last stable system block receives `cacheControl`
  - the decorated latest user block is serialized without `providerOptions`
  - only one message in the test output carries `providerOptions`, proving the adapter is not greedily tagging later blocks

Important nuance:

- the adapter itself can consume multiple recommended breakpoints in the future, up to Anthropic's limit of 4
- the current runtime still emits a single breakpoint by default, so present behavior remains single-breakpoint

## 已知独立红灯

The prompt cache refactor did not touch:

- [`web-fetch.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/tools/builtin/web-fetch.ts)
- [`web-fetch.test.ts`](/Users/raysonmeng/repo/quilin-agent/packages/agent-core/src/tools/builtin/web-fetch.test.ts)

Evidence:

1. `git diff -- packages/agent-core/src/tools/builtin/web-fetch.ts packages/agent-core/src/tools/builtin/web-fetch.test.ts`
   Result: empty diff

2. Because git write commands are forbidden in this environment, `git stash` could not be used directly.
   Equivalent proof was collected with a read-only HEAD snapshot:

```bash
tmpdir=$(mktemp -d /tmp/quilin-head-webfetch.XXXXXX)
git archive --format=tar HEAD | tar -x -C "$tmpdir"
ln -s /Users/raysonmeng/repo/quilin-agent/node_modules "$tmpdir/node_modules"
ln -s /Users/raysonmeng/repo/quilin-agent/packages/agent-core/node_modules \
  "$tmpdir/packages/agent-core/node_modules"
cd "$tmpdir"
pnpm --filter @quilin/agent-core test -- src/tools/builtin/web-fetch.test.ts
```

Observed result in the HEAD snapshot:

- the same test still failed
- failing case: `builtin web_fetch tool > strips sensitive auth headers when target host is not allowlisted`
- failing assertion: `expect(result.isError).toBe(false)` at line 279

Conclusion:

- this red test is pre-existing relative to the prompt-cache work
- it should not be attributed to the Step 1-5 / Step 5 refactor

## Verification Summary

Refactor-related verification completed:

- targeted `llm/context/loop` regression set passed
- full `packages/agent-core` suite passed except for the known independent `web-fetch` failure above

Current status:

- prompt cache refactor path is ready for commit
- `web-fetch` should be tracked separately or fixed in a dedicated follow-up
