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
import { DEFAULT_PROVIDER_CATALOG, decideLLMRoute } from "./provider.js";
import { selectLLMModelTier } from "./tier-router.js";
import { normalizeTokenUsage } from "./token-usage.js";
import type {
	InferenceConfig,
	LLMClient,
	LLMResponse,
	LLMRouteBudget,
	LLMRouteDecision,
	LLMRouteRequest,
	LLMStreamEvent,
	LLMTierRouteSelection,
	LLMTierRoutingConfig,
	NormalizedProviderError,
	ProviderCatalog,
	ProviderCatalogEntry,
	ProviderRunRecord,
	ThinkingMode,
} from "./types.js";

interface ResolvableModelHandle {
	readonly model: LanguageModel;
	readonly resolveModel?: (modelId: string) => LanguageModel;
}

type ModelHandle = LanguageModel | ResolvableModelHandle;

interface ModelRoutableLLMClient extends LLMClient {
	withModel(modelId: string): LLMClient;
}

interface PreparedInvocation {
	readonly model: LanguageModel;
	readonly modelProvider?: string;
	readonly messages: ReturnType<typeof adaptMessagesForModel>["messages"];
	readonly providerOptions?: InvocationProviderOptions;
	readonly warnings: readonly InvocationWarning[];
	readonly toolNameMapping: ModelToolNameMapping;
}

type InvocationWarning =
	| "deepseek-reasoner-upgrade"
	| "openai-thinking-budget-ignored";

type InvocationProviderOptions = NonNullable<
	Parameters<typeof generateText>[0]["providerOptions"]
>;

interface ProviderOptionsBuildResult {
	readonly providerOptions?: InvocationProviderOptions;
	readonly warnings: readonly InvocationWarning[];
}

interface ModelToolNameMapping {
	readonly toModelName: ReadonlyMap<string, string>;
	readonly toOriginalName: ReadonlyMap<string, string>;
}

interface ResolvedInvocationModel {
	readonly model: LanguageModel;
	readonly warnings: readonly InvocationWarning[];
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
	toolName?: string;
	inputText: string;
	input?: unknown;
	started: boolean;
	ended: boolean;
	pendingInputDeltas: string[];
}

interface ReasoningAccumulatorState {
	readonly id: string;
	text: string;
	providerMetadata?: NativeProviderMetadata;
}

interface LanguageModelMetadata {
	readonly provider?: string;
	readonly modelId?: string;
}

interface ProviderControlPlaneOptions {
	readonly catalog?: ProviderCatalog;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly routeRequest: Omit<LLMRouteRequest, "thinkingMode">;
	readonly tierRouting?: LLMTierRoutingConfig;
	readonly onRunRecord?: (record: ProviderRunRecord) => void;
	readonly now?: () => Date;
}

const REDACTED_PROVIDER_ERROR_MESSAGE = "Provider error details redacted.";
const MODEL_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/u;
const SAFE_ERROR_FIELD_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/u;
const UNSAFE_ERROR_FIELD_PATTERN = /(?:\bBearer\b|^sk-|token=|secret)/iu;

function hashToolName(name: string): string {
	let hash = 0x811c9dc5;
	for (const char of name) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(36);
}

function toBaseModelToolName(name: string): string {
	const normalized = name.replace(/[^A-Za-z0-9_-]/gu, "_");
	return MODEL_TOOL_NAME_PATTERN.test(normalized) && normalized.length > 0
		? normalized
		: `tool_${hashToolName(name)}`;
}

function createModelToolNameMapping(
	toolNames: readonly string[],
): ModelToolNameMapping {
	const toModelName = new Map<string, string>();
	const toOriginalName = new Map<string, string>();
	const usedModelNames = new Set<string>();

	for (const originalName of toolNames) {
		if (toModelName.has(originalName)) {
			continue;
		}

		const baseName = toBaseModelToolName(originalName);
		let modelName = baseName;
		if (usedModelNames.has(modelName)) {
			const hash = hashToolName(originalName);
			modelName = `${baseName}_${hash}`;
			let suffix = 2;
			while (usedModelNames.has(modelName)) {
				modelName = `${baseName}_${hash}_${suffix}`;
				suffix += 1;
			}
		}

		usedModelNames.add(modelName);
		toModelName.set(originalName, modelName);
		toOriginalName.set(modelName, originalName);
	}

	return { toModelName, toOriginalName };
}

