import { createHash } from "node:crypto";
import type { MemoryClient } from "../memory/client.js";
import type { MemoryItem } from "../memory/types.js";

export const PLAN_REVIEW_SOURCE = "planning_review";
export const PLAN_REVIEW_SCHEMA_VERSION = 1;

export interface PlanReviewRecord {
	readonly run_id: string;
	readonly source: typeof PLAN_REVIEW_SOURCE;
	readonly schema_version: typeof PLAN_REVIEW_SCHEMA_VERSION;
	readonly summary: string;
	readonly stable_strategy: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

export interface PlanReviewFallbackRecord {
	readonly kind: "planning_review_fallback";
	readonly reason: "memory_unavailable" | "store_failed";
	readonly error_code?: string;
	readonly logger_error_code?: string;
	readonly created_at: string;
	readonly review: PlanReviewRecord;
}

export interface PlanReviewWriteOptions {
	readonly client?: MemoryClient;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly eventLogger?: (
		record: PlanReviewFallbackRecord,
	) => void | Promise<void>;
	readonly now?: () => Date;
}

export interface PlanReviewWriteResult {
	readonly status: "written" | "fallback_logged";
	readonly item: MemoryItem;
	readonly fallback?: PlanReviewFallbackRecord;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTransientPlanningStateShape(
	record: Record<string, unknown>,
): boolean {
	return (
		typeof record.runId === "string" &&
		Array.isArray(record.events) &&
		Array.isArray(record.checkpoints) &&
		typeof record.phase === "string"
	);
}

function hasForbiddenTransientFields(record: Record<string, unknown>): boolean {
	return [
		"events",
		"checkpoints",
		"phase",
		"budget",
		"currentLeafId",
		"plan",
	].some((field) => field in record);
}

function toErrorCode(error: unknown): string {
	if (error instanceof Error) {
		const normalized = error.message
			.trim()
			.toUpperCase()
			.replace(/[^A-Z0-9]+/gu, "_")
			.replace(/^_+|_+$/gu, "");

		if (normalized.length > 0) {
			return normalized;
		}

		return error.name.toUpperCase();
	}

	return "UNKNOWN_ERROR";
}

export function validatePlanReviewRecord(input: unknown): PlanReviewRecord {
	if (!isPlainObject(input)) {
		throw new TypeError("PlanReviewRecord must be a JSON object");
	}

	if (hasTransientPlanningStateShape(input)) {
		throw new Error(
			"running PlanningState cannot be written to semantic memory",
		);
	}

	if (hasForbiddenTransientFields(input)) {
		throw new Error(
			"transient planning fields are not allowed in PlanReviewRecord",
		);
	}

	const runId = input.run_id;
	const source = input.source;
	const schemaVersion = input.schema_version;
	const summary = input.summary;
	const stableStrategy = input.stable_strategy;

	if (typeof runId !== "string" || runId.trim().length === 0) {
		throw new TypeError("PlanReviewRecord.run_id must be a non-empty string");
	}

	if (source !== PLAN_REVIEW_SOURCE) {
		throw new TypeError(
			`PlanReviewRecord.source must be ${PLAN_REVIEW_SOURCE}`,
		);
	}

	if (schemaVersion !== PLAN_REVIEW_SCHEMA_VERSION) {
		throw new TypeError(
			`PlanReviewRecord.schema_version must be ${PLAN_REVIEW_SCHEMA_VERSION}`,
		);
	}

	if (typeof summary !== "string" || summary.trim().length === 0) {
		throw new TypeError("PlanReviewRecord.summary must be a non-empty string");
	}

	if (!isPlainObject(stableStrategy)) {
		throw new TypeError(
			"PlanReviewRecord.stable_strategy must be a JSON object",
		);
	}

	return {
		...input,
		run_id: runId,
		source,
		schema_version: schemaVersion,
		summary,
		stable_strategy: stableStrategy,
	};
}

function createPlanReviewId(
	record: PlanReviewRecord,
	createdAt: string,
): string {
	const canonicalRecord = JSON.stringify(record, Object.keys(record).sort());
	const digest = createHash("sha256")
		.update(createdAt)
		.update("\0")
		.update(canonicalRecord)
		.digest("hex")
		.slice(0, 12);

	return `planning-review:${record.run_id}:${digest}`;
}

export function createPlanReviewMemoryItem(
	input: unknown,
	options: Pick<PlanReviewWriteOptions, "metadata" | "now"> = {},
): MemoryItem {
	const record = validatePlanReviewRecord(input);
	const createdAt = (options.now?.() ?? new Date()).toISOString();

	return {
		id: createPlanReviewId(record, createdAt),
		content: JSON.stringify(record),
		content_type: "json",
		layer: "semantic",
		metadata: {
			...(options.metadata ?? {}),
			schema_version: PLAN_REVIEW_SCHEMA_VERSION,
			source: PLAN_REVIEW_SOURCE,
			run_id: record.run_id,
		},
		embedding: null,
		created_at: createdAt,
		last_accessed: createdAt,
		access_count: 0,
		importance_score: 1,
	};
}

async function writeFallback(
	record: PlanReviewRecord,
	reason: PlanReviewFallbackRecord["reason"],
	options: PlanReviewWriteOptions,
	errorCode?: string,
): Promise<PlanReviewFallbackRecord> {
	const fallback: PlanReviewFallbackRecord = {
		kind: "planning_review_fallback",
		reason,
		error_code: errorCode,
		created_at: (options.now?.() ?? new Date()).toISOString(),
		review: record,
	};

	try {
		await options.eventLogger?.(fallback);
		return fallback;
	} catch (error) {
		return {
			...fallback,
			logger_error_code: toErrorCode(error),
		};
	}
}

export async function writePlanReviewRecord(
	input: unknown,
	options: PlanReviewWriteOptions = {},
): Promise<PlanReviewWriteResult> {
	const record = validatePlanReviewRecord(input);
	const item = createPlanReviewMemoryItem(record, options);

	if (options.client == null) {
		return {
			status: "fallback_logged",
			item,
			fallback: await writeFallback(record, "memory_unavailable", options),
		};
	}

	try {
		await options.client.store(item);
		return {
			status: "written",
			item,
		};
	} catch (error) {
		return {
			status: "fallback_logged",
			item,
			fallback: await writeFallback(
				record,
				"store_failed",
				options,
				toErrorCode(error),
			),
		};
	}
}
