import { describe, expect, it, vi } from "vitest";
import {
	createSandboxAuditRef,
	createSandboxFailure,
	createSandboxPolicyDigest,
	createSandboxRouteDecision,
	normalizeSandboxFailure,
	type SandboxCreateRequest,
	type SandboxProviderKind,
	type SandboxRouteReason,
	type SandboxRouter,
	type SandboxSession,
	type SandboxSnapshotRef,
	selectSandboxProvider,
} from "./sandbox-router.js";

const createRequest: SandboxCreateRequest = {
	owner: {
		userId: "user-1",
		agentId: "agent-1",
		runId: "run-1",
		taskId: "task-1",
	},
	purpose: "tool-worker",
	image: {
		reference: "python:3.14-slim",
		allowlisted: true,
	},
	mounts: [
		{
			kind: "base",
			hostPath: "/Users/alice/project",
			sandboxPath: "/workspace/base",
			access: "readonly",
			required: true,
		},
		{
			kind: "artifacts",
			hostPath: "/tmp/quilin-artifacts",
			sandboxPath: "/workspace/artifacts",
			access: "readwrite",
			required: true,
		},
	],
	networkPolicy: {
		mode: "allowlist",
		allowlist: [{ host: "api.example.com", purpose: "fetch package index" }],
	},
	resourcePolicy: {
		cpuCount: 2,
		memoryMb: 1024,
		processCount: 64,
		stdoutBytes: 8192,
		stderrBytes: 8192,
		wallClockTimeoutMs: 30_000,
		concurrency: 1,
	},
	outputPolicy: {
		artifactsPath: "/workspace/artifacts",
		maxArtifactBytes: 1_000_000,
		includeHiddenFiles: false,
		promotePatterns: ["*.json"],
		exposePartialOutputOnFailure: true,
	},
	permissionManifest: {
		identity: { user: "quilin-worker", role: "worker" },
		filesystem: {
			readonly: ["/workspace/base"],
			readwrite: ["/workspace/task", "/workspace/artifacts"],
			execute: ["/workspace/task"],
		},
		sessionSharing: "isolated",
		allowSecretMounts: false,
	},
	ttlMs: 300_000,
};

