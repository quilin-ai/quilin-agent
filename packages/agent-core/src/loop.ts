import {
	createSystemContextSource,
	DEFAULT_CONTEXT_BUDGET,
} from "./context/manager.js";
import { scanExternalContext } from "./context/injection-scanner.js";
import type { ContextManager } from "./context/types.js";
import type { InferenceConfig, LLMClient } from "./llm/types.js";
import { getLoggerRuntimeMode, logger } from "./logger.js";
import type { AgentState, Checkpoint, Message } from "./state/types.js";
import { ToolRouter } from "./tools/router.js";
import type { Tool } from "./tools/types.js";

function buildCheckpointState(
	messages: readonly Message[],
	responseContent: string,
	state?: AgentState,
): AgentState {
	const now = new Date().toISOString();

	return {
		messages: [...messages, { role: "assistant", content: responseContent }],
		isTerminal: false,
		turnCount: (state?.turnCount ?? 0) + 1,
		createdAt: state?.createdAt ?? now,
		lastActiveAt: now,
	};
}

/**
 * Quilin Agent 核心循环
 *
 * 目标: < 200 行，极简 while-loop
 * 参考: Claude Code ~88 行, Codex async queue, OpenClaw Pi agent
 *
 * 数据流:
 *   用户输入 → LLMClient.chat()
 *            → if tool_calls → ToolRouter.execute() → 结果追加 messages
 *            → if assistant   → 返回文本
 *            → loop
 *
 * Phase 0 简化:
 *   - ContextManager 可选接入，仅重建 system prompt
 *   - 无 ToolRouter（无工具）
 *   - Checkpoint 可选接入，仅保存最终 assistant 回复后的状态
 *   - 纯文本对话，不处理 tool_calls
 */
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
	const maxTurns = config.maxTurns ?? Number.POSITIVE_INFINITY;
	let turnCount = 0;

	while (true) {
		if (config.context != null && baseSystemPrompt != null) {
			const systemPrompt = await config.context.buildContext(
				[createSystemContextSource(baseSystemPrompt)],
				DEFAULT_CONTEXT_BUDGET,
			);

			workingMessages[0] = { role: "system", content: systemPrompt };
		}

		if (turnCount >= maxTurns) {
			throw new Error(`Agent loop exceeded maxTurns=${maxTurns}`);
		}

		turnCount += 1;

		if (shouldLogDebug) {
			logger.debug(
				{ turnMessages: workingMessages.length, turnCount, maxTurns },
				"Agent loop: calling LLM",
			);
		}

		const response = await llm.chat(
			[...workingMessages],
			config.tools ?? [],
			inferenceConfig,
		);

		if (shouldLogDebug) {
			logger.debug(
				{
					finishReason: response.finishReason,
					inputTokens: response.usage.inputTokens,
					outputTokens: response.usage.outputTokens,
				},
				"Agent loop: LLM responded",
			);
		}

		if (response.finishReason !== "tool_calls") {
			if (config.checkpoint != null) {
				await config.checkpoint.save(
					buildCheckpointState(workingMessages, response.content, config.state),
				);
			}

			return response.content;
		}

		if (response.toolCalls == null || response.toolCalls.length === 0) {
			throw new Error("LLM returned finishReason=tool_calls without toolCalls");
		}

		if (turnCount >= maxTurns) {
			throw new Error(
				`Agent loop exceeded maxTurns=${maxTurns} while awaiting final response`,
			);
		}

		workingMessages.push({
			role: "assistant",
			content: response.content,
			toolCalls: response.toolCalls,
		});

		// TODO: 在明确工具副作用/顺序语义后，将独立 tool calls 改为并行执行。
		for (const toolCall of response.toolCalls) {
			const toolResult = await router.execute(toolCall);
			const scanResult = scanExternalContext(
				toolResult.content,
				`tool:${toolCall.name}`,
			);
			if (!scanResult.safe) {
				logger.warn(
					{ toolName: toolCall.name, threats: scanResult.threats },
					"Tool output scan detected threats",
				);
			}
			workingMessages.push({
				role: "tool",
				toolCallId: toolResult.toolCallId,
				name: toolCall.name,
				content: scanResult.sanitizedContent,
			});
		}
	}
}

export interface AgentLoopConfig {
	readonly llm: LLMClient;
	readonly context?: ContextManager;
	readonly tools?: readonly Tool[];
	readonly checkpoint?: Checkpoint;
	readonly state?: AgentState;
	readonly maxTurns?: number;
	readonly inferenceConfig: InferenceConfig;
}
