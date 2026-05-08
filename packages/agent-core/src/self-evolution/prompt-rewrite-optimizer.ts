import { analyzeTrajectoryFailures } from "./failure-analyzer.js";
import {
	createArtifactHash,
	createStableHash,
	createStableRef,
} from "./hash.js";
import {
	normalizeEvidenceRefs,
	sanitizeForSelfEvolution,
	sanitizeSelfEvolutionString,
} from "./sanitize.js";
import {
	type CandidateArtifact,
	type FailureAnalysis,
	type FailureCategory,
	type FailureFinding,
	type NoProposalReason,
	type OfflineOptimizer,
	type OfflineOptimizerInput,
	type OfflineOptimizerResult,
	type OptimizationProposalDraft,
	PROMPT_REWRITE_OPTIMIZER_ID,
	type ProposalRiskPreview,
	SELF_EVOLUTION_SCHEMA_VERSION,
	type StoredTrajectoryRecord,
} from "./types.js";

/**
 * PromptRewriteOptimizer turns recent failure trajectories into native TS
 * prompt-rewrite candidates. It is a heuristic, dependency-free skeleton of
 * the DSPy/GEPA-style optimization loop described in
 * docs/10-self-evolution/README.md — clustering similar failures, generating
 * remediation guidance, and emitting `proposal_only` artifacts that a human
 * must review before any prompt or scaffold change is applied.
 *
 * PromptRewriteOptimizer 把最近的失败轨迹转换成 native TS 的 prompt 重写候选。
 * 它是 docs/10-self-evolution/README.md 中描述的 DSPy/GEPA 风格优化环的启发式、
 * 零依赖骨架——按相似失败聚类、生成修复指引，并产出 `proposal_only` 工件，
 * 任何 prompt 或脚手架变更必须由人工审核后方可应用。
 *
 * 关键约束 / Hard constraints:
 * - 不调用 LLM、不访问网络、不写入文件（只产 proposal）。
 * - 不生成 `generatedPatchProposal`（避免 scaffold patch 路径校验）：
 *   prompt 优化候选作为 markdown / json artifact 暴露给评审者，
 *   后续真正的 LLM 驱动 GEPA / DSPy 实现放在 Phase 1+。
 */

export interface PromptRewriteOptimizerOptions {
	readonly now?: () => Date;
	/**
	 * 最少的同类 failure 数量，达到该阈值才生成一个 prompt-rewrite 候选。
	 * Minimum number of failures in a single category required to emit a
	 * prompt-rewrite candidate.
	 */
	readonly minClusterSize?: number;
	/**
	 * Maximum number of prompt-rewrite candidates emitted per `optimize()` call.
	 * Caps fan-out so a single noisy session cannot flood the proposal store.
	 *
	 * 单次 optimize 调用最多产出多少个 prompt-rewrite 候选，避免噪声轨迹刷爆 store。
	 */
	readonly maxCandidates?: number;
}

const DEFAULT_MIN_CLUSTER_SIZE = 1;
const DEFAULT_MAX_CANDIDATES = 5;

interface FailureCluster {
	readonly category: FailureCategory;
	readonly findings: readonly FailureFinding[];
	readonly trajectoryRefs: readonly string[];
	readonly trajectoryByRef: ReadonlyMap<string, StoredTrajectoryRecord>;
}

const CATEGORY_REWRITE_GUIDANCE: Readonly<
	Record<FailureCategory, { readonly guidance: string; readonly hint: string }>
> = {
	tool_error: {
		guidance:
			"Add an explicit pre-flight check before invoking the failing tool. The system prompt should remind the agent to verify required arguments, working directory and environment before issuing the call.",
		hint: "Wrap the failing tool call with a pre-condition checklist before retrying.",
	},
	schema_violation: {
		guidance:
			"Reinforce schema fidelity in the system prompt: instruct the agent to (1) restate the expected JSON shape, (2) refuse to invent fields not present in the schema, and (3) emit fallback values matching the schema rather than free-form text on uncertainty.",
		hint: "Show the agent the schema once more and require restatement before output.",
	},
	budget_exhaustion: {
		guidance:
			"Inject a budget-aware reasoning rule: instruct the agent to prefer a smaller intermediate plan, summarise prior context, or escalate to a human before exceeding the token budget. This is a candidate only — budget tradeoffs require explicit human review.",
		hint: "Encourage early summarisation when token usage trends towards the budget cap.",
	},
	missing_evidence: {
		guidance:
			"Update the prompt to require explicit citations: every claim should reference an evidenceRef from the trajectory, and the agent must refuse to assert without one. Missing evidence findings remain non-actionable until human context is added.",
		hint: "Force evidence-backed claims; forbid uncited assertions.",
	},
	unknown: {
		guidance:
			"No deterministic remediation pattern matched this category. Capture the failure for human triage and gather more evidence before proposing a rewrite.",
		hint: "Triage manually; gather more evidence.",
	},
};

