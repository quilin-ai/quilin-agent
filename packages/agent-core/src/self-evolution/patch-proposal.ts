import { createStableRef } from "./hash.js";
import {
	normalizeEvidenceRefs,
	sanitizeForSelfEvolution,
	sanitizeSelfEvolutionString,
} from "./sanitize.js";
import type {
	BeforeAfterEvaluation,
	BeforeAfterEvaluationMetric,
	EvaluationMetricDirection,
	EvaluationMetricValue,
	EvaluationMode,
	GeneratedPatchChangeKind,
	GeneratedPatchDiffKind,
	GeneratedPatchFileChange,
	GeneratedPatchProposal,
	GeneratedPatchProposalKind,
	GeneratedPatchWriteAuthorityPreview,
	GeneratedPatchWriteOrigin,
	PatchProposalSafetyBoundary,
	ProposalRiskLevel,
} from "./types.js";

export const SELF_EVOLUTION_PATCH_ALLOWED_PATH_PREFIXES = [
	"packages/agent-core/src/self-evolution/",
] as const;

const DEFAULT_FORBIDDEN_PATCH_PATH_PATTERNS = [
	"agent-bridge.md",
	".env",
	"packages/agent-core/src/safety/",
] as const;

const VALID_EVALUATION_MODES = new Set<EvaluationMode>([
	"static_estimate",
	"measured",
	"not_run",
]);
const VALID_METRIC_DIRECTIONS = new Set<EvaluationMetricDirection>([
	"increase_is_better",
	"decrease_is_better",
	"neutral",
]);
const VALID_RISK_LEVELS = new Set<ProposalRiskLevel>([
	"low",
	"medium",
	"high",
	"critical",
]);
const VALID_PATCH_KINDS = new Set<GeneratedPatchProposalKind>([
	"regression_fixture_patch",
	"scaffold_patch",
]);
const VALID_CHANGE_KINDS = new Set<GeneratedPatchChangeKind>([
	"add",
	"modify",
	"delete",
]);
const VALID_DIFF_KINDS = new Set<GeneratedPatchDiffKind>([
	"synthetic_unified_diff",
]);

export interface BeforeAfterEvaluationMetricInput {
	readonly name: string;
	readonly baselineValue: EvaluationMetricValue;
	readonly candidateValue: EvaluationMetricValue;
	readonly unit?: string;
	readonly direction: EvaluationMetricDirection;
	readonly evidenceRefs?: readonly unknown[];
}

export interface BeforeAfterEvaluationInput {
	readonly mode?: EvaluationMode;
	readonly baselineLabel: string;
	readonly candidateLabel: string;
	readonly summary: string;
	readonly metrics: readonly BeforeAfterEvaluationMetricInput[];
	readonly regressionRisk?: ProposalRiskLevel;
	readonly evidenceRefs: readonly unknown[];
}

export interface PatchProposalSafetyBoundaryInput {
	readonly allowedPathPrefixes?: readonly string[];
	readonly forbiddenPathPatterns?: readonly string[];
	readonly rationale?: string;
}

export interface GeneratedPatchFileChangeInput {
	readonly path: string;
	readonly changeKind: GeneratedPatchChangeKind;
	readonly diffKind?: GeneratedPatchDiffKind;
	readonly summary: string;
	readonly unifiedDiff: string;
}

export interface GeneratedPatchWriteAuthorityPreviewInput {
	readonly origin?: GeneratedPatchWriteOrigin;
	readonly summary?: string;
}

export interface GeneratedPatchProposalInput {
	readonly proposalKind: GeneratedPatchProposalKind;
	readonly title: string;
	readonly summary: string;
	readonly fileChanges: readonly GeneratedPatchFileChangeInput[];
	readonly sourceRefs: readonly unknown[];
	readonly beforeAfterEvaluationId: string;
	readonly writeAuthorityPreview?: GeneratedPatchWriteAuthorityPreviewInput;
	readonly rollbackPlan: string;
	readonly safetyBoundary?: PatchProposalSafetyBoundaryInput;
}

