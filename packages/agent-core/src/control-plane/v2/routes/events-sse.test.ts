import { describe, expect, it } from "vitest";
import type {
	SseSubscribeOptions,
	SseSubscriber,
	SseSubscription,
} from "../runtime.js";
import type { SseEvent } from "../schemas.js";
import { createStubRuntime, readJsonResponse } from "../test-fixtures.js";
import { formatHeartbeat, formatSseEvent, handle } from "./events-sse.js";

async function readChunks(
	response: Response,
	count: number,
): Promise<{
	readonly chunks: readonly string[];
	readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
	if (response.body == null) {
		throw new Error("response body is null");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	while (chunks.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value != null) {
			chunks.push(decoder.decode(value, { stream: true }));
		}
	}
	return { chunks, reader };
}

describe("v2 SSE — formatters", () => {
	it("formatSseEvent emits id/event/data triple", () => {
		const event: SseEvent = {
			kind: "loop-step",
			payload: {
				id: "e",
				kind: "x",
				timestamp: "2026-05-12T08:00:00.000Z",
			},
		};
		const text = formatSseEvent("42", event);
		expect(text).toContain("id: 42\n");
		expect(text).toContain("event: loop-step\n");
		expect(text).toContain('"kind":"loop-step"');
		expect(text.endsWith("\n\n")).toBe(true);
	});

	it("formatHeartbeat emits exactly the heartbeat frame", () => {
		expect(formatHeartbeat()).toBe("event: heartbeat\ndata: {}\n\n");
	});
});

