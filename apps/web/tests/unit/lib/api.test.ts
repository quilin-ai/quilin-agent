import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiEnvelopeError, ApiHttpError, ApiResponseError, api, openEventStream } from "@/lib/api";

interface MockResponseInit {
	readonly status?: number;
	readonly body: unknown;
	readonly textBody?: string;
}

function mockJsonResponse(init: MockResponseInit): Response {
	const status = init.status ?? 200;
	return new Response(JSON.stringify(init.body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function mockTextErrorResponse(status: number, text: string): Response {
	return new Response(text, {
		status,
		headers: { "content-type": "text/plain" },
	});
}

const SAMPLE_SNAPSHOT = {
	version: "0.1.0-iter-f",
	startedAt: "2026-05-12T10:00:00Z",
	currentSessionId: "s1",
	currentAgentId: "main",
	agents: [],
	memory: [],
	skills: [],
	tools: [],
	mcp: [],
	config: {
		trustMode: "auto",
		idleEvolution: false,
		autoReflect: true,
		tokenBudgetDaily: 120_000,
		tokenBudgetWarnAt: 0.8,
		modelDefault: "claude-opus-4-7",
		modelCheap: "claude-haiku-4-5",
		redactionPolicy: "standard",
	},
	trustMode: "auto",
};

const SAMPLE_SESSIONS = {
	items: [
		{
			id: "s1",
			title: "self-evolution Stage D 状态查询",
			agentId: "main",
			turnsCount: 3,
			tokensTotal: 3_200,
			startedAt: "2026-05-12T13:45:00Z",
			lastTurnAt: "2026-05-12T13:55:00Z",
			status: "active",
			costUsd: 0.12,
		},
	],
	nextCursor: null,
};

const SAMPLE_CONFIG = SAMPLE_SNAPSHOT.config;

describe("api client envelope handling", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("unwraps a successful snapshot envelope", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({ body: { ok: true, data: SAMPLE_SNAPSHOT } }),
		);
		const result = await api.snapshot({ fetchImpl: fetchMock as typeof fetch });
		expect(result.version).toBe("0.1.0-iter-f");
		expect(result.config.trustMode).toBe("auto");
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/proxy/api/v2/snapshot",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("decodes sessions list", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({ body: { ok: true, data: SAMPLE_SESSIONS } }),
		);
		const result = await api.sessions({ fetchImpl: fetchMock as typeof fetch });
		expect(result.items).toHaveLength(1);
		const firstItem = result.items[0];
		expect(firstItem).toBeDefined();
		if (firstItem) {
			expect(firstItem.id).toBe("s1");
		}
	});

	it("throws ApiHttpError on non-2xx", async () => {
		fetchMock.mockResolvedValueOnce(mockTextErrorResponse(502, "bad gateway"));
		await expect(api.snapshot({ fetchImpl: fetchMock as typeof fetch })).rejects.toBeInstanceOf(
			ApiHttpError,
		);
	});

	it("throws ApiEnvelopeError when ok=false", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({
				body: {
					ok: false,
					error: { code: "session_not_found", message: "missing" },
				},
			}),
		);
		await expect(
			api.session("missing", { fetchImpl: fetchMock as typeof fetch }),
		).rejects.toBeInstanceOf(ApiEnvelopeError);
	});

	it("throws ApiResponseError when envelope is malformed", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({ body: { ok: true, data: { bogus: true } } }),
		);
		await expect(api.snapshot({ fetchImpl: fetchMock as typeof fetch })).rejects.toBeInstanceOf(
			ApiResponseError,
		);
	});

	it("throws ApiResponseError when the response is not an object", async () => {
		fetchMock.mockResolvedValueOnce(mockJsonResponse({ body: "not an envelope" }));
		await expect(api.snapshot({ fetchImpl: fetchMock as typeof fetch })).rejects.toBeInstanceOf(
			ApiResponseError,
		);
	});

	it("throws ApiResponseError when ok=false but error envelope is wrong", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({ body: { ok: false, error: { wrong: true } } }),
		);
		await expect(api.snapshot({ fetchImpl: fetchMock as typeof fetch })).rejects.toBeInstanceOf(
			ApiResponseError,
		);
	});

	it("validates config patch input client-side", async () => {
		fetchMock.mockResolvedValueOnce(mockJsonResponse({ body: { ok: true, data: SAMPLE_CONFIG } }));
		await api.patchConfig({ trustMode: "ask" }, { fetchImpl: fetchMock as typeof fetch });
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(init?.method).toBe("POST");
		expect(JSON.parse((init?.body as string) ?? "{}")).toEqual({
			trustMode: "ask",
		});
	});

	it("issues authorize POST with comment", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({
				body: { ok: true, data: { requestId: "r1", resolved: true } },
			}),
		);
		await api.postAuthorize("r1", "approve", "looks ok", {
			fetchImpl: fetchMock as typeof fetch,
		});
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse((init?.body as string) ?? "{}")).toEqual({
			requestId: "r1",
			decision: "approve",
			comment: "looks ok",
		});
	});

	it("issues authorize POST without comment when undefined", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({
				body: { ok: true, data: { requestId: "r1", resolved: false } },
			}),
		);
		await api.postAuthorize("r1", "deny", undefined, {
			fetchImpl: fetchMock as typeof fetch,
		});
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse((init?.body as string) ?? "{}")).toEqual({
			requestId: "r1",
			decision: "deny",
		});
	});

	it("uses custom baseUrl + signal", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({ body: { ok: true, data: SAMPLE_SESSIONS } }),
		);
		const controller = new AbortController();
		await api.sessions({
			fetchImpl: fetchMock as typeof fetch,
			baseUrl: "http://localhost:9999",
			signal: controller.signal,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:9999/api/v2/sessions",
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it("encodes session id when requesting detail", async () => {
		fetchMock.mockResolvedValueOnce(
			mockJsonResponse({
				body: {
					ok: true,
					data: {
						session: {
							id: "s 1",
							title: "t",
							agentId: "main",
							turnsCount: 0,
							tokensTotal: 0,
							startedAt: "2026-05-12T10:00:00Z",
							lastTurnAt: "2026-05-12T10:00:00Z",
							status: "active",
							costUsd: null,
						},
						turns: [],
					},
				},
			}),
		);
		await api.session("s 1", { fetchImpl: fetchMock as typeof fetch });
		expect(fetchMock).toHaveBeenCalledWith("/api/proxy/api/v2/sessions/s%201", expect.any(Object));
	});

	it("routes all listed endpoints", async () => {
		const responses = [[], { items: [] }, [], [], [], SAMPLE_CONFIG, { items: [] }];
		for (const data of responses) {
			fetchMock.mockResolvedValueOnce(mockJsonResponse({ body: { ok: true, data } }));
		}
		await api.memoryTiers({ fetchImpl: fetchMock as typeof fetch });
		await api.memoryRecent({ fetchImpl: fetchMock as typeof fetch });
		await api.skills({ fetchImpl: fetchMock as typeof fetch });
		await api.tools({ fetchImpl: fetchMock as typeof fetch });
		await api.mcp({ fetchImpl: fetchMock as typeof fetch });
		await api.config({ fetchImpl: fetchMock as typeof fetch });
		await api.agents({ fetchImpl: fetchMock as typeof fetch });
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});

	it("throws when no fetch implementation is available", async () => {
		const original = globalThis.fetch;
		// @ts-expect-error force missing
		globalThis.fetch = undefined;
		try {
			await expect(api.snapshot()).rejects.toThrow(/No fetch implementation/);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("openEventStream", () => {
	const originalES = globalThis.EventSource;

	class FakeEventSource {
		public static instances: FakeEventSource[] = [];
		public readonly url: string;
		public onmessage: ((event: MessageEvent) => void) | null = null;
		public closed = false;
		constructor(url: string) {
			this.url = url;
			FakeEventSource.instances.push(this);
		}
		close() {
			this.closed = true;
		}
	}

	beforeEach(() => {
		FakeEventSource.instances = [];
		// @ts-expect-error injected fake
		globalThis.EventSource = FakeEventSource;
	});
	afterEach(() => {
		globalThis.EventSource = originalES;
	});

	it("opens stream and forwards parsed events", () => {
		const received: unknown[] = [];
		const handle = openEventStream("s1", (event) => received.push(event));
		const instance = FakeEventSource.instances[0];
		expect(instance).toBeDefined();
		if (!instance) return;
		expect(instance.url).toContain("/api/v2/events?session=s1");
		const event = new MessageEvent("message", {
			data: JSON.stringify({ kind: "loop-step", payload: { step: 1 } }),
		});
		instance.onmessage?.(event);
		expect(received).toEqual([{ kind: "loop-step", payload: { step: 1 } }]);
		handle.close();
		expect(instance.closed).toBe(true);
	});

	it("drops malformed payloads silently", () => {
		const received: unknown[] = [];
		openEventStream("s1", (event) => received.push(event));
		const instance = FakeEventSource.instances[0];
		expect(instance).toBeDefined();
		if (!instance) return;
		instance.onmessage?.(new MessageEvent("message", { data: "not json" }));
		expect(received).toHaveLength(0);
	});

	it("closes the stream when AbortSignal fires", () => {
		const controller = new AbortController();
		openEventStream("s1", () => undefined, { signal: controller.signal });
		const instance = FakeEventSource.instances[0];
		expect(instance).toBeDefined();
		if (!instance) return;
		controller.abort();
		expect(instance.closed).toBe(true);
	});

	it("closes immediately if signal is already aborted", () => {
		const controller = new AbortController();
		controller.abort();
		openEventStream("s1", () => undefined, { signal: controller.signal });
		const instance = FakeEventSource.instances[0];
		expect(instance).toBeDefined();
		if (!instance) return;
		expect(instance.closed).toBe(true);
	});

	it("throws when EventSource is unavailable", () => {
		// @ts-expect-error force missing
		globalThis.EventSource = undefined;
		expect(() => openEventStream("s1", () => undefined)).toThrow(/EventSource not available/);
	});

	it("accepts custom baseUrl", () => {
		openEventStream("s1", () => undefined, { baseUrl: "http://x:9999" });
		const instance = FakeEventSource.instances[0];
		expect(instance).toBeDefined();
		if (!instance) return;
		expect(instance.url).toBe("http://x:9999/api/v2/events?session=s1");
	});
});
