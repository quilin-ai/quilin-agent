import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
	InferenceConfig,
	LLMResponse,
	ThinkingMode,
} from "../llm/types.js";
import type { Message } from "../state/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { runWithObservabilityContext } from "./context.js";
import type {
	LLMThinkingMode,
	OTelSpan,
	OTelSpanProvider,
	SpanAttributes,
	StateNodeName,
} from "./span.js";

export interface AgentLoopObservability {
	readonly spans?: OTelSpanProvider;
	readonly sessionId?: string;
	readonly userId?: string;
	readonly taskSummary?: string;
}

interface StartTurnInput {
	readonly turnIndex: number;
	readonly messages: readonly Message[];
}

interface InvokeLLMInput {
	readonly modelId?: string;
	readonly inferenceConfig: InferenceConfig;
}

function redactText(value: string, maxLength = 160): string {
	const redacted = value
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
		.replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
	return redacted.length <= maxLength
		? redacted
		: `${redacted.slice(0, maxLength)}...`;
}

function latestUserInput(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") {
			return redactText(message.content);
		}
	}

	return "";
}

function summarizeTask(messages: readonly Message[]): string {
	return latestUserInput(messages) || "unknown";
}

function mapThinkingMode(mode: ThinkingMode): LLMThinkingMode {
	return mode === "disabled" ? "off" : "standard";
}

function summarizeParams(args: Record<string, unknown>): string {
	const entries = Object.entries(args)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => [
			key,
			Array.isArray(value) ? "array" : typeof value,
		]);
	return JSON.stringify({ keys: entries });
}

