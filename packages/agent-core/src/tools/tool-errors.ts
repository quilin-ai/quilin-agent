import type { ToolError, ToolErrorCode, ToolResult } from "./types.js";

export interface CreateToolErrorOptions {
	readonly code: ToolErrorCode;
	readonly message: string;
	readonly retryable?: boolean;
	readonly details?: Record<string, unknown>;
}

export interface CreateToolErrorResultOptions extends CreateToolErrorOptions {
	readonly toolCallId: string;
}

const TIMEOUT_ERROR_NAMES = new Set([
	"AbortError",
	"MCPTimeoutError",
	"TimeoutError",
]);

export function createToolError(options: CreateToolErrorOptions): ToolError {
	return {
		code: options.code,
		message: options.message,
		...(options.retryable == null ? {} : { retryable: options.retryable }),
		...(options.details == null ? {} : { details: options.details }),
	};
}

export function createToolErrorResult(
	options: CreateToolErrorResultOptions,
): ToolResult {
	const error = createToolError(options);
	const payload: Record<string, unknown> = {
		error: error.message,
		code: error.code,
	};

	if (error.retryable != null) {
		payload.retryable = error.retryable;
	}
	if (error.details != null) {
		payload.details = error.details;
	}

	return {
		toolCallId: options.toolCallId,
		content: JSON.stringify(payload),
		isError: true,
		error,
	};
}

export function classifyToolException(error: unknown): ToolErrorCode {
	return error instanceof Error && TIMEOUT_ERROR_NAMES.has(error.name)
		? "timeout"
		: "execution_failed";
}

export function toolExceptionMessage(error: unknown): string {
	return classifyToolException(error) === "timeout"
		? "Tool execution timed out."
		: "Tool execution failed.";
}
