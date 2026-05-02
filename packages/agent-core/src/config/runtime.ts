// Runtime accessors that bridge ADR-009 user config to ADR-008
// observability primitives. Module-level singletons populated by
// bootstrapUserRuntime(); pure accessors throw if accessed before boot.

import { StructuredLogger } from "../observability/log.js";
import { OTelSpanProvider } from "../observability/span.js";
import {
	loadUserConfig,
	type UserConfigLoadOptions,
	type UserConfigLoadResult,
} from "./user-config.js";

interface UserRuntime {
	readonly result: UserConfigLoadResult;
	readonly spanProvider: OTelSpanProvider;
	readonly structuredLogger: StructuredLogger;
	readonly loadOptions: UserConfigLoadOptions;
	readonly dependencyOverrides: RuntimeDependencyOverrides;
}

let runtime: UserRuntime | null = null;
let runtimeGeneration = 0;
let inFlightReloadGenerations = new Set<number>();
let lastSuccess: RuntimeReloadSuccessSnapshot | null = null;
let lastFailure: RuntimeReloadFailureSnapshot | null = null;

export class UserRuntimeNotBootedError extends Error {
	constructor() {
		super(
			"user runtime not booted; call bootstrapUserRuntime() before accessor",
		);
		this.name = "UserRuntimeNotBootedError";
	}
}

export interface BootstrapOptions extends UserConfigLoadOptions {
	readonly spanProvider?: OTelSpanProvider;
	readonly structuredLogger?: StructuredLogger;
}

export type ReloadUserRuntimeOptions = BootstrapOptions;

export type RuntimeReloadSuccessOperation = "bootstrap" | "reload";

export interface RuntimeReloadSuccessSnapshot {
	readonly generation: number;
	readonly operation: RuntimeReloadSuccessOperation;
	readonly completedAtEpochMs: number;
	readonly configPath: string | null;
}

export interface RuntimeReloadFailureSnapshot {
	readonly generation: number;
	readonly operation: "reload";
	readonly completedAtEpochMs: number;
	readonly errorName: string;
	readonly errorMessage: string;
	readonly errorCode?: string;
}

export interface UserRuntimeStateSnapshot {
	readonly generation: number;
	readonly booted: boolean;
	readonly inFlight: boolean;
	readonly inFlightGenerations: readonly number[];
	readonly lastSuccess: RuntimeReloadSuccessSnapshot | null;
	readonly lastFailure: RuntimeReloadFailureSnapshot | null;
}

export type UserRuntimeStateSnapshotField =
	| "generation"
	| "booted"
	| "inFlight"
	| "inFlightGenerations"
	| "lastSuccess"
	| "lastFailure";

export interface UserRuntimeInFlightDelta {
	readonly addedGenerations: readonly number[];
	readonly removedGenerations: readonly number[];
	readonly countDelta: number;
}

export type RuntimeReloadOutcome = "none" | "success" | "failure";

export interface RuntimeReloadOutcomeState {
	readonly outcome: RuntimeReloadOutcome;
	readonly generation: number | null;
}

export type RuntimeReloadOutcomeTransitionKind =
	| "unchanged"
	| "none-to-success"
	| "none-to-failure"
	| "success-to-none"
	| "success-to-failure"
	| "failure-to-none"
	| "failure-to-success"
	| "success-updated"
	| "failure-updated";

export interface RuntimeReloadOutcomeTransition {
	readonly kind: RuntimeReloadOutcomeTransitionKind;
	readonly from: RuntimeReloadOutcomeState;
	readonly to: RuntimeReloadOutcomeState;
}

export interface UserRuntimeStateSnapshotDiff {
	readonly changedFields: readonly UserRuntimeStateSnapshotField[];
	readonly generationDelta: number;
	readonly inFlightDelta: UserRuntimeInFlightDelta;
	readonly failureSuccessTransition: RuntimeReloadOutcomeTransition;
	readonly successPresent: boolean;
	readonly failurePresent: boolean;
}

export interface RuntimeReloadAuditEvent {
	readonly event: "user_runtime_reload_audit";
	readonly generationDelta: number;
	readonly changedFields: readonly UserRuntimeStateSnapshotField[];
	readonly transitionKind: RuntimeReloadOutcomeTransitionKind;
	readonly inFlight: UserRuntimeInFlightDelta;
	readonly successPresent: boolean;
	readonly failurePresent: boolean;
}

