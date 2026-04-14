import type { LanguageModelV1 } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingLLMClient, VercelLLMClient } from "./client.js";

vi.mock("ai", () => ({
	generateText: vi.fn(),
	streamText: vi.fn(),
}));

describe("VercelLLMClient", () => {
	const model = {} as LanguageModelV1;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("maps messages and usage through generateText", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "hello from model",
			usage: {
				promptTokens: 12,
				completionTokens: 34,
			},
			finishReason: "stop",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		const result = await client.chat(
			[
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			[],
			{
				temperature: 0.7,
				maxTokens: 512,
				thinkingMode: "disabled",
				topP: 0.9,
			},
		);

		expect(generateText).toHaveBeenCalledWith({
			model: expect.objectContaining({
				specificationVersion: "v2",
				doGenerate: expect.any(Function),
				doStream: expect.any(Function),
			}),
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			maxTokens: 512,
			temperature: 0.7,
			topP: 0.9,
		});
		expect(result).toEqual({
			content: "hello from model",
			usage: {
				inputTokens: 12,
				outputTokens: 34,
			},
			finishReason: "stop",
		});
	});

	it("maps non-stop finish reasons to length", async () => {
		vi.mocked(generateText).mockResolvedValue({
			text: "truncated",
			usage: {
				promptTokens: 1,
				completionTokens: 2,
			},
			finishReason: "length",
		} as Awaited<ReturnType<typeof generateText>>);

		const client = new VercelLLMClient(model);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.7,
			maxTokens: 128,
			thinkingMode: "disabled",
		});

		expect(result.finishReason).toBe("length");
	});
});

describe("StreamingLLMClient", () => {
	const model = {} as LanguageModelV1;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("streams chunks and returns the accumulated response", async () => {
		const chunks = ["hel", "lo"];
		const onChunk = vi.fn();

		vi.mocked(streamText).mockReturnValue({
			textStream: (async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			})(),
			usage: Promise.resolve({
				promptTokens: 5,
				completionTokens: 7,
			}),
			finishReason: Promise.resolve("stop"),
		} as ReturnType<typeof streamText>);

		const client = new StreamingLLMClient(model, onChunk);

		const result = await client.chat([{ role: "user", content: "hi" }], [], {
			temperature: 0.2,
			maxTokens: 64,
			thinkingMode: "disabled",
		});

		expect(streamText).toHaveBeenCalledWith({
			model: expect.objectContaining({
				specificationVersion: "v2",
				doGenerate: expect.any(Function),
				doStream: expect.any(Function),
			}),
			messages: [{ role: "user", content: "hi" }],
			maxTokens: 64,
			temperature: 0.2,
			topP: undefined,
		});
		expect(onChunk).toHaveBeenCalledTimes(2);
		expect(onChunk).toHaveBeenNthCalledWith(1, "hel");
		expect(onChunk).toHaveBeenNthCalledWith(2, "lo");
		expect(result).toEqual({
			content: "hello",
			usage: {
				inputTokens: 5,
				outputTokens: 7,
			},
			finishReason: "stop",
		});
	});
});
