import type { AssistantContent, JSONValue, ModelMessage } from "ai";
import type {
	AssembledPrompt,
	RecommendedBreakpoint,
} from "../context/prompt-types.js";
import { redactString } from "../safety/redaction.js";
import type { Message } from "../state/types.js";
import type { ThinkingMode } from "./types.js";

export type CacheAwareProvider =
	| "anthropic"
	| "deepseek"
	| "openai"
	| "gemini"
	| "xai"
	| "unknown";

export interface CacheAdapterInput {
	readonly messages: readonly Message[];
	readonly prompt?: AssembledPrompt;
	readonly provider?: string;
	readonly thinkingMode?: ThinkingMode;
}

export interface CacheAdapterOutput {
	readonly messages: ModelMessage[];
	readonly appliedBreakpoints: readonly RecommendedBreakpoint[];
}

const ANTHROPIC_CACHE_CONTROL = {
	anthropic: {
		cacheControl: { type: "ephemeral" as const },
	},
};

const MAX_ANTHROPIC_BREAKPOINTS = 4;
type AssistantContentPart = Exclude<AssistantContent, string>[number];
type AssistantReasoningContentPart = Extract<
	AssistantContentPart,
	{ type: "reasoning" }
>;

function parseToolOutput(content: string) {
	try {
		return {
			type: "json" as const,
			value: JSON.parse(content) as JSONValue,
		};
	} catch {
		return {
			type: "text" as const,
			value: content,
		};
	}
}

// DeepSeek V4 thinking mode rejects requests whose assistant turns carry an
// empty reasoning_content. When a turn captured no reasoning (model went
// straight to tool calls, or stream omitted reasoning chunks), we still have
// to send a non-empty placeholder so the API replays the conversation.
const DEEPSEEK_REASONING_PLACEHOLDER = "(no reasoning captured)";

function getDeepSeekReasoningParts(
	message: Message,
): AssistantReasoningContentPart[] {
	const parts: AssistantReasoningContentPart[] = [];
	for (const part of message.reasoning ?? []) {
		if (part.provider === "deepseek" && part.text.length > 0) {
			const redactedText = redactString(part.text);
			if (redactedText.length > 0) {
				parts.push({ type: "reasoning", text: redactedText });
			}
		}
	}

	if (parts.length === 0) {
		parts.push({
			type: "reasoning",
			text: DEEPSEEK_REASONING_PLACEHOLDER,
		});
	}

	return parts;
}

function shouldSerializeDeepSeekReasoning(
	provider: string | undefined,
	thinkingMode: ThinkingMode | undefined,
	message: Message,
): boolean {
	return (
		normalizeProvider(provider) === "deepseek" &&
		thinkingMode !== "disabled" &&
		message.role === "assistant"
	);
}

function toSdkMessage(
	message: Message,
	provider: string | undefined,
	thinkingMode: ThinkingMode | undefined,
): ModelMessage[] {
	switch (message.role) {
		case "system":
			return [{ role: "system", content: message.content }];

		case "user":
			return [{ role: "user", content: message.content }];

		case "assistant": {
			const hasToolCalls =
				message.toolCalls != null && message.toolCalls.length > 0;
			const serializeReasoning = shouldSerializeDeepSeekReasoning(
				provider,
				thinkingMode,
				message,
			);

			if (!hasToolCalls && !serializeReasoning) {
				return [{ role: "assistant", content: message.content }];
			}

			const content: AssistantContent = [
				...(serializeReasoning ? getDeepSeekReasoningParts(message) : []),
				...(message.content === ""
					? []
					: [{ type: "text" as const, text: message.content }]),
				...(message.toolCalls ?? []).map((toolCall) => ({
					type: "tool-call" as const,
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: toolCall.arguments,
				})),
			];

			return [
				{
					role: "assistant",
					content,
				} satisfies ModelMessage,
			];
		}

		case "tool": {
			if (message.toolCallId == null || message.name == null) {
				return [];
			}

			return [
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: message.toolCallId,
							toolName: message.name,
							output: parseToolOutput(message.content),
						},
					],
				} satisfies ModelMessage,
			];
		}

		default:
			return [];
	}
}

function serializeMessages(
	messages: readonly Message[],
	provider: string | undefined,
	thinkingMode: ThinkingMode | undefined,
): ModelMessage[] {
	return messages.flatMap((message) =>
		toSdkMessage(message, provider, thinkingMode),
	);
}

function toAnthropicSystemMessage(
	content: string,
	includeCacheControl: boolean,
): ModelMessage {
	return {
		role: "system",
		content,
		...(includeCacheControl
			? { providerOptions: ANTHROPIC_CACHE_CONTROL }
			: {}),
	};
}

function normalizeProvider(provider: string | undefined): CacheAwareProvider {
	const normalized = provider?.split(".")[0]?.toLowerCase();

	switch (normalized) {
		case "anthropic":
			return "anthropic";
		case "deepseek":
			return "deepseek";
		case "openai":
			return "openai";
		case "google":
		case "gemini":
			return "gemini";
		case "xai":
			return "xai";
		default:
			return "unknown";
	}
}

function adaptAnthropicMessages(
	messages: readonly Message[],
	prompt: AssembledPrompt | undefined,
	thinkingMode: ThinkingMode | undefined,
): CacheAdapterOutput {
	if (prompt == null || prompt.segments.length === 0) {
		return {
			messages: serializeMessages(messages, "anthropic", thinkingMode),
			appliedBreakpoints: [],
		};
	}

	const breakpointIndexes = new Set(
		prompt.recommendedBreakpoints
			.slice(0, MAX_ANTHROPIC_BREAKPOINTS)
			.map((breakpoint) => breakpoint.segmentIndex),
	);

	const systemMessages = prompt.segments.flatMap((segment, index) =>
		segment.role !== "system"
			? []
			: [toAnthropicSystemMessage(segment.text, breakpointIndexes.has(index))],
	);

	const transcript =
		messages[0]?.role === "system" ? messages.slice(1) : messages;
	const appliedBreakpoints = prompt.recommendedBreakpoints.filter(
		(breakpoint) =>
			breakpointIndexes.has(breakpoint.segmentIndex) &&
			prompt.segments[breakpoint.segmentIndex]?.role === "system",
	);

	return {
		messages: [
			...systemMessages,
			...serializeMessages(transcript, "anthropic", thinkingMode),
		],
		appliedBreakpoints,
	};
}

export function adaptMessagesForModel(
	input: CacheAdapterInput,
): CacheAdapterOutput {
	switch (normalizeProvider(input.provider)) {
		case "anthropic":
			return adaptAnthropicMessages(
				input.messages,
				input.prompt,
				input.thinkingMode,
			);
		case "deepseek":
		case "openai":
		case "gemini":
		case "xai":
		case "unknown":
			return {
				messages: serializeMessages(
					input.messages,
					input.provider,
					input.thinkingMode,
				),
				appliedBreakpoints: [],
			};
	}
}
