import { appendFile, readFile } from "node:fs/promises";
import { logger } from "../logger.js";
import type {
	WriteAuthority,
	WriteOrigin,
	WriteRequest,
} from "../safety/write-authority.js";
import { createStableHash, createStableRef } from "./hash.js";
import {
	ensureJsonlPersistencePath,
	resolveJsonlPersistencePath,
	type SafeJsonlPersistencePath,
} from "./jsonl-path.js";
import {
	assertBeforeAfterEvaluationBoundary,
	assertGeneratedPatchProposalBoundary,
} from "./patch-proposal.js";
import type {
	ProposalSandboxDecision,
	ProposalSandboxPolicyGate,
} from "./sandbox-policy-gate.js";
import {
	normalizeEvidenceRefs,
	sanitizeForSelfEvolution,
	sanitizeSelfEvolutionString,
} from "./sanitize.js";
import {
	type CandidateArtifact,
	type JsonRecord,
	type ProposalQueryFilters,
	type ProposalRecordInput,
	type ProposalReviewQueueGroups,
	type ProposalReviewQueueItem,
	type ProposalReviewQueueNextAction,
	type ProposalReviewQueueNextActionKind,
	type ProposalReviewQueueView,
	type ProposalReviewQueueViewOptions,
	type ProposalStatus,
	type ReviewedProposalStatus,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredProposalRecord,
} from "./types.js";

const PROPOSAL_STATUSES = [
	"pending_review",
	"approved",
	"rejected",
	"superseded",
	"applied",
] as const satisfies readonly ProposalStatus[];

const PROPOSAL_STATUS_SET = new Set<string>(PROPOSAL_STATUSES);

const REVIEWED_PROPOSAL_STATUSES = new Set<ReviewedProposalStatus>([
	"approved",
	"rejected",
	"superseded",
]);

const PROPOSAL_QUERY_FILTER_KEYS = new Set(["reviewState", "createdAt"]);
const PROPOSAL_CREATED_AT_FILTER_KEYS = new Set(["from", "to"]);
const PROPOSAL_REVIEW_QUEUE_VIEW_OPTION_KEYS = new Set([
	"now",
	"stalePendingAfterMs",
]);
const DEFAULT_STALE_PENDING_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCE_ISSUE_REF_PATTERN =
	/(?:^|\b)(?:[A-Z][A-Z0-9]+-\d+|(?:linear|issue|source-issue|task):[A-Za-z0-9_.:/-]+)(?:\b|$)/u;

const PROPOSAL_REVIEW_QUEUE_NEXT_ACTIONS = {
	review_stale_pending: {
		kind: "review_stale_pending",
		priority: 10,
		reasonCode: "pending_review_stale",
		reviewState: "pending_review",
	},
	review_pending: {
		kind: "review_pending",
		priority: 20,
		reasonCode: "pending_review_waiting_for_human",
		reviewState: "pending_review",
	},
	record_approved_review: {
		kind: "record_approved_review",
		priority: 80,
		reasonCode: "approved_review_recorded",
		reviewState: "approved",
	},
	record_rejected_review: {
		kind: "record_rejected_review",
		priority: 90,
		reasonCode: "rejected_review_recorded",
		reviewState: "rejected",
	},
	record_superseded_review: {
		kind: "record_superseded_review",
		priority: 100,
		reasonCode: "superseded_review_recorded",
		reviewState: "superseded",
	},
	record_applied_review: {
		kind: "record_applied_review",
		priority: 110,
		reasonCode: "applied_review_recorded",
		reviewState: "applied",
	},
} as const satisfies Record<
	ProposalReviewQueueNextActionKind,
	Omit<ProposalReviewQueueNextAction, "proposalIds">
>;

export interface ProposalStoreOptions {
	readonly dataRoot?: string;
	readonly filePath: string;
	readonly now?: () => Date;
}

export interface ProposalReviewTransitionInput {
	readonly status: ReviewedProposalStatus;
	readonly reviewer: string;
	readonly reason: string;
	readonly reviewedAt: string;
	readonly metadata?: JsonRecord;
}

export interface ProposalStoreReviewTransitionInput
	extends Omit<ProposalReviewTransitionInput, "reviewedAt"> {
	readonly reviewedAt?: string;
}

export type ProposalApplyOutcomeStatus = "skipped" | "failed";

export type ProposalApplySkippedReason =
	| "user_rejected"
	| "deny_all"
	| "missing_confirm"
	| "sandbox_denied";

export type ProposalApplyFailedReason =
	| "unsupported_patch_type"
	| "apply_error";