export interface RuntimeReloadAuditSnapshotsInput {
	readonly before: UserRuntimeStateSnapshot;
	readonly after: UserRuntimeStateSnapshot;
}

export interface RuntimeReloadAuditDiffInput {
	readonly diff: UserRuntimeStateSnapshotDiff;
}

export type RuntimeReloadAuditEventInput =
	| RuntimeReloadAuditSnapshotsInput
	| RuntimeReloadAuditDiffInput;

interface RuntimeDependencyOverrides {
	readonly spanProvider?: OTelSpanProvider;
	readonly structuredLogger?: StructuredLogger;
}

function extractLoadOptions(
	options: UserConfigLoadOptions,
): UserConfigLoadOptions {
	return {
		...(options.configPath == null ? {} : { configPath: options.configPath }),
		...(options.cliOverrides == null
			? {}
			: { cliOverrides: options.cliOverrides }),
		...(options.env == null ? {} : { env: options.env }),
		...(options.enforceFileMode == null
			? {}
			: { enforceFileMode: options.enforceFileMode }),
	};
}

function mergeLoadOptions(
	current: UserConfigLoadOptions,
	next: UserConfigLoadOptions,
): UserConfigLoadOptions {
	return {
		...current,
		...extractLoadOptions(next),
	};
}

function extractDependencyOverrides(
	options: BootstrapOptions,
): RuntimeDependencyOverrides {
	return {
		...(options.spanProvider == null
			? {}
			: { spanProvider: options.spanProvider }),
		...(options.structuredLogger == null
			? {}
			: { structuredLogger: options.structuredLogger }),
	};
}

function buildRuntime(
	result: UserConfigLoadResult,
	loadOptions: UserConfigLoadOptions,
	dependencyOverrides: RuntimeDependencyOverrides,
	previousRuntime?: UserRuntime,
): UserRuntime {
	return {
		result,
		loadOptions,
		dependencyOverrides,
		spanProvider:
			dependencyOverrides.spanProvider ??
			previousRuntime?.spanProvider ??
			new OTelSpanProvider(),
		structuredLogger:
			dependencyOverrides.structuredLogger ??
			new StructuredLogger({ level: result.config.observability.log_level }),
	};
}

function buildSuccessSnapshot(
	generation: number,
	operation: RuntimeReloadSuccessOperation,
	userRuntime: UserRuntime,
): RuntimeReloadSuccessSnapshot {
	return {
		generation,
		operation,
		completedAtEpochMs: Date.now(),
		configPath: userRuntime.result.filePath,
	};
}

function buildFailureSnapshot(
	generation: number,
	error: unknown,
): RuntimeReloadFailureSnapshot {
	const errorRecord =
		typeof error === "object" && error !== null
			? (error as Record<string, unknown>)
			: {};
	const errorName =
		error instanceof Error
			? error.name
			: typeof error === "string"
				? "Error"
				: "UnknownError";
	const errorMessage =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Unknown runtime reload failure";
	const errorCode =
		typeof errorRecord.code === "string" ? errorRecord.code : undefined;
	return {
		generation,
		operation: "reload",
		completedAtEpochMs: Date.now(),
		errorName,
		errorMessage,
		...(errorCode == null ? {} : { errorCode }),
	};
}

function sortedUniqueGenerations(
	generations: readonly number[],
): readonly number[] {
	return Array.from(new Set(generations)).sort((left, right) => left - right);
}

function buildInFlightDelta(
	before: readonly number[],
	after: readonly number[],
): UserRuntimeInFlightDelta {
	const beforeGenerations = sortedUniqueGenerations(before);
	const afterGenerations = sortedUniqueGenerations(after);
	const beforeSet = new Set(beforeGenerations);
	const afterSet = new Set(afterGenerations);
	return {
		addedGenerations: afterGenerations.filter(
			(generation) => !beforeSet.has(generation),
		),
		removedGenerations: beforeGenerations.filter(
			(generation) => !afterSet.has(generation),
		),
		countDelta: afterSet.size - beforeSet.size,
	};
}

