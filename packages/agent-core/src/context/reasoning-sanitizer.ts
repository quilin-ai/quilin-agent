import type { ThinkingMode } from "../llm/types.js";
import { logger } from "../logger.js";
import { redactString } from "../safety/redaction.js";
import type { Message } from "../state/types.js";
import { scanExternalContext } from "./injection-scanner.js";

export interface ReasoningReplayOptions {
	readonly providerId?: string;
	readonly thinkingMode?: ThinkingMode;
}

function isDeepSeekProvider(providerId: string | undefined): boolean {
	return providerId?.toLowerCase().startsWith("deepseek") ?? false;
}

export function sanitizeReasoningParts(
	reasoning: Message["reasoning"],
): Message["reasoning"] {
	if (reasoning == null || reasoning.length === 0) {
		return reasoning;
	}

	return reasoning.map((part, partIndex) => {
		if (part.text == null || part.text.length === 0) {
			return part;
		}

		const source = `reasoning:${part.provider}`;
		const scanResult = scanExternalContext(part.text, source);
		if (!scanResult.safe) {
			logger.warn(
				{
					provider: part.provider,
					source,
					partIndex,
					threats: scanResult.threats,
				},
				"Reasoning scan detected threats",
			);
		}

		const redactedContent = redactString(scanResult.sanitizedContent);

		return redactedContent === part.text
			? part
			: { ...part, text: redactedContent };
	});
}

export function stripReasoningFromMessage(message: Message): Message {
	if (message.reasoning == null) {
		return message;
	}

	const { reasoning: _reasoning, ...messageWithoutReasoning } = message;
	return messageWithoutReasoning;
}

export function shouldReplayReasoningForModel(
	message: Message,
	options: ReasoningReplayOptions = {},
): boolean {
	return (
		options.thinkingMode !== "disabled" &&
		isDeepSeekProvider(options.providerId) &&
		message.role === "assistant" &&
		(message.toolCalls?.length ?? 0) > 0 &&
		(message.reasoning?.some(
			(part) => part.provider === "deepseek" && part.text.length > 0,
		) ??
			false)
	);
}

export function stripNonReplayableReasoningFromMessage(
	message: Message,
	options: ReasoningReplayOptions = {},
): Message {
	return shouldReplayReasoningForModel(message, options)
		? message
		: stripReasoningFromMessage(message);
}

export function stripReasoningFromMessages(
	messages: readonly Message[],
): Message[] {
	return messages.map((message) => stripReasoningFromMessage(message));
}

export function stripNonReplayableReasoningFromMessages(
	messages: readonly Message[],
	options: ReasoningReplayOptions = {},
): Message[] {
	return messages.map((message) =>
		stripNonReplayableReasoningFromMessage(message, options),
	);
}