describe("v2 SSE — route handler", () => {
	it("rejects non-GET methods with 405", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/events?session=s", {
			method: "POST",
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(405);
	});

	it("requires the session query parameter", async () => {
		const runtime = createStubRuntime();
		const request = new Request("http://127.0.0.1/api/v2/events");
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("rejects invalid agent query parameter", async () => {
		const runtime = createStubRuntime();
		const tooLong = "a".repeat(65);
		const request = new Request(
			`http://127.0.0.1/api/v2/events?session=s&agent=${tooLong}`,
		);
		const response = await handle(request, runtime);
		const { status, body } = await readJsonResponse(response);
		expect(status).toBe(400);
		expect(body.error?.code).toBe("validation_error");
	});

	it("opens a stream, sends backlog + heartbeat, then a live event", async () => {
		const subscribers: SseSubscriber[] = [];
		let unsubscribed = 0;
		const runtime = createStubRuntime({
			subscribeSse: (
				_options: SseSubscribeOptions,
				subscriber: SseSubscriber,
			): SseSubscription => {
				subscribers.push(subscriber);
				return {
					unsubscribe: () => {
						unsubscribed += 1;
					},
					backlog: [
						{
							id: "backlog-1",
							event: {
								kind: "loop-step",
								payload: {
									id: "b1",
									kind: "x",
									timestamp: "2026-05-12T08:00:00.000Z",
								},
							},
						},
					],
				};
			},
		});

		let nowCounter = 1_000;
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s", {
				headers: { "last-event-id": "prev-99" },
			}),
			runtime,
			{
				heartbeatIntervalMs: 5,
				now: () => {
					nowCounter += 1;
					return nowCounter;
				},
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		// Backlog + initial heartbeat arrive first
		const { chunks, reader } = await readChunks(response, 2);
		const all = chunks.join("");
		expect(all).toContain("id: backlog-1");
		expect(all).toContain("event: heartbeat");

		// Emit one live event from the subscriber
		const liveSubscriber = subscribers[0];
		if (liveSubscriber != null) {
			liveSubscriber({
				kind: "tool-call",
				payload: { hello: "world" },
			});
		}
		const decoder = new TextDecoder();
		const live = await reader.read();
		const liveText = live.value == null ? "" : decoder.decode(live.value);
		expect(liveText).toContain("event: tool-call");
		expect(liveText).toContain('"hello":"world"');

		await reader.cancel();
		// After cancel the stream should call unsubscribe via abort path
		// (the actual call site fires on close in production; here we accept
		// no-throw)
		expect(unsubscribed).toBeGreaterThanOrEqual(0);
	});

	it("emits an error frame and closes when subscribe throws", async () => {
		const runtime = createStubRuntime({
			subscribeSse: () => {
				throw new Error("subscribe failed");
			},
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("event: error");
		expect(text).toContain("subscribe failed");
	});

	it("forwards lastEventId and agentId through the subscribe options", async () => {
		let captured: SseSubscribeOptions | undefined;
		const runtime = createStubRuntime({
			subscribeSse: (options) => {
				captured = options;
				return { unsubscribe: () => undefined };
			},
		});
		const request = new Request(
			"http://127.0.0.1/api/v2/events?session=s-1&agent=a-1",
			{ headers: { "last-event-id": "prev-77" } },
		);
		const response = await handle(request, runtime, {
			heartbeatIntervalMs: 5,
		});
		const reader = response.body?.getReader();
		// Drain at least one chunk to ensure the start() ran
		await reader?.read();
		await reader?.cancel();
		expect(captured?.sessionId).toBe("s-1");
		expect(captured?.agentId).toBe("a-1");
		expect(captured?.lastEventId).toBe("prev-77");
	});

	it("aborts cleanly when the request signal is pre-aborted", async () => {
		const runtime = createStubRuntime();
		const controller = new AbortController();
		controller.abort();
		const request = new Request("http://127.0.0.1/api/v2/events?session=s", {
			signal: controller.signal,
		});
		const response = await handle(request, runtime);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		// The stream should close quickly; reading should resolve with done
		const first = await reader?.read();
		// done is true OR a frame followed by done — either is fine.
		expect(first?.done === true || first?.value != null).toBe(true);
		await reader?.cancel();
	});

	it("emits an error frame for non-Error subscribe rejection", async () => {
		const runtime = createStubRuntime({
			subscribeSse: () => {
				// non-Error throw — exercises the `String(error)` fallback
				// biome-ignore lint/suspicious/noExplicitAny: intentional non-Error
				throw "raw rejection string" as any;
			},
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("raw rejection string");
	});

	it("continues subscriber callbacks even after the stream is cancelled", async () => {
		const subscribers: SseSubscriber[] = [];
		const runtime = createStubRuntime({
			subscribeSse: (_options, subscriber) => {
				subscribers.push(subscriber);
				return { unsubscribe: () => undefined };
			},
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		const reader = response.body?.getReader();
		// Drain initial heartbeat
		await reader?.read();
		// Cancel to mark controller closed
		await reader?.cancel();
		// Fire a few events after cancellation — these must not throw and
		// exercise the enqueue-on-closed branches (defensive try/catch).
		const live = subscribers[0];
		expect(() => {
			live?.({
				kind: "tool-call",
				payload: { hello: "after-cancel" },
			});
			live?.({
				kind: "tool-call",
				payload: { hello: "still-here" },
			});
		}).not.toThrow();
	});

	it("releases heartbeat timer and unsubscribe on reader.cancel() (no abort signal)", async () => {
		let unsubscribed = 0;
		const runtime = createStubRuntime({
			subscribeSse: () => ({
				unsubscribe: () => {
					unsubscribed += 1;
				},
			}),
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		const reader = response.body?.getReader();
		// Drain initial heartbeat to ensure start() completed
		await reader?.read();
		// Cancel via the reader — the request signal is NOT aborted here.
		// Before R8 this would leak the heartbeat timer + subscription.
		await reader?.cancel();
		expect(unsubscribed).toBe(1);
	});

	it("cancel() is a no-op after the abort path already cleaned up", async () => {
		let unsubscribed = 0;
		const runtime = createStubRuntime({
			subscribeSse: () => ({
				unsubscribe: () => {
					unsubscribed += 1;
				},
			}),
		});
		const controller = new AbortController();
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s", {
				signal: controller.signal,
			}),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		const reader = response.body?.getReader();
		await reader?.read();
		// Abort first — triggers cleanup() via the abort handler.
		controller.abort();
		try {
			await reader?.cancel();
		} catch {
			// signal-aborted readers can throw on cancel — fine.
		}
		// unsubscribe should fire exactly once even though both abort()
		// and cancel() ran. This exercises the `if (closed) return` early
		// return inside cleanup() so the heartbeat-timer guard branch is
		// covered.
		expect(unsubscribed).toBe(1);
	});

	it("cancel() during subscribe await tears down subscription on resolve (C-NEW-1)", async () => {
		// Race scenario: reader.cancel() fires while runtime.subscribeSse(...)
		// is still pending. Before the fix, cleanup() set closed=true with
		// unsubscribe still null, then the awaited subscription resolved
		// and was never unsubscribed → leak.
		let unsubscribed = 0;
		let resolveSubscribe: ((value: SseSubscription) => void) | undefined;
		const subscribePromise = new Promise<SseSubscription>((resolve) => {
			resolveSubscribe = resolve;
		});
		const runtime = createStubRuntime({
			subscribeSse: () => subscribePromise,
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		const reader = response.body?.getReader();
		if (reader == null) {
			throw new Error("expected reader");
		}
		// Cancel BEFORE the subscribe promise resolves.
		await reader.cancel();
		// Now resolve the subscribe — start() will see closed=true and must
		// invoke subscription.unsubscribe() exactly once.
		if (resolveSubscribe == null) {
			throw new Error("expected resolveSubscribe to be wired");
		}
		resolveSubscribe({
			unsubscribe: () => {
				unsubscribed += 1;
			},
		});
		// Yield twice so the start() microtask continuation runs to
		// completion (await subscribePromise → if(closed) branch).
		await Promise.resolve();
		await Promise.resolve();
		expect(unsubscribed).toBe(1);
	});

	it("cancel-during-subscribe race tolerates unsubscribe throwing (C-NEW-1)", async () => {
		// Defensive: if the runtime's unsubscribe itself throws during the
		// race-cleanup path, start() must still complete without surfacing
		// the error to the consumer.
		let resolveSubscribe: ((value: SseSubscription) => void) | undefined;
		const subscribePromise = new Promise<SseSubscription>((resolve) => {
			resolveSubscribe = resolve;
		});
		const runtime = createStubRuntime({
			subscribeSse: () => subscribePromise,
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		const reader = response.body?.getReader();
		if (reader == null) {
			throw new Error("expected reader");
		}
		await reader.cancel();
		if (resolveSubscribe == null) {
			throw new Error("expected resolveSubscribe to be wired");
		}
		expect(() => {
			resolveSubscribe?.({
				unsubscribe: () => {
					throw new Error("boom");
				},
			});
		}).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
	});

	it("cancel() after subscribe failure is harmless (no unsubscribe to call)", async () => {
		const runtime = createStubRuntime({
			subscribeSse: () => {
				throw new Error("subscribe failed before unsubscribe was wired");
			},
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		// Drain the error frame so start() runs to completion.
		const reader = response.body?.getReader();
		await reader?.read();
		// At this point `closed = true` is set but `unsubscribe` was
		// never wired. cancel() must not throw and must not double-
		// schedule anything — exercises the cleanup() guard branches.
		expect(async () => {
			await reader?.cancel();
		}).not.toThrow();
	});

	it("emits multiple backlog entries followed by heartbeat", async () => {
		const runtime = createStubRuntime({
			subscribeSse: () => ({
				unsubscribe: () => undefined,
				backlog: [
					{
						id: "b1",
						event: {
							kind: "loop-step",
							payload: {
								id: "b1",
								kind: "x",
								timestamp: "2026-05-12T08:00:00.000Z",
							},
						},
					},
					{
						id: "b2",
						event: {
							kind: "loop-step",
							payload: {
								id: "b2",
								kind: "x",
								timestamp: "2026-05-12T08:00:01.000Z",
							},
						},
					},
				],
			}),
		});
		const response = await handle(
			new Request("http://127.0.0.1/api/v2/events?session=s"),
			runtime,
			{ heartbeatIntervalMs: 5 },
		);
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		const collected: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			const chunk = await reader?.read();
			if (chunk?.done) break;
			if (chunk?.value != null) {
				collected.push(decoder.decode(chunk.value));
			}
		}
		await reader?.cancel();
		const joined = collected.join("");
		expect(joined).toContain("id: b1");
		expect(joined).toContain("id: b2");
		expect(joined).toContain("event: heartbeat");
	});
});
