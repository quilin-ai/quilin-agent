import type { ToolCall } from "../tools/types.js";

export type Intent =
	| "SIMPLE_QA"
	| "SINGLE_TOOL"
	| "MULTI_STEP"
	| "CLARIFICATION";

export interface IntentClassification {
	readonly intent: Intent;
	readonly confidence: number;
	readonly source: "structural" | "audit";
	readonly latencyMs: number;
	readonly reasoningDigest?: string;
}

export type MemoryWriteScope =
	| "none"
	| "working"
	| "episodic"
	| "semantic"
	| "skill";

export type RiskLevel = "low" | "medium" | "high";

export interface SubTask {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly estimatedTokens: number;
	readonly estimatedSteps: number;
	readonly preconditions: ReadonlyArray<string>;
	readonly effects: ReadonlyArray<string>;
	readonly skillHint?: string;
	readonly writeScope?: MemoryWriteScope;
	readonly risk?: RiskLevel;
}

export interface LinearPlan {
	readonly kind: "linear";
	readonly subtasks: ReadonlyArray<SubTask>;
}

export interface DagPlan {
	readonly kind: "dag";
	readonly subtasks: ReadonlyArray<SubTask>;
	readonly edges: ReadonlyArray<readonly [string, string]>;
}

export type Plan = LinearPlan | DagPlan;

export interface ClarificationRequest {
	readonly question: string;
	readonly missing: ReadonlyArray<string>;
}

export interface PlannerAudit {
	readonly intentHint: Intent;
	readonly confidence: number;
	readonly reasoningDigest?: string;
}

export interface LLMPlannerResponse {
	readonly text?: string;
	readonly toolCalls?: ReadonlyArray<ToolCall>;
	readonly planSketch?: LinearPlan | DagPlan;
	readonly needClarification?: ClarificationRequest;
	readonly audit?: PlannerAudit;
}

export interface IntentClassifier {
	dispatch(response: LLMPlannerResponse): IntentClassification;
}
