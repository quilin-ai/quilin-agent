import {
	generateText,
	type LanguageModel,
	tool as sdkTool,
	streamText,
} from "ai";
import type { AssembledPrompt } from "../context/prompt-types.js";
import type { Message, ReasoningPart } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import { adaptMessagesForModel } from "./cache-adapter.js";
import { normalizeTokenUsage } from "./token-usage.js";
import type {
	InferenceConfig,
	LLMClient,
	LLMResponse,
	LLMStreamEvent,
	ThinkingMode,
} from "./types.js";

interface ResolvableModelHandle {
	readonly model: LanguageModel;
	readonly resolveModel?: (modelId: string) => LanguageModel;
}

type ModelHandle = LanguageModel | ResolvableModelHandle;

interface PreparedInvocation {
	readonly model: LanguageModel;
	readonly messages: ReturnType<typeof adaptMessagesForModel>["messages"];
	readonly providerOptions?: Record<string, unknown>;
}

type GenerateTextReasoningPart = Awaited<
	ReturnType<typeof generateText>
>["reasoning"][number];
type StreamTextReasoningPart = Awaited<
	Awaited<ReturnType<typeof streamText>["reasoning"]>
>[number];
type NativeReasoningPart = GenerateTextReasoningPart | StreamTextReasoningPart;
type NativeProviderMetadata = NativeReasoningPart["providerMetadata"];

interface ToolCallStreamState {
	toolName: string;
	inputText: string;
	input?: unknown;
	started: boolean;
	ended: boolean;
}

interface ReasoningAccumulatorState {
	readonly id: string;
	text: string;
	providerMetadata?: NativeProviderMetadata;
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

function isResolvableModelHandle(
	model: ModelHandle,
): model is ResolvableModelHandle {
	return typeof model === "object" && model != null && "model" in model;
}

function getBaseModel(model: ModelHandle): LanguageModel {
	return isResolvableModelHandle(model) ? model.model : model;
}

function normalizeProviderName(
	provider: string | undefined,
): "anthropic" | "deepseek" | "openai" | "unknown" {
	switch (provider?.split(".")[0]?.toLowerCase()) {
		case "anthropic":
			return "anthropic";
		case "deepseek":
			return "deepseek";
		case "openai":
			return "openai";
		default:
			return "unknown";
	}
}

function mapOpenAIReasoningEffort(
	thinkingMode: ThinkingMode,
): "medium" | "high" | undefined {
	switch (thinkingMode) {
		case "enabled":
			return "high";
		case "auto":
			return "medium";
		default:
			return undefined;
	}
}

function buildProviderOptions(
	provider: string | undefined,
	config: InferenceConfig,
): Record<string, unknown> | undefined {
	switch (normalizeProviderName(provider)) {
		case "anthropic":
			return config.thinkingMode === "enabled"
				? {
						anthropic: {
							thinking: {
								type: "enabled" as const,
								budgetTokens: config.thinkingBudget ?? 1024,
							},
						},
					}
				: undefined;
		case "openai": {
			const reasoningEffort = mapOpenAIReasoningEffort(config.thinkingMode);
			return reasoningEffort == null
				? undefined
				: {
						openai: {
							reasoningEffort,
						},
					};
		}
		case "deepseek":
		case "unknown":
			return undefined;
	}
}

function resolveInvocationModel(
	modelHandle: ModelHandle,
	config: InferenceConfig,
): LanguageModel {
	const baseModel = getBaseModel(modelHandle);
	if (
		normalizeProviderName(baseModel.provider) === "deepseek" &&
		config.thinkingMode !== "disabled" &&
		isResolvableModelHandle(modelHandle) &&
		modelHandle.resolveModel != null
	) {
		return modelHandle.resolveModel("deepseek-reasoner");
	}

	return baseModel;
}

function prepareInvocation(
	modelHandle: ModelHandle,
	messages: readonly Message[],
	config: InferenceConfig,
	prompt?: AssembledPrompt,
): PreparedInvocation {
	const model = resolveInvocationModel(modelHandle, config);
	const adaptedPrompt = adaptMessagesForModel({
		messages,
		prompt,
		provider: model.provider,
	});

	return {
		model,
		messages: adaptedPrompt.messages,
		providerOptions: buildProviderOptions(model.provider, config),
	};
}

function stringifyJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	return serialized ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getProviderMetadataBlock(
	providerMetadata: NativeProviderMetadata,
	providerName: string,
): Record<string, unknown> | undefined {
	if (!isRecord(providerMetadata)) {
		return undefined;
	}

	const block = providerMetadata[providerName];
	return isRecord(block) ? block : undefined;
}

function mergeProviderMetadata(
	current: NativeProviderMetadata,
	next: NativeProviderMetadata,
): NativeProviderMetadata {
	if (next == null) {
		return current;
	}

	if (current == null) {
		return next;
	}

	if (!isRecord(current) || !isRecord(next)) {
		return next;
	}

	const merged: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(next)) {
		const existing = merged[key];
		merged[key] =
			isRecord(existing) && isRecord(value) ? { ...existing, ...value } : value;
	}

