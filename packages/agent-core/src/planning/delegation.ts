import { assertAcyclicDag, getStepWriteSet, type WriteSet } from "./dag.js";
import type { DagPlan, RiskLevel, SubTask } from "./types.js";

export const DELEGATION_HANDOFF_SCHEMA_VERSION = 2;

export type DelegationRiskLevel = "safe" | RiskLevel | "critical";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };
export type JsonRecord = { readonly [key: string]: JsonValue };

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

export interface DelegationHandoffTask {
	readonly id: string;
	readonly action: string;
	readonly name: string;
	readonly description: string;
	readonly estimatedTokens: number;
	readonly estimatedSteps: number;
	readonly preconditions: ReadonlyArray<string>;
	readonly effects: ReadonlyArray<string>;
	readonly skillHint?: string;
	readonly arguments?: JsonRecord;
}

export interface DelegationHandoffReceiver {
	readonly role: string;
	readonly requiredCapabilities: ReadonlyArray<string>;
}

export interface DelegationRetryPolicy {
	readonly maxAttempts: number;
	readonly backoff: "none" | "linear" | "exponential";
}

export interface DelegationResumeContract {
	readonly checkpointRequired: true;
	readonly heartbeatRequired: true;
	readonly resumeFrom: "latest_checkpoint";
	readonly checkpointOwner: "child_agent";
}

export interface DelegationWriteAuthorityEnvelope {
	readonly gate: "WriteAuthority";
	readonly origin: "delegation";
	readonly required: true;
	readonly risk: DelegationRiskLevel;
	readonly scope: WriteSet["scope"];
	readonly canonicalResources: ReadonlyArray<string>;
}

export interface DelegationCancellationStrategy {
	readonly token: string;
	readonly mode: "cooperative";
	readonly requestedBy: "parent_or_supervisor";
	readonly reasonRequired: true;
}

export interface DelegationTraceEnvelope {
	readonly traceId: string;
	readonly parentRunId: string;
	readonly childRunId: string;
	readonly spanId: string;
	readonly schemaRef: "planning.delegation.trace.v1";
}

