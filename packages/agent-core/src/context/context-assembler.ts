import { logger } from "../logger.js";
import { TokenBudgetAllocator, trimSourcesToBudget } from "./budget.js";
import { scanExternalContext } from "./injection-scanner.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { AssembledPrompt, BuildContext } from "./prompt-types.js";
import type { BudgetPolicy, ContextSource } from "./source-types.js";

export interface AssembledContext {
	readonly prompt: AssembledPrompt;
	readonly contextSources: readonly ContextSource[];
	readonly budgetBreakdown: BudgetPolicy;
	readonly totalTokens: number;
}

export interface ContextAssemblerOptions {
	readonly modelId?: string;
	readonly modelWindow?: number;
	readonly availableTools?: readonly string[];
	readonly profile?: BuildContext["profile"];
	readonly now?: () => Date;
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
	): AssembledContext {
		const taskType = inferTaskType(userInput);
		const policy = this.budgetAllocator.allocate(
			taskType,
			this.options.modelWindow ?? 131_072,
		);
		const prompt = this.promptBuilder.build({
			userInput,
			sessionState,
			modelId: this.options.modelId ?? "deepseek-chat",
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
		const budgetedSources = trimSourcesToBudget(safeSources, {
			...policy,
			totalBudget: Math.max(0, policy.totalBudget - prompt.totalTokens),
		});

		return {
			prompt,
			contextSources: budgetedSources,
			budgetBreakdown: policy,
			totalTokens: prompt.totalTokens + sumTokens(budgetedSources),
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
