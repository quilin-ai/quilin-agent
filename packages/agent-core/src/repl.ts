import { stderr, stdin } from "node:process";
import { clearScreenDown, emitKeypressEvents, moveCursor } from "node:readline";
import * as readline from "node:readline/promises";
import type { CapabilitiesReloadStatus } from "./config/hot-reload.js";
import type { CapabilitiesRuntime } from "./config/loader.js";
import {
	isRuntimeToolEnabled,
	type RuntimeToolFilter,
} from "./config/runtime.js";
import { createDefaultPromptSections } from "./context/default-sections.js";
import { BasicContextManager } from "./context/manager.js";
import { PromptBuilder } from "./context/prompt-builder.js";
import { PromptSessionAssembler } from "./context/prompt-session-assembler.js";
import {
	createHotSkillsSection,
	createPostCompactSkillsSection,
	createSkillsCatalogSection,
} from "./context/skills-catalog-section.js";
import { createTemporalBucketSection } from "./context/temporal.js";
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
	type ChildRunStatusRecord,
	InProcessSupervisorRuntime,
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
import type { SkillsCatalogChange, SkillsManager } from "./skills/manager.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";
import type { AgentState, Message } from "./state/types.js";
import { createBuiltinTools } from "./tools/builtin/index.js";
import { MCPRegistry, type MCPServerEntry } from "./tools/registry.js";
import type { SandboxApprovalRequest } from "./tools/router.js";
import type { ToolWithMetadata } from "./tools/tool-metadata.js";
import type { Tool } from "./tools/types.js";

const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
	temperature: 0.7,
	maxTokens: 4096,
	thinkingMode: "disabled",
};
const REPL_PROMPT = "quilin> ";
const SLASH_COMMAND_NAME_WIDTH = 18;

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
		name: "quit",
		signature: "/quit",
		description: "Save and quit",
	},
];

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
	supervisorRuntime?: InProcessSupervisorRuntime;
	agentRunLogger?: AgentRunLogSink;
	onProviderRunRecord?: (record: ProviderRunRecord) => void;
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
		getAvailableTools: () =>
			filterToolsByRuntimeConfig(registry.getAllTools(), toolFilter)
				.map((tool) => tool.name)
				.filter((name): name is string => name != null),
		getAvailableToolDescriptors: () =>
			filterToolsByRuntimeConfig(registry.getToolDescriptors(), toolFilter),
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

function formatAgentRecord(record: ChildRunStatusRecord): string {
	const fields = [
		`${displayRunStatus(record).padEnd(18)} run=${record.runId}`,
		`task=${record.taskId}`,
		record.workerId == null ? undefined : `worker=${record.workerId}`,
		record.currentStep == null ? undefined : `step=${record.currentStep}`,
		record.blocker == null
			? undefined
			: `blocker=${quoteAgentField(record.blocker)}`,
		`summary=${quoteAgentField(record.summary) ?? '""'}`,
		`confidence=${record.confidence}`,
		`artifacts=${record.reviewedArtifactCount}`,
		`updated=${record.updatedAt}`,
	];

	return fields.filter((field): field is string => field != null).join(" ");
}

function renderAgentsStatus(snapshot: SupervisorRuntimeSnapshot): string {
	if (snapshot.records.length === 0) {
		return `${formatAgentsSummary(snapshot)}\nNo local subagent runs yet.`;
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
		"",
		...records.map(formatAgentRecord),
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
}

function createStreamRenderState(): ReplStreamRenderState {
	return {
		thinkingShown: false,
		toolInputs: new Map(),
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
			stderr.write(event.delta);
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

function formatSlashCommandEntry(command: SlashCommandEntry): string {
	return `  ${command.signature.padEnd(SLASH_COMMAND_NAME_WIDTH)} ${command.description}`;
}

function renderSlashCommandHelp(line = ""): string {
	const query = parseSlashCommandQuery(line);
	const matchingCommands = SLASH_COMMANDS.filter((command) =>
		matchesSlashCommandQuery(command, query),
	);
	const commandLines =
		matchingCommands.length > 0
			? matchingCommands.map(formatSlashCommandEntry)
			: ["  No matching slash commands."];

	return [
		"Slash commands:",
		...commandLines,
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
	return Math.max(1, stderr.columns ?? 80);
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
	moveCursor(stderr, -cursorPos.cols, -(cursorPos.rows + helpRows));
}

function restoreCursorPosition(
	from: ReadlineDisplayPosition,
	to: ReadlineDisplayPosition,
): void {
	moveCursor(stderr, to.cols - from.cols, to.rows - from.rows);
}

function clearPromptBlock(
	cursorPos: ReadlineDisplayPosition,
	helpRows: number,
): void {
	moveToBlockTop(cursorPos, helpRows);
	clearScreenDown(stderr);
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
	stderr.write(fullBlockText);
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
			stderr.write(promptText);
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

	if (stdin.isTTY !== true || stderr.isTTY !== true) {
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
		onProviderRunRecord,
	} = options;
	const context = new BasicContextManager();
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
	const resolvedSessionId = sessionId ?? crypto.randomUUID();
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

		rl = readline.createInterface({ input: stdin, output: stderr });
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

				for (const entry of changedMcpServers) {
					await registry.register(entry);
				}
				for (const serverId of removedMcpServerIds) {
					await registry.unregister(serverId);
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

				runtimeSurface = {
					key: surfaceKey,
					sessionAssembler: nextPromptSession.assembler,
					tools: filterToolsByRuntimeConfig(registry.getAllTools(), toolFilter),
				};
				return runtimeSurface;
			} catch (err) {
				if (runtimeSurface != null) {
					logger.warn(
						{ error: providerErrorLogFields(err) },
						"REPL: capabilities runtime sync failed; keeping previous surface",
					);
					return runtimeSurface;
				}
				throw err;
			}
		};

		runtimeSurface = await syncRuntimeSurface();
		const baseModel = provider(modelId);
		let inferenceConfig: InferenceConfig = {
			...DEFAULT_INFERENCE_CONFIG,
			...initialInferenceConfig,
		};
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
		const llm = new ProviderControlPlaneLLMClient(streamingLlm, {
			routeRequest: {
				provider: providerId,
				model: modelId,
			},
			...(tierRouting == null ? {} : { tierRouting }),
			onRunRecord: recordProviderRun,
		});

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
				}
				stderr.write(`${formatAgentsSummary(supervisorRuntime.snapshot())}\n`);
				continue;
			}

			if (trimmed === "/agents") {
				stderr.write(`${renderAgentsStatus(supervisorRuntime.snapshot())}\n`);
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
			stderr.write("\n");

			try {
				streamRenderState = createStreamRenderState();
				runtimeSurface = await syncRuntimeSurface();
				let latestAssistantMessage: Message | undefined;
				let latestLoopMessages: readonly Message[] | undefined;
				const response = await runAgentLoop(
					{
						llm,
						context,
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
						observability: {
							...options.observability,
							runLogger: runLogger ?? options.observability?.runLogger,
							turnId: currentTurnId,
							llmProviderId: providerId,
						},
						hooks: {
							onAssistantMessage: (message) => {
								latestAssistantMessage = message;
							},
							onMessagesUpdated: (loopMessages) => {
								latestLoopMessages = [...loopMessages];
							},
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
				stderr.write("\n\n");
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