function successSnapshotChanged(
	before: RuntimeReloadSuccessSnapshot | null,
	after: RuntimeReloadSuccessSnapshot | null,
): boolean {
	if (before == null || after == null) {
		return before !== after;
	}
	return (
		before.generation !== after.generation ||
		before.operation !== after.operation ||
		before.completedAtEpochMs !== after.completedAtEpochMs ||
		before.configPath !== after.configPath
	);
}

function failureSnapshotChanged(
	before: RuntimeReloadFailureSnapshot | null,
	after: RuntimeReloadFailureSnapshot | null,
): boolean {
	if (before == null || after == null) {
		return before !== after;
	}
	return (
		before.generation !== after.generation ||
		before.operation !== after.operation ||
		before.completedAtEpochMs !== after.completedAtEpochMs ||
		before.errorName !== after.errorName ||
		before.errorMessage !== after.errorMessage ||
		(before.errorCode ?? null) !== (after.errorCode ?? null)
	);
}

function getReloadOutcome(
	snapshot: UserRuntimeStateSnapshot,
): RuntimeReloadOutcomeState {
	const success = snapshot.lastSuccess;
	const failure = snapshot.lastFailure;
	if (success == null && failure == null) {
		return { outcome: "none", generation: null };
	}
	if (
		success != null &&
		(failure == null || success.generation >= failure.generation)
	) {
		return { outcome: "success", generation: success.generation };
	}
	if (failure != null) {
		return { outcome: "failure", generation: failure.generation };
	}
	return { outcome: "none", generation: null };
}

function getReloadOutcomeTransitionKind(
	from: RuntimeReloadOutcomeState,
	to: RuntimeReloadOutcomeState,
): RuntimeReloadOutcomeTransitionKind {
	if (from.outcome === to.outcome) {
		if (from.generation === to.generation) {
			return "unchanged";
		}
		if (to.outcome === "success") {
			return "success-updated";
		}
		if (to.outcome === "failure") {
			return "failure-updated";
		}
		return "unchanged";
	}
	if (from.outcome === "none") {
		return to.outcome === "success" ? "none-to-success" : "none-to-failure";
	}
	if (from.outcome === "success") {
		return to.outcome === "none" ? "success-to-none" : "success-to-failure";
	}
	return to.outcome === "none" ? "failure-to-none" : "failure-to-success";
}

function buildReloadOutcomeTransition(
	before: UserRuntimeStateSnapshot,
	after: UserRuntimeStateSnapshot,
): RuntimeReloadOutcomeTransition {
	const from = getReloadOutcome(before);
	const to = getReloadOutcome(after);
	return {
		kind: getReloadOutcomeTransitionKind(from, to),
		from,
		to,
	};
}

export function diffUserRuntimeStateSnapshots(
	before: UserRuntimeStateSnapshot,
	after: UserRuntimeStateSnapshot,
): UserRuntimeStateSnapshotDiff {
	const inFlightDelta = buildInFlightDelta(
		before.inFlightGenerations,
		after.inFlightGenerations,
	);
	const changedFields: UserRuntimeStateSnapshotField[] = [];
	if (before.generation !== after.generation) {
		changedFields.push("generation");
	}
	if (before.booted !== after.booted) {
		changedFields.push("booted");
	}
	if (before.inFlight !== after.inFlight) {
		changedFields.push("inFlight");
	}
	if (
		inFlightDelta.addedGenerations.length > 0 ||
		inFlightDelta.removedGenerations.length > 0
	) {
		changedFields.push("inFlightGenerations");
	}
	if (successSnapshotChanged(before.lastSuccess, after.lastSuccess)) {
		changedFields.push("lastSuccess");
	}
	if (failureSnapshotChanged(before.lastFailure, after.lastFailure)) {
		changedFields.push("lastFailure");
	}
	return {
		changedFields,
		generationDelta: after.generation - before.generation,
		inFlightDelta,
		failureSuccessTransition: buildReloadOutcomeTransition(before, after),
		successPresent: after.lastSuccess != null,
		failurePresent: after.lastFailure != null,
	};
}

function getAuditPresenceFromInput(
	input: RuntimeReloadAuditEventInput,
): Pick<RuntimeReloadAuditEvent, "successPresent" | "failurePresent"> {
	if (!isRuntimeReloadAuditDiffInput(input)) {
		return {
			successPresent: input.after.lastSuccess != null,
			failurePresent: input.after.lastFailure != null,
		};
	}
	return {
		successPresent: input.diff.successPresent,
		failurePresent: input.diff.failurePresent,
	};
}

