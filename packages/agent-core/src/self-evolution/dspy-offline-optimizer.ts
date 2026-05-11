import { logger } from "../logger.js";
import { analyzeTrajectoryFailures } from "./failure-analyzer.js";
import { createArtifactHash, createStableRef } from "./hash.js";
import {
	normalizeEvidenceRefs,
	sanitizeForSelfEvolution,
	sanitizeSelfEvolutionString,
} from "./sanitize.js";
import {
	type CandidateArtifact,
	type CandidateArtifactKind,
	type FailureAnalysis,
	type JsonRecord,
	type JsonValue,
	type NoProposalReason,
	type NoProposalReasonCode,
	type OfflineOptimizer,
	type OfflineOptimizerInput,
	type OfflineOptimizerResult,
	type OptimizationProposalDraft,
	type ProposalRiskLevel,
	type ProposalRiskPreview,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredTrajectoryRecord,
} from "./types.js";

/**
 * Optimizer id reported by the DSPy/GEPA-backed offline optimizer.
 *
 * The TS DspyOfflineOptimizer talks to the Python `providers/optimizer`
 * MCP server. Stage A returns a deterministic stub; Stage C will swap in
 * a real DSPy compilation pipeline without changing this id.
 *
 * TS 端 DspyOfflineOptimizer 通过 MCP 调用 Python `providers/optimizer`。
 * Stage A 返回确定性占位；Stage C 在保持本 id 不变的前提下接入真实
 * DSPy 编译流程。
 */
export const DSPY_OFFLINE_OPTIMIZER_ID = "dspy" as const;

/**
 * Minimal MCP client surface DspyOfflineOptimizer relies on. We do NOT
 * import `MCPClientManager` directly so tests can inject a tiny fake
 * without spawning a real subprocess.
 *
 * DspyOfflineOptimizer 仅依赖最小 MCP 客户端表面。我们不直接 import
 * `MCPClientManager`，方便测试注入轻量 fake，避免起真实子进程。
 */
export interface DspyOptimizerMCPClient {
	callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * Tool name exposed by the Python placeholder server. Mirrors
 * `providers/optimizer/src/quilin_optimizer/server.py` and stays stable
 * across Stage A / Stage C swaps.
 *
 * Python 占位服务暴露的工具名。与
 * `providers/optimizer/src/quilin_optimizer/server.py` 保持一致，
 * Stage A → Stage C 切换时不会变。
 */
export const DSPY_OPTIMIZE_TOOL_NAME = "optimize" as const;

const ALLOWED_RISK_LEVELS = new Set<ProposalRiskLevel>([
	"low",
	"medium",
	"high",
	"critical",
]);

const ALLOWED_NO_PROPOSAL_REASON_CODES = new Set<NoProposalReasonCode>([
	"no_failure_detected",
	"missing_evidence_requires_human_context",
	"missing_task_ref_requires_linear_issue",
	"budget_policy_requires_human_review",
	"unknown_failure_not_actionable",
	"insufficient_signal",
]);

const ALLOWED_ARTIFACT_KINDS = new Set<CandidateArtifactKind>([
	"markdown",
	"json",
	"patch",
]);

export interface DspyOfflineOptimizerOptions {
	readonly client: DspyOptimizerMCPClient;
	readonly now?: () => Date;
	/**
	 * Tool name to invoke. Defaults to `optimize` — the only tool the
	 * Python optimizer server exposes after the GEPA-only refactor.
	 *
	 * 调用的工具名。默认 `optimize` —— GEPA-only 重构后 optimizer server
	 * 只暴露这一个工具。
	 */
	readonly toolName?: string;
}

interface DspyToolPayload {
	readonly schema_version?: unknown;
	readonly optimizer_id?: unknown;
	readonly mode?: unknown;
	readonly created_at?: unknown;
	readonly proposals?: unknown;
	readonly no_proposal_reasons?: unknown;
	readonly error?: unknown;
}

/**
 * Error thrown when the MCP server returns an unexpected payload that
 * cannot be reconciled with the OfflineOptimizerResult contract.
 *
 * 当 MCP 服务返回无法对齐 OfflineOptimizerResult 契约的负载时抛出。
 */
export class DspyOptimizerProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DspyOptimizerProtocolError";
	}
}

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((item): item is string => typeof item === "string")
	);
}

function asStringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asJsonRecord(value: unknown): JsonRecord | undefined {
	if (value == null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	// Trust sanitize-on-read: callers feed the parsed JSON dict through
	// sanitizeForSelfEvolution before storing, so any redaction happens
	// downstream of this cast.
	return value as JsonRecord;
}

function asArrayOrEmpty(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function buildTrajectoryPayload(
	trajectory: StoredTrajectoryRecord,
): Record<string, JsonValue> {
	return {
		trajectoryRef: trajectory.trajectoryRef,
		runId: trajectory.runId,
		// taskRef may be undefined in the input record; convert to null so
		// the Python side sees a JSON-null instead of a missing key.
		// taskRef 在输入轨迹中可能缺失；用 null 显式占位，避免 Python 端拿到键缺失。
		taskRef: trajectory.taskRef ?? null,
	};
}

function collectFailureCategories(
	analyses: readonly FailureAnalysis[],
): readonly string[] {
	const categories = new Set<string>();
	for (const analysis of analyses) {
		for (const finding of analysis.findings) {
			categories.add(finding.category);
		}
	}
	return [...categories].sort();
}

function decodeArtifact(raw: unknown): CandidateArtifact | null {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const kindRaw = record.kind;
	const kind: CandidateArtifactKind =
		typeof kindRaw === "string" &&
		ALLOWED_ARTIFACT_KINDS.has(kindRaw as CandidateArtifactKind)
			? (kindRaw as CandidateArtifactKind)
			: "json";
	const titleRaw = asStringOrUndefined(record.title) ?? "DSPy artifact";
	const contentRaw = asStringOrUndefined(record.content) ?? "";
	const sourceRefsRaw = isStringArray(record.sourceRefs)
		? record.sourceRefs
		: [];
	const sanitizedTitle = sanitizeSelfEvolutionString(titleRaw);
	const sanitizedContent = String(sanitizeForSelfEvolution(contentRaw));
	const sanitizedSourceRefs = normalizeEvidenceRefs(sourceRefsRaw);
	const contentHash = createArtifactHash(sanitizedContent);
	const artifactIdRaw = asStringOrUndefined(record.artifactId);
	const artifactId =
		artifactIdRaw && artifactIdRaw.length > 0
			? sanitizeSelfEvolutionString(artifactIdRaw)
			: createStableRef("artifact", [kind, sanitizedTitle, contentHash]);
	return {
		artifactId,
		kind,
		title: sanitizedTitle,
		content: sanitizedContent,
		contentHash,
		sourceRefs: sanitizedSourceRefs,
	};
}

function decodeRiskPreview(raw: unknown): ProposalRiskPreview {
	const record =
		raw != null && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const levelRaw = record.level;
	const level: ProposalRiskLevel =
		typeof levelRaw === "string" &&
		ALLOWED_RISK_LEVELS.has(levelRaw as ProposalRiskLevel)
			? (levelRaw as ProposalRiskLevel)
			: "medium";
	const reasonsRaw = isStringArray(record.reasons) ? record.reasons : [];
	const reasons = reasonsRaw.map((reason) =>
		sanitizeSelfEvolutionString(reason),
	);
	return {
		level,
		reasons,
		touchesRuntime: record.touchesRuntime === true,
		requiresHumanReview: true,
	};
}

function decodeProposal(raw: unknown): OptimizationProposalDraft | null {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const titleRaw = asStringOrUndefined(record.title);
	const summaryRaw = asStringOrUndefined(record.summary);
	if (titleRaw == null || summaryRaw == null) {
		return null;
	}
	const artifactsRaw = asArrayOrEmpty(record.artifacts);
	const artifacts: CandidateArtifact[] = [];
	for (const item of artifactsRaw) {
		const artifact = decodeArtifact(item);
		if (artifact != null) {
			artifacts.push(artifact);
		}
	}
	const evidenceHashesRaw = isStringArray(record.evidenceHashes)
		? record.evidenceHashes
		: artifacts.map((artifact) => artifact.contentHash);
	const metadataRaw = asJsonRecord(record.metadata);
	const sanitizedMetadata =
		metadataRaw == null
			? undefined
			: (sanitizeForSelfEvolution(metadataRaw) as JsonRecord);
	return {
		title: sanitizeSelfEvolutionString(titleRaw),
		summary: sanitizeSelfEvolutionString(summaryRaw),
		artifacts,
		evidenceHashes: evidenceHashesRaw.map((hash) =>
			sanitizeSelfEvolutionString(hash),
		),
		riskPreview: decodeRiskPreview(record.riskPreview),
		...(sanitizedMetadata == null ? {} : { metadata: sanitizedMetadata }),
	};
}

function decodeNoProposalReason(raw: unknown): NoProposalReason | null {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const codeRaw = record.code;
	const messageRaw = asStringOrUndefined(record.message);
	if (
		typeof codeRaw !== "string" ||
		!ALLOWED_NO_PROPOSAL_REASON_CODES.has(codeRaw as NoProposalReasonCode) ||
		messageRaw == null
	) {
		return null;
	}
	const evidenceRefsRaw = isStringArray(record.evidenceRefs)
		? record.evidenceRefs
		: [];
	return {
		code: codeRaw as NoProposalReasonCode,
		message: sanitizeSelfEvolutionString(messageRaw),
		evidenceRefs: normalizeEvidenceRefs(evidenceRefsRaw),
	};
}

function detectErrorPayload(payload: DspyToolPayload): string | null {
	const errorValue = payload.error;
	if (errorValue == null) {
		return null;
	}
	if (typeof errorValue === "string") {
		return sanitizeSelfEvolutionString(errorValue);
	}
	if (typeof errorValue === "object") {
		const message = (errorValue as Record<string, unknown>).message;
		if (typeof message === "string") {
			return sanitizeSelfEvolutionString(message);
		}
	}
	return "DSPy optimizer returned an error";
}

function parseToolResponse(raw: string): DspyToolPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new DspyOptimizerProtocolError(
			`DSPy optimizer returned non-JSON payload: ${(error as Error).message}`,
		);
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new DspyOptimizerProtocolError(
			"DSPy optimizer payload must be a JSON object",
		);
	}
	return parsed as DspyToolPayload;
}

