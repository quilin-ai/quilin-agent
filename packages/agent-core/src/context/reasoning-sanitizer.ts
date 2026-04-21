import { logger } from "../logger.js";
import type { Message } from "../state/types.js";
import { scanExternalContext } from "./injection-scanner.js";

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

		return scanResult.sanitizedContent === part.text
			? part
			: { ...part, text: scanResult.sanitizedContent };
	});
}

export function stripReasoningFromMessage(message: Message): Message {
	if (message.reasoning == null) {
		return message;
	}

	const { reasoning: _reasoning, ...messageWithoutReasoning } = message;
	return messageWithoutReasoning;
}

export function stripReasoningFromMessages(
	messages: readonly Message[],
): Message[] {
	return messages.map((message) => stripReasoningFromMessage(message));
}
