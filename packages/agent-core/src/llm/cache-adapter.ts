import type { ModelMessage } from "ai";
import type {
	AssembledPrompt,
	RecommendedBreakpoint,
} from "../context/prompt-types.js";
import type { Message } from "../state/types.js";

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

function parseToolOutput(content: string) {
	try {
		return {
			type: "json" as const,
			value: JSON.parse(content) as unknown,
		};
	} catch {
		return {
			type: "text" as const,
			value: content,
		};
	}
}

function toSdkMessage(
	message: Message,
	providerOptions?: Record<string, unknown>,
): ModelMessage[] {
	switch (message.role) {
		case "system":
		case "user":
			return [
				{
					role: message.role,
					content: message.content,
					...(providerOptions == null ? {} : { providerOptions }),
				} satisfies ModelMessage,
			];

		case "assistant": {
			if (message.toolCalls == null || message.toolCalls.length === 0) {
				return [
					{
						role: "assistant",
						content: message.content,
						...(providerOptions == null ? {} : { providerOptions }),
					} satisfies ModelMessage,
				];
			}

			const content = [
				...(message.content === ""
					? []
					: [{ type: "text" as const, text: message.content }]),
				...message.toolCalls.map((toolCall) => ({
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
					...(providerOptions == null ? {} : { providerOptions }),
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
					...(providerOptions == null ? {} : { providerOptions }),
				} satisfies ModelMessage,
			];
		}

		default:
			return [];
	}
}

function serializeMessages(messages: readonly Message[]): ModelMessage[] {
	return messages.flatMap((message) => toSdkMessage(message));
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
): CacheAdapterOutput {
	if (prompt == null || prompt.segments.length === 0) {
		return {
			messages: serializeMessages(messages),
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
			: toSdkMessage(
					{ role: "system", content: segment.text },
					breakpointIndexes.has(index) ? ANTHROPIC_CACHE_CONTROL : undefined,
				),
	);

	const transcript =
		messages[0]?.role === "system" ? messages.slice(1) : messages;
	const appliedBreakpoints = prompt.recommendedBreakpoints.filter(
		(breakpoint) =>
			breakpointIndexes.has(breakpoint.segmentIndex) &&
			prompt.segments[breakpoint.segmentIndex]?.role === "system",
	);

	return {
		messages: [...systemMessages, ...serializeMessages(transcript)],
		appliedBreakpoints,
	};
}

export function adaptMessagesForModel(
	input: CacheAdapterInput,
): CacheAdapterOutput {
	switch (normalizeProvider(input.provider)) {
		case "anthropic":
			return adaptAnthropicMessages(input.messages, input.prompt);
		case "deepseek":
		case "openai":
		case "gemini":
		case "xai":
		case "unknown":
			return {
				messages: serializeMessages(input.messages),
				appliedBreakpoints: [],
			};
	}
}