function emptyResultWithReason(
	createdAt: string,
	code: NoProposalReasonCode,
	message: string,
): OfflineOptimizerResult {
	return {
		schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
		optimizerId: DSPY_OFFLINE_OPTIMIZER_ID,
		mode: "prompt_optimization",
		createdAt,
		proposals: [],
		noProposalReasons: [
			{
				code,
				message,
				evidenceRefs: [],
			},
		],
	};
}

function assertOptimizeRequest(input: OfflineOptimizerInput): void {
	if (input === null || typeof input !== "object") {
		throw new TypeError("OfflineOptimizerInput must be an object");
	}
	if (!Array.isArray(input.trajectories)) {
		throw new TypeError("OfflineOptimizerInput.trajectories must be an array");
	}
	if (input.analyses !== undefined && !Array.isArray(input.analyses)) {
		throw new TypeError("OfflineOptimizerInput.analyses must be an array");
	}
	if (input.now !== undefined && typeof input.now !== "function") {
		throw new TypeError("OfflineOptimizerInput.now must be a function");
	}
	if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
		throw new TypeError("OfflineOptimizerInput.dryRun must be a boolean");
	}
}

/**
 * DspyOfflineOptimizer is the TS-side adapter for the Python
 * `providers/optimizer` MCP server. It serializes trajectories +
 * failure categories, calls the `optimize` tool, and decodes the
 * response into `OptimizationProposalDraft[]` after running every
 * string field through the project's self-evolution sanitizer.
 *
 * Stage A: the underlying Python tool returns a deterministic stub.
 * Stage C: same surface, real DSPy/GEPA prompt-optimization output.
 *
 * DspyOfflineOptimizer 是 Python `providers/optimizer` MCP 服务的 TS
 * 适配层。它将 trajectories + failure categories 序列化、调用
 * `optimize` 工具、再把响应解码成 `OptimizationProposalDraft[]`，
 * 期间所有字符串字段都经过项目内 self-evolution sanitizer。
 *
 * Stage A 阶段 Python 工具返回确定性占位；Stage C 在保持外部表面不变
 * 的情况下接入真实 DSPy/GEPA 优化输出。
 */
