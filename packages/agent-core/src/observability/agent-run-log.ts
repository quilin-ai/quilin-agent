import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScanResult } from "../context/injection-scanner.js";
import type {
	NormalizedProviderError,
	ProviderRunRecord,
} from "../llm/types.js";
import type { ActionVerificationResult } from "../safety/action-verifier.js";
import {
	isSensitiveObjectKey,
	redactJsonLikeValue,
	redactString,
} from "../safety/redaction.js";
import type { Message } from "../state/types.js";
import type {
	ToolCall,
	ToolError,
	ToolInvocationAuditSummary,
	ToolResult,
} from "../tools/types.js";

export type AgentRunLogPhase =
	| "repl.session_started"
	| "turn.input_received"
	| "loop.turn_started"
	| "context.rebuild_skipped"
	| "context.outbound_request_built"
	| "context.cache_plan"
	| "context.trace_summary"
	| "context.trace_delta"
	| "checkpoint.saved"
	| "llm.request_prepared"
	| "llm.response_received"
	| "llm.provider_run"
	| "planning.tool_calls_selected"
	| "tool.call_started"
	| "tool.safety_action_verified"
	| "tool.call_completed"
	| "tool.output_scanned"
	| "tool.memory_identity_corrected"
	| "tool.result_appended"
	| "tool.provenance_recorded"
	| "assistant.response_final"
	| "turn.completed"
	| "turn.failed";

export interface AgentRunLogRecordOptions {
	readonly turnId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly requestId?: string;
}

export interface AgentRunLogRecordInput extends AgentRunLogRecordOptions {
	readonly phase: AgentRunLogPhase;
	readonly payload?: Record<string, unknown>;
}

export interface AgentRunLogEvent {
	readonly schema_version: 1;
	readonly timestamp: string;
	readonly session_id: string;
	readonly run_id: string;
	readonly process_id: number;
	readonly turn_id?: string;
	readonly trace_id?: string;
	readonly span_id?: string;
	readonly request_id?: string;
	readonly seq: number;
	readonly phase: AgentRunLogPhase;
	readonly payload: Record<string, unknown>;
}

export interface AgentRunLogSink {
	record(input: AgentRunLogRecordInput): void | Promise<void>;
	flush?(): void | Promise<void>;
}

export interface JsonlAgentRunLoggerOptions {
	readonly sessionId: string;
	readonly logsDir?: string;
	readonly runId?: string;
	readonly now?: () => Date;
}

export type ToolProvenanceAuditOutcome =
	| "usable_evidence"
	| "sanitized_warning"
	| "blocked"
	| "blocked_output"
	| "failed";

export interface ToolProvenanceEntry {
	readonly at: string;
	readonly tool: string;
	readonly callId: string;
	readonly sourceType: "url" | "tool";
	readonly url?: string;
	readonly resultReportedUrl?: string;
	readonly resultReportedUrlDiffers?: boolean;
	readonly pathChars?: number;
	readonly pathFingerprint?: string;
	readonly resultReportedPathChars?: number;
	readonly resultReportedPathFingerprint?: string;
	readonly invalidUrl?: boolean;
	readonly host?: string;
	readonly status?: number;
	readonly contentType?: string;
	readonly isError: boolean;
	readonly actionDecision?: ActionVerificationResult["decision"];
	readonly scanSafe?: boolean;
	readonly hasBlockedThreat: boolean;
	readonly trustedToolOutput: boolean;
	readonly appendedToModelContext: boolean;
	readonly auditOutcome: ToolProvenanceAuditOutcome;
	readonly usableEvidence: boolean;
}

const DEFAULT_LOGS_DIR = ".logs/agent-runs";
const DEFAULT_TEXT_PREVIEW_CHARS = 700;
const MAX_LOG_STRING_CHARS = 4_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_ARGUMENT_KEYS = 32;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

