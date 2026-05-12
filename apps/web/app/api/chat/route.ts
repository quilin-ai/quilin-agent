/**
 * Quilin Agent · Direct chat endpoint backed by AI SDK v6.
 *
 * Local-only (Next.js runs on 127.0.0.1). Uses DeepSeek via the OpenAI-compatible
 * adapter — matches agent-core's primary LLM for the v0.3.x demo. Falls back to a
 * deterministic mock stream when no API key is configured so the UI flow can be
 * demoed even without network.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

const SYSTEM_PROMPT =
	"你是麒麟 (Quilin),一个自演化的 AI Agent。" +
	"用中文与用户对话,语气专业、精炼、有条理。回答里可以用 markdown,但避免过度装饰。";

interface ChatRequestBody {
	readonly messages: readonly UIMessage[];
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
	const result = streamText({
		model: provider(DEEPSEEK_MODEL),
		system: SYSTEM_PROMPT,
		messages: modelMessages,
	});
	return result.toUIMessageStreamResponse();
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
			// AI SDK v6 UI message stream format
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`),
			);
			controller.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({ type: "start-step" })}\n\n`,
				),
			);
			controller.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({ type: "text-start", id: messageId })}\n\n`,
				),
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
				encoder.encode(
					`data: ${JSON.stringify({ type: "text-end", id: messageId })}\n\n`,
				),
			);
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: "finish-step" })}\n\n`),
			);
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: "finish" })}\n\n`),
			);
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
