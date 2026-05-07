#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConfigCommand } from "./cli/config-cmd.js";
import {
	type CapabilitiesHotReloadEvent,
	createCapabilitiesHotReloadController,
} from "./config/hot-reload.js";
import {
	bootstrapUserRuntime,
	buildRuntimeInferenceConfig,
	buildRuntimeTierRoutingConfig,
	buildRuntimeToolFilter,
	resolveRuntimeWriteAuthorityMode,
} from "./config/runtime.js";
import type { UserConfigLoadResult } from "./config/user-config.js";
import {
	normalizeProviderError,
	ProviderControlPlaneLLMClient,
	VercelLLMClient,
} from "./llm/client.js";
import {
	createProvider,
	DEFAULT_PROVIDER_CATALOG,
	getDefaultModel,
} from "./llm/provider.js";
import type {
	InferenceConfig,
	LLMModelTier,
	LLMProviderId,
	LLMTierRoutingConfig,
	ProviderRunRecord,
} from "./llm/types.js";
import { configureLogger, logger } from "./logger.js";
import { JsonFileSpanExporter } from "./observability/exporters/json-file.js";
import { startRepl } from "./repl.js";
import { SQLiteCheckpoint } from "./state/checkpoint.js";

export * from "./config/first-run.js";
export * from "./config/hot-reload.js";
export {
	type BootstrapOptions,
	bootstrapUserRuntime,
	buildRuntimeInferenceConfig,
	buildRuntimeReloadAuditEvent,
	buildRuntimeTierRoutingConfig,
	buildRuntimeToolFilter,
	diffUserRuntimeStateSnapshots,
	getDefaultSpanProvider,
	getDefaultStructuredLogger,
	getUserConfig,
	getUserConfigSources,
	getUserRuntime,
	getUserRuntimeStateSnapshot,
	isRuntimeToolEnabled,
	isUserRuntimeReady,
	type ReloadUserRuntimeOptions,
	type RuntimeReloadAuditEvent,
	type RuntimeReloadAuditEventInput,
	type RuntimeReloadFailureSnapshot,
	type RuntimeReloadOutcome,
	type RuntimeReloadOutcomeState,
	type RuntimeReloadOutcomeTransition,
	type RuntimeReloadOutcomeTransitionKind,
	type RuntimeReloadSuccessOperation,
	type RuntimeReloadSuccessSnapshot,
	type RuntimeToolFilter,
	reloadUserRuntime,
	resetUserRuntime,
	resolveRuntimeWriteAuthorityMode,
	type UserRuntimeInFlightDelta,
	UserRuntimeNotBootedError,
	type UserRuntimeStateSnapshot,
	type UserRuntimeStateSnapshotDiff,
	type UserRuntimeStateSnapshotField,
} from "./config/runtime.js";
export {
	type ConfigSource,
	loadUserConfig,
	UserConfigError,
	type UserConfigLoadOptions,
	type UserConfigLoadResult,
} from "./config/user-config.js";
export {
	FORBIDDEN_FIELD_FRAGMENTS,
	idleEvolutionConfigSchema,
	llmConfigSchema,
	memoryConfigSchema,
	observabilityConfigSchema,
	safetyConfigSchema,
	sessionConfigSchema,
	toolsConfigSchema,
	USER_CONFIG_SCHEMA_VERSION,
	type UserConfig,
	type UserConfigInput,
	type UserConfigSchemaVersion,
	userConfigSchema,
} from "./config/user-config-schema.js";
export * from "./context/index.js";
export * from "./control-plane/index.js";
export * from "./llm/client.js";
export * from "./llm/provider.js";
export * from "./llm/tier-router.js";
export * from "./llm/types.js";
export { runAgentLoop } from "./loop.js";
export type { AgentLoopConfig, LoopHooks } from "./loop-types.js";
export * from "./memory/index.js";
export * from "./multi-agent/index.js";
export * from "./observability/index.js";
export {
	buildPlannerRoutingTracePayload,
	decidePlannerRoute,
	explainPlannerRoutingDecision,
	type PlannerRoute,
	type PlannerRoutingDecision,
	type PlannerRoutingPolicy,
	type PlannerRoutingReasonCode,
	type PlannerRoutingRequest,
	type PlannerRoutingRiskTier,
	type PlannerRoutingStrategy,
	type PlannerRoutingTracePayload,
	validatePlannerRoutingDecision,
} from "./planning/planner-routing.js";
export {
	type CostRoutingGateDecision,
	type CostRoutingGateReason,
	type CostRoutingSignal,
	type CostRoutingStrategy,
	evaluateCostRoutingGate,
	evaluateTinyClassifierGate,
	type RecommendedModelTier,
	type TinyClassifierGateDecision,
	type TinyClassifierGateReason,
	type TinyClassifierSignal,
	validateCostRoutingSignal,
	validateTinyClassifierSignal,
} from "./planning/planner-routing-signals.js";
export {
	buildProductionRouteDelegationHandoffPlan,
	buildProductionRouteSupervisorHandoffPlan,
	classifyProductionRouteScoreBatchReadiness,
	explainProductionRoute,
	type ProductionRouteDelegationHandoffAcceptedItem,
	type ProductionRouteDelegationHandoffBlockedItem,
	type ProductionRouteDelegationHandoffPlan,
	type ProductionRouteDelegationHandoffPlanInput,
	type ProductionRouteExplanationBatchSummary,
	type ProductionRouteHandoffRecommendation,
	type ProductionRouteScore,
	type ProductionRouteScoreBatch,
	type ProductionRouteScoreBatchReadiness,
	type ProductionRouteScoreBatchReadinessCounts,
	type ProductionRouteScoreBatchReadinessSummary,
	type ProductionRouteScoreInput,
	type ProductionRouteScoreOptions,
	scoreProductionRoute,
	scoreProductionRoutes,
	summarizeProductionRouteExplanations,
	summarizeProductionRouteScoreBatchReadiness,
	summarizeProductionRouteScores,
} from "./planning/production-route-score.js";
export {
	applyEvent,
	type BudgetLedger,
	type Checkpoint as PlanningCheckpoint,
	type CheckpointFailedPayload,
	createPlanningState,
	type PlanningEvent,
	type PlanningState,
	type PlanPhase,
} from "./planning/state.js";
export {
	buildSupervisorHandoffPlan,
	CROSS_PROCESS_ROUTE_DECISION_SCHEMA_VERSION,
	type CrossProcessDeniedReason,
	type CrossProcessRouteDecision,
	type CrossProcessRouteMode,
	type CrossProcessRouteRequest,
	decideCrossProcessRoute,
	parseSupervisorHandoffPlan,
	SUPERVISOR_HANDOFF_PLAN_SCHEMA_VERSION,
	type SupervisorHandoffHistoryFilter,
	type SupervisorHandoffKind,
	type SupervisorHandoffPlan,
	validateSupervisorHandoffPlan,
} from "./planning/supervisor-handoff-plan.js";
export type {
	ClarificationRequest,
	DagPlan,
	Intent,
	IntentClassification,
	IntentClassifier,
	LinearPlan,
	LLMPlannerResponse,
	MemoryWriteScope,
	Plan,
	PlannerAudit,
	RiskLevel,
	SubTask,
} from "./planning/types.js";
export * from "./repl.js";
export * from "./safety/write-authority.js";
export * from "./self-evolution/index.js";
export {
	type RunSkillTriggerEvalOptions,
	runSkillTriggerEval,
} from "./skills/eval-runner.js";
export {
	type BuildSkillManifestOptions,
	buildSkillManifest,
	type SkillManifestCatalogHealthInput,
	type SkillManifestCatalogHealthSummary,
	type SkillManifestCatalogMissingFieldSummary,
	type SkillManifestCatalogRawHealthInput,
	type SkillManifestCatalogReadinessStatus,
	type SkillManifestCatalogReadinessSummary,
	type SkillManifestCatalogRiskCodeSummary,
	type SkillManifestHealthInput,
	type SkillManifestHealthStatus,
	type SkillManifestHealthSummary,
	type SkillManifestRiskCode,
	summarizeSkillManifestCatalogHealth,
	summarizeSkillManifestCatalogReadiness,
	summarizeSkillManifestCatalogReadinessInputs,
	summarizeSkillManifestHealth,
} from "./skills/manifest.js";
export {
	type CreateSkillProvenanceReceiptOptions,
	createSkillContentDigest,
	createSkillProvenanceReceipt,
	type SkillProvenanceValidationResult,
	type ValidateSkillProvenanceReceiptOptions,
	validateSkillProvenanceReceipt,
} from "./skills/provenance.js";
export type {
	SkillContentDigest,
	SkillManifest,
	SkillManifestSchemaVersion,
	SkillProvenanceReceipt,
	SkillProvenanceSchemaVersion,
	SkillTriggerEvalCase,
	SkillTriggerEvalCaseResult,
	SkillTriggerEvalReport,
} from "./skills/types.js";
export * from "./state/checkpoint.js";
export type {
	FileListToolOptions,
	FileReadToolOptions,
	FileWriteToolOptions,
} from "./tools/builtin/file-tools.js";
export {
	type BuiltinToolOptions,
	createBuiltinTools,
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
	createShellExecTool,
	createSkillManageTool,
	createSkillSearchTool,
	createSkillViewTool,
	createWebFetchTool,
} from "./tools/builtin/index.js";
export type {
	ShellExecToolOptions,
	ShellRunner,
	ShellRunnerOptions,
} from "./tools/builtin/shell-exec.js";
export type { SkillManageToolOptions } from "./tools/builtin/skill-manage.js";
export type { SkillSearchToolOptions } from "./tools/builtin/skill-search.js";
export type { SkillViewToolOptions } from "./tools/builtin/skill-view.js";
export type { WebFetchToolOptions } from "./tools/builtin/web-fetch.js";
export * from "./tools/docker-sandbox-router.js";
export * from "./tools/mcp-client.js";
export { MCPRegistry, type MCPServerEntry } from "./tools/registry.js";
export * from "./tools/router.js";
export {
	createSandboxApprovalSummary,
	defaultSandboxEvaluator,
	evaluateSandboxRequest,
	genericSandboxPolicy,
	resolveSandboxPolicy,
	type SandboxApprovalSummary,
	type SandboxDecision,
	type SandboxDecisionKind,
	type SandboxEvaluator,
	type SandboxNetworkSignal,
	type SandboxOperationType,
	type SandboxOrigin,
	type SandboxPathAccess,
	type SandboxPathSignal,
	type SandboxPolicy,
	type SandboxProcessSignal,
	type SandboxReasonCode,
	type SandboxRequest,
	type SandboxRequiredApproval,
	type SandboxRiskSignals,
	type SandboxToolContext,
} from "./tools/sandbox.js";
export * from "./tools/sandbox-router.js";
export {
	type JsonSchema,
	type JsonSchemaArray,
	type JsonSchemaObject,
	jsonSchemaToZod,
} from "./tools/schema-converter.js";
export {
	type CreateToolErrorOptions,
	type CreateToolErrorResultOptions,
	classifyToolException,
	createToolError,
	createToolErrorResult,
	toolExceptionMessage,
} from "./tools/tool-errors.js";
export type {
	RiskLevel as ToolRiskLevel,
	ToolCategory,
	ToolPromptDescriptor,
	ToolWithMetadata,
} from "./tools/tool-metadata.js";
export {
	MCP_TOOL_METADATA_MAX_LENGTH,
	MCP_TOOL_NAME_PATTERN,
	sanitizeMCPToolDescription,
	sanitizeMCPToolName,
} from "./tools/tool-sanitizer.js";
export type {
	Tool,
	ToolCall,
	ToolError,
	ToolErrorCode,
	ToolResult,
} from "./tools/types.js";
export * from "./types/index.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_PROVIDER_ID = "deepseek" satisfies LLMProviderId;
const MODEL_TIERS = ["flash", "lite", "pro"] as const;
const STARTUP_VERIFICATION_CONFIG: InferenceConfig = {
	temperature: 0,
	maxTokens: 20,
	thinkingMode: "disabled",
};

