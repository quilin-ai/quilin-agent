import {
	scanExternalContext,
	shouldTrustToolOutput,
} from "./context/injection-scanner.js";
import { logger } from "./logger.js";
import { AgentLoopError, type LoopHooks } from "./loop-types.js";
import type { AgentTurnTelemetry } from "./observability/loop.js";
import { saveCheckpointState } from "./state/checkpoint-writer.js";
import type { AgentState, Checkpoint, Message } from "./state/types.js";
import type { ToolRouter } from "./tools/router.js";
import type { ToolCall } from "./tools/types.js";

export interface ExecuteToolCallsOptions {
	readonly router: ToolRouter;
	readonly toolCalls: readonly ToolCall[];
	readonly turnCount: number;
	readonly workingMessages: Message[];
	readonly checkpoint?: Checkpoint;
	readonly state?: AgentState;
	readonly hooks?: LoopHooks;
	readonly telemetry?: AgentTurnTelemetry;
	readonly consecutiveBlockedToolOutputs: number;
}

export async function executeToolCalls(
	options: ExecuteToolCallsOptions,
): Promise<number> {
	let consecutiveBlockedToolOutputs = options.consecutiveBlockedToolOutputs;

	for (const toolCall of options.toolCalls) {
		const toolResult =
			options.telemetry == null
				? await options.router.execute(toolCall)
				: await options.telemetry.invokeTool(toolCall, () =>
						options.router.execute(toolCall),
					);
		await options.hooks?.recordSpan?.("loop.tool.execute", {
			turnCount: options.turnCount,
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

		options.workingMessages.push({
			role: "tool",
			toolCallId: toolResult.toolCallId,
			name: toolCall.name,
			content: scanResult.sanitizedContent,
		});
		await saveCheckpointState({
			checkpoint: options.checkpoint,
			messages: options.workingMessages,
			turnCount: options.turnCount,
			state: options.state,
			phase: "tool_result",
			recordSpan: options.hooks?.recordSpan,
		});

		if (consecutiveBlockedToolOutputs >= 3) {
			throw new AgentLoopError(
				"Agent loop aborted after 3 consecutive blocked tool outputs",
			);
		}
	}

	return consecutiveBlockedToolOutputs;
}
