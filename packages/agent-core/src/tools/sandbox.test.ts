import { describe, expect, it } from "vitest";
import {
	createSandboxApprovalSummary,
	defaultSandboxEvaluator,
	evaluateSandboxRequest,
	genericSandboxPolicy,
	resolveSandboxPolicy,
} from "./sandbox.js";

describe("evaluateSandboxRequest", () => {
	it("maps tool metadata into a generic sandbox request", () => {
		expect(
			genericSandboxPolicy({
				toolCallId: "call-read",
				requestedToolName: "file_read",
				resolvedToolName: "file_read",
				parsedArguments: { path: "README.md" },
				riskLevel: "read",
				origin: "agent",
			}),
		).toEqual({
			operation: "read",
			origin: "agent",
		});
		expect(
			genericSandboxPolicy({
				toolCallId: "call-exec",
				requestedToolName: "shell_exec",
				resolvedToolName: "shell_exec",
				parsedArguments: { command: "git status --short" },
				riskLevel: "exec",
			}),
		).toEqual({
			operation: "process",
		});
		expect(
			genericSandboxPolicy({
				toolCallId: "call-network",
				requestedToolName: "web_fetch",
				resolvedToolName: "web_fetch",
				parsedArguments: { url: "https://example.com" },
				riskLevel: "read",
				sandboxOperation: "network",
				origin: "agent",
			}),
		).toEqual({
			operation: "network",
			origin: "agent",
		});
		expect(
			genericSandboxPolicy({
				toolCallId: "call-high-risk",
				requestedToolName: "custom_high_risk",
				resolvedToolName: "custom_high_risk",
				parsedArguments: {},
				riskLevel: "high-risk",
			}),
		).toEqual({
			operation: "write",
			signals: {
				unknown: ["high_risk_without_explicit_sandbox_operation"],
			},
		});
		expect(
			genericSandboxPolicy({
				toolCallId: "call-unknown",
				requestedToolName: "custom_tool",
				resolvedToolName: "custom_tool",
				parsedArguments: {},
			}),
		).toBeUndefined();
	});

	it("resolves static and dynamic sandbox policies", async () => {
		const context = {
			toolCallId: "call-policy",
			requestedToolName: "file_write",
			resolvedToolName: "file_write",
			parsedArguments: { path: "demo.txt" },
			riskLevel: "write",
		};

		await expect(
			resolveSandboxPolicy({ operation: "read" }, context),
		).resolves.toEqual({
			operation: "read",
		});
		await expect(
			resolveSandboxPolicy(
				(toolContext) => ({
					operation: toolContext.riskLevel === "write" ? "write" : "read",
				}),
				context,
			),
		).resolves.toEqual({
			operation: "write",
		});
	});

	it("exposes the default evaluator as the generic policy adapter", () => {
		const decision = defaultSandboxEvaluator(
			{ operation: "write" },
			{
				toolCallId: "call-write",
				requestedToolName: "file_write",
				resolvedToolName: "file_write",
				parsedArguments: { path: "demo.txt" },
				riskLevel: "write",
			},
		);

		expect(decision.kind).toBe("ask");
		expect(decision.reasonCodes).toEqual(["write_operation_requires_approval"]);
	});

	it("creates stable approval summaries for write approval requests", () => {
		const decision = evaluateSandboxRequest({
			operation: "write",
		});
		const summary = createSandboxApprovalSummary(decision, {
			toolCallId: "call-write-summary",
			requestedToolName: "file_write",
			resolvedToolName: "file_write",
			parsedArguments: { path: "demo.txt", content: "top-secret" },
			origin: "agent",
		});

		expect(summary).toEqual({
			tool: "file_write",
			call: "call-write-summary",
			origin: "agent",
			kind: "ask",
			requiredApprovals: ["write_authority", "user_confirmation"],
			reasonCodes: ["write_operation_requires_approval"],
			summary: "Sandbox approval required for file_write.",
			detail:
				"call=call-write-summary; origin=agent; kind=ask; requiredApprovals=write_authority,user_confirmation; reasonCodes=write_operation_requires_approval",
		});
		expect(JSON.stringify(summary)).not.toContain("top-secret");
	});

	it("creates stable approval summaries for network approval requests", () => {
		const decision = evaluateSandboxRequest({
			operation: "network",
			signals: {
				network: {
					destination: "api.example.com",
					protocol: "https",
					method: "POST",
					sendsCredentials: true,
				},
			},
		});
		const summary = createSandboxApprovalSummary(decision, {
			toolCallId: "call-network-summary",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: {},
		});

		expect(summary).toEqual({
			tool: "web_fetch",
			call: "call-network-summary",
			origin: "unknown",
			kind: "ask",
			requiredApprovals: ["network_access", "user_confirmation"],
			reasonCodes: [
				"network_operation_requires_approval",
				"network_credentials_require_approval",
			],
			summary: "Sandbox approval required for web_fetch.",
			detail:
				"call=call-network-summary; origin=unknown; kind=ask; requiredApprovals=network_access,user_confirmation; reasonCodes=network_operation_requires_approval,network_credentials_require_approval",
		});
	});

	it("creates stable approval summaries for denied process requests", () => {
		const decision = evaluateSandboxRequest({
			operation: "process",
			signals: {
				process: {
					executable: "rm",
					args: ["-rf", "/"],
					destructive: true,
				},
			},
		});
		const summary = createSandboxApprovalSummary(decision, {
			toolCallId: "call-process-summary",
			requestedToolName: "shell_exec",
			resolvedToolName: "shell_exec",
			parsedArguments: {},
			origin: "agent",
		});

		expect(summary).toEqual({
			tool: "shell_exec",
			call: "call-process-summary",
			origin: "agent",
			kind: "deny",
			requiredApprovals: [],
			reasonCodes: [
				"process_operation_requires_approval",
				"destructive_process_denied",
			],
			summary: "Sandbox denied tool execution for shell_exec.",
			detail:
				"call=call-process-summary; origin=agent; kind=deny; requiredApprovals=none; reasonCodes=process_operation_requires_approval,destructive_process_denied",
		});
	});

	it("allows plain read operations by default", () => {
		const decision = evaluateSandboxRequest({
			operation: "read",
			signals: {
				paths: [
					{
						path: "README.md",
						access: "read",
					},
				],
			},
		});

		expect(decision).toEqual({
			kind: "allow",
			reasonCodes: ["read_operation_allowed"],
			requiredApprovals: [],
		});
	});

	it("asks for write approval by default", () => {
		const decision = evaluateSandboxRequest({
			operation: "write",
			signals: {
				paths: [
					{
						path: "packages/agent-core/src/tools/example.ts",
						access: "write",
					},
				],
			},
		});

		expect(decision).toEqual({
			kind: "ask",
			reasonCodes: ["write_operation_requires_approval"],
			requiredApprovals: ["write_authority", "user_confirmation"],
		});
	});

	it("asks before public network access", () => {
		const decision = evaluateSandboxRequest({
			operation: "network",
			signals: {
				network: {
					destination: "https://example.com",
					protocol: "https",
					method: "GET",
				},
			},
		});

		expect(decision).toEqual({
			kind: "ask",
			reasonCodes: ["network_operation_requires_approval"],
			requiredApprovals: ["network_access", "user_confirmation"],
		});
	});

	it("asks for credential approval when network signals send credentials", () => {
		const decision = evaluateSandboxRequest({
			operation: "network",
			signals: {
				network: {
					destination: "api.example.com",
					protocol: "https",
					method: "POST",
					sendsCredentials: true,
				},
			},
		});

		expect(decision).toEqual({
			kind: "ask",
			reasonCodes: [
				"network_operation_requires_approval",
				"network_credentials_require_approval",
			],
			requiredApprovals: ["network_access", "user_confirmation"],
		});
	});

	it("asks before ordinary process execution", () => {
		const decision = evaluateSandboxRequest({
			operation: "process",
			signals: {
				process: {
					executable: "git",
					args: ["status", "--short"],
				},
			},
		});

		expect(decision).toEqual({
			kind: "ask",
			reasonCodes: ["process_operation_requires_approval"],
			requiredApprovals: ["process_execution", "user_confirmation"],
		});
	});

	it("asks for write authority when process signals write to the filesystem", () => {
		const decision = evaluateSandboxRequest({
			operation: "process",
			signals: {
				process: {
					commandLine: "touch output.txt",
					executable: "touch",
					args: ["output.txt"],
					shell: false,
					writesFilesystem: true,
				},
			},
		});

		expect(decision).toEqual({
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
		});
	});

	it("denies critical and sensitive path operations", () => {
		const decision = evaluateSandboxRequest({
			operation: "read",
			signals: {
				critical: true,
				paths: [
					{
						path: "/etc/shadow",
						access: "read",
						systemPath: true,
					},
				],
			},
		});

		expect(decision.kind).toBe("deny");
		expect(decision.reasonCodes).toEqual(
			expect.arrayContaining([
				"critical_operation_denied",
				"sensitive_path_denied",
			]),
		);
		expect(decision.requiredApprovals).toEqual([]);
	});

	it("denies private network targets", () => {
		const decision = evaluateSandboxRequest({
			operation: "network",
			signals: {
				network: {
					destination: "http://127.0.0.1:8080",
					protocol: "http",
					privateAddress: true,
				},
			},
		});

		expect(decision.kind).toBe("deny");
		expect(decision.reasonCodes).toEqual(
			expect.arrayContaining([
				"network_operation_requires_approval",
				"private_network_denied",
			]),
		);
		expect(decision.requiredApprovals).toEqual([]);
	});

	it("denies destructive process signals", () => {
		const decision = evaluateSandboxRequest({
			operation: "process",
			signals: {
				process: {
					executable: "rm",
					args: ["-rf", "/"],
					destructive: true,
				},
			},
		});

		expect(decision.kind).toBe("deny");
		expect(decision.reasonCodes).toEqual(
			expect.arrayContaining([
				"process_operation_requires_approval",
				"destructive_process_denied",
			]),
		);
		expect(decision.requiredApprovals).toEqual([]);
	});

	it("denies unknown risk signals conservatively", () => {
		const decision = evaluateSandboxRequest({
			operation: "read",
			signals: {
				unknown: ["unclassified_device_access"],
			},
		});

		expect(decision.kind).toBe("deny");
		expect(decision.reasonCodes).toEqual(
			expect.arrayContaining(["unknown_risk_signal_denied"]),
		);
		expect(decision.reasonCodes).not.toContain("read_operation_allowed");
	});

	it("denies unknown runtime enum values from deserialized requests", () => {
		const decision = evaluateSandboxRequest({
			operation: "read",
			origin: "daemon" as never,
			signals: {
				paths: [
					{
						path: "README.md",
						access: "mutate" as never,
					},
				],
			},
		});

		expect(decision.kind).toBe("deny");
		expect(decision.reasonCodes).toEqual(
			expect.arrayContaining([
				"unknown_origin_denied",
				"unknown_path_access_denied",
			]),
		);
		expect(decision.reasonCodes).not.toContain("read_operation_allowed");
		expect(decision.requiredApprovals).toEqual([]);
	});

	it("asks when network or process signals appear on a read operation", () => {
		const networkDecision = evaluateSandboxRequest({
			operation: "read",
			signals: {
				network: {
					destination: "https://example.com",
					protocol: "https",
				},
			},
		});
		const processDecision = evaluateSandboxRequest({
			operation: "read",
			signals: {
				process: {
					executable: "git",
					args: ["status", "--short"],
				},
			},
		});

		expect(networkDecision).toEqual({
			kind: "ask",
			reasonCodes: [
				"read_operation_allowed",
				"network_operation_requires_approval",
			],
			requiredApprovals: ["network_access", "user_confirmation"],
		});
		expect(processDecision).toEqual({
			kind: "ask",
			reasonCodes: [
				"read_operation_allowed",
				"process_operation_requires_approval",
			],
			requiredApprovals: ["process_execution", "user_confirmation"],
		});
	});

	it("denies idle-time non-read operations instead of asking", () => {
		const decision = evaluateSandboxRequest({
			operation: "write",
			origin: "idle",
			signals: {
				paths: [
					{
						path: "packages/agent-core/src/tools/example.ts",
						access: "write",
					},
				],
			},
		});

		expect(decision.kind).toBe("deny");
		expect(decision.reasonCodes).toEqual(
			expect.arrayContaining([
				"write_operation_requires_approval",
				"idle_non_read_operation_denied",
			]),
		);
		expect(decision.requiredApprovals).toEqual([]);
	});

	it("denies unknown operation types conservatively", () => {
		const decision = evaluateSandboxRequest({
			operation: "kernel_module_load",
		});

		expect(decision).toEqual({
			kind: "deny",
			reasonCodes: ["unknown_operation_denied"],
			requiredApprovals: [],
		});
	});
});
