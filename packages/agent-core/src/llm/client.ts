import { type LanguageModel, generateText, streamText } from "ai";
import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import type { InferenceConfig, LLMClient, LLMResponse } from "./types.js";

function toSdkMessages(messages: readonly Message[]) {
	return messages
		.filter(
			(
				message,
			): message is Message & {
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
		default:
			return "length";
	}
}

function mapUsage(
	usage:
		| {
				promptTokens?: number;
				completionTokens?: number;
				inputTokens?: number;
				outputTokens?: number;
				inputTokenDetails?: { cacheReadTokens?: number };
		  }
		| undefined,
) {
	return {
		inputTokens: usage?.promptTokens ?? usage?.inputTokens ?? 0,
		outputTokens: usage?.completionTokens ?? usage?.outputTokens ?? 0,
		cacheHitTokens: usage?.inputTokenDetails?.cacheReadTokens,
	};
}

/**
 * 基于 Vercel AI SDK 的 LLMClient 实现（非流式）
 *
 * 直接传 LanguageModelV1 给 generateText()，
 * AI SDK 内置 V1→V2 compat shim 自动处理适配。
 */
export class VercelLLMClient implements LLMClient {
	constructor(private readonly model: LanguageModel) {}

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
			usage: mapUsage(result.usage),
			finishReason: mapFinishReason(result.finishReason),
		};
	}
}

/**
 * 基于 Vercel AI SDK 的流式 LLMClient 实现
 *
 * 逐 chunk 调用 onChunk 回调，用于 REPL 逐字输出。
 */
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
			usage: mapUsage(usage),
			finishReason: mapFinishReason(finishReason),
		};
	}
}
