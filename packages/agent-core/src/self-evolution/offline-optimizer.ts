import { analyzeTrajectoryFailures } from "./failure-analyzer.js";
import {
	createArtifactHash,
	createStableHash,
	createStableRef,
} from "./hash.js";
import {
	createBeforeAfterEvaluation,
	createGeneratedPatchProposal,
} from "./patch-proposal.js";
import type { JsonlProposalStore } from "./proposal-store.js";
import {
	normalizeEvidenceRefs,
	sanitizeForSelfEvolution,
	sanitizeSelfEvolutionString,
} from "./sanitize.js";
import {
	type BeforeAfterEvaluation,
	type CandidateArtifact,
	type FailureAnalysis,
	type FailureFinding,
	type GeneratedPatchProposal,
	LOCAL_NOOP_OPTIMIZER_ID,
	type NoProposalReason,
	type OfflineOptimizerInput,
	type OfflineOptimizerResult,
	type OptimizationProposalDraft,
	type ProposalRiskPreview,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredProposalRecord,
} from "./types.js";

export interface LocalNoopOfflineOptimizerOptions {
	readonly now?: () => Date;
}

function createCandidateArtifact(
	kind: CandidateArtifact["kind"],
	title: string,
	content: string,
	sourceRefs: readonly string[],
): CandidateArtifact {
	const sanitizedContent = String(sanitizeForSelfEvolution(content));
	const sanitizedSourceRefs = normalizeEvidenceRefs(sourceRefs);
	const contentHash = createArtifactHash(sanitizedContent);
	return {
		artifactId: createStableRef("artifact", [kind, title, contentHash]),
		kind,
		title,
		content: sanitizedContent,
		contentHash,
		sourceRefs: sanitizedSourceRefs,
	};
}

function sanitizeNoProposalReason(reason: NoProposalReason): NoProposalReason {
	return {
		...reason,
		message: sanitizeSelfEvolutionString(reason.message),
		evidenceRefs: normalizeEvidenceRefs(reason.evidenceRefs),
	};
}

function missingEvidenceReason(): NoProposalReason {
	return {
		code: "missing_evidence_requires_human_context",
		message:
			"Actionable failure signals require explicit evidence before proposing a change.",
		evidenceRefs: [],
	};
}

function sanitizeFinding(finding: FailureFinding): FailureFinding {
	const evidenceRefs = normalizeEvidenceRefs(finding.evidenceRefs);
	const proposalAllowed = finding.proposalAllowed && evidenceRefs.length > 0;
	const noProposalReason =
		finding.noProposalReason == null
			? undefined
			: sanitizeNoProposalReason(finding.noProposalReason);

	return {
		...finding,
		message: sanitizeSelfEvolutionString(finding.message),
		evidenceRefs,
		proposalAllowed,
		noProposalReason:
			!proposalAllowed && finding.proposalAllowed && evidenceRefs.length === 0
				? missingEvidenceReason()
				: noProposalReason,
	};
}

function dedupeNoProposalReasons(
	reasons: readonly NoProposalReason[],
): readonly NoProposalReason[] {
	const byKey = new Map<string, NoProposalReason>();
	for (const reason of reasons) {
		const key = `${reason.code}:${reason.message}:${reason.evidenceRefs.join("|")}`;
		if (!byKey.has(key)) {
			byKey.set(key, reason);
		}
	}
	return [...byKey.values()];
}

function sanitizeAnalysis(analysis: FailureAnalysis): FailureAnalysis {
	const findings = analysis.findings.map(sanitizeFinding);
	const findingReasons = findings.flatMap((finding) =>
		finding.noProposalReason == null ? [] : [finding.noProposalReason],
	);
	const noProposalReasons = dedupeNoProposalReasons([
		...analysis.noProposalReasons.map(sanitizeNoProposalReason),
		...findingReasons,
	]);

	return {
		...analysis,
		findings,
		noProposalReasons,
		shouldPropose: findings.some((finding) => finding.proposalAllowed),
	};
}

function formatFinding(finding: FailureFinding): string {
	return `- ${finding.category} (${finding.confidence}): ${String(
		sanitizeForSelfEvolution(finding.message),
	)}`;
}

