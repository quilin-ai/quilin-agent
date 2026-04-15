import type { BudgetPolicy, ContextSource } from "./source-types.js";

type KnownTaskType = "simple_qa" | "deep_reasoning" | "tool_use";

interface BudgetRatios {
	systemRatio: number;
	memoryRatio: number;
	toolsRatio: number;
	historyRatio: number;
}

const DEFAULT_OUTPUT_RESERVE_RATIO = 0.3;

const TASK_RATIOS: Record<KnownTaskType, BudgetRatios> = {
	simple_qa: {
		systemRatio: 0.2,
		memoryRatio: 0.2,
		toolsRatio: 0.15,
		historyRatio: 0.45,
	},
	deep_reasoning: {
		systemRatio: 0.2,
		memoryRatio: 0.3,
		toolsRatio: 0.15,
		historyRatio: 0.35,
	},
	tool_use: {
		systemRatio: 0.2,
		memoryRatio: 0.15,
		toolsRatio: 0.3,
		historyRatio: 0.35,
	},
};

function getRatios(taskType: string): BudgetRatios {
	return TASK_RATIOS[taskType as KnownTaskType] ?? TASK_RATIOS.simple_qa;
}

export class TokenBudgetAllocator {
	allocate(
		taskType: string,
		totalBudget: number,
		overrides: Partial<Pick<BudgetPolicy, "outputReserve">> = {},
	): BudgetPolicy {
		const ratios = getRatios(taskType);

		return {
			taskType,
			totalBudget,
			systemRatio: ratios.systemRatio,
			memoryRatio: ratios.memoryRatio,
			toolsRatio: ratios.toolsRatio,
			historyRatio: ratios.historyRatio,
			outputReserve:
				overrides.outputReserve ??
				Math.round(totalBudget * DEFAULT_OUTPUT_RESERVE_RATIO),
		};
	}

	rebalance(
		policy: BudgetPolicy,
		used: Partial<Record<"memory" | "tools" | "history", number>>,
	): BudgetPolicy {
		const memoryBudget = policy.totalBudget * policy.memoryRatio;
		const toolsBudget = policy.totalBudget * policy.toolsRatio;
		const historyBudget = policy.totalBudget * policy.historyRatio;

		const unusedMemory = Math.max(
			0,
			memoryBudget - (used.memory ?? memoryBudget),
		);
		const unusedTools = Math.max(0, toolsBudget - (used.tools ?? toolsBudget));
		const transferredTokens = unusedMemory + unusedTools;
		const ratioDelta = transferredTokens / policy.totalBudget;

		return {
			...policy,
			memoryRatio: policy.memoryRatio - unusedMemory / policy.totalBudget,
			toolsRatio: policy.toolsRatio - unusedTools / policy.totalBudget,
			historyRatio:
				policy.historyRatio +
				ratioDelta +
				Math.max(0, historyBudget - (used.history ?? historyBudget)) * 0,
		};
	}
}

export function trimSourcesToBudget(
	sources: readonly ContextSource[],
	policy: BudgetPolicy,
): ContextSource[] {
	const availableBudget = Math.max(
		0,
		policy.totalBudget - policy.outputReserve,
	);
	let usedTokens = 0;

	return sources
		.toSorted((left, right) => {
			if (right.relevanceScore !== left.relevanceScore) {
				return right.relevanceScore - left.relevanceScore;
			}

			return right.timestamp - left.timestamp;
		})
		.filter((source) => {
			if (usedTokens + source.tokenCount > availableBudget) {
				return false;
			}

			usedTokens += source.tokenCount;
			return true;
		});
}
