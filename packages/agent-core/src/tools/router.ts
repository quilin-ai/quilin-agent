import {
	createSandboxApprovalSummary,
	defaultSandboxEvaluator,
	genericSandboxPolicy,
	resolveSandboxPolicy,
	type SandboxApprovalSummary,
	type SandboxDecision,
	type SandboxEvaluator,
	type SandboxOrigin,
	type SandboxPolicy,
	type SandboxToolContext,
} from "./sandbox.js";
import {
	classifyToolException,
	createToolErrorResult,
	toolExceptionMessage,
} from "./tool-errors.js";
import type { ToolWithMetadata } from "./tool-metadata.js";
import type {
	Tool,
	ToolCall,
	ToolError,
	ToolInvocationAuditBatchSummary,
	ToolInvocationAuditOutcome,
	ToolInvocationAuditSummary,
	ToolResult,
	ToolResultAuditBatchSummary,
	ToolResultAuditReadinessStatus,
	ToolResultAuditReadinessSummary,
	ToolResultAuditReport,
	ToolResultAuditReportHealthBatchSummary,
	ToolResultAuditReportHealthStatus,
	ToolResultAuditReportHealthSummary,
} from "./types.js";

export type {
	ToolInvocationAuditBatchSummary,
	ToolInvocationAuditOutcome,
	ToolInvocationAuditSummary,
	ToolResultAuditBatchSummary,
	ToolResultAuditReadinessStatus,
	ToolResultAuditReadinessSummary,
	ToolResultAuditReport,
	ToolResultAuditReportHealthBatchSummary,
	ToolResultAuditReportHealthStatus,
	ToolResultAuditReportHealthSummary,
} from "./types.js";

export interface ToolRouterOptions {
	readonly sandboxEvaluator?: SandboxEvaluator;
	readonly sandboxPolicy?: SandboxPolicy;
	readonly sandboxOrigin?: SandboxOrigin;
	readonly sandboxApproval?: SandboxApprovalHandler;
}

export interface SandboxApprovalRequest {
	readonly decision: SandboxDecision;
	readonly context: SandboxToolContext;
	readonly summary: SandboxApprovalSummary;
}

export interface ToolInvocationAuditInput {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly outcome: ToolInvocationAuditOutcome;
	readonly errorDetails?: ToolError | Record<string, unknown>;
	readonly approvalSummary?: SandboxApprovalSummary;
}

export type SandboxApprovalHandler = (
	request: SandboxApprovalRequest,
) => boolean | Promise<boolean>;

interface SandboxEvaluationResult {
	readonly blockedResult?: ToolResult;
	readonly approvedSummary?: SandboxApprovalSummary;
}

