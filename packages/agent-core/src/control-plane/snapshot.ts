import type {
	CapabilitiesReloadStatus,
	McpDynamicReconnectStatus,
} from "../config/hot-reload.js";
import {
	getUserRuntimeStateSnapshot,
	type UserRuntimeStateSnapshot,
} from "../config/runtime.js";
import type { UserConfigLoadResult } from "../config/user-config.js";
import {
	buildProviderLiveMatrix,
	DEFAULT_PROVIDER_CATALOG,
} from "../llm/provider.js";
import type { ProviderCatalog, ProviderLiveMatrixEntry } from "../llm/types.js";
import {
	adaptSupervisorProgressEventsToDashboardRecords,
	type SupervisorProgressDashboardRecord,
} from "../observability/dashboard.js";
import type { ObservabilityEventRecord } from "../observability/event-record.js";
import type { SpanSnapshot } from "../observability/span.js";
import type { TraceQuery, TraceStore } from "../observability/trace-store.js";
import { redactJsonLikeValue, redactString } from "../safety/redaction.js";
import type { SkillsReloadStatus } from "../skills/manager.js";
import type {
	SkillDescriptor,
	SkillSource,
	SkillTrustLevel,
} from "../skills/types.js";
import type { AgentState, Checkpoint, MessageRole } from "../state/types.js";
import type { MCPServerEntry } from "../tools/registry.js";
import type { ToolPromptDescriptor } from "../tools/tool-metadata.js";

export const CONTROL_PLANE_SNAPSHOT_SCHEMA_VERSION =
	"quilin.control_plane.snapshot.v1" as const;

const DEFAULT_SESSION_LIMIT = 20;
const DEFAULT_TRACE_LIMIT = 200;
const MESSAGE_PREVIEW_CHARS = 160;

export type ControlPlaneAgentStatus =
	| "ready"
	| "booting"
	| "degraded"
	| "offline";

export type ControlPlaneSessionSource =
	| "checkpoint"
	| "trace"
	| "checkpoint+trace";

export type ControlPlaneSessionStatus =
	| "active"
	| "terminal"
	| "failed"
	| "unknown";

export interface ControlPlaneSessionLastMessage {
	readonly role: MessageRole;
	readonly preview: string;
}

export interface ControlPlaneSessionSummary {
	readonly sessionId: string;
	readonly source: ControlPlaneSessionSource;
	readonly status: ControlPlaneSessionStatus;
	readonly createdAt?: string;
	readonly lastActiveAt?: string;
	readonly turnCount?: number;
	readonly messageCount?: number;
	readonly totalTokens?: number;
	readonly totalCostUsd?: number;
	readonly taskSummary?: string;
	readonly lastMessage?: ControlPlaneSessionLastMessage;
	readonly traceIds: readonly string[];
}

export interface ControlPlaneSkillSummary {
	readonly name: string;
	readonly description: string;
	readonly source: SkillSource;
	readonly trust?: SkillTrustLevel;
	readonly userInvocable: boolean;
	readonly modelInvocable: boolean;
	readonly mandatory: boolean;
	readonly path: string;
	readonly allowedToolCount: number;
	readonly requiredToolCount: number;
	readonly requiredToolsetCount: number;
	readonly dependencyCount: number;
}

export interface ControlPlaneSkillsCatalogView {
	readonly catalog: readonly ControlPlaneSkillSummary[];
	readonly total: number;
	readonly countsBySource: Readonly<Partial<Record<SkillSource, number>>>;
	readonly countsByTrust: Readonly<Partial<Record<SkillTrustLevel, number>>>;
	readonly recentSkillNames: readonly string[];
	readonly reloadStatus: SkillsReloadStatus | null;
}

export interface ControlPlaneMcpServerView {
	readonly id: string;
	readonly namespace: string;
	readonly status: "active" | "pending_repl_apply" | "configured";
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly defaultRiskLevel?: string;
}

