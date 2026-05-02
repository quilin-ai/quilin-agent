import {
	createSystemContextSource,
	DEFAULT_CONTEXT_BUDGET,
} from "./context/manager.js";
import {
	sanitizeReasoningParts,
	stripNonReplayableReasoningFromMessages,
} from "./context/reasoning-sanitizer.js";
import { getLoggerRuntimeMode, logger } from "./logger.js";
import { executeToolCalls } from "./loop-tool-calls.js";
import {
	type AgentLoopConfig,
	AgentLoopError,
	createAssistantMessage,
	DEFAULT_MAX_TOTAL_TOKENS,
	DEFAULT_MAX_TURNS,
	recordLoopSpan,
} from "./loop-types.js";
import {
	recordAgentRunEvent,
	summarizeMessage,
	summarizeMessages,
	summarizeToolCall,
} from "./observability/agent-run-log.js";
import { createAgentLoopTelemetry } from "./observability/loop.js";
import { saveCheckpointState } from "./state/checkpoint-writer.js";
import type { Message } from "./state/types.js";
import { ToolRouter } from "./tools/router.js";

export async function runAgentLoop(
	config: AgentLoopConfig,
	messages: readonly Message[],
): Promise<string> {
	const { llm, inferenceConfig } = config;
	const shouldLogDebug = getLoggerRuntimeMode() !== "repl";
	const router = new ToolRouter(config.tools ?? [], config.toolRouterOptions);
	const workingMessages: Message[] = [...messages];
	const baseSystemPrompt =
		messages[0]?.role === "system" ? messages[0].content : null;
	if (
		config.context != null &&
		baseSystemPrompt == null &&
		config.sessionAssembler == null
	) {
		logger.warn(
			"ContextManager provided but no system message found — skipping context rebuild",
		);
	}
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxTotalTokens = config.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
	const telemetry = createAgentLoopTelemetry(config.observability, messages);
	const runLogger = config.observability?.runLogger;
	let turnCount = config.state?.turnCount ?? 0;
	let totalTokens = 0;
	let loopSucceeded = false;
	let turnKind: "user-turn" | "tool-resume" = "user-turn";
	let consecutiveBlockedToolOutputs = 0;
	const turnTelemetry = telemetry.startTurn({
		turnIndex: turnCount + 1,
		messages: workingMessages,
	});
	const runLogContext = { turnId: turnTelemetry.turnId };
	await recordAgentRunEvent(
		runLogger,
		"loop.turn_started",
		{
			turnIndex: turnCount + 1,
			messageState: summarizeMessages(workingMessages),
			maxTurns,
			maxTotalTokens,
		},
		runLogContext,
	);
	if (
		config.context != null &&
		baseSystemPrompt == null &&
		config.sessionAssembler == null
	) {
		await recordAgentRunEvent(
			runLogger,
			"context.rebuild_skipped",
			{
				reason: "context_manager_without_system_message",
				messageState: summarizeMessages(workingMessages),
			},
			runLogContext,
		);
	}
	try {
		while (true) {
			if (turnCount >= maxTurns) {
				throw new AgentLoopError(`Agent loop exceeded maxTurns=${maxTurns}`);
			}
			turnCount += 1;
			if (
				config.context != null &&
				baseSystemPrompt != null &&
				config.sessionAssembler == null
			) {
				const systemPrompt = await turnTelemetry.runStateNode(
					"build_context",
					async () =>
						config.context?.buildContext(
							[createSystemContextSource(baseSystemPrompt)],
							DEFAULT_CONTEXT_BUDGET,
						) ?? baseSystemPrompt,
				);
				workingMessages[0] = { role: "system", content: systemPrompt };
			}
			await recordLoopSpan(config.hooks, "loop.turn.start", {
				turnCount,
				messageCount: workingMessages.length,
			});
			await saveCheckpointState({
				checkpoint: config.checkpoint,
				messages: workingMessages,
				turnCount,
				state: config.state,
				phase: "turn_start",
				recordSpan: config.hooks?.recordSpan,
			});
			await recordAgentRunEvent(
				runLogger,
				"checkpoint.saved",
				{
					phase: "turn_start",
					turnCount,
					messageCount: workingMessages.length,
				},
				runLogContext,
			);
			if (shouldLogDebug) {
				logger.debug(
					{ turnMessages: workingMessages.length, turnCount, maxTurns },
					"Agent loop: calling LLM",
				);
			}
			const outboundTranscript =
				stripNonReplayableReasoningFromMessages(workingMessages);
			const outboundRequest =
				config.sessionAssembler == null
					? { messages: outboundTranscript }
					: config.sessionAssembler.buildOutboundRequest({
							transcript: outboundTranscript,
							turnKind,
							lastMessageTime:
								turnKind === "user-turn" ? config.lastMessageTime : undefined,
						});
			const outboundMessages = stripNonReplayableReasoningFromMessages(
				outboundRequest.messages,
			);
			await recordAgentRunEvent(
				runLogger,
				"context.outbound_request_built",
				{
					turnKind,
					rawTranscript: summarizeMessages(outboundTranscript),
					outbound: summarizeMessages(outboundMessages),
					hasPrompt: "prompt" in outboundRequest,
					prompt:
						"prompt" in outboundRequest
							? {
									segmentIds: outboundRequest.prompt.segments.map(
										(segment) => segment.id,
									),
									totalTokens: outboundRequest.prompt.totalTokens,
									sectionTokens: outboundRequest.prompt.sectionTokens,
								}
							: undefined,
				},
				runLogContext,
			);
			await recordAgentRunEvent(
				runLogger,
				"llm.request_prepared",
				{
					modelId: config.modelId,
					toolCount: config.tools?.length ?? 0,
					toolNames: (config.tools ?? []).map((tool) => tool.name),
					inferenceConfig,
					outboundMessageCount: outboundMessages.length,
				},
				runLogContext,
			);
			const response = await turnTelemetry.invokeLLM(
				{ modelId: config.modelId, inferenceConfig },
				async () =>
					llm.chat(
						outboundMessages,
						config.tools ?? [],
						inferenceConfig,
						"prompt" in outboundRequest ? outboundRequest.prompt : undefined,
					),
			);
			await recordLoopSpan(config.hooks, "loop.llm.chat", {
				turnCount,
				finishReason: response.finishReason,
				inputTokens: response.usage.inputTokens,
				outputTokens: response.usage.outputTokens,
				...(response.usage.cache == null
					? {}
					: {
							cacheReadTokens: response.usage.cache.readTokens,
							cacheWriteTokens: response.usage.cache.writeTokens,
							cacheSource: response.usage.cache.source,
						}),
			});
			await recordAgentRunEvent(
				runLogger,
				"llm.response_received",
				{
					turnCount,
					finishReason: response.finishReason,
					usage: response.usage,
					content: summarizeMessage({
						role: "assistant",
						content: response.content,
						...(response.toolCalls == null
							? {}
							: { toolCalls: response.toolCalls }),
						...(response.thinking == null
							? {}
							: { reasoning: response.thinking }),
					}),
					toolCalls: response.toolCalls?.map(summarizeToolCall) ?? [],
				},
				runLogContext,
			);
			if (shouldLogDebug) {
				logger.debug(
					{
						finishReason: response.finishReason,
						inputTokens: response.usage.inputTokens,
						outputTokens: response.usage.outputTokens,
						totalTokens,
						maxTotalTokens,
					},
					"Agent loop: LLM responded",
				);
			}
			totalTokens += response.usage.inputTokens + response.usage.outputTokens;
			if (totalTokens > maxTotalTokens) {
				throw new AgentLoopError(
					`token budget exceeded: ${totalTokens} / ${maxTotalTokens}`,
				);
			}
			const storedThinking = sanitizeReasoningParts(response.thinking);
			if (response.finishReason !== "tool_calls") {
				const assistantMessage = createAssistantMessage({
					content: response.content,
					reasoning: storedThinking,
				});
				await config.hooks?.onAssistantMessage?.(assistantMessage);
				await recordAgentRunEvent(
					runLogger,
					"assistant.response_final",
					{
						turnCount,
						message: summarizeMessage(assistantMessage),
					},
					runLogContext,
				);
				await saveCheckpointState({
					checkpoint: config.checkpoint,
					messages: [...workingMessages, assistantMessage],
					turnCount,
					state: config.state,
					phase: "assistant_response",
					recordSpan: config.hooks?.recordSpan,
				});
				await config.hooks?.onMessagesUpdated?.(
					[...workingMessages, assistantMessage],
					{
						phase: "assistant_response",
						turnCount,
					},
				);
				await recordAgentRunEvent(
					runLogger,
					"checkpoint.saved",
					{
						phase: "assistant_response",
						turnCount,
						messageCount: workingMessages.length + 1,
					},
					runLogContext,
				);
				loopSucceeded = true;
				await recordAgentRunEvent(
					runLogger,
					"turn.completed",
					{
						turnCount,
						totalTokens,
						messageCount: workingMessages.length + 1,
					},
					runLogContext,
				);
				return response.content;
			}
			if (response.toolCalls == null || response.toolCalls.length === 0) {
				throw new Error(
					"LLM returned finishReason=tool_calls without toolCalls",
				);
			}
			const assistantToolCallMessage = createAssistantMessage({
				content: response.content,
				toolCalls: response.toolCalls,
				reasoning: storedThinking,
			});
			await config.hooks?.onAssistantMessage?.(assistantToolCallMessage);
			workingMessages.push(assistantToolCallMessage);
			await recordAgentRunEvent(
				runLogger,
				"planning.tool_calls_selected",
				{
					turnCount,
					toolCalls: response.toolCalls.map(summarizeToolCall),
					assistantMessage: summarizeMessage(assistantToolCallMessage),
				},
				runLogContext,
			);
			await config.hooks?.onMessagesUpdated?.([...workingMessages], {
				phase: "assistant_tool_calls",
				turnCount,
			});
			await saveCheckpointState({
				checkpoint: config.checkpoint,
				messages: workingMessages,
				turnCount,
				state: config.state,
				phase: "assistant_tool_calls",
				recordSpan: config.hooks?.recordSpan,
			});
			await recordAgentRunEvent(
				runLogger,
				"checkpoint.saved",
				{
					phase: "assistant_tool_calls",
					turnCount,
					messageCount: workingMessages.length,
				},
				runLogContext,
			);
			consecutiveBlockedToolOutputs = await executeToolCalls({
				router,
				toolCalls: response.toolCalls,
				turnCount,
				workingMessages,
				checkpoint: config.checkpoint,
				state: config.state,
				hooks: config.hooks,
				telemetry: turnTelemetry,
				runLogger,
				turnId: turnTelemetry.turnId,
				consecutiveBlockedToolOutputs,
			});
			turnKind = "tool-resume";
		}
	} catch (error) {
		await recordAgentRunEvent(
			runLogger,
			"turn.failed",
			{
				error,
				turnCount,
				totalTokens,
				messageCount: workingMessages.length,
			},
			runLogContext,
		);
		throw error;
	} finally {
		turnTelemetry.end(loopSucceeded);
		telemetry.endSession({ turnCount, totalTokens, success: loopSucceeded });
	}
}
