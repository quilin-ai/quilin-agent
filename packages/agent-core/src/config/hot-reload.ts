import { existsSync, type FSWatcher, type WatchListener, watch } from "node:fs";
import { join } from "node:path";
import type {
	SkillsCatalogChange,
	SkillsReloadStatus,
} from "../skills/manager.js";
import type { MCPServerEntry } from "../tools/registry.js";
import {
	buildCapabilitiesRuntime,
	type CapabilitiesConfigSource,
	type CapabilitiesRuntime,
	type LoadCapabilitiesConfigOptions,
	type LoadedCapabilitiesConfig,
	loadCapabilitiesConfig,
} from "./loader.js";

export type CapabilitiesReloadOperation = "bootstrap" | "reload";
export type CapabilitiesReloadTrigger = "manual" | "watch";
export type CapabilitiesReloadDomain = "config" | "mcp" | "skills";
export type CapabilitiesReloadApplyState =
	| "not_requested"
	| "in_flight"
	| "unchanged"
	| "pending_repl_turn_boundary"
	| "applied"
	| "error";

export interface CapabilitiesReloadChangeSet {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

export interface CapabilitiesReloadErrorSummary {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly errorName: string;
	readonly errorMessage: string;
}

export interface CapabilitiesReloadLastApplied {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly operation:
		| CapabilitiesReloadOperation
		| "skills_discovery"
		| "repl_turn_boundary";
	readonly trigger?: CapabilitiesReloadTrigger;
	readonly target: string | null;
}

export interface CapabilitiesReloadDomainStatus {
	readonly domain: CapabilitiesReloadDomain;
	readonly generation: number;
	readonly inFlight: boolean;
	readonly applyState: CapabilitiesReloadApplyState;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
	readonly error: CapabilitiesReloadErrorSummary | null;
	readonly lastApplied: CapabilitiesReloadLastApplied | null;
}

export interface CapabilitiesReloadManagementStatus {
	readonly config: CapabilitiesReloadDomainStatus;
	readonly mcp: CapabilitiesReloadDomainStatus;
	readonly skills: CapabilitiesReloadDomainStatus;
}

export interface McpServerChangeSet extends CapabilitiesReloadChangeSet {}

export interface McpReconnectLastApplied {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly mode: "repl_turn_boundary";
}

export type McpDynamicReconnectStatus =
	| {
			readonly status: "not_requested";
			readonly reason: "bootstrap";
			readonly applyState: "not_requested";
			readonly generation: number;
			readonly activeServerIds: readonly string[];
	  }
	| {
			readonly status: "unchanged";
			readonly applyState: "unchanged";
			readonly generation: number;
			readonly activeServerIds: readonly string[];
	  }
	| {
			readonly status: "pending_repl_apply";
			readonly reason: "applied_at_repl_turn_boundary";
			readonly applyState: "pending";
			readonly appliesAt: "repl_turn_boundary";
			readonly pendingReason: "waiting_for_repl_turn_boundary";
			readonly generation: number;
			readonly requestedAtEpochMs: number;
			readonly activeServerIds: readonly string[];
			readonly change: McpServerChangeSet;
	  }
	| {
			readonly status: "applied_at_repl_turn_boundary";
			readonly applyState: "applied";
			readonly generation: number;
			readonly activeServerIds: readonly string[];
			readonly change: McpServerChangeSet;
			readonly lastApplied: McpReconnectLastApplied;
	  };

export interface CapabilitiesReloadSuccessSnapshot {
	readonly generation: number;
	readonly operation: CapabilitiesReloadOperation;
	readonly trigger: CapabilitiesReloadTrigger;
	readonly completedAtEpochMs: number;
	readonly source: CapabilitiesConfigSource;
	readonly configPath: string | null;
	readonly change: CapabilitiesReloadChangeSet;
	readonly mcpReconnect: McpDynamicReconnectStatus;
}

export interface CapabilitiesReloadFailureSnapshot {
	readonly generation: number;
	readonly operation: "reload";
	readonly trigger: CapabilitiesReloadTrigger;
	readonly completedAtEpochMs: number;
	readonly errorName: string;
	readonly errorMessage: string;
}

export interface CapabilitiesSkillsReloadSnapshot {
	readonly generation: number;
	readonly completedAtEpochMs: number;
	readonly change: SkillsCatalogChange;
	readonly status: SkillsReloadStatus;
}

export interface CapabilitiesReloadStatus {
	readonly generation: number;
	readonly booted: boolean;
	readonly watching: boolean;
	readonly watchedPaths: readonly string[];
	readonly inFlight: boolean;
	readonly inFlightGenerations: readonly number[];
	readonly lastSuccess: CapabilitiesReloadSuccessSnapshot | null;
	readonly lastFailure: CapabilitiesReloadFailureSnapshot | null;
	readonly lastSkillsChange: CapabilitiesSkillsReloadSnapshot | null;
	readonly skillsStatus: SkillsReloadStatus | null;
	readonly mcpReconnect: McpDynamicReconnectStatus | null;
	readonly management: CapabilitiesReloadManagementStatus;
}

type CapabilitiesReloadStatusCore = Omit<
	CapabilitiesReloadStatus,
	"management"
>;

export type CapabilitiesReloadResult =
	| {
			readonly status: "success";
			readonly runtime: CapabilitiesRuntime;
			readonly snapshot: CapabilitiesReloadSuccessSnapshot;
	  }
	| {
			readonly status: "failure";
			readonly runtime: CapabilitiesRuntime;
			readonly snapshot: CapabilitiesReloadFailureSnapshot;
	  };

export type CapabilitiesHotReloadEvent =
	| {
			readonly event: "capabilities_runtime_reload";
			readonly status: "success";
			readonly snapshot: CapabilitiesReloadSuccessSnapshot;
	  }
	| {
			readonly event: "capabilities_runtime_reload";
			readonly status: "failure";
			readonly snapshot: CapabilitiesReloadFailureSnapshot;
	  }
	| {
			readonly event: "capabilities_skills_catalog_reload";
			readonly snapshot: CapabilitiesSkillsReloadSnapshot;
	  };

export interface CapabilitiesHotReloadOptions
	extends LoadCapabilitiesConfigOptions {
	readonly watchEnabled?: boolean;
	readonly debounceMs?: number;
	readonly watchFactory?: typeof watch;
	readonly discoverSkills?: boolean;
	readonly startSkillsWatching?: boolean;
	readonly logEvent?: (event: CapabilitiesHotReloadEvent) => void;
}

export class CapabilitiesRuntimeNotBootedError extends Error {
	constructor() {
		super("capabilities runtime not booted; call bootstrap() before accessor");
		this.name = "CapabilitiesRuntimeNotBootedError";
	}
}

export class CapabilitiesHotReloadController {
	private readonly loadOptions: LoadCapabilitiesConfigOptions;
	private readonly watchEnabled: boolean;
	private readonly debounceMs: number;
	private readonly watchFactory: typeof watch;
	private readonly discoverSkills: boolean;
	private readonly startSkillsWatching: boolean;
	private readonly logEvent?: (event: CapabilitiesHotReloadEvent) => void;
	private loaded: LoadedCapabilitiesConfig | null = null;
	private runtime: CapabilitiesRuntime | null = null;
	private generation = 0;
	private inFlightReloadGenerations = new Set<number>();
	private lastSuccess: CapabilitiesReloadSuccessSnapshot | null = null;
	private lastFailure: CapabilitiesReloadFailureSnapshot | null = null;
	private lastSkillsChange: CapabilitiesSkillsReloadSnapshot | null = null;
	private mcpReconnect: McpDynamicReconnectStatus | null = null;
	private configWatchers: FSWatcher[] = [];
	private watchedPaths: readonly string[] = [];
	private pendingReloadTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeSkillsChange: (() => void) | null = null;

