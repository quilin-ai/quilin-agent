import { getObservabilityContext } from "./context.js";

export type StructuredLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface StructuredLogContext {
	readonly traceId?: string;
	readonly spanId?: string;
	readonly requestId?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
}

export interface StructuredLogOptions {
	readonly level?: StructuredLogLevel;
	readonly now?: () => Date;
	readonly write?: (line: string) => void;
}

const LEVEL_WEIGHT: Record<StructuredLogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	WARN: 30,
	ERROR: 40,
};

function defaultWrite(line: string): void {
	process.stdout.write(line);
}

function normalizeLevel(
	level: StructuredLogLevel | undefined,
): StructuredLogLevel {
	return level ?? "INFO";
}

function validateEventName(event: string): void {
	if (!/^[a-z][a-z0-9_]*$/.test(event)) {
		throw new Error(`Invalid structured log event name: ${event}`);
	}
}

export class StructuredLogger {
	private readonly threshold: StructuredLogLevel;
	private readonly now: () => Date;
	private readonly write: (line: string) => void;

	constructor(options: StructuredLogOptions = {}) {
		this.threshold = normalizeLevel(options.level);
		this.now = options.now ?? (() => new Date());
		this.write = options.write ?? defaultWrite;
	}

	log(
		level: StructuredLogLevel,
		component: string,
		event: string,
		data?: Record<string, unknown>,
		context: StructuredLogContext = {},
	): void {
		if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.threshold]) {
			return;
		}
		validateEventName(event);

		const ambient = getObservabilityContext();
		const sessionId = context.sessionId ?? ambient.sessionId;
		const turnId = context.turnId ?? ambient.turnId;
		const entry = {
			timestamp: this.now().toISOString(),
			level,
			component,
			event,
			trace_id: context.traceId ?? ambient.traceId ?? "-",
			span_id: context.spanId ?? ambient.spanId ?? "-",
			request_id: context.requestId ?? ambient.requestId ?? "-",
			...(sessionId == null ? {} : { session_id: sessionId }),
			...(turnId == null ? {} : { turn_id: turnId }),
			...(data == null ? {} : { data }),
		};

		this.write(`${JSON.stringify(entry)}\n`);
	}

	debug(
		component: string,
		event: string,
		data?: Record<string, unknown>,
		context?: StructuredLogContext,
	): void {
		this.log("DEBUG", component, event, data, context);
	}

	info(
		component: string,
		event: string,
		data?: Record<string, unknown>,
		context?: StructuredLogContext,
	): void {
		this.log("INFO", component, event, data, context);
	}

	warn(
		component: string,
		event: string,
		data?: Record<string, unknown>,
		context?: StructuredLogContext,
	): void {
		this.log("WARN", component, event, data, context);
	}

	error(
		component: string,
		event: string,
		data?: Record<string, unknown>,
		context?: StructuredLogContext,
	): void {
		this.log("ERROR", component, event, data, context);
	}
}
