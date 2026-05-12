/**
 * Quilin Agent · Chat endpoint backed by AI SDK v6 + AgentService.
 *
 * Task #22 Phase 3: session state lives in AgentService (shared with
 * TUI / admin probes), not in a private `chat-session-store` ring
 * buffer. The route translates AI SDK v6 `streamText().fullStream`
 * chunks into structured `AgentEventPayload` events via
 * `pumpFullStreamIntoAgentService`, and the subscriber stream
 * translates AgentEvents back into the SSE wire format `useChat`
 * expects via `agentEventToSseChunk`.
 *
 * Behavior preserved from the legacy chat-session-store path:
 *   1. Client disconnect does NOT kill the runner — the `setImmediate`
 *      detach keeps the background `streamText` alive, and Web subscriber
 *      cancellation only closes the subscription.
 *   2. Same `(sessionId, user-message hash)` reconnect → re-attach to
 *      the live AgentService session and replay its event history.
 *   3. Different hash on the same `sessionId` → abort the prior runner
 *      via its `AbortController`, evict the AgentService session, then
 *      start a fresh one.
 *   4. Client `resumeStream()` lands on the same subscriber + replays
 *      mid-stream events.
 *   5. `MAX_WEB_SESSION_META=200` cap is enforced by `web-session-meta`'s
 *      LRU eviction.
 *
 * Strict-epoch handshake: the response carries `X-Quilin-Epoch` so the
 * client can persist it; on reconnect the client passes `clientEpoch`
 * in the request body. A mismatch implies the agent-core process
 * restarted while the client cached a stale epoch — we treat that the
 * same as "no session found" and start fresh, so the user never sees
 * silently mis-numbered events.
 *
 * Task #22 Phase 3:Web chat 路由切换到 AgentService。状态共享给 TUI / admin probe;
 * 翻译层(sse-translator)做 AI SDK v6 SSE ⇄ AgentEvent 双向转换;严格 epoch
 * 校验跨进程重启的 session 重连。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { agentRegistry, shortId } from "@/lib/agent-registry";
import { type AgentServiceLike, getAgentService } from "@/lib/agent-service-client";
import {
	agentEventToSseChunk,
	pumpFullStreamIntoAgentService,
	SSE_DONE_FRAME,
} from "@/lib/sse-translator";
import { getToolsCatalog } from "@/lib/tools-loader";
import {
	evictSession,
	getMeta,
	hashMessages,
	setMeta,
	touchMeta,
	type WebSessionMeta,
} from "@/lib/web-session-meta";

/**
 * Dynamically load agent-core's built tool factory at request time.
 *
 * 为什么不用静态 import?
 *   - `@quilin/agent-core` 的 dist 是一个 3.5MB 的 bundle,内部有 observability
 *     dashboard 模块在文件顶层执行 `fileURLToPath(new URL("./dashboard-ui/",
 *     import.meta.url))`。这会被 Turbopack 静态分析时当成必须 resolve 的资源
 *     路径,导致编译失败。
 *   - 直接动态 import dist 文件:Node 运行时 resolve,绕开 Turbopack 静态分析。
 *     dist 包内的 dashboard URL 在执行时才求值,文件实际存在(运行 OK)。
 *
 * Cached after first load to avoid repeated module resolution.
 */
/**
 * agent-core's `web_fetch` blocks indefinitely on the dist bundle (likely a
 * sandbox/DNS guard interacting with the dispatcher path inside the bundle).
 * Replace it with a thin, well-behaved native-fetch implementation so the
 * LLM has a working HTTP primitive immediately. Same input shape as the
 * agent-core version (url / method / body / headers).
 *
 * agent-core 的 `web_fetch` 在 dist bundle 里执行会卡死(沙箱 DNS 守卫 +
 * import.meta.url 资源解析路径相互作用)。这里直接用 Node native fetch
 * 写一个清爽版,接同样的入参形状,LLM 立刻能用。
 */
