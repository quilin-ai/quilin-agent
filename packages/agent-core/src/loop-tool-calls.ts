import {
	scanExternalContext,
	shouldTrustToolOutput,
	type ThreatMatch,
} from "./context/injection-scanner.js";
import { logger } from "./logger.js";
import { AgentLoopError, type LoopHooks } from "./loop-types.js";
import {
	type AgentRunLogSink,
	recordAgentRunEvent,
	summarizeToolCall,
	summarizeToolResult,
} from "./observability/agent-run-log.js";
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
	readonly runLogger?: AgentRunLogSink;
	readonly turnId?: string;
	readonly consecutiveBlockedToolOutputs: number;
}

interface IdentityAssignment {
	readonly assistantName: string;
	readonly userName: string;
}

interface IdentityGuardResult {
	readonly toolCall: ToolCall;
	readonly rewritten: boolean;
	readonly assignment?: IdentityAssignment;
}

interface LegacyMemoryTierNormalizationResult {
	readonly toolCall: ToolCall;
	readonly rewritten: boolean;
	readonly legacyTier?: string;
	readonly canonicalTier?: "working" | "semantic";
}

export interface IdentityMemoryCorrectionSummary {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly assistantNameChars: number;
	readonly userNameChars: number;
}

export interface LegacyMemoryTierCorrectionSummary {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly legacyTier: string;
	readonly canonicalTier: "working" | "semantic";
}

export interface CorrectIdentityMemoryToolCallsResult {
	readonly toolCalls: readonly ToolCall[];
	readonly corrections: readonly IdentityMemoryCorrectionSummary[];
}

export interface NormalizeLegacyMemoryTierToolCallsResult {
	readonly toolCalls: readonly ToolCall[];
	readonly corrections: readonly LegacyMemoryTierCorrectionSummary[];
}

const LEGACY_MEMORY_TIER_ALIASES: Readonly<
	Record<string, "working" | "semantic">
> = {
	short: "working",
	long: "semantic",
};

function shortToolName(name: string): string {
	const slashIndex = name.lastIndexOf("/");
	return slashIndex === -1 ? name : name.slice(slashIndex + 1);
}