export interface ControlPlaneMcpToolView {
	readonly name: string;
	readonly namespace?: string;
	readonly description: string;
	readonly category: string;
	readonly riskLevel: string;
}

export interface ControlPlaneMcpStatusView {
	readonly status: "active" | "pending_repl_apply" | "configured" | "empty";
	readonly configuredServers: readonly ControlPlaneMcpServerView[];
	readonly activeServerIds: readonly string[];
	readonly toolCount: number;
	readonly toolCountByNamespace: Readonly<Record<string, number>>;
	readonly tools: readonly ControlPlaneMcpToolView[];
	readonly reconnect: McpDynamicReconnectStatus | null;
}

export interface ControlPlaneConfigView {
	readonly redacted: unknown;
	readonly sources: UserConfigLoadResult["sources"] | null;
	readonly runtimeState: UserRuntimeStateSnapshot;
	readonly redaction: {
		readonly status: "applied";
		readonly secretFields: "redacted";
	};
}

export interface ControlPlaneAgentView {
	readonly status: ControlPlaneAgentStatus;
	readonly runtime: UserRuntimeStateSnapshot;
	readonly capabilities: CapabilitiesReloadStatus | null;
	readonly events: {
		readonly supervisor: readonly SupervisorProgressDashboardRecord[];
		readonly observability: readonly ObservabilityEventRecord[];
	};
}

export interface ControlPlaneSnapshot {
	readonly schemaVersion: typeof CONTROL_PLANE_SNAPSHOT_SCHEMA_VERSION;
	readonly generatedAt: string;
	readonly agent: ControlPlaneAgentView;
	readonly sessions: readonly ControlPlaneSessionSummary[];
	readonly skills: ControlPlaneSkillsCatalogView;
	readonly mcp: ControlPlaneMcpStatusView;
	readonly providers: readonly ProviderLiveMatrixEntry[];
	readonly config: ControlPlaneConfigView;
}

export interface ControlPlaneSkillsCatalogSource {
	list(): readonly SkillDescriptor[];
	getRecentSkillNames?(): readonly string[];
	getReloadStatus?(): SkillsReloadStatus;
}

export interface ControlPlaneMcpRegistrySource {
	getToolDescriptors(): readonly ToolPromptDescriptor[];
}

export interface ControlPlaneProviderCredentialProbe {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly existingCredentialPaths?: readonly string[];
}

export interface BuildControlPlaneSnapshotOptions {
	readonly now?: () => Date;
	readonly runtimeState?: UserRuntimeStateSnapshot;
	readonly capabilitiesStatus?: CapabilitiesReloadStatus | null;
	readonly config?: unknown;
	readonly configSources?: UserConfigLoadResult["sources"] | null;
	readonly checkpoint?: Pick<Checkpoint, "list" | "load">;
	readonly traceStore?: Pick<TraceStore, "querySpanSnapshots">;
	readonly traceQuery?: TraceQuery;
	readonly sessionLimit?: number;
	readonly skillsManager?: ControlPlaneSkillsCatalogSource;
	readonly mcpRegistry?: ControlPlaneMcpRegistrySource;
	readonly mcpServers?: readonly MCPServerEntry[];
	readonly providerCatalog?: ProviderCatalog;
	readonly providerProbe?: ControlPlaneProviderCredentialProbe;
	readonly supervisorEvents?: Parameters<
		typeof adaptSupervisorProgressEventsToDashboardRecords
	>[0];
	readonly supervisorRecords?: readonly SupervisorProgressDashboardRecord[];
	readonly observabilityEvents?: readonly ObservabilityEventRecord[];
}

function redactedClone<T>(value: T): T {
	return redactJsonLikeValue(value);
}

function definedString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isoFromUnixMs(value: number | undefined): string | undefined {
	return value == null ? undefined : new Date(value).toISOString();
}

function newerIso(
	left: string | undefined,
	right: string | undefined,
): string | undefined {
	if (left == null) {
		return right;
	}
	if (right == null) {
		return left;
	}
	return Date.parse(right) > Date.parse(left) ? right : left;
}