function sanitizeFilePart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "session";
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function truncateLogString(value: string): string {
	if (value.length <= MAX_LOG_STRING_CHARS) {
		return value;
	}
	let suffix = `...[truncated:${value.length - MAX_LOG_STRING_CHARS}]`;
	for (let iteration = 0; iteration < 2; iteration += 1) {
		const previewChars = Math.max(0, MAX_LOG_STRING_CHARS - suffix.length);
		suffix = `...[truncated:${value.length - previewChars}]`;
	}
	const previewChars = Math.max(0, MAX_LOG_STRING_CHARS - suffix.length);
	return `${value.slice(0, previewChars)}${suffix}`;
}

function normalizeJsonValue(
	value: unknown,
	seen: WeakSet<object>,
	depth = 0,
): unknown {
	if (value == null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return truncateLogString(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : String(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			messageChars: value.message.length,
		};
	}
	if (typeof value !== "object") {
		return `[non_serializable:${typeof value}]`;
	}
	if (seen.has(value)) {
		return "[circular]";
	}
	if (depth > 8) {
		return "[max_depth]";
	}
	seen.add(value);

	if (Array.isArray(value)) {
		const items = value
			.slice(0, MAX_ARRAY_ITEMS)
			.map((item) => normalizeJsonValue(item, seen, depth + 1));
		return value.length > MAX_ARRAY_ITEMS
			? [...items, `[truncated:${value.length - MAX_ARRAY_ITEMS}]`]
			: items;
	}

	const output: Record<string, unknown> = {};
	for (const [index, [key, item]] of Object.entries(value).entries()) {
		if (index >= MAX_OBJECT_KEYS) {
			output.__truncated_keys = Object.keys(value).length - MAX_OBJECT_KEYS;
			break;
		}
		if (item !== undefined) {
			output[key] = normalizeJsonValue(item, seen, depth + 1);
		}
	}
	return output;
}

function sanitizePayload(
	payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const normalized = normalizeJsonValue(payload ?? {}, new WeakSet<object>());
	const redacted = redactJsonLikeValue(normalized);
	return redacted != null &&
		typeof redacted === "object" &&
		!Array.isArray(redacted)
		? (redacted as Record<string, unknown>)
		: {};
}

async function appendJsonlNoFollow(
	filePath: string,
	line: string,
): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const dirStat = await lstat(dir);
	if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
		throw new Error("agent run log directory must be a real directory");
	}
	const handle = await open(
		filePath,
		constants.O_APPEND |
			constants.O_CREAT |
			constants.O_WRONLY |
			NO_FOLLOW_FLAG,
		0o600,
	);
	try {
		await handle.writeFile(line, "utf8");
	} finally {
		await handle.close();
	}
}

export class JsonlAgentRunLogger implements AgentRunLogSink {
	private readonly filePath: string;
	private readonly now: () => Date;
	private readonly runId: string;
	private writeQueue: Promise<void> = Promise.resolve();
	private seq = 0;

	constructor(private readonly options: JsonlAgentRunLoggerOptions) {
		this.filePath = join(
			options.logsDir ?? DEFAULT_LOGS_DIR,
			`${sanitizeFilePart(options.sessionId)}.jsonl`,
		);
		this.now = options.now ?? (() => new Date());
		this.runId = options.runId ?? randomUUID();
	}

	async record(input: AgentRunLogRecordInput): Promise<void> {
		const event: AgentRunLogEvent = {
			schema_version: 1,
			timestamp: this.now().toISOString(),
			session_id: this.options.sessionId,
			run_id: this.runId,
			process_id: process.pid,
			...(input.turnId == null ? {} : { turn_id: input.turnId }),
			...(input.traceId == null ? {} : { trace_id: input.traceId }),
			...(input.spanId == null ? {} : { span_id: input.spanId }),
			...(input.requestId == null ? {} : { request_id: input.requestId }),
			seq: ++this.seq,
			phase: input.phase,
			payload: sanitizePayload(input.payload),
		};
		const line = `${JSON.stringify(event)}\n`;
		const previousWrite = this.writeQueue.catch(() => undefined);
		this.writeQueue = previousWrite.then(async () => {
			await appendJsonlNoFollow(this.filePath, line);
		});
		await this.writeQueue;
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}
}

