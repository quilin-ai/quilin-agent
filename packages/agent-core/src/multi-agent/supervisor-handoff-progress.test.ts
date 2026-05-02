import { describe, expect, it } from "vitest";
import {
	type DagPlan,
	type DelegationHandoff,
	evaluateDelegation,
	type SubTask,
} from "../planning/index.js";
import {
	applyDelegationHandoffsToSupervisorProgressSink,
	createBufferedSupervisorProgressSink,
	createChildRunStatusRecordFromDelegationHandoff,
	createSupervisorProgressStateFromDelegationHandoffs,
	projectSupervisorProgressEvents,
	recordChildRunHeartbeat,
} from "./index.js";

const NOW = "2026-05-02T08:00:00.000Z";

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
		writeScope: overrides.writeScope,
		risk: overrides.risk,
		scratchpad: overrides.scratchpad,
	};
}

function makeDelegationHandoff(): DelegationHandoff {
	const mainStep = makeStep("parent-summary", {
		writeScope: "working",
		arguments: { path: "summary.md" },
		risk: "low",
	});
	const delegatedStep = makeStep("delegated-research", {
		action: "research",
		writeScope: "episodic",
		arguments: { path: "research.md", topic: "handoff progress" },
		estimatedSteps: 4,
		risk: "medium",
	});
	const plan: DagPlan = {
		kind: "dag",
		subtasks: [mainStep, delegatedStep],
		edges: [],
	};
	const decision = evaluateDelegation({
		parentRunId: "run-supervisor-progress",
		candidateStep: delegatedStep,
		plan,
		mainAgentSteps: [mainStep],
		triggers: {
			longRunningTask: true,
			decomposableSubtask: true,
			nonBlockingSupervisorRequired: true,
			subAgentCapabilityAvailable: true,
		},
		subAgent: {
			role: "research-worker",
			goal: "Complete delegated research and report checkpoints",
		},
	});

	if (!decision.delegate) {
		throw new Error(`Expected delegation handoff, got ${decision.reason}`);
	}

	return decision.assignment.handoff;
}

describe("supervisor handoff progress bridge", () => {
	it("turns a typed delegation handoff into a queued child run projection", () => {
		const handoff = makeDelegationHandoff();
		const state = createSupervisorProgressStateFromDelegationHandoffs(
			[handoff],
			{ now: NOW },
		);

		expect(state).toMatchObject({
			kind: "delegation_handoff_supervisor_progress_state",
			schemaVersion: 1,
			records: [
				{
					runId: "run-supervisor-progress:delegated:delegated-research",
					taskId: "delegated-research",
					status: "queued",
					summary: "Queued handoff to research-worker: Step delegated-research",
					confidence: "unknown",
					reviewedArtifactCount: 0,
					lastHeartbeatAt: NOW,
					createdAt: NOW,
					updatedAt: NOW,
				},
			],
			projection: {
				snapshot: {
					generatedAt: NOW,
					totalRuns: 1,
					band: "starting",
					queuedRunIds: [
						"run-supervisor-progress:delegated:delegated-research",
					],
				},
			},
		});
		expect(state.projection.events.map((event) => event.type)).toEqual([
			"progress_snapshot",
			"child_heartbeat",
		]);
		expect(state.projection.events[1]).toMatchObject({
			type: "child_heartbeat",
			runId: "run-supervisor-progress:delegated:delegated-research",
			taskId: "delegated-research",
			payload: {
				status: "queued",
				summary: "Queued handoff to research-worker: Step delegated-research",
			},
		});
	});

	it("projects active heartbeat and checkpoint updates after handoff queueing", () => {
		const handoff = makeDelegationHandoff();
		const queuedRecord = createChildRunStatusRecordFromDelegationHandoff(
			handoff,
			NOW,
		);
		const activeRecord = recordChildRunHeartbeat(
			queuedRecord,
			{
				status: "active",
				summary: "research worker started",
				currentStep: "reading sources",
				progress: {
					completedSteps: 1,
					totalSteps: 4,
				},
				nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				confidence: "medium",
			},
			"2026-05-02T08:01:00.000Z",
		);
		const projection = projectSupervisorProgressEvents([activeRecord], {
			now: "2026-05-02T08:02:00.000Z",
		});

		expect(projection.snapshot).toMatchObject({
			band: "making_progress",
			boundedPercent: 25,
			currentSteps: ["reading sources"],
			nextCheckpointAt: "2026-05-02T08:05:00.000Z",
		});
		expect(projection.events.map((event) => event.type)).toEqual([
			"progress_snapshot",
			"child_heartbeat",
			"child_checkpoint",
		]);
		expect(
			projection.events.find((event) => event.type === "child_checkpoint"),
		).toMatchObject({
			type: "child_checkpoint",
			runId: "run-supervisor-progress:delegated:delegated-research",
			taskId: "delegated-research",
			payload: {
				status: "active",
				nextCheckpointAt: "2026-05-02T08:05:00.000Z",
				dueInMs: 180_000,
				isDue: false,
			},
		});
	});

	it("applies delegation handoff projections to the supervisor progress sink", () => {
		const handoff = makeDelegationHandoff();
		const report = applyDelegationHandoffsToSupervisorProgressSink(
			createBufferedSupervisorProgressSink(),
			[handoff],
			{ now: NOW },
		);

		expect(report).toMatchObject({
			batch: {
				totalEvents: 2,
				byType: {
					progress_snapshot: 1,
					child_heartbeat: 1,
				},
				bySeverity: {
					info: 2,
					warning: 0,
					success: 0,
					error: 0,
				},
			},
			attention: {
				status: "healthy",
				totalEvents: 2,
				warningCount: 0,
				errorCount: 0,
			},
		});
	});
});