function buildRiskPreview(
	findings: readonly FailureFinding[],
): ProposalRiskPreview {
	return {
		level: "critical",
		reasons: [
			"Generated patch proposal is a synthetic review artifact and must not be applied automatically.",
			"Runtime scaffold patch proposals are critical-risk writes and require WriteAuthority confirmation metadata.",
			...findings.map((finding) => `Evidence category: ${finding.category}`),
		],
		touchesRuntime: true,
		requiresHumanReview: true,
	};
}

function syntheticPatchDiff(
	trajectory: StoredTrajectoryRecord,
	findings: readonly FailureFinding[],
): string {
	const runId = sanitizeSelfEvolutionString(trajectory.runId);
	const categories = findings
		.map((finding) => sanitizeSelfEvolutionString(finding.category))
		.join(", ");
	return [
		"--- a/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
		"+++ b/packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
		"@@ synthetic review proposal @@",
		`+// Add a regression fixture for run ${runId}.`,
		`+// Failure categories covered by the fixture: ${categories}.`,
		"+// Expected result: a pending_review proposal with no automatic scaffold patch application.",
	].join("\n");
}

function beforeAfterEvaluationFor(
	sourceRefs: readonly string[],
	findings: readonly FailureFinding[],
): BeforeAfterEvaluation {
	return createBeforeAfterEvaluation({
		mode: "static_estimate",
		baselineLabel: "Current self-evolution output",
		candidateLabel: "Generated review-only patch proposal",
		summary:
			"Static comparison only. The candidate has not been applied, and the proposal remains pending human review.",
		regressionRisk: "critical",
		evidenceRefs: sourceRefs,
		metrics: [
			{
				name: "actionable findings attached to a reviewable patch proposal",
				baselineValue: 0,
				candidateValue: findings.length,
				unit: "findings",
				direction: "increase_is_better",
				evidenceRefs: sourceRefs,
			},
			{
				name: "automatic scaffold patch applications",
				baselineValue: 0,
				candidateValue: 0,
				unit: "writes",
				direction: "neutral",
				evidenceRefs: sourceRefs,
			},
		],
	});
}

function generatedPatchProposalFor(
	trajectory: StoredTrajectoryRecord,
	sourceRefs: readonly string[],
	findings: readonly FailureFinding[],
	evaluation: BeforeAfterEvaluation,
): GeneratedPatchProposal {
	const runId = sanitizeSelfEvolutionString(trajectory.runId);
	return createGeneratedPatchProposal({
		proposalKind: "scaffold_patch",
		title: `Review-only scaffold patch proposal for ${runId}`,
		summary:
			"Generated synthetic diff for reviewer consideration. The local optimizer cannot apply this patch.",
		sourceRefs,
		beforeAfterEvaluationId: evaluation.evaluationId,
		writeAuthorityPreview: {
			origin: "agent",
			summary: `Review-only scaffold patch proposal for ${runId}`,
		},
		rollbackPlan:
			"No runtime rollback is needed while this remains a proposal. If a human later applies a change, rollback through the same reviewed change path.",
		fileChanges: [
			{
				path: "packages/agent-core/src/self-evolution/failure-analyzer.test.ts",
				changeKind: "modify",
				summary:
					"Add regression coverage for the actionable failure before changing runtime behavior.",
				unifiedDiff: syntheticPatchDiff(trajectory, findings),
			},
		],
	});
}

function hasBooleanMetadataFlag(
	trajectory: StoredTrajectoryRecord,
	key: string,
): boolean {
	return trajectory.metadata?.[key] === true;
}

function hasEvidenceRefWithPrefix(
	findings: readonly FailureFinding[],
	prefix: string,
): boolean {
	return findings.some((finding) =>
		finding.evidenceRefs.some((evidenceRef) => evidenceRef.startsWith(prefix)),
	);
}

