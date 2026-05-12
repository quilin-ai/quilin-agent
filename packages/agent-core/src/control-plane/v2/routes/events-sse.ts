/**
 * GET /api/v2/events
 * Server-Sent Events stream of LoopStep + observability events.
 *
 * Query params:
 *   session=<sid>        required (single session focus)
 *   agent=<aid>          optional (filter to one subagent)
 *
 * Headers:
 *   Last-Event-ID        optional (reconnect cursor)
 *
 * Stream wire format:
 *   id: <monotonic>\n
 *   event: <kind>\n
 *   data: <json payload>\n\n
 *
 * Heartbeat (every `heartbeatIntervalMs`, default 15s):
 *   event: heartbeat\n
 *   data: {}\n\n
 */

import {
	methodNotAllowedResponse,
	validationErrorResponse,
} from "../responses.js";
import type {
	SseSubscribeOptions,
	SseSubscriber,
	SseSubscription,
	V2Runtime,
} from "../runtime.js";
import { AgentId, SessionId, type SseEvent } from "../schemas.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface SseHandleOptions {
	readonly heartbeatIntervalMs?: number;
	readonly now?: () => number;
}

/**
 * Format a single SSE event payload. Each event gets:
 *   - an `id:` line so clients can resume via Last-Event-ID
 *   - an `event:` line set to the discriminator kind
 *   - a single `data:` line containing the JSON payload
 *
 * 单条 SSE 事件的有线格式：id 让客户端可断点续传；event 携带 kind；
 * data 是单行 JSON payload。
 */
