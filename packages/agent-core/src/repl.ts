import { createHash } from "node:crypto";
import { stderr, stdin, stdout } from "node:process";
import { clearScreenDown, emitKeypressEvents, moveCursor } from "node:readline";
import * as readline from "node:readline/promises";
import type { CapabilitiesReloadStatus } from "./config/hot-reload.js";
import type { CapabilitiesRuntime } from "./config/loader.js";
import {
	isRuntimeToolEnabled,
	type RuntimeToolFilter,
} from "./config/runtime.js";
import type { UserConfig } from "./config/user-config-schema.js";
import { createDefaultPromptSections } from "./context/default-sections.js";
import {
	BasicContextManager,
	DEFAULT_CONTEXT_BUDGET,
} from "./context/manager.js";
import { PromptBuilder } from "./context/prompt-builder.js";
import { PromptSessionAssembler } from "./context/prompt-session-assembler.js";
import {
	createHotSkillsSection,
	createPostCompactSkillsSection,
	createSkillsCatalogSection,
} from "./context/skills-catalog-section.js";
import { createTemporalBucketSection } from "./context/temporal.js";
import { estimateTokens } from "./context/tokens.js";
import type { TokenBudget } from "./context/types.js";
import {
	normalizeProviderError,
	ProviderControlPlaneLLMClient,
	StreamingLLMClient,
} from "./llm/client.js";
import { type createProvider, decideLLMRoute } from "./llm/provider.js";
import type {
	InferenceConfig,
	LLMProviderId,
	LLMStreamEvent,
	LLMTierRoutingConfig,
	ProviderRunRecord,
} from "./llm/types.js";
import { logger } from "./logger.js";
import { runAgentLoop } from "./loop.js";
import {
	getOrCreateAgentService,
	listAgentServiceSessions,
} from "./repl/agent-service-bridge.js";
import { AgentLoopError } from "./loop-types.js";
import {
	createObserverBridgeIfEnabled,
	type ObserverBridge,
} from "./memory/observer-bridge.js";
import {
	type ChildRunStatusRecord,
	InProcessSupervisorRuntime,
	type SupervisorProgressEvent,
	type SupervisorRuntimeSnapshot,
} from "./multi-agent/index.js";
import {
	type AgentRunLogSink,
	createToolProvenanceEntry,
	JsonlAgentRunLogger,
	recordAgentRunEvent,
	summarizeProviderRunRecord,
	type ToolProvenanceEntry,
} from "./observability/agent-run-log.js";
import type { SpanExporter } from "./observability/exporters/composite.js";
import type { AgentLoopObservability } from "./observability/loop.js";
import { LiveInputQueue, type QueuedLiveInput } from "./runtime/live-input.js";
import {
	type AuthorityMode,
	WriteAuthority,
} from "./safety/write-authority.js";
import type {
	JsonlProposalStore,
	ProposalApplyOutcome,
	ProposalApplyResult,
} from "./self-evolution/proposal-store.js";
import {
	createDockerProposalSandboxPolicyGate,
	type ProposalSandboxPolicyGate,
} from "./self-evolution/sandbox-policy-gate.js";
import type { JsonlTrajectoryStore } from "./self-evolution/trajectory-store.js";
import type {
	StoredProposalRecord,
	TrajectoryRecordInput,
} from "./self-evolution/types.js";
import type { SkillsCatalogChange, SkillsManager } from "./skills/manager.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import type { AgentState, Message } from "./state/types.js";
import { createBuiltinTools } from "./tools/builtin/index.js";
import { MCPRegistry, type MCPServerEntry } from "./tools/registry.js";
import type { SandboxApprovalRequest } from "./tools/router.js";
import type { ToolWithMetadata } from "./tools/tool-metadata.js";
import type { Tool } from "./tools/types.js";
import { renderPanel, renderTable, type TableColumn } from "./tui/renderer.js";

const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
	temperature: 0.7,
	maxTokens: 4096,
	thinkingMode: "disabled",
};
const REPL_PROMPT = "quilin> ";
const RECENT_AGENT_EVENT_LIMIT = 5;

interface SlashCommandEntry {
	readonly name: string;
	readonly signature: string;
	readonly description: string;
}

const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
	{
		name: "help",
		signature: "/help",
		description: "Show this command list",
	},
	{
		name: "status",
		signature: "/status",
		description: "Show model, routing, and reasoning state",
	},
	{
		name: "agents",
		signature: "/agents",
		description: "Show local subagent runtime state",
	},
	{
		name: "think",
		signature: "/think on|off|auto",
		description: "Set thinking mode",
	},
	{
		name: "verbose",
		signature: "/verbose",
		description: "Show reasoning stream",
	},
	{
		name: "collapse",
		signature: "/collapse",
		description: "Hide reasoning stream",
	},
	{
		name: "clear",
		signature: "/clear",
		description: "Clear the conversation",
	},
	{
		name: "exit",
		signature: "/exit",
		description: "Save and quit",
	},
	{
		name: "resume",
		signature: "/resume [<number>]",
		description: "List or resume saved sessions",
	},
	{
		name: "sessions",
		signature: "/sessions",
		description: "List in-process AgentService sessions (TUI + web + admin)",
	},
	{
		name: "mcp",
		signature: "/mcp",
		description: "List registered MCP servers",
	},
	{
		name: "proposals",
		signature: "/proposals [--limit N]",
		description: "List pending self-evolution proposals",
	},
	{
		name: "proposal-approve",
		signature: "/proposal-approve <proposalId> [--reviewer <name>] [--yes]",
		description: "Approve a pending proposal",
	},
	{
		name: "proposal-reject",
		signature:
			'/proposal-reject <proposalId> --reason "..." [--reviewer <name>]',
		description: "Reject a pending proposal",
	},
	{
		name: "proposal-apply",
		signature: "/proposal-apply [--limit N]",
		description: "Apply approved proposals via WriteAuthority",
	},
	{
		name: "quit",
		signature: "/quit",
		description: "Save and quit",
	},
];

/**
 * Late-bound runtime references exposed to the embedder once the REPL has
 * constructed its dependencies. Consumed by `index.ts` to wire dashboard
 * data providers (tasks / memory / tools panels) without forcing those
 * runtime objects to be passed in from outside `startRepl`.
 *
 * REPL 构造完依赖后回传给宿主的运行时引用集合。`index.ts` 用它把
 * dashboard 的 tasks / memory / tools 面板接到真实数据源，而不需要
 * 把这些运行时对象塞进 `startRepl` 的入参。
 */
export interface ReplRuntimeRefs {
	readonly registry: MCPRegistry;
	readonly supervisorRuntime: SupervisorRuntimeControlPlane;
}

interface ReplOptions {
	provider: ReturnType<typeof createProvider>;
	providerId?: LLMProviderId;
	modelId: string;
	sessionId?: string;
	observability?: AgentLoopObservability;
	spanExporter?: SpanExporter;
	tools?: readonly Tool[];
	mcpServers?: readonly MCPServerEntry[];
	skillsManager?: SkillsManager;
	capabilitiesRuntime?: () => CapabilitiesRuntime;
	inferenceConfig?: InferenceConfig;
	tierRouting?: LLMTierRoutingConfig;
	writeAuthorityMode?: AuthorityMode;
	toolFilter?: RuntimeToolFilter;
	capabilitiesStatus?: () => CapabilitiesReloadStatus;
	supervisorRuntime?: SupervisorRuntimeControlPlane;
	agentRunLogger?: AgentRunLogSink;
	trajectoryStore?: JsonlTrajectoryStore;
	onIdle?: () => Promise<void>;
	// Self-evolution proposal review store. When provided, REPL exposes
	// /proposals, /proposal-approve, /proposal-reject, /proposal-apply
	// slash commands so users can review and act on pending proposals.
	// 自进化提案审核存储。提供后，REPL 暴露上述 slash 命令，
	// 让用户能在终端查看 pending 提案、approve/reject、并触发 apply。
	proposalStore?: JsonlProposalStore;
	/**
	 * Sandbox policy gate consulted by `/proposal-apply` before scaffold-patch
	 * applies (round-2 cross-review fix QUI-97). The REPL passes this gate to
	 * `JsonlProposalStore.applyApproved`; when omitted, the default
	 * `DockerProposalSandboxPolicyGate` is used so scaffold_patch applies are
	 * never silently bypassed (07 §2.6.5). Tests / embedders that want to
	 * keep the legacy "no gate" behavior on artifact-only proposals can pass
	 * a no-op gate.
	 *
	 * sandbox 策略闸门：`/proposal-apply` 在 scaffold patch apply 之前咨询此
	 * 闸门（QUI-97 round-2 修复）。未提供时使用默认 Docker gate，避免静默
	 * 绕过沙箱（07 §2.6.5）。
	 */
	proposalSandboxPolicyGate?: ProposalSandboxPolicyGate;
	/**
	 * Optional hook fired once the REPL has constructed its `WriteAuthority`
	 * gate. Lets the embedder bind the live authority to dependencies that
	 * were instantiated earlier (e.g. `IdleEvolutionRunner`, which must
	 * route every idle proposal append through the gate per
	 * docs/07 §2.6.4).
	 *
	 * REPL 构造好 WriteAuthority gate 后触发的可选钩子。让宿主把活的
	 * authority 绑定到提前实例化的依赖（例如 IdleEvolutionRunner——按
	 * docs/07 §2.6.4，每次 idle 提案 append 都必须走该 gate）。
	 */
	onWriteAuthorityReady?: (authority: WriteAuthority) => void;
	/**
	 * Optional hook fired once the REPL has constructed its `MCPRegistry`
	 * and `SupervisorRuntimeControlPlane`. Used by the embedder (index.ts)
	 * to late-bind dashboard data providers to live runtime sources —
	 * without this hook the providers would have to be wired before the
	 * REPL is started, which is impossible because `MCPRegistry` is
	 * instantiated inside `startRepl`. See QUI-105 round 2.
	 *
	 * REPL 构造好 MCPRegistry 与 SupervisorRuntimeControlPlane 后触发的
	 * 可选钩子。宿主（index.ts）用它把 dashboard data provider 晚绑到
	 * 真实运行时数据源——没有这个钩子，provider 只能在 REPL 启动前
	 * 绑定，而 MCPRegistry 是在 startRepl 内部才实例化的。详见 QUI-105
	 * round 2。
	 */
	onRuntimeReady?: (runtime: ReplRuntimeRefs) => void;
	onProviderRunRecord?: (record: ProviderRunRecord) => void;
	onMcpReconnectApplied?: () => void;
	// Provides the loaded user config so REPL can wire user-tuned
	// settings (e.g. context.budget, config_view) into runAgentLoop.
	// Optional — when null, runAgentLoop falls back to defaults.
	getUserConfig?: () => UserConfig | null;
}

interface SupervisorRuntimeControlPlane {
	snapshot(): SupervisorRuntimeSnapshot;
	getNotificationStatus?(): unknown;
	notificationStatus?(): unknown;
	notifications?(): unknown;
}

interface NotificationStatusProbe {
	readonly source: string;
	readonly value: unknown;
}

function createState(
	messages: readonly Message[],
	overrides: Partial<AgentState> = {},
): AgentState {
	const now = new Date().toISOString();

	return {
		messages,
		isTerminal: false,
		turnCount: 0,
		createdAt: now,
		lastActiveAt: now,
		...overrides,
	};
}

function createDefaultAgentRunLogger(
	sessionId: string,
): AgentRunLogSink | undefined {
	const explicit = process.env.QUILIN_AGENT_RUN_LOG?.toLowerCase();
	if (explicit === "off" || explicit === "false" || explicit === "0") {
		return undefined;
	}
	if (process.env.NODE_ENV === "test" && explicit == null) {
		return undefined;
	}
	const env = process.env.QUILIN_ENV ?? "dev";
	if (explicit == null && env === "prod") {
		return undefined;
	}
	return new JsonlAgentRunLogger({ sessionId });
}

interface ReplPromptSession {
	readonly assembler: PromptSessionAssembler;
	dispose(): void;
}

function createPromptSessionAssembler(
	modelId: string,
	registry: MCPRegistry,
	sessionStartedAt: string,
	lastSessionEndTime?: string,
	skillsManager?: SkillsManager,
	toolFilter?: RuntimeToolFilter,
	getToolProvenance?: () => readonly ToolProvenanceEntry[],
): ReplPromptSession {
	const promptBuilder = new PromptBuilder();
	for (const section of createDefaultPromptSections()) {
		promptBuilder.register(section);
	}
	if (skillsManager != null) {
		promptBuilder.register(createSkillsCatalogSection(skillsManager));
		promptBuilder.register(createHotSkillsSection(skillsManager));
		promptBuilder.register(createPostCompactSkillsSection(skillsManager));
	}
	promptBuilder.register(createTemporalBucketSection());

	const assembler = new PromptSessionAssembler({
		promptBuilder,
		modelId,
		sessionStartedAt,
		lastSessionEndedAt: lastSessionEndTime,
		now: () => new Date(),
		// System prompt only exposes tool_search as gateway;
		// all tools remain registered in ToolRouter for actual execution.
		// Only expose search/discovery tools; use them to find everything else.
		// All tools are registered in ToolRouter and callable once discovered.
		getAvailableTools: () => ["tool_search", "skill_search", "mcp_search"],
		getAvailableToolDescriptors: () =>
			filterToolsByRuntimeConfig(
				registry.getToolDescriptors(),
				toolFilter,
			).filter((t) =>
				["tool_search", "skill_search", "mcp_search"].includes(t.name ?? ""),
			),
		getSessionState: () => ({
			skills: {
				recentSkillNames: skillsManager?.getRecentSkillNames() ?? [],
			},
			toolProvenance: {
				recent: getToolProvenance?.().slice(-12) ?? [],
			},
		}),
	});

	const disposers: Array<() => void> = [];
	disposers.push(
		registry.onChange(() => {
			assembler.invalidateSessionPrefix("tool-registry-changed");
		}),
	);
	const unsubscribeSkillsCatalog = skillsManager?.onCatalogChange(() => {
		assembler.invalidateSessionPrefix("skills-catalog-changed");
	});
	if (unsubscribeSkillsCatalog != null) {
		disposers.push(unsubscribeSkillsCatalog);
	}

	return {
		assembler,
		dispose: () => {
			for (const dispose of disposers.splice(0)) {
				dispose();
			}
		},
	};
}

function withDefaultMetadata(tools: readonly Tool[]): ToolWithMetadata[] {
	return tools.map((tool) => ({
		...tool,
		category: "programmatic",
		riskLevel: "read",
	}));
}

function formatReplList(values: readonly string[]): string {
	return values.length === 0 ? "none" : values.join(",");
}

