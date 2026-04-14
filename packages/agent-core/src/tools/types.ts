import type { z } from "zod";

/** 工具定义 */
export interface Tool {
	readonly name: string;
	readonly description: string;
	readonly parameters: z.ZodSchema;
	readonly execute: (args: unknown) => Promise<ToolResult>;
}

/** 工具调用请求（来自 LLM） */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** 工具执行结果 */
export interface ToolResult {
	readonly toolCallId: string;
	readonly content: string;
	readonly isError: boolean;
}
