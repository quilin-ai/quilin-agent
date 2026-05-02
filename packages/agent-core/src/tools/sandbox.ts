import { BlockList, isIP } from "node:net";

export type SandboxOperationType =
	| "read"
	| "write"
	| "delete"
	| "network"
	| "process"
	| (string & {});

export type SandboxPathAccess = "read" | "write" | "delete" | "execute";

export type SandboxOrigin = "user" | "agent" | "idle";

export interface SandboxPathSignal {
	readonly path: string;
	readonly access: SandboxPathAccess;
	readonly sensitive?: boolean;
	readonly systemPath?: boolean;
	readonly outsideWorkspace?: boolean;
}

export interface SandboxNetworkSignal {
	readonly destination?: string;
	readonly protocol?: string;
	readonly method?: string;
	readonly privateAddress?: boolean;
	readonly loopback?: boolean;
	readonly sendsCredentials?: boolean;
}

export interface SandboxProcessSignal {
	readonly executable?: string;
	readonly args?: readonly string[];
	readonly commandLine?: string;
	readonly shell?: boolean;
	readonly elevatedPrivileges?: boolean;
	readonly destructive?: boolean;
	readonly writesFilesystem?: boolean;
}

export interface SandboxRiskSignals {
	readonly paths?: readonly SandboxPathSignal[];
	readonly network?: SandboxNetworkSignal;
	readonly process?: SandboxProcessSignal;
	readonly critical?: boolean;
	readonly unknown?: readonly string[];
}

export interface SandboxRequest {
	readonly operation: SandboxOperationType;
	readonly origin?: SandboxOrigin;
	readonly signals?: SandboxRiskSignals;
}

export interface SandboxToolContext {
	readonly toolCallId: string;
	readonly requestedToolName: string;
	readonly resolvedToolName: string;
	readonly parsedArguments: unknown;
	readonly origin?: SandboxOrigin;
	readonly category?: string;
	readonly riskLevel?: string;
	readonly namespace?: string;
	readonly sandboxOperation?: SandboxOperationType;
	readonly sandboxSignals?: SandboxRiskSignals;
}

export type SandboxPolicy =
	| SandboxRequest
	| ((
			context: SandboxToolContext,
	  ) => SandboxRequest | undefined | Promise<SandboxRequest | undefined>);

export type SandboxDecisionKind = "allow" | "ask" | "deny";

export type SandboxReasonCode =
	| "read_operation_allowed"
	| "write_operation_requires_approval"
	| "delete_operation_requires_approval"
	| "network_operation_requires_approval"
	| "process_operation_requires_approval"
	| "outside_workspace_requires_approval"
	| "network_credentials_require_approval"
	| "process_filesystem_write_requires_approval"
	| "unknown_operation_denied"
	| "unknown_risk_signal_denied"
	| "unknown_origin_denied"
	| "unknown_path_access_denied"
	| "critical_operation_denied"
	| "idle_non_read_operation_denied"
	| "sensitive_path_denied"
	| "private_network_denied"
	| "destructive_process_denied"
	| "elevated_process_denied"
	| "shell_process_denied";

export type SandboxRequiredApproval =
	| "user_confirmation"
	| "write_authority"
	| "network_access"
	| "process_execution";

export interface SandboxDecision {
	readonly kind: SandboxDecisionKind;
	readonly reasonCodes: readonly SandboxReasonCode[];
	readonly requiredApprovals: readonly SandboxRequiredApproval[];
}

export interface SandboxApprovalSummary {
	readonly tool: string;
	readonly call: string;
	readonly origin: SandboxOrigin | "unknown";
	readonly kind: SandboxDecisionKind;
	readonly requiredApprovals: readonly SandboxRequiredApproval[];
	readonly reasonCodes: readonly SandboxReasonCode[];
	readonly summary: string;
	readonly detail: string;
}

export interface SandboxDecisionPlanInput {
	readonly request: SandboxRequest;
	readonly context: SandboxToolContext;
}

export type SandboxDecisionKindCounts = Record<SandboxDecisionKind, number>;

export interface SandboxDecisionPlanItem extends SandboxApprovalSummary {
	readonly index: number;
	readonly operation: SandboxOperationType;
}