interface ResumeSessionSummary {
	readonly sessionId: string;
	readonly lastMessage: string;
	readonly messageCount: number;
	readonly lastActiveAt: string;
}

function formatResumeTime(isoTimestamp: string): string {
	// ISO 8601 → "MM-DD HH:mm"
	const month = isoTimestamp.slice(5, 7);
	const day = isoTimestamp.slice(8, 10);
	const hour = isoTimestamp.slice(11, 13);
	const minute = isoTimestamp.slice(14, 16);
	return `${month}-${day} ${hour}:${minute}`;
}

interface ResumeSessionRow {
	readonly num: string;
	readonly time: string;
	readonly message: string;
}

function renderResumeSessionsTable(
	sessions: readonly ResumeSessionSummary[],
): string {
	const columns: TableColumn<ResumeSessionRow>[] = [
		{ header: " #", key: "num", align: "left" },
		{ header: " 时间", key: "time" },
		{ header: " 最后输入", key: "message" },
	];

	const rows: ResumeSessionRow[] = sessions.map((session, index) => ({
		num: String(index + 1),
		time: formatResumeTime(session.lastActiveAt),
		message: session.lastMessage,
	}));

	return `${renderTable(columns, rows)}\n输入 /resume <编号> 恢复会话`;
}

/**
 * Render the in-process AgentService session list for the `/sessions`
 * command (Candidate 1 Slice A). Columns intentionally mirror
 * `renderResumeSessionsTable` for visual consistency, plus an
 * `origin` column so the user can tell at a glance which sessions
 * came from the web vs the TUI vs admin/API consumers.
 *
 * AgentService session 列表渲染。栏目对齐 /resume 表,加 origin 区分来源。
 */
interface AgentServiceSessionRow {
	readonly id: string;
	readonly origin: string;
	readonly status: string;
	readonly title: string;
	readonly time: string;
}

function formatAgentServiceTime(iso: string): string {
	try {
		return new Date(iso).toLocaleString("zh-CN", { hour12: false });
	} catch {
		return iso;
	}
}

function renderAgentServiceSessionsTable(
	sessions: readonly { readonly id: string; readonly origin: string; readonly status: string; readonly title: string; readonly lastActiveAt: string }[],
): string {
	if (sessions.length === 0) {
		return "(no in-process AgentService sessions yet)";
	}
	const columns: TableColumn<AgentServiceSessionRow>[] = [
		{ header: " id", key: "id" },
		{ header: " origin", key: "origin" },
		{ header: " status", key: "status" },
		{ header: " title", key: "title" },
		{ header: " last active", key: "time" },
	];
	const rows: AgentServiceSessionRow[] = sessions.map((s) => ({
		id: s.id.length > 16 ? `${s.id.slice(0, 13)}…` : s.id,
		origin: s.origin,
		status: s.status,
		title: s.title.length > 32 ? `${s.title.slice(0, 29)}…` : s.title,
		time: formatAgentServiceTime(s.lastActiveAt),
	}));
	return renderTable(columns, rows);
}

function formatCapabilitiesMcpStatus(
	status: CapabilitiesReloadStatus["mcpReconnect"],
): string {
	if (status == null) {
		return "none";
	}
	const active = formatReplList(status.activeServerIds);
	if (status.status !== "pending_repl_apply") {
		return `${status.status}(active=${active})`;
	}
	return [
		`${status.status}(active=${active}`,
		`added=${formatReplList(status.change.added)}`,
		`removed=${formatReplList(status.change.removed)}`,
		`changed=${formatReplList(status.change.changed)})`,
	].join(" ");
}

function formatCapabilitiesSkillsStatus(
	status: CapabilitiesReloadStatus,
): string {
	if (status.skillsStatus == null) {
		return "none";
	}
	const catalogSize = status.skillsStatus.lastSuccess?.catalogSize ?? "unknown";
	return `catalog=${catalogSize},watching=${status.skillsStatus.watching ? "on" : "off"}`;
}

function renderCapabilitiesStatus(status: CapabilitiesReloadStatus): string {
	const reload =
		status.lastSuccess == null
			? "none"
			: `${status.lastSuccess.operation}/${status.lastSuccess.trigger}`;
	const failure =
		status.lastFailure == null
			? "none"
			: `${status.lastFailure.errorName}:${status.lastFailure.errorMessage}`;
	return [
		`Capabilities: generation=${status.generation}`,
		`booted=${status.booted ? "yes" : "no"}`,
		`watching=${status.watching ? "on" : "off"}`,
		`in_flight=${status.inFlight ? "yes" : "no"}`,
		`last_reload=${reload}`,
		`last_failure=${failure}`,
		`mcp=${formatCapabilitiesMcpStatus(status.mcpReconnect)}`,
		`skills=${formatCapabilitiesSkillsStatus(status)}`,
	].join(" | ");
}

interface CapabilityTableRow {
	readonly field: string;
	readonly value: string;
}

function renderCapabilitiesTable(status: CapabilitiesReloadStatus): string {
	const reload =
		status.lastSuccess == null
			? "none"
			: `${status.lastSuccess.operation}/${status.lastSuccess.trigger}`;
	const failure =
		status.lastFailure == null
			? "none"
			: `${status.lastFailure.errorName}:${status.lastFailure.errorMessage}`;

	const columns: TableColumn<CapabilityTableRow>[] = [
		{ header: "Field", key: "field" },
		{ header: "Value", key: "value" },
	];

	const rows: CapabilityTableRow[] = [
		{ field: "Generation", value: String(status.generation) },
		{ field: "Booted", value: status.booted ? "yes" : "no" },
		{ field: "Watching", value: status.watching ? "on" : "off" },
		{ field: "In Flight", value: status.inFlight ? "yes" : "no" },
		{ field: "Last Reload", value: reload },
		{ field: "Last Failure", value: failure },
		{
			field: "MCP Reconnect",
			value: formatCapabilitiesMcpStatus(status.mcpReconnect),
		},
		{ field: "Skills", value: formatCapabilitiesSkillsStatus(status) },
	];

	return renderTable(columns, rows);
}

interface McpServerDisplayEntry {
	readonly id: string;
	readonly namespace: string;
	readonly toolCount: number;
	readonly connectionState: "connected" | "disconnected" | "error";
	readonly reloadState: string;
	readonly error: string | null;
}

function buildMcpServerDisplayEntries(
	serverToolCounts: ReadonlyMap<string, number>,
	status: CapabilitiesReloadStatus | undefined,
): readonly McpServerDisplayEntry[] {
	const management = status?.management?.mcp;
	const mcpReconnect = status?.mcpReconnect;
	const activeIds = new Set(mcpReconnect?.activeServerIds ?? []);
	const addedIds = new Set(management?.added ?? []);
	const removedIds = new Set(management?.removed ?? []);
	const changedIds = new Set(management?.changed ?? []);
	const applyState = management?.applyState ?? "not_requested";
	const error = management?.error ?? null;

	const allIds = new Set([
		...serverToolCounts.keys(),
		...activeIds,
		...removedIds,
	]);

	const entries: McpServerDisplayEntry[] = [];
	for (const serverId of allIds) {
		const toolCount = serverToolCounts.get(serverId) ?? 0;
		const connectionState: McpServerDisplayEntry["connectionState"] =
			toolCount > 0
				? "connected"
				: removedIds.has(serverId)
					? "disconnected"
					: "error";

		const reloadTags: string[] = [];
		if (addedIds.has(serverId)) reloadTags.push("added");
		if (removedIds.has(serverId)) reloadTags.push("removed");
		if (changedIds.has(serverId)) reloadTags.push("changed");
		const reloadState =
			reloadTags.length > 0
				? `${applyState}(${reloadTags.join(",")})`
				: applyState;

		entries.push({
			id: serverId,
			namespace: serverId,
			toolCount,
			connectionState,
			reloadState,
			error: error != null ? `${error.errorName}:${error.errorMessage}` : null,
		});
	}

	return entries;
}

function formatMcpServerDisplayEntry(entry: McpServerDisplayEntry): string {
	const fields = [
		entry.id.padEnd(18),
		`ns=${entry.namespace}`,
		`tools=${entry.toolCount}`,
		entry.connectionState,
		`reload=${entry.reloadState}`,
		entry.error == null ? undefined : `error=${entry.error}`,
	];
	return fields.filter((f): f is string => f != null).join(" ");
}

