import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_DB_DIR = join(homedir(), ".quilin");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "observability.db");

// === Row types (match SQL table columns) ===

export interface MetricHourlyRow {
  readonly hour_ts: number;
  readonly metric_name: string;
  readonly labels_json: string;
  readonly count: number;
  readonly sum: number;
  readonly min: number | null;
  readonly max: number | null;
}

export interface AgentRunRow {
  readonly run_id: string;
  readonly session_id: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly model: string | null;
  readonly tokens_used: number;
  readonly tool_calls: number;
  readonly status: string;
}

export interface SpanTraceRow {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly session_id: string;
  readonly name: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly attributes_json: string;
  readonly status: string;
}

// === Input types (for write methods) ===

export interface AgentRunInput {
  readonly run_id: string;
  readonly session_id: string;
  readonly started_at: number;
  readonly ended_at?: number;
  readonly model?: string;
  readonly tokens_used?: number;
  readonly tool_calls?: number;
  readonly status?: string;
}

export interface SpanTraceInput {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly session_id: string;
  readonly name: string;
  readonly started_at: number;
  readonly ended_at?: number;
  readonly attributes?: Record<string, unknown>;
  readonly status?: string;
}

// === Query options ===

export interface QueryMetricsOptions {
  readonly metric_name?: string;
  readonly from_hour_ts?: number;
  readonly to_hour_ts?: number;
  readonly labels_json?: string;
  readonly limit?: number;
}

export interface QueryAgentRunsOptions {
  readonly session_id?: string;
  readonly from_started_at?: number;
  readonly to_started_at?: number;
  readonly status?: string;
  readonly limit?: number;
}

// === Helpers ===

function buildWhereClause(
  conditions: readonly string[],
): { readonly where: string } {
  return conditions.length > 0
    ? { where: ` WHERE ${conditions.join(" AND ")}` }
    : { where: "" };
}

// === PersistentObservabilityStore ===

export class PersistentObservabilityStore {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
    if (dbPath != null) {
      mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    } else {
      mkdirSync(DEFAULT_DB_DIR, { recursive: true, mode: 0o700 });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.runMigrations();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_hourly (
        hour_ts INTEGER NOT NULL,
        metric_name TEXT NOT NULL,
        labels_json TEXT NOT NULL DEFAULT '{}',
        count INTEGER NOT NULL DEFAULT 0,
        sum REAL NOT NULL DEFAULT 0.0,
        min REAL,
        max REAL,
        PRIMARY KEY (hour_ts, metric_name, labels_json)
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        model TEXT,
        tokens_used INTEGER DEFAULT 0,
        tool_calls INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running'
      );

      CREATE TABLE IF NOT EXISTS span_traces (
        trace_id TEXT PRIMARY KEY,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        attributes_json TEXT DEFAULT '{}',
        status TEXT DEFAULT 'ok'
      )
    `);
  }

  recordMetric(
    name: string,
    value: number,
    labels?: Readonly<Record<string, string>>,
  ): void {
    const hourTs = Math.floor(Date.now() / 3_600_000) * 3_600;
    const labelsJson = JSON.stringify(labels ?? {});

    const existing = this.db
      .prepare(
        `SELECT count, sum, min, max FROM metrics_hourly
         WHERE hour_ts = ? AND metric_name = ? AND labels_json = ?`,
      )
      .all(hourTs, name, labelsJson) as MetricHourlyRow[];

    if (existing.length > 0) {
      this.db
        .prepare(
          `UPDATE metrics_hourly SET
             count = count + 1,
             sum = sum + ?,
             min = MIN(COALESCE(min, ?), ?),
             max = MAX(COALESCE(max, ?), ?)
           WHERE hour_ts = ? AND metric_name = ? AND labels_json = ?`,
        )
        .run(value, value, value, value, value, hourTs, name, labelsJson);
    } else {
      this.db
        .prepare(
          `INSERT INTO metrics_hourly (hour_ts, metric_name, labels_json, count, sum, min, max)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(hourTs, name, labelsJson, value, value, value);
    }
  }

  recordAgentRun(run: AgentRunInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_runs
           (run_id, session_id, started_at, ended_at, model, tokens_used, tool_calls, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.run_id,
        run.session_id,
        run.started_at,
        run.ended_at ?? null,
        run.model ?? null,
        run.tokens_used ?? 0,
        run.tool_calls ?? 0,
        run.status ?? "running",
      );
  }

  recordSpan(span: SpanTraceInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO span_traces
           (trace_id, span_id, parent_span_id, session_id, name,
            started_at, ended_at, attributes_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        span.trace_id,
        span.span_id,
        span.parent_span_id ?? null,
        span.session_id,
        span.name,
        span.started_at,
        span.ended_at ?? null,
        JSON.stringify(span.attributes ?? {}),
        span.status ?? "ok",
      );
  }

  queryMetrics(opts: QueryMetricsOptions = {}): readonly MetricHourlyRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.metric_name != null) {
      conditions.push("metric_name = ?");
      params.push(opts.metric_name);
    }
    if (opts.from_hour_ts != null) {
      conditions.push("hour_ts >= ?");
      params.push(opts.from_hour_ts);
    }
    if (opts.to_hour_ts != null) {
      conditions.push("hour_ts <= ?");
      params.push(opts.to_hour_ts);
    }
    if (opts.labels_json != null) {
      conditions.push("labels_json = ?");
      params.push(opts.labels_json);
    }

    const { where } = buildWhereClause(conditions);
    let sql = `SELECT * FROM metrics_hourly${where} ORDER BY hour_ts DESC`;

    if (opts.limit != null) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    return this.db.prepare(sql).all(...params) as MetricHourlyRow[];
  }

  queryAgentRuns(opts: QueryAgentRunsOptions = {}): readonly AgentRunRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.session_id != null) {
      conditions.push("session_id = ?");
      params.push(opts.session_id);
    }
    if (opts.from_started_at != null) {
      conditions.push("started_at >= ?");
      params.push(opts.from_started_at);
    }
    if (opts.to_started_at != null) {
      conditions.push("started_at <= ?");
      params.push(opts.to_started_at);
    }
    if (opts.status != null) {
      conditions.push("status = ?");
      params.push(opts.status);
    }

    const { where } = buildWhereClause(conditions);
    let sql = `SELECT * FROM agent_runs${where} ORDER BY started_at DESC`;

    if (opts.limit != null) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    return this.db.prepare(sql).all(...params) as AgentRunRow[];
  }

  close(): void {
    this.db.close();
  }
}