function olderIso(
	left: string | undefined,
	right: string | undefined,
): string | undefined {
	if (left == null) {
		return right;
	}
	if (right == null) {
		return left;
	}
	return Date.parse(right) < Date.parse(left) ? right : left;
}

function truncatePreview(value: string): string {
	const redacted = redactString(value).replace(/\s+/g, " ").trim();
	if (redacted.length <= MESSAGE_PREVIEW_CHARS) {
		return redacted;
	}
	return `${redacted.slice(0, MESSAGE_PREVIEW_CHARS)}...`;
}

function lastMessageSummary(
	state: AgentState,
): ControlPlaneSessionLastMessage | undefined {
	const message = [...state.messages]
		.reverse()
		.find((entry) => entry.role === "user" || entry.role === "assistant");
	if (message == null) {
		return undefined;
	}

	return {
		role: message.role,
		preview: truncatePreview(message.content),
	};
}

function sessionFromAgentState(
	sessionId: string,
	state: AgentState | null,
): ControlPlaneSessionSummary {
	if (state == null) {
		return {
			sessionId: redactString(sessionId),
			source: "checkpoint",
			status: "unknown",
			traceIds: [],
		};
	}

	return {
		sessionId: redactString(sessionId),
		source: "checkpoint",
		status: state.isTerminal ? "terminal" : "active",
		createdAt: state.createdAt,
		lastActiveAt: state.lastActiveAt,
		turnCount: state.turnCount,
		messageCount: state.messages.length,
		lastMessage: lastMessageSummary(state),
		traceIds: [],
	};
}

function sessionStatusFromSpan(span: SpanSnapshot): ControlPlaneSessionStatus {
	if (span.status === "error") {
		return "failed";
	}
	return span.endTimeUnixMs == null ? "active" : "terminal";
}

function sessionFromSpan(
	span: SpanSnapshot,
): ControlPlaneSessionSummary | null {
	if (span.name !== "agent.session") {
		return null;
	}

	const attrs = span.attributes;
	const sessionId = definedString(attrs["session.id"]) ?? span.traceId;
	const taskSummary = definedString(attrs["session.task_summary"]);
	const totalTokens = finiteNumber(attrs["session.total_tokens"]);
	const totalCostUsd = finiteNumber(attrs["session.total_cost_usd"]);
	const turnCount = finiteNumber(attrs["session.turn_count"]);

	return {
		sessionId: redactString(sessionId),
		source: "trace",
		status: sessionStatusFromSpan(span),
		createdAt: isoFromUnixMs(span.startTimeUnixMs),
		lastActiveAt: isoFromUnixMs(span.endTimeUnixMs ?? span.startTimeUnixMs),
		...(turnCount == null ? {} : { turnCount }),
		...(totalTokens == null ? {} : { totalTokens }),
		...(totalCostUsd == null ? {} : { totalCostUsd }),
		...(taskSummary == null
			? {}
			: { taskSummary: truncatePreview(taskSummary) }),
		traceIds: [span.traceId],
	};
}

function mergeSources(
	left: ControlPlaneSessionSource,
	right: ControlPlaneSessionSource,
): ControlPlaneSessionSource {
	return left === right ? left : "checkpoint+trace";
}

function mergeSessionStatus(
	left: ControlPlaneSessionStatus,
	right: ControlPlaneSessionStatus,
): ControlPlaneSessionStatus {
	if (left === "failed" || right === "failed") {
		return "failed";
	}
	if (left === "active" || right === "active") {
		return "active";
	}
	if (left === "terminal" || right === "terminal") {
		return "terminal";
	}
	return "unknown";
}

function maxNumber(
	left: number | undefined,
	right: number | undefined,
): number | undefined {
	if (left == null) {
		return right;
	}
	if (right == null) {
		return left;
	}
	return Math.max(left, right);
}