export interface ProposalApplyOutcome {
	readonly proposalId: string;
	readonly status: ProposalApplyOutcomeStatus;
	readonly reason: string;
	readonly reasonCode: ProposalApplySkippedReason | ProposalApplyFailedReason;
}

export interface ProposalApplyResult {
	readonly applied: readonly StoredProposalRecord[];
	readonly skipped: readonly ProposalApplyOutcome[];
	readonly failed: readonly ProposalApplyOutcome[];
}

/**
 * Sandbox routing context handed to a `ProposalPatchApplier`. Set when the
 * caller provides a `ProposalSandboxPolicyGate` and the proposal is a
 * `scaffold_patch` (07 §2.6.4 high-risk write paths route through sandbox
 * isolation when available).
 *
 * 自进化 patch applier 接收的沙箱路由上下文：仅当调用方提供
 * `ProposalSandboxPolicyGate` 且 proposal 类型为 `scaffold_patch` 时设置。
 */
export interface ProposalPatchApplierContext {
	readonly sandbox?: ProposalSandboxDecision;
}

export type ProposalPatchApplier = (
	record: StoredProposalRecord,
	context?: ProposalPatchApplierContext,
) => Promise<void>;

export interface ProposalApplyOptions {
	readonly origin?: WriteOrigin;
	readonly reviewer?: string;
	readonly reviewedAt?: string;
	readonly applier?: ProposalPatchApplier;
	/**
	 * Optional sandbox policy gate consulted before the applier runs on a
	 * `scaffold_patch` proposal. When omitted, existing behavior is preserved
	 * (applier runs natively with no sandbox context). When provided, the
	 * gate decides docker / native+warning / deny per 07 §2.6.4.
	 *
	 * 可选的沙箱策略闸门：仅在 `scaffold_patch` 类提案上生效。未提供时保持
	 * 既有行为；提供时按 07 §2.6.4 决定 docker / native+warning / deny。
	 */
	readonly sandboxPolicyGate?: ProposalSandboxPolicyGate;
}

interface NormalizedCreatedAtQueryRange {
	readonly fromMs?: number;
	readonly toMs?: number;
}

interface NormalizedProposalQueryFilters {
	readonly reviewStates?: ReadonlySet<ProposalStatus>;
	readonly createdAt?: NormalizedCreatedAtQueryRange;
}

interface NormalizedProposalReviewQueueViewOptions {
	readonly nowMs?: number;
	readonly stalePendingAfterMs: number;
}

function parseJsonl<T>(content: string): T[] {
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertNoUnsupportedKeys(
	value: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
	messagePrefix: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			throw new TypeError(`${messagePrefix}: ${key}`);
		}
	}
}

function assertProposalStatus(value: unknown, field: string): ProposalStatus {
	if (typeof value !== "string" || !PROPOSAL_STATUS_SET.has(value)) {
		throw new TypeError(`${field} must be a known review state`);
	}
	return value as ProposalStatus;
}

function hasSourceIssueRef(value: unknown): boolean {
	if (typeof value === "string") {
		return SOURCE_ISSUE_REF_PATTERN.test(value);
	}
	if (Array.isArray(value)) {
		return value.some(hasSourceIssueRef);
	}
	if (isPlainObject(value)) {
		return Object.entries(value).some(
			([key, entryValue]) =>
				SOURCE_ISSUE_REF_PATTERN.test(key) || hasSourceIssueRef(entryValue),
		);
	}
	return false;
}

function assertGeneratedPatchSourceIssueAnchor(
	input: ProposalRecordInput,
): void {
	if (
		!hasSourceIssueRef(input.metadata) &&
		!hasSourceIssueRef(input.generatedPatchProposal?.sourceRefs) &&
		!hasSourceIssueRef(
			input.artifacts.flatMap((artifact) => artifact.sourceRefs),
		)
	) {
		throw new TypeError(
			"Generated patch proposal must include a Linear/source issue taskRef anchor",
		);
	}
}

function assertProposalShape(input: ProposalRecordInput): void {
	if (
		input.schemaVersion !== undefined &&
		input.schemaVersion !== SELF_EVOLUTION_SCHEMA_VERSION
	) {
		throw new TypeError("Unsupported proposal schemaVersion");
	}

	if (sanitizeSelfEvolutionString(input.title).trim().length === 0) {
		throw new TypeError("Proposal title must be a non-empty string");
	}

	if (input.riskPreview.requiresHumanReview !== true) {
		throw new TypeError("Proposal riskPreview must require human review");
	}

	if (input.evidenceHashes.length === 0) {
		throw new TypeError("Proposal must include at least one evidence hash");
	}

	if (input.generatedPatchProposal !== undefined) {
		if (input.beforeAfterEvaluation === undefined) {
			throw new TypeError(
				"Generated patch proposal must include a before/after evaluation",
			);
		}
		if (
			input.riskPreview.level !== "critical" ||
			input.riskPreview.touchesRuntime !== true
		) {
			throw new TypeError(
				"Generated patch proposal riskPreview must mark runtime scaffold risk as critical",
			);
		}
		assertBeforeAfterEvaluationBoundary(input.beforeAfterEvaluation);
		assertGeneratedPatchProposalBoundary(
			input.generatedPatchProposal,
			input.beforeAfterEvaluation,
		);
		assertGeneratedPatchSourceIssueAnchor(input);
	}
}

