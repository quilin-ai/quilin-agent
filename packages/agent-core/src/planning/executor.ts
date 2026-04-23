import { createHash } from "node:crypto";
import type { ToolCall, ToolResult } from "../tools/types.js";
import {
	applyEvent,
	type Checkpoint,
	type CheckpointFailedPayload,
	createPlanningState,
	type PlanningEvent,
	type PlanningState,
	type PlanPhase,
} from "./state.js";
import type { IntentClassification, LinearPlan, SubTask } from "./types.js";

export const DEFAULT_EXECUTOR_MAX_STEPS = 20;
const CHECKPOINT_SCHEMA_VERSION = 1;

export interface CheckpointWriteInput {
	readonly runId: string;
	readonly phase: PlanPhase;
	readonly taskHash: string;
	readonly eventSeq: number;
	readonly schemaVersion: number;
	readonly state: PlanningState;
}

export interface CheckpointWriteResult {
	readonly id: string;
	readonly storageRef: string;
}

export type CheckpointWriter = (
	input: CheckpointWriteInput,
) => Promise<CheckpointWriteResult>;

export type ExecutorToolHandler = (
	toolCall: ToolCall,
	step: SubTask | null,
) => Promise<ToolResult>;

export interface ExecutorInput {
	readonly runId: string;
	readonly task: string;
	readonly plan: LinearPlan;
	readonly intent?: IntentClassification;
	readonly initialToolCalls?: ReadonlyArray<ToolCall>;
}

export interface ExecutorOptions {
	readonly tools: Readonly<Record<string, ExecutorToolHandler>>;
	readonly checkpointWriter?: CheckpointWriter;
	readonly maxSteps?: number;
	readonly now?: () => number;
	readonly onEvent?: (event: PlanningEvent) => void;
}

export interface ExecutorResult {
	readonly state: PlanningState;
	readonly taskHash: string;
	readonly outputs: ReadonlyArray<ToolResult>;
	readonly preflightOutputs: ReadonlyArray<ToolResult>;
	readonly haltedOnError: boolean;
	readonly terminatedReason: string | null;
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
	field: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) {
		throw new RangeError(`${field} must be a positive integer`);
	}
	return resolved;
}

function toErrorCode(error: unknown): string {
	if (error instanceof Error) {
		const normalized = error.message
			.trim()
			.toUpperCase()
			.replace(/[^A-Z0-9]+/gu, "_")
			.replace(/^_+|_+$/gu, "");

		if (normalized.length > 0) {
			return normalized;
		}

		return error.name.toUpperCase();
	}

	return "UNKNOWN_ERROR";
}

function createErrorResult(toolCall: ToolCall, errorCode: string): ToolResult {
	return {
		toolCallId: toolCall.id,
		content: JSON.stringify({ error: errorCode }),
		isError: true,
	};
}

function createToolCall(
	runId: string,
	step: SubTask,
	stepIndex: number,
): ToolCall {
	return {
		id: `${runId}:${step.id}:${stepIndex + 1}`,
		name: step.action,
		arguments: {
			...(step.arguments ?? {}),
		},
	};
}

function cloneSnapshot(state: PlanningState): PlanningState {
	return {
		...state,
		events: [...state.events],
		checkpoints: [...state.checkpoints],
	};
}

export function createTaskHash(task: string, plan: LinearPlan): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				task,
				subtasks: plan.subtasks.map((step) => ({
					id: step.id,
					action: step.action,
				})),
			}),
		)
		.digest("hex");
}

export class LinearPlanExecutor {
	private readonly now: () => number;
	private readonly maxSteps: number;

	constructor(private readonly options: ExecutorOptions) {
		this.now = options.now ?? Date.now;
		this.maxSteps = normalizePositiveInteger(
			options.maxSteps,
			DEFAULT_EXECUTOR_MAX_STEPS,
			"maxSteps",
		);
	}