export interface SandboxDecisionPlan {
	readonly kind: "sandbox_decision_plan";
	readonly schemaVersion: 1;
	readonly total: number;
	readonly byKind: SandboxDecisionKindCounts;
	readonly approvalRequired: boolean;
	readonly denied: boolean;
	readonly items: ReadonlyArray<SandboxDecisionPlanItem>;
	readonly approvalRequiredCallIds: ReadonlyArray<string>;
	readonly deniedCallIds: ReadonlyArray<string>;
}

export type SandboxEvaluator = (
	request: SandboxRequest,
	context: SandboxToolContext,
) => SandboxDecision | Promise<SandboxDecision>;

type MutableEvaluation = {
	kind: SandboxDecisionKind;
	reasonCodes: SandboxReasonCode[];
	requiredApprovals: SandboxRequiredApproval[];
};

const KNOWN_OPERATIONS = new Set<SandboxOperationType>([
	"read",
	"write",
	"delete",
	"network",
	"process",
]);
const KNOWN_ORIGINS = new Set<SandboxOrigin>(["user", "agent", "idle"]);
const KNOWN_PATH_ACCESSES = new Set<SandboxPathAccess>([
	"read",
	"write",
	"delete",
	"execute",
]);

const PRIVATE_NETWORK_BLOCKLIST = new BlockList();
PRIVATE_NETWORK_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORK_BLOCKLIST.addAddress("::", "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addAddress("::1", "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:10.0.0.0", 104, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:100.64.0.0", 106, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:169.254.0.0", 112, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:172.16.0.0", 108, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("::ffff:192.168.0.0", 112, "ipv6");

function unique<T>(values: readonly T[]): readonly T[] {
	return [...new Set(values)];
}

function createSandboxDecisionKindCounts(): SandboxDecisionKindCounts {
	return {
		allow: 0,
		ask: 0,
		deny: 0,
	};
}

function formatList(values: readonly string[]): string {
	return values.length === 0 ? "none" : values.join(",");
}

function normalizeNetworkHost(hostname: string): string {
	const trimmed = hostname.trim().toLowerCase();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1);
	}

	return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

function extractNetworkDestinationHost(
	destination: string | undefined,
): string | undefined {
	const trimmed = destination?.trim();
	if (trimmed == null || trimmed.length === 0) {
		return undefined;
	}

	const normalizedLiteral = normalizeNetworkHost(trimmed);
	if (isIP(normalizedLiteral) !== 0) {
		return normalizedLiteral;
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
		try {
			return normalizeNetworkHost(new URL(trimmed).hostname);
		} catch {
			return undefined;
		}
	}

	try {
		return normalizeNetworkHost(new URL(`http://${trimmed}`).hostname);
	} catch {
		return undefined;
	}
}

function isPrivateNetworkHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		return true;
	}

	const family = isIP(hostname);
	if (family === 0) {
		return false;
	}

	return PRIVATE_NETWORK_BLOCKLIST.check(
		hostname,
		family === 6 ? "ipv6" : "ipv4",
	);
}

function approvalSummaryText(
	kind: SandboxDecisionKind,
	toolName: string,
): string {
	switch (kind) {
		case "allow":
			return `Sandbox allowed tool execution for ${toolName}.`;
		case "ask":
			return `Sandbox approval required for ${toolName}.`;
		case "deny":
			return `Sandbox denied tool execution for ${toolName}.`;
	}
}

function escalate(
	evaluation: MutableEvaluation,
	kind: SandboxDecisionKind,
	reasonCode: SandboxReasonCode,
	approvals: readonly SandboxRequiredApproval[] = [],
): void {
	if (kind === "deny") {
		evaluation.kind = "deny";
	} else if (kind === "ask" && evaluation.kind === "allow") {
		evaluation.kind = "ask";
	}

	evaluation.reasonCodes.push(reasonCode);
	evaluation.requiredApprovals.push(...approvals);
}