	constructor(options: CapabilitiesHotReloadOptions) {
		this.loadOptions = {
			workspaceRoot: options.workspaceRoot,
			...(options.argv == null ? {} : { argv: options.argv }),
			...(options.env == null ? {} : { env: options.env }),
			...(options.cwd == null ? {} : { cwd: options.cwd }),
		};
		this.watchEnabled = options.watchEnabled ?? true;
		this.debounceMs = options.debounceMs ?? 200;
		this.watchFactory = options.watchFactory ?? watch;
		this.discoverSkills = options.discoverSkills ?? true;
		this.startSkillsWatching = options.startSkillsWatching ?? true;
		this.logEvent = options.logEvent;
	}

	async bootstrap(): Promise<CapabilitiesRuntime> {
		const loaded = await loadCapabilitiesConfig(this.loadOptions);
		const runtime = buildCapabilitiesRuntime(loaded);
		this.loaded = loaded;
		this.runtime = runtime;
		this.generation += 1;
		this.mcpReconnect = {
			status: "not_requested",
			reason: "bootstrap",
			applyState: "not_requested",
			generation: this.generation,
			activeServerIds: runtime.mcpServers.map((entry) => entry.id),
		};
		this.lastSuccess = buildCapabilitiesReloadSuccessSnapshot({
			generation: this.generation,
			operation: "bootstrap",
			trigger: "manual",
			previousLoaded: null,
			loaded,
			mcpReconnect: this.mcpReconnect,
		});
		await this.activateSkillsRuntime(runtime);
		if (this.watchEnabled) {
			this.rebuildConfigWatchers(loaded);
		}
		this.emit({
			event: "capabilities_runtime_reload",
			status: "success",
			snapshot: this.lastSuccess,
		});
		return runtime;
	}

