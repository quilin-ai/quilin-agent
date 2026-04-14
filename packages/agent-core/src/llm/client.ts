import type {
	LanguageModelV1,
	LanguageModelV1CallOptions,
	LanguageModelV1Message,
	LanguageModelV1Prompt,
	LanguageModelV1StreamPart,
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2Content,
	LanguageModelV2Prompt,
	LanguageModelV2StreamPart,
	LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
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

function toV1Prompt(prompt: LanguageModelV2Prompt): LanguageModelV1Prompt {
	return prompt.map((message): LanguageModelV1Message => {
		switch (message.role) {
			case "system":
				return {
					role: "system",
					content: message.content,
				};
			case "user":
				return {
					role: "user",
					content: message.content.map((part) =>
						part.type === "text"
							? { type: "text", text: part.text }
							: {
									type: "file",
									filename: part.filename,
									data:
										part.data instanceof Uint8Array
											? Buffer.from(part.data).toString("base64")
											: part.data,
									mimeType: part.mediaType,
								},
					),
				};
			case "assistant":
				return {
					role: "assistant",
					content: message.content.flatMap((part) => {
						switch (part.type) {
							case "text":
								return [{ type: "text", text: part.text }] as const;
							case "reasoning":
								return [{ type: "reasoning", text: part.text }] as const;
							case "file":
								return [
									{
										type: "file",
										filename: part.filename,
										data:
											part.data instanceof Uint8Array
												? Buffer.from(part.data).toString("base64")
												: part.data,
										mimeType: part.mediaType,
									},
								] as const;
							case "tool-call":
								return [
									{
										type: "tool-call",
										toolCallId: part.toolCallId,
										toolName: part.toolName,
										args: part.input,
									},
								] as const;
							default:
								return [];
						}
					}),
				};
			case "tool":
				return {
					role: "tool",
					content: message.content.map((part) => ({
						type: "tool-result" as const,
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						result: part.output,
						isError:
							part.output.type === "error-json" ||
							part.output.type === "error-text",
					})),
				};
		}
	});
}

function toV2Content(
	result: Awaited<ReturnType<LanguageModelV1["doGenerate"]>>,
) {
	const content: LanguageModelV2Content[] = [];

	if (result.text) {
		content.push({ type: "text", text: result.text });
	}

	if (typeof result.reasoning === "string") {
		content.push({ type: "reasoning", text: result.reasoning });
	} else if (Array.isArray(result.reasoning)) {
		for (const part of result.reasoning) {
			if (part.type === "text") {
				content.push({ type: "reasoning", text: part.text });
			}
		}
	}

	for (const file of result.files ?? []) {
		content.push({
			type: "file",
			mediaType: file.mimeType,
			data: file.data,
		});
	}

	for (const toolCall of result.toolCalls ?? []) {
		content.push({
			type: "tool-call",
			toolCallId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			input: toolCall.args,
		});
	}

	return content;
}

function toV2Usage(
	usage: Awaited<ReturnType<LanguageModelV1["doGenerate"]>>["usage"],
): LanguageModelV2Usage {
	return {
		inputTokens: usage.promptTokens,
		outputTokens: usage.completionTokens,
		totalTokens: usage.promptTokens + usage.completionTokens,
	};
}

function toV2Stream(
	stream: ReadableStream<LanguageModelV1StreamPart>,
	warnings: LanguageModelV2CallOptions["tools"] extends never
		? never
		: Awaited<ReturnType<LanguageModelV1["doStream"]>>["warnings"],
): ReadableStream<LanguageModelV2StreamPart> {
	return new ReadableStream<LanguageModelV2StreamPart>({
		async start(controller) {
			const reader = stream.getReader();
			const openTextIds = new Set<string>();
			const openReasoningIds = new Set<string>();
			const openToolInputIds = new Map<string, string>();
			const textId = "text";
			const reasoningId = "reasoning";

			controller.enqueue({
				type: "stream-start",
				warnings: warnings ?? [],
			});

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}

				switch (value.type) {
					case "text-delta":
						if (!openTextIds.has(textId)) {
							openTextIds.add(textId);
							controller.enqueue({ type: "text-start", id: textId });
						}
						controller.enqueue({
							type: "text-delta",
							id: textId,
							delta: value.textDelta,
						});
						break;
					case "reasoning":
						if (!openReasoningIds.has(reasoningId)) {
							openReasoningIds.add(reasoningId);
							controller.enqueue({ type: "reasoning-start", id: reasoningId });
						}
						controller.enqueue({
							type: "reasoning-delta",
							id: reasoningId,
							delta: value.textDelta,
						});
						break;
					case "file":
						controller.enqueue({
							type: "file",
							mediaType: value.mimeType,
							data: value.data,
						});
						break;
					case "source":
						controller.enqueue({
							type: "source",
							sourceType: value.source.sourceType,
							id: value.source.id,
							...(value.source.sourceType === "url"
								? {
										url: value.source.url,
										title: value.source.title,
									}
								: {
										mediaType: value.source.mediaType,
										title: value.source.title,
										filename: value.source.filename,
									}),
						});
						break;
					case "tool-call-delta":
						if (!openToolInputIds.has(value.toolCallId)) {
							openToolInputIds.set(value.toolCallId, value.toolName);
							controller.enqueue({
								type: "tool-input-start",
								id: value.toolCallId,
								toolName: value.toolName,
							});
						}
						controller.enqueue({
							type: "tool-input-delta",
							id: value.toolCallId,
							delta: value.argsTextDelta,
						});
						break;
					case "tool-call":
						controller.enqueue({
							type: "tool-call",
							toolCallId: value.toolCallId,
							toolName: value.toolName,
							input: value.args,
						});
						break;
					case "response-metadata":
						controller.enqueue({
							type: "response-metadata",
							id: value.id,
							timestamp: value.timestamp,
							modelId: value.modelId,
						});
						break;
					case "error":
						controller.enqueue({
							type: "error",
							error: value.error,
						});
						break;
					case "finish":
						for (const id of openTextIds) {
							controller.enqueue({ type: "text-end", id });
						}
						for (const id of openReasoningIds) {
							controller.enqueue({ type: "reasoning-end", id });
						}
						for (const [id] of openToolInputIds) {
							controller.enqueue({ type: "tool-input-end", id });
						}
						controller.enqueue({
							type: "finish",
							finishReason: value.finishReason,
							usage: toV2Usage(value.usage),
						});
						break;
					default:
						break;
				}
			}
		},
	});
}

