import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
	SupervisorProgressEvent,
	SupervisorProgressEventSeverity,
	SupervisorProgressEventType,
} from "../multi-agent/supervisor-progress.js";
import { renderPrometheusMetrics } from "./exporters/prometheus.js";
import { aggregateSpanMetrics } from "./metrics.js";
import { type TraceQuery, TraceStore } from "./trace-store.js";

export interface ObservabilityDashboardOptions {
	readonly logsDir?: string;
	readonly traceStore?: TraceStore;
	readonly durationBucketsMs?: readonly number[];
	readonly defaultTraceLimit?: number;
}

export interface StartObservabilityDashboardOptions
	extends ObservabilityDashboardOptions {
	readonly host?: string;
	readonly port?: number;
}

export interface SupervisorProgressDashboardRecord {
	readonly sourceEventId: string;
	readonly eventType: SupervisorProgressEventType;
	readonly severity: SupervisorProgressEventSeverity;
	readonly title: string;
	readonly summary: string;
	readonly childRunId?: string;
	readonly taskId?: string;
	readonly timestamp: string;
	readonly generatedAt?: string;
}

function terminalCountSummary(
	counts: Readonly<
		Record<"completed" | "failed" | "cancelled" | "deferred", number>
	>,
): string {
	return `${counts.completed} completed, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.deferred} deferred`;
}

function eventRunMetadata(
	event: SupervisorProgressEvent,
): Pick<SupervisorProgressDashboardRecord, "childRunId" | "taskId"> {
	if (!("runId" in event)) {
		return {};
	}

	return {
		childRunId: event.runId,
		taskId: event.taskId,
	};
}

function eventGeneratedAt(event: SupervisorProgressEvent): string | undefined {
	return event.type === "progress_snapshot"
		? event.payload.generatedAt
		: undefined;
}

function eventTitleAndSummary(
	event: SupervisorProgressEvent,
): Pick<SupervisorProgressDashboardRecord, "title" | "summary"> {
	switch (event.type) {
		case "progress_snapshot":
			return {
				title: `Supervisor progress: ${event.payload.band}`,
				summary: `${event.payload.totalRuns} child runs, ${event.payload.confidence} confidence, ${event.payload.reviewedArtifactCount} reviewed artifacts.`,
			};
		case "child_stale":
			return {
				title: "Child run stale",
				summary: `${event.runId} last heartbeat is ${event.payload.heartbeatAgeMs}ms old; stale threshold is ${event.payload.staleAfterMs}ms.`,
			};
		case "child_heartbeat":
			return {
				title: `Child heartbeat: ${event.payload.status}`,
				summary:
					event.payload.summary ||
					event.payload.currentStep ||
					`${event.runId} reported ${event.payload.status}.`,
			};
		case "child_checkpoint":
			return {
				title: event.payload.isDue
					? "Child checkpoint due"
					: "Child checkpoint scheduled",
				summary: event.payload.isDue
					? `${event.runId} checkpoint is due now.`
					: `${event.runId} checkpoint is due in ${event.payload.dueInMs}ms.`,
			};
		case "terminal_children_summary":
			return {
				title: "Terminal children summary",
				summary: `${event.payload.total} terminal child runs: ${terminalCountSummary(event.payload.counts)}.`,
			};
	}
}

export function adaptSupervisorProgressEventToDashboardRecord(
	event: SupervisorProgressEvent,
): SupervisorProgressDashboardRecord {
	const text = eventTitleAndSummary(event);
	const generatedAt = eventGeneratedAt(event);
	return {
		sourceEventId: event.id,
		eventType: event.type,
		severity: event.severity,
		...text,
		...eventRunMetadata(event),
		timestamp: event.occurredAt,
		...(generatedAt == null ? {} : { generatedAt }),
	};
}

export function adaptSupervisorProgressEventsToDashboardRecords(
	events: readonly SupervisorProgressEvent[],
): readonly SupervisorProgressDashboardRecord[] {
	return events.map(adaptSupervisorProgressEventToDashboardRecord);
}

function send(
	response: ServerResponse,
	statusCode: number,
	contentType: string,
	body: string,
): void {
	response.writeHead(statusCode, {
		"content-type": contentType,
		"cache-control": "no-store",
	});
	response.end(body);
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	payload: Record<string, unknown>,
): void {
	send(
		response,
		statusCode,
		"application/json; charset=utf-8",
		`${JSON.stringify(payload)}\n`,
	);
}

class DashboardBadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardBadRequestError";
	}
}

function parseNumberParam(value: string | null): number | undefined {
	if (value == null || value.length === 0) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new DashboardBadRequestError(
			`Invalid numeric query parameter: ${value}`,
		);
	}

	return parsed;
}

function parseLimitParam(value: string | null): number | undefined {
	const limit = parseNumberParam(value);
	if (limit != null && limit < 0) {
		throw new DashboardBadRequestError(
			"trace query limit must be a non-negative number",
		);
	}

	return limit;
}

