import { describe, expect, it } from "vitest";
import type {
	AuditAgreementMetrics,
	BudgetDecision,
	BudgetLedgerInput,
	DagPlan,
	DagValidationResult,
	DecomposeResult,
	DelegationDecision,
	GlobalPlanPatch,
	GlobalReplanRateMetrics,
	GoalDriftDecision,
	IntentClassification,
	LinearPlan,
	LLMPlannerResponse,
	LocalPlanPatch,
	PlannerAuditObservation,
	PlanningEvent,
	PlanningStrategy,
	PlanReviewRecord,
	PlanReviewWriteResult,
	ProductionRouteDelegationHandoffPlan,
	ProductionRouteExplanationBatchSummary,
	ProductionRouteScoreBatch,
	ProductionRouteScoreBatchReadiness,
	ProductionRouteScoreBatchReadinessSummary,
	StrategySelection,
	SubTask,
	SubtreeReplacementResult,
	TerminationDecision,
} from "./index.js";
import {
	applyGlobalReplan,
	applyLocalRearrange,
	buildPlanContext,
	buildProductionRouteDelegationHandoffPlan,
	classifyIntent,
	classifyProductionRouteScoreBatchReadiness,
	computeAuditAgreement,
	computeGlobalReplanRate,
	consumeBudget,
	createBudgetLedger,
	createGoalDriftEvent,
	createPlanReviewMemoryItem,
	DEFAULT_AUDIT_CONFIDENCE_THRESHOLD,
	DEFAULT_GOAL_DRIFT_THRESHOLD,
	decomposePlan,
	deriveStructuralIntent,
	detectGoalDrift,
	detectTermination,
	dispatchIntent,
	evaluateBudget,
	evaluateDelegation,
	linearPlanToDag,
	observePlannerAudit,
	PLAN_REVIEW_SCHEMA_VERSION,
	PLAN_REVIEW_SOURCE,
	RuleBasedStrategySelector,
	replacePlanSubtree,
	replayPlanningEvents,
	StructuralIntentClassifier,
	scoreProductionRoutes,
	selectPlanningStrategy,
	summarizeProductionRouteScoreBatchReadiness,
	summarizeProductionRouteScores,
	toReplanEventPayload,
	validateDagPlan,
	validatePlanReviewRecord,
	writePlanReviewRecord,
} from "./index.js";

function makeStep(id: string, overrides: Partial<SubTask> = {}): SubTask {
	return {
		id,
		action: overrides.action ?? "tool",
		name: overrides.name ?? `Step ${id}`,
		description: overrides.description ?? `Execute ${id}`,
		estimatedTokens: overrides.estimatedTokens ?? 120,
		estimatedSteps: overrides.estimatedSteps ?? 1,
		preconditions: overrides.preconditions ?? [],
		effects: overrides.effects ?? [`effect:${id}`],
		skillHint: overrides.skillHint,
		arguments: overrides.arguments,
		depth: overrides.depth,
		writeScope: overrides.writeScope ?? "working",
		risk: overrides.risk ?? "low",
	};
}

function makeLinearPlan(stepIds: readonly string[]): LinearPlan {
	return {
		kind: "linear",
		subtasks: stepIds.map((id) => makeStep(id)),
	};
}

