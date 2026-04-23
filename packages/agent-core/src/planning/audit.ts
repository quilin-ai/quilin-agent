import { classifyIntent, deriveStructuralIntent } from "./intent.js";
import type {
	Intent,
	IntentClassification,
	LLMPlannerResponse,
	PlannerAudit,
} from "./types.js";

export interface PlannerAuditObservation {
	readonly structuralIntent: Intent;
	readonly dispatchedIntent: Intent;
	readonly dispatchSource: IntentClassification["source"];
	readonly intentHint: Intent | null;
	readonly confidence: number | null;
	readonly reasoningDigest?: string;
	readonly matchesStructural: boolean | null;
	readonly matchesDispatched: boolean | null;
}

export interface AuditAgreementMetrics {
	readonly totalSamples: number;
	readonly auditedSamples: number;
	readonly structuralMatches: number;
	readonly dispatchedMatches: number;
	readonly structuralAgreementRate: number;
	readonly dispatchedAgreementRate: number;
}

function toObservation(
	structuralIntent: Intent,
	dispatched: IntentClassification,
	audit: PlannerAudit | undefined,
): PlannerAuditObservation {
	if (audit == null) {
		return {
			structuralIntent,
			dispatchedIntent: dispatched.intent,
			dispatchSource: dispatched.source,
			intentHint: null,
			confidence: null,
			matchesStructural: null,
			matchesDispatched: null,
		};
	}

	return {
		structuralIntent,
		dispatchedIntent: dispatched.intent,
		dispatchSource: dispatched.source,
		intentHint: audit.intentHint,
		confidence: audit.confidence,
		reasoningDigest: audit.reasoningDigest,
		matchesStructural: audit.intentHint === structuralIntent,
		matchesDispatched: audit.intentHint === dispatched.intent,
	};
}

function ratio(matches: number, total: number): number {
	if (total === 0) {
		return 0;
	}

	return matches / total;
}

export function observePlannerAudit(
	response: LLMPlannerResponse,
): PlannerAuditObservation {
	const structuralIntent = deriveStructuralIntent(response);
	const dispatched = classifyIntent(response);

	return toObservation(structuralIntent, dispatched, response.audit);
}

export function computeAuditAgreement(
	observations: ReadonlyArray<PlannerAuditObservation>,
): AuditAgreementMetrics {
	const auditedSamples = observations.filter(
		(observation) => observation.intentHint != null,
	);
	const structuralMatches = auditedSamples.filter(
		(observation) => observation.matchesStructural === true,
	).length;
	const dispatchedMatches = auditedSamples.filter(
		(observation) => observation.matchesDispatched === true,
	).length;

	return {
		totalSamples: observations.length,
		auditedSamples: auditedSamples.length,
		structuralMatches,
		dispatchedMatches,
		structuralAgreementRate: ratio(structuralMatches, auditedSamples.length),
		dispatchedAgreementRate: ratio(dispatchedMatches, auditedSamples.length),
	};
}