function sanitizeIdentityName(value: string): string {
	return value
		.trim()
		.replace(/^[\s"'“”‘’「」《》]+|[\s"'“”‘’「」《》]+$/gu, "")
		.trim();
}

function extractIdentityAssignment(content: string): IdentityAssignment | null {
	const assistantThenUser =
		/[你妳]\s*(?:叫|是)\s*([^，,。！？!；;：:\n\r]{1,32})\s*[，,。！？!；;、\s]+我\s*(?:叫|是)\s*([^，,。！？!；;：:\n\r]{1,32})/u.exec(
			content,
		);
	const userThenAssistant =
		/我\s*(?:叫|是)\s*([^，,。！？!；;：:\n\r]{1,32})\s*[，,。！？!；;、\s]+[你妳]\s*(?:叫|是)\s*([^，,。！？!；;：:\n\r]{1,32})/u.exec(
			content,
		);
	const assistantName =
		assistantThenUser?.[1] == null
			? userThenAssistant?.[2]
			: assistantThenUser[1];
	const userName =
		assistantThenUser?.[2] == null
			? userThenAssistant?.[1]
			: assistantThenUser[2];

	if (assistantName == null || userName == null) {
		return null;
	}

	const normalizedAssistantName = sanitizeIdentityName(assistantName);
	const normalizedUserName = sanitizeIdentityName(userName);
	if (normalizedAssistantName.length === 0 || normalizedUserName.length === 0) {
		return null;
	}

	return {
		assistantName: normalizedAssistantName,
		userName: normalizedUserName,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attributesAssistantNameToUser(
	content: string,
	assistantName: string,
): boolean {
	const escapedName = escapeRegExp(assistantName);
	return [
		new RegExp(
			`用户(?:的)?(?:名字|姓名|名称|称呼)?\\s*(?:叫|是|为|:|：)\\s*${escapedName}`,
			"u",
		),
		new RegExp(
			`${escapedName}\\s*(?:是|为)\\s*用户(?:的)?(?:名字|姓名|名称|称呼)?`,
			"u",
		),
	].some((pattern) => pattern.test(content));
}

function latestUserContent(messages: readonly Message[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") {
			return message.content;
		}
	}

	return null;
}

function correctInvertedIdentityMemoryCall(
	toolCall: ToolCall,
	messages: readonly Message[],
): IdentityGuardResult {
	if (shortToolName(toolCall.name) !== "memory_store") {
		return { toolCall, rewritten: false };
	}

	const content = toolCall.arguments.content;
	if (typeof content !== "string") {
		return { toolCall, rewritten: false };
	}

	const userContent = latestUserContent(messages);
	if (userContent == null) {
		return { toolCall, rewritten: false };
	}

	const assignment = extractIdentityAssignment(userContent);
	if (
		assignment == null ||
		!attributesAssistantNameToUser(content, assignment.assistantName)
	) {
		return { toolCall, rewritten: false };
	}

	return {
		toolCall: {
			...toolCall,
			arguments: {
				...toolCall.arguments,
				content: `助手身份：用户指定 Quilin Agent 为${assignment.assistantName}。用户称呼偏好：用户希望被称呼为${assignment.userName}。`,
			},
		},
		rewritten: true,
		assignment,
	};
}

function normalizeLegacyMemoryTierCall(
	toolCall: ToolCall,
): LegacyMemoryTierNormalizationResult {
	if (shortToolName(toolCall.name) !== "memory_store") {
		return { toolCall, rewritten: false };
	}

	const tier = toolCall.arguments.tier;
	if (typeof tier !== "string") {
		return { toolCall, rewritten: false };
	}

	const canonicalTier = LEGACY_MEMORY_TIER_ALIASES[tier];
	if (canonicalTier == null) {
		return { toolCall, rewritten: false };
	}

	return {
		toolCall: {
			...toolCall,
			arguments: {
				...toolCall.arguments,
				tier: canonicalTier,
			},
		},
		rewritten: true,
		legacyTier: tier,
		canonicalTier,
	};
}

function replaceAssistantToolCall(
	messages: Message[],
	updatedToolCall: ToolCall,
): void {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || message.toolCalls == null) {
			continue;
		}

		if (
			!message.toolCalls.some((toolCall) => toolCall.id === updatedToolCall.id)
		) {
			continue;
		}

		messages[index] = {
			...message,
			toolCalls: message.toolCalls.map((toolCall) =>
				toolCall.id === updatedToolCall.id ? updatedToolCall : toolCall,
			),
		};
		return;
	}
}

function summarizeIdentityCorrection(
	toolCall: ToolCall,
	assignment: IdentityAssignment,
): IdentityMemoryCorrectionSummary {
	return {
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		assistantNameChars: assignment.assistantName.length,
		userNameChars: assignment.userName.length,
	};
}

export function correctInvertedIdentityMemoryToolCalls(
	toolCalls: readonly ToolCall[],
	messages: readonly Message[],
): CorrectIdentityMemoryToolCallsResult {
	const corrections: IdentityMemoryCorrectionSummary[] = [];
	let changed = false;
	const correctedToolCalls = toolCalls.map((toolCall) => {
		const identityGuard = correctInvertedIdentityMemoryCall(toolCall, messages);
		if (!identityGuard.rewritten || identityGuard.assignment == null) {
			return toolCall;
		}

		changed = true;
		corrections.push(
			summarizeIdentityCorrection(
				identityGuard.toolCall,
				identityGuard.assignment,
			),
		);
		return identityGuard.toolCall;
	});

	return {
		toolCalls: changed ? correctedToolCalls : toolCalls,
		corrections,
	};
}

export function normalizeLegacyMemoryTierToolCalls(
	toolCalls: readonly ToolCall[],
): NormalizeLegacyMemoryTierToolCallsResult {
	const corrections: LegacyMemoryTierCorrectionSummary[] = [];
	let changed = false;
	const normalizedToolCalls = toolCalls.map((toolCall) => {
		const tierNormalization = normalizeLegacyMemoryTierCall(toolCall);
		if (
			!tierNormalization.rewritten ||
			tierNormalization.legacyTier == null ||
			tierNormalization.canonicalTier == null
		) {
			return toolCall;
		}

		changed = true;
		corrections.push({
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			legacyTier: tierNormalization.legacyTier,
			canonicalTier: tierNormalization.canonicalTier,
		});
		return tierNormalization.toolCall;
	});

	return {
		toolCalls: changed ? normalizedToolCalls : toolCalls,
		corrections,
	};
}

function summarizeThreat(threat: ThreatMatch): Record<string, unknown> {
	return {
		pattern: threat.pattern,
		severity: threat.severity,
		location: threat.location,
		matchedChars: threat.matchedText.length,
	};
}

export async function executeToolCalls(
	options: ExecuteToolCallsOptions,
): Promise<number> {
	let consecutiveBlockedToolOutputs = options.consecutiveBlockedToolOutputs;
	const tierNormalization = normalizeLegacyMemoryTierToolCalls(
		options.toolCalls,
	);
	for (const correction of tierNormalization.corrections) {
		const toolCall = tierNormalization.toolCalls.find(
			(candidate) => candidate.id === correction.toolCallId,
		);
		if (toolCall != null) {
			replaceAssistantToolCall(options.workingMessages, toolCall);
		}
		await recordAgentRunEvent(
			options.runLogger,
			"tool.memory_tier_alias_normalized",
			{ ...correction },
			{ turnId: options.turnId },
		);
	}
	const identityGuard = correctInvertedIdentityMemoryToolCalls(
		tierNormalization.toolCalls,
		options.workingMessages,
	);
	for (const correction of identityGuard.corrections) {
		const toolCall = identityGuard.toolCalls.find(
			(candidate) => candidate.id === correction.toolCallId,
		);
		if (toolCall != null) {
			replaceAssistantToolCall(options.workingMessages, toolCall);
		}
		await recordAgentRunEvent(
			options.runLogger,
			"tool.memory_identity_corrected",
			{ ...correction },
			{ turnId: options.turnId },
		);
	}

	for (const toolCall of identityGuard.toolCalls) {
		await recordAgentRunEvent(
			options.runLogger,
			"tool.call_started",
			{
				toolCall: summarizeToolCall(toolCall),
				turnCount: options.turnCount,
			},
			{ turnId: options.turnId },
		);
		const actionVerification = verifyAction(toolCall);
		await recordAgentRunEvent(
			options.runLogger,
			"tool.safety_action_verified",
			{
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				decision: actionVerification.decision,
				code: actionVerification.code,
				reason: actionVerification.reason,
			},
			{ turnId: options.turnId },
		);
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
		await recordAgentRunEvent(
			options.runLogger,
			"tool.call_completed",
			{
				toolCall: summarizeToolCall(toolCall),
				toolResult: summarizeToolResult(toolResult),
			},
			{ turnId: options.turnId },
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
				{
					toolName: toolCall.name,
					threats: scanResult.threats.map(summarizeThreat),
				},
				"Tool output scan detected threats",
			);
		}
		await recordAgentRunEvent(
			options.runLogger,
			"tool.output_scanned",
			{
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				safe: scanResult.safe,
				threats: scanResult.threats.map(summarizeThreat),
			},
			{ turnId: options.turnId },
		);

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
		await recordAgentRunEvent(
			options.runLogger,
			"tool.result_appended",
			{
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				messageCount: options.workingMessages.length,
				trustedToolOutput,
				hasBlockedThreat,
				toolResult: summarizeToolResult(toolResult, sanitizedRedactedContent),
			},
			{ turnId: options.turnId },
		);
		await options.hooks?.onToolResult?.({
			toolCall,
			toolResult,
			actionVerification,
			scanResult,
			sanitizedContent: sanitizedRedactedContent,
			trustedToolOutput,
			hasBlockedThreat,
		});
		await options.hooks?.onMessagesUpdated?.([...options.workingMessages], {
			phase: "tool_result",
			turnCount: options.turnCount,
		});
		await saveCheckpointState({
			checkpoint: options.checkpoint,
			messages: options.workingMessages,
			turnCount: options.turnCount,
			state: options.state,
			phase: "tool_result",
			recordSpan: options.hooks?.recordSpan,
		});
		await recordAgentRunEvent(
			options.runLogger,
			"checkpoint.saved",
			{
				phase: "tool_result",
				turnCount: options.turnCount,
				messageCount: options.workingMessages.length,
			},
			{ turnId: options.turnId },
		);

		if (consecutiveBlockedToolOutputs >= 3) {
			throw new AgentLoopError(
				"Agent loop aborted after 3 consecutive blocked tool outputs",
			);
		}
	}

	return consecutiveBlockedToolOutputs;
}
