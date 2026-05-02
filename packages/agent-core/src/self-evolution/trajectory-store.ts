import { appendFile, readFile } from "node:fs/promises";
import { createStableHash, createStableRef } from "./hash.js";
import {
	ensureJsonlPersistencePath,
	resolveJsonlPersistencePath,
	type SafeJsonlPersistencePath,
} from "./jsonl-path.js";
import {
	normalizeEvidenceRefs,
	sanitizeForSelfEvolution,
	sanitizeSelfEvolutionString,
} from "./sanitize.js";
import {
	type JsonRecord,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredTrajectoryRecord,
	type TrajectoryFailure,
	type TrajectoryOutcome,
	type TrajectoryRecordInput,
	type TrajectoryStep,
	type TrajectoryStepKind,
} from "./types.js";

export interface TrajectoryStoreOptions {
	readonly dataRoot?: string;
	readonly filePath: string;
	readonly now?: () => Date;
}

export interface TrajectoryExportOptions {
	readonly runId?: string;
}

const TRAJECTORY_OUTCOMES = [
	"success",
	"failure",
	"cancelled",
] as const satisfies readonly TrajectoryOutcome[];

const TRAJECTORY_OUTCOME_SET = new Set<string>(TRAJECTORY_OUTCOMES);

const TRAJECTORY_STEP_KINDS = [
	"model",
	"tool",
	"checkpoint",
	"observation",
] as const satisfies readonly TrajectoryStepKind[];

const TRAJECTORY_STEP_KIND_SET = new Set<string>(TRAJECTORY_STEP_KINDS);