function getShortName(tool: Tool | ToolWithMetadata): string {
	const slashIndex = tool.name.indexOf("/");
	return slashIndex === -1 ? tool.name : tool.name.slice(slashIndex + 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function formatAuditList(values: readonly string[]): string {
	return values.length === 0 ? "none" : values.join(",");
}

function auditSummaryText(
	outcome: ToolInvocationAuditOutcome,
	toolName: string,
	errorCode: string | undefined,
): string {
	switch (outcome) {
		case "success":
			return `Tool ${toolName} completed successfully.`;
		case "sandbox_ask":
			return `Tool ${toolName} requires sandbox approval.`;
		case "sandbox_deny":
			return `Tool ${toolName} was denied by sandbox policy.`;
		case "unknown_error":
			return `Tool ${toolName} failed with an unknown error.`;
		case "tool_error":
			return errorCode == null
				? `Tool ${toolName} failed.`
				: `Tool ${toolName} failed with ${errorCode}.`;
	}
}

function compareAuditKey(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	return left < right ? -1 : 1;
}

function incrementAuditCount(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedAuditCountRecord(
	counts: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
	return Object.fromEntries(
		[...counts.entries()].sort(([left], [right]) =>
			compareAuditKey(left, right),
		),
	) as Readonly<Record<string, number>>;
}

function createEmptyAuditOutcomeCounts(): Record<
	ToolInvocationAuditOutcome,
	number
> {
	return {
		success: 0,
		tool_error: 0,
		sandbox_ask: 0,
		sandbox_deny: 0,
		unknown_error: 0,
	};
}

function createEmptyAuditReportHealthStatusCounts(): Record<
	ToolResultAuditReportHealthStatus,
	number
> {
	return {
		clean: 0,
		blocked: 0,
		incomplete: 0,
		failed: 0,
	};
}

export function createToolInvocationAuditSummary(
	input: ToolInvocationAuditInput,
): ToolInvocationAuditSummary {
	const errorDetails = asRecord(input.errorDetails);
	const nestedDetails = asRecord(errorDetails?.details);
	const approvalSummary =
		input.approvalSummary ?? asRecord(nestedDetails?.approvalSummary);
	const decision = asRecord(nestedDetails?.decision);
	const requiredApprovalsSource =
		approvalSummary?.requiredApprovals ?? decision?.requiredApprovals;
	const reasonCodesSource =
		approvalSummary?.reasonCodes ?? decision?.reasonCodes;
	const errorCode = stringValue(errorDetails?.code);
	const retryable = booleanValue(errorDetails?.retryable);
	const sandboxKind =
		stringValue(approvalSummary?.kind) ?? stringValue(decision?.kind);
	const sandboxOrigin = stringValue(approvalSummary?.origin);
	const requiredApprovals = stringArray(requiredApprovalsSource);
	const reasonCodes = stringArray(reasonCodesSource);
	const detailParts = [
		`tool=${input.toolName}`,
		`call=${input.toolCallId}`,
		`outcome=${input.outcome}`,
	];

	if (errorCode != null) {
		detailParts.push(`code=${errorCode}`);
	}
	if (retryable != null) {
		detailParts.push(`retryable=${retryable}`);
	}
	if (sandboxKind != null) {
		detailParts.push(`sandboxKind=${sandboxKind}`);
	}
	if (sandboxOrigin != null) {
		detailParts.push(`sandboxOrigin=${sandboxOrigin}`);
	}
	if (Array.isArray(requiredApprovalsSource)) {
		detailParts.push(`requiredApprovals=${formatAuditList(requiredApprovals)}`);
	}
	if (Array.isArray(reasonCodesSource)) {
		detailParts.push(`reasonCodes=${formatAuditList(reasonCodes)}`);
	}

	return {
		tool: input.toolName,
		call: input.toolCallId,
		outcome: input.outcome,
		...(errorCode == null ? {} : { errorCode }),
		...(retryable == null ? {} : { retryable }),
		...(sandboxKind == null ? {} : { sandboxKind }),
		...(sandboxOrigin == null ? {} : { sandboxOrigin }),
		...(Array.isArray(requiredApprovalsSource) ? { requiredApprovals } : {}),
		...(Array.isArray(reasonCodesSource) ? { reasonCodes } : {}),
		summary: auditSummaryText(input.outcome, input.toolName, errorCode),
		detail: detailParts.join("; "),
	};
}

export function summarizeToolInvocationAudits(
	audits: readonly ToolInvocationAuditSummary[],
): ToolInvocationAuditBatchSummary {
	const byOutcome = createEmptyAuditOutcomeCounts();
	const toolCounts = new Map<string, number>();
	const reasonCodeCounts = new Map<string, number>();
	const blockedCallIds: string[] = [];

	for (const audit of audits) {
		byOutcome[audit.outcome] += 1;
		incrementAuditCount(toolCounts, audit.tool);

		for (const reasonCode of audit.reasonCodes ?? []) {
			incrementAuditCount(reasonCodeCounts, reasonCode);
		}

		if (audit.outcome === "sandbox_ask" || audit.outcome === "sandbox_deny") {
			blockedCallIds.push(audit.call);
		}
	}

	return {
		total: audits.length,
		byOutcome,
		byTool: sortedAuditCountRecord(toolCounts),
		reasonCodes: sortedAuditCountRecord(reasonCodeCounts),
		blockedCallIds: [...blockedCallIds].sort(compareAuditKey),
	};
}

export function summarizeToolResultAudits(
	results: readonly ToolResult[],
): ToolResultAuditBatchSummary {
	const audits: ToolInvocationAuditSummary[] = [];
	const missingAuditResultIds: string[] = [];

	for (const result of results) {
		if (result.audit == null) {
			missingAuditResultIds.push(result.toolCallId);
			continue;
		}

		audits.push(result.audit);
	}

	return {
		...summarizeToolInvocationAudits(audits),
		missingAuditResultIds: [...missingAuditResultIds].sort(compareAuditKey),
	};
}

export function summarizeToolResultAuditReadiness(
	summary: ToolResultAuditBatchSummary,
): ToolResultAuditReadinessSummary {
	const auditedTotal = summary.total;
	const missingAuditResultIds = [...summary.missingAuditResultIds].sort(
		compareAuditKey,
	);
	const missingTotal = missingAuditResultIds.length;
	const status: ToolResultAuditReadinessStatus =
		auditedTotal === 0
			? "missing"
			: missingTotal === 0
				? "complete"
				: "partial";

	return {
		status,
		total: auditedTotal + missingTotal,
		auditedTotal,
		missingTotal,
		missingAuditResultIds,
	};
}

export function summarizeToolResultAuditReport(
	results: readonly ToolResult[],
): ToolResultAuditReport {
	const audit = summarizeToolResultAudits(results);

	return {
		audit,
		readiness: summarizeToolResultAuditReadiness(audit),
	};
}

export function summarizeToolResultAuditReportHealth(
	report: ToolResultAuditReport,
): ToolResultAuditReportHealthSummary {
	const failedTotal =
		report.audit.byOutcome.tool_error + report.audit.byOutcome.unknown_error;
	const blockedOutcomeTotal =
		report.audit.byOutcome.sandbox_ask + report.audit.byOutcome.sandbox_deny;
	const blockedTotal = Math.max(
		blockedOutcomeTotal,
		report.audit.blockedCallIds.length,
	);
	const missingTotal = report.audit.missingAuditResultIds.length;
	const status: ToolResultAuditReportHealthStatus =
		failedTotal > 0
			? "failed"
			: blockedTotal > 0
				? "blocked"
				: missingTotal > 0
					? "incomplete"
					: "clean";

	return {
		status,
		total: report.audit.total + missingTotal,
		auditedTotal: report.audit.total,
		failedTotal,
		blockedTotal,
		missingTotal,
	};
}

export function summarizeToolResultAuditReportHealthBatch(
	summaries: Iterable<ToolResultAuditReportHealthSummary>,
): ToolResultAuditReportHealthBatchSummary {
	const byStatus = createEmptyAuditReportHealthStatusCounts();
	let total = 0;
	let auditedTotal = 0;
	let failedTotal = 0;
	let blockedTotal = 0;
	let missingTotal = 0;

	for (const summary of summaries) {
		byStatus[summary.status] += 1;
		total += summary.total;
		auditedTotal += summary.auditedTotal;
		failedTotal += summary.failedTotal;
		blockedTotal += summary.blockedTotal;
		missingTotal += summary.missingTotal;
	}

	const status: ToolResultAuditReportHealthStatus =
		byStatus.failed > 0
			? "failed"
			: byStatus.blocked > 0
				? "blocked"
				: byStatus.incomplete > 0
					? "incomplete"
					: "clean";

	return {
		status,
		byStatus,
		total,
		auditedTotal,
		failedTotal,
		blockedTotal,
		missingTotal,
	};
}

function auditOutcomeForError(
	error: ToolError | undefined,
): ToolInvocationAuditOutcome {
	switch (error?.code) {
		case "sandbox_approval_required":
			return "sandbox_ask";
		case "sandbox_denied":
			return "sandbox_deny";
		default:
			return "tool_error";
	}
}

function withInvocationAudit(
	toolCallId: string,
	toolName: string,
	result: ToolResult,
	outcome: ToolInvocationAuditOutcome = result.isError
		? auditOutcomeForError(result.error)
		: "success",
	approvalSummary?: SandboxApprovalSummary,
): ToolResult {
	return {
		...result,
		audit: createToolInvocationAuditSummary({
			toolCallId,
			toolName,
			outcome,
			...(approvalSummary == null ? {} : { approvalSummary }),
			...(result.error == null ? {} : { errorDetails: result.error }),
		}),
	};
}

function createRouterErrorResult(options: {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly code: ToolError["code"];
	readonly message: string;
	readonly retryable?: boolean;
	readonly details?: Record<string, unknown>;
	readonly outcome?: ToolInvocationAuditOutcome;
	readonly approvalSummary?: SandboxApprovalSummary;
}): ToolResult {
	return withInvocationAudit(
		options.toolCallId,
		options.toolName,
		createToolErrorResult({
			toolCallId: options.toolCallId,
			code: options.code,
			message: options.message,
			...(options.retryable == null ? {} : { retryable: options.retryable }),
			...(options.details == null ? {} : { details: options.details }),
		}),
		options.outcome,
		options.approvalSummary,
	);
}

function normalizeToolResult(
	toolCallId: string,
	toolName: string,
	result: ToolResult,
	approvalSummary?: SandboxApprovalSummary,
): ToolResult {
	const normalized = {
		toolCallId,
		content: result.content,
		isError: result.isError,
	};

	if (result.isError && result.error != null) {
		return withInvocationAudit(
			toolCallId,
			toolName,
			{
				...normalized,
				error: result.error,
			},
			auditOutcomeForError(result.error),
			approvalSummary,
		);
	}

	return withInvocationAudit(
		toolCallId,
		toolName,
		normalized,
		"success",
		approvalSummary,
	);
}

function validationIssues(error: { issues: readonly unknown[] }): {
	readonly issues: readonly Record<string, unknown>[];
} {
	return {
		issues: error.issues.map((issue) => {
			const record = issue as {
				readonly code?: unknown;
				readonly path?: readonly unknown[];
				readonly message?: unknown;
			};
			return {
				code: record.code,
				path: record.path?.map(String) ?? [],
				message: record.message,
			};
		}),
	};
}

function metadataFor(tool: Tool | ToolWithMetadata): {
	readonly category?: string;
	readonly riskLevel?: string;
	readonly namespace?: string;
	readonly sandboxOperation?: SandboxToolContext["sandboxOperation"];
	readonly sandboxSignals?: SandboxToolContext["sandboxSignals"];
} {
	if (!("riskLevel" in tool)) {
		return {};
	}

	return {
		category: tool.category,
		riskLevel: tool.riskLevel,
		...(tool.namespace == null ? {} : { namespace: tool.namespace }),
		...(tool.sandboxOperation == null
			? {}
			: { sandboxOperation: tool.sandboxOperation }),
		...(tool.sandboxSignals == null
			? {}
			: { sandboxSignals: tool.sandboxSignals }),
	};
}

function sandboxBlockedResult(
	toolCallId: string,
	decision: SandboxDecision,
	context: SandboxToolContext,
	approvalSummary: SandboxApprovalSummary = createSandboxApprovalSummary(
		decision,
		context,
	),
): ToolResult {
	const approvalRequired = decision.kind === "ask";
	return createRouterErrorResult({
		toolCallId,
		toolName: context.resolvedToolName,
		code: approvalRequired ? "sandbox_approval_required" : "sandbox_denied",
		message: approvalRequired
			? "Tool execution requires sandbox approval."
			: "Tool execution denied by sandbox policy.",
		details: {
			decision,
			approvalSummary,
		},
		outcome: approvalRequired ? "sandbox_ask" : "sandbox_deny",
	});
}

export class ToolRouter {
	constructor(
		private readonly tools: readonly (Tool | ToolWithMetadata)[],
		private readonly options: ToolRouterOptions = {},
	) {}

	private async evaluateSandbox(
		tool: Tool | ToolWithMetadata,
		call: ToolCall,
		parsedArguments: unknown,
	): Promise<SandboxEvaluationResult> {
		const policy =
			tool.sandboxPolicy ??
			this.options.sandboxPolicy ??
			(this.options.sandboxEvaluator == null
				? undefined
				: genericSandboxPolicy);

		if (policy == null) {
			return {};
		}

		const context: SandboxToolContext = {
			toolCallId: call.id,
			requestedToolName: call.name,
			resolvedToolName: tool.name,
			parsedArguments,
			...(this.options.sandboxOrigin == null
				? {}
				: { origin: this.options.sandboxOrigin }),
			...metadataFor(tool),
		};
		const request = await resolveSandboxPolicy(policy, context);

		if (request == null) {
			return {};
		}

		const evaluator = this.options.sandboxEvaluator ?? defaultSandboxEvaluator;
		const decision = await evaluator(request, context);

		if (decision.kind === "allow") {
			return {};
		}

		const approvalSummary = createSandboxApprovalSummary(decision, context);
		if (decision.kind === "ask" && this.options.sandboxApproval != null) {
			let approved = false;
			try {
				approved = await this.options.sandboxApproval({
					decision,
					context,
					summary: approvalSummary,
				});
			} catch {
				approved = false;
			}
			if (approved) {
				return { approvedSummary: approvalSummary };
			}
		}

		return {
			blockedResult: sandboxBlockedResult(
				call.id,
				decision,
				context,
				approvalSummary,
			),
		};
	}

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

		if (exactMatch == null && shortNameMatches.length > 1) {
			return createRouterErrorResult({
				toolCallId: call.id,
				toolName: call.name,
				code: "tool_ambiguous",
				message: `Tool name is ambiguous: ${call.name}`,
				details: {
					matches: shortNameMatches.map((candidate) => candidate.name),
				},
			});
		}

		if (tool == null) {
			return createRouterErrorResult({
				toolCallId: call.id,
				toolName: call.name,
				code: "tool_not_found",
				message: `Tool not found: ${call.name}`,
			});
		}

		const parsedArgs = tool.parameters.safeParse(call.arguments);
		if (!parsedArgs.success) {
			return createRouterErrorResult({
				toolCallId: call.id,
				toolName: tool.name,
				code: "invalid_arguments",
				message: parsedArgs.error.message,
				details: validationIssues(parsedArgs.error),
			});
		}

		let approvedSummary: SandboxApprovalSummary | undefined;
		try {
			const sandboxEvaluation = await this.evaluateSandbox(
				tool,
				call,
				parsedArgs.data,
			);
			if (sandboxEvaluation.blockedResult != null) {
				return sandboxEvaluation.blockedResult;
			}
			approvedSummary = sandboxEvaluation.approvedSummary;

			const result = await tool.execute(parsedArgs.data);
			return normalizeToolResult(call.id, tool.name, result, approvedSummary);
		} catch (error) {
			const code = classifyToolException(error);
			return createRouterErrorResult({
				toolCallId: call.id,
				toolName: tool.name,
				code,
				message: toolExceptionMessage(error),
				...(code === "timeout" ? { retryable: true } : {}),
				outcome: error instanceof Error ? "tool_error" : "unknown_error",
				approvalSummary: approvedSummary,
			});
		}
	}
}
