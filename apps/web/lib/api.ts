/**
 * Quilin Agent · v2 control-plane HTTP client.
 *
 * Contract source: docs/08-observability/web-ui-rebuild-plan.md §4–§5.
 * Every request is validated with zod before being returned, so a misshaped
 * backend response surfaces a `ApiResponseError` with the offending payload —
 * no silent corruption downstream.
 */
import type { z } from "zod";

import {
	type AgentSummary,
	AgentsListResponseSchema,
	ApiErrorSchema,
	AuthorizePostSchema,
	AuthorizeResponseSchema,
	type Config,
	ConfigPatchSchema,
	ConfigSchema,
	MCPRegistrySchema,
	MemoryRecentResponseSchema,
	MemoryTiersSchema,
	RuntimeSnapshotSchema,
	SessionDetailSchema,
	SessionsListResponse,
	SkillsCatalogSchema,
	ToolsCatalogSchema,
} from "./schemas";

const DEFAULT_BASE_URL =
	typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_BASE
		? process.env.NEXT_PUBLIC_API_BASE
		: "/api/proxy";

export class ApiHttpError extends Error {
	public readonly status: number;
	public readonly bodySnippet: string;
	constructor(status: number, bodySnippet: string) {
		super(`Quilin control-plane returned HTTP ${status}: ${bodySnippet}`);
		this.name = "ApiHttpError";
		this.status = status;
		this.bodySnippet = bodySnippet;
	}
}

export class ApiResponseError extends Error {
	public readonly issues: readonly z.core.$ZodIssue[];
	public readonly raw: unknown;
	constructor(issues: readonly z.core.$ZodIssue[], raw: unknown) {
		super(
			`Quilin control-plane response failed schema validation: ${issues
				.map((i) => `${i.path.join(".")} ${i.message}`)
				.join("; ")}`,
		);
		this.name = "ApiResponseError";
		this.issues = issues;
		this.raw = raw;
	}
}

export class ApiEnvelopeError extends Error {
	public readonly code: string;
	public readonly detail: unknown;
	constructor(code: string, message: string, detail: unknown) {
		super(`Quilin control-plane error [${code}]: ${message}`);
		this.name = "ApiEnvelopeError";
		this.code = code;
		this.detail = detail;
	}
}