export interface DelegationHandoff {
	readonly kind: "delegation_handoff";
	readonly schemaVersion: typeof DELEGATION_HANDOFF_SCHEMA_VERSION;
	readonly route: "sub_agent";
	readonly traceId: string;
	readonly parentRunId: string;
	readonly childRunId: string;
	readonly task: DelegationHandoffTask;
	readonly agent: DelegationAgentProfile;
	readonly receiver: DelegationHandoffReceiver;
	readonly inputSchemaRef: string;
	readonly inputPayload: JsonRecord;
	readonly historyFilter: "task_only";
	readonly writeSet: WriteSet;
	readonly writeScope: ReadonlyArray<string>;
	readonly writeAuthority: DelegationWriteAuthorityEnvelope;
	readonly risk: DelegationRiskLevel;
	readonly retryPolicy: DelegationRetryPolicy;
	readonly cancelToken: string;
	readonly cancellation: DelegationCancellationStrategy;
	readonly trace: DelegationTraceEnvelope;
	readonly idempotencyKey: string;
	readonly resultSchemaRef: string;
	readonly resume: DelegationResumeContract;
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
	| "high_risk_write"
	| "unknown_write_set"
	| "non_serializable_handoff";

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
	readonly handoff: DelegationHandoff;
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

function normalizeWriteResource(resource: string): string {
	const normalizedSeparators = resource.trim().replaceAll("\\", "/");
	const isAbsolute = normalizedSeparators.startsWith("/");
	const segments: string[] = [];

	for (const segment of normalizedSeparators.split("/")) {
		if (segment.length === 0 || segment === ".") {
			continue;
		}

		if (segment === "..") {
			const previous = segments.at(-1);
			if (previous != null && previous !== "..") {
				segments.pop();
				continue;
			}
			if (!isAbsolute) {
				segments.push(segment);
			}
			continue;
		}

		segments.push(segment);
	}

	const normalized = segments.join("/");
	if (isAbsolute) {
		return `/${normalized}`;
	}
	return normalized.length === 0 ? "." : normalized;
}

function normalizedResourceSet(writeSet: WriteSet): ReadonlySet<string> {
	return new Set(writeSet.resources.map(normalizeWriteResource));
}

function haveOverlappingWriteSets(left: WriteSet, right: WriteSet): boolean {
	if (left.scope === "none" || right.scope === "none") {
		return false;
	}

	if (left.scope !== right.scope) {
		return false;
	}

	if (left.unknown || right.unknown) {
		return true;
	}

	const rightResources = normalizedResourceSet(right);
	return [...normalizedResourceSet(left)].some((resource) =>
		rightResources.has(resource),
	);
}

function hasSharedWriteSet(candidate: DelegationCandidate): boolean {
	const candidateWriteSet = getStepWriteSet(candidate.candidateStep);
	return candidate.mainAgentSteps.some((mainStep) =>
		haveOverlappingWriteSets(getStepWriteSet(mainStep), candidateWriteSet),
	);
}

function createChildRunId(parentRunId: string, taskId: string): string {
	return `${parentRunId}:delegated:${taskId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function toJsonValue(
	value: unknown,
	seen: Set<object> = new Set(),
): JsonValue | undefined {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}

	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return undefined;
		}

		seen.add(value);
		const values: JsonValue[] = [];
		for (const item of value) {
			const jsonItem = toJsonValue(item, seen);
			if (jsonItem === undefined) {
				return undefined;
			}
			values.push(jsonItem);
		}
		seen.delete(value);
		return values;
	}

	if (!isPlainRecord(value)) {
		return undefined;
	}

	if (seen.has(value)) {
		return undefined;
	}

	seen.add(value);
	const record: Record<string, JsonValue> = {};
	for (const [key, item] of Object.entries(value)) {
		const jsonItem = toJsonValue(item, seen);
		if (jsonItem === undefined) {
			return undefined;
		}
		record[key] = jsonItem;
	}
	seen.delete(value);
	return record;
}

function toJsonRecord(value: unknown): JsonRecord | null {
	if (value == null) {
		return {};
	}

	const jsonValue = toJsonValue(value);
	return isPlainRecord(jsonValue) ? jsonValue : null;
}

function createHandoffTask(
	step: SubTask,
	inputPayload: JsonRecord,
): DelegationHandoffTask {
	return {
		id: step.id,
		action: step.action,
		name: step.name,
		description: step.description,
		estimatedTokens: step.estimatedTokens,
		estimatedSteps: step.estimatedSteps,
		preconditions: step.preconditions,
		effects: step.effects,
		...(step.skillHint == null ? {} : { skillHint: step.skillHint }),
		...(Object.keys(inputPayload).length === 0
			? {}
			: { arguments: inputPayload }),
	};
}

function requiredCapabilities(step: SubTask): readonly string[] {
	return [
		...new Set([step.action, step.skillHint].filter(Boolean) as string[]),
	];
}

function writeScopeFor(writeSet: WriteSet): readonly string[] {
	if (writeSet.scope === "none") {
		return [];
	}

	return [...normalizedResourceSet(writeSet)]
		.sort((left, right) => left.localeCompare(right))
		.map((resource) => `${writeSet.scope}:${resource}`);
}

function canonicalResourcesFor(writeSet: WriteSet): readonly string[] {
	return [...normalizedResourceSet(writeSet)].sort((left, right) =>
		left.localeCompare(right),
	);
}

function createDelegationHandoff(
	candidate: DelegationCandidate,
	childRunId: string,
	writeSet: WriteSet,
	risk: DelegationRiskLevel,
	inputPayload: JsonRecord,
): DelegationHandoff {
	const traceId = `${childRunId}:handoff`;
	const cancelToken = `${childRunId}:cancel`;
	const canonicalResources = canonicalResourcesFor(writeSet);

	return {
		kind: "delegation_handoff",
		schemaVersion: DELEGATION_HANDOFF_SCHEMA_VERSION,
		route: "sub_agent",
		traceId,
		parentRunId: candidate.parentRunId,
		childRunId,
		task: createHandoffTask(candidate.candidateStep, inputPayload),
		agent: candidate.subAgent,
		receiver: {
			role: candidate.subAgent.role,
			requiredCapabilities: requiredCapabilities(candidate.candidateStep),
		},
		inputSchemaRef: "planning.subtask.arguments.v1",
		inputPayload,
		historyFilter: "task_only",
		writeSet,
		writeScope: writeScopeFor(writeSet),
		writeAuthority: {
			gate: "WriteAuthority",
			origin: "delegation",
			required: true,
			risk,
			scope: writeSet.scope,
			canonicalResources,
		},
		risk,
		retryPolicy: {
			maxAttempts: 1,
			backoff: "none",
		},
		cancelToken,
		cancellation: {
			token: cancelToken,
			mode: "cooperative",
			requestedBy: "parent_or_supervisor",
			reasonRequired: true,
		},
		trace: {
			traceId,
			parentRunId: candidate.parentRunId,
			childRunId,
			spanId: `${traceId}:span`,
			schemaRef: "planning.delegation.trace.v1",
		},
		idempotencyKey: `delegation:${candidate.parentRunId}:${candidate.candidateStep.id}:${writeSet.scope}:${canonicalResources.join(",")}`,
		resultSchemaRef: "planning.delegation.result.v1",
		resume: {
			checkpointRequired: true,
			heartbeatRequired: true,
			resumeFrom: "latest_checkpoint",
			checkpointOwner: "child_agent",
		},
	};
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

	const risk = riskFor(candidate);
	if (!isDelegableRisk(risk)) {
		return { delegate: false, reason: "high_risk_write" };
	}

	const writeSet = getStepWriteSet(candidate.candidateStep);
	if (writeSet.unknown) {
		return { delegate: false, reason: "unknown_write_set" };
	}

	if (hasSharedWriteSet(candidate)) {
		return { delegate: false, reason: "shared_write_set" };
	}

	const inputPayload = toJsonRecord(candidate.candidateStep.arguments);
	if (inputPayload == null) {
		return { delegate: false, reason: "non_serializable_handoff" };
	}

	const childRunId = createChildRunId(
		candidate.parentRunId,
		candidate.candidateStep.id,
	);

	return {
		delegate: true,
		reason: "accepted",
		assignment: {
			parentRunId: candidate.parentRunId,
			childRunId,
			taskId: candidate.candidateStep.id,
			agent: candidate.subAgent,
			writeSet,
			progressReporting: {
				checkpoint: true,
				heartbeat: true,
			},
			handoff: createDelegationHandoff(
				candidate,
				childRunId,
				writeSet,
				risk,
				inputPayload,
			),
		},
	};
}

export class RuleBasedDelegationStrategy {
	evaluate(candidate: DelegationCandidate): DelegationDecision {
		return evaluateDelegation(candidate);
	}
}