/**
 * Allocate failures by category, attaching the trajectory each finding belongs
 * to. We never mutate the input arrays — every step returns a new structure.
 *
 * 按 category 聚类失败 finding，并保留每个 finding 所属轨迹的引用。
 * 每一步都返回新结构，绝不修改输入数组。
 */
function clusterFailures(
	trajectories: readonly StoredTrajectoryRecord[],
	analyses: readonly FailureAnalysis[],
): readonly FailureCluster[] {
	const trajectoryByRef = new Map<string, StoredTrajectoryRecord>();
	for (const trajectory of trajectories) {
		trajectoryByRef.set(trajectory.trajectoryRef, trajectory);
	}

	const findingsByCategory = new Map<
		FailureCategory,
		{ findings: FailureFinding[]; trajectoryRefs: Set<string> }
	>();
	for (const analysis of analyses) {
		for (const finding of analysis.findings) {
			let bucket = findingsByCategory.get(finding.category);
			if (bucket === undefined) {
				bucket = { findings: [], trajectoryRefs: new Set<string>() };
				findingsByCategory.set(finding.category, bucket);
			}
			bucket.findings.push(finding);
			bucket.trajectoryRefs.add(analysis.trajectoryRef);
		}
	}

	const clusters: FailureCluster[] = [];
	for (const [category, bucket] of findingsByCategory.entries()) {
		clusters.push({
			category,
			findings: bucket.findings,
			trajectoryRefs: [...bucket.trajectoryRefs],
			trajectoryByRef,
		});
	}
	// Stable order: highest count first, then lexicographic by category.
	clusters.sort((left, right) => {
		const sizeOrder = right.findings.length - left.findings.length;
		if (sizeOrder !== 0) {
			return sizeOrder;
		}
		return left.category.localeCompare(right.category);
	});
	return clusters;
}

function createCandidateArtifact(
	kind: CandidateArtifact["kind"],
	title: string,
	content: string,
	sourceRefs: readonly string[],
): CandidateArtifact {
	const sanitizedContent = String(sanitizeForSelfEvolution(content));
	const sanitizedSourceRefs = normalizeEvidenceRefs(sourceRefs);
	const contentHash = createArtifactHash(sanitizedContent);
	return {
		artifactId: createStableRef("artifact", [kind, title, contentHash]),
		kind,
		title,
		content: sanitizedContent,
		contentHash,
		sourceRefs: sanitizedSourceRefs,
	};
}

function buildRiskPreview(cluster: FailureCluster): ProposalRiskPreview {
	return {
		level: "medium",
		reasons: [
			"Prompt-rewrite candidate is a review-only artifact and must not be applied automatically.",
			`Failure category covered by the candidate: ${cluster.category}.`,
			`Trajectories aggregated into the candidate: ${cluster.trajectoryRefs.length}.`,
		],
		touchesRuntime: false,
		requiresHumanReview: true,
	};
}

interface PromptRewriteCandidate {
	readonly category: FailureCategory;
	readonly clusterSize: number;
	readonly trajectoryRefs: readonly string[];
	readonly guidance: string;
	readonly hint: string;
	readonly evidenceRefs: readonly string[];
	readonly estimatedFailureReduction: number;
}

function estimateFailureReduction(cluster: FailureCluster): number {
	// Heuristic: assume each high-confidence finding contributes 0.4, medium 0.2,
	// low 0.1 of remediation potential, capped at 0.9. Static estimate only —
	// real before/after measurement happens in Phase 1+ when a benchmark is wired.
	let score = 0;
	for (const finding of cluster.findings) {
		if (finding.confidence === "high") {
			score += 0.4;
		} else if (finding.confidence === "medium") {
			score += 0.2;
		} else {
			score += 0.1;
		}
	}
	return Math.min(0.9, Number(score.toFixed(2)));
}

