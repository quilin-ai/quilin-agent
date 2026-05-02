import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createFileListTool,
	createFileReadTool,
	createFileWriteTool,
} from "./builtin/file-tools.js";
import { createShellExecTool } from "./builtin/shell-exec.js";
import { createWebFetchTool } from "./builtin/web-fetch.js";
import {
	createToolInvocationAuditSummary,
	summarizeToolInvocationAudits,
	summarizeToolResultAuditReadiness,
	summarizeToolResultAuditReport,
	summarizeToolResultAuditReportHealth,
	summarizeToolResultAuditReportHealthBatch,
	summarizeToolResultAudits,
	type ToolInvocationAuditBatchSummary,
	type ToolInvocationAuditInput,
	type ToolInvocationAuditSummary,
	type ToolResultAuditBatchSummary,
	type ToolResultAuditReadinessSummary,
	type ToolResultAuditReport,
	type ToolResultAuditReportHealthBatchSummary,
	type ToolResultAuditReportHealthSummary,
	ToolRouter,
} from "./router.js";
import { defaultSandboxEvaluator, type SandboxEvaluator } from "./sandbox.js";
import type { ToolWithMetadata } from "./tool-metadata.js";

describe("ToolRouter", () => {
	it("exposes invocation audit helper and types from the router public export", () => {
		const input: ToolInvocationAuditInput = {
			toolName: "memory_store",
			toolCallId: "call-public-audit",
			outcome: "success",
		};

		const audit: ToolInvocationAuditSummary =
			createToolInvocationAuditSummary(input);

		expect(audit).toEqual({
			tool: "memory_store",
			call: "call-public-audit",
			outcome: "success",
			summary: "Tool memory_store completed successfully.",
			detail: "tool=memory_store; call=call-public-audit; outcome=success",
		});
	});

	it("creates deterministic invocation audit summaries without raw argument fields", () => {
		const audit = createToolInvocationAuditSummary({
			toolName: "file_write",
			toolCallId: "call-audit",
			outcome: "tool_error",
			errorDetails: {
				code: "execution_failed",
				message: "write failed for top-secret.txt",
				details: {
					rawArguments: { path: "top-secret.txt" },
					parsedArguments: { path: "top-secret.txt" },
				},
			},
		});

		expect(audit).toEqual({
			tool: "file_write",
			call: "call-audit",
			outcome: "tool_error",
			errorCode: "execution_failed",
			summary: "Tool file_write failed with execution_failed.",
			detail:
				"tool=file_write; call=call-audit; outcome=tool_error; code=execution_failed",
		});
		expect(JSON.stringify(audit)).not.toContain("top-secret");
		expect(JSON.stringify(audit)).not.toContain("rawArguments");
		expect(JSON.stringify(audit)).not.toContain("parsedArguments");
	});

	it("summarizes an empty invocation audit batch", () => {
		const batch: ToolInvocationAuditBatchSummary =
			summarizeToolInvocationAudits([]);

		expect(batch).toEqual({
			total: 0,
			byOutcome: {
				success: 0,
				tool_error: 0,
				sandbox_ask: 0,
				sandbox_deny: 0,
				unknown_error: 0,
			},
			byTool: {},
			reasonCodes: {},
			blockedCallIds: [],
		});
	});

	it("summarizes mixed success, error, and sandbox audit batches", () => {
		const batch = summarizeToolInvocationAudits([
			{
				tool: "web_fetch",
				call: "call-error",
				outcome: "tool_error",
				errorCode: "upstream_error",
				summary: "Tool web_fetch failed with upstream_error.",
				detail:
					"tool=web_fetch; call=call-error; outcome=tool_error; code=upstream_error",
			},
			{
				tool: "file_write",
				call: "call-ask",
				outcome: "sandbox_ask",
				errorCode: "sandbox_approval_required",
				sandboxKind: "ask",
				sandboxOrigin: "agent",
				requiredApprovals: ["write_authority", "user_confirmation"],
				reasonCodes: ["write_operation_requires_approval"],
				summary: "Tool file_write requires sandbox approval.",
				detail:
					"tool=file_write; call=call-ask; outcome=sandbox_ask; code=sandbox_approval_required; sandboxKind=ask; sandboxOrigin=agent; requiredApprovals=write_authority,user_confirmation; reasonCodes=write_operation_requires_approval",
			},
			{
				tool: "memory_store",
				call: "call-success",
				outcome: "success",
				summary: "Tool memory_store completed successfully.",
				detail: "tool=memory_store; call=call-success; outcome=success",
			},
			{
				tool: "file_read",
				call: "call-deny",
				outcome: "sandbox_deny",
				errorCode: "sandbox_denied",
				sandboxKind: "deny",
				sandboxOrigin: "unknown",
				requiredApprovals: [],
				reasonCodes: ["critical_operation_denied"],
				summary: "Tool file_read was denied by sandbox policy.",
				detail:
					"tool=file_read; call=call-deny; outcome=sandbox_deny; code=sandbox_denied; sandboxKind=deny; sandboxOrigin=unknown; requiredApprovals=none; reasonCodes=critical_operation_denied",
			},
		]);

		expect(batch).toEqual({
			total: 4,
			byOutcome: {
				success: 1,
				tool_error: 1,
				sandbox_ask: 1,
				sandbox_deny: 1,
				unknown_error: 0,
			},
			byTool: {
				file_read: 1,
				file_write: 1,
				memory_store: 1,
				web_fetch: 1,
			},
			reasonCodes: {
				critical_operation_denied: 1,
				write_operation_requires_approval: 1,
			},
			blockedCallIds: ["call-ask", "call-deny"],
		});
	});

	it("keeps invocation audit batch summaries stable across input order", () => {
		const auditA: ToolInvocationAuditSummary = {
			tool: "z_tool",
			call: "call-z",
			outcome: "sandbox_deny",
			reasonCodes: ["z_reason", "a_reason"],
			summary: "Tool z_tool was denied by sandbox policy.",
			detail:
				"tool=z_tool; call=call-z; outcome=sandbox_deny; reasonCodes=z_reason,a_reason",
		};
		const auditB: ToolInvocationAuditSummary = {
			tool: "a_tool",
			call: "call-a",
			outcome: "sandbox_ask",
			reasonCodes: ["a_reason"],
			summary: "Tool a_tool requires sandbox approval.",
			detail:
				"tool=a_tool; call=call-a; outcome=sandbox_ask; reasonCodes=a_reason",
		};
		const auditC: ToolInvocationAuditSummary = {
			tool: "z_tool",
			call: "call-success",
			outcome: "success",
			summary: "Tool z_tool completed successfully.",
			detail: "tool=z_tool; call=call-success; outcome=success",
		};

		const first = summarizeToolInvocationAudits([auditA, auditB, auditC]);
		const second = summarizeToolInvocationAudits([auditC, auditB, auditA]);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(JSON.stringify(first)).toBe(
			JSON.stringify({
				total: 3,
				byOutcome: {
					success: 1,
					tool_error: 0,
					sandbox_ask: 1,
					sandbox_deny: 1,
					unknown_error: 0,
				},
				byTool: {
					a_tool: 1,
					z_tool: 2,
				},
				reasonCodes: {
					a_reason: 2,
					z_reason: 1,
				},
				blockedCallIds: ["call-a", "call-z"],
			}),
		);
	});

	it("does not leak raw or parsed arguments through batch summaries", () => {
		const auditWithRawFields = {
			tool: "file_write",
			call: "call-leak-check",
			outcome: "tool_error",
			errorCode: "execution_failed",
			rawArguments: { path: "top-secret.txt" },
			parsedArguments: { path: "top-secret.txt" },
			summary: "Tool file_write failed with top-secret.txt.",
			detail:
				"tool=file_write; call=call-leak-check; outcome=tool_error; path=top-secret.txt",
		} satisfies ToolInvocationAuditSummary & {
			readonly parsedArguments: Record<string, string>;
			readonly rawArguments: Record<string, string>;
		};

		const batch = summarizeToolInvocationAudits([auditWithRawFields]);

		expect(batch).toEqual({
			total: 1,
			byOutcome: {
				success: 0,
				tool_error: 1,
				sandbox_ask: 0,
				sandbox_deny: 0,
				unknown_error: 0,
			},
			byTool: {
				file_write: 1,
			},
			reasonCodes: {},
			blockedCallIds: [],
		});
		expect(JSON.stringify(batch)).not.toContain("top-secret");
		expect(JSON.stringify(batch)).not.toContain("rawArguments");
		expect(JSON.stringify(batch)).not.toContain("parsedArguments");
	});

	it("summarizes result audits and reports missing audit result identifiers", () => {
		const batch: ToolResultAuditBatchSummary = summarizeToolResultAudits([
			{
				toolCallId: "call-missing-z",
				content: JSON.stringify({
					rawArguments: { path: "top-secret.txt" },
					parsedArguments: { path: "top-secret.txt" },
				}),
				isError: false,
			},
			{
				toolCallId: "call-ask",
				content: JSON.stringify({ error: "approval required" }),
				isError: true,
				audit: {
					tool: "file_write",
					call: "call-ask",
					outcome: "sandbox_ask",
					errorCode: "sandbox_approval_required",
					reasonCodes: ["write_operation_requires_approval"],
					summary: "Tool file_write requires sandbox approval.",
					detail:
						"tool=file_write; call=call-ask; outcome=sandbox_ask; code=sandbox_approval_required; reasonCodes=write_operation_requires_approval",
				},
			},
			{
				toolCallId: "call-missing-a",
				content: "raw top-secret content",
				isError: true,
			},
			{
				toolCallId: "call-success",
				content: JSON.stringify({ ok: true }),
				isError: false,
				audit: {
					tool: "memory_store",
					call: "call-success",
					outcome: "success",
					summary: "Tool memory_store completed successfully.",
					detail: "tool=memory_store; call=call-success; outcome=success",
				},
			},
		]);

		expect(batch).toEqual({
			total: 2,
			byOutcome: {
				success: 1,
				tool_error: 0,
				sandbox_ask: 1,
				sandbox_deny: 0,
				unknown_error: 0,
			},
			byTool: {
				file_write: 1,
				memory_store: 1,
			},
			reasonCodes: {
				write_operation_requires_approval: 1,
			},
			blockedCallIds: ["call-ask"],
			missingAuditResultIds: ["call-missing-a", "call-missing-z"],
		});
		expect(JSON.stringify(batch)).not.toContain("top-secret");
		expect(JSON.stringify(batch)).not.toContain("rawArguments");
		expect(JSON.stringify(batch)).not.toContain("parsedArguments");
	});

	it("keeps result audit batch summaries stable across input order", () => {
		const auditedAsk = {
			toolCallId: "call-a",
			content: JSON.stringify({ error: "approval required" }),
			isError: true,
			audit: {
				tool: "a_tool",
				call: "call-a",
				outcome: "sandbox_ask",
				reasonCodes: ["b_reason", "a_reason"],
				summary: "Tool a_tool requires sandbox approval.",
				detail:
					"tool=a_tool; call=call-a; outcome=sandbox_ask; reasonCodes=b_reason,a_reason",
			},
		} as const;
		const auditedSuccess = {
			toolCallId: "call-z",
			content: JSON.stringify({ ok: true }),
			isError: false,
			audit: {
				tool: "z_tool",
				call: "call-z",
				outcome: "success",
				summary: "Tool z_tool completed successfully.",
				detail: "tool=z_tool; call=call-z; outcome=success",
			},
		} as const;
		const missingA = {
			toolCallId: "call-missing-a",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;
		const missingZ = {
			toolCallId: "call-missing-z",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;

		const first = summarizeToolResultAudits([
			auditedSuccess,
			missingZ,
			auditedAsk,
			missingA,
		]);
		const second = summarizeToolResultAudits([
			missingA,
			auditedAsk,
			missingZ,
			auditedSuccess,
		]);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first).toEqual({
			total: 2,
			byOutcome: {
				success: 1,
				tool_error: 0,
				sandbox_ask: 1,
				sandbox_deny: 0,
				unknown_error: 0,
			},
			byTool: {
				a_tool: 1,
				z_tool: 1,
			},
			reasonCodes: {
				a_reason: 1,
				b_reason: 1,
			},
			blockedCallIds: ["call-a"],
			missingAuditResultIds: ["call-missing-a", "call-missing-z"],
		});
	});

	it("classifies result audit readiness as complete, partial, or missing", () => {
		const auditedSuccess = {
			toolCallId: "call-success",
			content: JSON.stringify({ ok: true }),
			isError: false,
			audit: {
				tool: "memory_store",
				call: "call-success",
				outcome: "success",
				summary: "Tool memory_store completed successfully.",
				detail: "tool=memory_store; call=call-success; outcome=success",
			},
		} as const;
		const missingA = {
			toolCallId: "call-missing-a",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;
		const missingZ = {
			toolCallId: "call-missing-z",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;

		const complete: ToolResultAuditReadinessSummary =
			summarizeToolResultAuditReadiness(
				summarizeToolResultAudits([auditedSuccess]),
			);
		const partial = summarizeToolResultAuditReadiness(
			summarizeToolResultAudits([missingZ, auditedSuccess, missingA]),
		);
		const missing = summarizeToolResultAuditReadiness(
			summarizeToolResultAudits([missingZ, missingA]),
		);
		const empty = summarizeToolResultAuditReadiness(
			summarizeToolResultAudits([]),
		);

		expect(complete).toEqual({
			status: "complete",
			total: 1,
			auditedTotal: 1,
			missingTotal: 0,
			missingAuditResultIds: [],
		});
		expect(partial).toEqual({
			status: "partial",
			total: 3,
			auditedTotal: 1,
			missingTotal: 2,
			missingAuditResultIds: ["call-missing-a", "call-missing-z"],
		});
		expect(missing).toEqual({
			status: "missing",
			total: 2,
			auditedTotal: 0,
			missingTotal: 2,
			missingAuditResultIds: ["call-missing-a", "call-missing-z"],
		});
		expect(empty).toEqual({
			status: "missing",
			total: 0,
			auditedTotal: 0,
			missingTotal: 0,
			missingAuditResultIds: [],
		});
	});

	it("composes a complete tool result audit report from existing helpers", () => {
		const results = [
			{
				toolCallId: "call-success",
				content: JSON.stringify({ ok: true }),
				isError: false,
				audit: {
					tool: "memory_store",
					call: "call-success",
					outcome: "success",
					summary: "Tool memory_store completed successfully.",
					detail: "tool=memory_store; call=call-success; outcome=success",
				},
			},
		] as const;

		const audit = summarizeToolResultAudits(results);
		const readiness = summarizeToolResultAuditReadiness(audit);
		const report: ToolResultAuditReport =
			summarizeToolResultAuditReport(results);

		expect(report).toEqual({
			audit: {
				total: 1,
				byOutcome: {
					success: 1,
					tool_error: 0,
					sandbox_ask: 0,
					sandbox_deny: 0,
					unknown_error: 0,
				},
				byTool: {
					memory_store: 1,
				},
				reasonCodes: {},
				blockedCallIds: [],
				missingAuditResultIds: [],
			},
			readiness: {
				status: "complete",
				total: 1,
				auditedTotal: 1,
				missingTotal: 0,
				missingAuditResultIds: [],
			},
		});
		expect(report).toEqual({ audit, readiness });
	});

	it("composes a partial tool result audit report with missing audit ids", () => {
		const results = [
			{
				toolCallId: "call-missing-z",
				content: JSON.stringify({ ok: true }),
				isError: false,
			},
			{
				toolCallId: "call-ask",
				content: JSON.stringify({ error: "approval required" }),
				isError: true,
				audit: {
					tool: "file_write",
					call: "call-ask",
					outcome: "sandbox_ask",
					errorCode: "sandbox_approval_required",
					reasonCodes: ["write_operation_requires_approval"],
					summary: "Tool file_write requires sandbox approval.",
					detail:
						"tool=file_write; call=call-ask; outcome=sandbox_ask; code=sandbox_approval_required; reasonCodes=write_operation_requires_approval",
				},
			},
			{
				toolCallId: "call-missing-a",
				content: JSON.stringify({ ok: true }),
				isError: false,
			},
		] as const;

		const audit = summarizeToolResultAudits(results);
		const readiness = summarizeToolResultAuditReadiness(audit);
		const report = summarizeToolResultAuditReport(results);

		expect(report).toEqual({
			audit: {
				total: 1,
				byOutcome: {
					success: 0,
					tool_error: 0,
					sandbox_ask: 1,
					sandbox_deny: 0,
					unknown_error: 0,
				},
				byTool: {
					file_write: 1,
				},
				reasonCodes: {
					write_operation_requires_approval: 1,
				},
				blockedCallIds: ["call-ask"],
				missingAuditResultIds: ["call-missing-a", "call-missing-z"],
			},
			readiness: {
				status: "partial",
				total: 3,
				auditedTotal: 1,
				missingTotal: 2,
				missingAuditResultIds: ["call-missing-a", "call-missing-z"],
			},
		});
		expect(report).toEqual({ audit, readiness });
	});

	it("composes empty and fully missing tool result audit reports", () => {
		const emptyAudit = summarizeToolResultAudits([]);
		const emptyReadiness = summarizeToolResultAuditReadiness(emptyAudit);
		const emptyReport = summarizeToolResultAuditReport([]);
		const missingResults = [
			{
				toolCallId: "call-missing-z",
				content: JSON.stringify({ ok: true }),
				isError: false,
			},
			{
				toolCallId: "call-missing-a",
				content: JSON.stringify({ ok: true }),
				isError: false,
			},
		] as const;
		const missingAudit = summarizeToolResultAudits(missingResults);
		const missingReadiness = summarizeToolResultAuditReadiness(missingAudit);
		const missingReport = summarizeToolResultAuditReport(missingResults);

		expect(emptyReport).toEqual({
			audit: {
				total: 0,
				byOutcome: {
					success: 0,
					tool_error: 0,
					sandbox_ask: 0,
					sandbox_deny: 0,
					unknown_error: 0,
				},
				byTool: {},
				reasonCodes: {},
				blockedCallIds: [],
				missingAuditResultIds: [],
			},
			readiness: {
				status: "missing",
				total: 0,
				auditedTotal: 0,
				missingTotal: 0,
				missingAuditResultIds: [],
			},
		});
		expect(emptyReport).toEqual({
			audit: emptyAudit,
			readiness: emptyReadiness,
		});
		expect(missingReport).toEqual({
			audit: {
				total: 0,
				byOutcome: {
					success: 0,
					tool_error: 0,
					sandbox_ask: 0,
					sandbox_deny: 0,
					unknown_error: 0,
				},
				byTool: {},
				reasonCodes: {},
				blockedCallIds: [],
				missingAuditResultIds: ["call-missing-a", "call-missing-z"],
			},
			readiness: {
				status: "missing",
				total: 2,
				auditedTotal: 0,
				missingTotal: 2,
				missingAuditResultIds: ["call-missing-a", "call-missing-z"],
			},
		});
		expect(missingReport).toEqual({
			audit: missingAudit,
			readiness: missingReadiness,
		});
	});

	it("keeps tool result audit reports stable across input order", () => {
		const auditedAsk = {
			toolCallId: "call-a",
			content: JSON.stringify({ error: "approval required" }),
			isError: true,
			audit: {
				tool: "a_tool",
				call: "call-a",
				outcome: "sandbox_ask",
				reasonCodes: ["b_reason", "a_reason"],
				summary: "Tool a_tool requires sandbox approval.",
				detail:
					"tool=a_tool; call=call-a; outcome=sandbox_ask; reasonCodes=b_reason,a_reason",
			},
		} as const;
		const auditedSuccess = {
			toolCallId: "call-z",
			content: JSON.stringify({ ok: true }),
			isError: false,
			audit: {
				tool: "z_tool",
				call: "call-z",
				outcome: "success",
				summary: "Tool z_tool completed successfully.",
				detail: "tool=z_tool; call=call-z; outcome=success",
			},
		} as const;
		const missingA = {
			toolCallId: "call-missing-a",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;
		const missingZ = {
			toolCallId: "call-missing-z",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;

		const first = summarizeToolResultAuditReport([
			auditedSuccess,
			missingZ,
			auditedAsk,
			missingA,
		]);
		const second = summarizeToolResultAuditReport([
			missingA,
			auditedAsk,
			missingZ,
			auditedSuccess,
		]);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first).toEqual({
			audit: {
				total: 2,
				byOutcome: {
					success: 1,
					tool_error: 0,
					sandbox_ask: 1,
					sandbox_deny: 0,
					unknown_error: 0,
				},
				byTool: {
					a_tool: 1,
					z_tool: 1,
				},
				reasonCodes: {
					a_reason: 1,
					b_reason: 1,
				},
				blockedCallIds: ["call-a"],
				missingAuditResultIds: ["call-missing-a", "call-missing-z"],
			},
			readiness: {
				status: "partial",
				total: 4,
				auditedTotal: 2,
				missingTotal: 2,
				missingAuditResultIds: ["call-missing-a", "call-missing-z"],
			},
		});
	});

	it("classifies compact tool result audit report health", () => {
		const auditedSuccess = {
			toolCallId: "call-success",
			content: JSON.stringify({ ok: true }),
			isError: false,
			audit: {
				tool: "memory_store",
				call: "call-success",
				outcome: "success",
				summary: "Tool memory_store completed successfully.",
				detail: "tool=memory_store; call=call-success; outcome=success",
			},
		} as const;
		const auditedAsk = {
			toolCallId: "call-ask",
			content: JSON.stringify({ error: "approval required" }),
			isError: true,
			audit: {
				tool: "file_write",
				call: "call-ask",
				outcome: "sandbox_ask",
				errorCode: "sandbox_approval_required",
				reasonCodes: ["write_operation_requires_approval"],
				summary: "Tool file_write requires sandbox approval.",
				detail:
					"tool=file_write; call=call-ask; outcome=sandbox_ask; code=sandbox_approval_required; reasonCodes=write_operation_requires_approval",
			},
		} as const;
		const auditedError = {
			toolCallId: "call-error",
			content: JSON.stringify({ error: "failed" }),
			isError: true,
			audit: {
				tool: "web_fetch",
				call: "call-error",
				outcome: "tool_error",
				errorCode: "upstream_error",
				summary: "Tool web_fetch failed with upstream_error.",
				detail:
					"tool=web_fetch; call=call-error; outcome=tool_error; code=upstream_error",
			},
		} as const;
		const missing = {
			toolCallId: "call-missing",
			content: JSON.stringify({ ok: true }),
			isError: false,
		} as const;

		const clean: ToolResultAuditReportHealthSummary =
			summarizeToolResultAuditReportHealth(
				summarizeToolResultAuditReport([auditedSuccess]),
			);
		const blocked = summarizeToolResultAuditReportHealth(
			summarizeToolResultAuditReport([auditedAsk]),
		);
		const incomplete = summarizeToolResultAuditReportHealth(
			summarizeToolResultAuditReport([auditedSuccess, missing]),
		);
		const blockedAndIncomplete = summarizeToolResultAuditReportHealth(
			summarizeToolResultAuditReport([auditedAsk, missing]),
		);
		const failed = summarizeToolResultAuditReportHealth(
			summarizeToolResultAuditReport([auditedAsk, auditedError, missing]),
		);

		expect(clean).toEqual({
			status: "clean",
			total: 1,
			auditedTotal: 1,
			failedTotal: 0,
			blockedTotal: 0,
			missingTotal: 0,
		});
		expect(blocked).toEqual({
			status: "blocked",
			total: 1,
			auditedTotal: 1,
			failedTotal: 0,
			blockedTotal: 1,
			missingTotal: 0,
		});
		expect(incomplete).toEqual({
			status: "incomplete",
			total: 2,
			auditedTotal: 1,
			failedTotal: 0,
			blockedTotal: 0,
			missingTotal: 1,
		});
		expect(blockedAndIncomplete).toEqual({
			status: "blocked",
			total: 2,
			auditedTotal: 1,
			failedTotal: 0,
			blockedTotal: 1,
			missingTotal: 1,
		});
		expect(failed).toEqual({
			status: "failed",
			total: 3,
			auditedTotal: 2,
			failedTotal: 1,
			blockedTotal: 1,
			missingTotal: 1,
		});
	});

	it("summarizes an empty tool result audit report health batch", () => {
		const batch: ToolResultAuditReportHealthBatchSummary =
			summarizeToolResultAuditReportHealthBatch([]);

		expect(batch).toEqual({
			status: "clean",
			byStatus: {
				clean: 0,
				blocked: 0,
				incomplete: 0,
				failed: 0,
			},
			total: 0,
			auditedTotal: 0,
			failedTotal: 0,
			blockedTotal: 0,
			missingTotal: 0,
		});
	});

	it("summarizes an all-clean tool result audit report health batch", () => {
		const summaries: readonly ToolResultAuditReportHealthSummary[] = [
			{
				status: "clean",
				total: 2,
				auditedTotal: 2,
				failedTotal: 0,
				blockedTotal: 0,
				missingTotal: 0,
			},
			{
				status: "clean",
				total: 3,
				auditedTotal: 3,
				failedTotal: 0,
				blockedTotal: 0,
				missingTotal: 0,
			},
		];

		expect(summarizeToolResultAuditReportHealthBatch(summaries)).toEqual({
			status: "clean",
			byStatus: {
				clean: 2,
				blocked: 0,
				incomplete: 0,
				failed: 0,
			},
			total: 5,
			auditedTotal: 5,
			failedTotal: 0,
			blockedTotal: 0,
			missingTotal: 0,
		});
	});

	it("summarizes blocked and incomplete tool result audit report health batches", () => {
		const summaries: readonly ToolResultAuditReportHealthSummary[] = [
			{
				status: "incomplete",
				total: 4,
				auditedTotal: 2,
				failedTotal: 0,
				blockedTotal: 0,
				missingTotal: 2,
			},
			{
				status: "blocked",
				total: 3,
				auditedTotal: 3,
				failedTotal: 0,
				blockedTotal: 2,
				missingTotal: 0,
			},
		];

		expect(summarizeToolResultAuditReportHealthBatch(summaries)).toEqual({
			status: "blocked",
			byStatus: {
				clean: 0,
				blocked: 1,
				incomplete: 1,
				failed: 0,
			},
			total: 7,
			auditedTotal: 5,
			failedTotal: 0,
			blockedTotal: 2,
			missingTotal: 2,
		});
	});

	it("summarizes failed mixed tool result audit report health batches", () => {
		const summaries = new Set<ToolResultAuditReportHealthSummary>([
			{
				status: "clean",
				total: 1,
				auditedTotal: 1,
				failedTotal: 0,
				blockedTotal: 0,
				missingTotal: 0,
			},
			{
				status: "blocked",
				total: 2,
				auditedTotal: 2,
				failedTotal: 0,
				blockedTotal: 1,
				missingTotal: 0,
			},
			{
				status: "failed",
				total: 4,
				auditedTotal: 3,
				failedTotal: 2,
				blockedTotal: 0,
				missingTotal: 1,
			},
		]);

		expect(summarizeToolResultAuditReportHealthBatch(summaries)).toEqual({
			status: "failed",
			byStatus: {
				clean: 1,
				blocked: 1,
				incomplete: 0,
				failed: 1,
			},
			total: 7,
			auditedTotal: 6,
			failedTotal: 2,
			blockedTotal: 1,
			missingTotal: 1,
		});
	});

	it("执行匹配工具并归一化 toolCallId", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ id: "mem-1" }),
			isError: false,
		});

		const router = new ToolRouter([
			{
				name: "memory_store",
				description: "Store memory",
				parameters: z.object({
					content: z.string(),
					tier: z.string().optional(),
				}),
				execute,
			},
		]);

		const result = await router.execute({
			id: "call-1",
			name: "memory_store",
			arguments: { content: "我叫小明", tier: "short" },
		});

		expect(execute).toHaveBeenCalledWith({
			content: "我叫小明",
			tier: "short",
		});
		expect(result).toEqual({
			toolCallId: "call-1",
			content: JSON.stringify({ id: "mem-1" }),
			isError: false,
			audit: {
				tool: "memory_store",
				call: "call-1",
				outcome: "success",
				summary: "Tool memory_store completed successfully.",
				detail: "tool=memory_store; call=call-1; outcome=success",
			},
		});
	});

	it("工具不存在时返回错误 ToolResult", async () => {
		const router = new ToolRouter([]);

		const result = await router.execute({
			id: "call-404",
			name: "memory_recall",
			arguments: { query: "我叫什么" },
		});

		expect(result.toolCallId).toBe("call-404");
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toMatchObject({
			error: expect.stringContaining("memory_recall"),
			code: "tool_not_found",
		});
		expect(result.error).toEqual({
			code: "tool_not_found",
			message: "Tool not found: memory_recall",
		});
	});

	it("参数校验失败时返回错误 ToolResult", async () => {
		const execute = vi.fn();
		const router = new ToolRouter([
			{
				name: "memory_recall",
				description: "Recall memory",
				parameters: z.object({ query: z.string() }),
				execute,
			},
		]);

		const result = await router.execute({
			id: "call-invalid",
			name: "memory_recall",
			arguments: { query: 123 },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.toolCallId).toBe("call-invalid");
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toMatchObject({
			error: expect.any(String),
			code: "invalid_arguments",
			details: {
				issues: [
					expect.objectContaining({
						code: expect.any(String),
						path: ["query"],
						message: expect.any(String),
					}),
				],
			},
		});
		expect(result.error?.code).toBe("invalid_arguments");
	});

	it("工具执行抛错时返回错误 ToolResult", async () => {
		const router = new ToolRouter([
			{
				name: "memory_store",
				description: "Store memory",
				parameters: z.object({ content: z.string() }),
				execute: vi.fn().mockRejectedValue(new Error("disk full")),
			},
		]);

		const result = await router.execute({
			id: "call-error",
			name: "memory_store",
			arguments: { content: "我叫小明" },
		});

		expect(result.toolCallId).toBe("call-error");
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: "Tool execution failed.",
			code: "execution_failed",
		});
		expect(result.error).toEqual({
			code: "execution_failed",
			message: "Tool execution failed.",
		});
		expect(result.audit).toEqual({
			tool: "memory_store",
			call: "call-error",
			outcome: "tool_error",
			errorCode: "execution_failed",
			summary: "Tool memory_store failed with execution_failed.",
			detail:
				"tool=memory_store; call=call-error; outcome=tool_error; code=execution_failed",
		});
		expect(JSON.stringify(result.audit)).not.toContain("我叫小明");
	});

	it("保留工具自身返回的结构化错误", async () => {
		const router = new ToolRouter([
			{
				name: "memory_store",
				description: "Store memory",
				parameters: z.object({ content: z.string() }),
				execute: vi.fn().mockResolvedValue({
					toolCallId: "wrong-id",
					content: JSON.stringify({
						error: "upstream rejected",
						code: "upstream_error",
					}),
					isError: true,
					error: {
						code: "upstream_error",
						message: "upstream rejected",
						retryable: true,
					},
				}),
			},
		]);

		const result = await router.execute({
			id: "call-upstream",
			name: "memory_store",
			arguments: { content: "我叫小明" },
		});

		expect(result).toEqual({
			toolCallId: "call-upstream",
			content: JSON.stringify({
				error: "upstream rejected",
				code: "upstream_error",
			}),
			isError: true,
			error: {
				code: "upstream_error",
				message: "upstream rejected",
				retryable: true,
			},
			audit: {
				tool: "memory_store",
				call: "call-upstream",
				outcome: "tool_error",
				errorCode: "upstream_error",
				retryable: true,
				summary: "Tool memory_store failed with upstream_error.",
				detail:
					"tool=memory_store; call=call-upstream; outcome=tool_error; code=upstream_error; retryable=true",
			},
		});
	});

	it("将具名超时异常归类为可重试 timeout 错误", async () => {
		const timeoutError = new Error("MCP tool memory_recall timed out");
		timeoutError.name = "MCPTimeoutError";
		const router = new ToolRouter([
			{
				name: "memory_recall",
				description: "Recall memory",
				parameters: z.object({ query: z.string() }),
				execute: vi.fn().mockRejectedValue(timeoutError),
			},
		]);

		const result = await router.execute({
			id: "call-timeout",
			name: "memory_recall",
			arguments: { query: "老孟" },
		});

		expect(JSON.parse(result.content)).toEqual({
			error: "Tool execution timed out.",
			code: "timeout",
			retryable: true,
		});
		expect(result.error).toEqual({
			code: "timeout",
			message: "Tool execution timed out.",
			retryable: true,
		});
	});

	it("支持执行带 metadata 的工具", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ ok: true }),
			isError: false,
		});
		const tool: ToolWithMetadata = {
			name: "file_read",
			description: "Read a file with numbered lines.",
			parameters: z.object({ path: z.string() }),
			execute,
			category: "programmatic",
			riskLevel: "read",
		};
		const router = new ToolRouter([tool]);

		const result = await router.execute({
			id: "call-meta",
			name: "file_read",
			arguments: { path: "/tmp/demo.txt" },
		});

		expect(execute).toHaveBeenCalledWith({ path: "/tmp/demo.txt" });
		expect(result).toEqual({
			toolCallId: "call-meta",
			content: JSON.stringify({ ok: true }),
			isError: false,
			audit: {
				tool: "file_read",
				call: "call-meta",
				outcome: "success",
				summary: "Tool file_read completed successfully.",
				detail: "tool=file_read; call=call-meta; outcome=success",
			},
		});
	});

	it("按工具声明的 sandbox policy 在执行前阻断需要审批的调用", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ ok: true }),
			isError: false,
		});
		const tool: ToolWithMetadata = {
			name: "file_write",
			description: "Write a file.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			sandboxPolicy: { operation: "write" },
			execute,
			category: "programmatic",
			riskLevel: "write",
		};
		const router = new ToolRouter([tool]);

		const result = await router.execute({
			id: "call-sandbox-ask",
			name: "file_write",
			arguments: { path: "demo.txt", content: "hello" },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		const expectedApprovalSummary = {
			tool: "file_write",
			call: "call-sandbox-ask",
			origin: "unknown",
			kind: "ask",
			requiredApprovals: ["write_authority", "user_confirmation"],
			reasonCodes: ["write_operation_requires_approval"],
			summary: "Sandbox approval required for file_write.",
			detail:
				"call=call-sandbox-ask; origin=unknown; kind=ask; requiredApprovals=write_authority,user_confirmation; reasonCodes=write_operation_requires_approval",
		};
		expect(JSON.parse(result.content)).toMatchObject({
			error: "Tool execution requires sandbox approval.",
			code: "sandbox_approval_required",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["write_operation_requires_approval"],
					requiredApprovals: ["write_authority", "user_confirmation"],
				},
				approvalSummary: expectedApprovalSummary,
			},
		});
		expect(result.error?.code).toBe("sandbox_approval_required");
		expect(result.error?.details?.approvalSummary).toEqual(
			expectedApprovalSummary,
		);
		expect(result.audit).toEqual({
			tool: "file_write",
			call: "call-sandbox-ask",
			outcome: "sandbox_ask",
			errorCode: "sandbox_approval_required",
			sandboxKind: "ask",
			sandboxOrigin: "unknown",
			requiredApprovals: ["write_authority", "user_confirmation"],
			reasonCodes: ["write_operation_requires_approval"],
			summary: "Tool file_write requires sandbox approval.",
			detail:
				"tool=file_write; call=call-sandbox-ask; outcome=sandbox_ask; code=sandbox_approval_required; sandboxKind=ask; sandboxOrigin=unknown; requiredApprovals=write_authority,user_confirmation; reasonCodes=write_operation_requires_approval",
		});
		expect(JSON.stringify(result.audit)).not.toContain("hello");
	});

	it("sandbox 审批通过后继续执行同一次工具调用", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ ok: true }),
			isError: false,
		});
		const sandboxApproval = vi.fn(async () => true);
		const tool: ToolWithMetadata = {
			name: "file_write",
			description: "Write a file.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			sandboxPolicy: { operation: "write" },
			execute,
			category: "programmatic",
			riskLevel: "write",
		};
		const router = new ToolRouter([tool], {
			sandboxApproval,
			sandboxOrigin: "agent",
		});

		const result = await router.execute({
			id: "call-sandbox-approved",
			name: "file_write",
			arguments: { path: "demo.txt", content: "hello" },
		});

		expect(sandboxApproval).toHaveBeenCalledWith({
			decision: {
				kind: "ask",
				reasonCodes: ["write_operation_requires_approval"],
				requiredApprovals: ["write_authority", "user_confirmation"],
			},
			context: expect.objectContaining({
				toolCallId: "call-sandbox-approved",
				requestedToolName: "file_write",
				resolvedToolName: "file_write",
				origin: "agent",
			}),
			summary: expect.objectContaining({
				tool: "file_write",
				call: "call-sandbox-approved",
				origin: "agent",
				kind: "ask",
				reasonCodes: ["write_operation_requires_approval"],
			}),
		});
		expect(execute).toHaveBeenCalledWith({
			path: "demo.txt",
			content: "hello",
		});
		expect(result).toMatchObject({
			toolCallId: "call-sandbox-approved",
			isError: false,
			content: JSON.stringify({ ok: true }),
			audit: {
				tool: "file_write",
				call: "call-sandbox-approved",
				outcome: "success",
				sandboxKind: "ask",
				sandboxOrigin: "agent",
				requiredApprovals: ["write_authority", "user_confirmation"],
				reasonCodes: ["write_operation_requires_approval"],
				summary: "Tool file_write completed successfully.",
				detail:
					"tool=file_write; call=call-sandbox-approved; outcome=success; sandboxKind=ask; sandboxOrigin=agent; requiredApprovals=write_authority,user_confirmation; reasonCodes=write_operation_requires_approval",
			},
		});
		expect(JSON.stringify(result.audit)).not.toContain("hello");
	});

	it("sandbox 审批通过后工具执行失败仍保留审批审计来源", async () => {
		const execute = vi
			.fn()
			.mockRejectedValue(new Error("unexpected write failure"));
		const sandboxApproval = vi.fn(async () => true);
		const tool: ToolWithMetadata = {
			name: "file_write",
			description: "Write a file.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			sandboxPolicy: { operation: "write" },
			execute,
			category: "programmatic",
			riskLevel: "write",
		};
		const router = new ToolRouter([tool], {
			sandboxApproval,
			sandboxOrigin: "agent",
		});

		const result = await router.execute({
			id: "call-sandbox-approved-error",
			name: "file_write",
			arguments: { path: "demo.txt", content: "hello" },
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			toolCallId: "call-sandbox-approved-error",
			isError: true,
			error: {
				code: "execution_failed",
			},
			audit: {
				tool: "file_write",
				call: "call-sandbox-approved-error",
				outcome: "tool_error",
				errorCode: "execution_failed",
				sandboxKind: "ask",
				sandboxOrigin: "agent",
				requiredApprovals: ["write_authority", "user_confirmation"],
				reasonCodes: ["write_operation_requires_approval"],
				summary: "Tool file_write failed with execution_failed.",
				detail:
					"tool=file_write; call=call-sandbox-approved-error; outcome=tool_error; code=execution_failed; sandboxKind=ask; sandboxOrigin=agent; requiredApprovals=write_authority,user_confirmation; reasonCodes=write_operation_requires_approval",
			},
		});
		expect(JSON.stringify(result.audit)).not.toContain("hello");
	});

	it("sandbox 审批拒绝后不执行工具调用", async () => {
		const execute = vi.fn();
		const sandboxApproval = vi.fn(async () => false);
		const tool: ToolWithMetadata = {
			name: "file_write",
			description: "Write a file.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			sandboxPolicy: { operation: "write" },
			execute,
			category: "programmatic",
			riskLevel: "write",
		};
		const router = new ToolRouter([tool], { sandboxApproval });

		const result = await router.execute({
			id: "call-sandbox-rejected",
			name: "file_write",
			arguments: { path: "demo.txt", content: "hello" },
		});

		expect(sandboxApproval).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
		expect(result.error?.code).toBe("sandbox_approval_required");
	});

	it("sandbox 审批 handler 抛错时 fail-closed 且不执行工具调用", async () => {
		const execute = vi.fn();
		const sandboxApproval = vi.fn(async () => {
			throw new Error("approval prompt failed");
		});
		const tool: ToolWithMetadata = {
			name: "file_write",
			description: "Write a file.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			sandboxPolicy: { operation: "write" },
			execute,
			category: "programmatic",
			riskLevel: "write",
		};
		const router = new ToolRouter([tool], { sandboxApproval });

		const result = await router.execute({
			id: "call-sandbox-handler-error",
			name: "file_write",
			arguments: { path: "demo.txt", content: "hello" },
		});

		expect(sandboxApproval).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
		expect(result.error?.code).toBe("sandbox_approval_required");
	});

	it("裸 network sandbox policy 缺少目标信号时需要审批", async () => {
		const execute = vi.fn();
		const tool: ToolWithMetadata = {
			name: "network_probe",
			description: "Probe a network target.",
			parameters: z.object({ url: z.string() }),
			sandboxPolicy: { operation: "network" },
			execute,
			category: "programmatic",
			riskLevel: "read",
		};
		const router = new ToolRouter([tool], { sandboxOrigin: "agent" });

		const result = await router.execute({
			id: "call-network-no-signal",
			name: "network_probe",
			arguments: { url: "https://example.com" },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.error).toEqual({
			code: "sandbox_approval_required",
			message: "Tool execution requires sandbox approval.",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["network_operation_requires_approval"],
					requiredApprovals: ["network_access", "user_confirmation"],
				},
				approvalSummary: expect.objectContaining({
					tool: "network_probe",
					call: "call-network-no-signal",
					origin: "agent",
					kind: "ask",
					requiredApprovals: ["network_access", "user_confirmation"],
					reasonCodes: ["network_operation_requires_approval"],
				}),
			},
		});
	});

	it("传入 sandbox evaluator 时使用 metadata 生成默认 sandbox request", async () => {
		const execute = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>().mockReturnValue({
			kind: "ask",
			reasonCodes: ["write_operation_requires_approval"],
			requiredApprovals: ["write_authority", "user_confirmation"],
		});
		const router = new ToolRouter(
			[
				{
					name: "file_write",
					description: "Write a file.",
					parameters: z.object({ path: z.string(), content: z.string() }),
					execute,
					category: "programmatic",
					riskLevel: "write",
				} satisfies ToolWithMetadata,
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-sandbox-default",
			name: "file_write",
			arguments: { path: "demo.txt", content: "hello" },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{ operation: "write", origin: "agent" },
			expect.objectContaining({
				toolCallId: "call-sandbox-default",
				requestedToolName: "file_write",
				resolvedToolName: "file_write",
				parsedArguments: { path: "demo.txt", content: "hello" },
				category: "programmatic",
				riskLevel: "write",
				origin: "agent",
			}),
		);
		expect(result.error?.code).toBe("sandbox_approval_required");
	});

	it("优先使用显式 sandbox operation metadata 而不是 riskLevel 推断", async () => {
		const execute = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>().mockReturnValue({
			kind: "ask",
			reasonCodes: ["network_credentials_require_approval"],
			requiredApprovals: ["network_access", "user_confirmation"],
		});
		const router = new ToolRouter(
			[
				{
					name: "web_fetch",
					description: "Fetch a URL.",
					parameters: z.object({
						url: z.string(),
						headers: z.record(z.string(), z.string()).optional(),
					}),
					execute,
					category: "programmatic",
					riskLevel: "read",
					sandboxOperation: "network",
				} satisfies ToolWithMetadata,
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-network-sandbox",
			name: "web_fetch",
			arguments: {
				url: "https://example.com",
				headers: { Authorization: "Bearer token" },
			},
		});

		expect(execute).not.toHaveBeenCalled();
		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{ operation: "network", origin: "agent" },
			expect.objectContaining({
				requestedToolName: "web_fetch",
				resolvedToolName: "web_fetch",
				riskLevel: "read",
				sandboxOperation: "network",
			}),
		);
		expect(result.error).toEqual({
			code: "sandbox_approval_required",
			message: "Tool execution requires sandbox approval.",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["network_credentials_require_approval"],
					requiredApprovals: ["network_access", "user_confirmation"],
				},
				approvalSummary: expect.objectContaining({
					tool: "web_fetch",
					call: "call-network-sandbox",
					origin: "agent",
					kind: "ask",
					requiredApprovals: ["network_access", "user_confirmation"],
					reasonCodes: ["network_credentials_require_approval"],
				}),
			},
		});
	});

	it("默认允许 built-in web_fetch 执行普通公网读取", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("latest codex news", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
		);
		const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
			defaultSandboxEvaluator(request, context),
		);
		const router = new ToolRouter(
			[
				createWebFetchTool({
					fetcher,
					resolver: async () => ["93.184.216.34"],
				}),
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-web-fetch-public",
			name: "web_fetch",
			arguments: { url: "https://example.com/news" },
		});

		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{
				operation: "network",
				origin: "agent",
				signals: {
					network: {
						destination: "example.com",
						protocol: "https",
						method: "GET",
						sendsCredentials: false,
					},
				},
			},
			expect.objectContaining({
				toolCallId: "call-web-fetch-public",
				requestedToolName: "web_fetch",
				resolvedToolName: "web_fetch",
				riskLevel: "read",
				sandboxOperation: "network",
				origin: "agent",
			}),
		);
		expect(fetcher).toHaveBeenCalledWith(
			"https://example.com/news",
			expect.objectContaining({
				method: "GET",
				redirect: "manual",
			}),
		);
		expect(result.toolCallId).toBe("call-web-fetch-public");
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual({
			url: "https://example.com/news",
			status: 200,
			contentType: "text/plain",
			body: "latest codex news",
			truncated: false,
		});
		expect(result.error).toBeUndefined();
	});

	it("默认在 sandbox 层拒绝 built-in web_fetch 访问本机地址", async () => {
		const fetcher = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
			defaultSandboxEvaluator(request, context),
		);
		const router = new ToolRouter(
			[
				createWebFetchTool({
					fetcher,
				}),
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-web-fetch-loopback",
			name: "web_fetch",
			arguments: { url: "http://127.0.0.1:3000/debug" },
		});

		expect(fetcher).not.toHaveBeenCalled();
		expect(result.error).toEqual({
			code: "sandbox_denied",
			message: "Tool execution denied by sandbox policy.",
			details: {
				decision: {
					kind: "deny",
					reasonCodes: ["private_network_denied"],
					requiredApprovals: [],
				},
				approvalSummary: expect.objectContaining({
					tool: "web_fetch",
					call: "call-web-fetch-loopback",
					origin: "agent",
					kind: "deny",
					requiredApprovals: [],
					reasonCodes: ["private_network_denied"],
				}),
			},
		});
	});

	it("将 built-in web_fetch 的动态 network signals 传给 sandbox evaluator", async () => {
		const fetcher = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
			defaultSandboxEvaluator(request, context),
		);
		const router = new ToolRouter(
			[
				createWebFetchTool({
					fetcher,
				}),
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-web-fetch-signals",
			name: "web_fetch",
			arguments: {
				url: "https://api.example.com/data",
				method: "POST",
				body: "ping",
				headers: {
					Authorization: "Bearer top-secret",
					Cookie: "session=abc",
					"x-test": "1",
				},
			},
		});

		expect(fetcher).not.toHaveBeenCalled();
		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{
				operation: "network",
				origin: "agent",
				signals: {
					network: {
						destination: "api.example.com",
						protocol: "https",
						method: "POST",
						sendsCredentials: true,
					},
				},
			},
			expect.objectContaining({
				toolCallId: "call-web-fetch-signals",
				requestedToolName: "web_fetch",
				resolvedToolName: "web_fetch",
				parsedArguments: {
					url: "https://api.example.com/data",
					method: "POST",
					body: "ping",
					headers: {
						Authorization: "Bearer top-secret",
						Cookie: "session=abc",
						"x-test": "1",
					},
				},
				category: "programmatic",
				riskLevel: "read",
				sandboxOperation: "network",
				origin: "agent",
			}),
		);
		expect(result.error).toEqual({
			code: "sandbox_approval_required",
			message: "Tool execution requires sandbox approval.",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["network_credentials_require_approval"],
					requiredApprovals: ["network_access", "user_confirmation"],
				},
				approvalSummary: expect.objectContaining({
					tool: "web_fetch",
					call: "call-web-fetch-signals",
					origin: "agent",
					kind: "ask",
					requiredApprovals: ["network_access", "user_confirmation"],
					reasonCodes: ["network_credentials_require_approval"],
				}),
			},
		});
	});

	it("将 built-in web_fetch URL userinfo 识别为凭据网络请求", async () => {
		const fetcher = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
			defaultSandboxEvaluator(request, context),
		);
		const router = new ToolRouter(
			[
				createWebFetchTool({
					fetcher,
				}),
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-web-fetch-userinfo",
			name: "web_fetch",
			arguments: {
				url: "https://user:pass@example.com/data",
			},
		});

		expect(fetcher).not.toHaveBeenCalled();
		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{
				operation: "network",
				origin: "agent",
				signals: {
					network: {
						destination: "example.com",
						protocol: "https",
						method: "GET",
						sendsCredentials: true,
					},
				},
			},
			expect.objectContaining({
				toolCallId: "call-web-fetch-userinfo",
				requestedToolName: "web_fetch",
				resolvedToolName: "web_fetch",
				sandboxOperation: "network",
				origin: "agent",
			}),
		);
		expect(result.error).toEqual({
			code: "sandbox_approval_required",
			message: "Tool execution requires sandbox approval.",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["network_credentials_require_approval"],
					requiredApprovals: ["network_access", "user_confirmation"],
				},
				approvalSummary: expect.objectContaining({
					tool: "web_fetch",
					call: "call-web-fetch-userinfo",
					origin: "agent",
					kind: "ask",
					requiredApprovals: ["network_access", "user_confirmation"],
					reasonCodes: ["network_credentials_require_approval"],
				}),
			},
		});
	});

	it("将 built-in shell_exec 的动态 process signals 传给 sandbox evaluator", async () => {
		const runner = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
			defaultSandboxEvaluator(request, context),
		);
		const router = new ToolRouter(
			[
				createShellExecTool({
					runner,
				}),
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-shell-exec-signals",
			name: "shell_exec",
			arguments: {
				command: "echo hello",
				cwd: "/tmp",
			},
		});

		expect(runner).not.toHaveBeenCalled();
		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{
				operation: "process",
				origin: "agent",
				signals: {
					process: {
						commandLine: "echo hello",
						executable: "echo",
						args: ["hello"],
						shell: false,
						writesFilesystem: false,
					},
				},
			},
			expect.objectContaining({
				toolCallId: "call-shell-exec-signals",
				requestedToolName: "shell_exec",
				resolvedToolName: "shell_exec",
				parsedArguments: {
					command: "echo hello",
					cwd: "/tmp",
				},
				category: "programmatic",
				riskLevel: "exec",
				sandboxOperation: "process",
				origin: "agent",
			}),
		);
		expect(result.error).toEqual({
			code: "sandbox_approval_required",
			message: "Tool execution requires sandbox approval.",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["process_operation_requires_approval"],
					requiredApprovals: ["process_execution", "user_confirmation"],
				},
				approvalSummary: expect.objectContaining({
					tool: "shell_exec",
					call: "call-shell-exec-signals",
					origin: "agent",
					kind: "ask",
					requiredApprovals: ["process_execution", "user_confirmation"],
					reasonCodes: ["process_operation_requires_approval"],
				}),
			},
		});
	});

	it("shell_exec filesystem write signals trigger process write approval", async () => {
		const runner = vi.fn();
		const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
			defaultSandboxEvaluator(request, context),
		);
		const router = new ToolRouter(
			[
				createShellExecTool({
					runner,
				}),
			],
			{ sandboxEvaluator, sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-shell-exec-write-signals",
			name: "shell_exec",
			arguments: {
				command: "touch output.txt",
			},
		});

		expect(runner).not.toHaveBeenCalled();
		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{
				operation: "process",
				origin: "agent",
				signals: {
					process: {
						commandLine: "touch output.txt",
						executable: "touch",
						args: ["output.txt"],
						shell: false,
						writesFilesystem: true,
					},
				},
			},
			expect.objectContaining({
				toolCallId: "call-shell-exec-write-signals",
				requestedToolName: "shell_exec",
				resolvedToolName: "shell_exec",
			}),
		);
		expect(result.error).toEqual({
			code: "sandbox_approval_required",
			message: "Tool execution requires sandbox approval.",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: [
						"process_operation_requires_approval",
						"process_filesystem_write_requires_approval",
					],
					requiredApprovals: [
						"process_execution",
						"user_confirmation",
						"write_authority",
					],
				},
				approvalSummary: expect.objectContaining({
					tool: "shell_exec",
					call: "call-shell-exec-write-signals",
					origin: "agent",
					kind: "ask",
					requiredApprovals: [
						"process_execution",
						"user_confirmation",
						"write_authority",
					],
					reasonCodes: [
						"process_operation_requires_approval",
						"process_filesystem_write_requires_approval",
					],
				}),
			},
		});
	});

	it("将 built-in read/list file tools 的动态 path signals 传给 sandbox evaluator", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quilin-router-file-"));

		try {
			const filePath = join(tempDir, "notes.txt");
			await writeFile(filePath, "hello\n", "utf8");
			const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
				defaultSandboxEvaluator(request, context),
			);
			const router = new ToolRouter(
				[
					createFileReadTool({ allowedRoots: [tempDir] }),
					createFileListTool({ allowedRoots: [tempDir] }),
				],
				{ sandboxEvaluator, sandboxOrigin: "agent" },
			);

			const readResult = await router.execute({
				id: "call-file-read-signals",
				name: "file_read",
				arguments: { path: filePath },
			});
			const listResult = await router.execute({
				id: "call-file-list-signals",
				name: "file_list",
				arguments: { path: tempDir },
			});

			expect(readResult.isError).toBe(false);
			expect(listResult.isError).toBe(false);
			expect(sandboxEvaluator).toHaveBeenNthCalledWith(
				1,
				{
					operation: "read",
					origin: "agent",
					signals: {
						paths: [
							{
								path: filePath,
								access: "read",
							},
						],
					},
				},
				expect.objectContaining({
					toolCallId: "call-file-read-signals",
					requestedToolName: "file_read",
					resolvedToolName: "file_read",
					parsedArguments: { path: filePath },
				}),
			);
			expect(sandboxEvaluator).toHaveBeenNthCalledWith(
				2,
				{
					operation: "read",
					origin: "agent",
					signals: {
						paths: [
							{
								path: tempDir,
								access: "read",
							},
						],
					},
				},
				expect.objectContaining({
					toolCallId: "call-file-list-signals",
					requestedToolName: "file_list",
					resolvedToolName: "file_list",
					parsedArguments: { path: tempDir },
				}),
			);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("built-in file_write path signal triggers sandbox write approval", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "quilin-router-write-"));

		try {
			const filePath = join(tempDir, "output.txt");
			const sandboxEvaluator = vi.fn<SandboxEvaluator>((request, context) =>
				defaultSandboxEvaluator(request, context),
			);
			const router = new ToolRouter(
				[createFileWriteTool({ allowedRoots: [tempDir] })],
				{ sandboxEvaluator, sandboxOrigin: "agent" },
			);

			const result = await router.execute({
				id: "call-file-write-signals",
				name: "file_write",
				arguments: { path: filePath, content: "hello" },
			});

			expect(sandboxEvaluator).toHaveBeenCalledWith(
				{
					operation: "write",
					origin: "agent",
					signals: {
						paths: [
							{
								path: filePath,
								access: "write",
							},
						],
					},
				},
				expect.objectContaining({
					toolCallId: "call-file-write-signals",
					requestedToolName: "file_write",
					resolvedToolName: "file_write",
					parsedArguments: { path: filePath, content: "hello" },
				}),
			);
			expect(result.error).toEqual({
				code: "sandbox_approval_required",
				message: "Tool execution requires sandbox approval.",
				details: {
					decision: {
						kind: "ask",
						reasonCodes: ["write_operation_requires_approval"],
						requiredApprovals: ["write_authority", "user_confirmation"],
					},
					approvalSummary: expect.objectContaining({
						tool: "file_write",
						call: "call-file-write-signals",
						origin: "agent",
						kind: "ask",
						requiredApprovals: ["write_authority", "user_confirmation"],
						reasonCodes: ["write_operation_requires_approval"],
					}),
				},
			});
			await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("sandbox 允许后才执行工具", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ ok: true }),
			isError: false,
		});
		const sandboxEvaluator = vi.fn<SandboxEvaluator>().mockReturnValue({
			kind: "allow",
			reasonCodes: ["read_operation_allowed"],
			requiredApprovals: [],
		});
		const router = new ToolRouter(
			[
				{
					name: "file_read",
					description: "Read a file.",
					parameters: z.object({ path: z.string() }),
					execute,
					category: "programmatic",
					riskLevel: "read",
				} satisfies ToolWithMetadata,
			],
			{ sandboxEvaluator },
		);

		const result = await router.execute({
			id: "call-sandbox-allow",
			name: "file_read",
			arguments: { path: "README.md" },
		});

		expect(sandboxEvaluator).toHaveBeenCalledWith(
			{ operation: "read" },
			expect.objectContaining({
				parsedArguments: { path: "README.md" },
				riskLevel: "read",
			}),
		);
		expect(execute).toHaveBeenCalledWith({ path: "README.md" });
		expect(result).toEqual({
			toolCallId: "call-sandbox-allow",
			content: JSON.stringify({ ok: true }),
			isError: false,
			audit: {
				tool: "file_read",
				call: "call-sandbox-allow",
				outcome: "success",
				summary: "Tool file_read completed successfully.",
				detail: "tool=file_read; call=call-sandbox-allow; outcome=success",
			},
		});
	});

	it("sandbox deny 决策阻断工具执行", async () => {
		const execute = vi.fn();
		const router = new ToolRouter([
			{
				name: "file_read",
				description: "Read a file.",
				parameters: z.object({ path: z.string() }),
				sandboxPolicy: {
					operation: "read",
					signals: {
						critical: true,
					},
				},
				execute,
				category: "programmatic",
				riskLevel: "read",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-sandbox-deny",
			name: "file_read",
			arguments: { path: "/etc/shadow" },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.error).toEqual({
			code: "sandbox_denied",
			message: "Tool execution denied by sandbox policy.",
			details: {
				decision: {
					kind: "deny",
					reasonCodes: ["critical_operation_denied"],
					requiredApprovals: [],
				},
				approvalSummary: expect.objectContaining({
					tool: "file_read",
					call: "call-sandbox-deny",
					origin: "unknown",
					kind: "deny",
					requiredApprovals: [],
					reasonCodes: ["critical_operation_denied"],
				}),
			},
		});
		expect(result.audit).toEqual({
			tool: "file_read",
			call: "call-sandbox-deny",
			outcome: "sandbox_deny",
			errorCode: "sandbox_denied",
			sandboxKind: "deny",
			sandboxOrigin: "unknown",
			requiredApprovals: [],
			reasonCodes: ["critical_operation_denied"],
			summary: "Tool file_read was denied by sandbox policy.",
			detail:
				"tool=file_read; call=call-sandbox-deny; outcome=sandbox_deny; code=sandbox_denied; sandboxKind=deny; sandboxOrigin=unknown; requiredApprovals=none; reasonCodes=critical_operation_denied",
		});
	});

	it("sandbox evaluator 抛错时不执行工具并返回稳定错误", async () => {
		const execute = vi.fn();
		const router = new ToolRouter(
			[
				{
					name: "file_read",
					description: "Read a file.",
					parameters: z.object({ path: z.string() }),
					execute,
					category: "programmatic",
					riskLevel: "read",
				} satisfies ToolWithMetadata,
			],
			{
				sandboxEvaluator: async () => {
					throw new Error("sandbox evaluator unavailable");
				},
			},
		);

		const result = await router.execute({
			id: "call-sandbox-evaluator-failure",
			name: "file_read",
			arguments: { path: "README.md" },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.error).toEqual({
			code: "execution_failed",
			message: "Tool execution failed.",
		});
	});

	it("dynamic sandbox policy 抛错时不执行工具并返回稳定错误", async () => {
		const execute = vi.fn();
		const router = new ToolRouter([
			{
				name: "file_read",
				description: "Read a file.",
				parameters: z.object({ path: z.string() }),
				sandboxPolicy: async () => {
					throw new Error("sandbox policy unavailable");
				},
				execute,
				category: "programmatic",
				riskLevel: "read",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-sandbox-policy-failure",
			name: "file_read",
			arguments: { path: "README.md" },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.error).toEqual({
			code: "execution_failed",
			message: "Tool execution failed.",
		});
	});

	it("非 Error 异常返回 unknown error audit 且不泄漏参数或抛出值", async () => {
		const router = new ToolRouter([
			{
				name: "memory_store",
				description: "Store memory",
				parameters: z.object({ content: z.string() }),
				execute: vi.fn().mockRejectedValue("raw throw top-secret"),
			},
		]);

		const result = await router.execute({
			id: "call-unknown-error",
			name: "memory_store",
			arguments: { content: "top-secret" },
		});

		expect(result.error).toEqual({
			code: "execution_failed",
			message: "Tool execution failed.",
		});
		expect(result.audit).toEqual({
			tool: "memory_store",
			call: "call-unknown-error",
			outcome: "unknown_error",
			errorCode: "execution_failed",
			summary: "Tool memory_store failed with an unknown error.",
			detail:
				"tool=memory_store; call=call-unknown-error; outcome=unknown_error; code=execution_failed",
		});
		expect(JSON.stringify(result.audit)).not.toContain("top-secret");
		expect(JSON.stringify(result.audit)).not.toContain("raw throw");
	});

	it("优先精确匹配带 namespace 的工具名", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});
		const router = new ToolRouter([
			{
				name: "omnimem/memory_recall",
				description: "Recall memories",
				parameters: z.object({ query: z.string() }),
				execute,
				category: "programmatic",
				riskLevel: "read",
				namespace: "omnimem",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-ns",
			name: "omnimem/memory_recall",
			arguments: { query: "小明" },
		});

		expect(execute).toHaveBeenCalledWith({ query: "小明" });
		expect(result.isError).toBe(false);
	});

	it("找不到精确匹配时回退到短名查找", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});
		const router = new ToolRouter([
			{
				name: "omnimem/memory_recall",
				description: "Recall memories",
				parameters: z.object({ query: z.string() }),
				execute,
				category: "programmatic",
				riskLevel: "read",
				namespace: "omnimem",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-short",
			name: "memory_recall",
			arguments: { query: "老孟" },
		});

		expect(execute).toHaveBeenCalledWith({ query: "老孟" });
		expect(result.isError).toBe(false);
	});

	it("短名冲突时返回 tool not found 错误", async () => {
		const executeOne = vi.fn();
		const executeTwo = vi.fn();
		const router = new ToolRouter([
			{
				name: "memory/search",
				description: "Memory search",
				parameters: z.object({ query: z.string() }),
				execute: executeOne,
				category: "programmatic",
				riskLevel: "read",
				namespace: "memory",
			} satisfies ToolWithMetadata,
			{
				name: "web/search",
				description: "Web search",
				parameters: z.object({ query: z.string() }),
				execute: executeTwo,
				category: "programmatic",
				riskLevel: "read",
				namespace: "web",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-ambiguous",
			name: "search",
			arguments: { query: "quilin" },
		});

		expect(executeOne).not.toHaveBeenCalled();
		expect(executeTwo).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("search"),
			code: "tool_ambiguous",
			details: {
				matches: ["memory/search", "web/search"],
			},
		});
		expect(result.error).toEqual({
			code: "tool_ambiguous",
			message: "Tool name is ambiguous: search",
			details: {
				matches: ["memory/search", "web/search"],
			},
		});
	});
});
