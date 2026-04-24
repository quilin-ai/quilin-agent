import {
	assertAcyclicDag,
	getStepWriteSet,
	haveIndependentWriteSets,
	type WriteSet,
} from "./dag.js";
import type { DagPlan, RiskLevel, SubTask } from "./types.js";

export type DelegationRiskLevel = "safe" | RiskLevel | "critical";

export interface DelegationTriggerConditions {
	readonly longRunningTask: boolean;
	readonly decomposableSubtask: boolean;
	readonly nonBlockingSupervisorRequired: boolean;
	readonly subAgentCapabilityAvailable: boolean;
}

export interface DelegationAgentProfile {
	readonly role: string;
	readonly goal: string;
	readonly backstory?: string;
}

export interface DelegationCandidate {
	readonly parentRunId: string;
	readonly candidateStep: SubTask;
	readonly plan: DagPlan;
	readonly mainAgentSteps: ReadonlyArray<SubTask>;
	readonly triggers: DelegationTriggerConditions;
	readonly subAgent: DelegationAgentProfile;
	readonly riskOverride?: DelegationRiskLevel;
}

export type DelegationDecisionReason =
	| "accepted"
	| "invalid_dag"
	| "missing_long_running_trigger"
	| "missing_decomposable_trigger"
	| "missing_non_blocking_trigger"
	| "missing_sub_agent_capability_trigger"
	| "candidate_not_in_plan"
	| "shared_write_set"
	| "high_risk_write";

export interface DelegationAssignment {
	readonly parentRunId: string;
	readonly childRunId: string;
	readonly taskId: string;
	readonly agent: DelegationAgentProfile;
	readonly writeSet: WriteSet;
	readonly progressReporting: {
		readonly checkpoint: true;
		readonly heartbeat: true;
	};
}

export type DelegationDecision =
	| {
			readonly delegate: true;
			readonly reason: "accepted";
			readonly assignment: DelegationAssignment;
	  }
	| {
			readonly delegate: false;
			readonly reason: Exclude<DelegationDecisionReason, "accepted">;
	  };

function riskFor(candidate: DelegationCandidate): DelegationRiskLevel {
	return candidate.riskOverride ?? candidate.candidateStep.risk ?? "medium";
}

function isDelegableRisk(risk: DelegationRiskLevel): boolean {
	return risk !== "high" && risk !== "critical";
}

function firstMissingTrigger(
	triggers: DelegationTriggerConditions,
): Exclude<DelegationDecisionReason, "accepted"> | null {
	if (!triggers.longRunningTask) {
		return "missing_long_running_trigger";
	}
	if (!triggers.decomposableSubtask) {
		return "missing_decomposable_trigger";
	}
	if (!triggers.nonBlockingSupervisorRequired) {
		return "missing_non_blocking_trigger";
	}
	if (!triggers.subAgentCapabilityAvailable) {
		return "missing_sub_agent_capability_trigger";
	}
	return null;
}

function hasSharedWriteSet(candidate: DelegationCandidate): boolean {
	return candidate.mainAgentSteps.some(
		(mainStep) => !haveIndependentWriteSets(mainStep, candidate.candidateStep),
	);
}

function createChildRunId(parentRunId: string, taskId: string): string {
	return `${parentRunId}:delegated:${taskId}`;
}

export function evaluateDelegation(
	candidate: DelegationCandidate,
): DelegationDecision {
	try {
		assertAcyclicDag(candidate.plan);
	} catch {
		return { delegate: false, reason: "invalid_dag" };
	}

	const missingTrigger = firstMissingTrigger(candidate.triggers);
	if (missingTrigger != null) {
		return { delegate: false, reason: missingTrigger };
	}

	if (
		!candidate.plan.subtasks.some(
			(step) => step.id === candidate.candidateStep.id,
		)
	) {
		return { delegate: false, reason: "candidate_not_in_plan" };
	}

	if (!isDelegableRisk(riskFor(candidate))) {
		return { delegate: false, reason: "high_risk_write" };
	}

	if (hasSharedWriteSet(candidate)) {
		return { delegate: false, reason: "shared_write_set" };
	}

	return {
		delegate: true,
		reason: "accepted",
		assignment: {
			parentRunId: candidate.parentRunId,
			childRunId: createChildRunId(
				candidate.parentRunId,
				candidate.candidateStep.id,
			),
			taskId: candidate.candidateStep.id,
			agent: candidate.subAgent,
			writeSet: getStepWriteSet(candidate.candidateStep),
			progressReporting: {
				checkpoint: true,
				heartbeat: true,
			},
		},
	};
}

export class RuleBasedDelegationStrategy {
	evaluate(candidate: DelegationCandidate): DelegationDecision {
		return evaluateDelegation(candidate);
	}
}
