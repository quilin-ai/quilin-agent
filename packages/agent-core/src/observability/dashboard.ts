import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	SupervisorProgressEvent,
	SupervisorProgressEventSeverity,
	SupervisorProgressEventType,
} from "../multi-agent/supervisor-progress.js";
import { redactString } from "../safety/redaction.js";
import { renderPrometheusMetrics } from "./exporters/prometheus.js";
import { aggregateSpanMetrics } from "./metrics.js";
import type { SerializedSpan } from "./exporters/json-file.js";
import { type TraceQuery, TraceStore } from "./trace-store.js";

export interface DashboardTaskRecord {
	readonly childRunId?: string;
	readonly taskId?: string;
	readonly eventType: string;
	readonly severity: string;
	readonly title: string;
	readonly summary: string;
	readonly timestamp: string;
}

export interface DashboardTasksData {
	readonly records: readonly DashboardTaskRecord[];
	readonly activeRunCount: number;
	readonly staleRunCount: number;
}

export interface DashboardMemoryTier {
	readonly name: string;
	readonly count: number;
	readonly note?: string;
}

export interface DashboardMemoryData {
	readonly tiers: readonly DashboardMemoryTier[];
}

export interface DashboardToolEntry {
	readonly name: string;
	readonly namespace?: string;
	readonly category?: string;
	readonly riskLevel?: string;
	readonly description?: string;
}

export interface DashboardToolsData {
	readonly tools: readonly DashboardToolEntry[];
	readonly total: number;
	readonly byNamespace: Readonly<Record<string, number>>;
}

export interface DashboardMetricsByTool {
	readonly tool: string;
	readonly calls: number;
	readonly errors: number;
	readonly p50LatencyMs?: number;
	readonly p95LatencyMs?: number;
}

export interface DashboardMetricsData {
	readonly totals: {
		readonly spans: number;
		readonly llmCalls: number;
		readonly tokensIn: number;
		readonly tokensOut: number;
		readonly errors: number;
		readonly avgLatencyMs: number;
	};
	readonly byTool: readonly DashboardMetricsByTool[];
}

export interface DashboardTopologyRun {
	readonly runId: string;
	readonly taskId?: string;
	readonly workerName?: string;
	readonly status: string;
	readonly startedAt?: string;
}

export interface DashboardTopologyData {
	readonly supervisorStatus: string;
	readonly activeRunCount: number;
	readonly totalRunCount: number;
	readonly runs: readonly DashboardTopologyRun[];
}

export interface DashboardSessionEntry {
	readonly sessionId: string;
	readonly status: string;
	readonly source?: string;
	readonly turnCount?: number;
	readonly messageCount?: number;
	readonly createdAt?: string;
	readonly lastActiveAt?: string;
}

export interface DashboardSessionsData {
	readonly sessions: readonly DashboardSessionEntry[];
	readonly total: number;
	readonly activeCount: number;
	readonly terminalCount: number;
}

export interface DashboardSkillEntry {
	readonly name: string;
	readonly source?: string;
	readonly trust?: string;
	readonly mandatory?: boolean;
}

export interface DashboardMcpServer {
	readonly id: string;
	readonly status: string;
	readonly command: string;
	readonly defaultRiskLevel?: string;
}

export interface DashboardProviderEntry {
	readonly provider: string;
	readonly status: string;
	readonly configuredSources?: readonly string[];
	readonly credentialStatus?: string;
}

export interface DashboardSkillsMcpData {
	readonly skills: { readonly catalog: readonly DashboardSkillEntry[] };
	readonly mcp: { readonly servers: readonly DashboardMcpServer[] };
	readonly config: unknown;
	readonly providers: readonly DashboardProviderEntry[];
}

export interface DashboardDataProviders {
	readonly tasks?: () => DashboardTasksData | Promise<DashboardTasksData>;
	readonly memory?: () => DashboardMemoryData | Promise<DashboardMemoryData>;
	readonly tools?: () => DashboardToolsData | Promise<DashboardToolsData>;
	readonly topology?: () =>
		| DashboardTopologyData
		| Promise<DashboardTopologyData>;
	readonly sessions?: () =>
		| DashboardSessionsData
		| Promise<DashboardSessionsData>;
	readonly skillsMcp?: () =>
		| DashboardSkillsMcpData
		| Promise<DashboardSkillsMcpData>;
}

