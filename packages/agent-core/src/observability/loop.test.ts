import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../loop.js";
import { serializeSpan } from "./exporters/json-file.js";
import { createAgentLoopTelemetry } from "./loop.js";
import { OTelSpanProvider } from "./span.js";

vi.mock("../logger.js", () => ({
	getLoggerRuntimeMode: vi.fn(() => "repl"),
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
	},
}));

describe("runAgentLoop observability", () => {
	it("creates session, turn, state_node, llm.invoke, and tool.invoke spans", async () => {
		const spans = new OTelSpanProvider();
		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						name: "memory_recall",
						arguments: { query: "hello" },
					},
				],
				usage: { inputTokens: 10, outputTokens: 2 },
				finishReason: "tool_calls",
			})
			.mockResolvedValueOnce({
				content: "done",
				usage: { inputTokens: 3, outputTokens: 4 },
				finishReason: "stop",
			});
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "call-1",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});

		await runAgentLoop(
			{
				llm: { chat },
				modelId: "deepseek-chat",
				observability: {
					spans,
					sessionId: "session-1",
					userId: "user-1",
					taskSummary: "test task",
					llmProviderId: "deepseek",
				},
				tools: [
					{
						name: "memory_recall",
						description: "Recall memory",
						parameters: {
							safeParse: vi.fn().mockImplementation((input) => ({
								success: true,
								data: input,
							})),
						} as never,
						execute,
					},
				],
				inferenceConfig: {
					temperature: 0.7,
					maxTokens: 1024,
					thinkingMode: "disabled",
				},
			},
			[{ role: "user", content: "hello token=secret" }],
		);

		const snapshots = spans.snapshot();
		const session = snapshots.find((span) => span.name === "agent.session");
		const turns = snapshots.filter((span) => span.name === "agent.turn");
		const stateNodes = snapshots.filter(
			(span) => span.name === "agent.state_node",
		);
		const llmSpans = snapshots.filter((span) => span.name === "llm.invoke");
		const llmSpan = llmSpans[0];
		const toolSpan = snapshots.find((span) => span.name === "tool.invoke");
		const toolParent = snapshots.find(
			(span) => span.spanId === toolSpan?.parentSpanId,
		);

		expect(snapshots.map((span) => span.name)).toEqual(
			expect.arrayContaining([
				"agent.session",
				"agent.turn",
				"agent.state_node",
				"llm.invoke",
				"tool.invoke",
			]),
		);
		expect(session?.parentSpanId).toBeUndefined();
		expect(turns).toHaveLength(1);
		expect(turns[0]?.parentSpanId).toBe(session?.spanId);
		expect(llmSpans).toHaveLength(2);
		expect(
			stateNodes.every((span) => span.parentSpanId === turns[0]?.spanId),
		).toBe(true);
		expect(llmSpan?.parentSpanId).toBe(stateNodes[0]?.spanId);
		expect(toolParent?.name).toBe("agent.state_node");
		expect(toolParent?.attributes["state_node.name"]).toBe("execute");
		expect(llmSpan?.attributes["llm.provider"]).toBe("deepseek");
		expect(toolSpan?.attributes).toEqual(
			expect.objectContaining({
				"tool.name": "memory_recall",
				"tool.success": true,
				"tool.result_size_bytes": expect.any(Number),
			}),
		);
		expect(session?.attributes).toEqual(
			expect.objectContaining({
				"session.turn_count": 1,
				"session.total_tokens": 19,
			}),
		);
	});

	it("records error and fallback observability paths without leaking secrets", async () => {
		const spans = new OTelSpanProvider();
		const telemetry = createAgentLoopTelemetry(
			{
				spans,
			},
			[],
		);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [
				{
					role: "assistant",
					content: "previous assistant message",
				},
				{
					role: "user",
					content: [
						"contact me at user@example.com",
						"SESSION_TOKEN=secret-value",
					]
						.join("\n")
						.concat("\n")
						.repeat(8)
						.trim(),
				},
			],
		});

		await expect(
			turn.invokeLLM(
				{
					modelId: undefined,
					inferenceConfig: {
						temperature: 0.1,
						maxTokens: 128,
						thinkingMode: "auto",
					},
				},
				async () => {
					throw "llm-string-failure";
				},
			),
		).rejects.toBe("llm-string-failure");
		const toolFailure = await turn.invokeTool(
			{
				id: "call-1",
				name: "memory_recall",
				arguments: { ids: ["a", "b"], include: true },
			},
			async () => ({
				toolCallId: "call-1",
				content: JSON.stringify({ error: "LOOKUP_FAILED" }),
				isError: true,
			}),
		);
		const malformedToolFailure = await turn.invokeTool(
			{
				id: "call-2",
				name: "memory_store",
				arguments: { note: "bad-json" },
			},
			async () => ({
				toolCallId: "call-2",
				content: "not-json",
				isError: true,
			}),
		);
		turn.end(false);
		telemetry.endSession({ turnCount: 0, totalTokens: 0, success: false });

		const snapshots = spans.snapshot();
		const session = snapshots.find((span) => span.name === "agent.session");
		const turnSpan = snapshots.find((span) => span.name === "agent.turn");
		const llmSpan = snapshots.find((span) => span.name === "llm.invoke");
		const toolSpans = snapshots.filter((span) => span.name === "tool.invoke");

		expect(toolFailure.isError).toBe(true);
		expect(malformedToolFailure.isError).toBe(true);
		expect(session?.attributes).toEqual(
			expect.objectContaining({
				"session.user_id": "unknown",
				"session.task_summary": "unknown",
				"session.turn_count": 0,
			}),
		);
		expect(session?.status).toBe("error");
		expect(turnSpan?.attributes["turn.user_input_redacted"]).toEqual(
			expect.stringContaining("[REDACTED:email]"),
		);
		expect(turnSpan?.attributes["turn.user_input_redacted"]).toEqual(
			expect.stringContaining("SESSION_TOKEN=[REDACTED:env_secret]"),
		);
		expect(turnSpan?.attributes["turn.user_input_redacted"]).not.toContain(
			"user@example.com",
		);
		expect(turnSpan?.attributes["turn.user_input_redacted"]).not.toContain(
			"secret-value",
		);
		expect(
			String(turnSpan?.attributes["turn.user_input_redacted"]).length,
		).toBeLessThanOrEqual(163);
		expect(turnSpan?.status).toBe("error");
		expect(llmSpan?.attributes["llm.model"]).toBe("unknown");
		expect(llmSpan?.attributes["llm.thinking_mode"]).toBe("standard");
		expect(llmSpan?.events).toEqual([
			expect.objectContaining({
				name: "llm_error",
				attributes: { "error.type": "UNKNOWN_ERROR" },
			}),
		]);
		expect(toolSpans.map((span) => span.status)).toEqual(["error", "error"]);
		expect(toolSpans.map((span) => span.attributes["tool.error_type"])).toEqual(
			["lookup_failed", "tool_error"],
		);
		expect(toolSpans[0]?.attributes["tool.params_summary"]).toBe(
			JSON.stringify({
				keys: [
					["ids", "array"],
					["include", "boolean"],
				],
			}),
		);
	});

	it("redacts shared safety patterns from user input and default task summary", () => {
		const cases = [
			{
				name: "bearer token",
				input: "Bearer abcdefghijklmnopqrstuvwxyz012345",
				marker: "Bearer [REDACTED:bearer_token]",
				rawFragments: ["abcdefghijklmnopqrstuvwxyz012345"],
			},
			{
				name: "OpenAI-style key",
				input: "sk-abcdefghijklmnop",
				marker: "[REDACTED:openai_key]",
				rawFragments: ["sk-abcdefghijklmnop"],
			},
			{
				name: "GitHub token",
				input: "ghp_abcdefghijklmnopqrst",
				marker: "[REDACTED:github_token]",
				rawFragments: ["ghp_abcdefghijklmnopqrst"],
			},
			{
				name: "Slack token",
				input: "xoxb-1234567890-ABCDEFGHIJ-secretvalue",
				marker: "[REDACTED:slack_token]",
				rawFragments: ["xoxb-1234567890-ABCDEFGHIJ-secretvalue"],
			},
			{
				name: "database URL",
				input: "postgres://user:db-pass@localhost:5432/app",
				marker: "[REDACTED:database_url]",
				rawFragments: ["db-pass", "postgres://user"],
			},
			{
				name: ".env assignment line",
				input: "OPENAI_API_KEY=plain-openai-secret",
				marker: "OPENAI_API_KEY=[REDACTED:env_secret]",
				rawFragments: ["plain-openai-secret"],
			},
			{
				name: "email address",
				input: "alpha@example.com",
				marker: "[REDACTED:email]",
				rawFragments: ["alpha@example.com"],
			},
		];

		for (const pattern of cases) {
			const spans = new OTelSpanProvider();
			const messages = [{ role: "user" as const, content: pattern.input }];
			const telemetry = createAgentLoopTelemetry({ spans }, messages);
			telemetry.startTurn({ turnIndex: 0, messages });

			const snapshots = spans.snapshot();
			const session = snapshots.find((span) => span.name === "agent.session");
			const turnSpan = snapshots.find((span) => span.name === "agent.turn");
			if (session == null || turnSpan == null) {
				throw new Error(`missing observability span for ${pattern.name}`);
			}

			const payloads = [
				String(session.attributes["session.task_summary"]),
				String(turnSpan.attributes["turn.user_input_redacted"]),
				JSON.stringify(serializeSpan(session)),
				JSON.stringify(serializeSpan(turnSpan)),
			];

			for (const payload of payloads) {
				expect(payload).toContain(pattern.marker);
				for (const rawFragment of pattern.rawFragments) {
					expect(payload).not.toContain(rawFragment);
				}
			}
		}
	});

	it("redacts shared safety patterns from explicit task summary", () => {
		const explicitTaskSummary = [
			"Bearer abcdefghijklmnopqrstuvwxyz012345",
			"sk-abcdefghijklmnop",
			"ghp_abcdefghijklmnopqrst",
			"xoxb-1234567890-ABCDEFGHIJ-secretvalue",
			"postgres://user:db-pass@localhost:5432/app",
			"OPENAI_API_KEY=plain-openai-secret",
			"alpha@example.com",
		].join("\n");
		const spans = new OTelSpanProvider();
		createAgentLoopTelemetry(
			{
				spans,
				taskSummary: explicitTaskSummary,
			},
			[{ role: "user", content: "safe user request" }],
		);

		const session = spans
			.snapshot()
			.find((span) => span.name === "agent.session");
		if (session == null) {
			throw new Error("missing agent.session span");
		}

		const taskSummary = String(session.attributes["session.task_summary"]);
		const exportedJson = JSON.stringify(serializeSpan(session));
		const markers = [
			"Bearer [REDACTED:bearer_token]",
			"[REDACTED:openai_key]",
			"[REDACTED:github_token]",
			"[REDACTED:slack_token]",
			"[REDACTED:database_url]",
			"OPENAI_API_KEY=[REDACTED:env_secret]",
			"[REDACTED:email]",
		];
		const rawFragments = [
			"abcdefghijklmnopqrstuvwxyz012345",
			"sk-abcdefghijklmnop",
			"ghp_abcdefghijklmnopqrst",
			"xoxb-1234567890-ABCDEFGHIJ-secretvalue",
			"db-pass",
			"postgres://user",
			"plain-openai-secret",
			"alpha@example.com",
		];

		expect(taskSummary).not.toBe(explicitTaskSummary);
		for (const payload of [taskSummary, exportedJson]) {
			for (const marker of markers) {
				expect(payload).toContain(marker);
			}
			for (const rawFragment of rawFragments) {
				expect(payload).not.toContain(rawFragment);
			}
		}
	});

	it("classifies failed tool result errors without exporting bearer tokens", async () => {
		const spans = new OTelSpanProvider();
		const telemetry = createAgentLoopTelemetry({ spans }, []);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [{ role: "user", content: "run tool" }],
		});
		const bearerToken = "Bearer abcdefghijklmnopqrstuvwxyz012345";

		const toolFailure = await turn.invokeTool(
			{
				id: "call-secret",
				name: "memory_recall",
				arguments: { query: "safe" },
			},
			async () => ({
				toolCallId: "call-secret",
				content: JSON.stringify({
					error: `Provider failed with ${bearerToken}`,
				}),
				isError: true,
			}),
		);

		turn.end(false);
		telemetry.endSession({ turnCount: 1, totalTokens: 0, success: false });

		const toolSpan = spans
			.snapshot()
			.find((span) => span.name === "tool.invoke");
		if (toolSpan == null) {
			throw new Error("missing tool.invoke span");
		}

		const exportedToolSpan = serializeSpan(toolSpan);
		const spanAttributesJson = JSON.stringify(toolSpan.attributes);
		const exportedJson = JSON.stringify(exportedToolSpan);

		expect(toolFailure.isError).toBe(true);
		expect(toolSpan.attributes["tool.error_type"]).toBe("tool_error");
		expect(exportedToolSpan.attributes["tool.error_type"]).toBe("tool_error");
		for (const payload of [spanAttributesJson, exportedJson]) {
			expect(payload).not.toContain(bearerToken);
			expect(payload).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
			expect(payload).not.toContain("Provider failed");
		}
	});

	it("runs without an active span provider", async () => {
		const telemetry = createAgentLoopTelemetry(undefined, [
			{ role: "assistant", content: "no user message" },
		]);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [{ role: "assistant", content: "no user message" }],
		});

		const llmResult = await turn.invokeLLM(
			{
				modelId: "mock-model",
				inferenceConfig: {
					temperature: 0.1,
					maxTokens: 128,
					thinkingMode: "disabled",
				},
			},
			async () => ({
				content: "ok",
				usage: {
					inputTokens: 1,
					outputTokens: 2,
				},
				finishReason: "error",
			}),
		);

		expect(llmResult.finishReason).toBe("error");
		expect(() =>
			telemetry.endSession({ turnCount: 2, totalTokens: 3, success: true }),
		).not.toThrow();
	});

	it("records typed errors, no-user turns, error finish reasons, and structured tool errors", async () => {
		const spans = new OTelSpanProvider();
		const telemetry = createAgentLoopTelemetry(
			{
				spans,
				sessionId: "session-2",
			},
			[{ role: "assistant", content: "assistant only" }],
		);
		const turn = telemetry.startTurn({
			turnIndex: 0,
			messages: [{ role: "assistant", content: "assistant only" }],
		});

		await expect(
			turn.invokeLLM(
				{
					modelId: "mock-model",
					inferenceConfig: {
						temperature: 0.1,
						maxTokens: 128,
						thinkingMode: "disabled",
					},
				},
				async () => {
					throw new TypeError("bad model output");
				},
			),
		).rejects.toThrow("bad model output");
		const errorFinish = await turn.invokeLLM(
			{
				modelId: "mock-model",
				inferenceConfig: {
					temperature: 0.1,
					maxTokens: 128,
					thinkingMode: "auto",
				},
			},
			async () => ({
				content: "failed",
				usage: { inputTokens: 1, outputTokens: 0 },
				finishReason: "error",
			}),
		);
		const toolResult = await turn.invokeTool(
			{
				id: "call-1",
				name: "memory_store",
				arguments: {},
			},
			async () => ({
				toolCallId: "call-1",
				content: JSON.stringify({ error: { code: "E_STRUCTURED" } }),
				isError: true,
			}),
		);

		turn.end(false);
		telemetry.endSession({ turnCount: 1, totalTokens: 1, success: false });

		const snapshots = spans.snapshot();
		const turnSpan = snapshots.find((span) => span.name === "agent.turn");
		const llmSpans = snapshots.filter((span) => span.name === "llm.invoke");
		const toolSpan = snapshots.find((span) => span.name === "tool.invoke");

		expect(errorFinish.finishReason).toBe("error");
		expect(toolResult.isError).toBe(true);
		expect(turnSpan?.attributes["turn.user_input_redacted"]).toBe("");
		expect(llmSpans.map((span) => span.status)).toEqual(["error", "error"]);
		expect(llmSpans[0]?.events).toEqual([
			expect.objectContaining({
				name: "llm_error",
				attributes: { "error.type": "TypeError" },
			}),
		]);
		expect(toolSpan?.attributes["tool.params_summary"]).toBe(
			JSON.stringify({ keys: [] }),
		);
		expect(toolSpan?.attributes["tool.error_type"]).toBe("e_structured");
	});
});
