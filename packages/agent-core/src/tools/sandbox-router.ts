import { createHash } from "node:crypto";

export type SandboxProviderKind =
	| "docker"
	| "local-dev"
	| "openai-hosted"
	| "e2b"
	| "modal"
	| "daytona";

export type SandboxPurpose =
	| "agent-task"
	| "benchmark"
	| "tool-worker"
	| "dev-shell";

export type SandboxSessionStateKind =
	| "allocated"
	| "pulling"
	| "creating"
	| "starting"
	| "ready"
	| "leased"
	| "executing"
	| "snapshotting"
	| "suspending"
	| "resuming"
	| "draining"
	| "destroyed"
	| "failed";

export type SandboxPhase =
	| "create"
	| "resume"
	| "inspect"
	| "execute"
	| "install"
	| "snapshot"
	| "suspend"
	| "destroy";

export type SandboxDestroyReason =
	| "completed"
	| "canceled"
	| "expired"
	| "failed"
	| "cleanup";

export type SandboxSuspendReason =
	| "user_pause"
	| "budget_exhausted"
	| "handoff"
	| "maintenance";

export type SandboxMountKind =
	| "base"
	| "task"
	| "artifacts"
	| "cache"
	| "secrets";

export type SandboxMountAccess = "readonly" | "readwrite";

export type SandboxNetworkMode = "none" | "allowlist" | "debug-bridge";

export type SandboxPermissionMode = "readonly" | "readwrite" | "execute";

export type SandboxRouteReason =
	| "default_docker"
	| "explicit_provider"
	| "local_dev_explicit"
	| "hosted_provider_spike";

export type SandboxRuntimeContext =
	| "local-development"
	| "ci"
	| "daemon"
	| "remote"
	| "production";

export type SandboxFailureKind =
	| "policy_rejected"
	| "provider_unavailable"
	| "image_unavailable"
	| "mount_failed"
	| "network_denied"
	| "command_failed"
	| "timeout"
	| "output_truncated"
	| "snapshot_failed"
	| "resume_mismatch"
	| "cleanup_failed";

export interface SandboxOwner {
	readonly agentId?: string;
	readonly runId?: string;
	readonly taskId?: string;
	readonly userId?: string;
}

export interface SandboxLease {
	readonly owner: SandboxOwner;
	readonly acquiredAt: string;
	readonly expiresAt: string;
}

export interface SandboxImageSpec {
	readonly reference: string;
	readonly digest?: string;
	readonly allowlisted?: boolean;
}

export interface SandboxMountSpec {
	readonly kind: SandboxMountKind;
	readonly sandboxPath: string;
	readonly hostPath?: string;
	readonly access: SandboxMountAccess;
	readonly required: boolean;
	readonly scope?: string;
}

export interface SandboxNetworkAllowlistEntry {
	readonly host?: string;
	readonly origin?: string;
	readonly purpose: string;
}

export interface SandboxNetworkPolicy {
	readonly mode: SandboxNetworkMode;
	readonly allowlist?: readonly SandboxNetworkAllowlistEntry[];
}

export interface SandboxResourcePolicy {
	readonly cpuCount?: number;
	readonly memoryMb?: number;
	readonly memorySwapMb?: number;
	readonly processCount?: number;
	readonly diskOutputBytes?: number;
	readonly stdoutBytes?: number;
	readonly stderrBytes?: number;
	readonly wallClockTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly concurrency?: number;
}

export interface SandboxOutputPolicy {
	readonly artifactsPath: string;
	readonly maxArtifactBytes: number;
	readonly includeHiddenFiles: boolean;
	readonly promotePatterns: readonly string[];
	readonly exposePartialOutputOnFailure: boolean;
}

export interface SandboxPermissionIdentity {
	readonly user?: string;
	readonly role: "explorer" | "worker" | "owner" | (string & {});
}

export interface SandboxPermissionManifest {
	readonly identity: SandboxPermissionIdentity;
	readonly filesystem: Readonly<
		Record<SandboxPermissionMode, readonly string[]>
	>;
	readonly sessionSharing: "shared-readonly" | "isolated";
	readonly allowSecretMounts: boolean;
}