	getRuntime(): CapabilitiesRuntime {
		if (this.runtime == null) {
			throw new CapabilitiesRuntimeNotBootedError();
		}
		return this.runtime;
	}

	getLoadedConfig(): LoadedCapabilitiesConfig {
		if (this.loaded == null) {
			throw new CapabilitiesRuntimeNotBootedError();
		}
		return this.loaded;
	}

	getStatus(): CapabilitiesReloadStatus {
		const inFlightGenerations = Array.from(this.inFlightReloadGenerations).sort(
			(left, right) => left - right,
		);
		const status = {
			generation: this.generation,
			booted: this.runtime != null,
			watching: this.configWatchers.length > 0,
			watchedPaths: [...this.watchedPaths],
			inFlight: inFlightGenerations.length > 0,
			inFlightGenerations,
			lastSuccess: cloneSuccessSnapshot(this.lastSuccess),
			lastFailure: this.lastFailure == null ? null : { ...this.lastFailure },
			lastSkillsChange: cloneSkillsSnapshot(this.lastSkillsChange),
			skillsStatus: this.runtime?.skillsManager?.getReloadStatus() ?? null,
			mcpReconnect: cloneMcpReconnect(this.mcpReconnect),
		};
		return {
			...status,
			management: buildCapabilitiesReloadManagementStatus(status),
		};
	}

	getManagementStatus(): CapabilitiesReloadManagementStatus {
		return this.getStatus().management;
	}

	markMcpReconnectAppliedAtReplTurnBoundary(
		completedAtEpochMs = Date.now(),
	): McpDynamicReconnectStatus | null {
		if (this.mcpReconnect?.status !== "pending_repl_apply") {
			return cloneMcpReconnect(this.mcpReconnect);
		}

		this.mcpReconnect = {
			status: "applied_at_repl_turn_boundary",
			applyState: "applied",
			generation: this.mcpReconnect.generation,
			activeServerIds: [...this.mcpReconnect.activeServerIds],
			change: cloneChangeSet(this.mcpReconnect.change),
			lastApplied: {
				generation: this.mcpReconnect.generation,
				completedAtEpochMs,
				mode: "repl_turn_boundary",
			},
		};
		if (this.lastSuccess != null) {
			this.lastSuccess = {
				...this.lastSuccess,
				mcpReconnect: this.mcpReconnect,
			};
		}
		return cloneMcpReconnect(this.mcpReconnect);
	}

