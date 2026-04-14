import type { AgentState, Checkpoint } from "./types.js";

export class SQLiteCheckpoint implements Checkpoint {
	async save(state: AgentState): Promise<void> {
		void state;
		throw new Error("Not implemented");
	}

	async load(sessionId: string): Promise<AgentState | null> {
		void sessionId;
		throw new Error("Not implemented");
	}

	async list(): Promise<readonly string[]> {
		throw new Error("Not implemented");
	}
}
