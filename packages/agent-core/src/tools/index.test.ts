import { describe, expect, it } from "vitest";
import { WriteAuthority } from "../safety/write-authority.js";
import { SkillsManager } from "../skills/manager.js";
import type {
	BuiltinToolOptions,
	FileListToolOptions,
	FileReadToolOptions,
	FileWriteToolOptions,
	JsonSchema,
	MCPServerConfig,
	SandboxCreateRequest,
	SandboxDecision,
	SandboxProviderSelection,
	SandboxRequest,
	SandboxRouteDecision,
	ShellExecToolOptions,
	SkillManageToolOptions,
	SkillViewToolOptions,
	Tool,
	ToolCall,
	ToolCategory,
	ToolErrorCode,
	ToolPromptDescriptor,
	ToolResult,
	ToolRiskLevel,
	ToolRouterOptions,
	ToolWithMetadata,
	WebFetchToolOptions,
} from "./index.js";
import {
	classifyToolException,
	createBuiltinTools,
	createFileReadTool,
	createSandboxApprovalSummary,
	createSandboxAuditRef,
	createSandboxPolicyDigest,
	createSandboxRouteDecision,
	createToolError,
	createToolErrorResult,
	defaultSandboxEvaluator,
	evaluateSandboxRequest,
	genericSandboxPolicy,
	jsonSchemaToZod,
	MCP_TOOL_METADATA_MAX_LENGTH,
	MCP_TOOL_NAME_PATTERN,
	MCPClientManager,
	MCPRegistry,
	resolveSandboxPolicy,
	sanitizeMCPToolDescription,
	sanitizeMCPToolName,
	selectSandboxProvider,
	ToolRouter,
	toolExceptionMessage,
	validateMCPServerConfig,
} from "./index.js";

