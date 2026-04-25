# Iter D 第一/二轮跨轨道 Review

## Review Scope

审查 7 个 commit：`630fce2`、`3cf2a9a`、`fd44e2d`、`c4775d6`、`ed8a39c`、`000ca33`、`eef2e7a`。

重点覆盖 ADR-008 span/attribute/traceparent、ADR-009 user config cascade/CLI/权限、M1.4 dual-emit、scratchpad 独立表、Rust stub、跨进程 trace_id 端到端证据、写边界、测试缺口、AMB 100k p95 与 plan 残余归属。

## 实证命令

- code-review-graph：`list_graph_stats`、`detect_changes(base=630fce2^)`、`get_review_context(base=630fce2^)`。图索引可用，204 files / 2117 nodes / 19362 edges，44 changed files，风险 high。
- Git 只读：`git status --short`、`git log --oneline --decorate --no-walk ...`、`git diff --stat 630fce2^..eef2e7a`、`git diff --name-only 630fce2^..eef2e7a`、`git show --no-patch --format=fuller ...`、`git show --stat --oneline ...`。
- 规范/实现核对：`rg -n "ADR-00[589]|traceparent|span taxonomy|user config|config cascade|scratchpad|Layer|layer enum|§17|M1\\.1|LongMemEval|Arm L|25-02|16\\.577|100k" docs`；对 ADR、plan、TS/Python/Rust changed files 使用 `sed` / `nl -ba` 精确取行号。
- TS 验证：`pnpm exec vitest run src/observability/loop.test.ts src/observability/exporters/json-file.test.ts src/tools/mcp-client.test.ts src/config/user-config.test.ts src/cli/config-cmd.test.ts src/memory/scratchpad-client.test.ts` = 6 files / 66 tests passed；`pnpm exec tsc --noEmit --pretty false` = exit 0；`pnpm exec biome check src/` = 164 files clean。另试跑 `bun test ...` 失败，原因是 Bun test runner 不支持 `describe.sequential`，项目脚本实际使用 Vitest。
- Python/Rust 验证：`uv run pytest tests/test_event_log.py tests/test_scratchpad.py tests/test_server.py` = 33 passed；`uv run ruff check src/ tests/` = clean；`cargo test --workspace` = 1 Rust test passed。
- AMB：`uv run python benchmarks/amb_100k.py --records 100000 --iterations 30` = passed，top1 1.0，p95 `0.237ms`，max `0.252ms`。运行后清理了我生成的 `providers/memory/.bench-cache/`。

## Findings

### BLOCKING

1. `packages/agent-core/src/index.ts:154`、`packages/agent-core/src/repl.ts:474`、`packages/agent-core/src/repl.ts:485`、`packages/agent-core/src/observability/exporters/json-file.test.ts:122`
   - 问题：`bootstrapUserRuntime()` 只创建了 `OTelSpanProvider` / `StructuredLogger` 单例，但 REPL 主路径调用 `runAgentLoop()` 时没有传 `observability`，也没有把 `JsonFileSpanExporter` / `CompositeSpanExporter` 接到 turn/session 结束路径。现有 exporter 测试是手动 `exporter.exportSpans(spans.snapshot())`，不是启动路径自动导出。
   - 影响：ADR-008/plan 要求“一次端到端 turn 产出完整五层 span 到 `.logs/traces-*.jsonl`，TS/Python trace_id 一致”；当前真实 CLI/REPL 路径默认不会产生五层 span，也不会写 `.logs/traces-*`。这会直接阻塞第二轮 review gate 和 Iter D 主轴硬验收。
   - 建议：在 `startRepl` / service loop 调用 `runAgentLoop` 时传入 `getDefaultSpanProvider()`、session/user/task 信息；在 turn/session 结束后通过默认 `json_file_exporter` 或 composite exporter 自动 flush。补一个从 boot/REPL 边界触发的端到端测试，断言 `.logs/traces-YYYY-MM-DD.jsonl` 含 `agent.session`、`agent.turn`、`agent.state_node`、`llm.invoke`、`tool.invoke`。

### HIGH

1. `packages/agent-core/src/cli/config-cmd.ts:203`、`packages/agent-core/src/cli/config-cmd.ts:206`、`packages/agent-core/src/cli/config-cmd.ts:240`、`packages/agent-core/src/cli/config-cmd.ts:247`；ADR-009 `docs/adr/adr-009-config-cascade.md:125`
   - 问题：`config set` 对已有文件直接 `fs.readFile`，绕过 `loadUserConfig()` 的 `>0600` 拒绝逻辑；写回时 `mode: 0o600` 对已有文件通常不改变权限，而且只在 `!fileExists` 时 `chmod(0600)`。
   - 影响：如果用户已有 `0644 ~/.quilin/config.toml`，`config show` 会拒绝读取，但 `config set` 会先修改该宽权限文件，再 reload 才失败。安全约束从“拒绝读取后提示修复”变成“先写入宽权限文件”，违反 ADR-009 的权限边界。
   - 建议：`runSet` 先 `stat` 并在非 win32 下拒绝 `mode > 0600`，或写回后无条件 `chmod 0600` 再 reload。补测试：existing `0644` config 执行 `set` 必须拒绝且不修改，或必须修正为 `0600` 后成功。

