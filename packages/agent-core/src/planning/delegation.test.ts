import { describe, expect, it } from "vitest";
import {
	DELEGATION_HANDOFF_SCHEMA_VERSION,
	type DelegationCandidate,
	type DelegationTriggerConditions,
	evaluateDelegation,
	RuleBasedDelegationStrategy,
} from "./delegation.js";
import type { DagPlan, SubTask } from "./types.js";

function makeStep(id: string, overrides: Partial<SubTask> = {}): SubTask {
	return {
		id,
		action: overrides.action ?? "tool",
		name: overrides.name ?? `Step ${id}`,
		description: overrides.description ?? `Execute ${id}`,
		estimatedTokens: overrides.estimatedTokens ?? 100,
		estimatedSteps: overrides.estimatedSteps ?? 1,
		preconditions: overrides.preconditions ?? [],
		effects: overrides.effects ?? [`effect:${id}`],
		arguments: overrides.arguments,
		depth: overrides.depth,
		writeScope: overrides.writeScope,
		risk: overrides.risk,
		skillHint: overrides.skillHint,
	};
}

const allTriggers: DelegationTriggerConditions = {
	longRunningTask: true,
	decomposableSubtask: true,
	nonBlockingSupervisorRequired: true,
	subAgentCapabilityAvailable: true,
};

function makeCandidate(
	overrides: Partial<DelegationCandidate> = {},
): DelegationCandidate {
	const mainStep = makeStep("main-write", {
		writeScope: "working",
		arguments: { path: "main.md" },
		risk: "low",
	});
	const delegatedStep = makeStep("delegated-research", {
		action: "research",
		writeScope: "episodic",
		arguments: { path: "research.md" },
		risk: "medium",
		estimatedSteps: 30,
	});
	const plan: DagPlan = {
		kind: "dag",
		subtasks: [mainStep, delegatedStep, makeStep("join")],
		edges: [
			["main-write", "join"],
			["delegated-research", "join"],
		],
	};

	return {
		parentRunId: "run-c3",
		candidateStep: delegatedStep,
		plan,
		mainAgentSteps: [mainStep],
		triggers: allTriggers,
		subAgent: {
			role: "research-worker",
			goal: "Complete delegated research without blocking the supervisor",
		},
		...overrides,
	};
}