function hasSimilarDiagnosticGate(
	findings: readonly FailureFinding[],
): boolean {
	const counts = new Map<string, number>();
	for (const finding of findings) {
		const key = `${finding.category}:${finding.message}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.values()].some((count) => count >= 3);
}

function hasPatchProposalGate(
	trajectory: StoredTrajectoryRecord,
	findings: readonly FailureFinding[],
): boolean {
	return (
		hasSimilarDiagnosticGate(findings) ||
		hasBooleanMetadataFlag(trajectory, "deterministicRegressionFixture") ||
		hasBooleanMetadataFlag(trajectory, "manualCriticalFailure") ||
		hasEvidenceRefWithPrefix(findings, "regression-fixture:") ||
		hasEvidenceRefWithPrefix(findings, "manual-critical:")
	);
}

function insufficientSignalReason(
	trajectory: StoredTrajectoryRecord,
	findings: readonly FailureFinding[],
): NoProposalReason {
	return {
		code: "insufficient_signal",
		message:
			"Scaffold patch proposals require at least three similar diagnostics, a deterministic regression fixture, or a manually marked critical failure.",
		evidenceRefs: normalizeEvidenceRefs([
			trajectory.trajectoryRef,
			trajectory.taskRef,
			...findings.flatMap((finding) => finding.evidenceRefs),
		]),
	};
}

function missingTaskRefReason(
	trajectory: StoredTrajectoryRecord,
	findings: readonly FailureFinding[],
): NoProposalReason {
	return {
		code: "missing_task_ref_requires_linear_issue",
		message:
			"Scaffold patch proposals require a Linear/source issue taskRef before generating review artifacts.",
		evidenceRefs: normalizeEvidenceRefs([
			trajectory.trajectoryRef,
			...findings.flatMap((finding) => finding.evidenceRefs),
		]),
	};
}

interface ProposalAnalysisCandidate {
	readonly proposal: OptimizationProposalDraft | null;
	readonly noProposalReason?: NoProposalReason;
}

function proposalForAnalysis(
	trajectory: StoredTrajectoryRecord,
	analysis: FailureAnalysis,
): ProposalAnalysisCandidate {
	const sanitizedAnalysis = sanitizeAnalysis(analysis);
	const actionableFindings = sanitizedAnalysis.findings.filter(
		(finding) => finding.proposalAllowed,
	);
	if (actionableFindings.length === 0) {
		return { proposal: null };
	}
	if (actionableFindings.some((finding) => finding.evidenceRefs.length === 0)) {
		return { proposal: null };
	}
	if (normalizeEvidenceRefs([trajectory.taskRef]).length === 0) {
		return {
			proposal: null,
			noProposalReason: missingTaskRefReason(trajectory, actionableFindings),
		};
	}
	if (!hasPatchProposalGate(trajectory, actionableFindings)) {
		return {
			proposal: null,
			noProposalReason: insufficientSignalReason(
				trajectory,
				actionableFindings,
			),
		};
	}

	const sourceRefs = normalizeEvidenceRefs([
		trajectory.trajectoryRef,
		trajectory.taskRef,
		...actionableFindings.flatMap((finding) => finding.evidenceRefs),
	]);
	const runId = sanitizeSelfEvolutionString(trajectory.runId);
	const trajectoryRef = sanitizeSelfEvolutionString(trajectory.trajectoryRef);
	const taskRef = normalizeEvidenceRefs([trajectory.taskRef])[0];
	const beforeAfterEvaluation = beforeAfterEvaluationFor(
		sourceRefs,
		actionableFindings,
	);
	const generatedPatchProposal = generatedPatchProposalFor(
		trajectory,
		sourceRefs,
		actionableFindings,
		beforeAfterEvaluation,
	);
	const markdown = [
		`# Self-evolution proposal for ${runId}`,
		"",
		"## Findings",
		...actionableFindings.map(formatFinding),
		"",
		"## Before/after evaluation",
		beforeAfterEvaluation.summary,
		"",
		"## Generated patch proposal",
		`Patch proposal id: ${generatedPatchProposal.patchProposalId}`,
		`Application mode: ${generatedPatchProposal.safetyBoundary.applicationMode}`,
		...(taskRef == null ? [] : [`Task reference: ${taskRef}`]),
		"",
		"## Review boundary",
		"This local optimizer only emits candidate artifacts. It does not write source files or apply scaffold/runtime changes.",
	].join("\n");
	const json = JSON.stringify(
		{
			runId,
			trajectoryRef,
			taskRef,
			findings: sanitizeForSelfEvolution(actionableFindings),
			beforeAfterEvaluation,
			generatedPatchProposal,
		},
		null,
		2,
	);
	const artifacts = [
		createCandidateArtifact(
			"markdown",
			"Failure review summary",
			markdown,
			sourceRefs,
		),
		createCandidateArtifact(
			"json",
			"Failure analysis payload",
			json,
			sourceRefs,
		),
		createCandidateArtifact(
			"patch",
			"Synthetic patch proposal",
			generatedPatchProposal.fileChanges
				.map((change) => change.unifiedDiff)
				.join("\n\n"),
			sourceRefs,
		),
	];
	const evidenceHashes = [
		trajectory.contentHash,
		...actionableFindings.map((finding) => createStableHash(finding)),
		createStableHash(beforeAfterEvaluation),
		createStableHash(generatedPatchProposal),
	];

	return {
		proposal: {
			title: `Review self-evolution finding for ${runId}`,
			summary:
				"Local no-op optimizer found deterministic failure signals and produced review-only patch proposal artifacts.",
			artifacts,
			evidenceHashes,
			riskPreview: buildRiskPreview(actionableFindings),
			generatedPatchProposal,
			beforeAfterEvaluation,
			metadata: {
				optimizer_id: LOCAL_NOOP_OPTIMIZER_ID,
				trajectory_ref: trajectoryRef,
				...(taskRef == null ? {} : { task_ref: taskRef }),
				patch_proposal_id: generatedPatchProposal.patchProposalId,
				before_after_evaluation_id: beforeAfterEvaluation.evaluationId,
				application_mode: "proposal_only",
				write_authority_tool: generatedPatchProposal.writeAuthorityPreview.tool,
				write_authority_origin:
					generatedPatchProposal.writeAuthorityPreview.origin,
				write_authority_risk_level:
					generatedPatchProposal.writeAuthorityPreview.riskLevel,
			},
		},
	};
}

