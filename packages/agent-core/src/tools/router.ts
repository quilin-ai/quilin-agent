import type { Tool, ToolCall, ToolResult } from "./types.js";

function createErrorResult(toolCallId: string, error: string): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify({ error }),
		isError: true,
	};
}

export class ToolRouter {
	constructor(private readonly tools: readonly Tool[]) {}

	async execute(call: ToolCall): Promise<ToolResult> {
		const tool = this.tools.find((candidate) => candidate.name === call.name);

		if (tool == null) {
			return createErrorResult(call.id, `Tool not found: ${call.name}`);
		}

		const parsedArgs = tool.parameters.safeParse(call.arguments);
		if (!parsedArgs.success) {
			return createErrorResult(call.id, parsedArgs.error.message);
		}

		try {
			const result = await tool.execute(parsedArgs.data);
			return {
				toolCallId: call.id,
				content: result.content,
				isError: result.isError,
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Tool execution failed";
			return createErrorResult(call.id, message);
		}
	}
}