function getMessageToolNames(messages: readonly Message[]): string[] {
	const names: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && message.toolCalls != null) {
			for (const toolCall of message.toolCalls) {
				names.push(toolCall.name);
			}
			continue;
		}

		if (message.role === "tool" && message.name != null) {
			names.push(message.name);
		}
	}

	return names;
}

function toModelToolName(name: string, mapping: ModelToolNameMapping): string {
	return mapping.toModelName.get(name) ?? name;
}

function toOriginalToolName(
	name: string,
	mapping: ModelToolNameMapping,
): string {
	return mapping.toOriginalName.get(name) ?? name;
}

function mapMessagesToModelToolNames(
	messages: readonly Message[],
	mapping: ModelToolNameMapping,
): Message[] {
	return messages.map((message) => {
		if (message.role === "assistant" && message.toolCalls != null) {
			return {
				...message,
				toolCalls: message.toolCalls.map((toolCall) => ({
					...toolCall,
					name: toModelToolName(toolCall.name, mapping),
				})),
			};
		}

		if (message.role === "tool" && message.name != null) {
			return {
				...message,
				name: toModelToolName(message.name, mapping),
			};
		}

		return message;
	});
}

function toSdkTools(tools: readonly Tool[], mapping: ModelToolNameMapping) {
	if (tools.length === 0) {
		return undefined;
	}

	return Object.fromEntries(
		tools.map((tool) => [
			toModelToolName(tool.name, mapping),
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
	mapping: ModelToolNameMapping,
) {
	return toolCalls?.map((toolCall) => ({
		id: toolCall.toolCallId,
		name: toOriginalToolName(toolCall.toolName, mapping),
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

function getLanguageModelMetadata(model: LanguageModel): LanguageModelMetadata {
	if (typeof model !== "object" || model == null) {
		return {};
	}

	return {
		provider:
			"provider" in model && typeof model.provider === "string"
				? model.provider
				: undefined,
		modelId:
			"modelId" in model && typeof model.modelId === "string"
				? model.modelId
				: undefined,
	};
}

function selectModelHandle(
	modelHandle: ModelHandle,
	modelId: string,
): ModelHandle {
	if (
		isResolvableModelHandle(modelHandle) &&
		modelHandle.resolveModel != null
	) {
		return {
			...modelHandle,
			model: modelHandle.resolveModel(modelId),
		};
	}

	const baseModel = getBaseModel(modelHandle);
	const metadata = getLanguageModelMetadata(baseModel);
	if (metadata.modelId === modelId) {
		return modelHandle;
	}

	throw new Error(
		`LLM model handle cannot resolve effective model ${modelId}.`,
	);
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
): ProviderOptionsBuildResult {
	switch (normalizeProviderName(provider)) {
		case "anthropic":
			return config.thinkingMode === "enabled"
				? {
						providerOptions: {
							anthropic: {
								thinking: {
									type: "enabled",
									budgetTokens: config.thinkingBudget ?? 1024,
								},
							},
						},
						warnings: [],
					}
				: { warnings: [] };
		case "openai": {
			const reasoningEffort = mapOpenAIReasoningEffort(config.thinkingMode);
			const warnings =
				config.thinkingBudget == null
					? []
					: (["openai-thinking-budget-ignored"] as const);
			return reasoningEffort == null
				? { warnings }
				: {
						providerOptions: {
							openai: {
								reasoningEffort,
							},
						},
						warnings,
					};
		}
		case "deepseek": {
			const reasoningEffort = mapOpenAIReasoningEffort(config.thinkingMode);
			return reasoningEffort == null
				? { warnings: [] }
				: {
						providerOptions: {
							deepseek: {
								thinking: { type: "enabled" },
								reasoningEffort,
							},
						},
						warnings: [],
					};
		}
		case "unknown":
			return { warnings: [] };
	}
}

function resolveInvocationModel(
	modelHandle: ModelHandle,
	config: InferenceConfig,
): ResolvedInvocationModel {
	const baseModel = getBaseModel(modelHandle);
	const baseModelMetadata = getLanguageModelMetadata(baseModel);
	if (
		normalizeProviderName(baseModelMetadata.provider) === "deepseek" &&
		baseModelMetadata.modelId === "deepseek-chat" &&
		config.thinkingMode !== "disabled" &&
		isResolvableModelHandle(modelHandle) &&
		modelHandle.resolveModel != null
	) {
		const resolvedModel = modelHandle.resolveModel("deepseek-reasoner");
		const resolvedModelMetadata = getLanguageModelMetadata(resolvedModel);
		return {
			model: resolvedModel,
			warnings:
				resolvedModelMetadata.modelId === baseModelMetadata.modelId
					? []
					: ["deepseek-reasoner-upgrade"],
		};
	}

	return { model: baseModel, warnings: [] };
}

function prepareInvocation(
	modelHandle: ModelHandle,
	messages: readonly Message[],
	tools: readonly Tool[],
	config: InferenceConfig,
	prompt?: AssembledPrompt,
): PreparedInvocation {
	const resolvedModel = resolveInvocationModel(modelHandle, config);
	const modelMetadata = getLanguageModelMetadata(resolvedModel.model);
	const toolNameMapping = createModelToolNameMapping([
		...tools.map((tool) => tool.name),
		...getMessageToolNames(messages),
	]);
	const adaptedPrompt = adaptMessagesForModel({
		messages: mapMessagesToModelToolNames(messages, toolNameMapping),
		prompt,
		provider: modelMetadata.provider,
		thinkingMode: config.thinkingMode,
	});
	const providerOptions = buildProviderOptions(modelMetadata.provider, config);

	return {
		model: resolvedModel.model,
		modelProvider: modelMetadata.provider,
		messages: adaptedPrompt.messages,
		providerOptions: providerOptions.providerOptions,
		warnings: [...resolvedModel.warnings, ...providerOptions.warnings],
		toolNameMapping,
	};
}

function stringifyJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	return serialized ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

function getSafeDiagnosticField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	const text =
		typeof value === "string"
			? value.trim()
			: typeof value === "number" && Number.isFinite(value)
				? String(value)
				: undefined;

	if (
		text == null ||
		!SAFE_ERROR_FIELD_PATTERN.test(text) ||
		UNSAFE_ERROR_FIELD_PATTERN.test(text)
	) {
		return undefined;
	}

	return text;
}

function getSafeErrorName(error: unknown): string {
	const name =
		isRecord(error) && typeof error.name === "string"
			? error.name.trim()
			: error instanceof Error
				? error.name
				: undefined;

	return name != null &&
		SAFE_ERROR_NAME_PATTERN.test(name) &&
		!UNSAFE_ERROR_FIELD_PATTERN.test(name)
		? name
		: "Error";
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
		toolName,
		inputText: "",
		started: false,
		ended: false,
		pendingInputDeltas: [],
	};
	states.set(toolCallId, created);
	return created;
}

function emitToolCallStart(
	state: ToolCallStreamState,
	toolCallId: string,
	onEvent: ((event: LLMStreamEvent) => void) | undefined,
): void {
	if (state.started || state.toolName == null) {
		return;
	}

	state.started = true;
	onEvent?.({
		type: "tool-call-start",
		toolCallId,
		toolName: state.toolName,
	});
}

function flushBufferedToolCallInput(
	state: ToolCallStreamState,
	toolCallId: string,
	onEvent: ((event: LLMStreamEvent) => void) | undefined,
): void {
	if (state.toolName == null || state.pendingInputDeltas.length === 0) {
		return;
	}

	for (const delta of state.pendingInputDeltas) {
		onEvent?.({
			type: "tool-call-args-delta",
			toolCallId,
			toolName: state.toolName,
			delta,
		});
	}
	state.pendingInputDeltas = [];
}

function emitInvocationWarnings(
	warnings: readonly InvocationWarning[],
	seenWarnings: Set<InvocationWarning>,
): void {
	for (const warning of warnings) {
		if (seenWarnings.has(warning)) {
			continue;
		}

		seenWarnings.add(warning);
		switch (warning) {
			case "deepseek-reasoner-upgrade":
				console.warn(
					"Effective model upgraded to deepseek-reasoner because thinking mode is enabled.",
				);
				break;
			case "openai-thinking-budget-ignored":
				console.warn(
					"OpenAI does not expose token-precise thinking budgets; thinkingBudget is ignored and mapped to reasoningEffort.",
				);
				break;
		}
	}
}

function emitToolCallEnd(
	state: ToolCallStreamState,
	toolCallId: string,
	onEvent: ((event: LLMStreamEvent) => void) | undefined,
): void {
	if (state.ended || state.toolName == null) {
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

export function normalizeProviderError(
	error: unknown,
): NormalizedProviderError {
	const record = isRecord(error) ? error : undefined;
	const code =
		record == null ? undefined : getSafeDiagnosticField(record, "code");
	const category =
		record == null ? undefined : getSafeDiagnosticField(record, "category");

	return {
		name: getSafeErrorName(error),
		message: REDACTED_PROVIDER_ERROR_MESSAGE,
		...(code == null ? {} : { code }),
		...(category == null ? {} : { category }),
	};
}

function reasoningStateAdapterForRequest(
	request: LLMRouteRequest,
): LLMRouteDecision["reasoningStateAdapter"] {
	return request.thinkingMode == null || request.thinkingMode === "disabled"
		? "none"
		: request.provider === "deepseek"
			? "captured_replayed_for_tool_calls"
			: "captured_not_replayed";
}

function routeDecisionFromRequest(request: LLMRouteRequest): LLMRouteDecision {
	return {
		provider: request.provider,
		configuredModel: request.model,
		effectiveModel: request.model,
		fallbackUsed: false,
		reasoningStateAdapter: reasoningStateAdapterForRequest(request),
	};
}

function applyTierSelectionToRoute(
	route: LLMRouteDecision,
	selection: LLMTierRouteSelection | undefined,
	thinkingMode: ThinkingMode,
): LLMRouteDecision {
	if (selection == null) {
		return route;
	}

	return {
		...route,
		selectedTier: selection.tier,
		routingMode: selection.mode,
		routeReason: selection.reason,
		thinkingMode,
	};
}

function applyTierProfileToConfig(
	config: InferenceConfig,
	routing: LLMTierRoutingConfig | undefined,
	selection: LLMTierRouteSelection | undefined,
): InferenceConfig {
	if (routing == null || selection == null) {
		return config;
	}

	const profile = routing.tiers[selection.tier];
	const { thinkingBudget: _thinkingBudget, ...configWithoutThinkingBudget } =
		config;
	const baseConfig =
		profile.thinkingMode === "disabled" ? configWithoutThinkingBudget : config;
	return {
		...baseConfig,
		thinkingMode: profile.thinkingMode,
		...(profile.temperature == null
			? {}
			: { temperature: profile.temperature }),
		...(profile.maxTokens == null ? {} : { maxTokens: profile.maxTokens }),
		...(profile.thinkingMode === "disabled" || profile.thinkingBudget == null
			? {}
			: { thinkingBudget: profile.thinkingBudget }),
		...(profile.topP == null ? {} : { topP: profile.topP }),
	};
}

function buildRouteBudget(config: InferenceConfig): LLMRouteBudget {
	return {
		maxTokens: config.maxTokens,
		...(config.thinkingBudget == null
			? {}
			: { thinkingBudget: config.thinkingBudget }),
	};
}

function attachRouteBudget(
	route: LLMRouteDecision,
	config: InferenceConfig,
): LLMRouteDecision {
	return {
		...route,
		budget: buildRouteBudget(config),
	};
}

function validateInferenceBudget(config: InferenceConfig): void {
	if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
		throw new Error("LLM maxTokens must be a positive integer.");
	}

	if (
		config.thinkingBudget != null &&
		(!Number.isInteger(config.thinkingBudget) || config.thinkingBudget <= 0)
	) {
		throw new Error("LLM thinkingBudget must be a positive integer when set.");
	}
}

function findRouteCatalogEntry(
	catalog: ProviderCatalog,
	route: LLMRouteDecision,
): ProviderCatalogEntry {
	const entry = catalog.entries.find(
		(candidate) => candidate.provider === route.provider,
	);
	if (entry == null) {
		throw new Error(
			`Provider ${route.provider} is not in the provider catalog.`,
		);
	}

	return entry;
}

function validateSelectedProviderCatalogEntry(
	catalog: ProviderCatalog,
	route: LLMRouteDecision,
	env: Readonly<Record<string, string | undefined>>,
): void {
	const entry = findRouteCatalogEntry(catalog, route);
	const missingEnv = (entry.requiredEnv ?? []).filter(
		(name) => env[name] == null,
	);
	if (missingEnv.length > 0) {
		throw new Error(
			`Enabled provider ${entry.provider} is missing required env: ${missingEnv.join(", ")}`,
		);
	}

	if (entry.liveEvidence !== "verified") {
		throw new Error(
			`Enabled provider ${entry.provider} requires verified live evidence.`,
		);
	}

	if (
		entry.defaultModel == null ||
		!(
			entry.allowCustomModels === true ||
			entry.models.includes(entry.defaultModel)
		)
	) {
		throw new Error(
			`Enabled provider ${entry.provider} requires a default model in its model list.`,
		);
	}
}

function isModelRoutableLLMClient(
	delegate: LLMClient,
): delegate is ModelRoutableLLMClient {
	return "withModel" in delegate && typeof delegate.withModel === "function";
}

function delegateForRoute(
	delegate: LLMClient,
	route: LLMRouteDecision,
): LLMClient {
	if (isModelRoutableLLMClient(delegate)) {
		return delegate.withModel(route.effectiveModel);
	}

	if (route.effectiveModel === route.configuredModel) {
		return delegate;
	}

	throw new Error(
		`LLM delegate cannot route configured model ${route.configuredModel} to effective model ${route.effectiveModel}.`,
	);
}

export class ProviderControlPlaneLLMClient implements LLMClient {
	private readonly catalog: ProviderCatalog;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly now: () => Date;
	private readonly records: ProviderRunRecord[] = [];

	constructor(
		private readonly delegate: LLMClient,
		private readonly options: ProviderControlPlaneOptions,
	) {
		this.catalog = options.catalog ?? DEFAULT_PROVIDER_CATALOG;
		this.env = options.env ?? process.env;
		this.now = options.now ?? (() => new Date());
	}

	get runRecords(): readonly ProviderRunRecord[] {
		return this.records;
	}

	private recordRun(record: ProviderRunRecord): void {
		this.records.push(record);
		try {
			this.options.onRunRecord?.(record);
		} catch {
			// Provider run observers must not affect model execution.
		}
	}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const selection =
			this.options.tierRouting == null
				? undefined
				: selectLLMModelTier(this.options.tierRouting, {
						messages,
						tools,
						prompt,
					});
		const routedConfig = applyTierProfileToConfig(
			config,
			this.options.tierRouting,
			selection,
		);
		const selectedProfile =
			this.options.tierRouting == null || selection == null
				? undefined
				: this.options.tierRouting.tiers[selection.tier];
		const routeRequest = {
			provider: selectedProfile?.provider ?? this.options.routeRequest.provider,
			model: selectedProfile?.model ?? this.options.routeRequest.model,
			thinkingMode: routedConfig.thinkingMode,
		};
		let route: LLMRouteDecision;
		if (routeRequest.provider !== this.options.routeRequest.provider) {
			const error = new Error(
				`LLM tier routing cannot switch runtime provider from ${this.options.routeRequest.provider} to ${routeRequest.provider}; configure a matching provider delegate before enabling that tier.`,
			);
			const record: ProviderRunRecord = {
				route: applyTierSelectionToRoute(
					attachRouteBudget(
						routeDecisionFromRequest({
							...this.options.routeRequest,
							thinkingMode: routedConfig.thinkingMode,
						}),
						routedConfig,
					),
					selection,
					routedConfig.thinkingMode,
				),
				attempts: [],
				outcome: "error",
				fallbackUsed: false,
				error: normalizeProviderError(error),
			};
			this.recordRun(record);
			throw error;
		}

		try {
			validateInferenceBudget(routedConfig);
			route = applyTierSelectionToRoute(
				attachRouteBudget(
					decideLLMRoute(routeRequest, this.catalog),
					routedConfig,
				),
				selection,
				routedConfig.thinkingMode,
			);
			validateSelectedProviderCatalogEntry(this.catalog, route, this.env);
		} catch (error) {
			const record: ProviderRunRecord = {
				route: applyTierSelectionToRoute(
					attachRouteBudget(
						routeDecisionFromRequest(routeRequest),
						routedConfig,
					),
					selection,
					routedConfig.thinkingMode,
				),
				attempts: [],
				outcome: "error",
				fallbackUsed: false,
				error: normalizeProviderError(error),
			};
			this.recordRun(record);
			throw error;
		}

		let routedDelegate: LLMClient;
		try {
			routedDelegate = delegateForRoute(this.delegate, route);
		} catch (error) {
			const record: ProviderRunRecord = {
				route,
				attempts: [],
				outcome: "error",
				fallbackUsed: false,
				error: normalizeProviderError(error),
			};
			this.recordRun(record);
			throw error;
		}

		const startedAt = this.now().toISOString();
		try {
			const response = await routedDelegate.chat(
				messages,
				tools,
				routedConfig,
				prompt,
			);
			const completedAt = this.now().toISOString();
			const record: ProviderRunRecord = {
				route,
				attempts: [
					{
						attemptNumber: 1,
						provider: route.provider,
						model: route.effectiveModel,
						startedAt,
						completedAt,
						outcome: "success",
						usage: response.usage,
					},
				],
				outcome: "success",
				fallbackUsed: false,
			};
			this.recordRun(record);
			return response;
		} catch (error) {
			const completedAt = this.now().toISOString();
			const record: ProviderRunRecord = {
				route,
				attempts: [
					{
						attemptNumber: 1,
						provider: route.provider,
						model: route.effectiveModel,
						startedAt,
						completedAt,
						outcome: "error",
						error: normalizeProviderError(error),
					},
				],
				outcome: "error",
				fallbackUsed: false,
			};
			this.recordRun(record);
			throw error;
		}
	}
}

/**
 * 基于 Vercel AI SDK 的 LLMClient 实现（非流式）
 *
 * 直接传 LanguageModel 给 generateText()。
 */
export class VercelLLMClient implements LLMClient {
	private readonly seenWarnings = new Set<InvocationWarning>();

	constructor(private readonly model: ModelHandle) {}

	withModel(modelId: string): VercelLLMClient {
		return new VercelLLMClient(selectModelHandle(this.model, modelId));
	}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const prepared = prepareInvocation(
			this.model,
			messages,
			tools,
			config,
			prompt,
		);
		emitInvocationWarnings(prepared.warnings, this.seenWarnings);

		const result = await generateText({
			model: prepared.model,
			messages: prepared.messages,
			allowSystemInMessages: true,
			tools: toSdkTools(tools, prepared.toolNameMapping),
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
			maxRetries: 0,
			...(prepared.providerOptions == null
				? {}
				: { providerOptions: prepared.providerOptions }),
		});
		const thinking =
			toReasoningParts(prepared.modelProvider, result.reasoning) ??
			toReasoningPartsFromText(prepared.modelProvider, result.reasoningText);

		return {
			content: result.text,
			toolCalls: mapToolCalls(result.toolCalls, prepared.toolNameMapping),
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
	private readonly seenWarnings = new Set<InvocationWarning>();

	constructor(
		private readonly model: ModelHandle,
		private readonly onEvent?: (event: LLMStreamEvent) => void,
	) {}

	withModel(modelId: string): StreamingLLMClient {
		return new StreamingLLMClient(
			selectModelHandle(this.model, modelId),
			this.onEvent,
		);
	}

	async chat(
		messages: readonly Message[],
		tools: readonly Tool[],
		config: InferenceConfig,
		prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		const prepared = prepareInvocation(
			this.model,
			messages,
			tools,
			config,
			prompt,
		);
		emitInvocationWarnings(prepared.warnings, this.seenWarnings);

		const result = streamText({
			model: prepared.model,
			messages: prepared.messages,
			allowSystemInMessages: true,
			tools: toSdkTools(tools, prepared.toolNameMapping),
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			topP: config.topP,
			maxRetries: 0,
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
					const toolName = toOriginalToolName(
						chunk.toolName,
						prepared.toolNameMapping,
					);
					const state = ensureToolCallState(toolCallStates, chunk.id, toolName);
					emitToolCallStart(state, chunk.id, this.onEvent);
					flushBufferedToolCallInput(state, chunk.id, this.onEvent);
					break;
				}
				case "tool-input-delta": {
					const state = ensureToolCallState(toolCallStates, chunk.id);
					state.inputText += chunk.delta;
					if (state.toolName == null) {
						state.pendingInputDeltas.push(chunk.delta);
						break;
					}
					emitToolCallStart(state, chunk.id, this.onEvent);
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
					const toolName = toOriginalToolName(
						chunk.toolName,
						prepared.toolNameMapping,
					);
					const state = ensureToolCallState(
						toolCallStates,
						chunk.toolCallId,
						toolName,
					);
					state.input = chunk.input;
					if (state.inputText.length === 0) {
						state.inputText = stringifyJson(chunk.input);
					}
					emitToolCallStart(state, chunk.toolCallId, this.onEvent);
					flushBufferedToolCallInput(state, chunk.toolCallId, this.onEvent);
					emitToolCallEnd(state, chunk.toolCallId, this.onEvent);
					break;
				}
				case "tool-result":
					if (!chunk.preliminary) {
						this.onEvent?.({
							type: "tool-result",
							toolCallId: chunk.toolCallId,
							toolName: toOriginalToolName(
								chunk.toolName,
								prepared.toolNameMapping,
							),
							output: chunk.output,
						});
					}
					break;
				case "tool-error":
					this.onEvent?.({
						type: "tool-result",
						toolCallId: chunk.toolCallId,
						toolName: toOriginalToolName(
							chunk.toolName,
							prepared.toolNameMapping,
						),
						output: chunk.error,
						isError: true,
					});
					break;
				case "error":
					throw chunk.error instanceof Error
						? chunk.error
						: new Error(String(chunk.error));
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
			toReasoningParts(prepared.modelProvider, reasoning) ??
			toReasoningParts(
				prepared.modelProvider,
				toAccumulatedReasoningParts(reasoningOrder),
			) ??
			toReasoningPartsFromText(prepared.modelProvider, reasoningText);

		return {
			content: fullText,
			toolCalls: mapToolCalls(toolCalls, prepared.toolNameMapping),
			...(thinking == null ? {} : { thinking }),
			usage: normalizeTokenUsage(usage, providerMetadata),
			finishReason: mapFinishReason(finishReason),
		};
	}
}

export const __test__ = {
	isResolvableModelHandle,
	getBaseModel,
	normalizeProviderName,
	mapOpenAIReasoningEffort,
	buildProviderOptions,
	normalizeProviderError,
};
