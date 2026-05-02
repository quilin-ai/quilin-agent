import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderRunRecord } from "../llm/types.js";
import { redactJsonLikeValue, redactString } from "../safety/redaction.js";
import type { Message } from "../state/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

export type AgentRunLogPhase =
	| "repl.session_started"
	| "turn.input_received"
	| "loop.turn_started"
	| "context.rebuild_skipped"
	| "context.outbound_request_built"
	| "checkpoint.saved"
	| "llm.request_prepared"
	| "llm.response_received"
	| "llm.provider_run"
	| "planning.tool_calls_selected"
	| "tool.call_started"
	| "tool.safety_action_verified"
	| "tool.call_completed"
	| "tool.output_scanned"
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
}

export interface JsonlAgentRunLoggerOptions {
	readonly sessionId: string;
	readonly logsDir?: string;
	readonly now?: () => Date;
}

export interface ToolProvenanceEntry {
	readonly at: string;
	readonly tool: string;
	readonly callId: string;
	readonly sourceType: "url" | "tool";
	readonly url?: string;
	readonly host?: string;
	readonly status?: number;
	readonly contentType?: string;
	readonly isError: boolean;
}

const DEFAULT_LOGS_DIR = ".logs/agent-runs";
const DEFAULT_TEXT_PREVIEW_CHARS = 700;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;

function sanitizeFilePart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "session";
}

function normalizeJsonValue(
	value: unknown,
	seen: WeakSet<object>,
	depth = 0,
): unknown {
	if (
		value == null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
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
			message: value.message,
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

export class JsonlAgentRunLogger implements AgentRunLogSink {
	private readonly filePath: string;
	private readonly now: () => Date;
	private writeQueue: Promise<void> = Promise.resolve();
	private seq = 0;

	constructor(private readonly options: JsonlAgentRunLoggerOptions) {
		this.filePath = join(
			options.logsDir ?? DEFAULT_LOGS_DIR,
			`${sanitizeFilePart(options.sessionId)}.jsonl`,
		);
		this.now = options.now ?? (() => new Date());
	}

	async record(input: AgentRunLogRecordInput): Promise<void> {
		const event: AgentRunLogEvent = {
			schema_version: 1,
			timestamp: this.now().toISOString(),
			session_id: this.options.sessionId,
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
			await mkdir(dirname(this.filePath), { recursive: true });
			await appendFile(this.filePath, line, "utf8");
		});
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
		await sink.record({ phase, payload, ...options });
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

export function summarizeToolCall(call: ToolCall): Record<string, unknown> {
	return {
		id: call.id,
		name: call.name,
		argumentKeys: Object.keys(call.arguments).sort(),
		arguments: call.arguments,
	};
}

export function summarizeMessage(message: Message): Record<string, unknown> {
	const preview = textPreview(message.content);
	return {
		role: message.role,
		contentChars: preview.chars,
		contentPreview: preview.text,
		contentPreviewTruncated: preview.truncated,
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
	const preview = textPreview(content);
	return {
		toolCallId: result.toolCallId,
		isError: result.isError,
		contentChars: preview.chars,
		contentPreview: preview.text,
		contentPreviewTruncated: preview.truncated,
		...(result.error == null ? {} : { error: result.error }),
		...(result.audit == null ? {} : { audit: result.audit }),
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
						error: firstAttempt.error,
					},
				}),
		...(record.error == null ? {} : { error: record.error }),
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

function hostFromUrl(value: string | undefined): string | undefined {
	if (value == null) {
		return undefined;
	}
	try {
		return new URL(value).host;
	} catch {
		return undefined;
	}
}

export function createToolProvenanceEntry(input: {
	readonly toolCall: ToolCall;
	readonly toolResult: ToolResult;
	readonly sanitizedContent: string;
	readonly at: string;
}): ToolProvenanceEntry | undefined {
	const parsed = parseJsonObject(input.sanitizedContent);
	const requestedUrl =
		typeof input.toolCall.arguments.url === "string"
			? input.toolCall.arguments.url
			: undefined;
	const resultUrl = typeof parsed?.url === "string" ? parsed.url : undefined;
	const url = resultUrl ?? requestedUrl;
	const status = typeof parsed?.status === "number" ? parsed.status : undefined;
	const contentType =
		typeof parsed?.contentType === "string" ? parsed.contentType : undefined;

	if (input.toolCall.name.endsWith("web_fetch") && url != null) {
		return {
			at: input.at,
			tool: input.toolCall.name,
			callId: input.toolCall.id,
			sourceType: "url",
			url,
			host: hostFromUrl(url),
			...(status == null ? {} : { status }),
			...(contentType == null ? {} : { contentType }),
			isError: input.toolResult.isError,
		};
	}

	return {
		at: input.at,
		tool: input.toolCall.name,
		callId: input.toolCall.id,
		sourceType: "tool",
		isError: input.toolResult.isError,
	};
}
