import {
	generateText,
	type LanguageModel,
	tool as sdkTool,
	streamText,
} from "ai";
import type { AssembledPrompt } from "../context/prompt-types.js";
import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import { adaptMessagesForModel } from "./cache-adapter.js";
import { normalizeTokenUsage } from "./token-usage.js";
import type { InferenceConfig, LLMClient, LLMResponse } from "./types.js";

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
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const adaptedPrompt = adaptMessagesForModel({
			messages,
			prompt,
			provider: this.model.provider,
		});

		const result = await generateText({
			model: this.model,
			messages: adaptedPrompt.messages,
			tools: toSdkTools(tools),
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
		});

		return {
			content: result.text,
			toolCalls: mapToolCalls(result.toolCalls),
			usage: normalizeTokenUsage(result.usage, result.providerMetadata),
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
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const adaptedPrompt = adaptMessagesForModel({
			messages,
			prompt,
			provider: this.model.provider,
		});

		const result = streamText({
			model: this.model,
			messages: adaptedPrompt.messages,
			tools: toSdkTools(tools),
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
		});

		let fullText = "";
		for await (const chunk of result.textStream) {
			fullText += chunk;
			this.onChunk?.(chunk);
		}

		const usage = await result.usage;
		const providerMetadata = await Promise.resolve(result.providerMetadata);
		const finishReason = await result.finishReason;
		const toolCalls = await Promise.resolve(result.toolCalls);

		return {
			content: fullText,
			toolCalls: mapToolCalls(toolCalls),
			usage: normalizeTokenUsage(usage, providerMetadata),
			finishReason: mapFinishReason(finishReason),
		};
	}
}