	return merged as NativeProviderMetadata;
}

function hasReasoningPayload(part: ReasoningPart): boolean {
	return (
		(part.text?.length ?? 0) > 0 ||
		part.signature != null ||
		part.encryptedContent != null ||
		part.itemId != null
	);
}

function toReasoningPart(
	provider: string | undefined,
	part: NativeReasoningPart,
): ReasoningPart | undefined {
	const anthropicMetadata = getProviderMetadataBlock(
		part.providerMetadata,
		"anthropic",
	);
	const openaiMetadata = getProviderMetadataBlock(
		part.providerMetadata,
		"openai",
	);
	const anthropicSignature = getString(anthropicMetadata?.signature);
	const openaiItemId = getString(openaiMetadata?.itemId);
	const openaiEncryptedContent = getString(
		openaiMetadata?.reasoningEncryptedContent,
	);

	switch (normalizeProviderName(provider)) {
		case "deepseek":
			return { provider: "deepseek", text: part.text };
		case "anthropic":
			return anthropicSignature == null
				? undefined
				: {
						provider: "anthropic",
						text: part.text,
						signature: anthropicSignature,
					};
		case "openai":
			if (openaiItemId != null && openaiEncryptedContent != null) {
				return {
					provider: "openai-responses",
					itemId: openaiItemId,
					encryptedContent: openaiEncryptedContent,
					...(part.text.length === 0 ? {} : { text: part.text }),
				};
			}

			return part.text.length === 0
				? undefined
				: {
						provider: "openai-chat",
						text: part.text,
					};
		case "unknown":
			return undefined;
	}
}

function toReasoningParts(
	provider: string | undefined,
	parts: readonly NativeReasoningPart[] | undefined,
): readonly ReasoningPart[] | undefined {
	if (parts == null || parts.length === 0) {
		return undefined;
	}

	const mapped = parts
		.map((part) => toReasoningPart(provider, part))
		.filter(
			(part): part is ReasoningPart =>
				part != null && hasReasoningPayload(part),
		);

	return mapped.length === 0 ? undefined : mapped;
}

function toReasoningPartsFromText(
	provider: string | undefined,
	text: string | undefined,
): readonly ReasoningPart[] | undefined {
	if (text == null || text.length === 0) {
		return undefined;
	}

	return toReasoningParts(provider, [{ type: "reasoning", text }]);
}

function getTextDelta(chunk: { delta?: string; text?: string }): string {
	return chunk.delta ?? chunk.text ?? "";
}

function ensureReasoningState(
	states: Map<string, ReasoningAccumulatorState>,
	order: ReasoningAccumulatorState[],
	reasoningId: string,
	providerMetadata?: NativeProviderMetadata,
): ReasoningAccumulatorState {
	const existing = states.get(reasoningId);
	if (existing != null) {
		existing.providerMetadata = mergeProviderMetadata(
			existing.providerMetadata,
			providerMetadata,
		);
		return existing;
	}

	const created: ReasoningAccumulatorState = {
		id: reasoningId,
		text: "",
		providerMetadata,
	};
	states.set(reasoningId, created);
	order.push(created);
	return created;
}

function toAccumulatedReasoningParts(
	parts: readonly ReasoningAccumulatorState[],
): readonly NativeReasoningPart[] | undefined {
	if (parts.length === 0) {
		return undefined;
	}

	return parts.map((part) => ({
		type: "reasoning",
		text: part.text,
		...(part.providerMetadata == null
			? {}
			: { providerMetadata: part.providerMetadata }),
	}));
}

function ensureToolCallState(
	states: Map<string, ToolCallStreamState>,
	toolCallId: string,
	toolName?: string,
): ToolCallStreamState {
	const existing = states.get(toolCallId);
	if (existing != null) {
		if (toolName != null) {
			existing.toolName = toolName;
		}
		return existing;
	}

	const created: ToolCallStreamState = {
		toolName: toolName ?? "tool",
		inputText: "",
		started: false,
		ended: false,
	};
	states.set(toolCallId, created);
	return created;
}

function emitToolCallStart(
	state: ToolCallStreamState,
	toolCallId: string,
	onEvent: ((event: LLMStreamEvent) => void) | undefined,
): void {
	if (state.started) {
		return;
	}

	state.started = true;
	onEvent?.({
		type: "tool-call-start",
		toolCallId,
		toolName: state.toolName,
	});
}

function emitToolCallEnd(
	state: ToolCallStreamState,
	toolCallId: string,
	onEvent: ((event: LLMStreamEvent) => void) | undefined,
): void {
	if (state.ended) {
		return;
	}

	state.ended = true;
	onEvent?.({
		type: "tool-call-end",
		toolCallId,
		toolName: state.toolName,
		inputText: state.inputText,
		...(state.input === undefined ? {} : { input: state.input }),
	});
}

/**
 * 基于 Vercel AI SDK 的 LLMClient 实现（非流式）
 *
 * 直接传 LanguageModel 给 generateText()。
 */
export class VercelLLMClient implements LLMClient {
	constructor(private readonly model: ModelHandle) {}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const prepared = prepareInvocation(this.model, messages, config, prompt);

