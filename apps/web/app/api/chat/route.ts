/**
 * Quilin Agent · Chat endpoint backed by AI SDK v6 + agent-core builtin tools.
 *
 * Slice 2 of the unified TUI+Web backend rollout. The LLM call still uses
 * `streamText` (so the browser `useChat` UIMessage SSE protocol keeps
 * working), but the tool set is now drawn from `@quilin/agent-core`'s
 * `createBuiltinTools()` — file_read / file_write / file_list / shell_exec /
 * web_fetch / image_describe / etc. — instead of the four hard-coded inline
 * tools that previously shipped here.
 *
 * 上游模型 (deepseek-chat default; reasoner mode skips tools) and the
 * subagent fire-and-forget runner are unchanged from the demo.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { agentRegistry, shortId } from "@/lib/agent-registry";
import {
	appendFrame,
	type ChatSession,
	getSession,
	hashMessages,
	markSessionComplete,
	startSession,
	subscribeSession,
} from "@/lib/chat-session-store";
import { getToolsCatalog } from "@/lib/tools-loader";

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

interface ChatRequestBody {
	readonly messages: readonly UIMessage[];
	/**
	 * AI SDK v6 `DefaultChatTransport` sends the `useChat({ id })` value as
	 * `id` in the body. We treat it as the chat session id and use it to
	 * scope subagent spawns so the AgentSwitcher only shows subagents
	 * belonging to the current conversation.
	 */
	readonly id?: string;
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

	// Reasoner mode: no tools, but emits reasoning_content → reasoning UI part
	if (IS_REASONER) {
		const result = streamText({
			model: provider(DEEPSEEK_MODEL),
			system: SYSTEM_PROMPT_BASE,
			messages: modelMessages,
		});
		return result.toUIMessageStreamResponse({ sendReasoning: true });
	}

	// Build a session-scoped spawn tool so the subagents registered by this
	// chat session are filterable in the AgentSwitcher (`?parent=<sessionId>`).
	const sessionId = typeof body.id === "string" && body.id.length > 0 ? body.id : "main";
	const messagesHash = hashMessages(body.messages);

	// Slice 3: decouple the LLM runner from the HTTP response so navigating
	// away mid-stream doesn't kill the run. Strategy:
	//   1. Look up the chat-session-store for an inflight session matching
	//      (sessionId, messagesHash). If found, this POST is a reconnect —
	//      attach a fresh subscriber that replays buffered frames + lives.
	//   2. Otherwise it's a new question: spin up a background runner that
	//      writes to the session store, then subscribe to it for this
	//      response. The runner outlives the HTTP request.
	let session = getSession(sessionId);
	const isReconnect =
		session != null &&
		session.startedFromHash === messagesHash &&
		(session.status === "running" || session.frames.length > 0);

	if (!isReconnect) {
		session = startSession(sessionId, messagesHash);
		// Fire-and-forget background runner. Errors are caught + logged so a
		// runner failure marks the session "failed" without crashing the
		// Next.js worker. Use `setImmediate` to detach from the request's
		// task scope — otherwise Next.js / Node may abort the runner when
		// the request's underlying response stream cancels.
		const sessionRef = session;
		setImmediate(() => {
			void runChatInBackground(sessionRef, modelMessages, sessionId).catch((e) => {
				console.log(`[CHAT bg ${sessionId}] runner crashed: ${String(e)}`);
				markSessionComplete(sessionRef, "failed");
			});
		});
	} else {
		console.log(
			`[CHAT bg ${sessionId}] reconnect: replaying ${session?.frames.length ?? 0} frames`,
		);
	}

	return new Response(buildSubscriberStream(session as ChatSession), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-vercel-ai-ui-message-stream": "v1",
		},
	});
}

/**
 * Background LLM runner. Writes every UIMessage SSE chunk into the session
 * buffer so disconnected and reconnecting clients can replay. Marks the
 * session complete (or failed) when streamText drains.
 *
 * 后台 LLM runner:把 UIMessage SSE chunk 写进 session buffer,断线/重连客户端
 * 可以 replay。stream 结束后 markSessionComplete。
 */
async function runChatInBackground(
	session: ChatSession,
	modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>,
	sessionId: string,
): Promise<void> {
	console.log(`[CHAT bg ${sessionId}] runner START`);
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
	});

	// Pump the UIMessage stream into our session buffer instead of straight
	// to an HTTP response. The browser subscriber reads from the buffer.
	const upstream = result.toUIMessageStreamResponse().body;
	if (upstream == null) {
		markSessionComplete(session, "complete");
		return;
	}
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	let leftover = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			leftover += decoder.decode(value, { stream: true });
			// SSE frames are separated by blank lines; split on `\n\n`.
			while (true) {
				const idx = leftover.indexOf("\n\n");
				if (idx < 0) break;
				const frame = leftover.slice(0, idx);
				leftover = leftover.slice(idx + 2);
				for (const line of frame.split("\n")) {
					const trimmed = line.trim();
					if (trimmed.startsWith("data:")) {
						const data = trimmed.slice(5).trim();
						if (data.length > 0) appendFrame(session, data);
					}
				}
			}
		}
		console.log(`[CHAT bg ${sessionId}] runner COMPLETE (${session.frames.length} frames)`);
		markSessionComplete(session, "complete");
	} catch (e) {
		console.log(`[CHAT bg ${sessionId}] stream error: ${String(e)}`);
		markSessionComplete(session, "failed");
	} finally {
		reader.releaseLock();
	}
}

/**
 * Build a ReadableStream that subscribes to the session's frame buffer
 * and emits each frame as a UIMessage SSE line. Client disconnect (e.g.,
 * `request.signal` aborts) cancels the subscriber but leaves the session
 * + runner alive in the store.
 */
function buildSubscriberStream(session: ChatSession): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const sub = subscribeSession(session, 0);
			try {
				for await (const frame of sub) {
					try {
						controller.enqueue(encoder.encode(`data: ${frame.data}\n\n`));
					} catch {
						// Controller closed (client disconnected) — stop reading.
						sub.close();
						break;
					}
				}
				try {
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				} catch {
					/* already closed */
				}
				controller.close();
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
