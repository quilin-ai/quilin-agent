import {
	scanExternalContext,
	shouldTrustToolOutput,
} from "./context/injection-scanner.js";
import { logger } from "./logger.js";
import { AgentLoopError, type LoopHooks } from "./loop-types.js";
import type { AgentTurnTelemetry } from "./observability/loop.js";
import { verifyAction } from "./safety/action-verifier.js";
import { verifyMetaInvariant } from "./safety/meta-verifier.js";
import { redactToolOutput } from "./safety/redaction.js";
import { saveCheckpointState } from "./state/checkpoint-writer.js";
import type { AgentState, Checkpoint, Message } from "./state/types.js";
import type { ToolRouter } from "./tools/router.js";
import type { ToolCall, ToolResult } from "./tools/types.js";

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
		const actionVerification = verifyAction(toolCall);
		const toolResultProduced = actionVerification.decision === "allow";
		const toolResult: ToolResult =
			actionVerification.decision === "block"
				? {
						toolCallId: toolCall.id,
						isError: true,
						content: JSON.stringify({
							error: "Tool call blocked by safety verifier",
							code: actionVerification.code,
							reason: actionVerification.reason,
						}),
					}
				: options.telemetry == null
					? await options.router.execute(toolCall)
					: await options.telemetry.invokeTool(toolCall, () =>
							options.router.execute(toolCall),
						);

		if (actionVerification.decision === "block") {
			logger.warn(
				{
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					code: actionVerification.code,
				},
				"Tool call blocked by action verifier",
			);
		} else {
			await options.hooks?.recordSpan?.("loop.tool.execute", {
				turnCount: options.turnCount,
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				isError: toolResult.isError,
			});
		}

		const trustedToolOutputCandidate =
			actionVerification.decision === "allow" &&
			shouldTrustToolOutput(toolCall.name, toolCall.arguments);
		const scanResult = scanExternalContext(
			toolResult.content,
			`tool:${toolCall.name}`,
			{
				trustedSource: trustedToolOutputCandidate,
			},
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
		const trustedToolOutput = trustedToolOutputCandidate && !hasBlockedThreat;
		const sanitizedRedactedContent = redactToolOutput(
			scanResult.sanitizedContent,
		);
		const metaVerification = verifyMetaInvariant({
			action: actionVerification,
			toolResultProduced,
			sanitizedRedactedContent,
			layer1: {
				trustedToolOutput,
				hasBlockedThreat,
			},
		});
		if (!metaVerification.ok) {
			throw new AgentLoopError(
				`Layer 4 safety invariant failed: ${metaVerification.code}: ${metaVerification.reason}`,
			);
		}

		consecutiveBlockedToolOutputs =
			actionVerification.decision === "block" || hasBlockedThreat
				? consecutiveBlockedToolOutputs + 1
				: 0;

		options.workingMessages.push({
			role: "tool",
			toolCallId: toolResult.toolCallId,
			name: toolCall.name,
			content: sanitizedRedactedContent,
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