const inlineWebFetchTool = tool({
	description:
		"Fetch HTTP(S) resources. Returns response body as text (truncated to 30KB) plus status/content-type. Use this for any external data, including search engine result pages.",
	inputSchema: z.object({
		url: z.string().url(),
		method: z.enum(["GET", "POST", "HEAD"]).default("GET"),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.string().optional(),
		maxChars: z.number().int().min(1).max(200_000).default(30_000),
	}),
	execute: async (args: {
		url: string;
		method?: "GET" | "POST" | "HEAD";
		headers?: Record<string, string>;
		body?: string;
		maxChars?: number;
	}) => {
		const { url, method = "GET", headers, body, maxChars = 30_000 } = args;
		console.log(`[TOOL web_fetch] ${method} ${url}`);
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 20_000);
			const res = await fetch(url, {
				method,
				headers: {
					"user-agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Quilin/0.1",
					...headers,
				},
				body,
				signal: controller.signal,
				redirect: "follow",
			});
			clearTimeout(timer);
			const ct = res.headers.get("content-type") ?? "";
			const text = method === "HEAD" ? "" : await res.text();
			console.log(`[TOOL web_fetch] HTTP ${res.status} ${ct} ${text.length}B`);
			const truncated = text.length > maxChars;
			return {
				url,
				status: res.status,
				ok: res.ok,
				contentType: ct,
				bodyLength: text.length,
				body: truncated
					? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`
					: text,
				truncated,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.log(`[TOOL web_fetch] EXCEPTION: ${msg}`);
			return { url, error: msg, status: 0, ok: false };
		}
	},
});

/**
 * Tool loading is now centralized in `lib/tools-loader.ts` so the chat
 * route and the read-only `/api/tools` / `/api/mcp` catalog endpoints
 * share one MCP registry (and therefore one set of stdio subprocesses).
 *
 * 工具加载统一走 lib/tools-loader.ts,所有 route 共享同一份 MCP registry。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const IS_REASONER = DEEPSEEK_MODEL.includes("reasoner");

const SYSTEM_PROMPT_BASE =
	"你是麒麟 (Quilin),一个自演化的 AI Agent。" +
	"用中文与用户对话,语气专业、精炼、有条理。回答里可以用 markdown,但避免过度装饰。";

const SYSTEM_PROMPT_WITH_TOOLS =
	`${SYSTEM_PROMPT_BASE}\n\n` +
	"你有一组真实工具,先用工具查清事实再答,不要凭记忆编造。\n\n" +
	"并行子代理 (web 层):\n" +
	"- spawn_subagent(task): 派一个并行子代理跑一个独立子任务,立即返回 agentId,不等结果。\n" +
	"- wait_for_subagents(agentIds): 阻塞等待你派的子代理跑完,返回它们的输出文本。\n\n" +
	"原则:\n" +
	"- 用户的请求能拆成多个互相独立的子任务、或明示要并行/多个 subagent/分别处理时,用 spawn_subagent 拆;否则直接答或自己调工具。\n" +
	"- 派 spawn_subagent 必须紧接着 wait_for_subagents 拿结果,不要停在『已派遣』。\n" +
	"- 综合 subagent 输出成自然语言答案,引用 URL,不要复制 JSON。\n" +
	"- 涉及『最新』『最近』『版本』『近期』『当前』『动态』等时效性内容,**必须**用 web_fetch 工具查真实数据,不要凭训练记忆答。";

/* Tool catalog is loaded lazily on first chat via lib/tools-loader.ts. */

/**
 * Build a session-scoped spawn_subagent tool. The tool factory closes over
 * `sessionId` so every subagent it spawns is registered with
 * `parentId === sessionId`, which lets `/api/agents?parent=<sessionId>`
 * filter out subagents from unrelated chat sessions.
 *
 * 把 sessionId 闭包进工厂,spawn 出来的 subagent 都带这个 parentId,前端
 * 才能按 session 过滤,避免不同会话的 subagent 混在一起。
 */
function makeSpawnSubagentTool(sessionId: string) {
	return tool({
		description:
			"派遣一个并行的子代理(subagent)去执行一个独立的子任务。【强制使用场景】用户消息出现『subagent / 子代理 / 派 N 个 / 开 N 个 / 分别查 / 同时查 / 并行』等任意触发词时,主代理必须用本工具拆任务。【关键】本工具是 fire-and-forget,只立即返回 agentId 不等结果;派完所有 subagent 后,你必须紧接着调 `wait_for_subagents` 才能拿到它们的输出来汇总给用户——否则用户只看到一句『已派遣』什么实质答案都没有,这是严重失败。",
		inputSchema: z.object({
			task: z
				.string()
				.min(1)
				.max(2000)
				.describe(
					"该子代理要执行的具体任务(中文,完整一句话,例如『查 gemini-cli 最新版本和新增功能』)。必须是独立可完成的单一目标,不要塞多个目标也不要复制父任务整段描述。",
				),
		}),
		execute: async ({ task }: { task: string }) => {
			const agentId = `subagent-${shortId()}`;
			agentRegistry.register({
				id: agentId,
				kind: "subagent",
				parentId: sessionId,
				task,
				status: "running",
			});

			// Fire-and-forget: kick off the subagent's own DeepSeek call in the
			// background so this tool returns immediately and the parent LLM can
			// continue spawning more subagents or replying to the user.
			void runSubagentInBackground(agentId, task);

			return {
				agentId,
				status: "spawned" as const,
				task,
				note: "已派遣;继续派其它 subagent 或调用 wait_for_subagents 等待结果。",
			};
		},
	});
}

const waitForSubagentsTool = tool({
	description:
		"等待之前 spawn_subagent 派遣的子代理跑完,返回每个 subagent 的最终输出文本。【强制】只要你刚调用过 spawn_subagent,你必须紧接着调本工具拿子代理输出再综合给用户。本工具阻塞轮询直到目标 subagent 全部 completed/failed 或超时(默认 120 秒)。返回数组包含每个 subagent 的 task / status / text / usage,你必须基于 text 字段综合写最终答案给用户(引用 URL,中文)。",
	inputSchema: z.object({
		agentIds: z
			.array(z.string())
			.min(1)
			.describe(
				"要等待的 subagent id 列表,把刚才 spawn_subagent 返回的 agentId 全填进来,例如 ['subagent-99a2e94c','subagent-0e0f359f']。",
			),
		timeoutSec: z
			.number()
			.int()
			.min(5)
			.max(180)
			.default(120)
			.describe("最长等待秒数,默认 120;一般 subagent 30-60 秒就完成,留余量。"),
	}),
	execute: async ({ agentIds, timeoutSec }: { agentIds: string[]; timeoutSec?: number }) => {
		const POLL_MS = 500;
		const deadline = Date.now() + (timeoutSec ?? 120) * 1000;
		const isTerminal = (s: string): boolean =>
			s === "completed" || s === "failed" || s === "cancelled" || s === "blocked";

		while (Date.now() < deadline) {
			const records = agentRegistry.list();
			const targets = agentIds.map((id) => records.find((r) => r.id === id));
			const allDone = targets.every((r) => r != null && isTerminal(r.status));
			if (allDone) break;
			await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
		}

		const finalRecords = agentRegistry.list();
		const results = agentIds.map((id) => {
			const r = finalRecords.find((x) => x.id === id);
			if (r == null) {
				return {
					agentId: id,
					status: "not_found" as const,
					task: null,
					text: "",
					usage: null,
					durationMs: 0,
				};
			}
			const startedMs = new Date(r.startedAt).getTime();
			const endedMs = r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt).getTime() : Date.now();
			return {
				agentId: r.id,
				status: r.status,
				task: r.task,
				text: r.streamedText,
				usage: r.usage,
				durationMs: Math.max(0, endedMs - startedMs),
			};
		});

		const timedOut =
			Date.now() >= deadline &&
			results.some(
				(r) =>
					r.status !== "completed" &&
					r.status !== "failed" &&
					r.status !== "cancelled" &&
					r.status !== "blocked",
			);
		return { timedOut, results };
	},
});

async function runSubagentInBackground(agentId: string, task: string): Promise<void> {
	const log = (event: string, payload?: Record<string, unknown>): void => {
		console.log(
			`[SUBAGENT ${agentId}] ${event}`,
			payload != null ? JSON.stringify(payload).slice(0, 400) : "",
		);
	};
	const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
	log("START", { task, hasApiKey: apiKey.length > 0 });
	if (apiKey.length === 0) {
		// No key — write a deterministic mock to the registry stream
		const reply = `[mock subagent ${agentId}] 已完成任务: ${task}`;
		for (const ch of reply) {
			agentRegistry.appendStream(agentId, ch);
			await new Promise<void>((r) => setTimeout(r, 30));
		}
		agentRegistry.updateStatus(agentId, "completed");
		log("MOCK_DONE");
		return;
	}
	const today = new Date().toISOString().slice(0, 10);
	try {
		const provider = createOpenAICompatible({
			name: "deepseek",
			baseURL: DEEPSEEK_BASE,
			apiKey,
		});
		// Force subagent calls onto deepseek-chat — reasoner would hang here.
		// Override agent-core's hanging `web_fetch` with the inline native-fetch
		// implementation so the subagent has a working HTTP primitive.
		const subagentTools = {
			...(await getToolsCatalog()).adapted,
			web_fetch: inlineWebFetchTool,
		};
		const result = streamText({
			model: provider("deepseek-chat"),
			system:
				`你是 Quilin 子代理 (subagent ${agentId})。今天是 ${today}。\n` +
				`任务: ${task}\n\n` +
				"原则:\n" +
				"- 用中文,完整、可读地把任务做完;不要停在『我先...』这种意图陈述上。\n" +
				"- 调工具是手段不是义务。任务需要外部事实或最新数据(版本号、发布日期、近期新闻、当前状态等)时调 web_fetch 等真实工具;不需要时直接基于你的知识答。\n" +
				"- 调了工具就把结果综合成答案,不要复制原始 JSON。引用事实时附 URL。",
			messages: [{ role: "user", content: task }],
			tools: subagentTools,
			stopWhen: stepCountIs(20),
			maxRetries: 1,
		});
		let textDeltaCount = 0;
		let toolCallCount = 0;
		for await (const event of result.fullStream) {
			const ev = event as { type: string } & Record<string, unknown>;
			if (ev.type === "text-delta") {
				const delta = (ev.text as string | undefined) ?? (ev.textDelta as string | undefined) ?? "";
				if (delta) {
					agentRegistry.appendStream(agentId, delta);
					textDeltaCount += 1;
				}
			} else if (ev.type === "tool-call") {
				toolCallCount += 1;
				log("TOOL_CALL", {
					name: String(ev.toolName ?? "tool"),
					input: ev.input ?? ev.args,
				});
				agentRegistry.recordToolEvent(agentId, {
					kind: "call",
					toolCallId: String(ev.toolCallId ?? ""),
					toolName: String(ev.toolName ?? "tool"),
					input: ev.input ?? ev.args,
				});
			} else if (ev.type === "tool-result") {
				const output = ev.output ?? ev.result;
				log("TOOL_RESULT", {
					name: String(ev.toolName ?? "tool"),
					outputPreview: JSON.stringify(output).slice(0, 200),
				});
				agentRegistry.recordToolEvent(agentId, {
					kind: "result",
					toolCallId: String(ev.toolCallId ?? ""),
					toolName: String(ev.toolName ?? "tool"),
					output,
				});
			} else if (ev.type === "tool-error") {
				log("TOOL_ERROR", {
					name: String(ev.toolName ?? "tool"),
					error: String(ev.error ?? ""),
				});
				agentRegistry.recordToolEvent(agentId, {
					kind: "error",
					toolCallId: String(ev.toolCallId ?? ""),
					toolName: String(ev.toolName ?? "tool"),
					error: String(ev.error ?? ""),
				});
			} else if (ev.type === "finish-step" || ev.type === "finish" || ev.type === "error") {
				log(`EVENT_${ev.type}`, {
					finishReason: ev.finishReason,
					error: ev.error == null ? undefined : String(ev.error),
				});
			}
		}
		log("STREAM_DRAINED", { textDeltaCount, toolCallCount });
		// Safety net: if no text-delta events fired (e.g., the SDK changed event
		// shapes), grab the final assembled text from result.text and append.
		try {
			const finalText = await result.text;
			if (textDeltaCount === 0 && finalText.length > 0) {
				log("FALLBACK_FINAL_TEXT", { length: finalText.length });
				agentRegistry.appendStream(agentId, finalText);
			}
			const finishReason = await result.finishReason;
			log("FINISH_REASON", { finishReason });
			if (toolCallCount === 0) {
				log("WARN_NO_TOOL_CALLS", {
					hint: "LLM 没调任何工具,可能在凭训练数据答 → 答案不可信",
				});
			}
		} catch (e) {
			log("RESULT_TEXT_ERROR", { error: String(e) });
		}
		// Best-effort token usage capture after the stream drains. The SDK
		// resolves `result.usage` once the provider finalizes token counts.
		try {
			const usage = (await result.usage) as
				| {
						readonly inputTokens?: number;
						readonly outputTokens?: number;
						readonly totalTokens?: number;
				  }
				| undefined;
			if (usage != null) {
				const inputTokens = usage.inputTokens ?? 0;
				const outputTokens = usage.outputTokens ?? 0;
				agentRegistry.recordUsage(agentId, {
					inputTokens,
					outputTokens,
					totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
				});
			}
		} catch {
			/* usage capture is non-essential; subagent still completes */
		}
		agentRegistry.updateStatus(agentId, "completed");
	} catch {
		agentRegistry.updateStatus(agentId, "failed");
	}
}

/**
 * Pull the first `text`-typed part out of a UIMessage.parts array.
 * Returns `null` when there's no text part (e.g., an attachment-only
 * message) or the parts array is empty/undefined. Kept narrow so the
 * route doesn't depend on the exact shape of AI SDK v6's
 * `UIMessagePart` union.
 *
 * 取 UIMessage.parts 中第一个 type="text" 的 text 字段;无 → null。
 */
function extractFirstTextPart(parts: readonly unknown[] | undefined): string | null {
	if (parts == null) return null;
	for (const p of parts) {
		if (typeof p !== "object" || p == null) continue;
		const obj = p as { readonly type?: unknown; readonly text?: unknown };
		if (obj.type === "text" && typeof obj.text === "string") return obj.text;
	}
	return null;
}

interface ChatRequestBody {
	readonly messages: readonly UIMessage[];
	/**
	 * AI SDK v6 `DefaultChatTransport` sends the `useChat({ id })` value as
	 * `id` in the body. We treat it as the chat session id and use it to
	 * scope subagent spawns so the AgentSwitcher only shows subagents
	 * belonging to the current conversation.
	 */
	readonly id?: string;
	/**
	 * Last-seen AgentService epoch from the client's sessionStorage (set
	 * by `ConversationView` after the first `/api/chat/status` probe).
	 * When this doesn't match the server's `currentEpoch()` the client's
	 * cursor is from a previous agent-core process and we force a fresh
	 * restart instead of replaying a stale event log.
	 */
	readonly clientEpoch?: string;
}

export async function POST(req: Request): Promise<Response> {
	let body: ChatRequestBody;
	try {
		body = (await req.json()) as ChatRequestBody;
	} catch {
		return new Response("invalid json", { status: 400 });
	}
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		return new Response("messages must be a non-empty array", { status: 400 });
	}

	const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
	if (apiKey.length === 0) {
		// Mock stream fallback so the demo doesn't die on missing key
		return mockStream(body.messages);
	}

	const provider = createOpenAICompatible({
		name: "deepseek",
		baseURL: DEEPSEEK_BASE,
		apiKey,
	});

	const modelMessages = await convertToModelMessages(body.messages);

	// Reasoner mode: no tools, but emits reasoning_content → reasoning UI part.
	// Reasoner runs straight through `toUIMessageStreamResponse` without
	// AgentService plumbing — the reasoner flow is short-lived and not
	// reconnect-resumable in the current product.
	if (IS_REASONER) {
		const result = streamText({
			model: provider(DEEPSEEK_MODEL),
			system: SYSTEM_PROMPT_BASE,
			messages: modelMessages,
		});
		return result.toUIMessageStreamResponse({ sendReasoning: true });
	}

	const sessionId = typeof body.id === "string" && body.id.length > 0 ? body.id : "main";
	const messagesHash = hashMessages(body.messages);
	const service = await getAgentService();
	const serverEpoch = service.currentEpoch();

	// Strict-epoch handshake: if the client's cached epoch is set but
	// doesn't match the server's current epoch, the client's view of any
	// in-flight session is stale (agent-core restarted). Evict whatever
	// is there and force fresh; the X-Quilin-Epoch response header will
	// re-sync the client.
	const epochMismatch =
		typeof body.clientEpoch === "string" &&
		body.clientEpoch.length > 0 &&
		body.clientEpoch !== serverEpoch;
	if (epochMismatch) {
		evictSession(sessionId, service, "client epoch mismatch (cross-process)");
	}

	// Decide reconnect vs fresh start. Reconnect criteria (must satisfy
	// ALL):
	//   - Web meta exists with the same `hash` (same user input)
	//   - AgentService still has a session for this id (not evicted by
	//     either web meta cap or AgentService maxSessions cap)
	//   - That session's status is "running" OR its event log is
	//     non-empty (completed but still buffered → still replayable)
	let meta = getMeta(sessionId);
	const existingSession = service.getSession(sessionId);
	const eventCount = existingSession == null ? 0 : service.getEventCount(sessionId);
	const isReconnect =
		!epochMismatch &&
		meta != null &&
		meta.hash === messagesHash &&
		existingSession != null &&
		(existingSession.status === "running" || eventCount > 0);

	if (!isReconnect) {
		// Either no existing session for this id, or the question
		// changed. If something is here, evict it cleanly so the prior
		// runner stops writing into a session we're about to recycle.
		if (meta != null || existingSession != null) {
			evictSession(sessionId, service, "user input changed");
		}
		// Derive a UX-friendly title from the first user message.
		const firstUser = body.messages.find((m) => m.role === "user");
		const titleSource = extractFirstTextPart(firstUser?.parts);
		const title =
			titleSource != null && titleSource.length > 0
				? titleSource.slice(0, 80)
				: "(new conversation)";
		// Capture EventBus seq BEFORE createSession so the subscriber
		// can filter out leftover events from a prior session that
		// shared this sessionId. The events linger in the ring buffer
		// after `deleteSession` (which only drops the registry entry,
		// not the event log); subscribe(afterSeq: startSeq - 1) skips
		// those legacy events.
		const startSeq = service.currentSeq();
		// Pass the user-supplied sessionId verbatim. AgentService's
		// `createSession` accepts an explicit `id` since the Phase 3
		// agent-core extension; collision-check still applies (we
		// evicted above so the slot is free).
		service.createSession({ origin: "web", title, id: sessionId });
		meta = setMeta(sessionId, messagesHash, service, startSeq);
		// Mark running and emit `turn.started` to bracket the new turn
		// for SSE consumers.
		service.setSessionStatus(sessionId, "running");
		const firstUserText = titleSource != null && titleSource.length > 0 ? titleSource : "";
		service.emitFromRunner(
			sessionId,
			{ type: "turn.started", turnIndex: 1, userText: firstUserText },
			{ touchActivity: true },
		);
		// Fire-and-forget background runner. `setImmediate` detaches
		// the runner from the request task scope so a client disconnect
		// cannot abort it; the AbortController on `meta` is the only
		// way to cancel.
		const metaRef = meta;
		setImmediate(() => {
			void runChatInBackground(service, sessionId, modelMessages, metaRef.abort).catch((e) => {
				console.log(`[CHAT ${sessionId}] runner crashed: ${String(e)}`);
				try {
					service.emitFromRunner(
						sessionId,
						{ type: "session.failed", error: String(e) },
						{ touchActivity: true },
					);
					service.setSessionStatus(sessionId, "failed");
				} catch {
					/* session may already be evicted */
				}
			});
		});
	} else if (meta != null) {
		touchMeta(sessionId);
		console.log(`[CHAT ${sessionId}] reconnect: replaying ${eventCount} events from AgentService`);
	}

	// At this point we either reconnected (meta is set, session is in
	// AgentService, runner is alive in background) or freshly started
	// (meta + AgentService session created, runner kicked off).
	// Pass `startSeq` so the subscriber only sees events emitted at or
	// after the session was (re)created — eliminates the
	// evict+recreate-same-id replay bug where the new subscriber would
	// see the old session's history before the new runner's output.
	const subscribeAfterSeq = (meta?.startSeq ?? 0) - 1;
	return new Response(buildSubscriberStream(service, sessionId, serverEpoch, subscribeAfterSeq), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-vercel-ai-ui-message-stream": "v1",
			// Strict-epoch handshake: server's current epoch is also
			// surfaced as a response header so non-`useChat`
			// consumers (TUI / admin probe / direct curl) can read
			// it without having to call `/api/chat/status`
			// separately. The browser `useChat` reads epoch via
			// `/api/chat/status` because `DefaultChatTransport`
			// doesn't expose response headers; the header here is
			// belt-and-suspenders / debug aid.
			"x-quilin-epoch": serverEpoch,
		},
	});
}

/**
 * Background LLM runner. Drives `streamText` and translates its
 * `fullStream` into structured `AgentEventPayload` events through
 * `pumpFullStreamIntoAgentService`. The runner outlives the HTTP
 * request via `setImmediate` detach; only `meta.abort.abort()` (via
 * the chat route's reconnect-restart path or the LRU eviction) stops
 * it.
 *
 * On normal completion: emits `session.completed` + flips status to
 * `completed`. On failure (caught exception) or user-driven cancel
 * (AbortError from `meta.abort`): emits `session.failed` + flips
 * status to `failed`. The chat route's POST `setImmediate` catch
 * block is the last-resort safety net for synchronous throws inside
 * this function before the try/catch establishes.
 *
 * 后台 LLM runner:fullStream → AgentEventPayload(经 sse-translator),
 * 整个 turn 结束 emit session.completed + setSessionStatus completed。
 * AbortController 触发会 fullStream throw,被 catch 后转 session.failed。
 */
async function runChatInBackground(
	service: AgentServiceLike,
	sessionId: string,
	modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>,
	abort: AbortController,
): Promise<void> {
	console.log(`[CHAT ${sessionId}] runner START`);
	const provider = createOpenAICompatible({
		name: "deepseek",
		baseURL: DEEPSEEK_BASE,
		apiKey: process.env.DEEPSEEK_API_KEY ?? "",
	});
	const spawnSubagentTool = makeSpawnSubagentTool(sessionId);
	const builtinTools = (await getToolsCatalog()).adapted;
	const result = streamText({
		model: provider(DEEPSEEK_MODEL),
		system: SYSTEM_PROMPT_WITH_TOOLS,
		messages: modelMessages,
		tools: {
			...builtinTools,
			web_fetch: inlineWebFetchTool,
			spawn_subagent: spawnSubagentTool,
			wait_for_subagents: waitForSubagentsTool,
		},
		stopWhen: stepCountIs(15),
		abortSignal: abort.signal,
	});

	try {
		const summary = await pumpFullStreamIntoAgentService(result.fullStream, service, sessionId, 1);
		console.log(
			`[CHAT ${sessionId}] runner COMPLETE (text=${summary.textDeltaCount} tools=${summary.toolCallCount} steps=${summary.stepCount} reason=${summary.finishReason ?? "(none)"})`,
		);
		// Final session.completed (after turn.completed already emitted
		// by the pump on `finish`).
		service.emitFromRunner(sessionId, { type: "session.completed" }, { touchActivity: true });
		service.setSessionStatus(sessionId, "completed");
	} catch (e) {
		// AbortError vs unexpected error: both flow through here. We
		// emit session.failed either way so subscribers see a clean
		// termination — the SSE writer follows up with SSE_DONE_FRAME.
		const message = e instanceof Error ? e.message : String(e);
		console.log(`[CHAT ${sessionId}] runner caught: ${message}`);
		// Session may have been evicted concurrently (reconnect-restart
		// path). Guard each AgentService call against that race.
		if (service.getSession(sessionId) != null) {
			try {
				service.emitFromRunner(
					sessionId,
					{ type: "session.failed", error: message },
					{ touchActivity: true },
				);
				service.setSessionStatus(sessionId, "failed");
			} catch {
				/* eviction race — best-effort */
			}
		}
	}
}

/**
 * Subscribe to the AgentService event stream for `sessionId` and
 * translate each AgentEvent into the AI SDK v6 UIMessage SSE chunk
 * format `useChat` expects. Client disconnect (ReadableStream
 * cancellation) closes the subscription but leaves the runner alive
 * — the next reconnect picks up from the same session via replay.
 *
 * `serverEpoch` is passed to `subscribe` as `expectedEpoch` so that
 * if the AgentService instance somehow swapped out between the route
 * handler computing `serverEpoch` and the subscribe call (impossible
 * in practice; defensive), the subscription fails cleanly.
 *
 * 订阅 AgentService 事件流,翻译成 AI SDK v6 SSE chunk。client disconnect
 * 只关订阅,runner 继续。expectedEpoch 防御性校验。
 */
function buildSubscriberStream(
	service: AgentServiceLike,
	sessionId: string,
	serverEpoch: string,
	afterSeq: number,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const sub = service.subscribe({
				sessionId,
				afterSeq,
				expectedEpoch: serverEpoch,
			});
			if (sub.info.epochMismatch) {
				// Should never happen because we just read serverEpoch
				// from the same service instance — but if it does, send
				// a minimal error frame and terminate.
				try {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "error", error: "agent-core epoch mismatch" })}\n\n`,
						),
					);
					controller.enqueue(encoder.encode(SSE_DONE_FRAME));
				} catch {
					/* already closed */
				}
				sub.close();
				controller.close();
				return;
			}
			let terminated = false;
			try {
				for await (const event of sub) {
					const chunk = agentEventToSseChunk(event);
					if (chunk != null) {
						try {
							controller.enqueue(encoder.encode(chunk));
						} catch {
							// Controller closed (client disconnected) —
							// stop the subscriber but keep the runner
							// alive. The session stays in AgentService
							// for the next reconnect.
							sub.close();
							terminated = true;
							break;
						}
					}
					// On terminal events we append `[DONE]` and exit. The
					// AgentService subscription itself stays open until
					// drained, but the SSE wire format demands `[DONE]`
					// at the end of every response. `useChat` will close
					// its EventSource on receiving it.
					if (
						event.payload.type === "session.completed" ||
						event.payload.type === "session.failed"
					) {
						try {
							controller.enqueue(encoder.encode(SSE_DONE_FRAME));
						} catch {
							/* already closed */
						}
						terminated = true;
						sub.close();
						break;
					}
				}
				if (!terminated) {
					// Subscription ended without a terminal event (e.g.,
					// session was evicted out from under us). Send DONE
					// anyway so the client doesn't hang.
					try {
						controller.enqueue(encoder.encode(SSE_DONE_FRAME));
					} catch {
						/* already closed */
					}
				}
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			} catch (e) {
				try {
					controller.error(e);
				} catch {
					/* already closed */
				}
			}
		},
	});
}

