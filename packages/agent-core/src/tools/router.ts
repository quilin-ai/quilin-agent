import type { ToolWithMetadata } from "./tool-metadata.js";
import type { Tool, ToolCall, ToolResult } from "./types.js";

function createErrorResult(toolCallId: string, error: string): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify({ error }),
		isError: true,
	};
}

function getShortName(tool: Tool | ToolWithMetadata): string {
	const slashIndex = tool.name.indexOf("/");
	return slashIndex === -1 ? tool.name : tool.name.slice(slashIndex + 1);
}

export class ToolRouter {
	constructor(private readonly tools: readonly (Tool | ToolWithMetadata)[]) {}

	async execute(call: ToolCall): Promise<ToolResult> {
		const exactMatch = this.tools.find(
			(candidate) => candidate.name === call.name,
		);
		const shortNameMatches =
			exactMatch == null
				? this.tools.filter(
						(candidate) => getShortName(candidate) === call.name,
					)
				: [];
		const tool =
			exactMatch ??
			(shortNameMatches.length === 1 ? shortNameMatches[0] : undefined);

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
