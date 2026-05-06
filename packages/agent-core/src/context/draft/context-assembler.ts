import { logger } from "../../logger.js";
import { TokenBudgetAllocator } from "../budget.js";
import { scanExternalContext } from "../injection-scanner.js";
import { PromptBuilder } from "../prompt-builder.js";
import type { AssembledPrompt, BuildContext } from "../prompt-types.js";
import { buildContextCachePlan } from "./cache-plan.js";
import { compressContextSources } from "./compression.js";
import { selectContextSources } from "./selection.js";
import type {
	BudgetPolicy,
	ContextCachePlan,
	ContextCacheRetentionPolicy,
	ContextCacheStrategy,
	ContextCompressionTrace,
	ContextDeltaStreamTrace,
	ContextSelectionCompressionTraceLink,
	ContextSelectionTrace,
	ContextSource,
	ContextTraceSourceSummary,
	ContextTraceSummary,
} from "./source-types.js";
import {
	buildContextDeltaStreamTrace,
	type ContextTraceDelta,
	diffContextTraceSummaries,
} from "./trace-delta.js";

export interface AssembledContext {
	readonly prompt: AssembledPrompt;
	readonly contextSources: readonly ContextSource[];
	readonly budgetBreakdown: BudgetPolicy;
	readonly compressionTrace: ContextCompressionTrace;
	readonly selectionTrace: ContextSelectionTrace;
	readonly selectionCompressionTraceLink: ContextSelectionCompressionTraceLink;
	readonly traceSummary: ContextTraceSummary;
	readonly deltaStreamTrace: ContextDeltaStreamTrace;
	readonly cachePlan?: ContextCachePlan;
	readonly traceDelta?: ContextTraceDelta;
	readonly totalTokens: number;
}

export interface ContextAssemblerOptions {
	readonly modelId?: string;
	readonly modelWindow?: number;
	readonly availableTools?: readonly string[];
	readonly profile?: BuildContext["profile"];
	readonly now?: () => Date;
	readonly providerPath?: string;
	readonly modelFamily?: string;
	readonly cacheStrategy?: ContextCacheStrategy;
	readonly cacheRetentionPolicy?: ContextCacheRetentionPolicy;
	readonly cacheProviderOptions?: Readonly<Record<string, unknown>>;
	readonly cacheExpectedUsageFields?: readonly string[];
}

export interface ContextAssemblyRunOptions {
	readonly previousTraceSummary?: ContextTraceSummary;
}

function inferTaskType(userInput: string): string {
	if (/(tool|调用|使用工具|memory_|mcp)/i.test(userInput)) {
		return "tool_use";
	}
	if (/(分析|解释|why|reason|设计|架构)/i.test(userInput)) {
		return "deep_reasoning";
	}
	return "simple_qa";
}

function sumTokens(sources: readonly ContextSource[]): number {
	return sources.reduce((sum, source) => sum + source.tokenCount, 0);
}

function sourcesWithSelectionTraceIds(
	sources: readonly ContextSource[],
	selectionTrace: ContextSelectionTrace,
): readonly ContextSource[] {
	return sources.map((source, index) => {
		const sourceId = selectionTrace.selectedSources[index]?.sourceId;

		if (sourceId == null || source.sourceId === sourceId) {
			return source;
		}

		return {
			...source,
			sourceId,
		};
	});
}

function linkSelectionAndCompressionTraces(
	selectionTrace: ContextSelectionTrace,
	compressionTrace: ContextCompressionTrace,
): ContextSelectionCompressionTraceLink {
	const compressionDecisionsBySourceId = new Map(
		compressionTrace.decisions.map((decision) => [decision.sourceId, decision]),
	);
	const selectedToCompression = selectionTrace.selectedSources.flatMap(
		(selectedSource) => {
			const compressionDecision = compressionDecisionsBySourceId.get(
				selectedSource.sourceId,
			);

			if (compressionDecision == null) {
				return [];
			}

			return [
				{
					sourceId: selectedSource.sourceId,
					compressionDecision: compressionDecision.decision,
					compressionReason: compressionDecision.reason,
					outputTokens: compressionDecision.outputTokens,
				},
			];
		},
	);
	const selectedDecisionSourceIds = new Set(
		selectedToCompression.map((link) => link.sourceId),
	);
	const compressionCandidateSourceIds = new Set(
		compressionTrace.candidateSourceIds,
	);
	const rejectedSourceIdsExcludedFromCompression =
		selectionTrace.rejectedSources
			.map((rejectedSource) => rejectedSource.sourceId)
			.filter((sourceId) => !compressionCandidateSourceIds.has(sourceId));
	const missingCompressionDecisionSourceIds = selectionTrace.selectedSources
		.map((selectedSource) => selectedSource.sourceId)
		.filter((sourceId) => !selectedDecisionSourceIds.has(sourceId));
	const determinismKey = [
		`selection=${selectionTrace.determinismKey}`,
		`compression=${compressionTrace.determinismKey}`,
		`selected=${selectedToCompression
			.map(
				(link) =>
					`${link.sourceId}:${link.compressionDecision}:${link.outputTokens}`,
			)
			.join(",")}`,
		`rejectedExcluded=${rejectedSourceIdsExcludedFromCompression.join(",")}`,
		`missing=${missingCompressionDecisionSourceIds.join(",")}`,
	].join("|");

	return {
		traceId: `selection-compression:${determinismKey}`,
		selectionTraceId: selectionTrace.traceId,
		compressionTraceId: compressionTrace.traceId,
		selectedToCompression,
		compressionCandidateSourceIds: compressionTrace.candidateSourceIds,
		rejectedSourceIdsExcludedFromCompression,
		missingCompressionDecisionSourceIds,
		determinismKey,
	};
}