2. `packages/agent-core/src/tools/mcp-client.ts:439`、`packages/agent-core/src/tools/mcp-client.ts:441`、`providers/memory/src/omnimem/server.py:153`、`providers/memory/src/omnimem/server.py:248`、`providers/memory/src/omnimem/server.py:417`；ADR-008 `docs/adr/adr-008-observability-span-schema.md:80`、`docs/adr/adr-008-observability-span-schema.md:90`
   - 问题：TS request 侧把 trace 放进 MCP `_meta`，Python 侧把 child `traceparent` 放进 JSON payload，而不是 response envelope metadata；TS `MCPClientManager` / `ScratchpadClient` 也不读取响应里的 `traceparent`。同时 `memory_store_tool` 没有解析 `ctx` trace，也不会回写 traceparent。
   - 影响：跨进程 trace_id 只能在部分 helper 级路径中证明，真实 MCP response 的 child span 不能被 TS 运行时消费；`memory_store` 这类 `memory_*` 调用还会断 trace。后续如果同一 turn 内多次 MCP 调用要串联 Python child span，当前实现无法做到 ADR-008 所说 request/response metadata 一致。
   - 建议：优先确认 MCP SDK 对 response `_meta`/metadata 的支持并使用 envelope metadata；若 SDK 限制只能走 payload，也要在 ADR/plan 明确降级，并在 TS client 中统一提取/记录 returned child traceparent。`memory_store_tool` 与 scratchpad/memory_recall 一样解析 `ctx` 并回写 child traceparent。增加真实 stdio MCP e2e 测试：ambient trace -> Python child trace -> TS 可观测上下文/trace 文件。

3. `providers/memory/src/omnimem/event_log.py:347`、`providers/memory/src/omnimem/event_log.py:351`、`providers/memory/src/omnimem/event_log.py:444`、`providers/memory/src/omnimem/event_log.py:452`、`providers/memory/src/omnimem/event_log.py:453`；ADR-008 `docs/adr/adr-008-observability-span-schema.md:54`、`docs/adr/adr-008-observability-span-schema.md:55`
   - 问题：M1.4 dual-emit 的 span event attributes 使用 `memory.rank_index`、`memory.score_ratio`、`memory.was_cited` 等 key。按 ADR-008，数字字段必须带单位后缀；TS validator 只额外接受 `.index`，不接受 `_index`，也不接受无单位的 `_ratio` 数字字段。
   - 影响：如果后续把 Python span event sink 接到同一套严格 validator / exporter，这些事件会被拒绝；由于 `_emit_span_event()` 会吞掉所有异常，结果会变成 SQLite 写入成功但 OTel dual-emit 静默丢失，削弱 M1.4 可观测性。
   - 建议：把 event attribute 命名对齐 ADR，例如 `memory.rank.index` 或明确追加允许规则；`memory.score_ratio` 要么改为非 numeric contract 中允许的名称，要么在 ADR-008 扩展 ratio 规则。补一个跨语言契约测试：Python dual-emit 事件属性通过 TS `validateSpanAttributes` 等价规则。

### MEDIUM

1. `providers/memory/tests/test_server.py:236`、`providers/memory/tests/test_server.py:253`、`providers/memory/tests/test_server.py:315`、`packages/agent-core/src/tools/mcp-client.test.ts:150`
   - 问题：traceparent 覆盖主要是 helper-level 或 mocked client：Python 用 `_FakeContext` 后直接调用 `_memory_recall_with_store()` / `_scratchpad_write_with_store()`，TS 用 fake `client.callTool` 断言 `_meta`。没有测试真实 FastMCP stdio 请求把 `_meta` 传到 handler `ctx`，也没有验证 response metadata/traceparent 被 TS 消费。
   - 影响：这正是跨进程 trace_id 一致性最高风险处；当前测试能证明两端函数各自可用，但不能证明 wire 上真的闭合。
   - 建议：在 `mcp-client.test.ts` 的真实 OmniMem bridge 测试中套 `runWithObservabilityContext()`，执行 `memory_recall` / `scratchpad_write`，断言返回 child traceparent、trace_id 与父 trace 一致，并在 exporter 文件里看到同一 trace_id。

