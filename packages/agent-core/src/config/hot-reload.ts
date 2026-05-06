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

export interface McpServerChangeSet {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

export type McpDynamicReconnectStatus =
	| {
			readonly status: "not_requested";
			readonly reason: "bootstrap";
			readonly activeServerIds: readonly string[];
	  }
	| {
			readonly status: "unchanged";
			readonly activeServerIds: readonly string[];
	  }
	| {
			readonly status: "pending_repl_apply";
			readonly reason: "applied_at_repl_turn_boundary";
			readonly activeServerIds: readonly string[];
			readonly change: McpServerChangeSet;
	  };

export interface CapabilitiesReloadSuccessSnapshot {
	readonly generation: number;
	readonly operation: CapabilitiesReloadOperation;
	readonly trigger: CapabilitiesReloadTrigger;
	readonly completedAtEpochMs: number;
	readonly source: CapabilitiesConfigSource;
	readonly configPath: string | null;
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
}

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
			activeServerIds: runtime.mcpServers.map((entry) => entry.id),
		};
		this.lastSuccess = buildCapabilitiesReloadSuccessSnapshot({
			generation: this.generation,
			operation: "bootstrap",
			trigger: "manual",
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
		return {
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
			);
			this.deactivateSkillsRuntime();
			currentRuntime.skillsManager?.stopWatching();
			this.loaded = loaded;
			this.runtime = runtime;
			this.mcpReconnect = mcpReconnect;
			this.lastSuccess = buildCapabilitiesReloadSuccessSnapshot({
				generation: commitGeneration,
				operation: "reload",
				trigger,
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

function buildCapabilitiesReloadSuccessSnapshot(input: {
	readonly generation: number;
	readonly operation: CapabilitiesReloadOperation;
	readonly trigger: CapabilitiesReloadTrigger;
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
): McpDynamicReconnectStatus {
	const activeServerIds = next.map((entry) => entry.id);
	const change = diffMcpServers(previous, next);
	if (!hasMcpChanges(change)) {
		return {
			status: "unchanged",
			activeServerIds,
		};
	}

	return {
		status: "pending_repl_apply",
		reason: "applied_at_repl_turn_boundary",
		activeServerIds,
		change,
	};
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
			change: {
				added: [...status.change.added],
				removed: [...status.change.removed],
				changed: [...status.change.changed],
			},
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
		change: {
			added: [...snapshot.change.added],
			removed: [...snapshot.change.removed],
			changed: [...snapshot.change.changed],
		},
		status: {
			...snapshot.status,
			inFlightGenerations: [...snapshot.status.inFlightGenerations],
			lastSuccess:
				snapshot.status.lastSuccess == null
					? null
					: {
							...snapshot.status.lastSuccess,
							change: {
								added: [...snapshot.status.lastSuccess.change.added],
								removed: [...snapshot.status.lastSuccess.change.removed],
								changed: [...snapshot.status.lastSuccess.change.changed],
							},
						},
			lastFailure:
				snapshot.status.lastFailure == null
					? null
					: { ...snapshot.status.lastFailure },
		},
	};
}