export interface SandboxCreateRequest {
	readonly owner: SandboxOwner;
	readonly purpose: SandboxPurpose;
	readonly providerPreference?: readonly SandboxProviderKind[];
	readonly image: SandboxImageSpec;
	readonly mounts: readonly SandboxMountSpec[];
	readonly networkPolicy: SandboxNetworkPolicy;
	readonly resourcePolicy: SandboxResourcePolicy;
	readonly outputPolicy: SandboxOutputPolicy;
	readonly permissionManifest: SandboxPermissionManifest;
	readonly ttlMs: number;
}

export interface SandboxResumeRequest {
	readonly owner: SandboxOwner;
	readonly snapshot: SandboxSnapshotRef;
	readonly providerPreference?: readonly SandboxProviderKind[];
	readonly traceId: string;
	readonly auditRef: string;
}

export interface SandboxCommandInput {
	readonly argv: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

export interface SandboxInstallInput {
	readonly packages: readonly string[];
	readonly manager: "npm" | "pnpm" | "uv" | "pip" | "apt" | (string & {});
	readonly timeoutMs?: number;
}

export interface SandboxSnapshotInput {
	readonly reason: string;
	readonly includeArtifacts: boolean;
	readonly includeCacheMetadata: boolean;
}

export interface SandboxArtifactRef {
	readonly path: string;
	readonly bytes?: number;
	readonly promoted: boolean;
}

export interface SandboxMetrics {
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly durationMs?: number;
	readonly stdoutBytes?: number;
	readonly stderrBytes?: number;
	readonly artifactBytes?: number;
}

export interface SandboxFailure {
	readonly kind: SandboxFailureKind;
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly provider: SandboxProviderKind;
	readonly phase: SandboxPhase;
	readonly commandExitCode?: number | null;
	readonly stderrPreview?: string;
	readonly traceId: string;
	readonly auditRef: string;
}

export interface SandboxCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly outputTruncated: boolean;
	readonly output_truncated: boolean;
	readonly artifactsDir?: string;
	readonly containerName?: string;
	readonly artifacts: readonly SandboxArtifactRef[];
	readonly metrics: SandboxMetrics;
	readonly failure?: SandboxFailure;
	readonly provider: SandboxProviderKind;
	readonly sessionId: string;
	readonly traceId: string;
	readonly auditRef: string;
	readonly isIsolationBoundary: boolean;
	readonly risk: "production" | "hosted" | "dev-only";
}

export interface SandboxInstallResult {
	readonly ok: boolean;
	readonly packages: readonly string[];
	readonly failure?: SandboxFailure;
	readonly metrics: SandboxMetrics;
	readonly traceId: string;
	readonly auditRef: string;
}

export interface SandboxPolicyDigest {
	readonly algorithm: "sha256";
	readonly value: string;
}

export type SandboxPolicyDigestInput = Pick<
	SandboxCreateRequest,
	| "image"
	| "mounts"
	| "networkPolicy"
	| "resourcePolicy"
	| "outputPolicy"
	| "permissionManifest"
	| "ttlMs"
>;

export interface SandboxSnapshotFileRef {
	readonly path: string;
	readonly bytes?: number;
	readonly digest?: SandboxPolicyDigest;
}

export interface SandboxSnapshotRef {
	readonly id: string;
	readonly provider: SandboxProviderKind;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly image: SandboxImageSpec;
	readonly policyDigest: SandboxPolicyDigest;
	readonly state: SandboxSessionStateKind;
	readonly files: readonly SandboxSnapshotFileRef[];
	readonly cacheMetadata?: Readonly<Record<string, unknown>>;
	readonly environmentManifest: Readonly<Record<string, string>>;
	readonly commandHistoryRef?: string;
	readonly needsReplay?: boolean;
}

