import type { AgentState, Checkpoint, Message } from "./types.js";

export interface SaveCheckpointStateOptions {
	readonly checkpoint?: Checkpoint;
	readonly messages: readonly Message[];
	readonly turnCount: number;
	readonly state?: AgentState;
	readonly phase?: string;
	readonly recordSpan?: (
		name: string,
		attributes?: Record<string, unknown>,
	) => void | Promise<void>;
	readonly now?: () => Date;
}

export function buildCheckpointState(
	messages: readonly Message[],
	turnCount: number,
	state?: AgentState,
	now: () => Date = () => new Date(),
): AgentState {
	const currentTime = now().toISOString();

	return {
		messages: [...messages],
		isTerminal: false,
		turnCount,
		createdAt: state?.createdAt ?? currentTime,
		lastActiveAt: currentTime,
	};
}

export async function saveCheckpointState(
	options: SaveCheckpointStateOptions,
): Promise<void> {
	if (options.checkpoint == null) {
		return;
	}

	const checkpointState = buildCheckpointState(
		options.messages,
		options.turnCount,
		options.state,
		options.now,
	);
	await options.checkpoint.save(checkpointState);
	await options.recordSpan?.("loop.checkpoint.save", {
		turnCount: options.turnCount,
		phase: options.phase,
		messageCount: checkpointState.messages.length,
	});
}
