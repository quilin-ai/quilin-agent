import { normalizeEvidenceRefs, sanitizeForSelfEvolution } from "./sanitize.js";
import {
	type FailureAnalysis,
	type FailureCategory,
	type FailureConfidence,
	type FailureFinding,
	type NoProposalReason,
	type NoProposalReasonCode,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredTrajectoryRecord,
	type TrajectoryFailure,
	type TrajectoryStep,
} from "./types.js";

const CATEGORY_PATTERNS: ReadonlyArray<{
	readonly category: FailureCategory;
	readonly confidence: FailureConfidence;
	readonly pattern: RegExp;
}> = [
	{
		category: "schema_violation",
		confidence: "high",
		pattern: /\b(schema|zod|validation|invalid json|parse error)\b/iu,
	},
	{
		category: "budget_exhaustion",
		confidence: "high",
		pattern:
			/\b(budget exhausted|token budget|context length|max(?:imum)? tokens|quota)\b/iu,
	},
	{
		category: "missing_evidence",
		confidence: "high",
		pattern:
			/\b(missing evidence|no evidence|citation required|insufficient evidence|unsupported claim)\b/iu,
	},
	{
		category: "tool_error",
		confidence: "medium",
		pattern:
			/\b(tool error|command failed|exit code|enoent|timeout|permission denied)\b/iu,
	},
];

function noProposalReasonFor(
	category: FailureCategory,
	evidenceRefs: readonly string[],
	proposalAllowed = false,
): NoProposalReason | undefined {
	if (proposalAllowed && evidenceRefs.length === 0) {
		return {
			code: "missing_evidence_requires_human_context",
			message:
				"Actionable failure signals require explicit evidence before proposing a change.",
			evidenceRefs,
		};
	}

	const reasonByCategory: Partial<
		Record<
			FailureCategory,
			{ readonly code: NoProposalReasonCode; readonly message: string }
		>
	> = {
		budget_exhaustion: {
			code: "budget_policy_requires_human_review",
			message:
				"Budget exhaustion can imply policy or product tradeoffs, so no runtime proposal is generated automatically.",
		},
		missing_evidence: {
			code: "missing_evidence_requires_human_context",
			message:
				"Missing evidence requires human context or additional retrieval before proposing a change.",
		},
		unknown: {
			code: "unknown_failure_not_actionable",
			message: "The failure did not match a deterministic actionable category.",
		},
	};
	const reason = reasonByCategory[category];
	if (reason == null) {
		return undefined;
	}

	return {
		...reason,
		evidenceRefs,
	};
}

function stringifyEvidence(value: unknown): string {
	const sanitized = sanitizeForSelfEvolution(value);
	if (typeof sanitized === "string") {
		return sanitized;
	}

	return JSON.stringify(sanitized);
}

function classifyMessage(
	message: string,
	fallbackCategory?: FailureCategory,
): Pick<FailureFinding, "category" | "confidence" | "proposalAllowed"> {
	if (fallbackCategory != null) {
		return {
			category: fallbackCategory,
			confidence: "high",
			proposalAllowed:
				fallbackCategory === "tool_error" ||
				fallbackCategory === "schema_violation",
		};
	}

	for (const candidate of CATEGORY_PATTERNS) {
		if (candidate.pattern.test(message)) {
			return {
				category: candidate.category,
				confidence: candidate.confidence,
				proposalAllowed:
					candidate.category === "tool_error" ||
					candidate.category === "schema_violation",
			};
		}
	}

	return {
		category: "unknown",
		confidence: "low",
		proposalAllowed: false,
	};
}

function findingFromFailure(failure: TrajectoryFailure): FailureFinding {
	const evidenceRefs = normalizeEvidenceRefs(failure.evidenceRefs);
	const classification = classifyMessage(failure.message, failure.category);
	const noProposalReason = noProposalReasonFor(
		classification.category,
		evidenceRefs,
		classification.proposalAllowed,
	);

	return {
		...classification,
		message: stringifyEvidence(failure.message),
		evidenceRefs,
		proposalAllowed: classification.proposalAllowed && evidenceRefs.length > 0,
		noProposalReason,
	};
}

function findingFromStep(step: TrajectoryStep): FailureFinding | null {
	if (step.error === undefined) {
		return null;
	}

	const message = stringifyEvidence(step.error);
	const evidenceRefs = normalizeEvidenceRefs(step.evidenceRefs);
	const classification = classifyMessage(message);
	if (
		step.kind === "tool" &&
		classification.category === "unknown" &&
		step.error !== undefined
	) {
		return {
			category: "tool_error",
			confidence: "medium",
			message,
			evidenceRefs,
			proposalAllowed: evidenceRefs.length > 0,
			noProposalReason: noProposalReasonFor("tool_error", evidenceRefs, true),
		};
	}

	const noProposalReason = noProposalReasonFor(
		classification.category,
		evidenceRefs,
		classification.proposalAllowed,
	);

	return {
		...classification,
		message,
		evidenceRefs,
		proposalAllowed: classification.proposalAllowed && evidenceRefs.length > 0,
		noProposalReason,
	};
}

function dedupeFindings(
	findings: readonly FailureFinding[],
): readonly FailureFinding[] {
	const byKey = new Map<string, FailureFinding>();
	for (const finding of findings) {
		const key = `${finding.category}:${finding.message}`;
		if (!byKey.has(key)) {
			byKey.set(key, finding);
		}
	}
	return [...byKey.values()];
}

export function analyzeTrajectoryFailures(
	trajectory: StoredTrajectoryRecord,
): FailureAnalysis {
	const explicitFindings = (trajectory.failures ?? []).map(findingFromFailure);
	const stepFindings = trajectory.steps
		.map(findingFromStep)
		.filter((finding): finding is FailureFinding => finding !== null);
	const findings = dedupeFindings([...explicitFindings, ...stepFindings]);
	const noProposalReasons =
		findings.length === 0
			? [
					{
						code: "no_failure_detected" as const,
						message:
							"No failure signal was found in the trajectory, so no proposal is generated.",
						evidenceRefs: [trajectory.trajectoryRef],
					},
				]
			: findings.flatMap((finding) =>
					finding.noProposalReason == null ? [] : [finding.noProposalReason],
				);

	return {
		schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
		runId: trajectory.runId,
		trajectoryRef: trajectory.trajectoryRef,
		findings,
		noProposalReasons,
		shouldPropose: findings.some((finding) => finding.proposalAllowed),
	};
}