function buildHashPayload(input: ProposalRecordInput): Record<string, unknown> {
	return {
		title: input.title,
		summary: input.summary,
		artifacts: input.artifacts,
		evidenceHashes: input.evidenceHashes,
		riskPreview: input.riskPreview,
		generatedPatchProposal: input.generatedPatchProposal,
		beforeAfterEvaluation: input.beforeAfterEvaluation,
		metadata: input.metadata,
	};
}

function sanitizeProposalInput(
	input: ProposalRecordInput,
): ProposalRecordInput {
	const sanitized = sanitizeForSelfEvolution(
		input,
	) as unknown as ProposalRecordInput;
	return {
		...sanitized,
		artifacts: sanitized.artifacts.map(sanitizeArtifact),
	};
}

function sanitizeArtifact(artifact: CandidateArtifact): CandidateArtifact {
	return {
		...artifact,
		sourceRefs: normalizeEvidenceRefs(artifact.sourceRefs),
	};
}

function assertNonEmptyReviewString(value: string, field: string): string {
	const sanitized = sanitizeSelfEvolutionString(value).trim();
	if (sanitized.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return sanitized;
}

function assertIsoTimestamp(
	value: string,
	field = "Proposal review timestamp",
): string {
	const reviewedAt = assertNonEmptyReviewString(value, field);
	if (
		Number.isNaN(Date.parse(reviewedAt)) ||
		new Date(reviewedAt).toISOString() !== reviewedAt
	) {
		throw new TypeError(`${field} must be ISO 8601 UTC`);
	}
	return reviewedAt;
}

function parseStrictUtcTimestamp(value: string, field: string): number {
	return Date.parse(assertIsoTimestamp(value, field));
}

function normalizeProposalReviewStateFilter(
	value: unknown,
): ReadonlySet<ProposalStatus> | undefined {
	if (value === undefined) {
		return undefined;
	}

	const states = Array.isArray(value) ? value : [value];
	if (states.length === 0) {
		throw new TypeError(
			"Proposal review state filter must include at least one state",
		);
	}

	const normalized: ProposalStatus[] = [];
	for (let index = 0; index < states.length; index += 1) {
		if (!(index in states)) {
			throw new TypeError(
				"Proposal review state filter must not contain sparse entries",
			);
		}
		normalized.push(
			assertProposalStatus(states[index], "Proposal review state filter"),
		);
	}

	return new Set(normalized);
}

function normalizeOptionalQueryTimestamp(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new TypeError(`${field} must be ISO 8601 UTC`);
	}
	return assertIsoTimestamp(value, field);
}

function normalizeCreatedAtQueryRange(
	value: unknown,
): NormalizedCreatedAtQueryRange | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isPlainObject(value)) {
		throw new TypeError("Proposal createdAt filter must be an object");
	}
	assertNoUnsupportedKeys(
		value,
		PROPOSAL_CREATED_AT_FILTER_KEYS,
		"Unsupported proposal createdAt filter",
	);

	const from = normalizeOptionalQueryTimestamp(
		value.from,
		"Proposal createdAt.from",
	);
	const to = normalizeOptionalQueryTimestamp(value.to, "Proposal createdAt.to");
	if (from === undefined && to === undefined) {
		throw new TypeError("Proposal createdAt filter must include from or to");
	}

	const fromMs =
		from === undefined
			? undefined
			: parseStrictUtcTimestamp(from, "Proposal createdAt.from");
	const toMs =
		to === undefined
			? undefined
			: parseStrictUtcTimestamp(to, "Proposal createdAt.to");
	if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
		throw new TypeError("Proposal createdAt range must have from <= to");
	}

	return {
		fromMs,
		toMs,
	};
}