function buildCandidate(cluster: FailureCluster): PromptRewriteCandidate {
	const guidanceEntry = CATEGORY_REWRITE_GUIDANCE[cluster.category];
	const evidenceRefs = normalizeEvidenceRefs([
		...cluster.trajectoryRefs,
		...cluster.findings.flatMap((finding) => finding.evidenceRefs),
	]);
	return {
		category: cluster.category,
		clusterSize: cluster.findings.length,
		trajectoryRefs: cluster.trajectoryRefs,
		guidance: guidanceEntry.guidance,
		hint: guidanceEntry.hint,
		evidenceRefs,
		estimatedFailureReduction: estimateFailureReduction(cluster),
	};
}

function buildArtifacts(
	candidate: PromptRewriteCandidate,
): readonly CandidateArtifact[] {
	const sourceRefs = candidate.evidenceRefs;
	const markdown = [
		`# Prompt rewrite candidate for ${candidate.category}`,
		"",
		"## Cluster summary",
		`- Failures clustered: ${candidate.clusterSize}`,
		`- Trajectories covered: ${candidate.trajectoryRefs.length}`,
		`- Estimated failure-rate reduction (heuristic, static): ${candidate.estimatedFailureReduction}`,
		"",
		"## Suggested prompt rewrite guidance",
		candidate.guidance,
		"",
		"## Reviewer hint",
		candidate.hint,
		"",
		"## Boundary",
		"This candidate is artifact-only. The optimizer cannot rewrite a prompt or scaffold automatically — a human reviewer must transcribe the guidance into the live prompt.",
	].join("\n");
	const json = JSON.stringify(
		{
			category: candidate.category,
			clusterSize: candidate.clusterSize,
			trajectoryRefs: candidate.trajectoryRefs,
			estimatedFailureReduction: candidate.estimatedFailureReduction,
			guidance: candidate.guidance,
			hint: candidate.hint,
			evidenceRefs: candidate.evidenceRefs,
		},
		null,
		2,
	);
	return [
		createCandidateArtifact(
			"markdown",
			`Prompt rewrite proposal — ${candidate.category}`,
			markdown,
			sourceRefs,
		),
		createCandidateArtifact(
			"json",
			`Prompt rewrite payload — ${candidate.category}`,
			json,
			sourceRefs,
		),
	];
}

function buildProposal(
	candidate: PromptRewriteCandidate,
): OptimizationProposalDraft | null {
	if (candidate.evidenceRefs.length === 0) {
		return null;
	}
	const cluster: FailureCluster = {
		category: candidate.category,
		findings: [],
		trajectoryRefs: candidate.trajectoryRefs,
		trajectoryByRef: new Map(),
	};
	const artifacts = buildArtifacts(candidate);
	const evidenceHashes = [
		createStableHash({
			category: candidate.category,
			clusterSize: candidate.clusterSize,
			estimatedFailureReduction: candidate.estimatedFailureReduction,
			trajectoryRefs: candidate.trajectoryRefs,
			evidenceRefs: candidate.evidenceRefs,
		}),
	];
	const sanitizedCategory = sanitizeSelfEvolutionString(candidate.category);
	return {
		title: `Prompt rewrite candidate for ${sanitizedCategory}`,
		summary:
			"Heuristic prompt-rewrite candidate clustered from recent failure trajectories. Review-only — a human must transcribe any change into the live prompt.",
		artifacts,
		evidenceHashes,
		riskPreview: buildRiskPreview(cluster),
		metadata: {
			optimizer_id: PROMPT_REWRITE_OPTIMIZER_ID,
			failure_category: sanitizedCategory,
			cluster_size: candidate.clusterSize,
			estimated_failure_reduction: candidate.estimatedFailureReduction,
			trajectory_refs: [...candidate.trajectoryRefs],
			application_mode: "proposal_only",
		},
	};
}

function unsupportedCategoryReason(cluster: FailureCluster): NoProposalReason {
	return {
		code: "unknown_failure_not_actionable",
		message: `PromptRewriteOptimizer does not have a deterministic rewrite template for category ${cluster.category}.`,
		evidenceRefs: normalizeEvidenceRefs(cluster.trajectoryRefs),
	};
}

