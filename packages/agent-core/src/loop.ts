import type { ContextManager } from "./context/types.js";
import type { InferenceConfig, LLMClient } from "./llm/types.js";
import { getLoggerRuntimeMode, logger } from "./logger.js";
import type { Checkpoint, Message } from "./state/types.js";
import type { Tool } from "./tools/types.js";

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
 *   - 无 ContextManager（直接传 messages）
 *   - 无 ToolRouter（无工具）
 *   - 无 Checkpoint（不持久化）
 *   - 纯文本对话，不处理 tool_calls
 */
export async function runAgentLoop(
	config: AgentLoopConfig,
	messages: readonly Message[],
): Promise<string> {
	const { llm, inferenceConfig } = config;
	const shouldLogDebug = getLoggerRuntimeMode() !== "repl";

	if (shouldLogDebug) {
		logger.debug({ turnMessages: messages.length }, "Agent loop: calling LLM");
	}

	const response = await llm.chat(
		messages,
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

	return response.content;
}

export interface AgentLoopConfig {
	readonly llm: LLMClient;
	readonly context?: ContextManager;
	readonly tools?: readonly Tool[];
	readonly checkpoint?: Checkpoint;
	readonly maxTurns?: number;
	readonly inferenceConfig: InferenceConfig;
}
