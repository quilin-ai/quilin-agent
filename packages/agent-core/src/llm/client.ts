import { generateText, streamText } from "ai";
import type { LanguageModelV1 } from "@ai-sdk/provider";
import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import type { InferenceConfig, LLMClient, LLMResponse } from "./types.js";

function toSdkMessages(messages: readonly Message[]) {
	return messages
		.filter(
			(message): message is Message & {
				role: "system" | "user" | "assistant";
			} =>
				message.role === "system" ||
				message.role === "user" ||
				message.role === "assistant",
		)
		.map((message) => ({
			role: message.role,
			content: message.content,
		}));
}

function mapFinishReason(
	finishReason: string | undefined,
): LLMResponse["finishReason"] {
	switch (finishReason) {
		case "stop":
			return "stop";
		case "tool-calls":
			return "tool_calls";
		case "error":
			return "error";
		case "length":
		default:
			return "length";
	}
}

export class VercelLLMClient implements LLMClient {
	constructor(private readonly model: LanguageModelV1) {}

	async chat(
		messages: readonly Message[],
		_tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse> {
		const result = await generateText({
			model: this.model,
			messages: toSdkMessages(messages),
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
		});

		return {
			content: result.text,
			usage: {
				inputTokens: result.usage.promptTokens,
				outputTokens: result.usage.completionTokens,
			},
			finishReason: mapFinishReason(result.finishReason),
		};
	}
}

export class StreamingLLMClient implements LLMClient {
	constructor(
		private readonly model: LanguageModelV1,
		private readonly onChunk?: (chunk: string) => void,
	) {}

	async chat(
		messages: readonly Message[],
		_tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse> {
		const result = streamText({
			model: this.model,
			messages: toSdkMessages(messages),
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
		});

		let fullText = "";
		for await (const chunk of result.textStream) {
			fullText += chunk;
			this.onChunk?.(chunk);
		}

		const usage = await result.usage;
		const finishReason = await result.finishReason;

		return {
			content: fullText,
			usage: {
				inputTokens: usage.promptTokens,
				outputTokens: usage.completionTokens,
			},
			finishReason: mapFinishReason(finishReason),
		};
	}
}
