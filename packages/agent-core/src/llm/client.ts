import {
	generateText,
	type LanguageModel,
	type ModelMessage,
	tool as sdkTool,
	streamText,
} from "ai";
import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import type { InferenceConfig, LLMClient, LLMResponse } from "./types.js";

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

function toSdkMessages(messages: readonly Message[]): ModelMessage[] {
	return messages.flatMap((message) => {
		switch (message.role) {
			case "system":
			case "user":
				return [
					{
						role: message.role,
						content: message.content,
					} satisfies ModelMessage,
				];
			case "assistant": {
				if (message.toolCalls == null || message.toolCalls.length === 0) {
					return [
						{
							role: "assistant",
							content: message.content,
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
	});
}

function toSdkTools(tools: readonly Tool[]) {
	if (tools.length === 0) {
		return undefined;
	}

	return Object.fromEntries(
		tools.map((tool) => [
			tool.name,
			sdkTool({
				description: tool.description,
				inputSchema: tool.parameters,
			}),
		]),
	);
}

function mapToolCalls(
	toolCalls:
		| readonly {
				toolCallId: string;
				toolName: string;
				input: unknown;
		  }[]
		| undefined,
) {
	return toolCalls?.map((toolCall) => ({
		id: toolCall.toolCallId,
		name: toolCall.toolName,
		arguments:
			toolCall.input != null && typeof toolCall.input === "object"
				? (toolCall.input as Record<string, unknown>)
				: {},
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
 * 直接传 LanguageModel 给 generateText()。
 */
export class VercelLLMClient implements LLMClient {
	constructor(private readonly model: LanguageModel) {}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse> {
		const result = await generateText({
			model: this.model,
			messages: toSdkMessages(messages),
			tools: toSdkTools(tools),
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
		});

		return {
			content: result.text,
			toolCalls: mapToolCalls(result.toolCalls),
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
		private readonly model: LanguageModel,
		private readonly onChunk?: (chunk: string) => void,
	) {}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse> {
		const result = streamText({
			model: this.model,
			messages: toSdkMessages(messages),
			tools: toSdkTools(tools),
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
		const toolCalls = await Promise.resolve(result.toolCalls);

		return {
			content: fullText,
			toolCalls: mapToolCalls(toolCalls),
			usage: mapUsage(usage),
			finishReason: mapFinishReason(finishReason),
		};
	}
}