function insufficientClusterReason(
	cluster: FailureCluster,
	minClusterSize: number,
): NoProposalReason {
	return {
		code: "insufficient_signal",
		message: `Prompt-rewrite candidate requires at least ${minClusterSize} clustered findings for ${cluster.category}.`,
		evidenceRefs: normalizeEvidenceRefs(cluster.trajectoryRefs),
	};
}

function emptyTrajectoryReason(): NoProposalReason {
	return {
		code: "no_failure_detected",
		message:
			"No trajectories were provided to PromptRewriteOptimizer; nothing to optimize.",
		evidenceRefs: [],
	};
}

function noFindingsReason(
	trajectory: StoredTrajectoryRecord,
): NoProposalReason {
	return {
		code: "no_failure_detected",
		message:
			"PromptRewriteOptimizer could not extract failure findings from the trajectory.",
		evidenceRefs: normalizeEvidenceRefs([trajectory.trajectoryRef]),
	};
}

function ensurePositiveInteger(value: number, field: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new TypeError(`${field} must be a positive integer`);
	}
	return value;
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

export class PromptRewriteOptimizer implements OfflineOptimizer {
	readonly optimizerId = PROMPT_REWRITE_OPTIMIZER_ID;
	private readonly now: () => Date;
	private readonly minClusterSize: number;
	private readonly maxCandidates: number;

	constructor(options: PromptRewriteOptimizerOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.minClusterSize = ensurePositiveInteger(
			options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE,
			"PromptRewriteOptimizer.minClusterSize",
		);
		this.maxCandidates = ensurePositiveInteger(
			options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
			"PromptRewriteOptimizer.maxCandidates",
		);
	}

	async optimize(
		input: OfflineOptimizerInput,
	): Promise<OfflineOptimizerResult> {
		assertOptimizeRequest(input);
		const createdAt = (input.now ?? this.now)().toISOString();

		if (input.trajectories.length === 0) {
			return {
				schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
				optimizerId: this.optimizerId,
				mode: "prompt_rewrite",
				createdAt,
				proposals: [],
				noProposalReasons: [emptyTrajectoryReason()],
			};
		}

		const providedAnalyses = new Map(
			(input.analyses ?? []).map(
				(analysis) => [analysis.trajectoryRef, analysis] as const,
			),
		);
		const noProposalReasons: NoProposalReason[] = [];
		const analyses: FailureAnalysis[] = input.trajectories.map((trajectory) => {
			const analysis =
				providedAnalyses.get(trajectory.trajectoryRef) ??
				analyzeTrajectoryFailures(trajectory);
			if (analysis.findings.length === 0) {
				noProposalReasons.push(noFindingsReason(trajectory));
			}
			return analysis;
		});

		const clusters = clusterFailures(input.trajectories, analyses);
		const proposals: OptimizationProposalDraft[] = [];
		for (const cluster of clusters) {
			if (proposals.length >= this.maxCandidates) {
				break;
			}
			if (cluster.category === "unknown") {
				noProposalReasons.push(unsupportedCategoryReason(cluster));
				continue;
			}
			if (cluster.findings.length < this.minClusterSize) {
				noProposalReasons.push(
					insufficientClusterReason(cluster, this.minClusterSize),
				);
				continue;
			}
			const candidate = buildCandidate(cluster);
			const proposal = buildProposal(candidate);
			if (proposal === null) {
				continue;
			}
			proposals.push(proposal);
		}

		return {
			schemaVersion: SELF_EVOLUTION_SCHEMA_VERSION,
			optimizerId: this.optimizerId,
			mode: "prompt_rewrite",
			createdAt,
			proposals,
			noProposalReasons,
		};
	}
}

/**
 * Internal helper exposed for tests: returns the heuristic estimate for a list
 * of findings. Kept private to the package so call sites can verify metric
 * estimation without reaching into the optimizer instance.
 *
 * 内部 helper：仅供测试，按 finding 列表算启发式评分。保持包内可见，
 * 测试可直接验证 metric estimation 而不必构造完整的 optimizer 实例。
 */
export function estimatePromptRewriteFailureReduction(
	findings: readonly FailureFinding[],
): number {
	return estimateFailureReduction({
		category: "unknown",
		findings,
		trajectoryRefs: [],
		trajectoryByRef: new Map(),
	});
}