describe("sandbox router contracts", () => {
	it("creates deterministic policy digests without exposing raw policy fields", () => {
		const digest = createSandboxPolicyDigest(createRequest);
		const sameDigest = createSandboxPolicyDigest({
			ttlMs: createRequest.ttlMs,
			permissionManifest: createRequest.permissionManifest,
			outputPolicy: createRequest.outputPolicy,
			resourcePolicy: createRequest.resourcePolicy,
			networkPolicy: createRequest.networkPolicy,
			mounts: createRequest.mounts,
			image: createRequest.image,
		});

		expect(digest).toEqual({
			algorithm: "sha256",
			value: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(sameDigest).toEqual(digest);
		expect(JSON.stringify(digest)).not.toContain("/Users/alice/project");
	});

	it("creates route decisions that carry policy digest and redacted owner ref", () => {
		const decision = createSandboxRouteDecision({
			request: createRequest,
			provider: "docker",
			traceId: "trace-sandbox-1",
			auditRef: createSandboxAuditRef({
				traceId: "trace-sandbox-1",
				phase: "create",
			}),
		});

		expect(decision).toEqual({
			kind: "sandbox_route_decision",
			schemaVersion: 1,
			provider: "docker",
			reason: "default_docker",
			policyDigest: createSandboxPolicyDigest(createRequest),
			leaseOwnerRef: expect.stringMatching(/^owner:sha256:[a-f0-9]{64}$/u),
			traceId: "trace-sandbox-1",
			auditRef: "sandbox:trace-sandbox-1:create:new",
			isIsolationBoundary: true,
			risk: "production",
		});
		expect(JSON.stringify(decision)).not.toContain("/Users/alice/project");
		expect(JSON.stringify(decision)).not.toContain("tool-worker");
		expect(JSON.stringify(decision)).not.toContain("user-1");
		expect(JSON.stringify(decision)).not.toContain("agent-1");
		expect(JSON.stringify(decision)).not.toContain("run-1");
		expect(JSON.stringify(decision)).not.toContain("task-1");
	});

	it("rejects unknown route reason strings before creating audit summaries", () => {
		expect(() =>
			createSandboxRouteDecision({
				request: createRequest,
				provider: "docker",
				reason: "/Users/alice/project" as SandboxRouteReason,
				traceId: "trace-sandbox-reason",
				auditRef: "sandbox:trace-sandbox-reason:create:new",
			}),
		).toThrow(/known reason code/u);
	});

	it("rejects unknown provider strings before creating route summaries", () => {
		const unknownProvider = "/Users/alice/project" as SandboxProviderKind;

		expect(() =>
			createSandboxRouteDecision({
				request: createRequest,
				provider: unknownProvider,
				traceId: "trace-sandbox-provider",
				auditRef: "sandbox:trace-sandbox-provider:create:new",
			}),
		).toThrow(/known provider/u);

		const selectedUnknown = selectSandboxProvider(
			{
				...createRequest,
				providerPreference: [unknownProvider],
			},
			{
				availableProviders: [unknownProvider],
				traceId: "trace-sandbox-provider",
				auditRef: "sandbox:trace-sandbox-provider:create:new",
			},
		);
		const unavailableUnknown = selectSandboxProvider(
			{
				...createRequest,
				providerPreference: [unknownProvider],
			},
			{
				availableProviders: ["docker"],
				traceId: "trace-sandbox-provider-unavailable",
				auditRef: "sandbox:trace-sandbox-provider-unavailable:create:new",
			},
		);

		expect(selectedUnknown).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "policy_rejected",
				code: "sandbox_provider_unknown",
				provider: "docker",
				retryable: false,
			}),
		});
		expect(unavailableUnknown).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "policy_rejected",
				code: "sandbox_provider_unknown",
				provider: "docker",
				retryable: false,
			}),
		});
		expect(JSON.stringify(selectedUnknown)).not.toContain(
			"/Users/alice/project",
		);
		expect(JSON.stringify(unavailableUnknown)).not.toContain(
			"/Users/alice/project",
		);
	});

	it("does not silently fall back to local-dev when docker is unavailable", () => {
		const selection = selectSandboxProvider(createRequest, {
			availableProviders: ["local-dev"],
			traceId: "trace-sandbox-2",
			auditRef: "sandbox:trace-sandbox-2:create:new",
		});

		expect(selection).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "provider_unavailable",
				code: "sandbox_provider_unavailable",
				provider: "docker",
				phase: "create",
				retryable: true,
			}),
		});
	});

	it("requires explicit unsafe opt-in before selecting local-dev", () => {
		const localRequest: SandboxCreateRequest = {
			...createRequest,
			purpose: "dev-shell",
			providerPreference: ["local-dev"],
		};

		expect(() =>
			createSandboxRouteDecision({
				request: localRequest,
				provider: "local-dev",
				traceId: "trace-sandbox-3",
				auditRef: "sandbox:trace-sandbox-3:create:new",
			}),
		).toThrow(/selectSandboxProvider/u);

		expect(
			selectSandboxProvider(localRequest, {
				availableProviders: ["local-dev"],
				traceId: "trace-sandbox-3",
				auditRef: "sandbox:trace-sandbox-3:create:new",
			}),
		).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "policy_rejected",
				code: "local_dev_requires_explicit_unsafe",
				provider: "local-dev",
				retryable: false,
			}),
		});

		expect(
			selectSandboxProvider(localRequest, {
				availableProviders: ["local-dev"],
				allowLocalDevUnsafe: true,
				runtimeContext: "local-development",
				traceId: "trace-sandbox-3",
				auditRef: "sandbox:trace-sandbox-3:create:new",
			}),
		).toEqual({
			kind: "selected",
			decision: expect.objectContaining({
				provider: "local-dev",
				reason: "local_dev_explicit",
				isIsolationBoundary: false,
				risk: "dev-only",
			}),
		});
	});

	it("marks only known hosted providers as hosted isolation boundaries", () => {
		for (const provider of [
			"openai-hosted",
			"e2b",
			"modal",
			"daytona",
		] as const) {
			expect(
				createSandboxRouteDecision({
					request: { ...createRequest, providerPreference: [provider] },
					provider,
					traceId: `trace-${provider}`,
					auditRef: `sandbox:trace-${provider}:create:new`,
				}),
			).toEqual(
				expect.objectContaining({
					provider,
					isIsolationBoundary: true,
					risk: "hosted",
				}),
			);
		}
	});

	it("restricts local-dev to single-user local development shells", () => {
		const localToolWorkerRequest: SandboxCreateRequest = {
			...createRequest,
			providerPreference: ["local-dev"],
		};
		const localDevShellRequest: SandboxCreateRequest = {
			...localToolWorkerRequest,
			purpose: "dev-shell",
		};

		expect(
			selectSandboxProvider(localToolWorkerRequest, {
				availableProviders: ["local-dev"],
				allowLocalDevUnsafe: true,
				runtimeContext: "local-development",
				traceId: "trace-sandbox-3b",
				auditRef: "sandbox:trace-sandbox-3b:create:new",
			}),
		).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "policy_rejected",
				code: "local_dev_requires_dev_shell_purpose",
				retryable: false,
			}),
		});

		expect(
			selectSandboxProvider(localDevShellRequest, {
				availableProviders: ["local-dev"],
				allowLocalDevUnsafe: true,
				runtimeContext: "daemon",
				traceId: "trace-sandbox-3c",
				auditRef: "sandbox:trace-sandbox-3c:create:new",
			}),
		).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "policy_rejected",
				code: "local_dev_requires_local_development_runtime",
				retryable: false,
			}),
		});

		expect(
			selectSandboxProvider(localDevShellRequest, {
				availableProviders: ["local-dev"],
				allowLocalDevUnsafe: true,
				runtimeContext: "local-development",
				multiUser: true,
				traceId: "trace-sandbox-3d",
				auditRef: "sandbox:trace-sandbox-3d:create:new",
			}),
		).toEqual({
			kind: "rejected",
			failure: expect.objectContaining({
				kind: "policy_rejected",
				code: "local_dev_rejects_multi_user_runtime",
				retryable: false,
			}),
		});
	});

	it("normalizes structured failures with retry defaults", () => {
		expect(
			createSandboxFailure({
				kind: "timeout",
				code: "sandbox_command_timeout",
				message: "Command timed out.",
				provider: "docker",
				phase: "execute",
				traceId: "trace-sandbox-4",
				auditRef: "sandbox:trace-sandbox-4:execute:session-1",
				commandExitCode: null,
				stderrPreview: "still running",
			}),
		).toEqual({
			kind: "timeout",
			code: "sandbox_command_timeout",
			message: "Command timed out.",
			retryable: false,
			provider: "docker",
			phase: "execute",
			commandExitCode: null,
			stderrPreview: "still running",
			traceId: "trace-sandbox-4",
			auditRef: "sandbox:trace-sandbox-4:execute:session-1",
		});

		expect(
			normalizeSandboxFailure(new Error("Docker daemon unavailable"), {
				provider: "docker",
				phase: "create",
				traceId: "trace-sandbox-5",
				auditRef: "sandbox:trace-sandbox-5:create:new",
			}),
		).toMatchObject({
			kind: "provider_unavailable",
			code: "sandbox_operation_failed",
			message: "Docker daemon unavailable",
			retryable: true,
		});
	});

	it("keeps session and router interfaces type-compatible for future providers", async () => {
		const snapshot: SandboxSnapshotRef = {
			id: "snapshot-1",
			provider: "docker",
			sessionId: "session-1",
			createdAt: "2026-05-02T18:44:00.000Z",
			image: createRequest.image,
			policyDigest: createSandboxPolicyDigest(createRequest),
			state: "ready",
			files: [{ path: "/workspace/task/state.json", bytes: 42 }],
			environmentManifest: { NODE_ENV: "test" },
			needsReplay: false,
		};
		const session: SandboxSession = {
			id: "session-1",
			provider: "docker",
			policy: createRequest,
			state: {
				id: "session-1",
				provider: "docker",
				state: "ready",
				owner: createRequest.owner,
				purpose: createRequest.purpose,
				createdAt: "2026-05-02T18:43:00.000Z",
				updatedAt: "2026-05-02T18:44:00.000Z",
				expiresAt: "2026-05-02T18:49:00.000Z",
				traceId: "trace-sandbox-6",
				auditRef: "sandbox:trace-sandbox-6:create:session-1",
			},
			execute: vi.fn(async () => ({
				stdout: "ok",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				outputTruncated: false,
				output_truncated: false,
				artifacts: [],
				containerName: "quilin-session-1",
				metrics: { durationMs: 12 },
				provider: "docker" as const,
				sessionId: "session-1",
				traceId: "trace-sandbox-6",
				auditRef: "sandbox:trace-sandbox-6:execute:session-1",
				isIsolationBoundary: true,
				risk: "production" as const,
			})),
			install: vi.fn(async () => ({
				ok: true,
				packages: ["pytest"],
				metrics: {},
				traceId: "trace-sandbox-6",
				auditRef: "sandbox:trace-sandbox-6:install:session-1",
			})),
			snapshot: vi.fn(async () => snapshot),
			suspend: vi.fn(async () => snapshot),
			destroy: vi.fn(async () => undefined),
		};
		const router: SandboxRouter = {
			createSession: vi.fn(async () => session),
			resumeSession: vi.fn(async () => session),
			inspectSession: vi.fn(async () => session.state),
			destroySession: vi.fn(async () => undefined),
		};

		await expect(router.createSession(createRequest)).resolves.toBe(session);
		await expect(
			session.execute({ argv: ["node", "--version"] }),
		).resolves.toEqual(
			expect.objectContaining({
				stdout: "ok",
				provider: "docker",
				isIsolationBoundary: true,
			}),
		);
		await expect(
			session.snapshot({
				reason: "test",
				includeArtifacts: true,
				includeCacheMetadata: false,
			}),
		).resolves.toBe(snapshot);
	});
});