function sourceSummaryKey(summary: ContextTraceSourceSummary): string {
	return [
		summary.sourceId,
		summary.selection,
		summary.rejectionReason ?? "",
		summary.compressionDecision ?? "",
		summary.compressionReason ?? "",
		summary.originalTokens ?? "",
		summary.outputTokens,
	].join(":");
}

function summarizeTraceSources(
	selectionTrace: ContextSelectionTrace,
	compressionTrace: ContextCompressionTrace,
): readonly ContextTraceSourceSummary[] {
	const compressionDecisionsBySourceId = new Map(
		compressionTrace.decisions.map((decision) => [decision.sourceId, decision]),
	);
	const selectedSourceSummaries = selectionTrace.selectedSources.map(
		(selectedSource): ContextTraceSourceSummary => {
			const compressionDecision = compressionDecisionsBySourceId.get(
				selectedSource.sourceId,
			);

			return {
				sourceId: selectedSource.sourceId,
				selection: "selected",
				compressionDecision: compressionDecision?.decision,
				compressionReason: compressionDecision?.reason,
				originalTokens: compressionDecision?.originalTokens,
				outputTokens: compressionDecision?.outputTokens ?? 0,
			};
		},
	);
	const rejectedSourceSummaries = selectionTrace.rejectedSources.map(
		(rejectedSource): ContextTraceSourceSummary => ({
			sourceId: rejectedSource.sourceId,
			selection: "rejected",
			rejectionReason: rejectedSource.reason,
			outputTokens: 0,
		}),
	);

	return [...selectedSourceSummaries, ...rejectedSourceSummaries].toSorted(
		(left, right) => left.sourceId.localeCompare(right.sourceId),
	);
}

function summarizeTraceOutcome(
	selectionTrace: ContextSelectionTrace,
	compressionTrace: ContextCompressionTrace,
	prompt: AssembledPrompt,
): ContextTraceSummary {
	const decisionCounts = {
		selected: selectionTrace.selectedSources.length,
		rejected: selectionTrace.rejectedSources.length,
		keep: 0,
		truncate: 0,
		drop: 0,
	};

	for (const decision of compressionTrace.decisions) {
		decisionCounts[decision.decision] += 1;
	}

	const compressedCount = decisionCounts.keep + decisionCounts.truncate;
	const sectionCount = prompt.segments.length;
	const sourceSummaries = summarizeTraceSources(
		selectionTrace,
		compressionTrace,
	);
	const determinismKey = [
		`selection=${selectionTrace.determinismKey}`,
		`compression=${compressionTrace.determinismKey}`,
		`candidate=${selectionTrace.candidateSourceIds.length}`,
		`selected=${decisionCounts.selected}`,
		`rejected=${decisionCounts.rejected}`,
		`compressed=${compressedCount}`,
		`truncated=${decisionCounts.truncate}`,
		`dropped=${decisionCounts.drop}`,
		`tokens=${compressionTrace.usedTokens}/${compressionTrace.budgetTokens}`,
		`sections=${sectionCount}`,
		`decisions=selected:${decisionCounts.selected},rejected:${decisionCounts.rejected},keep:${decisionCounts.keep},truncate:${decisionCounts.truncate},drop:${decisionCounts.drop}`,
		`sources=${sourceSummaries.map(sourceSummaryKey).join(",")}`,
	].join("|");

	return {
		traceId: `trace-summary:${determinismKey}`,
		selectionTraceId: selectionTrace.traceId,
		compressionTraceId: compressionTrace.traceId,
		candidateCount: selectionTrace.candidateSourceIds.length,
		selectedCount: decisionCounts.selected,
		rejectedCount: decisionCounts.rejected,
		compressedCount,
		truncatedCount: decisionCounts.truncate,
		droppedCount: decisionCounts.drop,
		usedTokens: compressionTrace.usedTokens,
		budgetTokens: compressionTrace.budgetTokens,
		sectionCount,
		decisionCounts,
		sourceSummaries,
		determinismKey,
	};
}