function mergeSessionSummaries(
	left: ControlPlaneSessionSummary,
	right: ControlPlaneSessionSummary,
): ControlPlaneSessionSummary {
	return {
		sessionId: left.sessionId,
		source: mergeSources(left.source, right.source),
		status: mergeSessionStatus(left.status, right.status),
		createdAt: olderIso(left.createdAt, right.createdAt),
		lastActiveAt: newerIso(left.lastActiveAt, right.lastActiveAt),
		turnCount: maxNumber(left.turnCount, right.turnCount),
		messageCount: maxNumber(left.messageCount, right.messageCount),
		totalTokens: maxNumber(left.totalTokens, right.totalTokens),
		totalCostUsd: maxNumber(left.totalCostUsd, right.totalCostUsd),
		taskSummary: left.taskSummary ?? right.taskSummary,
		lastMessage: left.lastMessage ?? right.lastMessage,
		traceIds: Array.from(new Set([...left.traceIds, ...right.traceIds])).sort(),
	};
}

async function listCheckpointSessions(
	checkpoint: Pick<Checkpoint, "list" | "load"> | undefined,
	limit: number,
): Promise<readonly ControlPlaneSessionSummary[]> {
	if (checkpoint == null || limit <= 0) {
		return [];
	}

	const sessionIds = (await checkpoint.list()).slice(0, limit);
	const sessions: ControlPlaneSessionSummary[] = [];
	for (const sessionId of sessionIds) {
		try {
			sessions.push(
				sessionFromAgentState(sessionId, await checkpoint.load(sessionId)),
			);
		} catch {
			sessions.push(sessionFromAgentState(sessionId, null));
		}
	}
	return sessions;
}

async function listTraceSessions(
	traceStore: Pick<TraceStore, "querySpanSnapshots"> | undefined,
	query: TraceQuery,
): Promise<readonly ControlPlaneSessionSummary[]> {
	if (traceStore == null) {
		return [];
	}

	const result = await traceStore.querySpanSnapshots(query);
	return result.spans
		.map(sessionFromSpan)
		.filter(
			(session): session is ControlPlaneSessionSummary => session != null,
		);
}

async function buildSessions(
	options: BuildControlPlaneSnapshotOptions,
): Promise<readonly ControlPlaneSessionSummary[]> {
	const limit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT;
	const traceQuery: TraceQuery = {
		limit: DEFAULT_TRACE_LIMIT,
		...options.traceQuery,
	};
	const sessions = [
		...(await listCheckpointSessions(options.checkpoint, limit)),
		...(await listTraceSessions(options.traceStore, traceQuery)),
	];
	const byId = new Map<string, ControlPlaneSessionSummary>();

	for (const session of sessions) {
		const existing = byId.get(session.sessionId);
		byId.set(
			session.sessionId,
			existing == null ? session : mergeSessionSummaries(existing, session),
		);
	}

	return [...byId.values()]
		.sort((left, right) => {
			const leftTime = Date.parse(left.lastActiveAt ?? left.createdAt ?? "");
			const rightTime = Date.parse(right.lastActiveAt ?? right.createdAt ?? "");
			const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
			const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
			return (
				safeRight - safeLeft || left.sessionId.localeCompare(right.sessionId)
			);
		})
		.slice(0, limit);
}

function incrementCount<TKey extends string>(
	counts: Partial<Record<TKey, number>>,
	key: TKey | undefined,
): void {
	if (key == null) {
		return;
	}
	counts[key] = (counts[key] ?? 0) + 1;
}

function dependencyCount(descriptor: SkillDescriptor): number {
	const dependencies = descriptor.frontmatter.dependencies;
	return (
		(dependencies?.skills?.length ?? 0) +
		(dependencies?.tools?.length ?? 0) +
		(dependencies?.toolsets?.length ?? 0) +
		(dependencies?.packages?.length ?? 0)
	);
}