function normalizeProposalQueryFilters(
	filters: ProposalQueryFilters,
): NormalizedProposalQueryFilters {
	if (!isPlainObject(filters)) {
		throw new TypeError("Proposal query filters must be an object");
	}
	assertNoUnsupportedKeys(
		filters,
		PROPOSAL_QUERY_FILTER_KEYS,
		"Unsupported proposal query filter",
	);

	return {
		reviewStates: normalizeProposalReviewStateFilter(filters.reviewState),
		createdAt: normalizeCreatedAtQueryRange(filters.createdAt),
	};
}

function normalizeProposalReviewQueueViewOptions(
	options: ProposalReviewQueueViewOptions = {},
): NormalizedProposalReviewQueueViewOptions {
	if (!isPlainObject(options)) {
		throw new TypeError("Proposal review queue options must be an object");
	}
	assertNoUnsupportedKeys(
		options,
		PROPOSAL_REVIEW_QUEUE_VIEW_OPTION_KEYS,
		"Unsupported proposal review queue option",
	);

	const rawOptions = options as Record<string, unknown>;
	const rawNow = rawOptions.now;
	if (rawNow !== undefined && typeof rawNow !== "string") {
		throw new TypeError("Proposal review queue now must be ISO 8601 UTC");
	}
	const nowMs =
		rawNow === undefined
			? undefined
			: parseStrictUtcTimestamp(rawNow, "Proposal review queue now");
	const stalePendingAfterMs =
		rawOptions.stalePendingAfterMs ?? DEFAULT_STALE_PENDING_AFTER_MS;
	if (
		typeof stalePendingAfterMs !== "number" ||
		!Number.isFinite(stalePendingAfterMs) ||
		stalePendingAfterMs < 0
	) {
		throw new TypeError(
			"Proposal review queue stalePendingAfterMs must be a non-negative number",
		);
	}

	return {
		nowMs,
		stalePendingAfterMs,
	};
}

function sanitizeReviewMetadataObject(
	metadata: JsonRecord | undefined,
): JsonRecord | undefined {
	if (metadata === undefined) {
		return undefined;
	}
	const sanitized = sanitizeForSelfEvolution(metadata);
	if (
		typeof sanitized !== "object" ||
		sanitized === null ||
		Array.isArray(sanitized)
	) {
		throw new TypeError("Proposal review metadata must be an object");
	}
	return sanitized as JsonRecord;
}

function sanitizeReviewMetadata(
	input: ProposalReviewTransitionInput,
): ProposalReviewTransitionInput {
	const status = input.status;
	if (!REVIEWED_PROPOSAL_STATUSES.has(status)) {
		throw new TypeError("Proposal review status transition is invalid");
	}

	return {
		status,
		reviewer: assertNonEmptyReviewString(input.reviewer, "Proposal reviewer"),
		reason: assertNonEmptyReviewString(input.reason, "Proposal review reason"),
		reviewedAt: assertIsoTimestamp(input.reviewedAt),
		metadata: sanitizeReviewMetadataObject(input.metadata),
	};
}

function assertReviewTransitionAllowed(
	record: StoredProposalRecord,
	input: ProposalReviewTransitionInput,
): void {
	if (record.status !== "pending_review") {
		throw new TypeError(
			`Proposal review transition requires pending_review, got ${record.status}`,
		);
	}
	if (!REVIEWED_PROPOSAL_STATUSES.has(input.status)) {
		throw new TypeError("Proposal review status transition is invalid");
	}
}

function assertStoredPatchBoundary(record: StoredProposalRecord): void {
	if (record.generatedPatchProposal === undefined) {
		return;
	}
	if (record.beforeAfterEvaluation === undefined) {
		throw new TypeError(
			"Generated patch proposal must include a before/after evaluation",
		);
	}
	assertBeforeAfterEvaluationBoundary(record.beforeAfterEvaluation);
	assertGeneratedPatchProposalBoundary(
		record.generatedPatchProposal,
		record.beforeAfterEvaluation,
	);
}

function assertStoredProposalQueryBoundary(record: StoredProposalRecord): void {
	assertProposalShape(record);
	assertProposalStatus(record.status, "Stored proposal status");
	assertIsoTimestamp(record.createdAt, "Stored proposal createdAt");
	assertStoredPatchBoundary(record);
}

function matchesCreatedAtQueryRange(
	record: StoredProposalRecord,
	range: NormalizedCreatedAtQueryRange,
): boolean {
	const createdAtMs = parseStrictUtcTimestamp(
		record.createdAt,
		"Stored proposal createdAt",
	);
	if (range.fromMs !== undefined && createdAtMs < range.fromMs) {
		return false;
	}
	if (range.toMs !== undefined && createdAtMs > range.toMs) {
		return false;
	}
	return true;
}

