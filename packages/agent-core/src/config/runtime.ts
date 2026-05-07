// Runtime accessors that bridge ADR-009 user config to ADR-008
// observability primitives. Module-level singletons populated by
// bootstrapUserRuntime(); pure accessors throw if accessed before boot.

import type { InferenceConfig, LLMTierRoutingConfig } from "../llm/types.js";
import { StructuredLogger } from "../observability/log.js";
import { OTelSpanProvider } from "../observability/span.js";
import type { AuthorityMode } from "../safety/write-authority.js";
import {
	loadUserConfig,
	type UserConfigLoadOptions,
	type UserConfigLoadResult,
} from "./user-config.js";
import type { UserConfig } from "./user-config-schema.js";

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

export type RuntimeReloadApplyState =
	| "not_requested"
	| "in_flight"
	| "applied"
	| "error";

export interface RuntimeReloadChangeSet {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

export interface RuntimeReloadErrorSummary {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly errorName: string;
	readonly errorMessage: string;
	readonly errorCode?: string;
}

export interface RuntimeReloadLastApplied {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly operation: RuntimeReloadSuccessOperation;
	readonly target: string | null;
}

export interface UserRuntimeReloadManagementStatus {
	readonly domain: "user_config";
	readonly generation: number;
	readonly inFlight: boolean;
	readonly applyState: RuntimeReloadApplyState;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
	readonly error: RuntimeReloadErrorSummary | null;
	readonly lastApplied: RuntimeReloadLastApplied | null;
}

export interface RuntimeReloadSuccessSnapshot {
	readonly generation: number;
	readonly operation: RuntimeReloadSuccessOperation;
	readonly completedAtEpochMs: number;
	readonly configPath: string | null;
	readonly change?: RuntimeReloadChangeSet;
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

export interface RuntimeToolFilter {
	readonly enabled: readonly string[];
	readonly disabled: readonly string[];
}

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
	previousRuntime: UserRuntime | null,
): RuntimeReloadSuccessSnapshot {
	return {
		generation,
		operation,
		completedAtEpochMs: Date.now(),
		configPath: userRuntime.result.filePath,
		change: diffRuntimeConfigPaths(
			previousRuntime?.result.filePath ?? null,
			userRuntime.result.filePath,
			operation,
		),
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

function runtimeConfigTarget(path: string | null): string {
	return path ?? "defaults";
}

function diffRuntimeConfigPaths(
	previousPath: string | null,
	nextPath: string | null,
	operation: RuntimeReloadSuccessOperation,
): RuntimeReloadChangeSet {
	const nextTarget = runtimeConfigTarget(nextPath);
	if (operation === "bootstrap") {
		return {
			added: [nextTarget],
			removed: [],
			changed: [],
		};
	}

	const previousTarget = runtimeConfigTarget(previousPath);
	if (previousTarget !== nextTarget) {
		return {
			added: [nextTarget],
			removed: [previousTarget],
			changed: [],
		};
	}

	return {
		added: [],
		removed: [],
		changed: [nextTarget],
	};
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
	const beforeChange = normalizeRuntimeChangeSet(before.change);
	const afterChange = normalizeRuntimeChangeSet(after.change);
	return (
		before.generation !== after.generation ||
		before.operation !== after.operation ||
		before.completedAtEpochMs !== after.completedAtEpochMs ||
		before.configPath !== after.configPath ||
		beforeChange.added.join("\0") !== afterChange.added.join("\0") ||
		beforeChange.removed.join("\0") !== afterChange.removed.join("\0") ||
		beforeChange.changed.join("\0") !== afterChange.changed.join("\0")
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

function latestRuntimeFailureIsActive(): RuntimeReloadFailureSnapshot | null {
	if (lastFailure == null) {
		return null;
	}
	if (lastSuccess == null || lastFailure.generation >= lastSuccess.generation) {
		return lastFailure;
	}
	return null;
}

function cloneRuntimeChangeSet(
	change: RuntimeReloadChangeSet | undefined,
): RuntimeReloadChangeSet {
	const normalized = normalizeRuntimeChangeSet(change);
	return {
		added: [...normalized.added],
		removed: [...normalized.removed],
		changed: [...normalized.changed],
	};
}

function normalizeRuntimeChangeSet(
	change: RuntimeReloadChangeSet | undefined,
): RuntimeReloadChangeSet {
	return change ?? { added: [], removed: [], changed: [] };
}

function runtimeFailureToErrorSummary(
	failure: RuntimeReloadFailureSnapshot,
): RuntimeReloadErrorSummary {
	return {
		generation: failure.generation,
		completedAtEpochMs: failure.completedAtEpochMs,
		errorName: failure.errorName,
		errorMessage: failure.errorMessage,
		...(failure.errorCode == null ? {} : { errorCode: failure.errorCode }),
	};
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

export function buildRuntimeInferenceConfig(
	config: Pick<UserConfig, "llm">,
): InferenceConfig {
	return {
		temperature: config.llm.temperature,
		maxTokens: config.llm.max_tokens,
		thinkingMode: config.llm.thinking.enabled ? "enabled" : "disabled",
		thinkingBudget: config.llm.thinking.budget_tokens,
	};
}

export function buildRuntimeTierRoutingConfig(
	config: Pick<UserConfig, "llm">,
): LLMTierRoutingConfig {
	return {
		mode: config.llm.routing.mode,
		defaultTier: config.llm.routing.default_tier,
		allowEscalation: config.llm.routing.allow_escalation,
		tiers: {
			flash: {
				provider: config.llm.tiers.flash.provider,
				model: config.llm.tiers.flash.model,
				thinkingMode: config.llm.tiers.flash.thinking,
				...(config.llm.tiers.flash.temperature == null
					? {}
					: { temperature: config.llm.tiers.flash.temperature }),
				...(config.llm.tiers.flash.max_tokens == null
					? {}
					: { maxTokens: config.llm.tiers.flash.max_tokens }),
				...(config.llm.tiers.flash.thinking_budget_tokens == null
					? {}
					: {
							thinkingBudget: config.llm.tiers.flash.thinking_budget_tokens,
						}),
				...(config.llm.tiers.flash.top_p == null
					? {}
					: { topP: config.llm.tiers.flash.top_p }),
			},
			lite: {
				provider: config.llm.tiers.lite.provider,
				model: config.llm.tiers.lite.model,
				thinkingMode: config.llm.tiers.lite.thinking,
				...(config.llm.tiers.lite.temperature == null
					? {}
					: { temperature: config.llm.tiers.lite.temperature }),
				...(config.llm.tiers.lite.max_tokens == null
					? {}
					: { maxTokens: config.llm.tiers.lite.max_tokens }),
				...(config.llm.tiers.lite.thinking_budget_tokens == null
					? {}
					: {
							thinkingBudget: config.llm.tiers.lite.thinking_budget_tokens,
						}),
				...(config.llm.tiers.lite.top_p == null
					? {}
					: { topP: config.llm.tiers.lite.top_p }),
			},
			pro: {
				provider: config.llm.tiers.pro.provider,
				model: config.llm.tiers.pro.model,
				thinkingMode: config.llm.tiers.pro.thinking,
				...(config.llm.tiers.pro.temperature == null
					? {}
					: { temperature: config.llm.tiers.pro.temperature }),
				...(config.llm.tiers.pro.max_tokens == null
					? {}
					: { maxTokens: config.llm.tiers.pro.max_tokens }),
				...(config.llm.tiers.pro.thinking_budget_tokens == null
					? {}
					: {
							thinkingBudget: config.llm.tiers.pro.thinking_budget_tokens,
						}),
				...(config.llm.tiers.pro.top_p == null
					? {}
					: { topP: config.llm.tiers.pro.top_p }),
			},
		},
	};
}

export function resolveRuntimeWriteAuthorityMode(
	config: Pick<UserConfig, "safety">,
): AuthorityMode {
	switch (config.safety.trust_mode) {
		case "auto":
			return "auto-medium";
		case "ask":
		case "read_only":
			return "ask";
	}
}

export function buildRuntimeToolFilter(
	config: Pick<UserConfig, "tools">,
): RuntimeToolFilter {
	return {
		enabled: [...config.tools.enabled],
		disabled: [...config.tools.disabled],
	};
}

function runtimeToolNameAliases(toolName: string): readonly string[] {
	const slashIndex = toolName.indexOf("/");
	if (slashIndex === -1) {
		return [toolName];
	}

	return [toolName, toolName.slice(slashIndex + 1)];
}

export function isRuntimeToolEnabled(
	toolName: string,
	filter: RuntimeToolFilter,
): boolean {
	const aliases = runtimeToolNameAliases(toolName);
	if (aliases.some((alias) => filter.disabled.includes(alias))) {
		return false;
	}

	return (
		filter.enabled.length === 0 ||
		aliases.some((alias) => filter.enabled.includes(alias))
	);
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
		lastSuccess:
			lastSuccess == null
				? null
				: {
						...lastSuccess,
						change: cloneRuntimeChangeSet(lastSuccess.change),
					},
		lastFailure: lastFailure == null ? null : { ...lastFailure },
	};
}

export function getUserRuntimeReloadManagementStatus(): UserRuntimeReloadManagementStatus {
	const inFlightGenerations = Array.from(inFlightReloadGenerations).sort(
		(left, right) => left - right,
	);
	const activeError = latestRuntimeFailureIsActive();
	const change = cloneRuntimeChangeSet(lastSuccess?.change);
	return {
		domain: "user_config",
		generation: runtimeGeneration,
		inFlight: inFlightGenerations.length > 0,
		applyState:
			activeError != null
				? "error"
				: inFlightGenerations.length > 0
					? "in_flight"
					: lastSuccess == null
						? "not_requested"
						: "applied",
		added: [...change.added],
		removed: [...change.removed],
		changed: [...change.changed],
		error:
			activeError == null ? null : runtimeFailureToErrorSummary(activeError),
		lastApplied:
			lastSuccess == null
				? null
				: {
						generation: lastSuccess.generation,
						completedAtEpochMs: lastSuccess.completedAtEpochMs,
						operation: lastSuccess.operation,
						target: lastSuccess.configPath,
					},
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
	lastSuccess = buildSuccessSnapshot(
		runtimeGeneration,
		"bootstrap",
		runtime,
		null,
	);
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
		lastSuccess = buildSuccessSnapshot(
			commitGeneration,
			"reload",
			runtime,
			currentRuntime,
		);
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
