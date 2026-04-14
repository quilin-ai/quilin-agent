import type { Tool, ToolCall, ToolResult } from "./types.js";

export class ToolRouter {
	constructor(private readonly tools: readonly Tool[]) {}

	async execute(call: ToolCall): Promise<ToolResult> {
		void call;
		void this.tools;
		throw new Error("Not implemented");
	}
}