function parseDateParam(value: string | null): string | undefined {
	if (value == null) {
		return undefined;
	}

	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new DashboardBadRequestError(`Invalid trace date: ${value}`);
	}

	return value;
}

function parseTraceQuery(
	url: URL,
	defaultTraceLimit: number | undefined,
): TraceQuery {
	const limit = parseLimitParam(url.searchParams.get("limit"));
	const fromUnixMs = parseNumberParam(url.searchParams.get("from_unix_ms"));
	const toUnixMs = parseNumberParam(url.searchParams.get("to_unix_ms"));
	const date = parseDateParam(url.searchParams.get("date"));
	return {
		...(url.searchParams.get("trace_id") == null
			? {}
			: { traceId: url.searchParams.get("trace_id") ?? undefined }),
		...(date == null ? {} : { date }),
		...(fromUnixMs == null ? {} : { fromUnixMs }),
		...(toUnixMs == null ? {} : { toUnixMs }),
		limit: limit ?? defaultTraceLimit,
	};
}

function renderDashboardHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quilin Observability</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.4;color:#17202a;background:#f7f8fa}
main{max-width:56rem}
a{color:#0b5cad}
code{background:#e9edf2;padding:0.125rem 0.25rem;border-radius:4px}
</style>
</head>
<body>
<main>
<h1>Quilin Observability</h1>
<p>Local trace and metric endpoints are available from this process.</p>
<ul>
<li><a href="/metrics"><code>/metrics</code></a></li>
<li><a href="/traces"><code>/traces</code></a></li>
</ul>
</main>
</body>
</html>
`;
}

function traceIdFromPath(pathname: string): string | undefined {
	const prefix = "/traces/";
	if (!pathname.startsWith(prefix)) {
		return undefined;
	}

	const traceId = decodeURIComponent(pathname.slice(prefix.length));
	return traceId.length === 0 ? undefined : traceId;
}

export function createObservabilityDashboardHandler(
	options: ObservabilityDashboardOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
	const traceStore =
		options.traceStore ?? new TraceStore({ logsDir: options.logsDir });
	const defaultTraceLimit = options.defaultTraceLimit ?? 100;

	return (request, response) => {
		void (async () => {
			if (request.method !== "GET" && request.method !== "HEAD") {
				sendJson(response, 405, { error: "method_not_allowed" });
				return;
			}

			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const bodyless = request.method === "HEAD";
			const write = (statusCode: number, contentType: string, body: string) =>
				send(response, statusCode, contentType, bodyless ? "" : body);

			if (url.pathname === "/" || url.pathname === "/dashboard") {
				write(200, "text/html; charset=utf-8", renderDashboardHtml());
				return;
			}

			if (url.pathname === "/metrics") {
				const query = parseTraceQuery(url, undefined);
				const result = await traceStore.querySpanSnapshots(query);
				const metrics = aggregateSpanMetrics(result.spans, {
					durationBucketsMs: options.durationBucketsMs,
				});
				write(
					200,
					"text/plain; version=0.0.4; charset=utf-8",
					renderPrometheusMetrics(metrics),
				);
				return;
			}

			if (url.pathname === "/traces") {
				const result = await traceStore.querySpans(
					parseTraceQuery(url, defaultTraceLimit),
				);
				write(
					200,
					"application/json; charset=utf-8",
					`${JSON.stringify({
						spans: result.spans,
						skipped_lines: result.skippedLines,
						files: result.files,
					})}\n`,
				);
				return;
			}

			const traceId = traceIdFromPath(url.pathname);
			if (traceId != null) {
				const result = await traceStore.querySpans({
					...parseTraceQuery(url, defaultTraceLimit),
					traceId,
				});
				write(
					200,
					"application/json; charset=utf-8",
					`${JSON.stringify({
						trace_id: traceId,
						spans: result.spans,
						skipped_lines: result.skippedLines,
						files: result.files,
					})}\n`,
				);
				return;
			}

			write(404, "application/json; charset=utf-8", '{"error":"not_found"}\n');
		})().catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : undefined);
				return;
			}

			if (error instanceof DashboardBadRequestError) {
				sendJson(response, 400, {
					error: "bad_request",
					message: error.message,
				});
				return;
			}

			sendJson(response, 500, {
				error: "internal_error",
				message: "Observability dashboard failed to read data",
			});
		});
	};
}

export async function startObservabilityDashboard(
	options: StartObservabilityDashboardOptions = {},
): Promise<{
	readonly server: ReturnType<typeof createServer>;
	readonly url: string;
}> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const server = createServer(createObservabilityDashboardHandler(options));

	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			server.off("error", onError);
			server.off("listening", onListening);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});

	const address = server.address() as AddressInfo;
	return {
		server,
		url: `http://${host}:${address.port}`,
	};
}