describe("tools barrel", () => {
	it("exposes representative tool boundary helpers from ./index.js", async () => {
		const config: MCPServerConfig = {
			command: "uv",
			args: ["run", "python", "-m", "fake-mcp"],
		};
		const routerOptions: ToolRouterOptions = {
			sandboxEvaluator: defaultSandboxEvaluator,
		};
		const skillsManager = new SkillsManager({});
		const writeAuthority = new WriteAuthority({
			mode: "ask",
			confirm: async () => true,
		});
		const fileRead: FileReadToolOptions = {
			maxChars: 64,
			maxBytes: 128,
			allowedRoots: [process.cwd()],
		};
		const fileWrite: FileWriteToolOptions = {
			maxBytes: 128,
			allowedRoots: [process.cwd()],
			authority: writeAuthority,
		};
		const fileList: FileListToolOptions = {
			allowedRoots: [process.cwd()],
		};
		const shellExec: ShellExecToolOptions = {
			defaultTimeoutMs: 1000,
			executableAllowlist: ["echo"],
			maxOutputChars: 64,
		};
		const skillView: SkillViewToolOptions = {
			skillsManager,
			maxBodyBytes: 128,
			maxBodyChars: 64,
		};
		const skillManage: SkillManageToolOptions = {
			skillsManager,
			writeAuthority,
			projectRoot: process.cwd(),
		};
		const webFetch: WebFetchToolOptions = {
			allowedAuthHosts: ["example.com"],
			maxBodyChars: 64,
			maxResponseBytes: 128,
		};
		const builtinOptions: BuiltinToolOptions = {
			fileRead,
			fileWrite,
			fileList,
			shellExec,
			webFetch,
			skillsManager,
			writeAuthority,
			skillView: {
				maxBodyBytes: skillView.maxBodyBytes,
				maxBodyChars: skillView.maxBodyChars,
			},
			skillManage: {
				projectRoot: skillManage.projectRoot,
			},
		};
		const builtinTools = createBuiltinTools(builtinOptions);
		const builtinTool: ToolWithMetadata = builtinTools[0];
		const baseTool: Tool = builtinTool;
		const toolCall: ToolCall = {
			id: "call-base-tool",
			name: baseTool.name,
			arguments: {},
		};
		const toolResult: ToolResult = {
			toolCallId: toolCall.id,
			content: "{}",
			isError: false,
		};
		const category: ToolCategory = builtinTool.category;
		const riskLevel: ToolRiskLevel = builtinTool.riskLevel;
		const descriptor: ToolPromptDescriptor = {
			name: baseTool.name,
			description: baseTool.description,
			category,
			riskLevel,
		};
		const schema: JsonSchema = {
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
		};
		const errorCode: ToolErrorCode = "tool_not_found";
		const sandboxContext = {
			toolCallId: "call-barrel",
			requestedToolName: "file_read",
			resolvedToolName: "file_read",
			parsedArguments: { path: "README.md" },
			riskLevel: "read",
		};
		const sandboxRequest: SandboxRequest = { operation: "read" };
		const sandboxCreateRequest: SandboxCreateRequest = {
			owner: { agentId: "agent-barrel", runId: "run-barrel" },
			purpose: "tool-worker",
			image: { reference: "python:3.14-slim", allowlisted: true },
			mounts: [
				{
					kind: "task",
					sandboxPath: "/workspace/task",
					access: "readwrite",
					required: true,
				},
			],
			networkPolicy: { mode: "none" },
			resourcePolicy: { wallClockTimeoutMs: 1000 },
			outputPolicy: {
				artifactsPath: "/workspace/artifacts",
				maxArtifactBytes: 1024,
				includeHiddenFiles: false,
				promotePatterns: [],
				exposePartialOutputOnFailure: true,
			},
			permissionManifest: {
				identity: { role: "worker" },
				filesystem: {
					readonly: [],
					readwrite: ["/workspace/task"],
					execute: ["/workspace/task"],
				},
				sessionSharing: "isolated",
				allowSecretMounts: false,
			},
			ttlMs: 1000,
		};

		const resolvedPolicy = await resolveSandboxPolicy(
			genericSandboxPolicy,
			sandboxContext,
		);
		const decision: SandboxDecision = defaultSandboxEvaluator(
			sandboxRequest,
			sandboxContext,
		);
		const approvalSummary = createSandboxApprovalSummary(
			decision,
			sandboxContext,
		);
		const sandboxAuditRef = createSandboxAuditRef({
			traceId: "trace-barrel",
			phase: "create",
		});
		const sandboxDigest = createSandboxPolicyDigest(sandboxCreateRequest);
		const sandboxRoute: SandboxRouteDecision = createSandboxRouteDecision({
			request: sandboxCreateRequest,
			provider: "docker",
			traceId: "trace-barrel",
			auditRef: sandboxAuditRef,
		});
		const sandboxSelection: SandboxProviderSelection = selectSandboxProvider(
			sandboxCreateRequest,
			{
				availableProviders: ["docker"],
				traceId: "trace-barrel",
				auditRef: sandboxAuditRef,
			},
		);
		const readTool = createFileReadTool({ allowedRoots: [process.cwd()] });

		expect(() => validateMCPServerConfig(config)).not.toThrow();
		expect(new MCPClientManager()).toBeInstanceOf(MCPClientManager);
		expect(new MCPRegistry()).toBeInstanceOf(MCPRegistry);
		expect(new ToolRouter([], routerOptions)).toBeInstanceOf(ToolRouter);
		expect(readTool.name).toBe("file_read");
		expect(
			createToolError({ code: errorCode, message: "missing" }),
		).toMatchObject({ code: errorCode, message: "missing" });
		expect(
			createToolErrorResult({
				toolCallId: "call-error",
				code: "execution_failed",
				message: "boom",
				retryable: false,
				details: { source: "barrel-test" },
			}),
		).toMatchObject({
			toolCallId: "call-error",
			isError: true,
			error: {
				code: "execution_failed",
				message: "boom",
				retryable: false,
				details: { source: "barrel-test" },
			},
		});
		expect(
			classifyToolException(new DOMException("late", "TimeoutError")),
		).toBe("timeout");
		expect(toolExceptionMessage(new Error("boom"))).toBe(
			"Tool execution failed.",
		);
		expect(resolvedPolicy).toMatchObject(sandboxRequest);
		expect(decision.kind).toBe("allow");
		expect(evaluateSandboxRequest(sandboxRequest)).toMatchObject(decision);
		expect(approvalSummary).toMatchObject({
			tool: "file_read",
			call: "call-barrel",
			kind: "allow",
		});
		expect(sandboxAuditRef).toBe("sandbox:trace-barrel:create:new");
		expect(sandboxDigest.value).toMatch(/^[a-f0-9]{64}$/u);
		expect(sandboxRoute).toMatchObject({
			provider: "docker",
			reason: "default_docker",
			isIsolationBoundary: true,
			risk: "production",
		});
		expect(sandboxSelection).toMatchObject({
			kind: "selected",
			decision: {
				provider: "docker",
			},
		});
		expect(builtinTools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"file_read",
				"file_write",
				"file_list",
				"shell_exec",
				"web_fetch",
			]),
		);
		expect(jsonSchemaToZod(schema).parse({ path: "README.md" })).toMatchObject({
			path: "README.md",
		});
		expect(sanitizeMCPToolName("file_read")).toBe("file_read");
		expect(
			sanitizeMCPToolDescription("Read a file", { toolName: "file_read" }),
		).toBe("Read a file");
		expect(MCP_TOOL_NAME_PATTERN.test(descriptor.name)).toBe(true);
		expect(MCP_TOOL_METADATA_MAX_LENGTH).toBeGreaterThanOrEqual(
			descriptor.description.length,
		);
		expect(toolResult).toMatchObject({
			toolCallId: "call-base-tool",
			isError: false,
		});
	});
});
