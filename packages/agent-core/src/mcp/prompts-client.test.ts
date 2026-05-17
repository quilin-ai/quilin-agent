import { describe, expect, it, vi } from "vitest";
import {
	createPromptsClient,
	PROMPTS_DEFAULT_TIMEOUT_MS,
	PromptsClient,
	type PromptsClientLike,
	PromptsTimeoutError,
} from "./prompts-client.js";

function makeStub(
	overrides: Partial<PromptsClientLike> = {},
): PromptsClientLike {
	return {
		listPrompts: vi.fn(async () => ({ prompts: [] })),
		getPrompt: vi.fn(async () => ({ messages: [] })),
		...overrides,
	};
}

describe("PromptsClient.listPrompts", () => {
	it("normalizes prompts and surfaces nextCursor when present", async () => {
		const stub = makeStub({
			listPrompts: vi.fn(async () => ({
				prompts: [
					{
						name: "summarize",
						title: "Summarize",
						description: "Summarize text",
						arguments: [
							{ name: "text", description: "input", required: true },
							{ name: "tone" },
						],
					},
					{
						name: "translate",
					},
				],
				nextCursor: "next-1",
			})),
		});

		const client = new PromptsClient(stub);
		const result = await client.listPrompts();

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value.prompts).toHaveLength(2);
		expect(result.value.prompts[0]).toEqual({
			name: "summarize",
			title: "Summarize",
			description: "Summarize text",
			arguments: [
				{ name: "text", description: "input", required: true },
				{ name: "tone", required: false },
			],
		});
		expect(result.value.prompts[1]).toEqual({
			name: "translate",
			arguments: [],
		});
		expect(result.value.nextCursor).toBe("next-1");
	});

	it("omits nextCursor when server does not return one", async () => {
		const client = new PromptsClient(makeStub());
		const result = await client.listPrompts();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value).not.toHaveProperty("nextCursor");
	});

	it("forwards cursor param to underlying client", async () => {
		const listPrompts = vi.fn(async () => ({ prompts: [] }));
		const client = new PromptsClient(makeStub({ listPrompts }));
		await client.listPrompts({ cursor: "page-2" });
		expect(listPrompts).toHaveBeenCalledWith(
			{ cursor: "page-2" },
			{ timeout: PROMPTS_DEFAULT_TIMEOUT_MS },
		);
	});

	it("returns error result instead of throwing when underlying call rejects", async () => {
		const client = new PromptsClient(
			makeStub({
				listPrompts: vi.fn(async () => {
					throw new Error("network down");
				}),
			}),
		);
		const result = await client.listPrompts();
		expect(result).toEqual({ ok: false, error: "network down" });
	});

	it("short-circuits when isConnected guard reports false", async () => {
		const listPrompts = vi.fn(async () => ({ prompts: [] }));
		const client = new PromptsClient(makeStub({ listPrompts }), {
			isConnected: () => false,
		});
		const result = await client.listPrompts();
		expect(result).toEqual({ ok: false, error: "MCP client is not connected" });
		expect(listPrompts).not.toHaveBeenCalled();
	});

	it("times out after configured timeoutMs and emits PromptsTimeoutError message", async () => {
		const stub = makeStub({
			listPrompts: () => new Promise(() => {}),
		});
		const client = new PromptsClient(stub, { timeoutMs: 10 });
		const result = await client.listPrompts();
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("prompts/list timed out after 10ms");
		// Sanity: the typed error class is exported and reusable
		expect(new PromptsTimeoutError("x", 1).name).toBe("PromptsTimeoutError");
	});

	it("converts non-Error rejections into a generic error string", async () => {
		const client = new PromptsClient(
			makeStub({
				listPrompts: vi.fn(async () => {
					throw "weird";
				}),
			}),
		);
		const result = await client.listPrompts();
		expect(result).toEqual({
			ok: false,
			error: "Unknown MCP prompts error",
		});
	});
});

describe("PromptsClient.getPrompt", () => {
	it("returns rendered prompt with description and text messages", async () => {
		const stub = makeStub({
			getPrompt: vi.fn(async () => ({
				description: "Greeting",
				messages: [
					{
						role: "user" as const,
						content: { type: "text" as const, text: "Hi" },
					},
					{
						role: "assistant" as const,
						content: { type: "text" as const, text: "Hello!" },
					},
				],
			})),
		});
		const client = new PromptsClient(stub);
		const result = await client.getPrompt("greet", { name: "Ada" });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value).toEqual({
			description: "Greeting",
			messages: [
				{ role: "user", text: "Hi" },
				{ role: "assistant", text: "Hello!" },
			],
		});
	});

	it("drops non-text content (image / audio / resource) silently", async () => {
		const stub = makeStub({
			getPrompt: vi.fn(async () => ({
				messages: [
					{
						role: "user" as const,
						content: {
							type: "image" as const,
							data: "xx",
							mimeType: "image/png",
						},
					},
					{
						role: "assistant" as const,
						content: { type: "text" as const, text: "after image" },
					},
				],
			})),
		});
		const client = new PromptsClient(stub);
		const result = await client.getPrompt("img");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.value.messages).toEqual([
			{ role: "assistant", text: "after image" },
		]);
	});

	it("rejects empty / whitespace-only prompt name", async () => {
		const getPrompt = vi.fn(async () => ({ messages: [] }));
		const client = new PromptsClient(makeStub({ getPrompt }));
		const result = await client.getPrompt("   ");
		expect(result).toEqual({
			ok: false,
			error: "Prompt name must not be empty",
		});
		expect(getPrompt).not.toHaveBeenCalled();
	});

	it("trims the prompt name before forwarding", async () => {
		const getPrompt = vi.fn(async () => ({ messages: [] }));
		const client = new PromptsClient(makeStub({ getPrompt }));
		await client.getPrompt("  summarize  ");
		expect(getPrompt).toHaveBeenCalledWith(
			{ name: "summarize" },
			{ timeout: PROMPTS_DEFAULT_TIMEOUT_MS },
		);
	});

	it("forwards arguments only when non-empty", async () => {
		const getPrompt = vi.fn(async () => ({ messages: [] }));
		const client = new PromptsClient(makeStub({ getPrompt }));
		await client.getPrompt("summarize", { text: "hi" });
		expect(getPrompt).toHaveBeenCalledWith(
			{ name: "summarize", arguments: { text: "hi" } },
			{ timeout: PROMPTS_DEFAULT_TIMEOUT_MS },
		);
	});

	it("returns error when not connected without invoking underlying client", async () => {
		const getPrompt = vi.fn(async () => ({ messages: [] }));
		const client = new PromptsClient(makeStub({ getPrompt }), {
			isConnected: () => false,
		});
		const result = await client.getPrompt("summarize");
		expect(result).toEqual({ ok: false, error: "MCP client is not connected" });
		expect(getPrompt).not.toHaveBeenCalled();
	});

	it("captures underlying rejections as error result", async () => {
		const client = new PromptsClient(
			makeStub({
				getPrompt: vi.fn(async () => {
					throw new Error("boom");
				}),
			}),
		);
		const result = await client.getPrompt("p");
		expect(result).toEqual({ ok: false, error: "boom" });
	});
});

describe("createPromptsClient factory", () => {
	it("wraps a SDK-shaped client and returns a PromptsClient instance", async () => {
		// Cast through unknown so the test does not pull in SDK types.
		const stub = makeStub();
		const client = createPromptsClient(stub as unknown as never);
		expect(client).toBeInstanceOf(PromptsClient);
		const result = await client.listPrompts();
		expect(result.ok).toBe(true);
	});
});