export async function recordAgentRunEvent(
	sink: AgentRunLogSink | undefined,
	phase: AgentRunLogPhase,
	payload?: Record<string, unknown>,
	options: AgentRunLogRecordOptions = {},
): Promise<void> {
	if (sink == null) {
		return;
	}
	try {
		await sink.record({ phase, payload: sanitizePayload(payload), ...options });
	} catch {
		// Observability must never break the agent loop.
	}
}

export function textPreview(
	value: string,
	maxChars = DEFAULT_TEXT_PREVIEW_CHARS,
): {
	readonly text: string;
	readonly chars: number;
	readonly truncated: boolean;
} {
	const redacted = redactString(value);
	if (redacted.length <= maxChars) {
		return { text: redacted, chars: redacted.length, truncated: false };
	}
	return {
		text: `${redacted.slice(0, Math.max(0, maxChars - 3))}...`,
		chars: redacted.length,
		truncated: true,
	};
}

function summarizeArgumentValue(value: unknown): Record<string, unknown> {
	if (value == null) {
		return { type: "null" };
	}
	if (typeof value === "string") {
		return {
			type: "string",
			chars: value.length,
			truncated: value.length > MAX_LOG_STRING_CHARS,
		};
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return { type: typeof value, value };
	}
	if (Array.isArray(value)) {
		return {
			type: "array",
			length: value.length,
			itemTypes: value
				.slice(0, 8)
				.map((item) => (item == null ? "null" : typeof item)),
		};
	}
	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		return {
			type: "object",
			keyCount: keys.length,
			keySummaries: keys.slice(0, MAX_ARGUMENT_KEYS).map(summarizeKeyName),
			truncated: keys.length > MAX_ARGUMENT_KEYS,
		};
	}
	return { type: typeof value };
}

function summarizeKeyName(key: string): Record<string, unknown> {
	return {
		id: hashText(key),
		chars: key.length,
		sensitiveName: isSensitiveObjectKey(key),
	};
}

function summarizeToolArguments(
	argumentsRecord: Record<string, unknown>,
): Record<string, unknown> {
	const entries = Object.entries(argumentsRecord).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return {
		entries: entries.slice(0, MAX_ARGUMENT_KEYS).map(([key, value]) => ({
			key: summarizeKeyName(key),
			value: summarizeArgumentValue(value),
		})),
		truncatedCount: Math.max(0, entries.length - MAX_ARGUMENT_KEYS),
	};
}

export function summarizeToolCall(call: ToolCall): Record<string, unknown> {
	const argumentKeys = Object.keys(call.arguments).sort();
	return {
		id: call.id,
		name: call.name,
		argumentKeyCount: argumentKeys.length,
		argumentKeys: argumentKeys
			.slice(0, MAX_ARGUMENT_KEYS)
			.map(summarizeKeyName),
		argumentKeysTruncated: argumentKeys.length > MAX_ARGUMENT_KEYS,
		argumentSummary: summarizeToolArguments(call.arguments),
	};
}

export function summarizeMessage(message: Message): Record<string, unknown> {
	return {
		role: message.role,
		contentChars: message.content.length,
		contentPreviewRedacted: true,
		...(message.name == null ? {} : { name: message.name }),
		...(message.toolCallId == null ? {} : { toolCallId: message.toolCallId }),
		...(message.toolCalls == null
			? {}
			: { toolCalls: message.toolCalls.map(summarizeToolCall) }),
		...(message.reasoning == null
			? {}
			: { reasoningPartCount: message.reasoning.length }),
	};
}

export function summarizeMessages(
	messages: readonly Message[],
): Record<string, unknown> {
	const latestMessage = messages.at(-1);
	return {
		count: messages.length,
		roles: messages.map((message) => message.role),
		latest: latestMessage == null ? null : summarizeMessage(latestMessage),
	};
}

