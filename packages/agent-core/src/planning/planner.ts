import { classifyIntent, type IntentDispatchOptions } from "./intent.js";
import type { PlanContext } from "./context.js";
import { decomposePlan, type DecomposeOptions } from "./decompose.js";
import type {
	IntentClassification,
	LLMPlannerResponse,
	Plan,
} from "./types.js";

export interface PlannerModel {
	deliberate(context: PlanContext): Promise<LLMPlannerResponse>;
}

export interface PlannerDeliberation {
	readonly response: LLMPlannerResponse;
	readonly classification: IntentClassification;
}

export interface MainLLMPlannerOptions {
	readonly intent?: IntentDispatchOptions;
	readonly decompose?: DecomposeOptions;
	readonly now?: () => number;
}

export class MainLLMPlanner {
	private readonly now: () => number;

	constructor(
		private readonly model: PlannerModel,
		private readonly options: MainLLMPlannerOptions = {},
	) {
		this.now = options.now ?? Date.now;
	}

	async deliberate(context: PlanContext): Promise<LLMPlannerResponse> {
		return this.model.deliberate(context);
	}

	classifyIntent(response: LLMPlannerResponse): IntentClassification {
		return classifyIntent(response, this.options.intent);
	}

	async decompose(
		response: LLMPlannerResponse,
		_context: PlanContext,
	): Promise<Plan> {
		return decomposePlan(response, this.options.decompose).plan;
	}

	async deliberateAndClassify(
		context: PlanContext,
	): Promise<PlannerDeliberation> {
		const startedAt = this.now();
		const response = await this.deliberate(context);
		const latencyMs = Math.max(0, this.now() - startedAt);

		return {
			response,
			classification: classifyIntent(response, {
				...this.options.intent,
				latencyMs,
			}),
		};
	}
}