export class DspyOfflineOptimizer implements OfflineOptimizer {
	readonly optimizerId = DSPY_OFFLINE_OPTIMIZER_ID;
	private readonly client: DspyOptimizerMCPClient;
	private readonly now: () => Date;
	private readonly toolName: string;

	constructor(options: DspyOfflineOptimizerOptions) {
		if (options.client == null) {
			throw new TypeError("DspyOfflineOptimizer requires an MCP client");
		}
		this.client = options.client;
		this.now = options.now ?? (() => new Date());
		this.toolName = options.toolName ?? DSPY_OPTIMIZE_TOOL_NAME;
	}

	async optimize(
		input: OfflineOptimizerInput,
	): Promise<OfflineOptimizerResult> {
		assertOptimizeRequest(input);
		const createdAt = (input.now ?? this.now)().toISOString();

		if (input.trajectories.length === 0) {
			return emptyResultWithReason(
				createdAt,
				"no_failure_detected",
				"DspyOfflineOptimizer received no trajectories; nothing to optimize.",
			);
		}

		const providedAnalyses = new Map(
			(input.analyses ?? []).map(
				(analysis) => [analysis.trajectoryRef, analysis] as const,
			),
		);
		const analyses: FailureAnalysis[] = input.trajectories.map(
			(trajectory) =>
				providedAnalyses.get(trajectory.trajectoryRef) ??
				analyzeTrajectoryFailures(trajectory),
		);
		const failureCategories = collectFailureCategories(analyses);
		const trajectoriesPayload = input.trajectories.map(buildTrajectoryPayload);

		const args: Record<string, unknown> = {
			trajectories: trajectoriesPayload,
			failure_categories: failureCategories,
			dry_run: input.dryRun === true,
		};

		let raw: string;
		try {
			raw = await this.client.callTool(this.toolName, args);
		} catch (error) {
			logger.warn(
				{
					optimizerId: DSPY_OFFLINE_OPTIMIZER_ID,
					tool: this.toolName,
					err: error,
				},
				"DspyOfflineOptimizer: MCP callTool threw — returning empty result",
			);
			throw error instanceof Error
				? error
				: new Error("DspyOfflineOptimizer: MCP callTool failed");
		}

		const payload = parseToolResponse(raw);
		const errorMessage = detectErrorPayload(payload);
		if (errorMessage != null) {
			throw new DspyOptimizerProtocolError(errorMessage);
		}

		const proposalsRaw = asArrayOrEmpty(payload.proposals);
		const proposals: OptimizationProposalDraft[] = [];
		for (const item of proposalsRaw) {
			const proposal = decodeProposal(item);
			if (proposal != null) {
				proposals.push(proposal);
			}
		}

		const reasonsRaw = asArrayOrEmpty(payload.no_proposal_reasons);
		const noProposalReasons: NoProposalReason[] = [];
		for (const item of reasonsRaw) {
			const reason = decodeNoProposalReason(item);
			if (reason != null) {
				noProposalReasons.push(reason);
			}
		}

		return {
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			optimizerId: DSPY_OFFLINE_OPTIMIZER_ID,
			mode: "prompt_optimization",
			createdAt,
			proposals,
			noProposalReasons,
		};
	}
}