export interface SandboxSessionState {
	readonly id: string;
	readonly provider: SandboxProviderKind;
	readonly state: SandboxSessionStateKind;
	readonly owner: SandboxOwner;
	readonly purpose: SandboxPurpose;
	readonly lease?: SandboxLease;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly expiresAt: string;
	readonly lastFailure?: SandboxFailure;
	readonly traceId: string;
	readonly auditRef: string;
}

export interface SandboxSession {
	readonly id: string;
	readonly provider: SandboxProviderKind;
	readonly policy: SandboxCreateRequest;
	readonly state: SandboxSessionState;

	execute(input: SandboxCommandInput): Promise<SandboxCommandResult>;
	install(input: SandboxInstallInput): Promise<SandboxInstallResult>;
	snapshot(input: SandboxSnapshotInput): Promise<SandboxSnapshotRef>;
	suspend(reason: SandboxSuspendReason): Promise<SandboxSnapshotRef>;
	destroy(reason: SandboxDestroyReason): Promise<void>;
}

export interface SandboxRouter {
	createSession(request: SandboxCreateRequest): Promise<SandboxSession>;
	resumeSession(request: SandboxResumeRequest): Promise<SandboxSession>;
	inspectSession(id: string): Promise<SandboxSessionState>;
	destroySession(id: string, reason: SandboxDestroyReason): Promise<void>;
}

export interface SandboxRouteDecision {
	readonly kind: "sandbox_route_decision";
	readonly schemaVersion: 1;
	readonly provider: SandboxProviderKind;
	readonly reason: SandboxRouteReason;
	readonly policyDigest: SandboxPolicyDigest;
	readonly leaseOwnerRef: string;
	readonly traceId: string;
	readonly auditRef: string;
	readonly isIsolationBoundary: boolean;
	readonly risk: "production" | "hosted" | "dev-only";
}

export interface SandboxProviderSelectionOptions {
	readonly availableProviders?: readonly SandboxProviderKind[];
	readonly allowLocalDevUnsafe?: boolean;
	readonly runtimeContext?: SandboxRuntimeContext;
	readonly multiUser?: boolean;
	readonly traceId: string;
	readonly auditRef: string;
}

export type SandboxProviderSelection =
	| {
			readonly kind: "selected";
			readonly decision: SandboxRouteDecision;
	  }
	| {
			readonly kind: "rejected";
			readonly failure: SandboxFailure;
	  };

function normalizeForStableJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeForStableJson(item));
	}

	if (value == null || typeof value !== "object") {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, normalizeForStableJson(item)]),
	);
}

function stableJson(value: unknown): string {
	return JSON.stringify(normalizeForStableJson(value));
}

function sandboxOwnerRef(owner: SandboxOwner): string {
	const digest = createHash("sha256").update(stableJson(owner)).digest("hex");
	return `owner:sha256:${digest}`;
}

function providerRisk(
	provider: SandboxProviderKind,
): SandboxRouteDecision["risk"] {
	if (provider === "local-dev") {
		return "dev-only";
	}
	return provider === "docker" ? "production" : "hosted";
}

function providerIsIsolationBoundary(provider: SandboxProviderKind): boolean {
	return provider === "docker" || providerRisk(provider) === "hosted";
}

function routeReasonForProvider(
	provider: SandboxProviderKind,
	explicit: boolean,
): SandboxRouteReason {
	if (provider === "local-dev") {
		return "local_dev_explicit";
	}
	if (provider === "docker" && !explicit) {
		return "default_docker";
	}
	return provider === "docker" ? "explicit_provider" : "hosted_provider_spike";
}

const RETRYABLE_FAILURE_KINDS = new Set<SandboxFailureKind>([
	"provider_unavailable",
	"image_unavailable",
	"snapshot_failed",
	"cleanup_failed",
]);

const SANDBOX_PROVIDER_KINDS = new Set<SandboxProviderKind>([
	"docker",
	"local-dev",
	"openai-hosted",
	"e2b",
	"modal",
	"daytona",
]);

const SANDBOX_ROUTE_REASONS = new Set<SandboxRouteReason>([
	"default_docker",
	"explicit_provider",
	"local_dev_explicit",
	"hosted_provider_spike",
]);

