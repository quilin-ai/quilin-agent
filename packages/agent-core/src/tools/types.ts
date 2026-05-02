import type { z } from "zod";
import type { SandboxPolicy } from "./sandbox.js";

export type ToolErrorCode =
	| "tool_not_found"
	| "tool_ambiguous"
	| "invalid_arguments"
	| "sandbox_approval_required"
	| "sandbox_denied"
	| "execution_failed"
	| "timeout"
	| "upstream_error";

export interface ToolError {
	readonly code: ToolErrorCode;
	readonly message: string;
	readonly retryable?: boolean;
	readonly details?: Record<string, unknown>;
}

export type ToolInvocationAuditOutcome =
	| "success"
	| "tool_error"
	| "sandbox_ask"
	| "sandbox_deny"
	| "unknown_error";

export interface ToolInvocationAuditSummary {
	readonly tool: string;
	readonly call: string;
	readonly outcome: ToolInvocationAuditOutcome;
	readonly errorCode?: string;
	readonly retryable?: boolean;
	readonly sandboxKind?: string;
	readonly sandboxOrigin?: string;
	readonly requiredApprovals?: readonly string[];
	readonly reasonCodes?: readonly string[];
	readonly summary: string;
	readonly detail: string;
}

export interface ToolInvocationAuditBatchSummary {
	readonly total: number;
	readonly byOutcome: Readonly<Record<ToolInvocationAuditOutcome, number>>;
	readonly byTool: Readonly<Record<string, number>>;
	readonly reasonCodes: Readonly<Record<string, number>>;
	readonly blockedCallIds: readonly string[];
}

export interface ToolResultAuditBatchSummary
	extends ToolInvocationAuditBatchSummary {
	readonly missingAuditResultIds: readonly string[];
}

export type ToolResultAuditReadinessStatus = "complete" | "partial" | "missing";

export interface ToolResultAuditReadinessSummary {
	readonly status: ToolResultAuditReadinessStatus;
	readonly total: number;
	readonly auditedTotal: number;
	readonly missingTotal: number;
	readonly missingAuditResultIds: readonly string[];
}

export interface ToolResultAuditReport {
	readonly audit: ToolResultAuditBatchSummary;
	readonly readiness: ToolResultAuditReadinessSummary;
}

export type ToolResultAuditReportHealthStatus =
	| "clean"
	| "blocked"
	| "incomplete"
	| "failed";

export interface ToolResultAuditReportHealthSummary {
	readonly status: ToolResultAuditReportHealthStatus;
	readonly total: number;
	readonly auditedTotal: number;
	readonly failedTotal: number;
	readonly blockedTotal: number;
	readonly missingTotal: number;
}

export interface ToolResultAuditReportHealthBatchSummary {
	readonly status: ToolResultAuditReportHealthStatus;
	readonly byStatus: Readonly<
		Record<ToolResultAuditReportHealthStatus, number>
	>;
	readonly total: number;
	readonly auditedTotal: number;
	readonly failedTotal: number;
	readonly blockedTotal: number;
	readonly missingTotal: number;
}

/** 工具定义 */
export interface Tool {
	readonly name: string;
	readonly description: string;
	readonly parameters: z.ZodSchema;
	readonly sandboxPolicy?: SandboxPolicy;
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
	readonly error?: ToolError;
	readonly audit?: ToolInvocationAuditSummary;
}