describe("evaluateDelegation", () => {
	it("accepts delegation only when all trigger, DAG, write-set, and risk gates pass", () => {
		const decision = evaluateDelegation(makeCandidate());

		expect(decision).toMatchObject({
			delegate: true,
			reason: "accepted",
			assignment: {
				parentRunId: "run-c3",
				childRunId: "run-c3:delegated:delegated-research",
				taskId: "delegated-research",
				writeSet: {
					scope: "episodic",
					resources: ["research.md"],
					unknown: false,
				},
				progressReporting: {
					checkpoint: true,
					heartbeat: true,
				},
				handoff: {
					kind: "delegation_handoff",
					schemaVersion: DELEGATION_HANDOFF_SCHEMA_VERSION,
					route: "sub_agent",
					traceId: "run-c3:delegated:delegated-research:handoff",
					parentRunId: "run-c3",
					childRunId: "run-c3:delegated:delegated-research",
					task: {
						id: "delegated-research",
						action: "research",
						name: "Step delegated-research",
						description: "Execute delegated-research",
						estimatedTokens: 100,
						estimatedSteps: 30,
						preconditions: [],
						effects: ["effect:delegated-research"],
						arguments: { path: "research.md" },
					},
					agent: {
						role: "research-worker",
						goal: "Complete delegated research without blocking the supervisor",
					},
					receiver: {
						role: "research-worker",
						requiredCapabilities: ["research"],
					},
					inputSchemaRef: "planning.subtask.arguments.v1",
					inputPayload: { path: "research.md" },
					historyFilter: "task_only",
					writeSet: {
						scope: "episodic",
						resources: ["research.md"],
						unknown: false,
					},
					writeScope: ["episodic:research.md"],
					writeAuthority: {
						gate: "WriteAuthority",
						origin: "delegation",
						required: true,
						risk: "medium",
						scope: "episodic",
						canonicalResources: ["research.md"],
					},
					risk: "medium",
					retryPolicy: {
						maxAttempts: 1,
						backoff: "none",
					},
					cancelToken: "run-c3:delegated:delegated-research:cancel",
					cancellation: {
						token: "run-c3:delegated:delegated-research:cancel",
						mode: "cooperative",
						requestedBy: "parent_or_supervisor",
						reasonRequired: true,
					},
					trace: {
						traceId: "run-c3:delegated:delegated-research:handoff",
						parentRunId: "run-c3",
						childRunId: "run-c3:delegated:delegated-research",
						spanId: "run-c3:delegated:delegated-research:handoff:span",
						schemaRef: "planning.delegation.trace.v1",
					},
					idempotencyKey:
						"delegation:run-c3:delegated-research:episodic:research.md",
					resultSchemaRef: "planning.delegation.result.v1",
					resume: {
						checkpointRequired: true,
						heartbeatRequired: true,
						resumeFrom: "latest_checkpoint",
						checkpointOwner: "child_agent",
					},
				},
			},
		});
	});

	it("produces a serializable typed handoff for cross-process supervisor routing", () => {
		const decision = evaluateDelegation(makeCandidate());
		if (!decision.delegate) {
			throw new Error("expected delegation to be accepted");
		}

		expect(JSON.parse(JSON.stringify(decision.assignment.handoff))).toEqual(
			decision.assignment.handoff,
		);
		expect(decision.assignment.handoff).toMatchObject({
			kind: "delegation_handoff",
			schemaVersion: DELEGATION_HANDOFF_SCHEMA_VERSION,
			route: "sub_agent",
			traceId: "run-c3:delegated:delegated-research:handoff",
			receiver: {
				role: "research-worker",
				requiredCapabilities: ["research"],
			},
			task: {
				id: decision.assignment.taskId,
				action: "research",
			},
			inputSchemaRef: "planning.subtask.arguments.v1",
			inputPayload: { path: "research.md" },
			historyFilter: "task_only",
			writeScope: ["episodic:research.md"],
			retryPolicy: {
				maxAttempts: 1,
				backoff: "none",
			},
			cancelToken: "run-c3:delegated:delegated-research:cancel",
			cancellation: {
				token: "run-c3:delegated:delegated-research:cancel",
				mode: "cooperative",
			},
			trace: {
				traceId: "run-c3:delegated:delegated-research:handoff",
				schemaRef: "planning.delegation.trace.v1",
			},
			idempotencyKey:
				"delegation:run-c3:delegated-research:episodic:research.md",
			resultSchemaRef: "planning.delegation.result.v1",
			resume: {
				checkpointRequired: true,
				heartbeatRequired: true,
				resumeFrom: "latest_checkpoint",
			},
		});
	});

	it.each([
		["longRunningTask", "missing_long_running_trigger"],
		["decomposableSubtask", "missing_decomposable_trigger"],
		["nonBlockingSupervisorRequired", "missing_non_blocking_trigger"],
		["subAgentCapabilityAvailable", "missing_sub_agent_capability_trigger"],
	] as const)("rejects delegation when the %s trigger is absent", (triggerName, reason) => {
		expect(
			evaluateDelegation(
				makeCandidate({
					triggers: {
						...allTriggers,
						[triggerName]: false,
					},
				}),
			),
		).toEqual({ delegate: false, reason });
	});

	it("rejects unavailable worker candidates before producing a handoff", () => {
		const decision = evaluateDelegation(
			makeCandidate({
				triggers: {
					...allTriggers,
					subAgentCapabilityAvailable: false,
				},
				subAgent: undefined as unknown as DelegationCandidate["subAgent"],
			}),
		);

		expect(decision).toEqual({
			delegate: false,
			reason: "missing_sub_agent_capability_trigger",
		});
		expect("assignment" in decision).toBe(false);
	});

	it("rejects delegated writes that overlap the main agent write set", () => {
		const candidateStep = makeStep("delegated-write", {
			writeScope: "working",
			arguments: { path: "same.md" },
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep,
					plan: {
						kind: "dag",
						subtasks: [candidateStep],
						edges: [],
					},
					mainAgentSteps: [
						makeStep("main-write", {
							writeScope: "working",
							arguments: { path: "same.md" },
							risk: "low",
						}),
					],
				}),
			),
		).toEqual({ delegate: false, reason: "shared_write_set" });
	});

	it("rejects delegated writes whose normalized path overlaps the main agent write set", () => {
		const candidateStep = makeStep("delegated-normalized-write", {
			writeScope: "working",
			arguments: { path: "./notes/../notes/research.md" },
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep,
					plan: {
						kind: "dag",
						subtasks: [candidateStep],
						edges: [],
					},
					mainAgentSteps: [
						makeStep("main-normalized-write", {
							writeScope: "working",
							arguments: { path: "notes/research.md" },
							risk: "low",
						}),
					],
				}),
			),
		).toEqual({ delegate: false, reason: "shared_write_set" });
	});

	it("uses canonical write resources in the handoff runtime envelope", () => {
		const candidateStep = makeStep("delegated-normalized-handoff", {
			writeScope: "working",
			arguments: { path: "./notes/../notes/research.md" },
			risk: "medium",
		});
		const decision = evaluateDelegation(
			makeCandidate({
				candidateStep,
				plan: {
					kind: "dag",
					subtasks: [candidateStep],
					edges: [],
				},
				mainAgentSteps: [],
			}),
		);

		if (!decision.delegate) {
			throw new Error("expected delegation to be accepted");
		}

		expect(decision.assignment.handoff.writeSet.resources).toEqual([
			"./notes/../notes/research.md",
		]);
		expect(decision.assignment.handoff.writeScope).toEqual([
			"working:notes/research.md",
		]);
		expect(decision.assignment.handoff.writeAuthority).toMatchObject({
			gate: "WriteAuthority",
			origin: "delegation",
			canonicalResources: ["notes/research.md"],
		});
		expect(decision.assignment.handoff.idempotencyKey).toBe(
			"delegation:run-c3:delegated-normalized-handoff:working:notes/research.md",
		);
	});

	it("rejects high and critical risk writes conservatively", () => {
		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep: makeStep("dangerous", {
						writeScope: "episodic",
						arguments: { path: "danger.md" },
						risk: "high",
					}),
					plan: {
						kind: "dag",
						subtasks: [
							makeStep("dangerous", {
								writeScope: "episodic",
								arguments: { path: "danger.md" },
								risk: "high",
							}),
						],
						edges: [],
					},
				}),
			),
		).toEqual({ delegate: false, reason: "high_risk_write" });

		expect(
			evaluateDelegation(makeCandidate({ riskOverride: "critical" })),
		).toEqual({ delegate: false, reason: "high_risk_write" });
	});

	it("rejects unknown write sets before producing a handoff", () => {
		const candidateStep = makeStep("unknown-write", {
			writeScope: "episodic",
			arguments: {},
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep,
					plan: {
						kind: "dag",
						subtasks: [candidateStep],
						edges: [],
					},
					mainAgentSteps: [],
				}),
			),
		).toEqual({ delegate: false, reason: "unknown_write_set" });
	});

	it("rejects non-JSON-safe handoff payloads", () => {
		const cyclic: Record<string, unknown> = { path: "research.md" };
		cyclic.self = cyclic;
		const candidateStep = makeStep("cyclic-payload", {
			action: "research",
			writeScope: "episodic",
			arguments: cyclic,
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep,
					plan: {
						kind: "dag",
						subtasks: [candidateStep],
						edges: [],
					},
					mainAgentSteps: [],
				}),
			),
		).toEqual({ delegate: false, reason: "non_serializable_handoff" });
	});

	it("rejects non-JSON-safe handoff metadata", () => {
		const candidateStep = makeStep("function-metadata", {
			action: "research",
			writeScope: "episodic",
			arguments: {
				path: "research.md",
				metadata: {
					onCheckpoint: () => "not serializable",
				},
			},
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep,
					plan: {
						kind: "dag",
						subtasks: [candidateStep],
						edges: [],
					},
					mainAgentSteps: [],
				}),
			),
		).toEqual({ delegate: false, reason: "non_serializable_handoff" });
	});

	it("rejects invalid DAG candidates before producing an assignment", () => {
		const step = makeStep("loop");

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep: step,
					plan: {
						kind: "dag",
						subtasks: [step],
						edges: [["loop", "loop"]],
					},
				}),
			),
		).toEqual({ delegate: false, reason: "invalid_dag" });
	});

	it("rejects dependency edges that reference missing steps", () => {
		const step = makeStep("delegated-edge", {
			writeScope: "episodic",
			arguments: { path: "edge.md" },
			risk: "medium",
		});

		expect(
			evaluateDelegation(
				makeCandidate({
					candidateStep: step,
					plan: {
						kind: "dag",
						subtasks: [step],
						edges: [["missing-predecessor", "delegated-edge"]],
					},
				}),
			),
		).toEqual({ delegate: false, reason: "invalid_dag" });
	});
});

describe("RuleBasedDelegationStrategy", () => {
	it("wraps the pure delegation evaluator", () => {
		const strategy = new RuleBasedDelegationStrategy();

		expect(strategy.evaluate(makeCandidate()).delegate).toBe(true);
	});
});