2. `docs/planning/2026-04-25-01-iter-d-parallel-breakdown.md:44`、`providers/memory/benchmarks/amb_100k.py:22`、`providers/memory/benchmarks/amb_100k.py:38`
   - 问题：plan/commit evidence 写 AMB 100k p95 `16.577ms`，并解释为“dual-emit OTel writes now happen on recall path”。但 `amb_100k.py` 只构造 `OmniMemStore` + `MemoryRetriever`，没有 `RetrievalEventLog` / `span_event_sink`，因此该 benchmark 并不覆盖 M1.4 dual-emit 写路径。我本机复跑同一脚本得到 p95 `0.237ms`。
   - 影响：16.577ms 仍低于 300ms，不需要立即优化；真正的问题是 evidence 归因不成立。后续 reviewer 可能以为 dual-emit 性能已被 AMB 覆盖，实际没有。
   - 建议：把 AMB 100k 继续作为 recall gate；另加一个小型 event_log dual-emit latency smoke，明确测 SQLite + span_event_sink 的 p95/失败不阻塞。更新 plan 行，把 `16.577ms` 标为当次环境结果，不再归因于 dual-emit recall path。

### LOW

无。

## Residual Risk

- Codex follow-up 已修复 BLOCKING exporter wiring：`index.ts` 在 REPL runtime 创建 `JsonFileSpanExporter` 并把 runtime `OTelSpanProvider` 传给 `startRepl`，`repl.ts` 每轮 `runAgentLoop()` 后 flush span snapshot 并在成功导出后 clear。新增测试覆盖 REPL 将 observability 传入 loop 并自动 flush exporter。
- Codex follow-up 已修复 Kelvin `config set` 宽权限路径：写入前先拒绝 existing `>0600` config，写回后无条件 `chmod 0600`；新增测试证明 `0644` 文件不会被先写后拒绝。
- Codex follow-up 已修复 Python dual-emit attribute 漂移：`memory.rank_index` 改为 `memory.rank.index`，TS validator 增补 ratio 规则并覆盖 `memory.score_ratio` / `memory.rank.index` event attributes。
- Codex follow-up 已补真实 stdio trace 覆盖：`mcp-client.test.ts` 在 ambient observability context 下调用真实 OmniMem `memory_recall`，断言 Python 返回 child traceparent 且 trace_id 与父 trace 一致；`memory_store_tool` 也已解析 `ctx` trace 并回写 child traceparent。
- 仍保留一个降级说明：当前 FastMCP response traceparent 仍走 JSON payload，不是 envelope metadata；这是 SDK 形态限制下的可用降级，后续如果 SDK 暴露 response metadata，应迁回 ADR-008 的 metadata 形态。
- AMB 100k 继续只作为 recall gate，不能证明 event_log dual-emit latency；本轮 follow-up 复跑结果为 p95 `0.294ms`，低于 `300ms` 门槛。建议后续补一个 event_log dual-emit latency smoke，避免把 AMB 归因到 dual-emit 写入路径。

- ADR-009 cascade、forbidden fields、schema strictness、env mapping、`config show/set` 主体覆盖较好；已有宽权限文件的 `set` 路径已由 follow-up 测试覆盖。
- scratchpad 使用 `scratchpad_entries` 独立表，未扩展 ADR-005 `working | episodic | semantic | skill` 枚举；MCP methods、TS client、Executor optional Plan/Step 字段均保持向后兼容。
- Rust workspace 符合边界：`Cargo.toml` / `crates/mesh-sdk/Cargo.toml` 无外部 crates，`justfile:34` 的 `test-all` 已包含 `test-rs`，`cargo test --workspace` 通过。
- 写边界没有发现明显越界：Kelvin/Boyle/Newton/Curie touched files 与 plan 范围基本一致。当前工作区另有 `packages/agent-core/src/planning/{executor.ts,executor.test.ts,types.ts}` 修改，非本 review worker 产生，未触碰、未 revert。
- Plan §17 残余归属仍稳：`docs/planning/00-implementation-plan.md:548-550` 中 M1.1 / LongMemEval / Arm L gate 仍是资源或数据集 blocked；未发现本轮 commit 解锁信号。`25-02 cleanup sweep` 的启动条件仍要求 Iter D 主轴全部通过，鉴于上面的 BLOCKING trace/export 缺口，不能提前启动。

## Verification Notes

- 通过：Vitest targeted 66 tests、Python targeted 33 tests、`tsc`、Biome、Ruff、Rust test、AMB 100k gate。
- 未跑完整 `just test-all`，因为 targeted + 三语言核心命令已覆盖本 review 重点；commit message 声称的历史 `just test-all` 仅作为只读证据，没有在本轮复跑。
- `bun test ...` 失败不计为项目测试失败：项目 package script 是 `vitest run --configLoader runner`，直接 Bun runner 与 Vitest API 不兼容。