export class ContextAssembler {
	constructor(
		private readonly promptBuilder: PromptBuilder,
		private readonly budgetAllocator: TokenBudgetAllocator,
		private readonly options: ContextAssemblerOptions = {},
	) {}

	assembleContext(
		userInput: string,
		sessionState: Record<string, unknown>,
		memorySources: readonly ContextSource[],
		externalSources: readonly ContextSource[],
		runOptions: ContextAssemblyRunOptions = {},
	): AssembledContext {
		const taskType = inferTaskType(userInput);
		const modelId = this.options.modelId ?? "deepseek-chat";
		const policy = this.budgetAllocator.allocate(
			taskType,
			this.options.modelWindow ?? 131_072,
		);
		const prompt = this.promptBuilder.build({
			userInput,
			sessionState,
			modelId,
			availableTools: this.options.availableTools ?? [],
			profile: this.options.profile ?? "full",
		});

		const allSources = [...memorySources, ...externalSources];
		const scannedSources = allSources.map((source) => {
			if (!source.isExternal) {
				return source;
			}

			const result = scanExternalContext(source.content, source.sourceType);
			if (!result.safe) {
				logger.warn(
					{ sourceType: source.sourceType, threats: result.threats },
					"External context scan detected threats",
				);
			}

			return {
				...source,
				content: result.sanitizedContent,
			};
		});
		const safeSources = scannedSources.filter(
			(source) => source.content.length > 0,
		);
		const availableSourceBudget = Math.max(
			0,
			policy.totalBudget - policy.outputReserve - prompt.totalTokens,
		);
		const selection = selectContextSources(safeSources, {
			taskIntent: taskType,
			budgetTokens: availableSourceBudget,
			enforceBudgetGate: false,
		});
		const selectedSources = sourcesWithSelectionTraceIds(
			selection.sources,
			selection.trace,
		);
		const compression = compressContextSources(selectedSources, {
			budgetTokens: availableSourceBudget,
		});
		const selectionCompressionTraceLink = linkSelectionAndCompressionTraces(
			selection.trace,
			compression.trace,
		);
		const cachePlan = buildContextCachePlan({
			prompt,
			contextSources: compression.sources,
			promptBuildId: selection.trace.promptBuildId,
			modelId,
			providerPath: this.options.providerPath,
			modelFamily: this.options.modelFamily,
			cacheStrategy: this.options.cacheStrategy,
			retentionPolicy: this.options.cacheRetentionPolicy,
			providerOptions: this.options.cacheProviderOptions,
			expectedUsageFields: this.options.cacheExpectedUsageFields,
		});
		const traceSummary = summarizeTraceOutcome(
			selection.trace,
			compression.trace,
			prompt,
		);
		const traceDelta =
			runOptions.previousTraceSummary == null
				? undefined
				: diffContextTraceSummaries(
						runOptions.previousTraceSummary,
						traceSummary,
					);
		const deltaStreamTrace = buildContextDeltaStreamTrace({
			sessionId: selection.trace.runId,
			streamId: selection.trace.promptBuildId,
			selectionTrace: selection.trace,
			compressionTrace: compression.trace,
			cachePlan,
			traceSummary,
			...(traceDelta == null ? {} : { traceDelta }),
			deliveredAt: (this.options.now ?? (() => new Date()))().toISOString(),
		});

		return {
			prompt,
			contextSources: compression.sources,
			budgetBreakdown: policy,
			compressionTrace: compression.trace,
			selectionTrace: selection.trace,
			selectionCompressionTraceLink,
			traceSummary,
			deltaStreamTrace,
			cachePlan,
			...(traceDelta == null ? {} : { traceDelta }),
			totalTokens: prompt.totalTokens + sumTokens(compression.sources),
		};
	}
}

export function createDefaultContextAssembler(
	options: ContextAssemblerOptions = {},
): ContextAssembler {
	return new ContextAssembler(
		new PromptBuilder(),
		new TokenBudgetAllocator(),
		options,
	);
}
