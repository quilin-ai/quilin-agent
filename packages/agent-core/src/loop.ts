import {
	createSystemContextSource,
	DEFAULT_CONTEXT_BUDGET,
} from "./context/manager.js";
import {
	stripReasoningFromMessages,
	sanitizeReasoningParts,
} from "./context/reasoning-sanitizer.js";
import { getLoggerRuntimeMode, logger } from "./logger.js";
import {
	AgentLoopError,
	DEFAULT_MAX_TOTAL_TOKENS,
	DEFAULT_MAX_TURNS,
	type AgentLoopConfig,
	type LoopHooks,
} from "./loop-types.js";
import { executeToolCalls } from "./loop-tool-calls.js";
import { saveCheckpointState } from "./state/checkpoint-writer.js";
import type { Message } from "./state/types.js";
import { ToolRouter } from "./tools/router.js";

async function recordLoopSpan(
	hooks: LoopHooks | undefined,
	name: string,
	attributes?: Record<string, unknown>,
): Promise<void> {
	await hooks?.recordSpan?.(name, attributes);
}

function createAssistantMessage(
	response: Pick<Message, "content"> & {
		readonly toolCalls?: Message["toolCalls"];
		readonly reasoning?: Message["reasoning"];
	},
): Message {
	return {
		role: "assistant",
		content: response.content,
		...(response.toolCalls == null ? {} : { toolCalls: response.toolCalls }),
		...(response.reasoning == null ? {} : { reasoning: response.reasoning }),
	};
}

// Quilin Agent 核心循环：保持 loop file 小而稳，具体副作用委托给 helper 模块。
export async function runAgentLoop(
	config: AgentLoopConfig,
	messages: readonly Message[],
): Promise<string> {
	const { llm, inferenceConfig } = config;
	const shouldLogDebug = getLoggerRuntimeMode() !== "repl";
	const router = new ToolRouter(config.tools ?? []);
	const workingMessages: Message[] = [...messages];
	const baseSystemPrompt =
		messages[0]?.role === "system" ? messages[0].content : null;
	if (config.context != null && baseSystemPrompt == null) {
		logger.warn(
			"ContextManager provided but no system message found — skipping context rebuild",
		);
	}
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxTotalTokens = config.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
	let turnCount = config.state?.turnCount ?? 0;
	let totalTokens = 0;
	let turnKind: "user-turn" | "tool-resume" = "user-turn";
	// This counter spans turns and only resets after any non-blocked tool result.
	let consecutiveBlockedToolOutputs = 0;

	while (true) {
		if (
			config.context != null &&
			baseSystemPrompt != null &&
			config.sessionAssembler == null
		) {
			const systemPrompt = await config.context.buildContext(
				[createSystemContextSource(baseSystemPrompt)],
				DEFAULT_CONTEXT_BUDGET,
			);

			workingMessages[0] = { role: "system", content: systemPrompt };
		}

		if (turnCount >= maxTurns) {
			throw new AgentLoopError(`Agent loop exceeded maxTurns=${maxTurns}`);
		}

		turnCount += 1;
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

		if (shouldLogDebug) {
			logger.debug(
				{ turnMessages: workingMessages.length, turnCount, maxTurns },
				"Agent loop: calling LLM",
			);
		}

		const outboundTranscript = stripReasoningFromMessages(workingMessages);
		const outboundRequest =
			config.sessionAssembler == null
				? { messages: outboundTranscript }
				: config.sessionAssembler.buildOutboundRequest({
						transcript: outboundTranscript,
						turnKind,
						lastMessageTime:
							turnKind === "user-turn" ? config.lastMessageTime : undefined,
					});
		const outboundMessages = stripReasoningFromMessages(
			outboundRequest.messages,
		);

			const response = await llm.chat(
				outboundMessages,
				config.tools ?? [],
				inferenceConfig,
				"prompt" in outboundRequest ? outboundRequest.prompt : undefined,
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
			await saveCheckpointState({
				checkpoint: config.checkpoint,
				messages: [...workingMessages, assistantMessage],
				turnCount,
				state: config.state,
				phase: "assistant_response",
				recordSpan: config.hooks?.recordSpan,
			});

			return response.content;
		}

		if (response.toolCalls == null || response.toolCalls.length === 0) {
			throw new Error("LLM returned finishReason=tool_calls without toolCalls");
		}

		const assistantToolCallMessage = createAssistantMessage({
			content: response.content,
			toolCalls: response.toolCalls,
			reasoning: storedThinking,
		});
		await config.hooks?.onAssistantMessage?.(assistantToolCallMessage);
		workingMessages.push(assistantToolCallMessage);
		await saveCheckpointState({
			checkpoint: config.checkpoint,
			messages: workingMessages,
			turnCount,
			state: config.state,
			phase: "assistant_tool_calls",
			recordSpan: config.hooks?.recordSpan,
		});

		consecutiveBlockedToolOutputs = await executeToolCalls({
			router,
			toolCalls: response.toolCalls,
			turnCount,
			workingMessages,
			checkpoint: config.checkpoint,
			state: config.state,
			hooks: config.hooks,
			consecutiveBlockedToolOutputs,
		});
		turnKind = "tool-resume";
	}
}