describe("planning barrel contract", () => {
	it("exports DAG conversion and validation helpers", () => {
		const linearPlan = makeLinearPlan(["collect", "analyze", "publish"]);
		const dagPlan: DagPlan = linearPlanToDag(linearPlan);
		const validation: DagValidationResult = validateDagPlan(dagPlan);

		expect(dagPlan).toEqual({
			kind: "dag",
			subtasks: linearPlan.subtasks,
			edges: [
				["collect", "analyze"],
				["analyze", "publish"],
			],
		});
		expect(validation).toEqual({
			ok: true,
			missingStepIds: [],
			duplicateStepIds: [],
			cycle: [],
		});
		expect(
			validateDagPlan({
				kind: "dag",
				subtasks: [makeStep("a"), makeStep("b"), makeStep("a")],
				edges: [["b", "missing"]],
			}),
		).toMatchObject({
			ok: false,
			missingStepIds: ["missing"],
			duplicateStepIds: ["a"],
			cycle: [],
		});
		expect(
			validateDagPlan({
				kind: "dag",
				subtasks: [makeStep("a"), makeStep("b")],
				edges: [
					["a", "b"],
					["b", "a"],
				],
			}),
		).toMatchObject({
			ok: false,
			cycle: ["a", "b", "a"],
		});
	});

	it("exports decomposition and subtree replacement helpers", () => {
		const dagSketch: DagPlan = {
			kind: "dag",
			subtasks: [
				makeStep("research"),
				makeStep("profile"),
				makeStep("synthesize"),
			],
			edges: [
				["research", "synthesize"],
				["profile", "synthesize"],
			],
		};
		const decomposition: DecomposeResult = decomposePlan(dagSketch, {
			maxSteps: 2,
			maxDepth: 1,
		});
		const replacement: SubtreeReplacementResult = replacePlanSubtree(
			{
				kind: "linear",
				subtasks: [
					makeStep("research"),
					makeStep("draft"),
					makeStep("draft.sources"),
					makeStep("publish"),
				],
			},
			"draft",
			[
				makeStep("outline", { effects: ["outline_ready"] }),
				makeStep("write", { preconditions: ["outline_ready"] }),
			],
		);

		expect(decomposition).toMatchObject({
			truncated: true,
			omittedSteps: 1,
			maxStepsApplied: 2,
			maxDepthApplied: 1,
		});
		expect(decomposition.plan.subtasks.map((step) => step.id)).toEqual([
			"research",
			"profile",
		]);
		expect(replacement.replacedStepIds).toEqual(["draft", "draft.sources"]);
		expect(replacement.insertedStepIds).toEqual([
			"draft.outline",
			"draft.write",
		]);
		expect(replacement.plan.subtasks.map((step) => step.id)).toEqual([
			"research",
			"draft.outline",
			"draft.write",
			"publish",
		]);
	});

	it("exports budget creation, evaluation, and consumption helpers", () => {
		const input: BudgetLedgerInput = {
			tokenBudget: 200,
			turnBudget: 2,
			stepBudget: 3,
			retryTokenBudgetPct: 0.25,
		};
		const ledger = createBudgetLedger(input);
		const initialDecision: BudgetDecision = evaluateBudget(ledger);
		const chargedDecision: BudgetDecision = consumeBudget(ledger, {
			tokens: 50,
			turns: 1,
			retryTokens: 10,
			steps: 1,
		});

		expect(ledger).toMatchObject({
			tokenBudget: 200,
			tokenSpent: 0,
			retryTokenBudget: 50,
			retryTokenSpent: 0,
			turnBudget: 2,
			stepBudget: 3,
		});
		expect(initialDecision).toMatchObject({
			kind: "continue",
			remaining: {
				tokens: 200,
				turns: 2,
				retryTokens: 50,
				steps: 3,
			},
		});
		expect(chargedDecision).toMatchObject({
			kind: "continue",
			remaining: {
				tokens: 150,
				turns: 1,
				retryTokens: 40,
				steps: 2,
			},
		});
		expect(
			consumeBudget(chargedDecision.budget, {
				tokens: 151,
			}),
		).toMatchObject({
			kind: "terminal",
			exceeded: "token",
			reason: "ResourceExhausted",
		});
	});

	it("exports delegation helpers and produces a runnable sub-agent handoff", () => {
		const mainStep = makeStep("main-write", {
			writeScope: "working",
			arguments: { path: "main.md" },
		});
		const delegatedStep = makeStep("delegated-research", {
			action: "research",
			estimatedSteps: 30,
			writeScope: "episodic",
			arguments: { path: "research.md", topic: "planning boundaries" },
			risk: "medium",
		});
		const decision: DelegationDecision = evaluateDelegation({
			parentRunId: "run-barrel",
			candidateStep: delegatedStep,
			plan: {
				kind: "dag",
				subtasks: [mainStep, delegatedStep, makeStep("join")],
				edges: [
					["main-write", "join"],
					["delegated-research", "join"],
				],
			},
			mainAgentSteps: [mainStep],
			triggers: {
				longRunningTask: true,
				decomposableSubtask: true,
				nonBlockingSupervisorRequired: true,
				subAgentCapabilityAvailable: true,
			},
			subAgent: {
				role: "planning-worker",
				goal: "Complete delegated research without blocking the supervisor",
			},
		});

		expect(decision).toMatchObject({
			delegate: true,
			reason: "accepted",
			assignment: {
				parentRunId: "run-barrel",
				childRunId: "run-barrel:delegated:delegated-research",
				taskId: "delegated-research",
				progressReporting: {
					checkpoint: true,
					heartbeat: true,
				},
				handoff: {
					kind: "delegation_handoff",
					route: "sub_agent",
					inputPayload: {
						path: "research.md",
						topic: "planning boundaries",
					},
					writeScope: ["episodic:research.md"],
					resume: {
						checkpointRequired: true,
						heartbeatRequired: true,
						resumeFrom: "latest_checkpoint",
					},
				},
			},
		});
		if (decision.delegate) {
			expect(JSON.parse(JSON.stringify(decision.assignment.handoff))).toEqual(
				decision.assignment.handoff,
			);
		}
	});

	it("exports goal-drift helpers and converts drift decisions into events", () => {
		const state = replayPlanningEvents("run-barrel-drift", [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "subtask_started",
				payload: { leafId: "step-1" },
			},
			{
				seq: 2,
				timestamp: 1_010,
				kind: "subtask_started",
				payload: { leafId: "step-2" },
			},
		]);
		const decision: GoalDriftDecision = detectGoalDrift(state, 0.5, {
			checkInterval: 2,
			warningLimit: 1,
		});
		const event = createGoalDriftEvent(state, decision, () => 2_000);

		expect(decision).toEqual({
			checked: true,
			drifted: true,
			shouldReplan: true,
			similarity: 0.5,
			threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
			stepCount: 2,
			warningCount: 1,
			currentLeafId: "step-2",
			reason: "warning_limit_reached",
		});
		expect(event).toEqual({
			seq: 3,
			timestamp: 2_000,
			kind: "goal_drift_detected",
			payload: {
				run_id: "run-barrel-drift",
				similarity: 0.5,
				threshold: DEFAULT_GOAL_DRIFT_THRESHOLD,
				step_count: 2,
				warning_count: 1,
				current_leaf_id: "step-2",
				should_replan: true,
				reason: "warning_limit_reached",
			},
		});
	});

	it("exports context helpers and assembles planner inputs with memory recall", async () => {
		const memoryItem = {
			id: "memory-1",
			content: "Prefer bounded delegated planning work.",
			content_type: "text",
			layer: "semantic",
			metadata: {
				schema_version: 1,
				source: "barrel-test",
			},
			embedding: null,
			created_at: "2026-04-24T08:00:00.000Z",
			last_accessed: "2026-04-24T08:00:00.000Z",
			access_count: 1,
			importance_score: 0.8,
		} as const;
		const budget = createBudgetLedger({
			tokenBudget: 500,
			turnBudget: 2,
			stepBudget: 4,
		});

		const context = await buildPlanContext({
			task: "Plan a delegation boundary test",
			conversationHistory: [
				{ role: "user", content: "Cover delegation through the barrel." },
			],
			skillCatalog: [],
			budget,
			iteration: 3,
			memory: {
				query: "planning delegation boundary",
				options: { limit: 1, layer: "semantic" },
				client: {
					recall: async (query, options) => {
						expect(query).toBe("planning delegation boundary");
						expect(options).toEqual({ limit: 1, layer: "semantic" });
						return [memoryItem];
					},
					store: async () => undefined,
				},
			},
		});

		expect(context).toEqual({
			task: "Plan a delegation boundary test",
			conversationHistory: [
				{ role: "user", content: "Cover delegation through the barrel." },
			],
			memoryRecall: [memoryItem],
			skillCatalog: [],
			budget,
			iteration: 3,
		});
	});

	it("exports production route readiness helpers and summary types", () => {
		const localBatch: ProductionRouteScoreBatch = scoreProductionRoutes([
			{
				taskRisk: "low",
				complexity: 0.2,
				cost: 0.2,
				capabilityFit: 0.95,
			},
		]);
		const handoffBatch: ProductionRouteScoreBatch = scoreProductionRoutes([
			{
				taskRisk: "high",
				complexity: 0.1,
				cost: 0.1,
				capabilityFit: 0.95,
			},
		]);

		const routeSummary: ProductionRouteExplanationBatchSummary =
			summarizeProductionRouteScores(localBatch.scores);
		const readiness: ProductionRouteScoreBatchReadiness =
			classifyProductionRouteScoreBatchReadiness(handoffBatch);
		const readinessSummary: ProductionRouteScoreBatchReadinessSummary =
			summarizeProductionRouteScoreBatchReadiness([localBatch, handoffBatch]);

		expect(routeSummary).toEqual(localBatch.summary);
		expect(readiness).toBe("handoff_required");
		expect(readinessSummary).toEqual({
			totalBatches: 2,
			totalScores: 2,
			byReadiness: {
				empty: 0,
				local_only: 1,
				mixed: 0,
				handoff_required: 1,
			},
			highestRequiredReadiness: "handoff_required",
		});
	});

	it("exports production route delegation handoff bridge helpers", () => {
		const localStep = makeStep("local-step", {
			writeScope: "working",
			arguments: { path: "local.md" },
			risk: "low",
		});
		const delegatedStep = makeStep("delegated-step", {
			action: "research",
			writeScope: "episodic",
			arguments: { path: "delegated.md" },
			risk: "medium",
		});
		const bridgePlan: ProductionRouteDelegationHandoffPlan =
			buildProductionRouteDelegationHandoffPlan({
				parentRunId: "run-planning-barrel-route",
				plan: {
					kind: "dag",
					subtasks: [localStep, delegatedStep],
					edges: [],
				},
				batch: scoreProductionRoutes([
					{
						taskRisk: "low",
						complexity: 0.1,
						cost: 0.1,
						capabilityFit: 1,
					},
					{
						taskRisk: "medium",
						nonBlockingSupervisorRequired: true,
					},
				]),
				subAgentForStep: (step) => ({
					role: "planning-worker",
					goal: `Complete ${step.name}`,
				}),
			});

		expect(bridgePlan).toMatchObject({
			kind: "production_route_delegation_handoff_plan",
			handoffReadyCount: 1,
			blockedCount: 0,
			acceptedAssignments: [
				{
					index: 1,
					taskId: "delegated-step",
					assignment: {
						childRunId: "run-planning-barrel-route:delegated:delegated-step",
						handoff: {
							kind: "delegation_handoff",
							writeScope: ["episodic:delegated.md"],
							resume: {
								checkpointRequired: true,
								heartbeatRequired: true,
							},
						},
					},
				},
			],
		});
	});

	it("exports replan helpers and patch types", () => {
		const previousPlan = makeLinearPlan(["search", "draft"]);
		const localPatch: LocalPlanPatch = applyLocalRearrange(previousPlan, {
			kind: "tool_failed",
			leafId: "search",
			errorCode: "TIMEOUT",
			changes: {
				action: "cached_search",
				arguments: { query: "fallback" },
			},
		});
		const nextPlan = makeLinearPlan(["confirm", "draft"]);
		const globalPatch: GlobalPlanPatch = applyGlobalReplan(
			localPatch.plan,
			nextPlan,
			{
				reason: "manual_request",
				currentLeafId: "confirm",
				note: "user asked for a broader plan",
				production: true,
			},
		);

		expect(localPatch).toMatchObject({
			level: "L-Rearrange",
			leafId: "search",
			reason: "tool_failed:TIMEOUT",
			currentLeafId: "search",
		});
		expect(localPatch.plan.subtasks[0]).toMatchObject({
			id: "search",
			action: "cached_search",
			arguments: { query: "fallback" },
		});
		expect(toReplanEventPayload(globalPatch)).toEqual({
			plan: nextPlan,
			currentLeafId: "confirm",
			reason: "manual_request",
			note: "user asked for a broader plan",
			production: true,
			metric: {
				kind: "global_replan_triggered",
				reason: "manual_request",
				production: true,
			},
		});
	});

	it("exports replan metrics helpers and metric types", () => {
		const metrics: GlobalReplanRateMetrics = computeGlobalReplanRate(
			[
				{ hadGlobalReplan: true, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: false, production: true },
				{ hadGlobalReplan: true, production: false },
			],
			{ productionTargetRate: 0.25 },
		);

		expect(metrics).toEqual({
			totalRuns: 4,
			globalReplanTriggers: 2,
			triggerRate: 0.5,
			productionRuns: 3,
			productionGlobalReplanTriggers: 1,
			productionTriggerRate: 1 / 3,
			productionTargetRate: 0.25,
			productionTargetMet: false,
		});
	});

	it("exports intent dispatch helpers, classifier class, and intent types", () => {
		const response: LLMPlannerResponse = {
			toolCalls: [
				{
					id: "tool-1",
					name: "web_search",
					arguments: { query: "planning boundary tests" },
				},
			],
			audit: {
				intentHint: "MULTI_STEP",
				confidence: DEFAULT_AUDIT_CONFIDENCE_THRESHOLD + 0.01,
				reasoningDigest: "Potential follow-up exists.",
			},
		};
		const classifier = new StructuralIntentClassifier();
		const structuralIntent = deriveStructuralIntent(response);
		const dispatched: IntentClassification = dispatchIntent(response, {
			latencyMs: -1,
		});

		expect(structuralIntent).toBe("SINGLE_TOOL");
		expect(dispatched).toEqual({
			intent: "SINGLE_TOOL",
			confidence: 1,
			source: "structural",
			latencyMs: 0,
		});
		expect(classifier.dispatch({ text: "Done." })).toMatchObject({
			intent: "SIMPLE_QA",
			source: "structural",
		});
		expect(
			classifyIntent({
				text: "Done.",
				audit: {
					intentHint: "SIMPLE_QA",
					confidence: DEFAULT_AUDIT_CONFIDENCE_THRESHOLD,
				},
			}),
		).toMatchObject({
			intent: "SIMPLE_QA",
			source: "audit",
		});
	});

	it("exports planner audit observation helpers and audit metric types", () => {
		const matching: PlannerAuditObservation = observePlannerAudit({
			planSketch: makeLinearPlan(["inspect", "patch"]),
			audit: {
				intentHint: "MULTI_STEP",
				confidence: 0.93,
				reasoningDigest: "The planner emitted a two-step sketch.",
			},
		});
		const mismatched = observePlannerAudit({
			text: "Done.",
			audit: {
				intentHint: "MULTI_STEP",
				confidence: 0.91,
			},
		});
		const metrics: AuditAgreementMetrics = computeAuditAgreement([
			matching,
			mismatched,
			observePlannerAudit({ text: "No audit payload." }),
		]);

		expect(matching).toEqual({
			structuralIntent: "MULTI_STEP",
			dispatchedIntent: "MULTI_STEP",
			dispatchSource: "audit",
			intentHint: "MULTI_STEP",
			confidence: 0.93,
			reasoningDigest: "The planner emitted a two-step sketch.",
			matchesStructural: true,
			matchesDispatched: true,
		});
		expect(metrics).toEqual({
			totalSamples: 3,
			auditedSamples: 2,
			structuralMatches: 1,
			dispatchedMatches: 2,
			structuralAgreementRate: 0.5,
			dispatchedAgreementRate: 1,
		});
	});

	it("exports plan review memory-writer helpers, constants, and result types", async () => {
		const now = () => new Date("2026-04-24T08:00:00.000Z");
		const review: PlanReviewRecord = {
			run_id: "run-barrel-memory",
			source: PLAN_REVIEW_SOURCE,
			schema_version: PLAN_REVIEW_SCHEMA_VERSION,
			summary: "Persist only stable planning review facts.",
			stable_strategy: {
				selection: "audit_then_structural_fallback",
			},
		};
		const validated = validatePlanReviewRecord(review);
		const item = createPlanReviewMemoryItem(validated, {
			now,
			metadata: { channel: "barrel-test" },
		});
		const storedItems: unknown[] = [];
		const writeResult: PlanReviewWriteResult = await writePlanReviewRecord(
			review,
			{
				now,
				client: {
					recall: async () => [],
					store: async (memoryItem) => {
						storedItems.push(memoryItem);
					},
				},
			},
		);

		expect(item).toMatchObject({
			id: expect.stringMatching(/^planning-review:run-barrel-memory:/),
			content: JSON.stringify(review),
			content_type: "json",
			layer: "semantic",
			metadata: {
				channel: "barrel-test",
				schema_version: PLAN_REVIEW_SCHEMA_VERSION,
				source: PLAN_REVIEW_SOURCE,
				run_id: "run-barrel-memory",
			},
			created_at: now().toISOString(),
			last_accessed: now().toISOString(),
		});
		expect(writeResult.status).toBe("written");
		expect(storedItems).toHaveLength(1);
		expect(storedItems[0]).toMatchObject({
			content: JSON.stringify(review),
			layer: "semantic",
		});
	});

	it("exports strategy selection helpers, selector class, and selection types", () => {
		const selected: StrategySelection = selectPlanningStrategy(
			{
				intent: "MULTI_STEP",
				plan: makeLinearPlan(["one", "two", "three"]),
			},
			{ planAndExecuteStepThreshold: 2 },
		);
		const override: PlanningStrategy = "CoT";
		const selector = new RuleBasedStrategySelector({
			planAndExecuteStepThreshold: 4,
		});

		expect(selected).toMatchObject({
			strategy: "PlanAndExecute",
			reason: "long_plan",
			planStepCount: 3,
			threshold: 2,
			overridden: false,
		});
		expect(
			selector.select({
				intent: "MULTI_STEP",
				estimatedSteps: 5,
				userOverride: override,
			}),
		).toMatchObject({
			strategy: "CoT",
			reason: "user_override",
			overridden: true,
		});
	});

	it("exports termination replay and detection helpers", () => {
		const events: readonly PlanningEvent[] = [
			{
				seq: 1,
				timestamp: 1_000,
				kind: "task_decomposed",
				payload: { plan: makeLinearPlan(["loop"]) },
			},
			{
				seq: 2,
				timestamp: 1_010,
				kind: "subtask_started",
				payload: { leafId: "loop" },
			},
			{
				seq: 3,
				timestamp: 1_020,
				kind: "local_repair",
				payload: { leafId: "loop", note: "retry with same inputs" },
			},
			{
				seq: 4,
				timestamp: 1_030,
				kind: "local_repair",
				payload: { leafId: "loop", note: "retry with same inputs again" },
			},
		];
		const decision: TerminationDecision = detectTermination(
			replayPlanningEvents("run-barrel-termination", events),
			{ deadLoopRepairThreshold: 2 },
		);

		expect(decision).toEqual({
			shouldTerminate: true,
			reason: "DeadLoop",
			stepCount: 1,
			deadLoop: {
				detected: true,
				leafId: "loop",
				repairs: 2,
			},
		});
	});
});