function assertNonEmptyString(value: string, field: string): string {
	const sanitized = sanitizeSelfEvolutionString(value).trim();
	if (sanitized.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return sanitized;
}

function normalizePatchPath(value: string, field: string): string {
	const sanitized = assertNonEmptyString(value, field).replace(/\\/gu, "/");
	if (/^[a-z][a-z0-9+.-]*:/iu.test(sanitized) || sanitized.startsWith("/")) {
		throw new TypeError(`${field} must be a repository-relative path`);
	}

	const segments = sanitized.split("/");
	if (segments.some((segment) => segment === "" || segment === ".")) {
		throw new TypeError(`${field} must not contain empty path segments`);
	}
	if (segments.some((segment) => segment === "..")) {
		throw new TypeError(`${field} must not traverse outside the repository`);
	}

	return sanitized;
}

function normalizePatchPrefix(value: string): string {
	const normalized = normalizePatchPath(
		value.replace(/[\\/]+$/u, ""),
		"Patch proposal allowedPathPrefix",
	);
	return `${normalized}/`;
}

function normalizeForbiddenPattern(value: string): string {
	return sanitizeSelfEvolutionString(value).trim().replace(/\\/gu, "/");
}

function pathMatchesForbiddenPattern(
	filePath: string,
	forbiddenPattern: string,
): boolean {
	if (forbiddenPattern.length === 0) {
		return false;
	}
	const directoryPattern = forbiddenPattern.endsWith("/")
		? forbiddenPattern
		: `${forbiddenPattern}/`;
	return (
		filePath === forbiddenPattern ||
		filePath.startsWith(directoryPattern) ||
		filePath.includes(forbiddenPattern)
	);
}

function isPathAllowed(
	filePath: string,
	boundary: PatchProposalSafetyBoundary,
): boolean {
	return boundary.allowedPathPrefixes.some((prefix) =>
		filePath.startsWith(normalizePatchPrefix(prefix)),
	);
}

function assertPathAllowed(
	filePath: string,
	boundary: PatchProposalSafetyBoundary,
): void {
	if (!isPathAllowed(filePath, boundary)) {
		throw new TypeError(
			"Generated patch proposal file path must stay within the allowed prefixes",
		);
	}

	const forbiddenPattern = boundary.forbiddenPathPatterns.find((pattern) =>
		pathMatchesForbiddenPattern(filePath, normalizeForbiddenPattern(pattern)),
	);
	if (forbiddenPattern !== undefined) {
		throw new TypeError(
			`Generated patch proposal file path is blocked by ${forbiddenPattern}`,
		);
	}
}

function sanitizeMetricValue(
	value: EvaluationMetricValue,
): EvaluationMetricValue {
	const sanitized = sanitizeForSelfEvolution(value);
	if (
		typeof sanitized === "string" ||
		typeof sanitized === "number" ||
		typeof sanitized === "boolean"
	) {
		return sanitized;
	}
	return JSON.stringify(sanitized);
}

function sanitizeMetric(
	metric: BeforeAfterEvaluationMetricInput,
): BeforeAfterEvaluationMetric {
	if (!VALID_METRIC_DIRECTIONS.has(metric.direction)) {
		throw new TypeError("Before/after evaluation metric direction is invalid");
	}
	const evidenceRefs = normalizeEvidenceRefs(metric.evidenceRefs);
	if (evidenceRefs.length === 0) {
		throw new TypeError(
			"Before/after metric evidence refs must include explicit evidence refs",
		);
	}

	return {
		name: assertNonEmptyString(metric.name, "Before/after metric name"),
		baselineValue: sanitizeMetricValue(metric.baselineValue),
		candidateValue: sanitizeMetricValue(metric.candidateValue),
		unit:
			metric.unit === undefined
				? undefined
				: assertNonEmptyString(metric.unit, "Before/after metric unit"),
		direction: metric.direction,
		evidenceRefs,
	};
}

export function createBeforeAfterEvaluation(
	input: BeforeAfterEvaluationInput,
): BeforeAfterEvaluation {
	const mode = input.mode ?? "static_estimate";
	if (!VALID_EVALUATION_MODES.has(mode)) {
		throw new TypeError("Before/after evaluation mode is invalid");
	}
	const regressionRisk = input.regressionRisk ?? "critical";
	if (!VALID_RISK_LEVELS.has(regressionRisk)) {
		throw new TypeError("Before/after evaluation regression risk is invalid");
	}
	const metrics = input.metrics.map(sanitizeMetric);
	if (metrics.length === 0) {
		throw new TypeError("Before/after evaluation must include metrics");
	}
	const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
	if (evidenceRefs.length === 0) {
		throw new TypeError("Before/after evaluation must include evidence refs");
	}

	const payload = {
		mode,
		baselineLabel: assertNonEmptyString(
			input.baselineLabel,
			"Before/after baseline label",
		),
		candidateLabel: assertNonEmptyString(
			input.candidateLabel,
			"Before/after candidate label",
		),
		summary: assertNonEmptyString(
			input.summary,
			"Before/after evaluation summary",
		),
		metrics,
		regressionRisk,
		evidenceRefs,
	};

	return {
		evaluationId: createStableRef("evaluation", [payload]),
		...payload,
		requiresHumanReview: true,
	};
}

export function createPatchProposalSafetyBoundary(
	input: PatchProposalSafetyBoundaryInput = {},
): PatchProposalSafetyBoundary {
	const allowedPathPrefixes = (
		input.allowedPathPrefixes ?? SELF_EVOLUTION_PATCH_ALLOWED_PATH_PREFIXES
	).map(normalizePatchPrefix);
	if (allowedPathPrefixes.length === 0) {
		throw new TypeError("Patch proposal must include allowed path prefixes");
	}

	const forbiddenPathPatterns = (
		input.forbiddenPathPatterns ?? DEFAULT_FORBIDDEN_PATCH_PATH_PATTERNS
	)
		.map(normalizeForbiddenPattern)
		.filter((pattern) => pattern.length > 0);

	return {
		applicationMode: "proposal_only",
		autoApplyAllowed: false,
		requiresHumanReview: true,
		allowedPathPrefixes,
		forbiddenPathPatterns,
		rationale:
			input.rationale == null
				? "Generated patch proposals are review artifacts only and must not be applied automatically."
				: assertNonEmptyString(
						input.rationale,
						"Patch proposal safety rationale",
					),
	};
}

function sanitizeFileChange(
	change: GeneratedPatchFileChangeInput,
	boundary: PatchProposalSafetyBoundary,
): GeneratedPatchFileChange {
	const path = normalizePatchPath(change.path, "Generated patch proposal path");
	assertPathAllowed(path, boundary);
	const diffKind = change.diffKind ?? "synthetic_unified_diff";
	if (!VALID_CHANGE_KINDS.has(change.changeKind)) {
		throw new TypeError("Generated patch proposal change kind is invalid");
	}
	if (!VALID_DIFF_KINDS.has(diffKind)) {
		throw new TypeError("Generated patch proposal diff kind is invalid");
	}

	return {
		path,
		changeKind: change.changeKind,
		diffKind,
		summary: assertNonEmptyString(
			change.summary,
			"Generated patch proposal change summary",
		),
		unifiedDiff: assertNonEmptyString(
			change.unifiedDiff,
			"Generated patch proposal synthetic diff",
		),
	};
}

function createWriteAuthorityPreview(
	input: GeneratedPatchWriteAuthorityPreviewInput | undefined,
	title: string,
): GeneratedPatchWriteAuthorityPreview {
	const origin = input?.origin ?? "agent";
	if (origin !== "agent" && origin !== "idle") {
		throw new TypeError(
			"Generated patch proposal WriteAuthority origin is invalid",
		);
	}

	return {
		tool: "scaffold_patch",
		riskLevel: "critical",
		origin,
		summary:
			input?.summary == null
				? `Review-only scaffold patch proposal: ${title}`
				: assertNonEmptyString(
						input.summary,
						"Generated patch proposal WriteAuthority summary",
					),
		requiresConfirmation: true,
		auditRequired: true,
	};
}

export function createGeneratedPatchProposal(
	input: GeneratedPatchProposalInput,
): GeneratedPatchProposal {
	if (!VALID_PATCH_KINDS.has(input.proposalKind)) {
		throw new TypeError("Generated patch proposal kind is invalid");
	}
	const safetyBoundary = createPatchProposalSafetyBoundary(
		input.safetyBoundary,
	);
	const fileChanges = input.fileChanges.map((change) =>
		sanitizeFileChange(change, safetyBoundary),
	);
	if (fileChanges.length === 0) {
		throw new TypeError("Generated patch proposal must include file changes");
	}
	const sourceRefs = normalizeEvidenceRefs(input.sourceRefs);
	if (sourceRefs.length === 0) {
		throw new TypeError("Generated patch proposal must include source refs");
	}
	const title = assertNonEmptyString(
		input.title,
		"Generated patch proposal title",
	);

	const payload = {
		proposalKind: input.proposalKind,
		reviewState: "pending_human_review" as const,
		title,
		summary: assertNonEmptyString(
			input.summary,
			"Generated patch proposal summary",
		),
		safetyBoundary,
		fileChanges,
		sourceRefs,
		beforeAfterEvaluationId: assertNonEmptyString(
			input.beforeAfterEvaluationId,
			"Generated patch proposal before/after evaluation id",
		),
		writeAuthorityPreview: createWriteAuthorityPreview(
			input.writeAuthorityPreview,
			title,
		),
		rollbackPlan: assertNonEmptyString(
			input.rollbackPlan,
			"Generated patch proposal rollback plan",
		),
	};
	const proposal = {
		patchProposalId: createStableRef("patch-proposal", [payload]),
		...payload,
	};

	assertGeneratedPatchProposalBoundary(proposal);
	return proposal;
}

export function assertBeforeAfterEvaluationBoundary(
	evaluation: BeforeAfterEvaluation,
): void {
	if (evaluation.requiresHumanReview !== true) {
		throw new TypeError("Before/after evaluation must require human review");
	}
	if (!VALID_EVALUATION_MODES.has(evaluation.mode)) {
		throw new TypeError("Before/after evaluation mode is invalid");
	}
	if (!VALID_RISK_LEVELS.has(evaluation.regressionRisk)) {
		throw new TypeError("Before/after evaluation regression risk is invalid");
	}
	if (evaluation.metrics.length === 0) {
		throw new TypeError("Before/after evaluation must include metrics");
	}
	if (normalizeEvidenceRefs(evaluation.evidenceRefs).length === 0) {
		throw new TypeError("Before/after evaluation must include evidence refs");
	}
	for (const metric of evaluation.metrics) {
		assertNonEmptyString(metric.name, "Before/after metric name");
		if (!VALID_METRIC_DIRECTIONS.has(metric.direction)) {
			throw new TypeError(
				"Before/after evaluation metric direction is invalid",
			);
		}
		if (normalizeEvidenceRefs(metric.evidenceRefs).length === 0) {
			throw new TypeError(
				"Before/after metric evidence refs must include explicit evidence refs",
			);
		}
	}
}

export function assertGeneratedPatchProposalBoundary(
	proposal: GeneratedPatchProposal,
	evaluation?: BeforeAfterEvaluation,
): void {
	if (!VALID_PATCH_KINDS.has(proposal.proposalKind)) {
		throw new TypeError("Generated patch proposal kind is invalid");
	}
	if (proposal.reviewState !== "pending_human_review") {
		throw new TypeError(
			"Generated patch proposal must remain pending human review",
		);
	}
	if (proposal.safetyBoundary.applicationMode !== "proposal_only") {
		throw new TypeError("Generated patch proposal must be proposal-only");
	}
	if (proposal.safetyBoundary.autoApplyAllowed !== false) {
		throw new TypeError("Generated patch proposal cannot allow auto-apply");
	}
	if (proposal.safetyBoundary.requiresHumanReview !== true) {
		throw new TypeError("Generated patch proposal must require human review");
	}
	if (proposal.fileChanges.length === 0) {
		throw new TypeError("Generated patch proposal must include file changes");
	}
	if (normalizeEvidenceRefs(proposal.sourceRefs).length === 0) {
		throw new TypeError("Generated patch proposal must include source refs");
	}
	if (proposal.writeAuthorityPreview.tool !== "scaffold_patch") {
		throw new TypeError(
			"Generated patch proposal WriteAuthority tool must be scaffold_patch",
		);
	}
	if (proposal.writeAuthorityPreview.riskLevel !== "critical") {
		throw new TypeError(
			"Generated patch proposal WriteAuthority risk must be critical",
		);
	}
	if (
		proposal.writeAuthorityPreview.origin !== "agent" &&
		proposal.writeAuthorityPreview.origin !== "idle"
	) {
		throw new TypeError(
			"Generated patch proposal WriteAuthority origin is invalid",
		);
	}
	if (
		proposal.writeAuthorityPreview.requiresConfirmation !== true ||
		proposal.writeAuthorityPreview.auditRequired !== true
	) {
		throw new TypeError(
			"Generated patch proposal WriteAuthority preview must require confirmation and audit",
		);
	}
	assertNonEmptyString(
		proposal.writeAuthorityPreview.summary,
		"Generated patch proposal WriteAuthority summary",
	);
	assertNonEmptyString(
		proposal.rollbackPlan,
		"Generated patch proposal rollback plan",
	);
	for (const change of proposal.fileChanges) {
		if (!VALID_CHANGE_KINDS.has(change.changeKind)) {
			throw new TypeError("Generated patch proposal change kind is invalid");
		}
		if (change.diffKind !== "synthetic_unified_diff") {
			throw new TypeError(
				"Generated patch proposal must use synthetic diffs until human review applies a patch",
			);
		}
		const path = normalizePatchPath(
			change.path,
			"Generated patch proposal path",
		);
		assertPathAllowed(path, proposal.safetyBoundary);
		assertNonEmptyString(
			change.summary,
			"Generated patch proposal change summary",
		);
		assertNonEmptyString(
			change.unifiedDiff,
			"Generated patch proposal synthetic diff",
		);
	}
	if (
		evaluation !== undefined &&
		proposal.beforeAfterEvaluationId !== evaluation.evaluationId
	) {
		throw new TypeError(
			"Generated patch proposal must reference its before/after evaluation",
		);
	}
}
