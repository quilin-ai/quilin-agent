/**
 * POST /api/agents/spawn — demo subagent spawn endpoint.
 *
 * Registers a new `subagent-<hex>` record in the in-memory registry and starts an
 * AI SDK v6 streamText call with DeepSeek. Returns the UI message stream directly
 * for the AgentSwitcher to render live. Mock fallback when no API key.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { z } from "zod";

import { deriveAgentDisplayName } from "@/lib/agent-display-name";
import { agentRegistry, shortId } from "@/lib/agent-registry";
import { getAgentService } from "@/lib/agent-service-client";
import { rewriteUserIntentText } from "@/lib/user-intent-rewrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

const BodySchema = z.object({
	task: z.string().min(1).max(2000),
	parentId: z.string().min(1).max(64).optional(),
});

export async function POST(req: Request): Promise<Response> {
	let parsed: z.infer<typeof BodySchema>;
	try {
		const json = (await req.json()) as unknown;
		const result = BodySchema.safeParse(json);
		if (!result.success) {
			return Response.json(
				{ ok: false, error: { code: "validation_error", issues: result.error.issues } },
				{ status: 400 },
			);
		}
		parsed = result.data;
	} catch (e) {
		return Response.json(
			{ ok: false, error: { code: "invalid_json", message: String(e) } },
			{ status: 400 },
		);
	}

	const agentId = `subagent-${shortId()}`;
	const taskRewrite = rewriteUserIntentText(parsed.task);
	const effectiveTask = taskRewrite.normalizedText;
	const displayName = deriveAgentDisplayName(effectiveTask);
	agentRegistry.register({
		id: agentId,
		kind: "subagent",
		parentId: parsed.parentId ?? "main",
		displayName,
		task: effectiveTask,
		status: "running",
	});
	// Task #30 (minimal slice): shadow-register the subagent in the
	// shared AgentService so the TUI's `/sessions` list and the admin
	// probe can see it. The legacy `agent-registry` still owns the
	// streamed text + tool events for `/api/agents` consumers; future
	// slices will collapse both into AgentService events. Failure to
	// register here must not block the spawn — `agent-registry` is the
	// source of truth for the demo UX.
	//
	// Task #30 最小切片:把子代理影子注册到共享 AgentService,让 TUI 与
	// admin probe 可见。当前 `/api/agents` 仍用 agent-registry,后续切片
	// 再统一。注册失败不阻塞 spawn。
	void getAgentService()
		.then((svc) => {
			try {
				svc.createSession({
					origin: "api",
					id: agentId,
					title: displayName,
					// `parsed.parentId` is already `string | undefined`
					// (Zod `.optional()`) — no `?? undefined` shim. Distinct
					// from line 50's agent-registry default of "main":
					// AgentService doesn't mirror a synthetic "main" parent,
					// so absent parentId = "no parent" (the subagent appears
					// at the top level until the parent chat session is also
					// AgentService-tracked in a future slice).
					parentId: parsed.parentId,
					task: effectiveTask,
				});
			} catch {
				/* session id collision — already registered by a concurrent call; safe to ignore */
			}
		})
		.catch(() => {
			/* AgentService not available — degrade gracefully, agent-registry is authoritative */
		});

	const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
	if (apiKey.length === 0) {
		return mockStream(agentId, effectiveTask);
	}

	try {
		const provider = createOpenAICompatible({
			name: "deepseek",
			baseURL: DEEPSEEK_BASE,
			apiKey,
		});
		const result = streamText({
			model: provider(DEEPSEEK_MODEL),
			system: `你是 Quilin 派遣的子代理「${displayName}」(id: ${agentId})。任务: ${effectiveTask}。如果任务里有明显中文同音/输入法错误,先按自然语义纠正后再搜索。完成后简要汇报结果给主代理,语气专业精炼。`,
			messages: [{ role: "user", content: effectiveTask }],
			maxRetries: 0,
		});
		// Mirror textStream into registry (background, doesn't block response)
		void (async () => {
			try {
				for await (const delta of result.textStream) {
					agentRegistry.appendStream(agentId, delta);
				}
				agentRegistry.updateStatus(agentId, "completed");
			} catch {
				agentRegistry.updateStatus(agentId, "failed");
			}
		})();
		const response = result.toUIMessageStreamResponse();
		response.headers.set("x-agent-id", agentId);
		response.headers.set("x-agent-display-name", encodeURIComponent(displayName));
		response.headers.set("x-stream-mode", "deepseek");
		return response;
	} catch (error) {
		agentRegistry.updateStatus(agentId, "failed");
		return Response.json(
			{ ok: false, error: { code: "spawn_failed", message: String(error) } },
			{ status: 500 },
		);
	}
}

function mockStream(agentId: string, task: string): Response {
	const displayName = deriveAgentDisplayName(task);
	const text = `[mock subagent ${displayName}] 已完成任务: ${task}`;
	const encoder = new TextEncoder();
	const messageId = `msg-${shortId()}`;
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (obj: unknown) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
			};
			emit({ type: "start" });
			emit({ type: "start-step" });
			emit({ type: "text-start", id: messageId });
			for (const ch of text) {
				agentRegistry.appendStream(agentId, ch);
				emit({ type: "text-delta", id: messageId, delta: ch });
				await sleep(50);
			}
			emit({ type: "text-end", id: messageId });
			emit({ type: "finish-step" });
			emit({ type: "finish" });
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			agentRegistry.updateStatus(agentId, "completed");
			controller.close();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store, no-transform",
			"x-agent-id": agentId,
			"x-agent-display-name": encodeURIComponent(displayName),
			"x-stream-mode": "mock",
			"x-vercel-ai-ui-message-stream": "v1",
		},
	});
}