function analysisByTrajectoryRef(
	analyses: readonly FailureAnalysis[],
): ReadonlyMap<string, FailureAnalysis> {
	return new Map(
		analyses.map((analysis) => [analysis.trajectoryRef, analysis] as const),
	);
}

export class LocalNoopOfflineOptimizer {
	private readonly now: () => Date;

	constructor(options: LocalNoopOfflineOptimizerOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	optimize(input: OfflineOptimizerInput): OfflineOptimizerResult {
		const createdAt = (input.now ?? this.now)().toISOString();
		const providedAnalyses = analysisByTrajectoryRef(input.analyses ?? []);
		const analyses = input.trajectories.map((trajectory) =>
			sanitizeAnalysis(
				providedAnalyses.get(trajectory.trajectoryRef) ??
					analyzeTrajectoryFailures(trajectory),
			),
		);
		const proposalCandidates = input.trajectories.map((trajectory, index) =>
			proposalForAnalysis(trajectory, analyses[index] as FailureAnalysis),
		);
		const gatedNoProposalReasons = proposalCandidates.flatMap((candidate) =>
			candidate.noProposalReason === undefined
				? []
				: [candidate.noProposalReason],
		);
		const noProposalReasons: NoProposalReason[] = [
			...analyses.flatMap((analysis) =>
				analysis.shouldPropose ? [] : analysis.noProposalReasons,
			),
			...gatedNoProposalReasons,
		];

		return {
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			optimizerId: LOCAL_NOOP_OPTIMIZER_ID,
			mode: "artifact_only",
			createdAt,
			proposals: proposalCandidates
				.map((candidate) => candidate.proposal)
				.filter(
					(proposal): proposal is OptimizationProposalDraft =>
						proposal !== null,
				),
			noProposalReasons,
		};
	}

	async runOptimizationCycle(
		input: OfflineOptimizerInput,
		proposalStore: JsonlProposalStore,
	): Promise<readonly StoredProposalRecord[]> {
		const result = this.optimize(input);
		const storedProposals: StoredProposalRecord[] = [];
		for (const proposal of result.proposals) {
			const stored = await proposalStore.append(proposal);
			storedProposals.push(stored);
		}
		return storedProposals;
	}
}
