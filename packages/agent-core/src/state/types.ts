import type { ToolCall } from "../tools/types.js";

/** 消息角色 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 消息 */
export interface Message {
	readonly role: MessageRole;
	readonly content: string;
	readonly toolCalls?: readonly ToolCall[];
	readonly toolCallId?: string;
	readonly name?: string;
}

/** Agent 状态 — "the only state is a message array" */
export interface AgentState {
	readonly messages: readonly Message[];
	readonly isTerminal: boolean;
	readonly turnCount: number;
	readonly createdAt: string;
	readonly lastActiveAt: string;
}

/** Checkpoint 接口 — SQLite 持久化 */
export interface Checkpoint {
	save(state: AgentState): Promise<void>;
	load(sessionId: string): Promise<AgentState | null>;
	list(): Promise<readonly string[]>;
}