function isRuntimeReloadAuditDiffInput(
	input: RuntimeReloadAuditEventInput,
): input is RuntimeReloadAuditDiffInput {
	return "diff" in input;
}

export function buildRuntimeReloadAuditEvent(
	input: RuntimeReloadAuditEventInput,
): RuntimeReloadAuditEvent {
	const diff = isRuntimeReloadAuditDiffInput(input)
		? input.diff
		: diffUserRuntimeStateSnapshots(input.before, input.after);
	const presence = getAuditPresenceFromInput(input);
	return {
		event: "user_runtime_reload_audit",
		generationDelta: diff.generationDelta,
		changedFields: [...diff.changedFields],
		transitionKind: diff.failureSuccessTransition.kind,
		inFlight: {
			addedGenerations: [...diff.inFlightDelta.addedGenerations],
			removedGenerations: [...diff.inFlightDelta.removedGenerations],
			countDelta: diff.inFlightDelta.countDelta,
		},
		...presence,
	};
}

export function getUserRuntimeStateSnapshot(): UserRuntimeStateSnapshot {
	const inFlightGenerations = Array.from(inFlightReloadGenerations).sort(
		(left, right) => left - right,
	);
	return {
		generation: runtimeGeneration,
		booted: runtime != null,
		inFlight: inFlightGenerations.length > 0,
		inFlightGenerations,
		lastSuccess: lastSuccess == null ? null : { ...lastSuccess },
		lastFailure: lastFailure == null ? null : { ...lastFailure },
	};
}

export async function bootstrapUserRuntime(
	options: BootstrapOptions = {},
): Promise<UserRuntime> {
	const loadOptions = extractLoadOptions(options);
	const result = await loadUserConfig(loadOptions);
	runtime = buildRuntime(
		result,
		loadOptions,
		extractDependencyOverrides(options),
	);
	runtimeGeneration += 1;
	lastSuccess = buildSuccessSnapshot(runtimeGeneration, "bootstrap", runtime);
	return runtime;
}

export function resetUserRuntime(): void {
	runtime = null;
	runtimeGeneration += 1;
	inFlightReloadGenerations = new Set<number>();
	lastSuccess = null;
	lastFailure = null;
}

export function isUserRuntimeReady(): boolean {
	return runtime != null;
}

export async function reloadUserRuntime(
	options: ReloadUserRuntimeOptions = {},
): Promise<UserRuntime> {
	const currentRuntime = getUserRuntime();
	const commitGeneration = runtimeGeneration + 1;
	runtimeGeneration = commitGeneration;
	inFlightReloadGenerations.add(commitGeneration);
	const loadOptions = mergeLoadOptions(currentRuntime.loadOptions, options);
	const dependencyOverrides = {
		...currentRuntime.dependencyOverrides,
		...extractDependencyOverrides(options),
	};
	try {
		const result = await loadUserConfig(loadOptions);
		if (commitGeneration !== runtimeGeneration) {
			return getUserRuntime();
		}
		runtime = buildRuntime(
			result,
			loadOptions,
			dependencyOverrides,
			currentRuntime,
		);
		lastSuccess = buildSuccessSnapshot(commitGeneration, "reload", runtime);
		return runtime;
	} catch (error) {
		if (commitGeneration === runtimeGeneration) {
			lastFailure = buildFailureSnapshot(commitGeneration, error);
		}
		throw error;
	} finally {
		inFlightReloadGenerations.delete(commitGeneration);
	}
}

export function getUserRuntime(): UserRuntime {
	if (runtime == null) {
		throw new UserRuntimeNotBootedError();
	}
	return runtime;
}

export function getUserConfig(): UserConfigLoadResult["config"] {
	return getUserRuntime().result.config;
}

export function getUserConfigSources(): UserConfigLoadResult["sources"] {
	return getUserRuntime().result.sources;
}

export function getDefaultSpanProvider(): OTelSpanProvider {
	return getUserRuntime().spanProvider;
}

export function getDefaultStructuredLogger(): StructuredLogger {
	return getUserRuntime().structuredLogger;
}