function evaluateOperation(
	request: SandboxRequest,
	evaluation: MutableEvaluation,
): void {
	switch (request.operation) {
		case "read":
			escalate(evaluation, "allow", "read_operation_allowed");
			return;
		case "write":
			escalate(evaluation, "ask", "write_operation_requires_approval", [
				"write_authority",
				"user_confirmation",
			]);
			return;
		case "delete":
			escalate(evaluation, "ask", "delete_operation_requires_approval", [
				"write_authority",
				"user_confirmation",
			]);
			return;
		case "network":
			if (request.signals?.network == null) {
				escalate(evaluation, "ask", "network_operation_requires_approval", [
					"network_access",
					"user_confirmation",
				]);
			}
			return;
		case "process":
			escalate(evaluation, "ask", "process_operation_requires_approval", [
				"process_execution",
				"user_confirmation",
			]);
			return;
		default:
			escalate(evaluation, "deny", "unknown_operation_denied");
	}
}

function evaluatePathSignal(
	signal: SandboxPathSignal,
	evaluation: MutableEvaluation,
): void {
	if (!KNOWN_PATH_ACCESSES.has(signal.access)) {
		escalate(evaluation, "deny", "unknown_path_access_denied");
		return;
	}

	if (signal.sensitive === true || signal.systemPath === true) {
		escalate(evaluation, "deny", "sensitive_path_denied");
		return;
	}

	if (signal.access === "write") {
		escalate(evaluation, "ask", "write_operation_requires_approval", [
			"write_authority",
			"user_confirmation",
		]);
	}

	if (signal.access === "delete") {
		escalate(evaluation, "ask", "delete_operation_requires_approval", [
			"write_authority",
			"user_confirmation",
		]);
	}

	if (signal.access === "execute") {
		escalate(evaluation, "ask", "process_operation_requires_approval", [
			"process_execution",
			"user_confirmation",
		]);
	}

	if (signal.outsideWorkspace === true) {
		escalate(evaluation, "ask", "outside_workspace_requires_approval", [
			"user_confirmation",
		]);
	}
}

function evaluateNetworkSignal(
	signal: SandboxNetworkSignal,
	evaluation: MutableEvaluation,
): void {
	const destinationHost = extractNetworkDestinationHost(signal.destination);
	if (destinationHost == null) {
		escalate(evaluation, "ask", "network_operation_requires_approval", [
			"network_access",
			"user_confirmation",
		]);
	} else if (
		signal.privateAddress === true ||
		signal.loopback === true ||
		isPrivateNetworkHost(destinationHost)
	) {
		escalate(evaluation, "deny", "private_network_denied");
		return;
	}

	if (signal.sendsCredentials === true) {
		escalate(evaluation, "ask", "network_credentials_require_approval", [
			"network_access",
			"user_confirmation",
		]);
	}
}

function evaluateProcessSignal(
	signal: SandboxProcessSignal,
	evaluation: MutableEvaluation,
): void {
	escalate(evaluation, "ask", "process_operation_requires_approval", [
		"process_execution",
		"user_confirmation",
	]);

	if (signal.destructive === true) {
		escalate(evaluation, "deny", "destructive_process_denied");
	}

	if (signal.elevatedPrivileges === true) {
		escalate(evaluation, "deny", "elevated_process_denied");
	}

	if (signal.shell === true) {
		escalate(evaluation, "deny", "shell_process_denied");
	}

	if (signal.writesFilesystem === true) {
		escalate(evaluation, "ask", "process_filesystem_write_requires_approval", [
			"process_execution",
			"write_authority",
			"user_confirmation",
		]);
	}
}

function finalizeEvaluation(evaluation: MutableEvaluation): SandboxDecision {
	const reasonCodes = unique(evaluation.reasonCodes).filter(
		(reasonCode) =>
			evaluation.kind !== "deny" || reasonCode !== "read_operation_allowed",
	);

	return {
		kind: evaluation.kind,
		reasonCodes,
		requiredApprovals:
			evaluation.kind === "deny" ? [] : unique(evaluation.requiredApprovals),
	};
}

export function genericSandboxPolicy(
	context: SandboxToolContext,
): SandboxRequest | undefined {
	if (context.sandboxOperation != null) {
		return {
			operation: context.sandboxOperation,
			...(context.origin == null ? {} : { origin: context.origin }),
			...(context.sandboxSignals == null
				? {}
				: { signals: context.sandboxSignals }),
		};
	}

	switch (context.riskLevel) {
		case "read":
			return {
				operation: "read",
				...(context.origin == null ? {} : { origin: context.origin }),
			};
		case "write":
			return {
				operation: "write",
				...(context.origin == null ? {} : { origin: context.origin }),
			};
		case "exec":
			return {
				operation: "process",
				...(context.origin == null ? {} : { origin: context.origin }),
			};
		case "high-risk":
			return {
				operation: "write",
				...(context.origin == null ? {} : { origin: context.origin }),
				signals: {
					unknown: ["high_risk_without_explicit_sandbox_operation"],
				},
			};
		default:
			return undefined;
	}
}