function assertNonEmptyString(value: string, field: string): string {
	const trimmed = sanitizeSelfEvolutionString(value).trim();
	if (trimmed.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return trimmed;
}

function assertTimestamp(value: string, field: string): string {
	const sanitized = assertNonEmptyString(value, field);
	if (!Number.isFinite(Date.parse(sanitized))) {
		throw new TypeError(`${field} must be an ISO-compatible timestamp`);
	}
	return sanitized;
}

function sanitizeOptionalString(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const sanitized = sanitizeSelfEvolutionString(value).trim();
	return sanitized.length === 0 ? undefined : sanitized;
}

function sanitizeOptionalTimestamp(
	value: string | undefined,
	field: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return assertTimestamp(value, field);
}

function assertTrajectoryOutcome(value: TrajectoryOutcome): void {
	if (!TRAJECTORY_OUTCOME_SET.has(value)) {
		throw new TypeError("TrajectoryRecord.outcome must be known");
	}
}

function assertTrajectoryStepKind(value: TrajectoryStepKind): void {
	if (!TRAJECTORY_STEP_KIND_SET.has(value)) {
		throw new TypeError("TrajectoryStep.kind must be known");
	}
}

function assertNonNegativeInteger(value: number, field: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative integer`);
	}
}

function sanitizeRecord(value: unknown): JsonRecord {
	const sanitized = sanitizeForSelfEvolution(value);
	if (
		typeof sanitized !== "object" ||
		sanitized === null ||
		Array.isArray(sanitized)
	) {
		return {};
	}
	return sanitized as JsonRecord;
}

function sanitizeStep(step: TrajectoryStep): TrajectoryStep {
	assertNonNegativeInteger(step.index, "TrajectoryStep.index");
	assertTrajectoryStepKind(step.kind);

	return {
		...step,
		label: assertNonEmptyString(step.label, "TrajectoryStep.label"),
		startedAt: sanitizeOptionalTimestamp(
			step.startedAt,
			"TrajectoryStep.startedAt",
		),
		endedAt: sanitizeOptionalTimestamp(step.endedAt, "TrajectoryStep.endedAt"),
		input:
			step.input === undefined
				? undefined
				: sanitizeForSelfEvolution(step.input),
		output:
			step.output === undefined
				? undefined
				: sanitizeForSelfEvolution(step.output),
		error:
			step.error === undefined
				? undefined
				: sanitizeForSelfEvolution(step.error),
		metadata:
			step.metadata === undefined ? undefined : sanitizeRecord(step.metadata),
		evidenceRefs: normalizeEvidenceRefs(step.evidenceRefs),
	};
}

function sanitizeFailure(failure: TrajectoryFailure): TrajectoryFailure {
	return {
		...failure,
		message: assertNonEmptyString(failure.message, "TrajectoryFailure.message"),
		source: sanitizeOptionalString(failure.source),
		evidenceRefs: normalizeEvidenceRefs(failure.evidenceRefs),
		metadata:
			failure.metadata === undefined
				? undefined
				: sanitizeRecord(failure.metadata),
	};
}

function buildHashPayload(
	input: TrajectoryRecordInput,
): Record<string, unknown> {
	return {
		runId: input.runId,
		taskRef: input.taskRef,
		outcome: input.outcome,
		steps: input.steps,
		failures: input.failures,
		tokenUsage: input.tokenUsage,
		metadata: input.metadata,
	};
}

function parseJsonl<T>(content: string): T[] {
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

export class JsonlTrajectoryStore {
	private readonly persistencePath: SafeJsonlPersistencePath;
	private readonly now: () => Date;

	constructor(options: TrajectoryStoreOptions) {
		this.persistencePath = resolveJsonlPersistencePath(options);
		this.now = options.now ?? (() => new Date());
	}

	async append(input: TrajectoryRecordInput): Promise<StoredTrajectoryRecord> {
		if (
			input.schemaVersion !== undefined &&
			input.schemaVersion !== SELF_EVOLUTION_SCHEMA_VERSION
		) {
			throw new TypeError("Unsupported trajectory schemaVersion");
		}

		const runId = assertNonEmptyString(input.runId, "TrajectoryRecord.runId");
		assertTrajectoryOutcome(input.outcome);
		const createdAt = assertTimestamp(
			input.createdAt ?? this.now().toISOString(),
			"TrajectoryRecord.createdAt",
		);
		const sanitizedInput: TrajectoryRecordInput = {
			...input,
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			runId,
			taskRef: sanitizeOptionalString(input.taskRef),
			createdAt,
			steps: input.steps.map(sanitizeStep),
			failures: input.failures?.map(sanitizeFailure),
			metadata:
				input.metadata === undefined
					? undefined
					: sanitizeRecord(input.metadata),
		};
		const contentHash = createStableHash(buildHashPayload(sanitizedInput));
		const trajectoryRef = createStableRef("trajectory", [runId, contentHash]);
		const record: StoredTrajectoryRecord = {
			...sanitizedInput,
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			trajectoryRef,
			contentHash,
			createdAt,
		};

		await ensureJsonlPersistencePath(this.persistencePath, "write");
		await appendFile(
			this.persistencePath.filePath,
			`${JSON.stringify(record)}\n`,
			"utf8",
		);
		return record;
	}

	async list(): Promise<readonly StoredTrajectoryRecord[]> {
		const exists = await ensureJsonlPersistencePath(
			this.persistencePath,
			"read",
		);
		if (!exists) {
			return [];
		}

		try {
			const content = await readFile(this.persistencePath.filePath, "utf8");
			return parseJsonl<StoredTrajectoryRecord>(content).filter(
				(record) => record.schemaVersion === SELF_EVOLUTION_SCHEMA_VERSION,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}

	async queryByRunId(
		runId: string,
	): Promise<readonly StoredTrajectoryRecord[]> {
		const normalizedRunId = assertNonEmptyString(runId, "runId");
		const records = await this.list();
		return records.filter((record) => record.runId === normalizedRunId);
	}

	async exportSanitized(
		options: TrajectoryExportOptions = {},
	): Promise<readonly StoredTrajectoryRecord[]> {
		const records =
			options.runId === undefined
				? await this.list()
				: await this.queryByRunId(options.runId);
		return records.map(
			(record) => sanitizeRecord(record) as unknown as StoredTrajectoryRecord,
		);
	}
}