function isSandboxProviderKind(
	provider: unknown,
): provider is SandboxProviderKind {
	return (
		typeof provider === "string" &&
		SANDBOX_PROVIDER_KINDS.has(provider as SandboxProviderKind)
	);
}

function unknownSandboxProviderSelection(
	options: Pick<SandboxProviderSelectionOptions, "auditRef" | "traceId">,
): SandboxProviderSelection {
	return {
		kind: "rejected",
		failure: createSandboxFailure({
			kind: "policy_rejected",
			code: "sandbox_provider_unknown",
			message: "Unknown sandbox provider requested.",
			provider: "docker",
			phase: "create",
			traceId: options.traceId,
			auditRef: options.auditRef,
			retryable: false,
		}),
	};
}

export function createSandboxPolicyDigest(
	input: SandboxPolicyDigestInput,
): SandboxPolicyDigest {
	const policy: SandboxPolicyDigestInput = {
		image: input.image,
		mounts: input.mounts,
		networkPolicy: input.networkPolicy,
		resourcePolicy: input.resourcePolicy,
		outputPolicy: input.outputPolicy,
		permissionManifest: input.permissionManifest,
		ttlMs: input.ttlMs,
	};

	return {
		algorithm: "sha256",
		value: createHash("sha256").update(stableJson(policy)).digest("hex"),
	};
}

export const digestSandboxPolicy = createSandboxPolicyDigest;

export function createSandboxAuditRef(input: {
	readonly traceId: string;
	readonly phase: SandboxPhase;
	readonly sessionId?: string;
}): string {
	return ["sandbox", input.traceId, input.phase, input.sessionId ?? "new"].join(
		":",
	);
}

export function createSandboxFailure(options: {
	readonly kind: SandboxFailureKind;
	readonly code: string;
	readonly message: string;
	readonly provider: SandboxProviderKind;
	readonly phase: SandboxPhase;
	readonly traceId: string;
	readonly auditRef: string;
	readonly retryable?: boolean;
	readonly commandExitCode?: number | null;
	readonly stderrPreview?: string;
}): SandboxFailure {
	return {
		kind: options.kind,
		code: options.code,
		message: options.message,
		retryable: options.retryable ?? RETRYABLE_FAILURE_KINDS.has(options.kind),
		provider: options.provider,
		phase: options.phase,
		traceId: options.traceId,
		auditRef: options.auditRef,
		...(options.commandExitCode === undefined
			? {}
			: { commandExitCode: options.commandExitCode }),
		...(options.stderrPreview == null
			? {}
			: { stderrPreview: options.stderrPreview }),
	};
}

export function normalizeSandboxFailure(
	error: unknown,
	context: {
		readonly provider: SandboxProviderKind;
		readonly phase: SandboxPhase;
		readonly traceId: string;
		readonly auditRef: string;
		readonly kind?: SandboxFailureKind;
		readonly code?: string;
		readonly retryable?: boolean;
	},
): SandboxFailure {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Sandbox operation failed.";

	return createSandboxFailure({
		kind: context.kind ?? "provider_unavailable",
		code: context.code ?? "sandbox_operation_failed",
		message,
		provider: context.provider,
		phase: context.phase,
		traceId: context.traceId,
		auditRef: context.auditRef,
		...(context.retryable == null ? {} : { retryable: context.retryable }),
	});
}

function buildSandboxRouteDecision(options: {
	readonly request: SandboxCreateRequest;
	readonly provider: SandboxProviderKind;
	readonly reason?: SandboxRouteReason;
	readonly traceId: string;
	readonly auditRef: string;
	readonly localDevApproved?: boolean;
}): SandboxRouteDecision {
	if (!isSandboxProviderKind(options.provider)) {
		throw new TypeError("Sandbox route decisions require a known provider.");
	}

	if (options.provider === "local-dev" && options.localDevApproved !== true) {
		throw new TypeError(
			"LocalSandbox route decisions must be created through selectSandboxProvider.",
		);
	}

	const reason =
		options.reason ??
		routeReasonForProvider(
			options.provider,
			(options.request.providerPreference?.length ?? 0) > 0,
		);

	if (!SANDBOX_ROUTE_REASONS.has(reason)) {
		throw new TypeError("Sandbox route decisions require a known reason code.");
	}

	return {
		kind: "sandbox_route_decision",
		schemaVersion: 1,
		provider: options.provider,
		reason,
		policyDigest: createSandboxPolicyDigest(options.request),
		leaseOwnerRef: sandboxOwnerRef(options.request.owner),
		traceId: options.traceId,
		auditRef: options.auditRef,
		isIsolationBoundary: providerIsIsolationBoundary(options.provider),
		risk: providerRisk(options.provider),
	};
}