export interface ApiClientOptions {
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
 * Unwrap the standard `{ ok, data, error }` envelope (§4 common types). When
 * `ok === false`, throws `ApiEnvelopeError`. When the envelope itself is
 * malformed, throws `ApiResponseError`.
 */
function unwrapEnvelope<T>(raw: unknown, dataSchema: z.ZodType<T>): T {
	if (typeof raw !== "object" || raw === null) {
		throw new ApiResponseError(
			[
				{
					code: "custom",
					message: "response was not an object",
					path: [],
					input: raw,
				} as unknown as z.core.$ZodIssue,
			],
			raw,
		);
	}
	const envelope = raw as { ok?: unknown; data?: unknown; error?: unknown };
	if (envelope.ok === false) {
		const errorParse = ApiErrorSchema.safeParse(envelope.error);
		if (!errorParse.success) {
			throw new ApiResponseError(errorParse.error.issues, raw);
		}
		throw new ApiEnvelopeError(
			errorParse.data.code,
			errorParse.data.message,
			errorParse.data.detail,
		);
	}
	const dataParse = dataSchema.safeParse(envelope.data);
	if (!dataParse.success) {
		throw new ApiResponseError(dataParse.error.issues, raw);
	}
	return dataParse.data;
}

async function request<T>(
	path: string,
	dataSchema: z.ZodType<T>,
	init: RequestInit,
	options: ApiClientOptions,
): Promise<T> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new Error("No fetch implementation available");
	}
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	const url = `${baseUrl}${path}`;
	const response = await fetchImpl(url, {
		...init,
		signal: options.signal ?? init.signal,
		headers: {
			Accept: "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		const snippet = await response.text().catch(() => "");
		throw new ApiHttpError(response.status, snippet.slice(0, 240));
	}
	const json = (await response.json()) as unknown;
	return unwrapEnvelope(json, dataSchema);
}

export const api = {
	snapshot(options: ApiClientOptions = {}) {
		return request("/api/v2/snapshot", RuntimeSnapshotSchema, { method: "GET" }, options);
	},
	sessions(options: ApiClientOptions = {}) {
		return request("/api/v2/sessions", SessionsListResponse, { method: "GET" }, options);
	},
	session(id: string, options: ApiClientOptions = {}) {
		const encoded = encodeURIComponent(id);
		return request(`/api/v2/sessions/${encoded}`, SessionDetailSchema, { method: "GET" }, options);
	},
	memoryTiers(options: ApiClientOptions = {}) {
		return request("/api/v2/memory/tiers", MemoryTiersSchema, { method: "GET" }, options);
	},
	memoryRecent(options: ApiClientOptions = {}) {
		return request("/api/v2/memory/recent", MemoryRecentResponseSchema, { method: "GET" }, options);
	},
	skills(options: ApiClientOptions = {}) {
		return request("/api/v2/skills", SkillsCatalogSchema, { method: "GET" }, options);
	},
	tools(options: ApiClientOptions = {}) {
		return request("/api/v2/tools", ToolsCatalogSchema, { method: "GET" }, options);
	},
	mcp(options: ApiClientOptions = {}) {
		return request("/api/v2/mcp", MCPRegistrySchema, { method: "GET" }, options);
	},
	config(options: ApiClientOptions = {}) {
		return request("/api/v2/config", ConfigSchema, { method: "GET" }, options);
	},
	patchConfig(patch: Partial<Config>, options: ApiClientOptions = {}) {
		const validated = ConfigPatchSchema.parse(patch);
		return request(
			"/api/v2/config",
			ConfigSchema,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(validated),
			},
			options,
		);
	},
	agents(options: ApiClientOptions = {}) {
		return request("/api/v2/agents", AgentsListResponseSchema, { method: "GET" }, options);
	},
	postAuthorize(
		requestId: string,
		decision: "approve" | "deny",
		comment: string | undefined,
		options: ApiClientOptions = {},
	) {
		const body = AuthorizePostSchema.parse(
			comment === undefined ? { requestId, decision } : { requestId, decision, comment },
		);
		return request(
			"/api/v2/authorize",
			AuthorizeResponseSchema,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
			options,
		);
	},
};

export type Api = typeof api;

/**
 * SSE consumer — yields parsed `{ kind, payload }` events; respects
 * AbortSignal cancellation. The frontend page wires this into a React
 * state machine that pipes events into the live `Process` container.
 *
 * Returns the underlying EventSource so callers can close it on unmount.
 */
export function openEventStream(
	sessionId: string,
	onEvent: (raw: unknown) => void,
	options: { baseUrl?: string; signal?: AbortSignal } = {},
): { close: () => void } {
	if (typeof EventSource === "undefined") {
		throw new Error("EventSource not available in this runtime");
	}
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	const url = `${baseUrl}/api/v2/events?session=${encodeURIComponent(sessionId)}`;
	const source = new EventSource(url);
	const close = () => source.close();
	source.onmessage = (event) => {
		try {
			const parsed = JSON.parse(event.data) as unknown;
			onEvent(parsed);
		} catch {
			// drop malformed payloads — backend is the source of truth and will
			// re-emit valid frames; surfacing parse errors would flood the UI.
		}
	};
	if (options.signal) {
		if (options.signal.aborted) {
			close();
		} else {
			options.signal.addEventListener("abort", close, { once: true });
		}
	}
	return { close };
}

/**
 * Re-export the canonical agent typings so consumers don't import schemas
 * directly when they only need types.
 */
export type { AgentSummary };