function renderMcpDetailStatus(
	entries: readonly McpServerDisplayEntry[],
): string {
	if (entries.length === 0) {
		return "MCP Servers: none";
	}
	const lines = entries.map(formatMcpServerDisplayEntry);
	return `MCP Servers (${entries.length}):\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

function renderMcpServerList(
	entries: readonly McpServerDisplayEntry[],
): string {
	if (entries.length === 0) {
		return "No MCP servers registered.";
	}
	const lines = entries.map(formatMcpServerDisplayEntry);
	return [
		`MCP Servers (${entries.length}):`,
		...lines.map((line) => `  ${line}`),
	].join("\n");
}

interface McpServerTableRow {
	readonly id: string;
	readonly tools: string;
	readonly connection: string;
	readonly reload: string;
	readonly error: string;
}

function renderMcpServerTable(
	entries: readonly McpServerDisplayEntry[],
): string {
	if (entries.length === 0) {
		return "No MCP servers registered.";
	}

	const columns: TableColumn<McpServerTableRow>[] = [
		{ header: "ID", key: "id" },
		{ header: "Tools", key: "tools", align: "right" },
		{ header: "Connection", key: "connection" },
		{ header: "Reload", key: "reload" },
		{ header: "Error", key: "error" },
	];

	const rows: McpServerTableRow[] = entries.map((entry) => ({
		id: entry.id,
		tools: String(entry.toolCount),
		connection: entry.connectionState,
		reload: entry.reloadState,
		error: entry.error ?? "-",
	}));

	return renderTable(columns, rows);
}

// ---------------------------------------------------------------------------
// Self-evolution proposal review TUI helpers
// 自进化提案审核 TUI 辅助函数
// ---------------------------------------------------------------------------

const DEFAULT_PROPOSAL_LIST_LIMIT = 20;
const PROPOSAL_ID_SHORT_LENGTH = 12;

interface ProposalListRow {
	readonly proposalId: string;
	readonly createdAt: string;
	readonly type: string;
	readonly summary: string;
	readonly affectedPaths: string;
}

interface ProposalApplyRow {
	readonly proposalId: string;
	readonly outcome: string;
	readonly reasonCode: string;
	readonly reason: string;
}

function shortenProposalId(proposalId: string): string {
	if (proposalId.length <= PROPOSAL_ID_SHORT_LENGTH) {
		return proposalId;
	}
	return `${proposalId.slice(0, PROPOSAL_ID_SHORT_LENGTH)}…`;
}

function summarizeProposalAffectedPaths(record: StoredProposalRecord): string {
	const patch = record.generatedPatchProposal;
	if (patch === undefined) {
		return "artifact-only";
	}
	const changes = patch.fileChanges ?? [];
	if (changes.length === 0) {
		return "patch:0-files";
	}
	const visible = changes
		.slice(0, 3)
		.map((change) => `${change.changeKind}:${change.path}`);
	const more =
		changes.length > visible.length
			? ` +${changes.length - visible.length}`
			: "";
	return `${visible.join(",")}${more}`;
}

function classifyProposalType(record: StoredProposalRecord): string {
	if (record.generatedPatchProposal !== undefined) {
		return "patch";
	}
	if (record.artifacts.length > 0) {
		return "artifact";
	}
	return "draft";
}

function truncateProposalSummary(value: string, maxLength = 60): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatProposalListRow(record: StoredProposalRecord): ProposalListRow {
	return {
		proposalId: shortenProposalId(record.proposalId),
		createdAt: record.createdAt,
		type: classifyProposalType(record),
		summary: truncateProposalSummary(record.summary),
		affectedPaths: summarizeProposalAffectedPaths(record),
	};
}

function renderProposalListTable(
	records: readonly StoredProposalRecord[],
): string {
	const columns: readonly TableColumn<ProposalListRow>[] = [
		{ header: "proposalId", key: "proposalId" },
		{ header: "createdAt", key: "createdAt" },
		{ header: "type", key: "type" },
		{ header: "summary", key: "summary" },
		{ header: "paths", key: "affectedPaths" },
	];
	return renderTable(columns, records.map(formatProposalListRow));
}

function describeApplyOutcome(
	outcome: ProposalApplyOutcome,
	status: "skipped" | "failed",
): ProposalApplyRow {
	return {
		proposalId: shortenProposalId(outcome.proposalId),
		outcome: status,
		reasonCode: outcome.reasonCode,
		reason: truncateProposalSummary(outcome.reason),
	};
}

function renderProposalApplyTable(result: ProposalApplyResult): string {
	const rows: ProposalApplyRow[] = [
		...result.applied.map(
			(record): ProposalApplyRow => ({
				proposalId: shortenProposalId(record.proposalId),
				outcome: "applied",
				reasonCode: "ok",
				reason: "patch applied via WriteAuthority gate",
			}),
		),
		...result.skipped.map((entry) => describeApplyOutcome(entry, "skipped")),
		...result.failed.map((entry) => describeApplyOutcome(entry, "failed")),
	];
	const columns: readonly TableColumn<ProposalApplyRow>[] = [
		{ header: "proposalId", key: "proposalId" },
		{ header: "outcome", key: "outcome" },
		{ header: "reasonCode", key: "reasonCode" },
		{ header: "reason", key: "reason" },
	];
	return renderTable(columns, rows);
}

interface ProposalCommandArgs {
	readonly positional: readonly string[];
	readonly flags: ReadonlyMap<string, string | true>;
}

interface ParseProposalCommandOptions {
	// Flags listed here greedily consume every following non-`--` token
	// until the next flag or end of input, joining them with single spaces.
	// 这类 flag 会贪婪消耗后续非 `--` token 直到下一个 flag 或输入结束，并以单空格 join。
	// Used for freeform reason / message fields where requiring quotes hurts UX.
	// 用于 reason / message 这类自由文本字段，避免强制用户加引号。
	readonly greedyFlags?: ReadonlySet<string>;
}

function parseProposalCommandArgs(
	rawArgs: readonly string[],
	options: ParseProposalCommandOptions = {},
): ProposalCommandArgs {
	const greedyFlags = options.greedyFlags ?? new Set<string>();
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	let i = 0;
	while (i < rawArgs.length) {
		const token = rawArgs[i] ?? "";
		if (token.startsWith("--")) {
			const flagName = token.slice(2);
			if (greedyFlags.has(flagName)) {
				const collected: string[] = [];
				let j = i + 1;
				while (j < rawArgs.length) {
					const candidate = rawArgs[j] ?? "";
					if (candidate.startsWith("--")) {
						break;
					}
					collected.push(candidate);
					j += 1;
				}
				if (collected.length === 0) {
					flags.set(flagName, true);
				} else {
					flags.set(flagName, collected.join(" "));
				}
				i = j;
				continue;
			}
			const next = rawArgs[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(flagName, next);
				i += 2;
				continue;
			}
			flags.set(flagName, true);
			i += 1;
			continue;
		}
		positional.push(token);
		i += 1;
	}
	return { positional, flags };
}

// Maximum length for a proposal review reason. Anything longer is
// truncated before persistence to keep audit log lines bounded.
// 提案审核 reason 字段最大长度，超过则截断以保证审计日志行长度可控。
const MAX_PROPOSAL_REASON_LENGTH = 4096;

// Sanitize a free-form review reason before persistence:
// - strip ASCII control characters (incl. NUL, BEL, BS, LF, CR, ESC, DEL)
// - clamp length to MAX_PROPOSAL_REASON_LENGTH
// JSON.stringify in the store already escapes characters for jsonl integrity,
// but stripping control chars here keeps audit logs human-readable and
// prevents terminal-injection style payloads from leaking through.
// 对自由文本 reason 进行清洗：剔除 ASCII 控制字符并限制长度。
// 存储层会用 JSON.stringify 包裹整条记录，因此 jsonl 完整性不会因换行破裂；
// 这里再清洗一次主要是防止控制字符污染审计日志和终端。
// Exported for unit tests so we can verify C0/DEL stripping and length cap
// without booting the full REPL. Production callers stay inside repl.ts.
// 导出给单元测试，方便直接验证 C0/DEL 清洗和长度上限，无需启动完整 REPL。
// 生产路径仍只在 repl.ts 内调用。
export function sanitizeProposalReason(raw: string): string {
	let cleaned = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		// Strip C0 controls (0x00-0x1F) and DEL (0x7F); collapse to space.
		// 剔除 C0 控制字符（0x00-0x1F）与 DEL（0x7F），统一替换为空格。
		if ((code >= 0 && code <= 0x1f) || code === 0x7f) {
			cleaned += " ";
		} else {
			cleaned += ch;
		}
	}
	const collapsed = cleaned.replace(/\s+/gu, " ").trim();
	if (collapsed.length <= MAX_PROPOSAL_REASON_LENGTH) {
		return collapsed;
	}
	return collapsed.slice(0, MAX_PROPOSAL_REASON_LENGTH);
}

// Hash the sanitized review reason before emitting telemetry so that the
// agent-run JSONL log keeps a stable correlator without leaking free-form
// reviewer text. Empty input → undefined so the payload omits the field
// entirely instead of recording a hash of "".
// 在发出遥测前对清洗后的 reason 做哈希，让 agent-run JSONL 日志保留稳定相关性
// 标识，但不泄露评审人的自由文本。空输入返回 undefined，让 payload 直接省略字段，
// 避免落入"空串哈希"。
function hashReviewReason(reason: string): string | undefined {
	if (reason.length === 0) {
		return undefined;
	}
	return createHash("sha256").update(reason).digest("hex").slice(0, 12);
}

function tokenizeSlashCommand(input: string): readonly string[] {
	const tokens: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
	let match: RegExpExecArray | null = pattern.exec(input);
	while (match !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
		match = pattern.exec(input);
	}
	return tokens;
}

function parsePositiveLimitFlag(
	flags: ReadonlyMap<string, string | true>,
	fallback: number,
): { ok: true; value: number } | { ok: false; reason: string } {
	const raw = flags.get("limit");
	if (raw === undefined) {
		return { ok: true, value: fallback };
	}
	if (raw === true) {
		return { ok: false, reason: "--limit requires a positive integer" };
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
		return { ok: false, reason: `Invalid --limit value: ${raw}` };
	}
	return { ok: true, value: parsed };
}

function renderTokenBudget(
	messages: readonly Message[],
	budget: TokenBudget = DEFAULT_CONTEXT_BUDGET,
): string {
	let systemTokens = 0;
	let conversationTokens = 0;
	let toolTokens = 0;
	let memoryTokens = 0;

	for (const msg of messages) {
		const tokens = estimateTokens(msg.content);
		switch (msg.role) {
			case "system":
				systemTokens += tokens;
				break;
			case "user":
			case "assistant":
				conversationTokens += tokens;
				break;
			case "tool":
				if (msg.name?.includes("memory") === true) {
					memoryTokens += tokens;
				} else {
					toolTokens += tokens;
				}
				break;
		}
	}

	const totalUsed =
		systemTokens + conversationTokens + toolTokens + memoryTokens;

	function pct(used: number, cap: number): string {
		if (cap <= 0) return "unbounded";
		return `${Math.round((used / cap) * 100)}%`;
	}

	return [
		`Token Budget: used=${totalUsed}/${budget.total}`,
		`system=${systemTokens}/${budget.system}(${pct(systemTokens, budget.system)})`,
		`messages=${conversationTokens}/${budget.conversation}(${pct(conversationTokens, budget.conversation)})`,
		`tools=${toolTokens}/${budget.tools}(${pct(toolTokens, budget.tools)})`,
		`memories=${memoryTokens}/${budget.memory}(${pct(memoryTokens, budget.memory)})`,
	].join(" | ");
}

function countRecords(
	records: readonly ChildRunStatusRecord[],
	predicate: (record: ChildRunStatusRecord) => boolean,
): number {
	return records.filter(predicate).length;
}

function isNeedsDecisionRecord(record: ChildRunStatusRecord): boolean {
	return record.status === "blocked" && record.currentStep === "needs_decision";
}

function formatAgentsSummary(snapshot: SupervisorRuntimeSnapshot): string {
	const { records } = snapshot;
	if (records.length === 0) {
		return "Agents: none";
	}

	const counts = snapshot.projection.snapshot.counts;
	const needsDecision = countRecords(records, isNeedsDecisionRecord);
	const blocked = Math.max(0, counts.blocked - needsDecision);
	const active =
		counts.active +
		counts.waiting_for_review +
		counts.aggregating +
		counts.cancel_requested;
	const queued = counts.queued + counts.assigned;

	return [
		`Agents: active=${active}`,
		`blocked=${blocked}`,
		`needs_decision=${needsDecision}`,
		`completed=${counts.completed}`,
		`failed=${counts.failed}`,
		`queued=${queued}`,
	].join(" | ");
}

interface AgentCountTableRow {
	readonly active: string;
	readonly blocked: string;
	readonly needsDecision: string;
	readonly completed: string;
	readonly failed: string;
	readonly queued: string;
}

function renderAgentsSummaryTable(snapshot: SupervisorRuntimeSnapshot): string {
	const { records } = snapshot;
	if (records.length === 0) {
		return "";
	}

	const counts = snapshot.projection.snapshot.counts;
	const needsDecision = countRecords(records, isNeedsDecisionRecord);
	const blocked = Math.max(0, counts.blocked - needsDecision);
	const active =
		counts.active +
		counts.waiting_for_review +
		counts.aggregating +
		counts.cancel_requested;
	const queued = counts.queued + counts.assigned;

	const columns: TableColumn<AgentCountTableRow>[] = [
		{ header: "Active", key: "active", align: "right" },
		{ header: "Blocked", key: "blocked", align: "right" },
		{ header: "Needs Decision", key: "needsDecision", align: "right" },
		{ header: "Completed", key: "completed", align: "right" },
		{ header: "Failed", key: "failed", align: "right" },
		{ header: "Queued", key: "queued", align: "right" },
	];

	const rows: AgentCountTableRow[] = [
		{
			active: String(active),
			blocked: String(blocked),
			needsDecision: String(needsDecision),
			completed: String(counts.completed),
			failed: String(counts.failed),
			queued: String(queued),
		},
	];

	return renderTable(columns, rows);
}

function displayRunStatus(record: ChildRunStatusRecord): string {
	return isNeedsDecisionRecord(record) ? "needs_decision" : record.status;
}

function childRunSortRank(record: ChildRunStatusRecord): number {
	const status = displayRunStatus(record);
	switch (status) {
		case "needs_decision":
			return 0;
		case "blocked":
			return 1;
		case "active":
		case "waiting_for_review":
		case "aggregating":
		case "cancel_requested":
			return 2;
		case "queued":
		case "assigned":
			return 3;
		case "failed":
		case "cancelled":
			return 4;
		case "deferred":
			return 5;
		case "completed":
			return 6;
		default:
			return 7;
	}
}

function quoteAgentField(value: string | undefined): string | undefined {
	const trimmed = value?.replace(/\s+/gu, " ").trim();
	if (trimmed == null || trimmed.length === 0) {
		return undefined;
	}
	const shortened =
		trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
	return `"${shortened.replaceAll('"', "'")}"`;
}

function formatAgentProgress(record: ChildRunStatusRecord): string | undefined {
	if (record.progress == null) {
		return undefined;
	}
	const label = quoteAgentField(record.progress.label);
	return [
		`progress=${record.progress.completedSteps}/${record.progress.totalSteps}`,
		label == null ? undefined : `label=${label}`,
	]
		.filter((field): field is string => field != null)
		.join(" ");
}

function progressSnapshot(snapshot: SupervisorRuntimeSnapshot) {
	return snapshot.projection.snapshot;
}

function progressEvents(
	snapshot: SupervisorRuntimeSnapshot,
): readonly SupervisorProgressEvent[] {
	return snapshot.projection.events ?? [];
}

function eventOccurredAt(event: SupervisorProgressEvent): string {
	const extended = event as SupervisorProgressEvent & {
		readonly timestamp?: unknown;
		readonly updatedAt?: unknown;
	};
	const occurredAt = extended.occurredAt;
	if (typeof occurredAt === "string") {
		return occurredAt;
	}
	if (typeof extended.timestamp === "string") {
		return extended.timestamp;
	}
	if (typeof extended.updatedAt === "string") {
		return extended.updatedAt;
	}
	return "";
}

function countEvents(
	events: readonly SupervisorProgressEvent[],
	predicate: (event: SupervisorProgressEvent) => boolean,
): number {
	return events.filter(predicate).length;
}

function isRecoveryEvent(event: SupervisorProgressEvent): boolean {
	return (
		event.type.includes("recover") ||
		event.type.includes("recovery") ||
		event.type.includes("resume")
	);
}

function recentKeyEvents(
	snapshot: SupervisorRuntimeSnapshot,
): readonly SupervisorProgressEvent[] {
	const events = progressEvents(snapshot);
	const keyEvents = events.filter(
		(event) => event.type !== "progress_snapshot",
	);
	return (keyEvents.length === 0 ? events : keyEvents)
		.slice()
		.sort((left, right) =>
			eventOccurredAt(right).localeCompare(eventOccurredAt(left)),
		)
		.slice(0, RECENT_AGENT_EVENT_LIMIT);
}

function formatBoundedPercent(value: number | null | undefined): string {
	return value == null ? "unbounded" : `${value}%`;
}

function formatAgentProgressSummary(
	snapshot: SupervisorRuntimeSnapshot,
): string {
	const projection = progressSnapshot(snapshot);
	const events = progressEvents(snapshot);
	const heartbeatCount = countEvents(
		events,
		(event) => event.type === "child_heartbeat",
	);
	const dueCheckpointCount = countEvents(
		events,
		(event) => event.type === "child_checkpoint" && event.payload.isDue,
	);
	const staleCount = projection.staleRunIds?.length ?? 0;
	const recoveryCount = countEvents(events, isRecoveryEvent);

	return [
		`Progress: band=${projection.band ?? "unknown"}`,
		`percent=${formatBoundedPercent(projection.boundedPercent)}`,
		`heartbeat=${heartbeatCount}`,
		`stale=${staleCount}`,
		`recovery=${recoveryCount}`,
		`oldest_heartbeat_ms=${projection.oldestHeartbeatAgeMs ?? "none"}`,
		`checkpoint_due=${dueCheckpointCount}`,
		`next_checkpoint=${projection.nextCheckpointAt ?? "none"}`,
	].join(" | ");
}

function formatProgressEvent(event: SupervisorProgressEvent): string {
	switch (event.type) {
		case "child_stale":
			return [
				`${event.severity} child_stale`,
				`run=${event.runId}`,
				`task=${event.taskId}`,
				`status=${event.payload.status}`,
				`age_ms=${event.payload.heartbeatAgeMs}`,
				`threshold_ms=${event.payload.staleAfterMs}`,
				`summary=${quoteAgentField(event.payload.summary) ?? '""'}`,
				`at=${event.occurredAt}`,
			].join(" ");
		case "child_heartbeat": {
			const progress =
				event.payload.progress == null
					? undefined
					: `progress=${event.payload.progress.completedSteps}/${event.payload.progress.totalSteps}`;
			return [
				`${event.severity} child_heartbeat`,
				`run=${event.runId}`,
				`task=${event.taskId}`,
				`status=${event.payload.status}`,
				progress,
				event.payload.currentStep == null
					? undefined
					: `step=${event.payload.currentStep}`,
				`age_ms=${event.payload.heartbeatAgeMs}`,
				`summary=${quoteAgentField(event.payload.summary) ?? '""'}`,
				`at=${event.occurredAt}`,
			]
				.filter((field): field is string => field != null)
				.join(" ");
		}
		case "child_checkpoint":
			return [
				`${event.severity} child_checkpoint`,
				`run=${event.runId}`,
				`task=${event.taskId}`,
				`status=${event.payload.status}`,
				`due=${event.payload.isDue ? "yes" : "no"}`,
				`due_ms=${event.payload.dueInMs}`,
				`at=${event.occurredAt}`,
			].join(" ");
		case "terminal_children_summary":
			return [
				`${event.severity} terminal_children_summary`,
				`total=${event.payload.total}`,
				`completed=${event.payload.counts.completed}`,
				`failed=${event.payload.counts.failed}`,
				`cancelled=${event.payload.counts.cancelled}`,
				`deferred=${event.payload.counts.deferred}`,
				`at=${event.occurredAt}`,
			].join(" ");
		case "progress_snapshot":
			return [
				`${event.severity} progress_snapshot`,
				`band=${event.payload.band}`,
				`runs=${event.payload.totalRuns}`,
				`stale=${event.payload.staleRunIds.length}`,
				`percent=${formatBoundedPercent(event.payload.boundedPercent)}`,
				`at=${event.occurredAt}`,
			].join(" ");
		default: {
			const extended = event as {
				readonly type?: unknown;
				readonly severity?: unknown;
				readonly runId?: unknown;
				readonly taskId?: unknown;
				readonly payload?: unknown;
				readonly occurredAt?: unknown;
			};
			const payload = isRecord(extended.payload) ? extended.payload : {};
			const summary = stringField(payload, ["summary", "message", "detail"]);
			return [
				`${typeof extended.severity === "string" ? extended.severity : "info"} ${typeof extended.type === "string" ? extended.type : "unknown_event"}`,
				typeof extended.runId === "string"
					? `run=${extended.runId}`
					: undefined,
				typeof extended.taskId === "string"
					? `task=${extended.taskId}`
					: undefined,
				summary == null ? undefined : `summary=${quoteAgentField(summary)}`,
				`at=${eventOccurredAt(event) || "unknown"}`,
			]
				.filter((field): field is string => field != null)
				.join(" ");
		}
	}
}

function renderRecentAgentEvents(snapshot: SupervisorRuntimeSnapshot): string {
	const events = recentKeyEvents(snapshot);
	if (events.length === 0) {
		return "Recent events:\n  none";
	}

	return [
		"Recent events:",
		...events.map((event) => `  ${formatProgressEvent(event)}`),
	].join("\n");
}

function numberField(
	record: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

function stringField(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

function arrayField(
	record: Record<string, unknown>,
	keys: readonly string[],
): readonly unknown[] | undefined {
	for (const key of keys) {
		const value = record[key];
		if (Array.isArray(value)) {
			return value;
		}
	}
	return undefined;
}

function countLikeField(
	record: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	const direct = numberField(record, keys);
	if (direct != null) {
		return direct;
	}
	const arrayValue = arrayField(record, keys);
	return arrayValue == null ? undefined : arrayValue.length;
}

function isPromiseLike(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value != null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}

function readNotificationStatus(
	runtime: SupervisorRuntimeControlPlane,
): NotificationStatusProbe | undefined {
	const candidates = [
		"getNotificationStatus",
		"notificationStatus",
		"notifications",
	] as const;
	const runtimeRecord = runtime as unknown as Record<string, unknown>;

	for (const source of candidates) {
		const candidate = runtimeRecord[source];
		if (typeof candidate === "function") {
			try {
				const value = candidate.call(runtime);
				return {
					source,
					value: isPromiseLike(value) ? { status: "async_unavailable" } : value,
				};
			} catch (err) {
				return {
					source,
					value: {
						status: "unavailable",
						error: normalizeProviderError(err).name,
					},
				};
			}
		}
		if (candidate != null) {
			return {
				source,
				value: candidate,
			};
		}
	}

	return undefined;
}

function formatNotificationValue(probe: NotificationStatusProbe): string {
	const { source, value } = probe;
	if (typeof value === "string") {
		return `status=${value} | source=${source}`;
	}
	if (!isRecord(value)) {
		return `status=available | source=${source}`;
	}

	const status = stringField(value, ["status", "state", "mode"]) ?? "available";
	const enabled =
		typeof value.enabled === "boolean" ? value.enabled : undefined;
	const channels = arrayField(value, ["channels", "sinks"])
		?.map((entry) => String(entry))
		.filter((entry) => entry.length > 0)
		.join(",");
	const last =
		stringField(value, [
			"lastNotifiedAt",
			"lastDeliveredAt",
			"lastNotificationAt",
			"updatedAt",
		]) ?? "none";
	const error = stringField(value, ["error", "lastError"]);

	const fields = [
		`status=${status}`,
		enabled == null ? undefined : `enabled=${enabled ? "yes" : "no"}`,
		`source=${source}`,
		`pending=${countLikeField(value, ["pendingCount", "pending"]) ?? 0}`,
		`delivered=${numberField(value, ["deliveredCount", "sentCount"]) ?? 0}`,
		`failed=${numberField(value, ["failedCount", "errorCount"]) ?? 0}`,
		channels == null || channels.length === 0
			? undefined
			: `channels=${channels}`,
		`last=${last}`,
		`heartbeat=${countLikeField(value, ["heartbeatCount", "heartbeats"]) ?? 0}`,
		`stale=${countLikeField(value, ["staleCount", "stale"]) ?? 0}`,
		`recovery=${
			countLikeField(value, ["recoveryCount", "recoveredCount", "recovery"]) ??
			0
		}`,
		`recent=${countLikeField(value, ["recentCount", "recent", "recentEvents"]) ?? 0}`,
		error == null ? undefined : `error=${quoteAgentField(error) ?? '""'}`,
	];

	return fields.filter((field): field is string => field != null).join(" | ");
}

function formatAgentNotificationStatus(
	snapshot: SupervisorRuntimeSnapshot,
	runtime: SupervisorRuntimeControlPlane,
): string {
	const projection = progressSnapshot(snapshot);
	const events = progressEvents(snapshot);
	const heartbeatCount = countEvents(
		events,
		(event) => event.type === "child_heartbeat",
	);
	const staleCount = projection.staleRunIds?.length ?? 0;
	const recoveryCount = countEvents(events, isRecoveryEvent);
	const warningCount = countEvents(
		events,
		(event) => event.severity === "warning",
	);
	const errorCount = countEvents(events, (event) => event.severity === "error");
	const projectionStatus =
		events.length === 0
			? "empty"
			: warningCount + errorCount > 0
				? "needs_attention"
				: "healthy";
	const probe = readNotificationStatus(runtime);
	const derivedFields =
		probe == null
			? [
					`projection=${projectionStatus}`,
					`key_events=${recentKeyEvents(snapshot).length}`,
					`heartbeat=${heartbeatCount}`,
					`stale=${staleCount}`,
					`recovery=${recoveryCount}`,
				]
			: [
					`projection=${projectionStatus}`,
					`projection_key_events=${recentKeyEvents(snapshot).length}`,
					`projection_heartbeat=${heartbeatCount}`,
					`projection_stale=${staleCount}`,
					`projection_recovery=${recoveryCount}`,
				];
	const statusFields =
		probe == null
			? [`status=${projectionStatus}`, "source=progress_projection"]
			: [formatNotificationValue(probe)];

	return `Agent notifications: ${[...statusFields, ...derivedFields].join(" | ")}`;
}

interface AgentRecordRow {
	readonly status: string;
	readonly run: string;
	readonly task: string;
	readonly worker: string;
	readonly step: string;
	readonly progress: string;
	readonly blocker: string;
	readonly summary: string;
	readonly confidence: string;
	readonly artifacts: string;
}

function formatAgentRecordRow(record: ChildRunStatusRecord): AgentRecordRow {
	return {
		status: displayRunStatus(record),
		run: `run=${record.runId}`,
		task: `task=${record.taskId}`,
		worker: record.workerId == null ? "-" : `worker=${record.workerId}`,
		step: record.currentStep == null ? "-" : `step=${record.currentStep}`,
		progress: formatAgentProgress(record) ?? "-",
		blocker:
			record.blocker == null
				? "-"
				: `blocker=${quoteAgentField(record.blocker)}`,
		summary: `summary=${quoteAgentField(record.summary) ?? '""'}`,
		confidence: `confidence=${record.confidence}`,
		artifacts: `artifacts=${record.reviewedArtifactCount}`,
	};
}

function renderAgentRecordsTable(
	records: readonly ChildRunStatusRecord[],
): string {
	const sorted = [...records].sort((left, right) => {
		const rankDelta = childRunSortRank(left) - childRunSortRank(right);
		if (rankDelta !== 0) {
			return rankDelta;
		}
		return right.updatedAt.localeCompare(left.updatedAt);
	});

	const columns: TableColumn<AgentRecordRow>[] = [
		{ header: "Status", key: "status" },
		{ header: "Run", key: "run" },
		{ header: "Task", key: "task" },
		{ header: "Worker", key: "worker" },
		{ header: "Step", key: "step" },
		{ header: "Progress", key: "progress" },
		{ header: "Blocker", key: "blocker" },
		{ header: "Summary", key: "summary" },
		{ header: "Confidence", key: "confidence" },
		{ header: "Artifacts", key: "artifacts" },
	];

	const rows = sorted.map(formatAgentRecordRow);

	return renderTable(columns, rows);
}

function renderAgentsStatus(snapshot: SupervisorRuntimeSnapshot): string {
	if (snapshot.records.length === 0) {
		return [
			formatAgentsSummary(snapshot),
			formatAgentProgressSummary(snapshot),
			renderRecentAgentEvents(snapshot),
			"No local subagent runs yet.",
		].join("\n");
	}

	const records = [...snapshot.records].sort((left, right) => {
		const rankDelta = childRunSortRank(left) - childRunSortRank(right);
		if (rankDelta !== 0) {
			return rankDelta;
		}
		return right.updatedAt.localeCompare(left.updatedAt);
	});

	return [
		formatAgentsSummary(snapshot),
		renderAgentsSummaryTable(snapshot),
		formatAgentProgressSummary(snapshot),
		renderRecentAgentEvents(snapshot),
		"",
		renderAgentRecordsTable(records),
	].join("\n");
}

function mcpServerRuntimeSignature(entry: MCPServerEntry): string {
	return JSON.stringify({
		namespace: entry.namespace,
		defaultRiskLevel: entry.defaultRiskLevel,
		config: entry.config,
	});
}

const runtimeIdentity = new WeakMap<object, number>();
let nextRuntimeIdentity = 1;

function getRuntimeIdentity(value: object | undefined): number {
	if (value == null) {
		return 0;
	}
	const existing = runtimeIdentity.get(value);
	if (existing != null) {
		return existing;
	}
	const assigned = nextRuntimeIdentity;
	nextRuntimeIdentity += 1;
	runtimeIdentity.set(value, assigned);
	return assigned;
}

function buildRuntimeSurfaceKey(input: {
	readonly runtime?: CapabilitiesRuntime;
	readonly status?: CapabilitiesReloadStatus;
	readonly mcpServers: readonly MCPServerEntry[];
	readonly skillsManager?: SkillsManager;
	readonly tools: readonly Tool[];
}): string {
	const generation =
		input.status?.generation ?? getRuntimeIdentity(input.runtime);
	const mcpSignature = input.mcpServers
		.map((entry) => `${entry.id}:${mcpServerRuntimeSignature(entry)}`)
		.join("|");
	const toolSignature = input.tools
		.map((tool) => `${tool.name}:${tool.description}`)
		.join("|");
	return [
		`generation=${generation}`,
		`runtime=${getRuntimeIdentity(input.runtime)}`,
		`skills=${getRuntimeIdentity(input.skillsManager)}`,
		`mcp=${mcpSignature}`,
		`tools=${toolSignature}`,
	].join(";");
}

function createSandboxApprovalPrompt(request: SandboxApprovalRequest): string {
	const { summary } = request;
	return `[Sandbox] ${summary.tool}: ${summary.summary}\nReasons: ${formatReplList(summary.reasonCodes)} | Required: ${formatReplList(summary.requiredApprovals)}\nAllow once? [y/N]: `;
}

function filterToolsByRuntimeConfig<T extends { readonly name?: string }>(
	tools: readonly T[],
	filter: RuntimeToolFilter | undefined,
): T[] {
	if (filter == null) {
		return [...tools];
	}

	return tools.filter(
		(tool) => tool.name != null && isRuntimeToolEnabled(tool.name, filter),
	);
}

function providerErrorLogFields(error: unknown): Record<string, string> {
	const normalized = normalizeProviderError(error);

	return {
		name: normalized.name,
		...(normalized.code == null ? {} : { code: normalized.code }),
		...(normalized.category == null ? {} : { category: normalized.category }),
	};
}

async function flushObservabilitySpans(
	observability: AgentLoopObservability | undefined,
	exporter: SpanExporter | undefined,
): Promise<void> {
	const spans = observability?.spans;
	if (spans == null || exporter == null) {
		return;
	}

	const snapshots = spans.snapshot();
	if (snapshots.length === 0) {
		return;
	}

	try {
		if (exporter.exportSpans != null) {
			await exporter.exportSpans(snapshots);
		} else if (exporter.exportSpan != null) {
			await Promise.all(snapshots.map((span) => exporter.exportSpan?.(span)));
		} else {
			return;
		}
		spans.clear();
	} catch (err) {
		logger.error(
			{ error: providerErrorLogFields(err) },
			"REPL: span export failed",
		);
	}
}

async function flushAgentRunLogger(
	runLogger: AgentRunLogSink | undefined,
): Promise<void> {
	try {
		await runLogger?.flush?.();
	} catch (err) {
		logger.warn(
			{ error: providerErrorLogFields(err) },
			"REPL: agent run log flush failed",
		);
	}
}

type ReasoningDisplayMode = "collapsed" | "verbose";

interface ReplStreamRenderState {
	thinkingShown: boolean;
	toolInputs: Map<string, string>;
	// Tracks whether the most recent emission to stdout was a `text`
	// delta (the LLM's natural-language reply). Used by the turn-end
	// hook to ensure a trailing newline is emitted so that subsequent
	// logger output / readline prompt does not collide with the reply's
	// last character. Reply content is on stdout; operational icons /
	// banner stay on stderr.
	lastTextEndedWithNewline: boolean;
	hasEmittedText: boolean;
}

/**
 * Ensure the agent's reply stream ends on a newline. Called whenever an
 * assistant message completes during a turn (which happens once per
 * tool-call round in `loop.ts:392`, plus once for the final assistant
 * message in `loop.ts:306`). If the agent emitted any `text` deltas
 * since the last finalize AND the last byte was not a newline, we write
 * one. This prevents the next stream writer (logger on stderr,
 * tool-call icon on stderr, readline prompt on stdout) from
 * concatenating onto the reply's final character. See QUI-141
 * Reply text + trailing `\n` go to stdout (separate from operational stderr).
 *
 * Resets the flags after firing so the NEXT round's text deltas (or
 * lack thereof, in a tool-only round) decide independently whether
 * another newline is needed. Without the reset, `onAssistantMessage`
 * for a tool-only round would write a stray `\n` on stale state from
 * the previous round.
 */
function finalizeStreamRender(state: ReplStreamRenderState): void {
	if (state.hasEmittedText && !state.lastTextEndedWithNewline) {
		stdout.write("\n");
	}
	state.hasEmittedText = false;
	state.lastTextEndedWithNewline = false;
}

function createStreamRenderState(): ReplStreamRenderState {
	return {
		thinkingShown: false,
		toolInputs: new Map(),
		lastTextEndedWithNewline: false,
		hasEmittedText: false,
	};
}

function stringifyJson(value: unknown): string {
	const serialized = JSON.stringify(value);
	return serialized ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}

function summarizeInlineText(text: string, maxLength = 120): string {
	const singleLine = text.replace(/\s+/gu, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}

	return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeToolOutput(output: unknown): string {
	if (isRecord(output)) {
		const result = output.result;
		if (typeof result === "string") {
			return summarizeInlineText(result);
		}

		const content = output.content;
		if (typeof content === "string") {
			return summarizeInlineText(content.split(/\r?\n/u, 1)[0] ?? content);
		}
	}

	const raw =
		typeof output === "string" ? output : stringifyJson(output ?? "undefined");
	return summarizeInlineText(raw.split(/\r?\n/u, 1)[0] ?? raw);
}

function renderStreamEvent(
	event: LLMStreamEvent,
	reasoningDisplay: ReasoningDisplayMode,
	renderState: ReplStreamRenderState,
): void {
	switch (event.type) {
		case "text":
			// Reply content goes to stdout so a downstream pipe consumer
			// (e.g. `just dev 2>/tmp/log`) can capture the natural-language
			// reply separate from the operational stderr surface.
			// (channel split: reply on stdout, operational on stderr.)
			stdout.write(event.delta);
			// Only update the trailing-newline flag for non-empty deltas:
			// some providers emit a final empty `text` delta to flush state,
			// and `"".endsWith("\n")` is false — that would incorrectly flip
			// a previously-true flag and cause finalizeStreamRender to write
			// a stray `\n` even when the reply already ended on `\n`.
			if (event.delta.length > 0) {
				renderState.hasEmittedText = true;
				renderState.lastTextEndedWithNewline =
					event.delta.endsWith("\n");
			}
			break;
		case "reasoning":
			if (reasoningDisplay === "verbose") {
				stderr.write(event.delta);
				return;
			}

			if (!renderState.thinkingShown) {
				renderState.thinkingShown = true;
				stderr.write("💭 [thinking...]\n");
			}
			break;
		case "tool-call-start":
			renderState.toolInputs.set(event.toolCallId, "");
			break;
		case "tool-call-args-delta":
			renderState.toolInputs.set(
				event.toolCallId,
				`${renderState.toolInputs.get(event.toolCallId) ?? ""}${event.delta}`,
			);
			break;
		case "tool-call-end": {
			const inputText =
				event.inputText.length > 0
					? event.inputText
					: (renderState.toolInputs.get(event.toolCallId) ??
						(event.input == null ? "" : stringifyJson(event.input)));
			renderState.toolInputs.delete(event.toolCallId);
			stderr.write(
				`\n🔧 calling ${event.toolName}(${summarizeInlineText(inputText)})\n`,
			);
			break;
		}
		case "tool-result":
			stderr.write(
				`\n${event.isError === true ? "⚠️" : "✅"} ${event.toolName} → ${summarizeToolOutput(event.output)}\n`,
			);
			break;
	}
}

function getEffectiveModelId(
	providerId: LLMProviderId,
	baseModelId: string,
	thinkingMode: InferenceConfig["thinkingMode"],
): string {
	try {
		return decideLLMRoute({
			provider: providerId,
			model: baseModelId,
			thinkingMode,
		}).effectiveModel;
	} catch {
		return baseModelId;
	}
}

function renderSkillsCatalogHint(change: SkillsCatalogChange): string | null {
	if (
		change.added.length === 1 &&
		change.removed.length === 0 &&
		change.changed.length === 0
	) {
		return `📥 New skill discovered: ${change.added[0]}\n`;
	}

	if (
		change.removed.length === 1 &&
		change.added.length === 0 &&
		change.changed.length === 0
	) {
		return `🗑 Skill removed: ${change.removed[0]}\n`;
	}

	if (
		change.added.length === 0 &&
		change.removed.length === 0 &&
		change.changed.length === 0
	) {
		return null;
	}

	return "🎯 Skills catalog updated\n";
}

function parseSlashCommandQuery(line: string): string {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith("/")) {
		return "";
	}

	const commandAndArgs = trimmed.slice(1).trimStart();
	const [command] = commandAndArgs.split(/\s+/u, 1);
	return command?.toLowerCase() ?? "";
}

function matchesSlashCommandQuery(
	command: SlashCommandEntry,
	query: string,
): boolean {
	return query === "" || command.name.startsWith(query);
}

function renderSlashCommandHelp(line = ""): string {
	const query = parseSlashCommandQuery(line);
	const matchingCommands = SLASH_COMMANDS.filter((command) =>
		matchesSlashCommandQuery(command, query),
	);

	if (matchingCommands.length === 0) {
		return "  No matching slash commands.";
	}

	const columns: TableColumn<SlashCommandEntry>[] = [
		{ header: "Command", key: "signature" },
		{ header: "Description", key: "description" },
	];

	return [
		"Slash commands:",
		renderTable(columns, [...matchingCommands]),
		"Tip: type /help to show this list again.",
	].join("\n");
}

interface SlashCommandHelpRenderState {
	renderedLine: string | undefined;
	renderedCursorPos: ReadlineDisplayPosition | undefined;
	renderedHelpRows: number;
}

function resetSlashCommandHelpRenderState(
	state: SlashCommandHelpRenderState,
): void {
	state.renderedLine = undefined;
	state.renderedCursorPos = undefined;
	state.renderedHelpRows = 0;
}

interface ReadlineDisplayPosition {
	readonly cols: number;
	readonly rows: number;
}

function isSlashCommandLine(line: string): boolean {
	return line.trimStart().startsWith("/");
}

function renderPromptLine(line: string): string {
	return `${REPL_PROMPT}${line}`;
}

function getTerminalColumns(): number {
	// Slash-command help block + prompt are rendered on stdout (same
	// stream as readline). Use the stdout column count so wrap math
	// matches the actual rendering surface. Fall back to stderr.columns
	// then 80 to retain previous behaviour when stdout is not a TTY.
	return Math.max(1, stdout.columns ?? stderr.columns ?? 80);
}

function measureDisplayPosition(
	text: string,
	columns = getTerminalColumns(),
): ReadlineDisplayPosition {
	let rows = 0;
	let cols = 0;

	for (const char of text) {
		if (char === "\n") {
			rows += 1;
			cols = 0;
			continue;
		}

		cols += 1;
		if (cols >= columns) {
			rows += Math.floor(cols / columns);
			cols %= columns;
		}
	}

	return { cols, rows };
}

function measureDisplayRows(
	text: string,
	columns = getTerminalColumns(),
): number {
	let rows = 0;

	for (const line of text.split("\n")) {
		rows += Math.max(1, Math.ceil(line.length / columns));
	}

	return rows;
}

function moveToBlockTop(
	cursorPos: ReadlineDisplayPosition,
	helpRows: number,
): void {
	// Cursor manipulation must target the same stream as the prompt
	// rendering (stdout, after the reply/operational channel split). Otherwise the
	// cursor moves on stderr while the visible prompt is on stdout
	// and the help block / prompt rendering desyncs.
	moveCursor(stdout, -cursorPos.cols, -(cursorPos.rows + helpRows));
}

function restoreCursorPosition(
	from: ReadlineDisplayPosition,
	to: ReadlineDisplayPosition,
): void {
	moveCursor(stdout, to.cols - from.cols, to.rows - from.rows);
}

function clearPromptBlock(
	cursorPos: ReadlineDisplayPosition,
	helpRows: number,
): void {
	moveToBlockTop(cursorPos, helpRows);
	clearScreenDown(stdout);
}

interface SlashCommandInputSnapshot {
	readonly line: string;
	readonly cursorPos: ReadlineDisplayPosition;
}

interface KeypressEventInfo {
	readonly name?: string;
	readonly sequence?: string;
	readonly ctrl?: boolean;
	readonly meta?: boolean;
	readonly shift?: boolean;
}

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0) ?? 0;
	return codePoint < 32 || codePoint === 127;
}

function getPrintableKeypressText(input: string | undefined): string {
	if (input == null) {
		return "";
	}

	return Array.from(input)
		.filter((char) => !isControlCharacter(char))
		.join("");
}

class SlashCommandInputTracker {
	private readonly chars: string[] = [];
	private cursorIndex = 0;

	reset(): void {
		this.chars.length = 0;
		this.cursorIndex = 0;
	}

	snapshot(): SlashCommandInputSnapshot {
		const line = this.chars.join("");
		const lineBeforeCursor = this.chars.slice(0, this.cursorIndex).join("");

		return {
			line,
			cursorPos: measureDisplayPosition(renderPromptLine(lineBeforeCursor)),
		};
	}

	applyKeypress(
		input: string | undefined,
		key: KeypressEventInfo | undefined,
	): void {
		const keyName = key?.name;

		if (key?.ctrl === true || key?.meta === true) {
			this.applyControlKey(keyName, key);
			return;
		}

		switch (keyName) {
			case "return":
			case "enter":
				this.reset();
				return;
			case "backspace":
				if (this.cursorIndex > 0) {
					this.chars.splice(this.cursorIndex - 1, 1);
					this.cursorIndex -= 1;
				}
				return;
			case "delete":
				if (this.cursorIndex < this.chars.length) {
					this.chars.splice(this.cursorIndex, 1);
				}
				return;
			case "left":
				this.cursorIndex = Math.max(0, this.cursorIndex - 1);
				return;
			case "right":
				this.cursorIndex = Math.min(this.chars.length, this.cursorIndex + 1);
				return;
			case "home":
				this.cursorIndex = 0;
				return;
			case "end":
				this.cursorIndex = this.chars.length;
				return;
			case "tab":
				return;
			default:
				break;
		}

		const printableText = getPrintableKeypressText(input);
		if (printableText === "") {
			return;
		}

		const insertedChars = Array.from(printableText);
		this.chars.splice(this.cursorIndex, 0, ...insertedChars);
		this.cursorIndex += insertedChars.length;
	}

	private applyControlKey(
		keyName: string | undefined,
		key: KeypressEventInfo,
	): void {
		if (key.ctrl !== true || key.meta === true) {
			return;
		}

		switch (keyName) {
			case "a":
				this.cursorIndex = 0;
				return;
			case "e":
				this.cursorIndex = this.chars.length;
				return;
			case "u":
				this.chars.splice(0, this.cursorIndex);
				this.cursorIndex = 0;
				return;
			case "k":
				this.chars.splice(this.cursorIndex);
				return;
			default:
				return;
		}
	}
}

function renderSlashCommandHelpBlock(
	state: SlashCommandHelpRenderState,
	line: string,
	cursorPos: ReadlineDisplayPosition,
): void {
	if (
		state.renderedLine === line &&
		state.renderedCursorPos?.cols === cursorPos.cols &&
		state.renderedCursorPos?.rows === cursorPos.rows
	) {
		return;
	}

	const helpText = renderSlashCommandHelp(line);
	const helpRows = measureDisplayRows(helpText);
	const promptText = renderPromptLine(line);
	clearPromptBlock(
		cursorPos,
		state.renderedLine == null ? 0 : state.renderedHelpRows,
	);
	const fullBlockText = `${helpText}\n${promptText}`;
	const targetCursorPos = {
		cols: cursorPos.cols,
		rows: helpRows + cursorPos.rows,
	};
	// Prompt + slash-help block share the readline output stream
	// (stdout) so the cursor stays in sync with the visible prompt.
	// (the slash-help block must render on the same stream as readline.)
	stdout.write(fullBlockText);
	restoreCursorPosition(measureDisplayPosition(fullBlockText), targetCursorPos);
	state.renderedLine = line;
	state.renderedCursorPos = { ...cursorPos };
	state.renderedHelpRows = helpRows;
}

function updateSlashCommandHelpBlock(
	snapshot: SlashCommandInputSnapshot,
	state: SlashCommandHelpRenderState,
): boolean {
	const { line, cursorPos } = snapshot;
	if (!isSlashCommandLine(line)) {
		if (state.renderedLine != null) {
			const promptText = renderPromptLine(line);
			clearPromptBlock(cursorPos, state.renderedHelpRows);
			// Prompt re-render after backing out of slash mode goes to
			// stdout (matches readline's output stream after QUI-141
			// Symptom B).
			stdout.write(promptText);
			restoreCursorPosition(measureDisplayPosition(promptText), cursorPos);
			resetSlashCommandHelpRenderState(state);
		}
		return false;
	}

	renderSlashCommandHelpBlock(state, line, cursorPos);
	return true;
}

interface SlashCommandHelpController {
	resetInput(): void;
	dispose(): void;
}

function installSlashCommandHelp(options: {
	isActive: () => boolean;
	onShown: () => void;
}): SlashCommandHelpController {
	const noopController: SlashCommandHelpController = {
		resetInput: () => undefined,
		dispose: () => undefined,
	};

	// Slash-command help renders on stdout (matches readline's output
	// stream after the channel split). Cursor manipulation requires
	// stdout to be a TTY; otherwise skip the live-help overlay.
	if (stdin.isTTY !== true || stdout.isTTY !== true) {
		return noopController;
	}

	const inputTracker = new SlashCommandInputTracker();
	const renderState: SlashCommandHelpRenderState = {
		renderedLine: undefined,
		renderedCursorPos: undefined,
		renderedHelpRows: 0,
	};
	let disposed = false;
	let scheduled: NodeJS.Immediate | undefined;
	emitKeypressEvents(stdin);

	const scheduleRender = (): void => {
		if (scheduled != null) {
			return;
		}

		scheduled = setImmediate(() => {
			scheduled = undefined;
			if (disposed || !options.isActive()) {
				resetSlashCommandHelpRenderState(renderState);
				return;
			}

			if (updateSlashCommandHelpBlock(inputTracker.snapshot(), renderState)) {
				options.onShown();
			}
		});
	};

	const handleKeypress = (
		input: string | undefined,
		key: KeypressEventInfo | undefined,
	): void => {
		inputTracker.applyKeypress(input, key);
		scheduleRender();
	};

	stdin.on("keypress", handleKeypress);

	return {
		resetInput: () => {
			inputTracker.reset();
			resetSlashCommandHelpRenderState(renderState);
		},
		dispose: () => {
			disposed = true;
			if (scheduled != null) {
				clearImmediate(scheduled);
				scheduled = undefined;
			}
			stdin.off("keypress", handleKeypress);
		},
	};
}

export async function startRepl(options: ReplOptions): Promise<void> {
	// Candidate 1 Slice A: get/create the in-process AgentService
	// singleton up front. The `/sessions` command (and Slice B+ write
	// paths) all read through this binding.
	//
	// Candidate 1 Slice A:取/构造进程级 AgentService 单例,`/sessions` 命令 +
	// 后续 slice 写侧都通过它访问。
	const agentService = getOrCreateAgentService();
	const {
		provider,
		providerId = "deepseek",
		modelId,
		sessionId,
		tools = [],
		mcpServers = [],
		skillsManager,
		capabilitiesRuntime,
		inferenceConfig: initialInferenceConfig,
		tierRouting,
		writeAuthorityMode = "ask",
		toolFilter,
		capabilitiesStatus,
		supervisorRuntime: providedSupervisorRuntime,
		agentRunLogger,
		trajectoryStore,
		onIdle,
		proposalStore,
		proposalSandboxPolicyGate,
		onWriteAuthorityReady,
		onRuntimeReady,
		onProviderRunRecord,
		onMcpReconnectApplied,
		getUserConfig,
	} = options;
	// Forward the production logger so RelevanceSelector fallback warnings
	// (e.g. "vector strategy without retriever") surface on stdout.
	const context = new BasicContextManager({ log: logger });
	const resolveContextBudget = (): TokenBudget | undefined =>
		getUserConfig?.()?.context?.budget;
	const ownsStaticSkillsManager =
		capabilitiesRuntime == null && skillsManager != null;
	if (ownsStaticSkillsManager) {
		await skillsManager.discover();
		skillsManager.startWatching();
	}
	const registry = new MCPRegistry();
	const supervisorRuntime =
		providedSupervisorRuntime ??
		new InProcessSupervisorRuntime({ maxActiveRuns: 6 });
	if (onRuntimeReady != null) {
		try {
			onRuntimeReady({ registry, supervisorRuntime });
		} catch (error) {
			logger.warn(
				{ err: error },
				"startRepl: onRuntimeReady hook threw — continuing",
			);
		}
	}
	const resolvedSessionId = sessionId ?? crypto.randomUUID();
	// L3a observer bridge — resolved lazily because the underlying
	// MCP transport for `quilin-mem` is not connected until syncRuntimeSurface
	// runs the registry. The bridge is constructed at most once per session,
	// gated on `userConfig.memory.observer.enabled === true` AND the presence
	// of an observer API key in the environment (QUILIN_OBSERVER_API_KEY or
	// DEEPSEEK_API_KEY). When either gate is closed, no bridge is built and
	// runAgentLoop's observerBridge stays undefined (loop.ts handles
	// `observerBridge == null` as a no-op).
	//
	// L3a 观察桥懒加载：底层 quilin-mem MCP transport 要等 syncRuntimeSurface
	// 跑完 registry 才连上。每 session 最多构造一次，必须同时满足
	// `userConfig.memory.observer.enabled === true` 且环境变量含
	// QUILIN_OBSERVER_API_KEY 或 DEEPSEEK_API_KEY；否则不构造桥，
	// runAgentLoop 的 observerBridge 保持 undefined（loop.ts 已处理为 no-op）。
	const QUILIN_MEM_SERVER_ID = "quilin-mem";
	let cachedObserverBridge: ObserverBridge | undefined;
	let observerStartupLogged = false;
	const resolveObserverBridge = (): ObserverBridge | undefined => {
		if (cachedObserverBridge != null) {
			return cachedObserverBridge;
		}
		const userConfig = getUserConfig?.() ?? null;
		const enabled = userConfig?.memory?.observer?.enabled === true;
		const observerApiKey = process.env.QUILIN_OBSERVER_API_KEY;
		const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
		const hasApiKey =
			(observerApiKey != null && observerApiKey.length > 0) ||
			(deepseekApiKey != null && deepseekApiKey.length > 0);
		const transport = registry.getServerCallToolTransport(QUILIN_MEM_SERVER_ID);
		// Build using the pure helper so the gating logic is unit-testable
		// without spinning up a REPL.
		const bridge = createObserverBridgeIfEnabled({
			enabled,
			...(observerApiKey == null ? {} : { observerApiKey }),
			...(deepseekApiKey == null ? {} : { deepseekApiKey }),
			...(transport == null ? {} : { transport }),
		});
		if (bridge == null) {
			if (!observerStartupLogged && (!enabled || !hasApiKey)) {
				// Log once when permanently inactive (config-gated). Don't
				// log when transport is just not yet ready — that's a
				// transient state that resolves on the next turn.
				observerStartupLogged = true;
				logger.info(
					{
						observerEnabled: enabled,
						observerApiKeyPresent: hasApiKey,
					},
					"L3a observer bridge inactive (gated by config + env)",
				);
			}
			return undefined;
		}
		cachedObserverBridge = bridge;
		if (!observerStartupLogged) {
			observerStartupLogged = true;
			logger.info(
				{ sessionId: resolvedSessionId },
				"L3a observer bridge enabled (memory_observe wired)",
			);
		}
		return cachedObserverBridge;
	};
	const checkpoint = new SQLiteCheckpoint({ sessionId: resolvedSessionId });
	const runLogger =
		agentRunLogger ?? createDefaultAgentRunLogger(resolvedSessionId);
	let rl: readline.Interface | undefined;
	let slashCommandHelpController: SlashCommandHelpController | undefined;
	let slashCommandHelpShownForPrompt = false;
	let mainPromptActive = false;
	const queuedCommands: string[] = [];
	const liveInputQueue = new LiveInputQueue({
		createId: () => crypto.randomUUID(),
	});
	const toolProvenance: ToolProvenanceEntry[] = [];
	const mcpServerToolCounts = new Map<string, number>();
	let activeTurnId: string | undefined;
	const enqueueLiveInput = (entry: QueuedLiveInput): void => {
		queuedCommands.push(entry.input);
		if (entry.kind === "slash_command") {
			stderr.write(`Command queued for current turn: ${entry.input}\n`);
		} else {
			stderr.write(
				`Live input queued for current turn: ${entry.input.length} chars.\n`,
			);
		}
		void recordAgentRunEvent(
			runLogger,
			"turn.live_input_received",
			{
				id: entry.id,
				kind: entry.kind,
				receivedAt: entry.receivedAt,
				input: {
					chars: entry.input.length,
					previewRedacted: true,
				},
				queuedFor: "next_turn",
				queuedCommandCount: queuedCommands.length,
			},
			{ turnId: entry.turnId },
		);
	};
	const handleLiveInputLine = (line: string): void => {
		const entry = liveInputQueue.append(line);
		if (entry != null) {
			enqueueLiveInput(entry);
		}
	};
	const writeAuthority = new WriteAuthority({
		actor: resolvedSessionId,
		mode: writeAuthorityMode,
		confirm: async (request) => {
			if (rl == null) {
				return false;
			}

			while (true) {
				const resumeLiveInput = liveInputQueue.suspend();
				let answer: string;
				try {
					answer = (
						await rl.question(
							`[WriteAuthority] ${request.tool} (${request.riskLevel.toUpperCase()}): ${request.summary}\nAllow? [y/N/always-low/always-medium]: `,
						)
					).trim();
				} finally {
					resumeLiveInput();
				}

				if (answer.startsWith("/")) {
					queuedCommands.push(answer);
					stderr.write(`Command queued for next turn: ${answer}\n`);
					continue;
				}

				const normalizedAnswer = answer.toLowerCase();

				if (normalizedAnswer === "always-low") {
					writeAuthority.setMode("auto-low");
					return true;
				}

				if (normalizedAnswer === "always-medium") {
					writeAuthority.setMode("auto-medium");
					return true;
				}

				return normalizedAnswer === "y" || normalizedAnswer === "yes";
			}
		},
	});
	if (onWriteAuthorityReady != null) {
		try {
			onWriteAuthorityReady(writeAuthority);
		} catch (error) {
			logger.warn(
				{ err: error },
				"startRepl: onWriteAuthorityReady hook threw — continuing",
			);
		}
	}
	const confirmSandboxApproval = async (
		request: SandboxApprovalRequest,
	): Promise<boolean> => {
		if (rl == null) {
			return false;
		}

		while (true) {
			const resumeLiveInput = liveInputQueue.suspend();
			let answer: string;
			try {
				answer = (
					await rl.question(createSandboxApprovalPrompt(request))
				).trim();
			} finally {
				resumeLiveInput();
			}

			if (answer.startsWith("/")) {
				queuedCommands.push(answer);
				stderr.write(`Command queued for next turn: ${answer}\n`);
				continue;
			}

			const normalizedAnswer = answer.toLowerCase();
			return normalizedAnswer === "y" || normalizedAnswer === "yes";
		}
	};
	let promptSession: ReplPromptSession | undefined;
	let unsubscribeCatalogHints: (() => void) | undefined;

	try {
		const restoredState =
			sessionId == null ? null : await checkpoint.load(resolvedSessionId);
		const restoredMessages =
			restoredState?.messages[0]?.role === "system"
				? restoredState.messages.slice(1)
				: (restoredState?.messages ?? []);

		stderr.write("\n🐉 Quilin Agent v0.0.3 (DeepSeek)\n");
		stderr.write(
			`Session: ${resolvedSessionId} (${restoredState == null ? "new" : "restored"})\n`,
		);
		if (restoredState != null) {
			stderr.write(
				`Messages: ${restoredMessages.length} | Last active: ${restoredState.lastActiveAt}\n`,
			);
		}
		stderr.write(
			"Type your message, or / to list commands. /exit to quit.\n\n",
		);
		await recordAgentRunEvent(runLogger, "repl.session_started", {
			sessionId: resolvedSessionId,
			restored: restoredState != null,
			messageCount: restoredMessages.length,
			modelId,
			providerId,
			hasTierRouting: tierRouting != null,
		});

		// readline's prompt rendering and user-input echo go to stdout so
		// the user keeps seeing the prompt even when stderr is redirected
		// (e.g. `just dev 2>/tmp/log`). Operational surface (banner, tool
		// icons, errors) remains on stderr.
		rl = readline.createInterface({ input: stdin, output: stdout });
		rl.on?.("line", handleLiveInputLine);
		slashCommandHelpController = installSlashCommandHelp({
			isActive: () => mainPromptActive,
			onShown: () => {
				slashCommandHelpShownForPrompt = true;
			},
		});

		let state: AgentState;
		if (restoredState == null) {
			state = createState([]);
		} else {
			state = createState(restoredMessages, {
				...restoredState,
				messages: restoredMessages,
			});
		}

		const messages: Message[] = [...state.messages];
		interface RuntimeSurface {
			readonly key: string;
			readonly sessionAssembler: PromptSessionAssembler;
			readonly tools: readonly ToolWithMetadata[];
		}
		let runtimeSurface: RuntimeSurface | undefined;
		let catalogHintSkillsManager: SkillsManager | undefined;
		const registeredMcpServerSignatures = new Map<string, string>();
		// Forward declarations: subagent_spawn's getLoopConfig closure needs to
		// read these lazily at execution time, so they live in scope before
		// syncRuntimeSurface (which constructs the spawn tool).
		let inferenceConfig: InferenceConfig = {
			...DEFAULT_INFERENCE_CONFIG,
			...initialInferenceConfig,
		};
		let llm: ProviderControlPlaneLLMClient | undefined;

		const updateCatalogHintSubscription = (
			currentSkillsManager: SkillsManager | undefined,
		): void => {
			if (catalogHintSkillsManager === currentSkillsManager) {
				return;
			}
			unsubscribeCatalogHints?.();
			unsubscribeCatalogHints = undefined;
			catalogHintSkillsManager = currentSkillsManager;
			if (currentSkillsManager == null) {
				return;
			}
			unsubscribeCatalogHints = currentSkillsManager.onCatalogChange(
				(change) => {
					const hint = renderSkillsCatalogHint(change);
					if (hint != null) {
						stderr.write(hint);
					}
				},
			);
		};

		const syncRuntimeSurface = async (): Promise<RuntimeSurface> => {
			try {
				const currentRuntime = capabilitiesRuntime?.();
				const currentStatus = capabilitiesStatus?.();
				const currentMcpServers = currentRuntime?.mcpServers ?? mcpServers;
				const currentSkillsManager =
					currentRuntime?.skillsManager ?? skillsManager;
				const surfaceKey = buildRuntimeSurfaceKey({
					runtime: currentRuntime,
					status: currentStatus,
					mcpServers: currentMcpServers,
					skillsManager: currentSkillsManager,
					tools,
				});

				if (runtimeSurface != null && runtimeSurface.key === surfaceKey) {
					return runtimeSurface;
				}

				const nextBuiltinTools = filterToolsByRuntimeConfig(
					createBuiltinTools({
						writeAuthority,
						skillsManager: currentSkillsManager,
						configView: {
							getRuntimeState: () => {
								const cfg = getUserConfig?.() ?? null;
								return cfg == null ? null : { config: cfg };
							},
						},
						sessionList: { checkpoint },
						toolSearch: {
							getTools: () => registry.getAllTools(),
						},
						subagentSpawn: {
							getLoopConfig: () => {
								if (llm == null || runtimeSurface == null) {
									throw new AgentLoopError(
										"subagent_spawn invoked before runtime is initialized",
									);
								}
								return {
									llm,
									context,
									sessionAssembler: runtimeSurface.sessionAssembler,
									checkpoint,
									modelId,
									tools: runtimeSurface.tools,
									toolRouterOptions: {
										sandboxOrigin: "agent",
										sandboxApproval: confirmSandboxApproval,
									},
									inferenceConfig,
								};
							},
						},
					}),
					toolFilter,
				);
				const nextInjectedTools = filterToolsByRuntimeConfig(
					withDefaultMetadata(tools),
					toolFilter,
				);
				const nextMcpServerSignatures = new Map(
					currentMcpServers.map((entry) => [
						entry.id,
						mcpServerRuntimeSignature(entry),
					]),
				);
				const nextMcpServerIds = new Set(nextMcpServerSignatures.keys());
				const removedMcpServerIds = [
					...registeredMcpServerSignatures.keys(),
				].filter((serverId) => !nextMcpServerIds.has(serverId));
				const changedMcpServers = currentMcpServers.filter(
					(entry) =>
						registeredMcpServerSignatures.get(entry.id) !==
						nextMcpServerSignatures.get(entry.id),
				);

				// Force re-registration for previously-registered servers whose
				// transport has disconnected (e.g. ERR_USE_AFTER_CLOSE catch-up).
				// This enables auto-reconnect on the next turn without waiting for
				// a capabilities config change.
				const disconnectedMcpServers = currentMcpServers.filter(
					(entry) =>
						registeredMcpServerSignatures.has(entry.id) &&
						!registry.isServerConnected(entry.id),
				);
				for (const entry of disconnectedMcpServers) {
					if (!changedMcpServers.includes(entry)) {
						changedMcpServers.push(entry);
					}
				}

				const isReconnect = (id: string): boolean =>
					disconnectedMcpServers.some((entry) => entry.id === id);
				for (const entry of changedMcpServers) {
					try {
						const registeredTools = await registry.register(entry);
						mcpServerToolCounts.set(entry.id, registeredTools.length);
						await recordAgentRunEvent(
							runLogger,
							isReconnect(entry.id)
								? "mcp.reconnect_succeeded"
								: "mcp.register_succeeded",
							{
								serverId: entry.id,
								toolCount: registeredTools.length,
							},
						);
					} catch (err) {
						logger.warn({ err, serverId: entry.id }, "MCP register failed");
						mcpServerToolCounts.delete(entry.id);
						await recordAgentRunEvent(
							runLogger,
							isReconnect(entry.id)
								? "mcp.reconnect_failed"
								: "mcp.register_failed",
							{
								serverId: entry.id,
								error: err instanceof Error ? err.message : String(err),
							},
						);
					}
				}
				for (const serverId of removedMcpServerIds) {
					await registry.unregister(serverId);
					mcpServerToolCounts.delete(serverId);
					await recordAgentRunEvent(runLogger, "mcp.unregister", {
						serverId,
					});
				}

				registry.clearBuiltinTools();
				registry.registerBuiltin(nextBuiltinTools);
				if (nextInjectedTools.length > 0) {
					registry.registerBuiltin(nextInjectedTools);
				}

				registeredMcpServerSignatures.clear();
				for (const [serverId, signature] of nextMcpServerSignatures) {
					registeredMcpServerSignatures.set(serverId, signature);
				}
				onMcpReconnectApplied?.();

				const nextPromptSession = createPromptSessionAssembler(
					modelId,
					registry,
					state.createdAt,
					restoredState?.lastActiveAt,
					currentSkillsManager,
					toolFilter,
					() => toolProvenance,
				);
				promptSession?.dispose();
				promptSession = nextPromptSession;
				updateCatalogHintSubscription(currentSkillsManager);

				const previousSurfaceKey = runtimeSurface?.key;
				runtimeSurface = {
					key: surfaceKey,
					sessionAssembler: nextPromptSession.assembler,
					tools: filterToolsByRuntimeConfig(registry.getAllTools(), toolFilter),
				};
				// Telemetry: hot-reload / first-build distinction lets dashboard
				// see when capabilities config or skills catalog actually rotates.
				await recordAgentRunEvent(
					runLogger,
					previousSurfaceKey == null
						? "capabilities.surface_built"
						: "capabilities.reload_applied",
					{
						previousKey: previousSurfaceKey,
						nextKey: surfaceKey,
						mcpServerCount: registeredMcpServerSignatures.size,
						toolCount: runtimeSurface.tools.length,
					},
				);
				return runtimeSurface;
			} catch (err) {
				if (runtimeSurface != null) {
					logger.warn(
						{ error: providerErrorLogFields(err) },
						"REPL: capabilities runtime sync failed; keeping previous surface",
					);
					await recordAgentRunEvent(runLogger, "capabilities.reload_failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					return runtimeSurface;
				}
				throw err;
			}
		};

		runtimeSurface = await syncRuntimeSurface();
		const baseModel = provider(modelId);
		let reasoningDisplay: ReasoningDisplayMode = "collapsed";
		let streamRenderState = createStreamRenderState();
		const streamingLlm = new StreamingLLMClient(
			{
				model: baseModel,
				resolveModel: provider,
			},
			(event) => {
				renderStreamEvent(event, reasoningDisplay, streamRenderState);
			},
		);
		let lastProviderRunRecord: ProviderRunRecord | undefined;
		const recordProviderRun = (record: ProviderRunRecord): void => {
			lastProviderRunRecord = record;
			try {
				onProviderRunRecord?.(record);
			} catch (err) {
				logger.warn(
					{ error: providerErrorLogFields(err) },
					"REPL: provider run callback failed",
				);
			}
			void recordAgentRunEvent(
				runLogger,
				"llm.provider_run",
				summarizeProviderRunRecord(record),
				{ turnId: activeTurnId },
			);
		};
		llm = new ProviderControlPlaneLLMClient(streamingLlm, {
			routeRequest: {
				provider: providerId,
				model: modelId,
			},
			...(tierRouting == null ? {} : { tierRouting }),
			onRunRecord: recordProviderRun,
		});
		const activeLlm = llm;

		while (true) {
			slashCommandHelpShownForPrompt = false;
			mainPromptActive = queuedCommands.length === 0;
			if (mainPromptActive) {
				slashCommandHelpController?.resetInput();
			}
			const input = queuedCommands.shift() ?? (await rl.question(REPL_PROMPT));
			mainPromptActive = false;
			const trimmed = input.trim();

			if (!trimmed) {
				continue;
			}

			if (trimmed === "/exit" || trimmed === "/quit") {
				state = createState([...messages], {
					...state,
					isTerminal: true,
					lastActiveAt: new Date().toISOString(),
				});
				await checkpoint.save(state);
				stderr.write("\nBye! 🐉\n");
				break;
			}

			if (trimmed === "/clear") {
				messages.length = 0;
				streamRenderState = createStreamRenderState();
				runtimeSurface.sessionAssembler.resetSession();
				state = createState([...messages], {
					...state,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				stderr.write("Conversation cleared.\n\n");
				continue;
			}

			if (trimmed === "/status") {
				const effectiveModel = getEffectiveModelId(
					providerId,
					modelId,
					inferenceConfig.thinkingMode,
				);
				stderr.write(
					tierRouting == null
						? `Status: model=${modelId} | effective=${effectiveModel} | thinking=${inferenceConfig.thinkingMode} | routing=fixed | reasoning=${reasoningDisplay}\n`
						: `Status: base_model=${modelId} | base_effective=${effectiveModel} | base_thinking=${inferenceConfig.thinkingMode} | routing=${tierRouting.mode} | reasoning=${reasoningDisplay}\n`,
				);
				if (tierRouting != null) {
					stderr.write(
						`Tiers: flash=${tierRouting.tiers.flash.provider}/${tierRouting.tiers.flash.model} thinking=${tierRouting.tiers.flash.thinkingMode} | lite=${tierRouting.tiers.lite.provider}/${tierRouting.tiers.lite.model} thinking=${tierRouting.tiers.lite.thinkingMode} | pro=${tierRouting.tiers.pro.provider}/${tierRouting.tiers.pro.model} thinking=${tierRouting.tiers.pro.thinkingMode}\n`,
					);
					if (lastProviderRunRecord != null) {
						const route = lastProviderRunRecord.route;
						stderr.write(
							`Last route: tier=${route.selectedTier ?? "none"} | provider=${route.provider} | configured=${route.configuredModel} | effective=${route.effectiveModel} | thinking=${route.thinkingMode ?? inferenceConfig.thinkingMode} | reason=${route.routeReason ?? "n/a"}\n`,
						);
					}
				}
				const capabilitiesReloadStatus = capabilitiesStatus?.();
				if (capabilitiesReloadStatus != null) {
					stderr.write(
						`${renderCapabilitiesStatus(capabilitiesReloadStatus)}\n`,
					);
					const mcpEntries = buildMcpServerDisplayEntries(
						mcpServerToolCounts,
						capabilitiesReloadStatus,
					);
					stderr.write(
						`${renderCapabilitiesTable(capabilitiesReloadStatus)}\n`,
					);
					stderr.write(`${renderMcpDetailStatus(mcpEntries)}\n`);
				}
				stderr.write(`${renderTokenBudget(messages)}\n`);
				const supervisorSnapshot = supervisorRuntime.snapshot();
				stderr.write(`${formatAgentsSummary(supervisorSnapshot)}\n`);
				stderr.write(
					`${formatAgentNotificationStatus(supervisorSnapshot, supervisorRuntime)}\n`,
				);
				continue;
			}
			if (trimmed === "/agents") {
				stderr.write(`${renderAgentsStatus(supervisorRuntime.snapshot())}\n`);
				continue;
			}

			if (trimmed === "/mcp") {
				const cs = capabilitiesStatus?.();
				const entries = buildMcpServerDisplayEntries(mcpServerToolCounts, cs);
				if (entries.length === 0) {
					stderr.write("No MCP servers registered.\n");
				} else {
					stderr.write(`MCP Servers (${entries.length}):\n`);
					const textLines = entries.map(formatMcpServerDisplayEntry);
					stderr.write(`${textLines.map((l) => `  ${l}`).join("\n")}\n`);
					stderr.write(`${renderMcpServerTable(entries)}\n`);
				}
				continue;
			}

			if (trimmed === "/proposals" || trimmed.startsWith("/proposals ")) {
				if (proposalStore == null) {
					stderr.write(
						"Self-evolution proposal store is not configured. Configure proposalStore to enable review commands.\n",
					);
					continue;
				}
				const tokens = tokenizeSlashCommand(trimmed).slice(1);
				const args = parseProposalCommandArgs(tokens);
				const limitResult = parsePositiveLimitFlag(
					args.flags,
					DEFAULT_PROPOSAL_LIST_LIMIT,
				);
				if (!limitResult.ok) {
					stderr.write(`${limitResult.reason}\n`);
					continue;
				}
				try {
					const pending = await proposalStore.query({
						reviewState: "pending_review",
					});
					if (pending.length === 0) {
						stderr.write("No pending proposals.\n");
						continue;
					}
					const visible = pending.slice(0, limitResult.value);
					stderr.write(
						`Pending proposals (${visible.length} of ${pending.length}):\n`,
					);
					stderr.write(`${renderProposalListTable(visible)}\n`);
					if (pending.length > visible.length) {
						stderr.write(
							`Showing first ${visible.length}; pass --limit ${pending.length} to see all.\n`,
						);
					}
				} catch (error) {
					stderr.write(
						`Failed to list proposals: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				}
				continue;
			}

			if (trimmed.startsWith("/proposal-approve")) {
				if (proposalStore == null) {
					stderr.write("Self-evolution proposal store is not configured.\n");
					continue;
				}
				const tokens = tokenizeSlashCommand(trimmed).slice(1);
				const args = parseProposalCommandArgs(tokens);
				const proposalId = args.positional[0];
				if (proposalId === undefined || proposalId.length === 0) {
					stderr.write(
						"Usage: /proposal-approve <proposalId> [--reviewer <name>] [--yes]\n",
					);
					continue;
				}
				const reviewerFlag = args.flags.get("reviewer");
				const reviewer =
					typeof reviewerFlag === "string" && reviewerFlag.length > 0
						? reviewerFlag
						: "repl-user";
				// Proposal approval is the human-in-loop gate for self-evolution
				// scaffold-patch apply (a CRITICAL-classified write per
				// docs/07-safety-guardrails §2.6.4 — "CRITICAL 永远 confirm").
				// Trust mode (auto-low / auto-medium) MUST NOT silently skip the
				// approval prompt; only an explicit `--yes` flag may opt out per
				// invocation. This preserves the 4-eye review intent of the gate.
				// 提案 approve 是 self-evolution scaffold-patch apply（按 07-safety
				// §2.6.4 分类为 CRITICAL，"CRITICAL 永远 confirm"）的人工把关入口。
				// trust_mode (auto-low / auto-medium) 不能静默跳过这一确认；
				// 仅允许显式 `--yes` 在单次调用内 opt-out，保持人工 review 的设计意图。
				const skipConfirm = args.flags.get("yes") === true;
				let record: StoredProposalRecord | null;
				try {
					record = await proposalStore.getById(proposalId);
				} catch (error) {
					stderr.write(
						`Failed to load proposal ${proposalId}: ${error instanceof Error ? error.message : String(error)}\n`,
					);
					continue;
				}
				if (record == null) {
					stderr.write(`Proposal not found: ${proposalId}\n`);
					continue;
				}
				if (record.status !== "pending_review") {
					stderr.write(
						`Proposal ${proposalId} is already ${record.status} and cannot be approved again.\n`,
					);
					continue;
				}
				if (!skipConfirm) {
					if (rl == null) {
						stderr.write(
							"Cannot prompt for approval confirmation without an interactive REPL; pass --yes to skip.\n",
						);
						continue;
					}
					const resumeLiveInput = liveInputQueue.suspend();
					let answer: string;
					try {
						answer = (
							await rl.question(
								`Approve proposal ${shortenProposalId(record.proposalId)} — "${truncateProposalSummary(record.title)}"? [y/N]: `,
							)
						).trim();
					} finally {
						resumeLiveInput();
					}
					const normalized = answer.toLowerCase();
					if (normalized !== "y" && normalized !== "yes") {
						stderr.write("Approval cancelled.\n");
						continue;
					}
				}
				try {
					const transitioned = await proposalStore.transitionReviewState(
						record.proposalId,
						{
							status: "approved",
							reviewer,
							reason: "Approved via REPL slash command.",
						},
					);
					stderr.write(
						`Proposal approved: ${transitioned.proposalId} (reviewer=${reviewer}).\n`,
					);
					stderr.write(
						"Use /proposal-apply to apply approved proposals, or wait for the next idle apply pass.\n",
					);
					await recordAgentRunEvent(runLogger, "proposal.approved", {
						proposalId: transitioned.proposalId,
						reviewer,
						skipConfirm,
					});
				} catch (error) {
					stderr.write(
						`Failed to approve proposal: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				}
				continue;
			}

			if (trimmed.startsWith("/proposal-reject")) {
				if (proposalStore == null) {
					stderr.write("Self-evolution proposal store is not configured.\n");
					continue;
				}
				const tokens = tokenizeSlashCommand(trimmed).slice(1);
				// `--reason` is greedy: it consumes every following non-flag token
				// and joins them with a single space, so unquoted multi-word
				// reasons (`--reason duplicate of QUI-90`) work correctly without
				// silently dropping trailing words.
				// `--reason` 贪婪消耗后续非 flag token 并以单空格 join，
				// 这样不带引号的多词 reason（例如 `--reason duplicate of QUI-90`）
				// 也能完整保留，不会丢字。
				const args = parseProposalCommandArgs(tokens, {
					greedyFlags: new Set(["reason"]),
				});
				const proposalId = args.positional[0];
				if (proposalId === undefined || proposalId.length === 0) {
					stderr.write(
						'Usage: /proposal-reject <proposalId> --reason "..." [--reviewer <name>]\n',
					);
					continue;
				}
				const reasonFlag = args.flags.get("reason");
				if (reasonFlag === undefined || reasonFlag === true) {
					stderr.write(
						'Missing --reason "..." (rejection reason is required).\n',
					);
					continue;
				}
				const reasonText = sanitizeProposalReason(reasonFlag);
				if (reasonText.length === 0) {
					stderr.write("Rejection reason must be a non-empty string.\n");
					continue;
				}
				const reviewerFlag = args.flags.get("reviewer");
				const reviewer =
					typeof reviewerFlag === "string" && reviewerFlag.length > 0
						? reviewerFlag
						: "repl-user";
				try {
					const record = await proposalStore.getById(proposalId);
					if (record == null) {
						stderr.write(`Proposal not found: ${proposalId}\n`);
						continue;
					}
					if (record.status !== "pending_review") {
						stderr.write(
							`Proposal ${proposalId} is already ${record.status} and cannot be rejected.\n`,
						);
						continue;
					}
					const transitioned = await proposalStore.transitionReviewState(
						record.proposalId,
						{
							status: "rejected",
							reviewer,
							reason: reasonText,
						},
					);
					stderr.write(
						`Proposal rejected: ${transitioned.proposalId} (reviewer=${reviewer}).\n`,
					);
					const reasonHash = hashReviewReason(reasonText);
					await recordAgentRunEvent(runLogger, "proposal.rejected", {
						proposalId: transitioned.proposalId,
						reviewer,
						reasonChars: reasonText.length,
						...(reasonHash == null ? {} : { reasonHash }),
					});
				} catch (error) {
					stderr.write(
						`Failed to reject proposal: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				}
				continue;
			}

			if (
				trimmed === "/proposal-apply" ||
				trimmed.startsWith("/proposal-apply ")
			) {
				if (proposalStore == null) {
					stderr.write("Self-evolution proposal store is not configured.\n");
					continue;
				}
				const tokens = tokenizeSlashCommand(trimmed).slice(1);
				const args = parseProposalCommandArgs(tokens);
				const limitResult = parsePositiveLimitFlag(args.flags, 0);
				if (!limitResult.ok) {
					stderr.write(`${limitResult.reason}\n`);
					continue;
				}
				try {
					// Resolve the sandbox gate per QUI-97 round-2: scaffold_patch
					// proposals require an explicit gate, so the REPL falls back
					// to the default Docker gate when the embedder did not pass
					// one. Embedders that want stricter behavior (require Docker)
					// can supply their own gate via `proposalSandboxPolicyGate`.
					// 解析 sandbox gate（QUI-97 round-2）：未注入时回退到默认
					// Docker gate，避免 scaffold_patch 被静默 deny。
					const sandboxGate =
						proposalSandboxPolicyGate ??
						createDockerProposalSandboxPolicyGate();
					const result = await proposalStore.applyApproved(writeAuthority, {
						origin: "user",
						reviewer: "repl-user",
						sandboxPolicyGate: sandboxGate,
						runLogger,
					});
					const totalOutcomes =
						result.applied.length +
						result.skipped.length +
						result.failed.length;
					if (totalOutcomes === 0) {
						stderr.write("No approved proposals to apply.\n");
						continue;
					}
					stderr.write(
						`Apply outcomes: applied=${result.applied.length} skipped=${result.skipped.length} failed=${result.failed.length}\n`,
					);
					stderr.write(`${renderProposalApplyTable(result)}\n`);
					// Emit one telemetry event per outcome bucket so the agent-run
					// JSONL log preserves the audit trail for CRITICAL scaffold-patch
					// applies (07 §2.6.4: every WriteAuthority confirm gate must be
					// observable). proposalIds keep the link back to proposalStore.
					// 每种 outcome bucket 发一条遥测事件，让 agent-run JSONL 保留
					// CRITICAL scaffold-patch apply 的审计链路（07 §2.6.4: 每次
					// WriteAuthority confirm gate 都必须可观测）。proposalId 用于
					// 反查 proposalStore。
					for (const applied of result.applied) {
						await recordAgentRunEvent(runLogger, "proposal.applied", {
							proposalId: applied.proposalId,
							reviewer: "repl-user",
						});
					}
					for (const outcome of result.skipped) {
						await recordAgentRunEvent(runLogger, "proposal.apply_skipped", {
							proposalId: outcome.proposalId,
							reasonCode: outcome.reasonCode,
						});
					}
					for (const outcome of result.failed) {
						await recordAgentRunEvent(runLogger, "proposal.apply_failed", {
							proposalId: outcome.proposalId,
							reasonCode: outcome.reasonCode,
						});
					}
				} catch (error) {
					stderr.write(
						`Failed to apply approved proposals: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				}
				continue;
			}

			if (trimmed.startsWith("/think")) {
				const mode = trimmed.split(/\s+/u)[1];
				switch (mode) {
					case "on":
						inferenceConfig = {
							...inferenceConfig,
							thinkingMode: "enabled",
						};
						stderr.write("Thinking mode: enabled.\n");
						break;
					case "off":
						inferenceConfig = {
							...inferenceConfig,
							thinkingMode: "disabled",
						};
						stderr.write("Thinking mode: disabled.\n");
						break;
					case "auto":
						inferenceConfig = {
							...inferenceConfig,
							thinkingMode: "auto",
						};
						stderr.write("Thinking mode: auto.\n");
						break;
					default:
						stderr.write("Usage: /think on|off|auto\n");
						break;
				}
				continue;
			}

			if (trimmed === "/verbose") {
				reasoningDisplay = "verbose";
				stderr.write("Reasoning display: verbose.\n");
				continue;
			}

			if (trimmed === "/collapse") {
				reasoningDisplay = "collapsed";
				stderr.write("Reasoning display: collapsed.\n");
				continue;
			}

			if (trimmed === "/resume") {
				const sessions = await checkpoint.listSessions();
				if (sessions.length === 0) {
					stderr.write("No saved sessions found.\n");
				} else {
					stderr.write(`${renderResumeSessionsTable(sessions)}\n`);
					stderr.write("输入 /resume <编号> 恢复, 或 /resume latest\n");
				}
				continue;
			}

			if (trimmed === "/sessions") {
				// Candidate 1 Slice A: list every AgentService session currently
				// in-process — covers TUI's own + web's + any future agent-mesh
				// consumer's. This is the heat-store complement to /resume
				// (which is the SQLite cold-store).
				//
				// 进程内 AgentService session 列表(TUI/web/agent-mesh)。是 /resume
				// 冷存的热存补集。Slice B+ 会加 `/sessions <id>` 切入。
				const svcSessions = listAgentServiceSessions(agentService);
				stderr.write(`${renderAgentServiceSessionsTable(svcSessions)}\n`);
				stderr.write(
					"(read-only in Slice A; switching via `/sessions <id>` lands in Slice B)\n",
				);
				continue;
			}

			if (trimmed === "/resume latest") {
				const sessions = await checkpoint.listSessions();
				if (sessions.length === 0) {
					stderr.write("No saved sessions found.\n");
					continue;
				}
				const latest = sessions[0] as ResumeSessionSummary;
				const restoredState = await checkpoint.load(latest.sessionId);
				if (restoredState == null) {
					stderr.write(`Session could not be loaded.\n`);
					continue;
				}
				state = createState([...messages], {
					...state,
					isTerminal: true,
					lastActiveAt: new Date().toISOString(),
				});
				await checkpoint.save(state);
				const restoredMessages =
					restoredState.messages[0]?.role === "system"
						? restoredState.messages.slice(1)
						: [...restoredState.messages];
				messages.splice(0, messages.length, ...restoredMessages);
				streamRenderState = createStreamRenderState();
				runtimeSurface.sessionAssembler.resetSession();
				state = createState([...messages], {
					...restoredState,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				continue;
			}

			if (trimmed.startsWith("/resume ")) {
				const arg = trimmed.slice(8).trim();
				const parsedIndex = Number.parseInt(arg, 10);

				if (!Number.isInteger(parsedIndex) || String(parsedIndex) !== arg) {
					stderr.write(`Invalid session number: ${arg}\n`);
					continue;
				}

				const sessions = await checkpoint.listSessions();
				const targetIndex = parsedIndex - 1;

				if (targetIndex < 0 || targetIndex >= sessions.length) {
					stderr.write(
						`Session number ${parsedIndex} out of range (1-${sessions.length}).\n`,
					);
					continue;
				}

				const targetSession = sessions[targetIndex] as ResumeSessionSummary;
				const restoredState = await checkpoint.load(targetSession.sessionId);

				if (restoredState == null) {
					stderr.write(
						`Session ${targetSession.sessionId} could not be loaded.\n`,
					);
					continue;
				}

				state = createState([...messages], {
					...state,
					isTerminal: true,
					lastActiveAt: new Date().toISOString(),
				});
				await checkpoint.save(state);

				const restoredMessages =
					restoredState.messages[0]?.role === "system"
						? restoredState.messages.slice(1)
						: [...restoredState.messages];

				messages.splice(0, messages.length, ...restoredMessages);
				streamRenderState = createStreamRenderState();
				runtimeSurface.sessionAssembler.resetSession();
				state = createState([...messages], {
					...restoredState,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});

				stderr.write(
					`Resumed session ${targetSession.sessionId} (${restoredMessages.length} messages).\n\n`,
				);
				continue;
			}

			if (trimmed === "/" || trimmed === "/help" || trimmed === "/?") {
				if (!slashCommandHelpShownForPrompt) {
					stderr.write(`${renderSlashCommandHelp()}\n`);
				}
				continue;
			}

			if (trimmed.startsWith("/")) {
				stderr.write(`Unknown command: ${trimmed}\n`);
				stderr.write(`${renderSlashCommandHelp(trimmed)}\n`);
				continue;
			}

			const previousLastActiveAt = state.lastActiveAt;
			const currentTurnId = crypto.randomUUID();
			activeTurnId = currentTurnId;
			liveInputQueue.beginTurn(currentTurnId);
			await recordAgentRunEvent(
				runLogger,
				"turn.input_received",
				{
					input: {
						chars: trimmed.length,
						previewRedacted: true,
					},
					inputChars: trimmed.length,
					historyMessageCount: messages.length,
					stateTurnCount: state.turnCount,
				},
				{ turnId: currentTurnId },
			);
			messages.push({ role: "user", content: trimmed });
			state = createState([...messages], {
				...state,
				messages: [...messages],
				lastActiveAt: new Date().toISOString(),
			});
			// Visual gap between user input echo and the LLM reply belongs
			// on the reply stream (stdout) — same channel as `case "text"`
			// and the readline prompt (both on stdout after the channel split).
			stdout.write("\n");

			try {
				streamRenderState = createStreamRenderState();
				runtimeSurface = await syncRuntimeSurface();
				let latestAssistantMessage: Message | undefined;
				let latestLoopMessages: readonly Message[] | undefined;
				const userContextBudget = resolveContextBudget();
				const observerBridge = resolveObserverBridge();
				const response = await runAgentLoop(
					{
						llm: activeLlm,
						context,
						...(userContextBudget == null
							? {}
							: { contextBudget: userContextBudget }),
						sessionAssembler: runtimeSurface.sessionAssembler,
						checkpoint,
						state,
						modelId,
						lastMessageTime: previousLastActiveAt,
						tools: runtimeSurface.tools,
						toolRouterOptions: {
							sandboxOrigin: "agent",
							sandboxApproval: confirmSandboxApproval,
						},
						inferenceConfig,
						...(observerBridge == null
							? {}
							: {
									observerBridge,
									observerSessionId: resolvedSessionId,
								}),
						observability: {
							...options.observability,
							runLogger: runLogger ?? options.observability?.runLogger,
							turnId: currentTurnId,
							llmProviderId: providerId,
						},
						hooks: {
							onAssistantMessage: (message) => {
								latestAssistantMessage = message;
								// At this point the LLM stream has ended; ensure
								// the reply ends on a newline before any logger
								// output (e.g. provider run record) writes to
								// stderr in between.
								finalizeStreamRender(streamRenderState);
							},
							onMessagesUpdated: (loopMessages) => {
								latestLoopMessages = [...loopMessages];
							},
							onIdle,
							onToolResult: async (event) => {
								const provenance = createToolProvenanceEntry({
									toolCall: event.toolCall,
									toolResult: event.toolResult,
									sanitizedContent: event.sanitizedContent,
									actionVerification: event.actionVerification,
									scanResult: event.scanResult,
									trustedToolOutput: event.trustedToolOutput,
									hasBlockedThreat: event.hasBlockedThreat,
									appendedToModelContext: true,
									at: new Date().toISOString(),
								});
								if (provenance == null) {
									return;
								}
								toolProvenance.push(provenance);
								if (toolProvenance.length > 50) {
									toolProvenance.splice(0, toolProvenance.length - 50);
								}
								await recordAgentRunEvent(
									runLogger,
									"tool.provenance_recorded",
									{ provenance },
									{ turnId: currentTurnId },
								);
							},
						},
					},
					messages,
				);

				if (latestLoopMessages == null) {
					messages.push(
						latestAssistantMessage ?? { role: "assistant", content: response },
					);
				} else {
					messages.splice(0, messages.length, ...latestLoopMessages);
				}
				state = createState([...messages], {
					...state,
					messages: [...messages],
					turnCount: state.turnCount + 1,
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
				if (trajectoryStore != null) {
					try {
						const turnInput: TrajectoryRecordInput = {
							runId: `${resolvedSessionId}-${state.turnCount}`,
							outcome: "success",
							steps: [{ index: 0, kind: "model", label: "user-turn" }],
						};
						await trajectoryStore.append(turnInput);
					} catch (trajErr) {
						logger.warn(
							{ error: providerErrorLogFields(trajErr) },
							"REPL: trajectory save failed",
						);
					}
				}
				// Single trailing newline at turn end: `finalizeStreamRender`
				// (called from `onAssistantMessage`) already guarantees the
				// reply ends on `\n`. Adding `\n\n` here would produce two
				// blank lines between the reply and the next prompt — keep
				// just one for visual breathing room. Goes to stdout because
				// it is part of the reply visual that precedes the next
				// (stdout-rendered) readline prompt.
				stdout.write("\n");
			} catch (err) {
				logger.error(
					{ error: providerErrorLogFields(err) },
					"REPL: LLM call failed",
				);
				streamRenderState = createStreamRenderState();
				stderr.write("\n[Error: LLM call failed. Check logs for details.]\n\n");
				messages.pop();
				state = createState([...messages], {
					...state,
					messages: [...messages],
					isTerminal: false,
					lastActiveAt: new Date().toISOString(),
				});
			} finally {
				await flushObservabilitySpans(
					options.observability,
					options.spanExporter,
				);
				liveInputQueue.finishTurn();
				activeTurnId = undefined;
			}
		}
	} finally {
		await flushAgentRunLogger(runLogger);
		promptSession?.dispose();
		unsubscribeCatalogHints?.();
		slashCommandHelpController?.dispose();
		rl?.off?.("line", handleLiveInputLine);
		rl?.close();
		if (ownsStaticSkillsManager) {
			skillsManager?.stopWatching();
		}
		await registry.disconnectAll();
	}
}
