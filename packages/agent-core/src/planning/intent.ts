import type {
	Intent,
	IntentClassification,
	IntentClassifier,
	LLMPlannerResponse,
} from "./types.js";

export const DEFAULT_AUDIT_CONFIDENCE_THRESHOLD = 0.85;

export interface IntentDispatchOptions {
	readonly auditConfidenceThreshold?: number;
	readonly latencyMs?: number;
}

function normalizeLatency(latencyMs: number | undefined): number {
	return latencyMs == null || latencyMs < 0 ? 0 : latencyMs;
}

export function deriveStructuralIntent(response: LLMPlannerResponse): Intent {
	if (response.needClarification != null) {
		return "CLARIFICATION";
	}

	if (response.planSketch != null) {
		return "MULTI_STEP";
	}

	const toolCallCount = response.toolCalls?.length ?? 0;
	if (toolCallCount > 1) {
		return "MULTI_STEP";
	}

	if (toolCallCount === 1) {
		return "SINGLE_TOOL";
	}

	return "SIMPLE_QA";
}

function shouldUseAuditIntent(
	response: LLMPlannerResponse,
	structuralIntent: Intent,
	auditConfidenceThreshold: number,
): boolean {
	if (response.audit == null) {
		return false;
	}

	if (response.audit.confidence < auditConfidenceThreshold) {
		return false;
	}

	return (
		structuralIntent === "SIMPLE_QA" ||
		response.audit.intentHint === structuralIntent
	);
}

export function dispatchIntent(
	response: LLMPlannerResponse,
	options: IntentDispatchOptions = {},
): IntentClassification {
	const structuralIntent = deriveStructuralIntent(response);
	const latencyMs = normalizeLatency(options.latencyMs);
	const auditConfidenceThreshold =
		options.auditConfidenceThreshold ?? DEFAULT_AUDIT_CONFIDENCE_THRESHOLD;

	if (
		shouldUseAuditIntent(
			response,
			structuralIntent,
			auditConfidenceThreshold,
		) &&
		response.audit != null
	) {
		return {
			intent: response.audit.intentHint,
			confidence: response.audit.confidence,
			source: "audit",
			latencyMs,
			reasoningDigest: response.audit.reasoningDigest,
		};
	}

	return {
		intent: structuralIntent,
		confidence: 1,
		source: "structural",
		latencyMs,
	};
}

export const classifyIntent = dispatchIntent;

export class StructuralIntentClassifier implements IntentClassifier {
	constructor(private readonly options: IntentDispatchOptions = {}) {}

	dispatch(response: LLMPlannerResponse): IntentClassification {
		return dispatchIntent(response, this.options);
	}
}