		const result = await generateText({
			model: prepared.model,
			messages: prepared.messages,
			tools: toSdkTools(tools),
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
			...(prepared.providerOptions == null
				? {}
				: { providerOptions: prepared.providerOptions }),
		});
		const thinking =
			toReasoningParts(prepared.model.provider, result.reasoning) ??
			toReasoningPartsFromText(prepared.model.provider, result.reasoningText);

		return {
			content: result.text,
			toolCalls: mapToolCalls(result.toolCalls),
			...(thinking == null ? {} : { thinking }),
			usage: normalizeTokenUsage(result.usage, result.providerMetadata),
			finishReason: mapFinishReason(result.finishReason),
		};
	}
}

/**
 * 基于 Vercel AI SDK 的流式 LLMClient 实现
 *
 * 逐事件调用 onEvent 回调，用于 REPL 逐字输出与 thinking/tool 进度展示。
 */
export class StreamingLLMClient implements LLMClient {
	constructor(
		private readonly model: ModelHandle,
		private readonly onEvent?: (event: LLMStreamEvent) => void,
	) {}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const prepared = prepareInvocation(this.model, messages, config, prompt);

		const result = streamText({
			model: prepared.model,
			messages: prepared.messages,
			tools: toSdkTools(tools),
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
			...(prepared.providerOptions == null
				? {}
				: { providerOptions: prepared.providerOptions }),
		});

		let fullText = "";
		const toolCallStates = new Map<string, ToolCallStreamState>();
		const reasoningStates = new Map<string, ReasoningAccumulatorState>();
		const reasoningOrder: ReasoningAccumulatorState[] = [];

		for await (const chunk of result.fullStream) {
			switch (chunk.type) {
				case "text-delta": {
					const delta = getTextDelta(chunk);
					fullText += delta;
					this.onEvent?.({ type: "text", delta });
					break;
				}
				case "reasoning-start":
					ensureReasoningState(
						reasoningStates,
						reasoningOrder,
						chunk.id,
						chunk.providerMetadata,
					);
					break;
				case "reasoning-delta": {
					const delta = getTextDelta(chunk);
					ensureReasoningState(
						reasoningStates,
						reasoningOrder,
						chunk.id,
						chunk.providerMetadata,
					).text += delta;
					if (delta.length > 0) {
						this.onEvent?.({ type: "reasoning", delta });
					}
					break;
				}
				case "reasoning-end":
					ensureReasoningState(
						reasoningStates,
						reasoningOrder,
						chunk.id,
						chunk.providerMetadata,
					);
					break;
				case "tool-input-start": {
					const state = ensureToolCallState(
						toolCallStates,
						chunk.id,
						chunk.toolName,
					);
					emitToolCallStart(state, chunk.id, this.onEvent);
					break;
				}
				case "tool-input-delta": {
					const state = ensureToolCallState(toolCallStates, chunk.id);
					emitToolCallStart(state, chunk.id, this.onEvent);
					state.inputText += chunk.delta;
					this.onEvent?.({
						type: "tool-call-args-delta",
						toolCallId: chunk.id,
						toolName: state.toolName,
						delta: chunk.delta,
					});
					break;
				}
				case "tool-input-end": {
					ensureToolCallState(toolCallStates, chunk.id);
					break;
				}
				case "tool-call": {
					const state = ensureToolCallState(
						toolCallStates,
						chunk.toolCallId,
						chunk.toolName,
					);
					state.input = chunk.input;
					if (state.inputText.length === 0) {
						state.inputText = stringifyJson(chunk.input);
					}
					emitToolCallStart(state, chunk.toolCallId, this.onEvent);
					emitToolCallEnd(state, chunk.toolCallId, this.onEvent);
					break;
				}
				case "tool-result":
					if (!chunk.preliminary) {
						this.onEvent?.({
							type: "tool-result",
							toolCallId: chunk.toolCallId,
							toolName: chunk.toolName,
							output: chunk.output,
						});
					}
					break;
				case "tool-error":
					this.onEvent?.({
						type: "tool-result",
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						output: chunk.error,
						isError: true,
					});
					break;
				default:
					break;
			}
		}

		const usage = await result.usage;
		const reasoning = await Promise.resolve(result.reasoning);
		const reasoningText = await Promise.resolve(result.reasoningText);
		const providerMetadata = await Promise.resolve(result.providerMetadata);
		const finishReason = await result.finishReason;
		const toolCalls = await Promise.resolve(result.toolCalls);
		const thinking =
			toReasoningParts(prepared.model.provider, reasoning) ??
			toReasoningParts(
				prepared.model.provider,
				toAccumulatedReasoningParts(reasoningOrder),
			) ??
			toReasoningPartsFromText(prepared.model.provider, reasoningText);

		return {
			content: fullText,
			toolCalls: mapToolCalls(toolCalls),
			...(thinking == null ? {} : { thinking }),
			usage: normalizeTokenUsage(usage, providerMetadata),
			finishReason: mapFinishReason(finishReason),
		};
	}
}