function summarizeSkill(descriptor: SkillDescriptor): ControlPlaneSkillSummary {
	return {
		name: redactString(descriptor.name),
		description: redactString(descriptor.description),
		source: descriptor.source,
		...(descriptor.frontmatter.trust == null
			? {}
			: { trust: descriptor.frontmatter.trust }),
		userInvocable: descriptor.frontmatter.userInvocable,
		modelInvocable: !descriptor.frontmatter.disableModelInvocation,
		mandatory: descriptor.frontmatter.mandatory === true,
		path: redactString(descriptor.path),
		allowedToolCount: descriptor.frontmatter.allowedTools?.length ?? 0,
		requiredToolCount: descriptor.frontmatter.requiresTools?.length ?? 0,
		requiredToolsetCount: descriptor.frontmatter.requiresToolsets?.length ?? 0,
		dependencyCount: dependencyCount(descriptor),
	};
}

function buildSkillsCatalogView(
	skillsManager: ControlPlaneSkillsCatalogSource | undefined,
): ControlPlaneSkillsCatalogView {
	const descriptors = skillsManager?.list() ?? [];
	const catalog = descriptors
		.map(summarizeSkill)
		.sort((left, right) => left.name.localeCompare(right.name));
	const countsBySource: Partial<Record<SkillSource, number>> = {};
	const countsByTrust: Partial<Record<SkillTrustLevel, number>> = {};

	for (const skill of catalog) {
		incrementCount(countsBySource, skill.source);
		incrementCount(countsByTrust, skill.trust);
	}

	return {
		catalog,
		total: catalog.length,
		countsBySource,
		countsByTrust,
		recentSkillNames: (skillsManager?.getRecentSkillNames?.() ?? []).map(
			redactString,
		),
		reloadStatus: redactedClone(skillsManager?.getReloadStatus?.() ?? null),
	};
}

function activeServerIdsFromReconnect(
	reconnect: McpDynamicReconnectStatus | null | undefined,
): readonly string[] {
	return reconnect?.activeServerIds ?? [];
}

function serverStatus(
	serverId: string,
	reconnect: McpDynamicReconnectStatus | null,
): ControlPlaneMcpServerView["status"] {
	if (reconnect?.status === "pending_repl_apply") {
		if (
			reconnect.activeServerIds.includes(serverId) ||
			reconnect.change.added.includes(serverId) ||
			reconnect.change.changed.includes(serverId)
		) {
			return "pending_repl_apply";
		}
	}
	return reconnect?.activeServerIds.includes(serverId)
		? "active"
		: "configured";
}

function summarizeMcpServer(
	entry: MCPServerEntry,
	reconnect: McpDynamicReconnectStatus | null,
): ControlPlaneMcpServerView {
	return {
		id: redactString(entry.id),
		namespace: redactString(entry.namespace),
		status: serverStatus(entry.id, reconnect),
		command: redactString(entry.config.command),
		args: entry.config.args.map(redactString),
		...(entry.config.cwd == null
			? {}
			: { cwd: redactString(entry.config.cwd) }),
		...(entry.defaultRiskLevel == null
			? {}
			: { defaultRiskLevel: entry.defaultRiskLevel }),
	};
}

function namespaceFromToolName(name: string): string | undefined {
	const slashIndex = name.indexOf("/");
	return slashIndex === -1 ? undefined : name.slice(0, slashIndex);
}

function summarizeTool(tool: ToolPromptDescriptor): ControlPlaneMcpToolView {
	const namespace = namespaceFromToolName(tool.name);
	return {
		name: redactString(tool.name),
		...(namespace == null ? {} : { namespace: redactString(namespace) }),
		description: redactString(tool.description),
		category: tool.category,
		riskLevel: tool.riskLevel,
	};
}