	async reload(
		trigger: CapabilitiesReloadTrigger = "manual",
	): Promise<CapabilitiesReloadResult> {
		const currentRuntime = this.getRuntime();
		const commitGeneration = this.generation + 1;
		this.generation = commitGeneration;
		this.inFlightReloadGenerations.add(commitGeneration);
		try {
			const loaded = await loadCapabilitiesConfig(this.loadOptions);
			const runtime = buildCapabilitiesRuntime(loaded);
			if (commitGeneration !== this.generation) {
				return {
					status: "success",
					runtime: this.getRuntime(),
					snapshot: this.lastSuccess as CapabilitiesReloadSuccessSnapshot,
				};
			}

			const mcpReconnect = buildMcpReconnectStatus(
				currentRuntime.mcpServers,
				runtime.mcpServers,
				commitGeneration,
			);
			const previousLoaded = this.loaded;
			this.deactivateSkillsRuntime();
			currentRuntime.skillsManager?.stopWatching();
			this.loaded = loaded;
			this.runtime = runtime;
			this.mcpReconnect = mcpReconnect;
			this.lastSuccess = buildCapabilitiesReloadSuccessSnapshot({
				generation: commitGeneration,
				operation: "reload",
				trigger,
				previousLoaded,
				loaded,
				mcpReconnect,
			});
			await this.activateSkillsRuntime(runtime);
			if (this.watchEnabled) {
				this.rebuildConfigWatchers(loaded);
			}
			this.emit({
				event: "capabilities_runtime_reload",
				status: "success",
				snapshot: this.lastSuccess,
			});
			return {
				status: "success",
				runtime,
				snapshot: this.lastSuccess,
			};
		} catch (error) {
			if (commitGeneration === this.generation) {
				this.lastFailure = buildCapabilitiesReloadFailureSnapshot(
					commitGeneration,
					trigger,
					error,
				);
				this.emit({
					event: "capabilities_runtime_reload",
					status: "failure",
					snapshot: this.lastFailure,
				});
				return {
					status: "failure",
					runtime: currentRuntime,
					snapshot: this.lastFailure,
				};
			}
			return {
				status: "success",
				runtime: this.getRuntime(),
				snapshot: this.lastSuccess as CapabilitiesReloadSuccessSnapshot,
			};
		} finally {
			this.inFlightReloadGenerations.delete(commitGeneration);
		}
	}

	stopWatching(): void {
		if (this.pendingReloadTimer != null) {
			clearTimeout(this.pendingReloadTimer);
			this.pendingReloadTimer = null;
		}
		for (const watcher of this.configWatchers) {
			watcher.close();
		}
		this.configWatchers = [];
		this.watchedPaths = [];
	}

	dispose(): void {
		this.stopWatching();
		this.deactivateSkillsRuntime();
		this.runtime?.skillsManager?.stopWatching();
	}

	private async activateSkillsRuntime(
		runtime: CapabilitiesRuntime,
	): Promise<void> {
		const skillsManager = runtime.skillsManager;
		if (skillsManager == null) {
			return;
		}
		this.unsubscribeSkillsChange = skillsManager.onCatalogChange((change) => {
			this.lastSkillsChange = {
				generation: this.generation,
				completedAtEpochMs: Date.now(),
				change,
				status: skillsManager.getReloadStatus(),
			};
			this.emit({
				event: "capabilities_skills_catalog_reload",
				snapshot: this.lastSkillsChange,
			});
		});
		if (this.discoverSkills) {
			try {
				await skillsManager.discover();
			} catch {
				// SkillsManager stores discovery failures in its own reload status.
			}
		}
		if (this.startSkillsWatching) {
			skillsManager.startWatching();
		}
	}

	private deactivateSkillsRuntime(): void {
		this.unsubscribeSkillsChange?.();
		this.unsubscribeSkillsChange = null;
	}

	private rebuildConfigWatchers(loaded: LoadedCapabilitiesConfig): void {
		this.stopWatching();
		const watchPaths = resolveCapabilitiesWatchPaths(loaded);
		const watchers: FSWatcher[] = [];
		const watchedPaths: string[] = [];
		for (const path of watchPaths) {
			try {
				watchers.push(this.createConfigWatcher(path));
				watchedPaths.push(path);
			} catch (error) {
				this.lastFailure = buildCapabilitiesReloadFailureSnapshot(
					this.generation,
					"watch",
					error,
				);
			}
		}
		this.configWatchers = watchers;
		this.watchedPaths = watchedPaths;
	}

	private createConfigWatcher(path: string): FSWatcher {
		const onEvent: WatchListener<string> = () => {
			this.scheduleReload();
		};
		try {
			return this.watchFactory(path, { recursive: true }, onEvent);
		} catch {
			return this.watchFactory(path, {}, onEvent);
		}
	}