export async function resolveSandboxPolicy(
	policy: SandboxPolicy,
	context: SandboxToolContext,
): Promise<SandboxRequest | undefined> {
	return typeof policy === "function" ? await policy(context) : policy;
}

export function defaultSandboxEvaluator(
	request: SandboxRequest,
	_context: SandboxToolContext,
): SandboxDecision {
	return evaluateSandboxRequest(request);
}

export function createSandboxApprovalSummary(
	decision: SandboxDecision,
	context: SandboxToolContext,
): SandboxApprovalSummary {
	const origin = context.origin ?? "unknown";
	const requiredApprovals = [...decision.requiredApprovals];
	const reasonCodes = [...decision.reasonCodes];

	return {
		tool: context.resolvedToolName,
		call: context.toolCallId,
		origin,
		kind: decision.kind,
		requiredApprovals,
		reasonCodes,
		summary: approvalSummaryText(decision.kind, context.resolvedToolName),
		detail: `call=${context.toolCallId}; origin=${origin}; kind=${decision.kind}; requiredApprovals=${formatList(requiredApprovals)}; reasonCodes=${formatList(reasonCodes)}`,
	};
}

export function evaluateSandboxRequest(
	request: SandboxRequest,
): SandboxDecision {
	const evaluation: MutableEvaluation = {
		kind: "allow",
		reasonCodes: [],
		requiredApprovals: [],
	};
	const signals = request.signals ?? {};

	if (!KNOWN_OPERATIONS.has(request.operation)) {
		escalate(evaluation, "deny", "unknown_operation_denied");
	}

	if (request.origin != null && !KNOWN_ORIGINS.has(request.origin)) {
		escalate(evaluation, "deny", "unknown_origin_denied");
	}

	if (signals.critical === true) {
		escalate(evaluation, "deny", "critical_operation_denied");
	}

	if ((signals.unknown?.length ?? 0) > 0) {
		escalate(evaluation, "deny", "unknown_risk_signal_denied");
	}

	if (request.origin === "idle" && request.operation !== "read") {
		escalate(evaluation, "deny", "idle_non_read_operation_denied");
	}

	if (evaluation.reasonCodes.includes("unknown_operation_denied")) {
		return finalizeEvaluation(evaluation);
	}

	evaluateOperation(request, evaluation);

	for (const pathSignal of signals.paths ?? []) {
		evaluatePathSignal(pathSignal, evaluation);
	}

	if (signals.network != null) {
		evaluateNetworkSignal(signals.network, evaluation);
	}

	if (signals.process != null) {
		evaluateProcessSignal(signals.process, evaluation);
	}

	return finalizeEvaluation(evaluation);
}

export function buildSandboxDecisionPlan(
	inputs: Iterable<SandboxDecisionPlanInput>,
): SandboxDecisionPlan {
	const byKind = createSandboxDecisionKindCounts();
	const items: SandboxDecisionPlanItem[] = [];
	const approvalRequiredCallIds: string[] = [];
	const deniedCallIds: string[] = [];

	for (const [index, input] of [...inputs].entries()) {
		const decision = evaluateSandboxRequest(input.request);
		const summary = createSandboxApprovalSummary(decision, input.context);
		byKind[decision.kind] += 1;

		if (decision.kind === "ask") {
			approvalRequiredCallIds.push(input.context.toolCallId);
		}
		if (decision.kind === "deny") {
			deniedCallIds.push(input.context.toolCallId);
		}

		items.push({
			index,
			operation: input.request.operation,
			...summary,
		});
	}

	return {
		kind: "sandbox_decision_plan",
		schemaVersion: 1,
		total: items.length,
		byKind,
		approvalRequired: approvalRequiredCallIds.length > 0,
		denied: deniedCallIds.length > 0,
		items,
		approvalRequiredCallIds,
		deniedCallIds,
	};
}
