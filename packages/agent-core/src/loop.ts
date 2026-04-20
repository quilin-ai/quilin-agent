import { isAbsolute, relative, resolve } from "node:path";
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

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_MAX_TOTAL_TOKENS = 200_000;

export class AgentLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentLoopError";
	}
}

function buildCheckpointState(
	messages: readonly Message[],
	turnCount: number,
	state?: AgentState,
): AgentState {
	const now = new Date().toISOString();

	return {
		messages: [...messages],
		isTerminal: false,
		turnCount,
		createdAt: state?.createdAt ?? now,
		lastActiveAt: now,
	};
}

export interface LoopHooks {
	readonly recordSpan?: (
		name: string,
		attributes?: Record<string, unknown>,
	) => void | Promise<void>;
}

async function recordLoopSpan(
	hooks: LoopHooks | undefined,
	name: string,
	attributes?: Record<string, unknown>,
): Promise<void> {
	await hooks?.recordSpan?.(name, attributes);
}

async function saveCheckpointState(
	checkpoint: Checkpoint | undefined,
	hooks: LoopHooks | undefined,
	messages: readonly Message[],
	turnCount: number,
	state?: AgentState,
	phase?: string,
): Promise<void> {
	if (checkpoint == null) {
		return;
	}

	const checkpointState = buildCheckpointState(messages, turnCount, state);
	await checkpoint.save(checkpointState);
	await recordLoopSpan(hooks, "loop.checkpoint.save", {
		turnCount,
		phase,
		messageCount: checkpointState.messages.length,
	});
}

function isWithinWorkspace(filePath: string): boolean {
	const resolvedWorkspace = resolve(process.cwd());
	const resolvedPath = resolve(filePath);
	const relativePath = relative(resolvedWorkspace, resolvedPath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function shouldTrustToolOutput(
	toolName: string,
	toolArgs: Record<string, unknown>,
): boolean {
	return (
		toolName === "file_read" &&
		typeof toolArgs.path === "string" &&
		isWithinWorkspace(toolArgs.path)
	);
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
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxTotalTokens = config.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
	let turnCount = config.state?.turnCount ?? 0;
	let totalTokens = 0;
	// This counter spans turns and only resets after any non-blocked tool result.
	let consecutiveBlockedToolOutputs = 0;

	while (true) {
		if (config.context != null && baseSystemPrompt != null) {
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
		await saveCheckpointState(
			config.checkpoint,
			config.hooks,
			workingMessages,
			turnCount,
			config.state,
			"turn_start",
		);

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
		await recordLoopSpan(config.hooks, "loop.llm.chat", {
			turnCount,
			finishReason: response.finishReason,
			inputTokens: response.usage.inputTokens,
			outputTokens: response.usage.outputTokens,
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

		if (response.finishReason !== "tool_calls") {
			await saveCheckpointState(
				config.checkpoint,
				config.hooks,
				[...workingMessages, { role: "assistant", content: response.content }],
				turnCount,
				config.state,
				"assistant_response",
			);

			return response.content;
		}

		if (response.toolCalls == null || response.toolCalls.length === 0) {
			throw new Error("LLM returned finishReason=tool_calls without toolCalls");
		}

		workingMessages.push({
			role: "assistant",
			content: response.content,
			toolCalls: response.toolCalls,
		});
		await saveCheckpointState(
			config.checkpoint,
			config.hooks,
			workingMessages,
			turnCount,
			config.state,
			"assistant_tool_calls",
		);

		// TODO: 在明确工具副作用/顺序语义后，将独立 tool calls 改为并行执行。
		for (const toolCall of response.toolCalls) {
			const toolResult = await router.execute(toolCall);
			await recordLoopSpan(config.hooks, "loop.tool.execute", {
				turnCount,
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				isError: toolResult.isError,
			});
			const trustedToolOutput = shouldTrustToolOutput(
				toolCall.name,
				toolCall.arguments,
			);
			const scanResult = scanExternalContext(
				toolResult.content,
				`tool:${toolCall.name}`,
				{ trustedSource: trustedToolOutput },
			);
			if (!scanResult.safe) {
				logger.warn(
					{ toolName: toolCall.name, threats: scanResult.threats },
					"Tool output scan detected threats",
				);
			}

			const hasBlockedThreat = scanResult.threats.some(
				(threat) => threat.severity === "block",
			);
			consecutiveBlockedToolOutputs =
				hasBlockedThreat && !trustedToolOutput
					? consecutiveBlockedToolOutputs + 1
					: 0;

			workingMessages.push({
				role: "tool",
				toolCallId: toolResult.toolCallId,
				name: toolCall.name,
				content: scanResult.sanitizedContent,
			});
			await saveCheckpointState(
				config.checkpoint,
				config.hooks,
				workingMessages,
				turnCount,
				config.state,
				"tool_result",
			);

			if (consecutiveBlockedToolOutputs >= 3) {
				throw new AgentLoopError(
					"Agent loop aborted after 3 consecutive blocked tool outputs",
				);
			}
		}
	}
}

export interface AgentLoopConfig {
	readonly llm: LLMClient;
	readonly context?: ContextManager;
	readonly tools?: readonly Tool[];
	readonly checkpoint?: Checkpoint;
	readonly state?: AgentState;
	/** Defaults to 50 if omitted to prevent unbounded tool loops. */
	readonly maxTurns?: number;
	/** Defaults to 200_000 if omitted; counts inputTokens + outputTokens across the whole loop. */
	readonly maxTotalTokens?: number;
	readonly hooks?: LoopHooks;
	readonly inferenceConfig: InferenceConfig;
}