export function adaptLanguageModel(model: LanguageModelV1): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: model.provider,
		modelId: model.modelId,
		supportedUrls: {},
		async doGenerate(options: LanguageModelV2CallOptions) {
			const result = await model.doGenerate({
				inputFormat: "messages",
				mode: { type: "regular" },
				prompt: toV1Prompt(options.prompt),
				maxTokens: options.maxOutputTokens,
				temperature: options.temperature,
				topP: options.topP,
				topK: options.topK,
				frequencyPenalty: options.frequencyPenalty,
				presencePenalty: options.presencePenalty,
				stopSequences: options.stopSequences,
				seed: options.seed,
				headers: options.headers,
				abortSignal: options.abortSignal,
			} satisfies LanguageModelV1CallOptions);

			return {
				content: toV2Content(result),
				finishReason: result.finishReason,
				usage: toV2Usage(result.usage),
				warnings: result.warnings ?? [],
				request: result.request ? { body: result.request.body } : undefined,
				response: result.response
					? {
							id: result.response.id,
							timestamp: result.response.timestamp,
							modelId: result.response.modelId,
							headers: result.rawResponse?.headers,
							body: result.rawResponse?.body,
						}
					: undefined,
			};
		},
		async doStream(options: LanguageModelV2CallOptions) {
			const result = await model.doStream({
				inputFormat: "messages",
				mode: { type: "regular" },
				prompt: toV1Prompt(options.prompt),
				maxTokens: options.maxOutputTokens,
				temperature: options.temperature,
				topP: options.topP,
				topK: options.topK,
				frequencyPenalty: options.frequencyPenalty,
				presencePenalty: options.presencePenalty,
				stopSequences: options.stopSequences,
				seed: options.seed,
				headers: options.headers,
				abortSignal: options.abortSignal,
			} satisfies LanguageModelV1CallOptions);

			return {
				stream: toV2Stream(result.stream, result.warnings),
				request: result.request ? { body: result.request.body } : undefined,
				response: result.rawResponse
					? {
							headers: result.rawResponse.headers,
						}
					: undefined,
			};
		},
	};
}

export class VercelLLMClient implements LLMClient {
	constructor(private readonly model: LanguageModelV1) {}

	async chat(
		messages: readonly Message[],
		_tools: readonly Tool[],
		config: InferenceConfig,
	): Promise<LLMResponse> {
		const result = await generateText({
			model: adaptLanguageModel(this.model),
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
			model: adaptLanguageModel(this.model),
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