export function formatSseEvent(id: string, event: SseEvent): string {
	return `id: ${id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatHeartbeat(): string {
	return "event: heartbeat\ndata: {}\n\n";
}

interface HandleArgs {
	readonly request: Request;
	readonly runtime: V2Runtime;
	readonly options?: SseHandleOptions;
}

export async function handle(
	request: Request,
	runtime: V2Runtime,
	options: SseHandleOptions = {},
): Promise<Response> {
	return handleInternal({ request, runtime, options });
}

async function handleInternal(args: HandleArgs): Promise<Response> {
	const { request, runtime, options = {} } = args;
	if (request.method !== "GET") {
		return methodNotAllowedResponse(["GET"]);
	}

	const url = new URL(request.url);
	const sessionParam = url.searchParams.get("session");
	const sessionCheck = SessionId.safeParse(sessionParam);
	if (!sessionCheck.success) {
		return validationErrorResponse({
			field: "session",
			reason: "required query parameter; must match SessionId",
		});
	}

	const agentParam = url.searchParams.get("agent");
	let agentId: string | undefined;
	if (agentParam != null) {
		const agentCheck = AgentId.safeParse(agentParam);
		if (!agentCheck.success) {
			return validationErrorResponse({
				field: "agent",
				reason: "must match AgentId schema",
			});
		}
		agentId = agentCheck.data;
	}

	const lastEventId = request.headers.get("last-event-id") ?? undefined;

	const heartbeatIntervalMs =
		options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());

	const encoder = new TextEncoder();

	const subscribeOptions: SseSubscribeOptions =
		agentId == null
			? lastEventId == null
				? { sessionId: sessionCheck.data }
				: { sessionId: sessionCheck.data, lastEventId }
			: lastEventId == null
				? { sessionId: sessionCheck.data, agentId }
				: { sessionId: sessionCheck.data, agentId, lastEventId };

	// Cleanup state shared across start() and cancel() callbacks. We hoist
	// the heartbeat timer and unsubscribe so the ReadableStream's cancel()
	// — which fires when a consumer calls `reader.cancel()` without going
	// through `request.signal` — can release the same resources as the
	// abort path. Without this, a consumer that cancels but never aborts
	// keeps the heartbeat interval (and the underlying subscription)
	// alive forever, leaking timers and event listeners.
	//
	// 让 cancel() 与 abort() 走同一套清理逻辑。直接 reader.cancel() 而
	// 不触发 request.signal 时，原实现会泄漏 heartbeat timer 与订阅；
	// 这里把心跳计时器和取消订阅函数提升到外层，保证两条路径都能释放。
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let unsubscribe: (() => void) | null = null;
	let closed = false;

	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeatTimer != null) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (unsubscribe != null) {
			try {
				unsubscribe();
			} catch {
				/* tolerate duplicate */
			}
			unsubscribe = null;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let sequence = 0;
			const subscriber: SseSubscriber = (event) => {
				if (closed) return;
				sequence += 1;
				const id = `${now()}-${sequence}`;
				try {
					controller.enqueue(encoder.encode(formatSseEvent(id, event)));
					/* c8 ignore start: defensive enqueue-after-close branches */
				} catch {
					closed = true;
				}
				/* c8 ignore stop */
			};

			let subscription: SseSubscription;
			try {
				subscription = await runtime.subscribeSse(subscribeOptions, subscriber);
			} catch (error) {
				closed = true;
				const message = error instanceof Error ? error.message : String(error);
				try {
					controller.enqueue(
						encoder.encode(
							`event: error\ndata: ${JSON.stringify({ message })}\n\n`,
						),
					);
				} catch {
					/* downstream gone */
				}
				controller.close();
				return;
			}

			// Race: the consumer may have called `reader.cancel()` while we
			// were awaiting `runtime.subscribeSse(...)`. In that case
			// `cleanup()` already ran (and set `closed = true`) BEFORE
			// `unsubscribe` was wired, so the subscription would otherwise
			// leak. Tear it down immediately and exit start() — without
			// touching the controller, which the cancel path has already
			// closed.
			//
			// 取消-订阅竞态：消费者可能在 `runtime.subscribeSse(...)` 还在
			// await 时就调用了 `reader.cancel()`。此时 `cleanup()` 已经把
			// `closed` 置为 true，但 `unsubscribe` 还没拿到——直接释放
			// 订阅并退出 start()，避免后端订阅泄漏。
			if (closed) {
				try {
					subscription.unsubscribe();
				} catch {
					/* tolerate runtime unsubscribe errors */
				}
				return;
			}

			// Wire the subscription into the shared cleanup state so both
			// abort() and cancel() can drop the subscriber + heartbeat.
			unsubscribe = subscription.unsubscribe;

			// Replay backlog (if any) before live events
			if (subscription.backlog != null) {
				for (const { id, event } of subscription.backlog) {
					if (closed) break;
					try {
						controller.enqueue(encoder.encode(formatSseEvent(id, event)));
						/* c8 ignore start: defensive enqueue-after-close branch */
					} catch {
						closed = true;
					}
					/* c8 ignore stop */
				}
			}

			// Initial heartbeat so clients confirm the stream is live
			if (!closed) {
				try {
					controller.enqueue(encoder.encode(formatHeartbeat()));
					/* c8 ignore start: defensive enqueue-after-close branch */
				} catch {
					closed = true;
				}
				/* c8 ignore stop */
			}

			heartbeatTimer = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(formatHeartbeat()));
					/* c8 ignore start: defensive enqueue-after-close branches */
				} catch {
					closed = true;
					if (heartbeatTimer != null) {
						clearInterval(heartbeatTimer);
						heartbeatTimer = null;
					}
				}
				/* c8 ignore stop */
			}, heartbeatIntervalMs);
			// Detach so tests with fake timers don't hang the process
			if (typeof heartbeatTimer === "object" && heartbeatTimer != null) {
				(heartbeatTimer as { unref?: () => void }).unref?.();
			}

			const abort = () => {
				if (closed) return;
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) {
				abort();
			}
		},
		cancel() {
			// Fires when consumer calls `reader.cancel()` (without abort).
			// Release the heartbeat + subscription on this code path too so
			// nothing leaks when the consumer cancels through the reader.
			cleanup();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
}
