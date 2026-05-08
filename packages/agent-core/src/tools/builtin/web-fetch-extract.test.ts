import { describe, expect, it, vi } from "vitest";
import type { LLMClient, LLMResponse } from "../../llm/types.js";
import {
	buildExtractionUserMessage,
	createDefaultHtmlToMarkdown,
	extractWithLLM,
	resetTurndownCache,
} from "./web-fetch-extract.js";

function makeFakeClient(content = "extracted answer"): {
	client: LLMClient;
	chat: ReturnType<typeof vi.fn>;
} {
	const response: LLMResponse = {
		content,
		usage: { inputTokens: 1, outputTokens: 1 },
		finishReason: "stop",
	};
	const chat = vi.fn().mockResolvedValue(response);
	return {
		client: { chat: chat as unknown as LLMClient["chat"] },
		chat,
	};
}

describe("buildExtractionUserMessage", () => {
	it("includes the prompt and markdown verbatim when below the cap", () => {
		const message = buildExtractionUserMessage(
			"What is the price?",
			"# Title\n\nPrice: $42",
			1000,
		);

		expect(message).toContain("User prompt: What is the price?");
		expect(message).toContain("# Title");
		expect(message).toContain("Price: $42");
		expect(message).not.toContain("[Content truncated");
	});

	it("truncates markdown that exceeds the cap and signals the truncation", () => {
		const longMarkdown = "x".repeat(50);
		const message = buildExtractionUserMessage("p", longMarkdown, 10);

		expect(message).toContain("[Content truncated due to length...]");
		expect(message).toContain("xxxxxxxxxx");
		expect(message).not.toContain("xxxxxxxxxxxxxxxxxxxxx");
	});
});

describe("extractWithLLM", () => {
	it("invokes the llm client with the assembled user prompt", async () => {
		const { client, chat } = makeFakeClient("price is $42");

		const result = await extractWithLLM({
			llmClient: client,
			inferenceConfig: {
				temperature: 0,
				maxTokens: 256,
				thinkingMode: "disabled",
			},
			markdown: "Price: $42",
			prompt: "What is the price?",
		});

		expect(result).toBe("price is $42");
		expect(chat).toHaveBeenCalledTimes(1);
		const [messages, tools, config] = chat.mock.calls[0]!;
		expect(tools).toEqual([]);
		expect(config.maxTokens).toBe(256);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain("What is the price?");
		expect(messages[0].content).toContain("Price: $42");
	});

	it("respects a custom max markdown length", async () => {
		const { client, chat } = makeFakeClient();

		await extractWithLLM({
			llmClient: client,
			inferenceConfig: {
				temperature: 0,
				maxTokens: 100,
				thinkingMode: "disabled",
			},
			markdown: "y".repeat(20),
			prompt: "summarize",
			maxMarkdownLength: 5,
		});

		const [messages] = chat.mock.calls[0]!;
		expect(messages[0].content).toContain("[Content truncated");
	});
});

describe("createDefaultHtmlToMarkdown", () => {
	it("converts simple html to atx headings and fenced code", async () => {
		resetTurndownCache();
		const convert = createDefaultHtmlToMarkdown();

		const out = await convert(
			"<h1>Title</h1><p>Hello <strong>world</strong>.</p><pre><code>x = 1</code></pre>",
		);

		expect(out).toContain("# Title");
		expect(out).toContain("**world**");
		expect(out).toContain("```");
		expect(out).toContain("x = 1");
	});

	it("reuses the lazy turndown singleton across calls", async () => {
		resetTurndownCache();
		const convert = createDefaultHtmlToMarkdown();

		const a = await convert("<p>a</p>");
		const b = await convert("<p>b</p>");

		expect(a).toContain("a");
		expect(b).toContain("b");
	});
});