export interface ObservabilityDashboardOptions {
	readonly logsDir?: string;
	readonly traceStore?: TraceStore;
	readonly durationBucketsMs?: readonly number[];
	readonly defaultTraceLimit?: number;
	readonly dataProviders?: DashboardDataProviders;
	readonly uiAssetsDir?: string;
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
				summary: redactString(
					event.payload.summary ||
						event.payload.currentStep ||
						`${event.runId} reported ${event.payload.status}.`,
				),
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

const DEFAULT_UI_ASSETS_DIR = fileURLToPath(
	new URL("./dashboard-ui/", import.meta.url),
);

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
<li><a href="/ui/"><code>/ui/</code> — 7-panel dashboard UI</a></li>
<li><a href="/metrics"><code>/metrics</code></a></li>
<li><a href="/traces"><code>/traces</code></a></li>
</ul>
</main>
</body>
</html>
`;
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

function contentTypeForPath(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) {
		return "application/octet-stream";
	}
	const ext = filePath.slice(dot).toLowerCase();
	return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function serveStaticAsset(
	uiAssetsDir: string,
	relativePath: string,
): Promise<{ readonly contentType: string; readonly body: Buffer } | null> {
	const cleaned = relativePath.length === 0 ? "index.html" : relativePath;
	const baseDir = resolve(uiAssetsDir);
	const target = resolve(join(baseDir, cleaned));
	const normalizedTarget = normalize(target);
	const baseDirWithSep =
		baseDir.endsWith("/") || baseDir.endsWith("\\") ? baseDir : `${baseDir}/`;
	if (
		normalizedTarget !== baseDir &&
		!normalizedTarget.startsWith(baseDirWithSep) &&
		!normalizedTarget.startsWith(`${baseDir}\\`)
	) {
		return null;
	}
	try {
		const body = await readFile(normalizedTarget);
		return { contentType: contentTypeForPath(normalizedTarget), body };
	} catch {
		return null;
	}
}

function uiPathFromUrl(pathname: string): string | null {
	if (pathname === "/ui" || pathname === "/ui/") {
		return "";
	}
	const prefix = "/ui/";
	if (pathname.startsWith(prefix)) {
		return decodeURIComponent(pathname.slice(prefix.length));
	}
	return null;
}

function buildMetricsData(
	spans: readonly SerializedSpan[],
): DashboardMetricsData {
	let tokensIn = 0;
	let tokensOut = 0;
	let errors = 0;
	let llmCalls = 0;
	let totalLatency = 0;
	let latencyCount = 0;
	const toolStats = new Map<
		string,
		{ calls: number; errors: number; latencies: number[] }
	>();

	for (const span of spans) {
		if (span.status === "error") {
			errors += 1;
		}
		const latency =
			typeof span.attributes["llm.total_latency_ms"] === "number"
				? (span.attributes["llm.total_latency_ms"] as number)
				: typeof span.duration_ms === "number"
					? span.duration_ms
					: 0;
		if (latency > 0) {
			totalLatency += latency;
			latencyCount += 1;
		}
		const tin = span.attributes["llm.tokens_input"];
		const tout = span.attributes["llm.tokens_output"];
		if (typeof tin === "number") tokensIn += tin;
		if (typeof tout === "number") tokensOut += tout;
		if (span.name === "llm.invoke") {
			llmCalls += 1;
		}
		if (span.name.startsWith("tool.")) {
			const toolName =
				typeof span.attributes["tool.name"] === "string"
					? (span.attributes["tool.name"] as string)
					: span.name.slice("tool.".length);
			const entry = toolStats.get(toolName) ?? {
				calls: 0,
				errors: 0,
				latencies: [],
			};
			entry.calls += 1;
			if (span.status === "error") entry.errors += 1;
			if (latency > 0) entry.latencies.push(latency);
			toolStats.set(toolName, entry);
		}
	}

	const percentile = (values: readonly number[], p: number): number | undefined => {
		if (values.length === 0) return undefined;
		const sorted = [...values].sort((left, right) => left - right);
		const idx = Math.min(
			sorted.length - 1,
			Math.floor((p / 100) * sorted.length),
		);
		return Math.round(sorted[idx] ?? 0);
	};

	const byTool: DashboardMetricsByTool[] = [...toolStats.entries()]
		.map(([tool, stats]) => {
			const p50 = percentile(stats.latencies, 50);
			const p95 = percentile(stats.latencies, 95);
			return {
				tool,
				calls: stats.calls,
				errors: stats.errors,
				...(p50 == null ? {} : { p50LatencyMs: p50 }),
				...(p95 == null ? {} : { p95LatencyMs: p95 }),
			};
		})
		.sort((left, right) => right.calls - left.calls);

	return {
		totals: {
			spans: spans.length,
			llmCalls,
			tokensIn,
			tokensOut,
			errors,
			avgLatencyMs:
				latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
		},
		byTool,
	};
}

function emptyTasksData(): DashboardTasksData {
	return { records: [], activeRunCount: 0, staleRunCount: 0 };
}

function emptyMemoryData(): DashboardMemoryData {
	return {
		tiers: [
			{ name: "working", count: 0, note: "memory provider not connected" },
			{ name: "episodic", count: 0, note: "memory provider not connected" },
			{ name: "semantic", count: 0, note: "memory provider not connected" },
			{ name: "skill", count: 0, note: "memory provider not connected" },
		],
	};
}

function emptyToolsData(): DashboardToolsData {
	return { tools: [], total: 0, byNamespace: {} };
}

function emptyTopologyData(): DashboardTopologyData {
	return {
		supervisorStatus: "unknown",
		activeRunCount: 0,
		totalRunCount: 0,
		runs: [],
	};
}

function emptySessionsData(): DashboardSessionsData {
	return { sessions: [], total: 0, activeCount: 0, terminalCount: 0 };
}

function emptySkillsMcpData(): DashboardSkillsMcpData {
	return {
		skills: { catalog: [] },
		mcp: { servers: [] },
		config: null,
		providers: [],
	};
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
	const dataProviders = options.dataProviders ?? {};
	const uiAssetsDir = options.uiAssetsDir ?? DEFAULT_UI_ASSETS_DIR;

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

			const uiRelative = uiPathFromUrl(url.pathname);
			if (uiRelative != null) {
				const asset = await serveStaticAsset(uiAssetsDir, uiRelative);
				if (asset == null) {
					sendJson(response, 404, { error: "ui_asset_not_found" });
					return;
				}
				response.writeHead(200, {
					"content-type": asset.contentType,
					"cache-control": "no-store",
				});
				if (bodyless) {
					response.end();
				} else {
					response.end(asset.body);
				}
				return;
			}

			if (url.pathname.startsWith("/api/dashboard/")) {
				const panel = url.pathname.slice("/api/dashboard/".length);
				let payload: unknown;
				switch (panel) {
					case "tasks":
						payload = dataProviders.tasks
							? await dataProviders.tasks()
							: emptyTasksData();
						break;
					case "memory":
						payload = dataProviders.memory
							? await dataProviders.memory()
							: emptyMemoryData();
						break;
					case "tools":
						payload = dataProviders.tools
							? await dataProviders.tools()
							: emptyToolsData();
						break;
					case "metrics": {
						const result = await traceStore.querySpans({
							limit: options.defaultTraceLimit ?? 200,
						});
						payload = buildMetricsData(result.spans);
						break;
					}
					case "topology":
						payload = dataProviders.topology
							? await dataProviders.topology()
							: emptyTopologyData();
						break;
					case "sessions":
						payload = dataProviders.sessions
							? await dataProviders.sessions()
							: emptySessionsData();
						break;
					case "skills-mcp":
						payload = dataProviders.skillsMcp
							? await dataProviders.skillsMcp()
							: emptySkillsMcpData();
						break;
					default:
						sendJson(response, 404, { error: "panel_not_found" });
						return;
				}
				write(
					200,
					"application/json; charset=utf-8",
					`${JSON.stringify(payload)}\n`,
				);
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
					...parseTraceQuery(url, undefined),
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
