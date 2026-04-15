import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "./web-fetch.js";

describe("builtin web_fetch tool", () => {
	it("rejects non-http protocols", async () => {
		const tool = createWebFetchTool();

		const result = await tool.execute({
			url: "file:///etc/passwd",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("http"),
		});
	});

	it("uses the injected fetcher and returns response metadata", async () => {
		const fetcher = vi.fn(async () =>
			new Response("hello world", {
				status: 200,
				headers: {
					"content-type": "text/plain",
				},
			}),
		);
		const tool = createWebFetchTool({ fetcher });

		const result = await tool.execute({
			url: "https://example.com/data",
			method: "POST",
			body: "ping",
			headers: { "x-test": "1" },
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledWith("https://example.com/data", {
			method: "POST",
			body: "ping",
			headers: { "x-test": "1" },
		});
		expect(JSON.parse(result.content)).toEqual({
			url: "https://example.com/data",
			status: 200,
			contentType: "text/plain",
			body: "hello world",
			truncated: false,
		});
	});

	it("marks HTTP errors and truncates oversized bodies", async () => {
		const errorFetcher = vi.fn(async () =>
			new Response("internal error", {
				status: 500,
				headers: {
					"content-type": "text/plain",
				},
			}),
		);
		const errorTool = createWebFetchTool({ fetcher: errorFetcher });

		const errorResult = await errorTool.execute({
			url: "https://example.com/fail",
		});

		expect(errorResult.isError).toBe(true);
		expect(JSON.parse(errorResult.content)).toEqual({
			error: "HTTP 500",
			status: 500,
			body: "internal error",
		});

		const truncatingFetcher = vi.fn(async () =>
			new Response("abcdefghijklmnopqrstuvwxyz", {
				status: 200,
				headers: {
					"content-type": "text/plain",
				},
			}),
		);
		const truncatingTool = createWebFetchTool({
			fetcher: truncatingFetcher,
			maxBodyChars: 10,
		});

		const truncated = await truncatingTool.execute({
			url: "https://example.com/large",
		});

		expect(truncated.isError).toBe(false);
		expect(JSON.parse(truncated.content)).toEqual({
			url: "https://example.com/large",
			status: 200,
			contentType: "text/plain",
			body: "abcdefg...",
			truncated: true,
		});
	});
});