function logCapabilitiesHotReloadEvent(
	event: CapabilitiesHotReloadEvent,
): void {
	logger.info(
		{
			event: event.event,
			status: "status" in event ? event.status : "success",
			snapshot: event.snapshot,
		},
		"Capabilities hot reload event",
	);
}

export type RuntimeMode = "repl" | "service";

export interface MainOptions {
	readonly runtimeMode?: RuntimeMode;
	readonly serviceRunner?: () => Promise<void>;
}

interface ReplCliOptions {
	readonly sessionId?: string;
	readonly resumeLatest: boolean;
}

interface RuntimeModelSelection {
	readonly modelId: string;
	readonly source: "provider_default" | "user_config";
	readonly providerDefaultModel: string;
	readonly userConfigDefaultModel: string;
	readonly userConfigDefaultModelSource: UserConfigLoadResult["sources"][string];
}

type ProviderRunRecordRuntimePhase = "startup_verification" | "repl_turn";

function firstProviderRunError(record: ProviderRunRecord) {
	return (
		record.error ?? record.attempts.find((attempt) => attempt.error)?.error
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

function providerRunRecordLogPayload(
	record: ProviderRunRecord,
	runtimePhase: ProviderRunRecordRuntimePhase,
): Record<string, unknown> {
	const firstAttempt = record.attempts[0];
	const error = firstProviderRunError(record);

	return {
		runtime_phase: runtimePhase,
		provider: record.route.provider,
		configured_model: record.route.configuredModel,
		effective_model: record.route.effectiveModel,
		selected_tier: record.route.selectedTier,
		routing_mode: record.route.routingMode,
		route_reason: record.route.routeReason,
		route_thinking_mode: record.route.thinkingMode,
		fallback_used: record.fallbackUsed,
		outcome: record.outcome,
		attempt_count: record.attempts.length,
		reasoning_state_adapter: record.route.reasoningStateAdapter,
		request_max_tokens: record.route.budget?.maxTokens,
		request_thinking_budget: record.route.budget?.thinkingBudget,
		...(firstAttempt == null
			? {}
			: {
					attempt_provider: firstAttempt.provider,
					attempt_model: firstAttempt.model,
					attempt_outcome: firstAttempt.outcome,
					input_tokens: firstAttempt.usage?.inputTokens,
					output_tokens: firstAttempt.usage?.outputTokens,
					cache_read_tokens: firstAttempt.usage?.cache?.readTokens,
					cache_write_tokens: firstAttempt.usage?.cache?.writeTokens,
					cache_source: firstAttempt.usage?.cache?.source,
				}),
		...(error == null
			? {}
			: {
					error: {
						name: error.name,
						...(error.code == null ? {} : { code: error.code }),
						...(error.category == null ? {} : { category: error.category }),
					},
				}),
	};
}

function createProviderRunRecordLogger(
	runtimePhase: ProviderRunRecordRuntimePhase,
): (record: ProviderRunRecord) => void {
	return (record) => {
		logger.info(
			providerRunRecordLogPayload(record, runtimePhase),
			"LLM provider run recorded",
		);
	};
}

function findNearestWorkspaceRoot(startDir: string): string | null {
	let currentDir = startDir;

	while (true) {
		if (existsSync(join(currentDir, "pnpm-workspace.yaml"))) {
			return currentDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}
}

export function resolveWorkspaceRoot(startDir: string): string {
	return (
		findNearestWorkspaceRoot(startDir) ??
		findNearestWorkspaceRoot(process.cwd()) ??
		process.cwd()
	);
}

function resolveRuntimeMode(runtimeMode?: RuntimeMode): RuntimeMode {
	if (runtimeMode) {
		return runtimeMode;
	}

	const modeFromEnv = process.env.QUILIN_RUNTIME_MODE;
	if (modeFromEnv === "repl" || modeFromEnv === "service") {
		return modeFromEnv;
	}

	return process.stdin.isTTY && process.stderr.isTTY ? "repl" : "service";
}

function parseReplCliOptions(argv: readonly string[]): ReplCliOptions {
	let sessionId: string | undefined;
	let resumeLatest = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--resume") {
			const nextArg = argv[index + 1];
			if (nextArg == null || nextArg.startsWith("--")) {
				throw new Error("--resume requires a sessionId");
			}

			sessionId = nextArg;
			index += 1;
			continue;
		}

		if (arg === "--resume-latest") {
			resumeLatest = true;
		}
	}

	return { sessionId, resumeLatest };
}

function selectRuntimeModel(
	userConfig: UserConfigLoadResult,
	providerDefaultModel: string,
): RuntimeModelSelection {
	const userConfigDefaultModel = userConfig.config.llm.default_model;
	const userConfigDefaultModelSource =
		userConfig.sources["llm.default_model"] ?? "default";
	const useUserConfigModel = userConfigDefaultModelSource !== "default";

	return {
		modelId: useUserConfigModel ? userConfigDefaultModel : providerDefaultModel,
		source: useUserConfigModel ? "user_config" : "provider_default",
		providerDefaultModel,
		userConfigDefaultModel,
		userConfigDefaultModelSource,
	};
}

function isEnabledDefaultCatalogModel(model: string): boolean {
	return DEFAULT_PROVIDER_CATALOG.entries.some(
		(entry) => entry.status === "enabled" && entry.models.includes(model),
	);
}

function resolveRuntimeTierRoutingConfig(
	userConfig: UserConfigLoadResult,
	modelSelection: RuntimeModelSelection,
): LLMTierRoutingConfig {
	const routing = buildRuntimeTierRoutingConfig(userConfig.config);
	if (modelSelection.userConfigDefaultModelSource !== "default") {
		if (!isEnabledDefaultCatalogModel(modelSelection.modelId)) {
			throw new Error(
				`llm.default_model ${modelSelection.modelId} is providerless and not enabled in DEFAULT_PROVIDER_CATALOG; configure custom model ids under llm.tiers.<flash|lite|pro>.provider/model.`,
			);
		}
	}

	return routing;
}

function startupVerificationProfile(
	profile: LLMTierRoutingConfig["tiers"][LLMModelTier],
): LLMTierRoutingConfig["tiers"][LLMModelTier] {
	return {
		provider: profile.provider,
		model: profile.model,
		thinkingMode: profile.thinkingMode,
		temperature: STARTUP_VERIFICATION_CONFIG.temperature,
		maxTokens: STARTUP_VERIFICATION_CONFIG.maxTokens,
		...(profile.thinkingMode === "disabled" || profile.thinkingBudget == null
			? {}
			: { thinkingBudget: Math.min(profile.thinkingBudget, 512) }),
	};
}

function startupVerificationRoutingForTier(
	routing: LLMTierRoutingConfig,
	tier: LLMModelTier,
): LLMTierRoutingConfig {
	return {
		...routing,
		mode: tier,
		defaultTier: tier,
		tiers: {
			flash: startupVerificationProfile(routing.tiers.flash),
			lite: startupVerificationProfile(routing.tiers.lite),
			pro: startupVerificationProfile(routing.tiers.pro),
		},
	};
}

async function resolveReplSessionId(
	argv: readonly string[] = process.argv.slice(2),
): Promise<string | undefined> {
	const cliOptions = parseReplCliOptions(argv);
	if (cliOptions.sessionId != null) {
		return cliOptions.sessionId;
	}

	if (!cliOptions.resumeLatest) {
		return undefined;
	}

	const sessionId = (await new SQLiteCheckpoint().list())[0];
	if (sessionId == null) {
		logger.warn("No saved sessions found — starting a new session");
		return undefined;
	}

	return sessionId;
}

async function runServiceLoop(): Promise<void> {
	await new Promise<void>(() => {
		setInterval(() => {
			logger.debug("agent-core heartbeat");
		}, HEARTBEAT_INTERVAL_MS);
	});
}

async function verifyLLMConnection(
	provider: ReturnType<typeof createProvider>,
	providerId: LLMProviderId,
	modelId: string,
	tierRouting: LLMTierRoutingConfig | undefined,
	onProviderRunRecord: (record: ProviderRunRecord) => void,
): Promise<void> {
	const routingVariants =
		tierRouting == null
			? [undefined]
			: MODEL_TIERS.map((tier) =>
					startupVerificationRoutingForTier(tierRouting, tier),
				);

	for (const routingVariant of routingVariants) {
		const verificationClient = new ProviderControlPlaneLLMClient(
			new VercelLLMClient({
				model: provider(modelId),
				resolveModel: provider,
			}),
			{
				routeRequest: {
					provider: providerId,
					model: modelId,
				},
				...(routingVariant == null ? {} : { tierRouting: routingVariant }),
				onRunRecord: onProviderRunRecord,
			},
		);
		const response = await verificationClient.chat(
			[
				{
					role: "user",
					content: 'Reply with exactly: "Quilin Agent online." Nothing else.',
				},
			],
			[],
			STARTUP_VERIFICATION_CONFIG,
		);

		logger.info(
			{
				tier: routingVariant?.mode ?? "fixed",
				response: response.content.trim(),
				inputTokens: response.usage.inputTokens,
				outputTokens: response.usage.outputTokens,
			},
			"LLM connection verified",
		);
	}
}

export async function main(options: MainOptions = {}): Promise<void> {
	const runtimeMode = resolveRuntimeMode(options.runtimeMode);
	configureLogger(runtimeMode);

	const userRuntime = await bootstrapUserRuntime();
	logger.info(
		{
			version: "0.0.1",
			user_config: {
				file_path: userRuntime.result.filePath,
				log_level: userRuntime.result.config.observability.log_level,
				default_model: userRuntime.result.config.llm.default_model,
				safety_trust: userRuntime.result.config.safety.trust_mode,
			},
		},
		"Quilin Agent starting",
	);

	const provider = createProvider();
	const modelSelection = selectRuntimeModel(
		userRuntime.result,
		getDefaultModel(),
	);
	const modelId = modelSelection.modelId;
	const runtimeInferenceConfig = buildRuntimeInferenceConfig(
		userRuntime.result.config,
	);
	const runtimeToolFilter = buildRuntimeToolFilter(userRuntime.result.config);
	const runtimeWriteAuthorityMode = resolveRuntimeWriteAuthorityMode(
		userRuntime.result.config,
	);
	const runtimeTierRouting = resolveRuntimeTierRoutingConfig(
		userRuntime.result,
		modelSelection,
	);

	logger.info(
		{
			provider: DEFAULT_PROVIDER_ID,
			model: modelId,
			model_source: modelSelection.source,
			provider_default_model: modelSelection.providerDefaultModel,
			user_config_default_model: modelSelection.userConfigDefaultModel,
			user_config_default_model_source:
				modelSelection.userConfigDefaultModelSource,
			temperature: runtimeInferenceConfig.temperature,
			max_tokens: runtimeInferenceConfig.maxTokens,
			thinking_mode: runtimeInferenceConfig.thinkingMode,
			thinking_budget: runtimeInferenceConfig.thinkingBudget,
			routing_mode: runtimeTierRouting.mode,
			routing_default_tier: runtimeTierRouting.defaultTier,
			routing_allow_escalation: runtimeTierRouting.allowEscalation,
			routing_tiers: runtimeTierRouting.tiers,
		},
		"LLM provider initialized",
	);

	logger.info("Verifying LLM connection...");
	const logStartupProviderRunRecord = createProviderRunRecordLogger(
		"startup_verification",
	);

	try {
		await verifyLLMConnection(
			provider,
			DEFAULT_PROVIDER_ID,
			modelId,
			runtimeTierRouting,
			logStartupProviderRunRecord,
		);
	} catch (err) {
		logger.fatal(
			{ error: providerErrorLogFields(err) },
			"LLM connection failed",
		);
		process.exit(1);
	}

	if (runtimeMode === "repl") {
		const workspaceRoot = resolveWorkspaceRoot(
			dirname(fileURLToPath(import.meta.url)),
		);
		const capabilitiesHotReload = createCapabilitiesHotReloadController({
			workspaceRoot,
			argv: process.argv.slice(2),
			env: process.env,
			logEvent: logCapabilitiesHotReloadEvent,
		});
		await capabilitiesHotReload.bootstrap();
		const sessionId = await resolveReplSessionId();
		let shouldExit = false;

		logger.info({ mode: "repl" }, "Starting CLI REPL...");

		try {
			await startRepl({
				provider,
				providerId: DEFAULT_PROVIDER_ID,
				modelId,
				...(sessionId == null ? {} : { sessionId }),
				observability: {
					spans: userRuntime.spanProvider,
					...(sessionId == null ? {} : { sessionId }),
				},
				spanExporter: new JsonFileSpanExporter(),
				capabilitiesRuntime: () => capabilitiesHotReload.getRuntime(),
				capabilitiesStatus: () => capabilitiesHotReload.getStatus(),
				inferenceConfig: runtimeInferenceConfig,
				tierRouting: runtimeTierRouting,
				writeAuthorityMode: runtimeWriteAuthorityMode,
				toolFilter: runtimeToolFilter,
				onProviderRunRecord: createProviderRunRecordLogger("repl_turn"),
				onMcpReconnectApplied: () =>
					capabilitiesHotReload.markMcpReconnectAppliedAtReplTurnBoundary(),
			});
			shouldExit = true;
		} finally {
			capabilitiesHotReload.dispose();
		}

		if (shouldExit) {
			process.exit(0);
			return;
		}
	}

	logger.info({ mode: "service" }, "Starting agent-core service loop...");
	await (options.serviceRunner ?? runServiceLoop)();
}

async function dispatchCli(argv: readonly string[]): Promise<void> {
	if (argv[0] === "config") {
		const result = await runConfigCommand(argv.slice(1));
		if (result.stdout.length > 0) {
			process.stdout.write(result.stdout);
		}
		if (result.stderr.length > 0) {
			process.stderr.write(result.stderr);
		}
		process.exit(result.exitCode);
	}
	await main();
}

if (import.meta.main) {
	dispatchCli(process.argv.slice(2)).catch((err) => {
		logger.fatal({ error: providerErrorLogFields(err) }, "Unexpected error");
		process.exit(1);
	});
}
