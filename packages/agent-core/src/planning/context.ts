import { NullMemoryClient } from "../memory/client.js";
import type { MemoryClient, MemoryRecallOptions } from "../memory/client.js";
import type { MemoryItem } from "../memory/types.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { Message } from "../state/types.js";
import type { BudgetLedger } from "./state.js";

export interface PlanContext {
	readonly task: string;
	readonly conversationHistory: ReadonlyArray<Message>;
	readonly memoryRecall: ReadonlyArray<MemoryItem>;
	readonly skillCatalog: ReadonlyArray<SkillDescriptor>;
	readonly budget: BudgetLedger;
	readonly iteration: number;
}

export interface PlanContextMemoryInput {
	readonly client?: MemoryClient;
	readonly query?: string;
	readonly options?: MemoryRecallOptions;
}

export interface BuildPlanContextOptions {
	readonly task: string;
	readonly conversationHistory?: ReadonlyArray<Message>;
	readonly skillCatalog?: ReadonlyArray<SkillDescriptor>;
	readonly budget: BudgetLedger;
	readonly iteration?: number;
	readonly memory?: PlanContextMemoryInput;
}

async function recallMemory(
	task: string,
	input: PlanContextMemoryInput | undefined,
): Promise<ReadonlyArray<MemoryItem>> {
	const query = input?.query ?? task;
	const options = input?.options;
	const client = input?.client ?? new NullMemoryClient();

	try {
		return await client.recall(query, options);
	} catch {
		return new NullMemoryClient().recall(query, options);
	}
}

export async function buildPlanContext(
	options: BuildPlanContextOptions,
): Promise<PlanContext> {
	return {
		task: options.task,
		conversationHistory: options.conversationHistory ?? [],
		memoryRecall: await recallMemory(options.task, options.memory),
		skillCatalog: options.skillCatalog ?? [],
		budget: options.budget,
		iteration: options.iteration ?? 0,
	};
}