	async execute(input: ExecutorInput): Promise<ExecutorResult> {
		let seq = 0;
		let state = createPlanningState(input.runId);
		const outputs: ToolResult[] = [];
		const preflightOutputs: ToolResult[] = [];
		const taskHash = createTaskHash(input.task, input.plan);

		const emit = <TKind extends PlanningEvent["kind"]>(
			event: Omit<
				Extract<PlanningEvent, { readonly kind: TKind }>,
				"seq" | "timestamp"
			>,
		): void => {
			seq += 1;
			const nextEvent = {
				seq,
				timestamp: this.now(),
				...event,
			} as PlanningEvent;
			state = applyEvent(state, nextEvent);
			this.options.onEvent?.(nextEvent);
		};

		if (input.intent != null) {
			emit({
				kind: "intent_classified",
				payload: input.intent,
			});
		}

		emit({
			kind: "task_decomposed",
			payload: { plan: input.plan },
		});

		for (const toolCall of input.initialToolCalls ?? []) {
			emit({
				kind: "tool_called",
				payload: { toolCall },
			});
			const result = await this.executeTool(toolCall, null);
			emit({
				kind: "tool_returned",
				payload: {
					toolCallId: toolCall.id,
					isError: result.isError,
				},
			});
			preflightOutputs.push(result);
			if (result.isError) {
				return {
					state,
					taskHash,
					outputs,
					preflightOutputs,
					haltedOnError: true,
					terminatedReason: null,
				};
			}
		}

		const steps = input.plan.subtasks.slice(0, this.maxSteps);
		if (input.plan.subtasks.length > steps.length) {
			emit({
				kind: "terminated",
				payload: { reason: "MaxSteps" },
			});
			return {
				state,
				taskHash,
				outputs,
				preflightOutputs,
				haltedOnError: false,
				terminatedReason: "MaxSteps",
			};
		}

		for (const [stepIndex, step] of steps.entries()) {
			emit({
				kind: "subtask_started",
				payload: { leafId: step.id },
			});

			const toolCall = createToolCall(input.runId, step, stepIndex);
			emit({
				kind: "tool_called",
				payload: {
					toolCall,
					leafId: step.id,
				},
			});

			const result = await this.executeTool(toolCall, step);
			emit({
				kind: "tool_returned",
				payload: {
					toolCallId: toolCall.id,
					isError: result.isError,
					leafId: step.id,
				},
			});

			if (result.isError) {
				emit({
					kind: "local_repair",
					payload: {
						leafId: step.id,
						note: `tool_failed:${toolCall.name}`,
					},
				});

				await this.writeCheckpoint(state, taskHash, seq, emit);

				return {
					state,
					taskHash,
					outputs,
					preflightOutputs,
					haltedOnError: true,
					terminatedReason: null,
				};
			}

			outputs.push(result);
			emit({
				kind: "subtask_done",
				payload: { leafId: step.id },
			});

			await this.writeCheckpoint(state, taskHash, seq, emit);
		}

		emit({
			kind: "terminated",
			payload: { reason: "Success" },
		});

		return {
			state,
			taskHash,
			outputs,
			preflightOutputs,
			haltedOnError: false,
			terminatedReason: "Success",
		};
	}

	private async executeTool(
		toolCall: ToolCall,
		step: SubTask | null,
	): Promise<ToolResult> {
		const handler = this.options.tools[toolCall.name];
		if (handler == null) {
			return createErrorResult(toolCall, "TOOL_NOT_FOUND");
		}

		try {
			return await handler(toolCall, step);
		} catch (error) {
			return createErrorResult(toolCall, toErrorCode(error));
		}
	}

	private async writeCheckpoint(
		state: PlanningState,
		taskHash: string,
		eventSeq: number,
		emit: (event: Omit<PlanningEvent, "seq" | "timestamp">) => void,
	): Promise<void> {
		if (this.options.checkpointWriter == null) {
			return;
		}

		try {
			const checkpointResult = await this.options.checkpointWriter({
				runId: state.runId,
				phase: state.phase,
				taskHash,
				eventSeq,
				schemaVersion: CHECKPOINT_SCHEMA_VERSION,
				state,
			});
			const checkpoint: Checkpoint = {
				id: checkpointResult.id,
				atEventSeq: eventSeq,
				stateSnapshot: cloneSnapshot(state),
				storageRef: checkpointResult.storageRef,
			};

			emit({
				kind: "checkpoint_saved",
				payload: checkpoint,
			});
		} catch (error) {
			const payload: CheckpointFailedPayload = {
				run_id: state.runId,
				phase: state.phase,
				task_hash: taskHash,
				error_code: toErrorCode(error),
				ts: this.now(),
			};

			emit({
				kind: "checkpoint_failed",
				payload,
			});
		}
	}
}