export function summarizeToolResult(
	result: ToolResult,
	sanitizedContent?: string,
): Record<string, unknown> {
	const content = sanitizedContent ?? result.content;
	return {
		toolCallId: result.toolCallId,
		isError: result.isError,
		contentChars: content.length,
		contentSanitized: sanitizedContent != null,
		contentPreviewRedacted: true,
		...(result.error == null
			? {}
			: { error: summarizeToolError(result.error) }),
		...(result.audit == null
			? {}
			: { audit: summarizeToolAudit(result.audit) }),
	};
}

function summarizeToolError(error: ToolError): Record<string, unknown> {
	return {
		code: error.code,
		retryable: error.retryable ?? false,
		messageChars: error.message.length,
		detailKeys:
			error.details == null
				? []
				: Object.keys(error.details).sort().map(summarizeKeyName),
		detailKeyCount:
			error.details == null ? 0 : Object.keys(error.details).length,
	};
}

function summarizeToolAudit(
	audit: ToolInvocationAuditSummary,
): Record<string, unknown> {
	return {
		tool: audit.tool,
		call: audit.call,
		outcome: audit.outcome,
		errorCode: audit.errorCode,
		retryable: audit.retryable ?? false,
		sandboxKind: audit.sandboxKind,
		sandboxOrigin: audit.sandboxOrigin,
		requiredApprovalCount: audit.requiredApprovals?.length ?? 0,
		reasonCodeCount: audit.reasonCodes?.length ?? 0,
		summaryChars: audit.summary.length,
		detailChars: audit.detail.length,
	};
}

export function summarizeProviderRunRecord(
	record: ProviderRunRecord,
): Record<string, unknown> {
	const firstAttempt = record.attempts[0];
	return {
		provider: record.route.provider,
		configuredModel: record.route.configuredModel,
		effectiveModel: record.route.effectiveModel,
		selectedTier: record.route.selectedTier,
		routingMode: record.route.routingMode,
		routeReason: record.route.routeReason,
		thinkingMode: record.route.thinkingMode,
		reasoningStateAdapter: record.route.reasoningStateAdapter,
		fallbackUsed: record.fallbackUsed,
		outcome: record.outcome,
		attemptCount: record.attempts.length,
		requestBudget: record.route.budget,
		...(firstAttempt == null
			? {}
			: {
					firstAttempt: {
						provider: firstAttempt.provider,
						model: firstAttempt.model,
						outcome: firstAttempt.outcome,
						usage: firstAttempt.usage,
						...(firstAttempt.error == null
							? {}
							: { error: summarizeProviderError(firstAttempt.error) }),
					},
				}),
		...(record.error == null
			? {}
			: { error: summarizeProviderError(record.error) }),
	};
}

function summarizeProviderError(
	error: NormalizedProviderError,
): Record<string, unknown> {
	return {
		name: error.name,
		code: error.code,
		category: error.category,
		messageChars: error.message.length,
	};
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value);
		return parsed != null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function safeUrlDetails(value: string | undefined):
	| {
			readonly url: string;
			readonly host?: string;
			readonly fingerprint: string;
			readonly pathChars?: number;
			readonly pathFingerprint?: string;
			readonly invalidUrl?: boolean;
	  }
	| undefined {
	if (value == null) {
		return undefined;
	}
	try {
		const parsed = new URL(value);
		const hasPath = parsed.pathname !== "" && parsed.pathname !== "/";
		const safePath = hasPath ? "/[path-redacted]" : parsed.pathname || "/";
		const query = parsed.search.length > 0 ? "?[redacted]" : "";
		const fragment = parsed.hash.length > 0 ? "#[redacted]" : "";
		return {
			url: `${parsed.protocol}//${parsed.host}${safePath}${query}${fragment}`,
			host: parsed.host,
			fingerprint: hashText(parsed.href),
			...(hasPath
				? {
						pathChars: parsed.pathname.length,
						pathFingerprint: hashText(parsed.pathname),
					}
				: {}),
		};
	} catch {
		return {
			url: "[invalid-url:redacted]",
			fingerprint: hashText(value),
			invalidUrl: true,
		};
	}
}