	private scheduleReload(): void {
		if (this.pendingReloadTimer != null) {
			clearTimeout(this.pendingReloadTimer);
		}
		this.pendingReloadTimer = setTimeout(() => {
			this.pendingReloadTimer = null;
			void this.reload("watch");
		}, this.debounceMs);
	}

	private emit(event: CapabilitiesHotReloadEvent): void {
		try {
			this.logEvent?.(event);
		} catch {
			// Hot reload event consumers must not break the runtime.
		}
	}
}

export function createCapabilitiesHotReloadController(
	options: CapabilitiesHotReloadOptions,
): CapabilitiesHotReloadController {
	return new CapabilitiesHotReloadController(options);
}

function resolveCapabilitiesWatchPaths(
	loaded: LoadedCapabilitiesConfig,
): readonly string[] {
	if (loaded.source.path != null) {
		return [loaded.source.path];
	}

	const projectConfigDir = join(loaded.workspaceRoot, ".quilin");
	return existsSync(projectConfigDir) ? [projectConfigDir] : [];
}

function configSourceLabel(source: CapabilitiesConfigSource): string {
	return source.path ?? source.kind;
}

function diffCapabilitiesConfigSources(
	previous: CapabilitiesConfigSource | null,
	next: CapabilitiesConfigSource,
	operation: CapabilitiesReloadOperation,
): CapabilitiesReloadChangeSet {
	const nextLabel = configSourceLabel(next);
	if (previous == null) {
		return {
			added: operation === "bootstrap" ? [nextLabel] : [],
			removed: [],
			changed: operation === "bootstrap" ? [] : [nextLabel],
		};
	}

	const previousLabel = configSourceLabel(previous);
	if (previousLabel !== nextLabel) {
		return {
			added: [nextLabel],
			removed: [previousLabel],
			changed: [],
		};
	}

	return {
		added: [],
		removed: [],
		changed: [nextLabel],
	};
}

function emptyChangeSet(): CapabilitiesReloadChangeSet {
	return {
		added: [],
		removed: [],
		changed: [],
	};
}

function latestFailureIsActive(input: {
	readonly successGeneration: number | null;
	readonly failureGeneration: number | null;
}): boolean {
	return (
		input.failureGeneration != null &&
		(input.successGeneration == null ||
			input.failureGeneration >= input.successGeneration)
	);
}

function failureToErrorSummary(
	failure:
		| CapabilitiesReloadFailureSnapshot
		| NonNullable<SkillsReloadStatus["lastFailure"]>,
): CapabilitiesReloadErrorSummary {
	return {
		generation: failure.generation,
		completedAtEpochMs: failure.completedAtEpochMs,
		errorName: failure.errorName,
		errorMessage: failure.errorMessage,
	};
}

function buildConfigManagementStatus(
	status: CapabilitiesReloadStatusCore,
): CapabilitiesReloadDomainStatus {
	const lastSuccess = status.lastSuccess;
	const lastFailure = status.lastFailure;
	const activeError = latestFailureIsActive({
		successGeneration: lastSuccess?.generation ?? null,
		failureGeneration: lastFailure?.generation ?? null,
	})
		? lastFailure
		: null;
	const change = lastSuccess?.change ?? emptyChangeSet();
	return {
		domain: "config",
		generation: status.generation,
		inFlight: status.inFlight,
		applyState:
			activeError != null
				? "error"
				: status.inFlight
					? "in_flight"
					: lastSuccess == null
						? "not_requested"
						: "applied",
		added: [...change.added],
		removed: [...change.removed],
		changed: [...change.changed],
		error: activeError == null ? null : failureToErrorSummary(activeError),
		lastApplied:
			lastSuccess == null
				? null
				: {
						generation: lastSuccess.generation,
						completedAtEpochMs: lastSuccess.completedAtEpochMs,
						operation: lastSuccess.operation,
						trigger: lastSuccess.trigger,
						target: lastSuccess.configPath ?? lastSuccess.source.kind,
					},
	};
}

function buildMcpManagementStatus(
	status: CapabilitiesReloadStatusCore,
): CapabilitiesReloadDomainStatus {
	const mcpReconnect = status.mcpReconnect;
	const change =
		mcpReconnect?.status === "pending_repl_apply" ||
		mcpReconnect?.status === "applied_at_repl_turn_boundary"
			? mcpReconnect.change
			: emptyChangeSet();
	return {
		domain: "mcp",
		generation: mcpReconnect?.generation ?? status.generation,
		inFlight: status.inFlight,
		applyState:
			mcpReconnect == null
				? "not_requested"
				: mcpReconnect.status === "pending_repl_apply"
					? "pending_repl_turn_boundary"
					: mcpReconnect.status === "applied_at_repl_turn_boundary"
						? "applied"
						: mcpReconnect.status === "unchanged"
							? "unchanged"
							: "not_requested",
		added: [...change.added],
		removed: [...change.removed],
		changed: [...change.changed],
		error: null,
		lastApplied:
			mcpReconnect?.status === "applied_at_repl_turn_boundary"
				? {
						generation: mcpReconnect.lastApplied.generation,
						completedAtEpochMs: mcpReconnect.lastApplied.completedAtEpochMs,
						operation: "repl_turn_boundary",
						target:
							mcpReconnect.activeServerIds.length === 0
								? null
								: mcpReconnect.activeServerIds.join(","),
					}
				: null,
	};
}

function buildSkillsManagementStatus(
	status: CapabilitiesReloadStatusCore,
): CapabilitiesReloadDomainStatus {
	const skillsStatus = status.skillsStatus;
	const lastSuccess = skillsStatus?.lastSuccess ?? null;
	const lastFailure = skillsStatus?.lastFailure ?? null;
	const activeError = latestFailureIsActive({
		successGeneration: lastSuccess?.generation ?? null,
		failureGeneration: lastFailure?.generation ?? null,
	})
		? lastFailure
		: null;
	const change = lastSuccess?.change ?? emptyChangeSet();
	return {
		domain: "skills",
		generation: skillsStatus?.generation ?? status.generation,
		inFlight: skillsStatus?.inFlight ?? false,
		applyState:
			activeError != null
				? "error"
				: skillsStatus?.inFlight === true
					? "in_flight"
					: lastSuccess == null
						? "not_requested"
						: change.added.length === 0 &&
								change.removed.length === 0 &&
								change.changed.length === 0
							? "unchanged"
							: "applied",
		added: [...change.added],
		removed: [...change.removed],
		changed: [...change.changed],
		error: activeError == null ? null : failureToErrorSummary(activeError),
		lastApplied:
			lastSuccess == null
				? null
				: {
						generation: lastSuccess.generation,
						completedAtEpochMs: lastSuccess.completedAtEpochMs,
						operation: "skills_discovery",
						target: String(lastSuccess.catalogSize),
					},
	};
}

function buildCapabilitiesReloadManagementStatus(
	status: CapabilitiesReloadStatusCore,
): CapabilitiesReloadManagementStatus {
	return {
		config: buildConfigManagementStatus(status),
		mcp: buildMcpManagementStatus(status),
		skills: buildSkillsManagementStatus(status),
	};
}

function buildCapabilitiesReloadSuccessSnapshot(input: {
	readonly generation: number;
	readonly operation: CapabilitiesReloadOperation;
	readonly trigger: CapabilitiesReloadTrigger;
	readonly previousLoaded: LoadedCapabilitiesConfig | null;
	readonly loaded: LoadedCapabilitiesConfig;
	readonly mcpReconnect: McpDynamicReconnectStatus;
}): CapabilitiesReloadSuccessSnapshot {
	return {
		generation: input.generation,
		operation: input.operation,
		trigger: input.trigger,
		completedAtEpochMs: Date.now(),
		source: input.loaded.source,
		configPath: input.loaded.source.path ?? null,
		change: diffCapabilitiesConfigSources(
			input.previousLoaded?.source ?? null,
			input.loaded.source,
			input.operation,
		),
		mcpReconnect: input.mcpReconnect,
	};
}

function buildCapabilitiesReloadFailureSnapshot(
	generation: number,
	trigger: CapabilitiesReloadTrigger,
	error: unknown,
): CapabilitiesReloadFailureSnapshot {
	return {
		generation,
		operation: "reload",
		trigger,
		completedAtEpochMs: Date.now(),
		errorName:
			error instanceof Error
				? error.name
				: typeof error === "string"
					? "Error"
					: "UnknownError",
		errorMessage:
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: "Unknown capabilities reload failure",
	};
}

function mcpServerSignature(entry: MCPServerEntry): string {
	return JSON.stringify({
		namespace: entry.namespace,
		defaultRiskLevel: entry.defaultRiskLevel,
		config: entry.config,
	});
}

function diffMcpServers(
	previous: readonly MCPServerEntry[],
	next: readonly MCPServerEntry[],
): McpServerChangeSet {
	const previousById = new Map(previous.map((entry) => [entry.id, entry]));
	const nextById = new Map(next.map((entry) => [entry.id, entry]));
	return {
		added: next
			.filter((entry) => !previousById.has(entry.id))
			.map((entry) => entry.id),
		removed: previous
			.filter((entry) => !nextById.has(entry.id))
			.map((entry) => entry.id),
		changed: next
			.filter((entry) => {
				const oldEntry = previousById.get(entry.id);
				return (
					oldEntry != null &&
					mcpServerSignature(oldEntry) !== mcpServerSignature(entry)
				);
			})
			.map((entry) => entry.id),
	};
}

function hasMcpChanges(change: McpServerChangeSet): boolean {
	return (
		change.added.length > 0 ||
		change.removed.length > 0 ||
		change.changed.length > 0
	);
}

function buildMcpReconnectStatus(
	previous: readonly MCPServerEntry[],
	next: readonly MCPServerEntry[],
	generation: number,
): McpDynamicReconnectStatus {
	const activeServerIds = next.map((entry) => entry.id);
	const change = diffMcpServers(previous, next);
	if (!hasMcpChanges(change)) {
		return {
			status: "unchanged",
			applyState: "unchanged",
			generation,
			activeServerIds,
		};
	}

	return {
		status: "pending_repl_apply",
		reason: "applied_at_repl_turn_boundary",
		applyState: "pending",
		appliesAt: "repl_turn_boundary",
		pendingReason: "waiting_for_repl_turn_boundary",
		generation,
		requestedAtEpochMs: Date.now(),
		activeServerIds,
		change,
	};
}

function cloneChangeSet<T extends CapabilitiesReloadChangeSet>(change: T): T {
	return {
		added: [...change.added],
		removed: [...change.removed],
		changed: [...change.changed],
	} as unknown as T;
}

function cloneMcpReconnect(
	status: McpDynamicReconnectStatus | null,
): McpDynamicReconnectStatus | null {
	if (status == null) {
		return null;
	}
	if (status.status === "pending_repl_apply") {
		return {
			...status,
			activeServerIds: [...status.activeServerIds],
			change: cloneChangeSet(status.change),
		};
	}
	if (status.status === "applied_at_repl_turn_boundary") {
		return {
			...status,
			activeServerIds: [...status.activeServerIds],
			change: cloneChangeSet(status.change),
			lastApplied: { ...status.lastApplied },
		};
	}
	return {
		...status,
		activeServerIds: [...status.activeServerIds],
	};
}

function cloneSuccessSnapshot(
	snapshot: CapabilitiesReloadSuccessSnapshot | null,
): CapabilitiesReloadSuccessSnapshot | null {
	if (snapshot == null) {
		return null;
	}
	return {
		...snapshot,
		source: { ...snapshot.source },
		change: cloneChangeSet(snapshot.change),
		mcpReconnect: cloneMcpReconnect(
			snapshot.mcpReconnect,
		) as McpDynamicReconnectStatus,
	};
}

function cloneSkillsSnapshot(
	snapshot: CapabilitiesSkillsReloadSnapshot | null,
): CapabilitiesSkillsReloadSnapshot | null {
	if (snapshot == null) {
		return null;
	}
	return {
		...snapshot,
		change: cloneChangeSet(snapshot.change),
		status: {
			...snapshot.status,
			inFlightGenerations: [...snapshot.status.inFlightGenerations],
			lastSuccess:
				snapshot.status.lastSuccess == null
					? null
					: {
							...snapshot.status.lastSuccess,
							change: cloneChangeSet(snapshot.status.lastSuccess.change),
						},
			lastFailure:
				snapshot.status.lastFailure == null
					? null
					: { ...snapshot.status.lastFailure },
		},
	};
}