export function createSandboxRouteDecision(options: {
	readonly request: SandboxCreateRequest;
	readonly provider: SandboxProviderKind;
	readonly reason?: SandboxRouteReason;
	readonly traceId: string;
	readonly auditRef: string;
}): SandboxRouteDecision {
	return buildSandboxRouteDecision(options);
}

export function selectSandboxProvider(
	request: SandboxCreateRequest,
	options: SandboxProviderSelectionOptions,
): SandboxProviderSelection {
	const preference = request.providerPreference ?? ["docker"];
	const availableProviderList = options.availableProviders ?? preference;
	if (
		[...preference, ...availableProviderList].some(
			(candidate) => !isSandboxProviderKind(candidate),
		)
	) {
		return unknownSandboxProviderSelection(options);
	}

	const availableProviders = new Set(availableProviderList);
	const provider = preference.find((candidate) =>
		availableProviders.has(candidate),
	);

	if (provider == null) {
		return {
			kind: "rejected",
			failure: createSandboxFailure({
				kind: "provider_unavailable",
				code: "sandbox_provider_unavailable",
				message: "No requested sandbox provider is available.",
				provider: preference[0] ?? "docker",
				phase: "create",
				traceId: options.traceId,
				auditRef: options.auditRef,
			}),
		};
	}

	if (provider !== "local-dev") {
		return {
			kind: "selected",
			decision: createSandboxRouteDecision({
				request,
				provider,
				traceId: options.traceId,
				auditRef: options.auditRef,
			}),
		};
	}

	if (request.purpose !== "dev-shell") {
		return {
			kind: "rejected",
			failure: createSandboxFailure({
				kind: "policy_rejected",
				code: "local_dev_requires_dev_shell_purpose",
				message: "LocalSandbox is restricted to dev-shell sessions.",
				provider,
				phase: "create",
				traceId: options.traceId,
				auditRef: options.auditRef,
				retryable: false,
			}),
		};
	}

	if (options.allowLocalDevUnsafe !== true) {
		return {
			kind: "rejected",
			failure: createSandboxFailure({
				kind: "policy_rejected",
				code: "local_dev_requires_explicit_unsafe",
				message: "LocalSandbox requires explicit unsafe development opt-in.",
				provider,
				phase: "create",
				traceId: options.traceId,
				auditRef: options.auditRef,
				retryable: false,
			}),
		};
	}

	if (options.runtimeContext !== "local-development") {
		return {
			kind: "rejected",
			failure: createSandboxFailure({
				kind: "policy_rejected",
				code: "local_dev_requires_local_development_runtime",
				message: "LocalSandbox requires a local-development runtime context.",
				provider,
				phase: "create",
				traceId: options.traceId,
				auditRef: options.auditRef,
				retryable: false,
			}),
		};
	}

	if (options.multiUser === true) {
		return {
			kind: "rejected",
			failure: createSandboxFailure({
				kind: "policy_rejected",
				code: "local_dev_rejects_multi_user_runtime",
				message: "LocalSandbox is not allowed in multi-user runtimes.",
				provider,
				phase: "create",
				traceId: options.traceId,
				auditRef: options.auditRef,
				retryable: false,
			}),
		};
	}

	return {
		kind: "selected",
		decision: buildSandboxRouteDecision({
			request,
			provider,
			traceId: options.traceId,
			auditRef: options.auditRef,
			localDevApproved: true,
		}),
	};
}