function resolveAuditOutcome(input: {
	readonly toolResult: ToolResult;
	readonly actionVerification?: ActionVerificationResult;
	readonly scanResult?: ScanResult;
	readonly hasBlockedThreat?: boolean;
}): ToolProvenanceAuditOutcome {
	if (input.actionVerification?.decision === "block") {
		return "blocked";
	}
	if (input.toolResult.isError) {
		return "failed";
	}
	const hasBlockedThreat =
		input.hasBlockedThreat ??
		input.scanResult?.threats.some((threat) => threat.severity === "block") ??
		false;
	if (hasBlockedThreat) {
		return "blocked_output";
	}
	if (input.scanResult != null && !input.scanResult.safe) {
		return "sanitized_warning";
	}
	return "usable_evidence";
}

export function createToolProvenanceEntry(input: {
	readonly toolCall: ToolCall;
	readonly toolResult: ToolResult;
	readonly sanitizedContent: string;
	readonly actionVerification?: ActionVerificationResult;
	readonly scanResult?: ScanResult;
	readonly trustedToolOutput?: boolean;
	readonly hasBlockedThreat?: boolean;
	readonly appendedToModelContext?: boolean;
	readonly at: string;
}): ToolProvenanceEntry | undefined {
	const parsed = parseJsonObject(input.sanitizedContent);
	const requestedUrl =
		typeof input.toolCall.arguments.url === "string"
			? input.toolCall.arguments.url
			: undefined;
	const resultUrl = typeof parsed?.url === "string" ? parsed.url : undefined;
	const requestedDetails = safeUrlDetails(requestedUrl);
	const resultDetails = safeUrlDetails(resultUrl);
	const status = typeof parsed?.status === "number" ? parsed.status : undefined;
	const contentType =
		typeof parsed?.contentType === "string" ? parsed.contentType : undefined;
	const auditOutcome = resolveAuditOutcome(input);
	const hasBlockedThreat =
		input.hasBlockedThreat ??
		input.scanResult?.threats.some((threat) => threat.severity === "block") ??
		false;
	const usableEvidence = auditOutcome === "usable_evidence";
	const common = {
		at: input.at,
		tool: input.toolCall.name,
		callId: input.toolCall.id,
		isError: input.toolResult.isError,
		...(input.actionVerification == null
			? {}
			: { actionDecision: input.actionVerification.decision }),
		scanSafe: input.scanResult?.safe,
		hasBlockedThreat,
		trustedToolOutput: input.trustedToolOutput ?? false,
		appendedToModelContext: input.appendedToModelContext ?? true,
		auditOutcome,
		usableEvidence,
	};

	if (
		input.toolCall.name.endsWith("web_fetch") &&
		(requestedDetails != null || resultDetails != null)
	) {
		const resultReportedUrlDiffers =
			requestedDetails != null &&
			resultDetails != null &&
			requestedDetails.fingerprint !== resultDetails.fingerprint;
		return {
			...common,
			sourceType: "url",
			url: requestedDetails?.url ?? resultDetails?.url,
			host: requestedDetails?.host ?? resultDetails?.host,
			...(requestedDetails?.pathChars == null
				? {}
				: { pathChars: requestedDetails.pathChars }),
			...(requestedDetails?.pathFingerprint == null
				? {}
				: { pathFingerprint: requestedDetails.pathFingerprint }),
			...(requestedDetails?.invalidUrl == null
				? {}
				: { invalidUrl: requestedDetails.invalidUrl }),
			...(resultDetails == null || !resultReportedUrlDiffers
				? {}
				: { resultReportedUrl: resultDetails.url }),
			...(resultDetails?.pathChars == null || !resultReportedUrlDiffers
				? {}
				: { resultReportedPathChars: resultDetails.pathChars }),
			...(resultDetails?.pathFingerprint == null || !resultReportedUrlDiffers
				? {}
				: { resultReportedPathFingerprint: resultDetails.pathFingerprint }),
			...(resultReportedUrlDiffers ? { resultReportedUrlDiffers } : {}),
			...(status == null ? {} : { status }),
			...(contentType == null ? {} : { contentType }),
		};
	}

	return {
		...common,
		sourceType: "tool",
	};
}