function errorType(error: unknown): string {
	return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function toolErrorType(result: ToolResult): string {
	if (!result.isError) {
		return "";
	}

	try {
		const parsed = JSON.parse(result.content) as { error?: unknown };
		return typeof parsed.error === "string" ? parsed.error : "TOOL_ERROR";
	} catch {
		return "TOOL_ERROR";
	}
}

class AgentTurnTelemetry {
	readonly requestId: string;
	readonly turnId: string;
	private readonly turnSpan?: OTelSpan;

	constructor(
		private readonly spans: OTelSpanProvider | undefined,
		private readonly sessionId: string,
		sessionSpan: OTelSpan | undefined,
		input: StartTurnInput,
	) {
		this.requestId = randomUUID();
		this.turnId = this.requestId;
		this.turnSpan = spans?.startSpan(
			"agent.turn",
			{
				"turn.id": this.turnId,
				"turn.index": input.turnIndex,
				"turn.user_input_redacted": latestUserInput(input.messages),
				"turn.replanning_count": 0,
				"turn.cost_usd": 0,
				"turn.success": false,
			},
			{ parent: sessionSpan },
		);
	}

	runStateNode<T>(
		name: StateNodeName,
		operation: (stateSpan: OTelSpan | undefined) => Promise<T>,
	): Promise<T> {
		const stateSpan = this.spans?.startSpan(
			"agent.state_node",
			{ "state_node.name": name, "state_node.duration_ms": 0 },
			{ parent: this.turnSpan },
		);

		return runWithObservabilityContext(
			{
				requestId: this.requestId,
				sessionId: this.sessionId,
				turnId: this.turnId,
				traceId: stateSpan?.traceId ?? this.turnSpan?.traceId,
				spanId: stateSpan?.spanId ?? this.turnSpan?.spanId,
			},
			async () => {
				try {
					const result = await operation(stateSpan);
					stateSpan?.end("ok");
					return result;
				} catch (error) {
					stateSpan?.end("error");
					throw error;
				}
			},
		);
	}

	invokeLLM(
		input: InvokeLLMInput,
		operation: () => Promise<LLMResponse>,
	): Promise<LLMResponse> {
		return this.runStateNode("plan", async (stateSpan) => {
			const llmSpan = this.spans?.startSpan(
				"llm.invoke",
				{
					"llm.model": input.modelId ?? "unknown",
					"llm.provider": "unknown",
					"llm.tokens_input": 0,
					"llm.tokens_output": 0,
					"llm.tokens_thinking": 0,
					"llm.thinking_mode": mapThinkingMode(
						input.inferenceConfig.thinkingMode,
					),
					"llm.cost_usd": 0,
					"llm.time_to_first_token_ms": 0,
					"llm.total_latency_ms": 0,
				},
				{ parent: stateSpan },
			);
			const startedAt = Date.now();

			return runWithObservabilityContext(
				{
					requestId: this.requestId,
					sessionId: this.sessionId,
					turnId: this.turnId,
					traceId: llmSpan?.traceId ?? this.turnSpan?.traceId,
					spanId: llmSpan?.spanId ?? this.turnSpan?.spanId,
				},
				async () => {
					try {
						const response = await operation();
						const latencyMs = Date.now() - startedAt;
						llmSpan?.setAttributes({
							"llm.tokens_input": response.usage.inputTokens,
							"llm.tokens_output": response.usage.outputTokens,
							"llm.time_to_first_token_ms": latencyMs,
							"llm.total_latency_ms": latencyMs,
						});
						llmSpan?.end(response.finishReason === "error" ? "error" : "ok");
						return response;
					} catch (error) {
						llmSpan?.addEvent("llm_error", { "error.type": errorType(error) });
						llmSpan?.end("error");
						throw error;
					}
				},
			);
		});
	}

	invokeTool(
		toolCall: ToolCall,
		operation: () => Promise<ToolResult>,
	): Promise<ToolResult> {
		return this.runStateNode("execute", async (stateSpan) => {
			const toolSpan = this.spans?.startSpan(
				"tool.invoke",
				{
					"tool.name": toolCall.name,
					"tool.params_summary": summarizeParams(toolCall.arguments),
					"tool.duration_ms": 0,
					"tool.success": false,
					"tool.result_size_bytes": 0,
				},
				{ parent: stateSpan },
			);
			const startedAt = Date.now();

			return runWithObservabilityContext(
				{
					requestId: this.requestId,
					sessionId: this.sessionId,
					turnId: this.turnId,
					traceId: toolSpan?.traceId ?? this.turnSpan?.traceId,
					spanId: toolSpan?.spanId ?? this.turnSpan?.spanId,
				},
				async () => {
					try {
						const result = await operation();
						const durationMs = Date.now() - startedAt;
						const success = !result.isError;
						toolSpan?.setAttributes({
							"tool.duration_ms": durationMs,
							"tool.success": success,
							"tool.result_size_bytes": Buffer.byteLength(
								result.content,
								"utf8",
							),
							...(success ? {} : { "tool.error_type": toolErrorType(result) }),
						} as SpanAttributes);
						toolSpan?.end(success ? "ok" : "error");
						return result;
					} catch (error) {
						toolSpan?.setAttributes({
							"tool.duration_ms": Date.now() - startedAt,
							"tool.success": false,
							"tool.result_size_bytes": 0,
							"tool.error_type": errorType(error),
						});
						toolSpan?.end("error");
						throw error;
					}
				},
			);
		});
	}

	end(success: boolean): void {
		this.turnSpan?.setAttribute("turn.success", success);
		this.turnSpan?.end(success ? "ok" : "error");
	}
}

export class AgentLoopTelemetry {
	private readonly sessionId: string;
	private readonly sessionSpan?: OTelSpan;

	constructor(
		private readonly observability: AgentLoopObservability | undefined,
		messages: readonly Message[],
	) {
		this.sessionId = observability?.sessionId ?? randomUUID();
		this.sessionSpan = observability?.spans?.startSpan("agent.session", {
			"session.id": this.sessionId,
			"session.user_id": observability?.userId ?? "unknown",
			"session.task_summary":
				observability?.taskSummary ?? summarizeTask(messages),
			"session.turn_count": 0,
			"session.total_cost_usd": 0,
			"session.total_tokens": 0,
		});
	}

	startTurn(input: StartTurnInput): AgentTurnTelemetry {
		return new AgentTurnTelemetry(
			this.observability?.spans,
			this.sessionId,
			this.sessionSpan,
			input,
		);
	}

	endSession(input: {
		readonly turnCount: number;
		readonly totalTokens: number;
		readonly success: boolean;
	}): void {
		this.sessionSpan?.setAttributes({
			"session.turn_count": input.turnCount === 0 ? 0 : 1,
			"session.total_tokens": input.totalTokens,
		});
		this.sessionSpan?.end(input.success ? "ok" : "error");
	}
}

export function createAgentLoopTelemetry(
	observability: AgentLoopObservability | undefined,
	messages: readonly Message[],
): AgentLoopTelemetry {
	return new AgentLoopTelemetry(observability, messages);
}

export type { AgentTurnTelemetry };
