import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createToolProvenanceEntry,
	JsonlAgentRunLogger,
	recordAgentRunEvent,
	summarizeProviderRunRecord,
} from "./agent-run-log.js";

describe("JsonlAgentRunLogger", () => {
	it("writes redacted per-session JSONL events with stable sequence numbers", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "quilin-agent-run-log-"));
		const logger = new JsonlAgentRunLogger({
			sessionId: "session/test",
			logsDir,
			now: () => new Date("2026-05-02T13:00:00.000Z"),
		});

		await recordAgentRunEvent(
			logger,
			"turn.input_received",
			{
				input: "hello sk-abcdefghijklmnopqrstuvwxyz012345",
				headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345" },
			},
			{ turnId: "turn-1" },
		);
		await recordAgentRunEvent(logger, "turn.completed", { ok: true });

		const lines = (await readFile(join(logsDir, "session_test.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			schema_version: 1,
			session_id: "session/test",
			turn_id: "turn-1",
			seq: 1,
			phase: "turn.input_received",
		});
		expect(JSON.stringify(lines[0])).toContain("[REDACTED:openai_key]");
		expect(JSON.stringify(lines[0])).not.toContain(
			"Bearer abcdefghijklmnopqrstuvwxyz012345",
		);
		expect(lines[1]).toMatchObject({ seq: 2, phase: "turn.completed" });
	});

	it("extracts URL provenance from web_fetch tool results", () => {
		const provenance = createToolProvenanceEntry({
			toolCall: {
				id: "call-1",
				name: "web_fetch",
				arguments: { url: "https://example.com/search?q=codex" },
			},
			toolResult: {
				toolCallId: "call-1",
				isError: false,
				content: JSON.stringify({
					url: "https://example.com/search?q=codex",
					status: 200,
					contentType: "text/html",
					body: "ok",
				}),
			},
			sanitizedContent: JSON.stringify({
				url: "https://example.com/search?q=codex",
				status: 200,
				contentType: "text/html",
				body: "ok",
			}),
			at: "2026-05-02T13:00:00.000Z",
		});

		expect(provenance).toEqual({
			at: "2026-05-02T13:00:00.000Z",
			tool: "web_fetch",
			callId: "call-1",
			sourceType: "url",
			url: "https://example.com/search?q=codex",
			host: "example.com",
			status: 200,
			contentType: "text/html",
			isError: false,
		});
	});

	it("summarizes provider route records for run logs", () => {
		expect(
			summarizeProviderRunRecord({
				route: {
					provider: "deepseek",
					configuredModel: "deepseek-v4-flash",
					effectiveModel: "deepseek-v4-flash",
					fallbackUsed: false,
					reasoningStateAdapter: "captured_replayed_for_tool_calls",
					selectedTier: "lite",
					routingMode: "auto",
					routeReason: "default_tier",
					thinkingMode: "enabled",
				},
				attempts: [
					{
						attemptNumber: 1,
						provider: "deepseek",
						model: "deepseek-v4-flash",
						startedAt: "2026-05-02T13:00:00.000Z",
						completedAt: "2026-05-02T13:00:01.000Z",
						outcome: "success",
						usage: { inputTokens: 10, outputTokens: 20 },
					},
				],
				outcome: "success",
				fallbackUsed: false,
			}),
		).toMatchObject({
			provider: "deepseek",
			selectedTier: "lite",
			routeReason: "default_tier",
			firstAttempt: {
				model: "deepseek-v4-flash",
				usage: { inputTokens: 10, outputTokens: 20 },
			},
		});
	});
});
