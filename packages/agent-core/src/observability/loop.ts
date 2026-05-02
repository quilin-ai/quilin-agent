import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
	InferenceConfig,
	LLMProviderId,
	LLMResponse,
	ThinkingMode,
} from "../llm/types.js";
import { redactString, redactToolOutput } from "../safety/redaction.js";
import type { Message } from "../state/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { AgentRunLogSink } from "./agent-run-log.js";
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
	readonly turnId?: string;
	readonly userId?: string;
	readonly taskSummary?: string;
	readonly llmProviderId?: LLMProviderId;
	readonly runLogger?: AgentRunLogSink;
}

interface StartTurnInput {
	readonly turnIndex: number;
	readonly messages: readonly Message[];
}

interface InvokeLLMInput {
	readonly modelId?: string;
	readonly inferenceConfig: InferenceConfig;
}

const DEFAULT_TOOL_ERROR_TYPE = "tool_error";
const BLOCKED_TOOL_ERROR_TYPE = "blocked";
const SAFE_ERROR_CODE_CHARS = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const DELIMITED_ERROR_CODE_PATTERN =
	/^[A-Za-z][A-Za-z0-9]*(?:[_.:-][A-Za-z0-9]+)+$/;
const ERROR_CLASS_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:Error|Exception)$/;
const UPPERCASE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.:-]{1,63}$/;

function redactText(value: string, maxLength = 160): string {
	const redacted = redactString(value);
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
			redactString(key),
			Array.isArray(value) ? "array" : typeof value,
		]);
	return redactString(JSON.stringify({ keys: entries }));
}

function errorType(error: unknown): string {
	return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function safeAttributeText(value: string, maxLength = 160): string {
	const redacted = redactString(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	const truncated =
		redacted.length <= maxLength
			? redacted
			: `${redacted.slice(0, maxLength)}...`;
	return truncated.length === 0 ? "unknown" : truncated;
}

function normalizedSafeErrorCode(value: string): string | undefined {
	const redacted = redactString(value.trim());
	if (
		redacted.includes("[REDACTED") ||
		!SAFE_ERROR_CODE_CHARS.test(redacted) ||
		!(
			DELIMITED_ERROR_CODE_PATTERN.test(redacted) ||
			ERROR_CLASS_CODE_PATTERN.test(redacted) ||
			UPPERCASE_ERROR_CODE_PATTERN.test(redacted)
		)
	) {
		return undefined;
	}

	return redacted
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[.:-]+/g, "_")
		.replace(/_{2,}/g, "_")
		.toLowerCase();
}

function classifyToolErrorText(value: string): string {
	const redacted = redactString(value);
	if (/\bblocked\b/i.test(redacted)) {
		return BLOCKED_TOOL_ERROR_TYPE;
	}

	return normalizedSafeErrorCode(redacted) ?? DEFAULT_TOOL_ERROR_TYPE;
}

function stringProperty(
	value: unknown,
	key: "code" | "error" | "name" | "type",
): string | undefined {
	return typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>)[key] === "string"
		? ((value as Record<string, string>)[key] ?? undefined)
		: undefined;
}

function toolErrorType(result: ToolResult): string {
	if (!result.isError) {
		return "";
	}

	const content = redactToolOutput(result.content);
	try {
		const parsed = JSON.parse(content) as { error?: unknown };
		if (typeof parsed.error === "string") {
			return classifyToolErrorText(parsed.error);
		}

		const safeCode =
			normalizedSafeErrorCode(stringProperty(parsed.error, "code") ?? "") ??
			normalizedSafeErrorCode(stringProperty(parsed.error, "type") ?? "") ??
			normalizedSafeErrorCode(stringProperty(parsed, "code") ?? "") ??
			normalizedSafeErrorCode(stringProperty(parsed, "type") ?? "");
		return safeCode ?? DEFAULT_TOOL_ERROR_TYPE;
	} catch {
		return /\bblocked\b/i.test(content)
			? BLOCKED_TOOL_ERROR_TYPE
			: DEFAULT_TOOL_ERROR_TYPE;
	}
}

function toolExceptionType(error: unknown): string {
	return normalizedSafeErrorCode(errorType(error)) ?? DEFAULT_TOOL_ERROR_TYPE;
}

class AgentTurnTelemetry {
	readonly requestId: string;
	readonly turnId: string;
	private readonly turnSpan?: OTelSpan;

	constructor(
		private readonly spans: OTelSpanProvider | undefined,
		private readonly sessionId: string,
		private readonly llmProviderId: LLMProviderId | undefined,
		turnId: string | undefined,
		sessionSpan: OTelSpan | undefined,
		input: StartTurnInput,
	) {
		this.requestId = randomUUID();
		this.turnId = turnId ?? this.requestId;
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
					"llm.provider": this.llmProviderId ?? "unknown",
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
					"tool.name": safeAttributeText(toolCall.name),
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
							"tool.error_type": toolExceptionType(error),
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
				observability?.taskSummary == null
					? summarizeTask(messages)
					: redactString(observability.taskSummary),
			"session.turn_count": 0,
			"session.total_cost_usd": 0,
			"session.total_tokens": 0,
		});
	}

	startTurn(input: StartTurnInput): AgentTurnTelemetry {
		return new AgentTurnTelemetry(
			this.observability?.spans,
			this.sessionId,
			this.observability?.llmProviderId,
			this.observability?.turnId,
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
