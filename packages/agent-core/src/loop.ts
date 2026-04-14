import type { ContextManager } from "./context/types.js";
import type { InferenceConfig, LLMClient } from "./llm/types.js";
import type { AgentState, Checkpoint } from "./state/types.js";
import type { Tool } from "./tools/types.js";

/**
 * Quilin Agent 核心循环
 *
 * 目标: < 200 行，极简 while-loop
 * 参考: Claude Code ~88 行, Codex async queue, OpenClaw Pi agent
 *
 * 数据流:
 *   用户输入 → ContextManager.buildContext()
 *            → LLMClient.chat()
 *            → if tool_calls → ToolRouter.execute() → 结果追加 messages
 *            → if assistant   → 检查是否终止
 *            → Checkpoint.save()
 *            → loop
 */
export async function runAgentLoop(
	config: AgentLoopConfig,
): Promise<AgentState> {
	void config;
	throw new Error("Not implemented");
}

export interface AgentLoopConfig {
	readonly llm: LLMClient;
	readonly context: ContextManager;
	readonly tools: readonly Tool[];
	readonly checkpoint: Checkpoint;
	readonly maxTurns: number;
	readonly inferenceConfig: InferenceConfig;
}