/**
 * Deterministic mock stream used when DEEPSEEK_API_KEY is missing.
 * Streams ~1 character per 60ms so the UI shows real typing animation.
 */
function mockStream(messages: readonly UIMessage[]): Response {
	const last = messages[messages.length - 1];
	let userText = "(empty)";
	if (last?.parts != null) {
		const textParts = last.parts.filter(
			(p: { type: string }): p is { type: "text"; text: string } => p.type === "text",
		);
		userText = textParts.map((p) => p.text).join(" ") || "(empty)";
	}
	const reply = `[mock 模式,未配置 DEEPSEEK_API_KEY] 收到你的问题: "${userText.slice(0, 200)}"。这是来自 Quilin 麒麟 的占位回复,演示流式渲染。配置 .env 里的 DEEPSEEK_API_KEY 即可接通真实模型。`;

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const messageId = `msg-${Date.now().toString(36)}`;
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start-step" })}\n\n`));
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: "text-start", id: messageId })}\n\n`),
			);
			for (const ch of reply) {
				await new Promise<void>((r) => setTimeout(r, 50));
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: "text-delta", id: messageId, delta: ch })}\n\n`,
					),
				);
			}
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: "text-end", id: messageId })}\n\n`),
			);
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish-step" })}\n\n`));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish" })}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-vercel-ai-ui-message-stream": "v1",
		},
	});
}
