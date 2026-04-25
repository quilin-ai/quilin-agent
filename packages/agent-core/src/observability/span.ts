import { randomUUID } from "node:crypto";

export type SpanName =
	| "agent.session"
	| "agent.turn"
	| "agent.state_node"
	| "llm.invoke"
	| "tool.invoke";

export type SpanStatus = "unset" | "ok" | "error";
export type StateNodeName =
	| "build_context"
	| "plan"
	| "execute"
	| "verify"
	| "reflect"
	| "decide";
export type LLMThinkingMode = "off" | "standard" | "preserved";
export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface SpanEventSnapshot {
	readonly name: string;
	readonly timestampUnixMs: number;
	readonly attributes: SpanAttributes;
}

export interface SpanSnapshot {
	readonly name: SpanName;
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly startTimeUnixMs: number;
	readonly endTimeUnixMs?: number;
	readonly durationMs?: number;
	readonly status: SpanStatus;
	readonly attributes: SpanAttributes;
	readonly events: readonly SpanEventSnapshot[];
	readonly children: readonly string[];
}

export interface StartSpanOptions {
	readonly parent?: OTelSpan | SpanSnapshot;
}

interface MutableSpanRecord {
	name: SpanName;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	startTimeUnixMs: number;
	endTimeUnixMs?: number;
	durationMs?: number;
	status: SpanStatus;
	attributes: SpanAttributes;
	events: SpanEventSnapshot[];
	children: string[];
}

const SPAN_NAMES = new Set<SpanName>([
	"agent.session",
	"agent.turn",
	"agent.state_node",
	"llm.invoke",
	"tool.invoke",
]);

const REQUIRED_ATTRIBUTES: Record<SpanName, readonly string[]> = {
	"agent.session": [
		"session.id",
		"session.user_id",
		"session.task_summary",
		"session.turn_count",
		"session.total_cost_usd",
		"session.total_tokens",
	],
	"agent.turn": [
		"turn.id",
		"turn.index",
		"turn.user_input_redacted",
		"turn.replanning_count",
		"turn.cost_usd",
		"turn.success",
	],
	"agent.state_node": ["state_node.name", "state_node.duration_ms"],
	"llm.invoke": [
		"llm.model",
		"llm.provider",
		"llm.tokens_input",
		"llm.tokens_output",
		"llm.tokens_thinking",
		"llm.thinking_mode",
		"llm.cost_usd",
		"llm.time_to_first_token_ms",
		"llm.total_latency_ms",
	],
	"tool.invoke": [
		"tool.name",
		"tool.params_summary",
		"tool.duration_ms",
		"tool.success",
		"tool.result_size_bytes",
	],
};

const STATE_NODE_NAMES = new Set<StateNodeName>([
	"build_context",
	"plan",
	"execute",
	"verify",
	"reflect",
	"decide",
]);

const THINKING_MODES = new Set<LLMThinkingMode>([
	"off",
	"standard",
	"preserved",
]);

function createHexId(length: 16 | 32): string {
	return randomUUID().replaceAll("-", "").slice(0, length);
}

function nowUnixMs(): number {
	return Date.now();
}

function cloneAttributes(attributes: SpanAttributes): SpanAttributes {
	return { ...attributes };
}

function cloneSnapshot(record: MutableSpanRecord): SpanSnapshot {
	return {
		name: record.name,
		traceId: record.traceId,
		spanId: record.spanId,
		...(record.parentSpanId == null
			? {}
			: { parentSpanId: record.parentSpanId }),
		startTimeUnixMs: record.startTimeUnixMs,
		...(record.endTimeUnixMs == null
			? {}
			: { endTimeUnixMs: record.endTimeUnixMs }),
		...(record.durationMs == null ? {} : { durationMs: record.durationMs }),
		status: record.status,
		attributes: cloneAttributes(record.attributes),
		events: record.events.map((event) => ({
			name: event.name,
			timestampUnixMs: event.timestampUnixMs,
			attributes: cloneAttributes(event.attributes),
		})),
		children: [...record.children],
	};
}

export function validateAttributeKey(key: string): void {
	if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(key)) {
		throw new Error(`Invalid observability attribute key: ${key}`);
	}
}

function validateNumericAttribute(key: string): void {
	if (
		key.endsWith("_ms") ||
		key.endsWith("_bytes") ||
		key.endsWith("_usd") ||
		key.endsWith("_tokens") ||
		key.endsWith("_count") ||
		key.endsWith(".index") ||
		key.includes(".tokens_")
	) {
		return;
	}

	throw new Error(`Numeric observability attribute must carry a unit: ${key}`);
}