function matchesProposalQueryFilters(
	record: StoredProposalRecord,
	filters: NormalizedProposalQueryFilters,
): boolean {
	if (
		filters.reviewStates !== undefined &&
		!filters.reviewStates.has(record.status)
	) {
		return false;
	}
	if (
		filters.createdAt !== undefined &&
		!matchesCreatedAtQueryRange(record, filters.createdAt)
	) {
		return false;
	}
	return true;
}

function compareStrings(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function compareProposalQueryRecords(
	left: StoredProposalRecord,
	right: StoredProposalRecord,
): number {
	const createdAtOrder = compareStrings(left.createdAt, right.createdAt);
	if (createdAtOrder !== 0) {
		return createdAtOrder;
	}
	return compareStrings(left.proposalId, right.proposalId);
}

function latestProposalRecords(
	records: readonly StoredProposalRecord[],
): readonly StoredProposalRecord[] {
	const byId = new Map<string, StoredProposalRecord>();
	for (const record of records) {
		byId.delete(record.proposalId);
		byId.set(record.proposalId, record);
	}
	return [...byId.values()];
}

function createEmptyProposalReviewQueueCounts(): Record<
	ProposalStatus,
	number
> {
	return {
		pending_review: 0,
		approved: 0,
		rejected: 0,
		superseded: 0,
		applied: 0,
	};
}

function createEmptyProposalReviewQueueGroups(): Record<
	ProposalStatus,
	ProposalReviewQueueItem[]
> {
	return {
		pending_review: [],
		approved: [],
		rejected: [],
		superseded: [],
		applied: [],
	};
}

function isStalePendingProposal(
	record: StoredProposalRecord,
	options: NormalizedProposalReviewQueueViewOptions,
): boolean {
	if (record.status !== "pending_review" || options.nowMs === undefined) {
		return false;
	}
	const createdAtMs = parseStrictUtcTimestamp(
		record.createdAt,
		"Stored proposal createdAt",
	);
	return options.nowMs - createdAtMs >= options.stalePendingAfterMs;
}

function proposalReviewQueueNextActionKindForRecord(
	record: StoredProposalRecord,
	options: NormalizedProposalReviewQueueViewOptions,
): ProposalReviewQueueNextActionKind {
	if (record.status === "pending_review") {
		return isStalePendingProposal(record, options)
			? "review_stale_pending"
			: "review_pending";
	}
	if (record.status === "approved") {
		return "record_approved_review";
	}
	if (record.status === "rejected") {
		return "record_rejected_review";
	}
	if (record.status === "applied") {
		return "record_applied_review";
	}
	return "record_superseded_review";
}

function compareProposalReviewQueueNextActions(
	left: ProposalReviewQueueNextAction,
	right: ProposalReviewQueueNextAction,
): number {
	const priorityOrder = left.priority - right.priority;
	if (priorityOrder !== 0) {
		return priorityOrder;
	}
	return compareStrings(left.kind, right.kind);
}

export function transitionProposalReviewState(
	record: StoredProposalRecord,
	input: ProposalReviewTransitionInput,
): StoredProposalRecord {
	const review = sanitizeReviewMetadata(input);
	assertReviewTransitionAllowed(record, review);
	const transitioned: StoredProposalRecord = {
		...record,
		status: review.status,
		review: {
			reviewer: review.reviewer,
			reason: review.reason,
			reviewedAt: review.reviewedAt,
			metadata: review.metadata,
		},
	};
	assertProposalShape(transitioned);
	assertStoredPatchBoundary(transitioned);
	return transitioned;
}

interface AppliedTransitionInput {
	readonly reviewer: string;
	readonly reason: string;
	readonly reviewedAt: string;
	readonly metadata?: JsonRecord;
}

function sanitizeAppliedTransition(
	input: AppliedTransitionInput,
): AppliedTransitionInput {
	return {
		reviewer: assertNonEmptyReviewString(input.reviewer, "Proposal reviewer"),
		reason: assertNonEmptyReviewString(input.reason, "Proposal review reason"),
		reviewedAt: assertIsoTimestamp(input.reviewedAt),
		metadata: sanitizeReviewMetadataObject(input.metadata),
	};
}

export function transitionProposalAppliedState(
	record: StoredProposalRecord,
	input: AppliedTransitionInput,
): StoredProposalRecord {
	if (record.status !== "approved") {
		throw new TypeError(
			`Proposal apply transition requires approved, got ${record.status}`,
		);
	}
	const sanitized = sanitizeAppliedTransition(input);
	const transitioned: StoredProposalRecord = {
		...record,
		status: "applied",
		review: {
			reviewer: sanitized.reviewer,
			reason: sanitized.reason,
			reviewedAt: sanitized.reviewedAt,
			metadata: sanitized.metadata,
		},
	};
	assertProposalShape(transitioned);
	assertStoredPatchBoundary(transitioned);
	return transitioned;
}

export function buildProposalReviewQueueView(
	records: readonly StoredProposalRecord[],
	options?: ProposalReviewQueueViewOptions,
): ProposalReviewQueueView {
	const normalizedOptions = normalizeProposalReviewQueueViewOptions(options);
	const counts = createEmptyProposalReviewQueueCounts();
	const byReviewState = createEmptyProposalReviewQueueGroups();
	const proposalIdsByNextAction = new Map<
		ProposalReviewQueueNextActionKind,
		string[]
	>();

	for (const record of [...records].sort(compareProposalQueryRecords)) {
		assertStoredProposalQueryBoundary(record);
		counts[record.status] += 1;
		byReviewState[record.status].push({
			proposalId: record.proposalId,
			title: sanitizeSelfEvolutionString(record.title),
			createdAt: record.createdAt,
		});
		const actionKind = proposalReviewQueueNextActionKindForRecord(
			record,
			normalizedOptions,
		);
		const proposalIds = proposalIdsByNextAction.get(actionKind);
		if (proposalIds === undefined) {
			proposalIdsByNextAction.set(actionKind, [record.proposalId]);
		} else {
			proposalIds.push(record.proposalId);
		}
	}

	const nextActions = [...proposalIdsByNextAction.entries()]
		.map(([kind, proposalIds]) => ({
			...PROPOSAL_REVIEW_QUEUE_NEXT_ACTIONS[kind],
			proposalIds,
		}))
		.sort(compareProposalReviewQueueNextActions);

	return {
		totalCount: records.length,
		counts,
		byReviewState: byReviewState as ProposalReviewQueueGroups,
		nextActions,
	};
}

export class JsonlProposalStore {
	private readonly persistencePath: SafeJsonlPersistencePath;
	private readonly now: () => Date;
	private transitionQueue: Promise<void> = Promise.resolve();

	constructor(options: ProposalStoreOptions) {
		this.persistencePath = resolveJsonlPersistencePath(options);
		this.now = options.now ?? (() => new Date());
	}

	async append(input: ProposalRecordInput): Promise<StoredProposalRecord> {
		return this.enqueueMutation(() => this.appendPendingRecord(input));
	}

	private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const previousTransition = this.transitionQueue;
		let releaseTransition!: () => void;
		this.transitionQueue = new Promise<void>((resolve) => {
			releaseTransition = resolve;
		});

		await previousTransition;
		try {
			return await operation();
		} finally {
			releaseTransition();
		}
	}

	private async appendPendingRecord(
		input: ProposalRecordInput,
	): Promise<StoredProposalRecord> {
		assertProposalShape(input);
		const sanitizedInput = sanitizeProposalInput(input);
		assertProposalShape(sanitizedInput);
		const {
			createdAt: sanitizedCreatedAt,
			proposalId: _ignoredProposalId,
			review: _ignoredReview,
			schemaVersion: _ignoredSchemaVersion,
			status: _ignoredStatus,
			...sanitizedDraft
		} = sanitizedInput as ProposalRecordInput & {
			readonly review?: unknown;
			readonly status?: unknown;
		};
		const createdAt = sanitizeSelfEvolutionString(
			sanitizedCreatedAt ?? this.now().toISOString(),
		);
		const canonicalCreatedAt = assertIsoTimestamp(
			createdAt,
			"Proposal createdAt",
		);
		const contentHash = createStableHash(buildHashPayload(sanitizedInput));
		const proposalId = createStableRef("proposal", [
			sanitizedDraft.title,
			contentHash,
		]);
		const current = await this.getById(proposalId);
		if (current !== null && current.status !== "pending_review") {
			throw new TypeError(
				`Proposal ${proposalId} is already ${current.status} and cannot be reopened as pending_review`,
			);
		}
		const record: StoredProposalRecord = {
			...sanitizedDraft,
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			proposalId,
			status: "pending_review",
			createdAt: canonicalCreatedAt,
			contentHash,
		};

		await ensureJsonlPersistencePath(this.persistencePath, "write");
		await appendFile(
			this.persistencePath.filePath,
			`${JSON.stringify(record)}\n`,
			"utf8",
		);
		return record;
	}

	async list(): Promise<readonly StoredProposalRecord[]> {
		const exists = await ensureJsonlPersistencePath(
			this.persistencePath,
			"read",
		);
		if (!exists) {
			return [];
		}

		try {
			const content = await readFile(this.persistencePath.filePath, "utf8");
			const records = parseJsonl<StoredProposalRecord>(content).filter(
				(record) => record.schemaVersion === SELF_EVOLUTION_SCHEMA_VERSION,
			);
			return latestProposalRecords(records);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}

	async query(
		filters: ProposalQueryFilters = {},
	): Promise<readonly StoredProposalRecord[]> {
		const normalizedFilters = normalizeProposalQueryFilters(filters);
		await this.transitionQueue;
		const records = await this.list();
		return records
			.filter((record) => {
				assertStoredProposalQueryBoundary(record);
				return matchesProposalQueryFilters(record, normalizedFilters);
			})
			.sort(compareProposalQueryRecords);
	}

	async getById(proposalId: string): Promise<StoredProposalRecord | null> {
		const records = await this.list();
		return records.find((record) => record.proposalId === proposalId) ?? null;
	}

	async transitionReviewState(
		proposalId: string,
		input: ProposalStoreReviewTransitionInput,
	): Promise<StoredProposalRecord> {
		return this.enqueueMutation(async () => {
			const current = await this.getById(proposalId);
			if (current === null) {
				throw new TypeError("Proposal not found");
			}
			const transitioned = transitionProposalReviewState(current, {
				...input,
				reviewedAt: input.reviewedAt ?? this.now().toISOString(),
			});

			await ensureJsonlPersistencePath(this.persistencePath, "write");
			await appendFile(
				this.persistencePath.filePath,
				`${JSON.stringify(transitioned)}\n`,
				"utf8",
			);
			return transitioned;
		});
	}

	async listPending(): Promise<readonly StoredProposalRecord[]> {
		return this.query({ reviewState: "pending_review" });
	}

	async approve(
		proposalId: string,
		reviewer = "system",
	): Promise<StoredProposalRecord> {
		return this.transitionReviewState(proposalId, {
			status: "approved",
			reviewer,
			reason: "Approved via review workflow.",
		});
	}

	async reject(
		proposalId: string,
		reason: string,
		reviewer = "system",
	): Promise<StoredProposalRecord> {
		return this.transitionReviewState(proposalId, {
			status: "rejected",
			reviewer,
			reason,
		});
	}

	async applyApproved(
		authority: WriteAuthority,
		options: ProposalApplyOptions = {},
	): Promise<ProposalApplyResult> {
		if (authority == null || typeof authority.authorize !== "function") {
			throw new TypeError(
				"applyApproved requires a WriteAuthority gate to authorize patch apply",
			);
		}
		const origin: WriteOrigin = options.origin ?? "agent";
		const reviewer = sanitizeSelfEvolutionString(
			options.reviewer ?? "self-evolution-applier",
		).trim();
		if (reviewer.length === 0) {
			throw new TypeError("applyApproved reviewer must be a non-empty string");
		}
		const applier: ProposalPatchApplier =
			options.applier ?? defaultUnsupportedPatchApplier;

		return this.enqueueMutation(async () => {
			const approvedRecords = (await this.list()).filter(
				(record) => record.status === "approved",
			);

			const applied: StoredProposalRecord[] = [];
			const skipped: ProposalApplyOutcome[] = [];
			const failed: ProposalApplyOutcome[] = [];

			for (const record of approvedRecords) {
				const outcome = await this.applyApprovedRecord({
					record,
					authority,
					origin,
					reviewer,
					reviewedAt: options.reviewedAt,
					applier,
					sandboxPolicyGate: options.sandboxPolicyGate,
				});
				if (outcome.kind === "applied") {
					applied.push(outcome.record);
					continue;
				}
				if (outcome.kind === "skipped") {
					skipped.push(outcome.outcome);
					continue;
				}
				failed.push(outcome.outcome);
			}

			return {
				applied,
				skipped,
				failed,
			};
		});
	}

	private async applyApprovedRecord(input: {
		readonly record: StoredProposalRecord;
		readonly authority: WriteAuthority;
		readonly origin: WriteOrigin;
		readonly reviewer: string;
		readonly reviewedAt?: string;
		readonly applier: ProposalPatchApplier;
		readonly sandboxPolicyGate?: ProposalSandboxPolicyGate;
	}): Promise<
		| { readonly kind: "applied"; readonly record: StoredProposalRecord }
		| { readonly kind: "skipped"; readonly outcome: ProposalApplyOutcome }
		| { readonly kind: "failed"; readonly outcome: ProposalApplyOutcome }
	> {
		const {
			record,
			authority,
			origin,
			reviewer,
			reviewedAt,
			applier,
			sandboxPolicyGate,
		} = input;
		const writeRequest = buildApplyWriteRequest(record, origin);
		const decision = await authority.authorize(writeRequest);
		if (decision.kind !== "allow") {
			const reason =
				decision.kind === "deny"
					? decision.reason
					: "write request requires interactive confirmation";
			const reasonCode =
				decision.kind === "deny"
					? classifySkippedReason(decision.reason)
					: "missing_confirm";
			return {
				kind: "skipped",
				outcome: {
					proposalId: record.proposalId,
					status: "skipped",
					reasonCode,
					reason,
				},
			};
		}

		let sandboxDecision: ProposalSandboxDecision | undefined;
		if (sandboxPolicyGate !== undefined) {
			const proposalKind =
				record.generatedPatchProposal?.proposalKind ?? "artifact_only";
			sandboxDecision = await sandboxPolicyGate.decide({
				tool: writeRequest.tool,
				riskLevel: writeRequest.riskLevel,
				proposalKind,
				proposalId: record.proposalId,
				summary: writeRequest.summary,
			});
			if (sandboxDecision.kind === "deny") {
				logger.warn(
					{
						proposalId: record.proposalId,
						reason: sandboxDecision.reason,
						proposalKind,
					},
					"Sandbox policy gate denied scaffold patch apply",
				);
				return {
					kind: "skipped",
					outcome: {
						proposalId: record.proposalId,
						status: "skipped",
						reasonCode: "sandbox_denied",
						reason: sandboxDecision.reason,
					},
				};
			}
			if (
				sandboxDecision.kind === "native" &&
				sandboxDecision.warning.length > 0
			) {
				logger.warn(
					{
						proposalId: record.proposalId,
						proposalKind,
					},
					sandboxDecision.warning,
				);
			}
		}

		try {
			const applierContext: ProposalPatchApplierContext | undefined =
				sandboxDecision === undefined
					? undefined
					: { sandbox: sandboxDecision };
			await applier(record, applierContext);
		} catch (error) {
			const reasonCode: ProposalApplyFailedReason =
				error instanceof UnsupportedPatchTypeError
					? "unsupported_patch_type"
					: "apply_error";
			return {
				kind: "failed",
				outcome: {
					proposalId: record.proposalId,
					status: "failed",
					reasonCode,
					reason: error instanceof Error ? error.message : String(error),
				},
			};
		}

		const transitioned = transitionProposalAppliedState(record, {
			reviewer,
			reason: "Approved patch applied via WriteAuthority gate.",
			reviewedAt: reviewedAt ?? this.now().toISOString(),
		});

		await ensureJsonlPersistencePath(this.persistencePath, "write");
		await appendFile(
			this.persistencePath.filePath,
			`${JSON.stringify(transitioned)}\n`,
			"utf8",
		);

		return { kind: "applied", record: transitioned };
	}
}

export class UnsupportedPatchTypeError extends Error {
	constructor(message = "patch type is not supported by the default applier") {
		super(message);
		this.name = "UnsupportedPatchTypeError";
	}
}

async function defaultUnsupportedPatchApplier(
	record: StoredProposalRecord,
	_context?: ProposalPatchApplierContext,
): Promise<void> {
	const detail =
		record.generatedPatchProposal === undefined
			? "artifact-only proposal cannot be auto-applied"
			: "synthetic patch proposals require a custom applier";
	throw new UnsupportedPatchTypeError(detail);
}

function classifySkippedReason(reason: string): ProposalApplySkippedReason {
	const normalized = reason.toLowerCase();
	if (normalized.includes("disabled") || normalized.includes("deny-all")) {
		return "deny_all";
	}
	if (normalized.includes("interactive confirmation")) {
		return "missing_confirm";
	}
	return "user_rejected";
}

function summarizeAffectedPaths(record: StoredProposalRecord): string {
	if (record.generatedPatchProposal === undefined) {
		return "artifact-only";
	}
	const paths = record.generatedPatchProposal.fileChanges
		.map((change) => `${change.changeKind}:${change.path}`)
		.slice(0, 4);
	const more =
		record.generatedPatchProposal.fileChanges.length > paths.length
			? ` +${record.generatedPatchProposal.fileChanges.length - paths.length} more`
			: "";
	return `${paths.join(",")}${more}`;
}

function buildApplyWriteRequest(
	record: StoredProposalRecord,
	origin: WriteOrigin,
): WriteRequest {
	const summary = `self_evolution.apply ${record.proposalId}`;
	const detail = [
		`title=${sanitizeSelfEvolutionString(record.title)}`,
		`paths=${summarizeAffectedPaths(record)}`,
		`risk=${record.riskPreview.level}`,
	].join(" | ");

	return {
		tool: "self_evolution_patch_apply",
		origin,
		riskLevel: "critical",
		summary,
		detail,
	};
}