function buildMcpStatusView(
	mcpRegistry: ControlPlaneMcpRegistrySource | undefined,
	mcpServers: readonly MCPServerEntry[] | undefined,
	capabilitiesStatus: CapabilitiesReloadStatus | null,
): ControlPlaneMcpStatusView {
	const reconnect = capabilitiesStatus?.mcpReconnect ?? null;
	const tools = (mcpRegistry?.getToolDescriptors() ?? []).map(summarizeTool);
	const toolCountByNamespace: Record<string, number> = {};

	for (const tool of tools) {
		const namespace = tool.namespace ?? "builtin";
		toolCountByNamespace[namespace] =
			(toolCountByNamespace[namespace] ?? 0) + 1;
	}

	const configuredServers = (mcpServers ?? []).map((entry) =>
		summarizeMcpServer(entry, reconnect),
	);
	const activeServerIds =
		activeServerIdsFromReconnect(reconnect).map(redactString);
	const hasPendingReconnect = reconnect?.status === "pending_repl_apply";

	return {
		status:
			tools.length > 0 || activeServerIds.length > 0
				? "active"
				: hasPendingReconnect
					? "pending_repl_apply"
					: configuredServers.length > 0
						? "configured"
						: "empty",
		configuredServers,
		activeServerIds,
		toolCount: tools.length,
		toolCountByNamespace,
		tools,
		reconnect: redactedClone(reconnect),
	};
}

function buildConfigView(
	config: unknown,
	sources: UserConfigLoadResult["sources"] | null | undefined,
	runtimeState: UserRuntimeStateSnapshot,
): ControlPlaneConfigView {
	return {
		redacted: redactedClone(config ?? null),
		sources: sources == null ? null : redactedClone(sources),
		runtimeState: redactedClone(runtimeState),
		redaction: {
			status: "applied",
			secretFields: "redacted",
		},
	};
}

function deriveAgentStatus(
	runtimeState: UserRuntimeStateSnapshot,
	capabilitiesStatus: CapabilitiesReloadStatus | null,
): ControlPlaneAgentStatus {
	if (runtimeState.inFlight || capabilitiesStatus?.inFlight === true) {
		return "booting";
	}
	if (
		runtimeState.lastFailure != null ||
		capabilitiesStatus?.lastFailure != null
	) {
		return "degraded";
	}
	if (!runtimeState.booted || capabilitiesStatus?.booted === false) {
		return "offline";
	}
	return "ready";
}

function buildSupervisorRecords(
	options: BuildControlPlaneSnapshotOptions,
): readonly SupervisorProgressDashboardRecord[] {
	return redactedClone([
		...(options.supervisorRecords ?? []),
		...adaptSupervisorProgressEventsToDashboardRecords(
			options.supervisorEvents ?? [],
		),
	]).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function buildAgentView(
	runtimeState: UserRuntimeStateSnapshot,
	capabilitiesStatus: CapabilitiesReloadStatus | null,
	options: BuildControlPlaneSnapshotOptions,
): ControlPlaneAgentView {
	return {
		status: deriveAgentStatus(runtimeState, capabilitiesStatus),
		runtime: redactedClone(runtimeState),
		capabilities: redactedClone(capabilitiesStatus),
		events: {
			supervisor: buildSupervisorRecords(options),
			observability: redactedClone(options.observabilityEvents ?? []),
		},
	};
}

export async function buildControlPlaneSnapshot(
	options: BuildControlPlaneSnapshotOptions = {},
): Promise<ControlPlaneSnapshot> {
	const now = options.now ?? (() => new Date());
	const runtimeState = redactedClone(
		options.runtimeState ?? getUserRuntimeStateSnapshot(),
	);
	const capabilitiesStatus = redactedClone(options.capabilitiesStatus ?? null);

	return {
		schemaVersion: CONTROL_PLANE_SNAPSHOT_SCHEMA_VERSION,
		generatedAt: now().toISOString(),
		agent: buildAgentView(runtimeState, capabilitiesStatus, options),
		sessions: await buildSessions(options),
		skills: buildSkillsCatalogView(options.skillsManager),
		mcp: buildMcpStatusView(
			options.mcpRegistry,
			options.mcpServers,
			capabilitiesStatus,
		),
		providers: buildProviderLiveMatrix(
			options.providerCatalog ?? DEFAULT_PROVIDER_CATALOG,
			options.providerProbe,
		),
		config: buildConfigView(
			options.config,
			options.configSources,
			runtimeState,
		),
	};
}