function validateEnumAttribute(key: string, value: SpanAttributeValue): void {
	if (
		key === "state_node.name" &&
		!STATE_NODE_NAMES.has(value as StateNodeName)
	) {
		throw new Error(`Invalid state_node.name: ${String(value)}`);
	}

	if (
		key === "llm.thinking_mode" &&
		!THINKING_MODES.has(value as LLMThinkingMode)
	) {
		throw new Error(`Invalid llm.thinking_mode: ${String(value)}`);
	}
}

export function validateSpanAttributes(attributes: SpanAttributes): void {
	for (const [key, value] of Object.entries(attributes)) {
		validateAttributeKey(key);
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			throw new Error(`Invalid observability attribute value: ${key}`);
		}
		if (typeof value === "number") {
			validateNumericAttribute(key);
		}
		validateEnumAttribute(key, value);
	}
}

function validateRequiredAttributes(record: MutableSpanRecord): void {
	for (const key of REQUIRED_ATTRIBUTES[record.name]) {
		if (!(key in record.attributes)) {
			throw new Error(`Missing required ${record.name} attribute: ${key}`);
		}
	}

	if (
		record.name === "tool.invoke" &&
		record.attributes["tool.success"] === false &&
		!("tool.error_type" in record.attributes)
	) {
		throw new Error(
			"Missing required failed tool.invoke attribute: tool.error_type",
		);
	}
}

function applyDurationAttributes(
	record: MutableSpanRecord,
	durationMs: number,
): void {
	switch (record.name) {
		case "agent.state_node":
			record.attributes["state_node.duration_ms"] = durationMs;
			break;
		case "llm.invoke":
			record.attributes["llm.time_to_first_token_ms"] = durationMs;
			record.attributes["llm.total_latency_ms"] = durationMs;
			break;
		case "tool.invoke":
			record.attributes["tool.duration_ms"] = durationMs;
			break;
		case "agent.session":
		case "agent.turn":
			break;
	}
}

export class OTelSpan {
	constructor(private readonly record: MutableSpanRecord) {}

	get name(): SpanName {
		return this.record.name;
	}

	get traceId(): string {
		return this.record.traceId;
	}

	get spanId(): string {
		return this.record.spanId;
	}

	get parentSpanId(): string | undefined {
		return this.record.parentSpanId;
	}

	setAttribute(key: string, value: SpanAttributeValue): void {
		validateSpanAttributes({ [key]: value });
		this.record.attributes[key] = value;
	}

	setAttributes(attributes: SpanAttributes): void {
		validateSpanAttributes(attributes);
		Object.assign(this.record.attributes, attributes);
	}

	addEvent(name: string, attributes: SpanAttributes = {}): void {
		validateSpanAttributes(attributes);
		this.record.events.push({
			name,
			timestampUnixMs: nowUnixMs(),
			attributes: cloneAttributes(attributes),
		});
	}

	end(status: Exclude<SpanStatus, "unset"> = "ok"): void {
		if (this.record.endTimeUnixMs != null) {
			return;
		}

		const endTimeUnixMs = nowUnixMs();
		const durationMs = endTimeUnixMs - this.record.startTimeUnixMs;
		applyDurationAttributes(this.record, durationMs);
		validateRequiredAttributes(this.record);
		this.record.endTimeUnixMs = endTimeUnixMs;
		this.record.durationMs = durationMs;
		this.record.status = status;
	}

	snapshot(): SpanSnapshot {
		return cloneSnapshot(this.record);
	}
}

export class OTelSpanProvider {
	private readonly spans = new Map<string, MutableSpanRecord>();

	startSpan(
		name: SpanName,
		attributes: SpanAttributes = {},
		options: StartSpanOptions = {},
	): OTelSpan {
		if (!SPAN_NAMES.has(name)) {
			throw new Error(`Invalid observability span name: ${name}`);
		}
		validateSpanAttributes(attributes);

		const parent = options.parent;
		const traceId = parent?.traceId ?? createHexId(32);
		const parentSpanId = parent?.spanId;
		const record: MutableSpanRecord = {
			name,
			traceId,
			spanId: createHexId(16),
			...(parentSpanId == null ? {} : { parentSpanId }),
			startTimeUnixMs: nowUnixMs(),
			status: "unset",
			attributes: cloneAttributes(attributes),
			events: [],
			children: [],
		};

		this.spans.set(record.spanId, record);
		if (parentSpanId != null) {
			const parentRecord = this.spans.get(parentSpanId);
			parentRecord?.children.push(record.spanId);
		}

		return new OTelSpan(record);
	}

	readSpan(spanId: string): SpanSnapshot | undefined {
		const record = this.spans.get(spanId);
		return record == null ? undefined : cloneSnapshot(record);
	}

	snapshot(): readonly SpanSnapshot[] {
		return [...this.spans.values()].map((record) => cloneSnapshot(record));
	}

	clear(): void {
		this.spans.clear();
	}
}
