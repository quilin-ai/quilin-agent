import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "./web-fetch.js";

function createResolver(
	records: Record<string, readonly string[]>,
) {
	return vi.fn(async (hostname: string) => records[hostname] ?? ["93.184.216.34"]);
}

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
		expect(fetcher).toHaveBeenCalledWith(
			"https://example.com/data",
			expect.objectContaining({
				method: "POST",
				body: "ping",
				headers: { "x-test": "1" },
				redirect: "manual",
				signal: expect.any(AbortSignal),
			}),
		);
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

	it("blocks IMDS, loopback, and RFC1918 targets before fetching", async () => {
		const fetcher = vi.fn();
		const resolver = createResolver({
			"169.254.169.254": ["169.254.169.254"],
			"127.0.0.1": ["127.0.0.1"],
			"10.0.0.1": ["10.0.0.1"],
		});
		const tool = createWebFetchTool({ fetcher, resolver });

		for (const url of [
			"http://169.254.169.254/latest/meta-data/",
			"http://127.0.0.1:3000/health",
			"http://10.0.0.1/internal",
		]) {
			const result = await tool.execute({ url });
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content)).toEqual({
				error: expect.stringContaining("not allowed"),
			});
		}

		expect(fetcher).not.toHaveBeenCalled();
	});

	it("re-validates redirects and blocks redirects into private targets", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: {
						location: "http://169.254.169.254/latest/meta-data/",
					},
				}),
			);
		const resolver = createResolver({
			"safe.example": ["93.184.216.34"],
			"169.254.169.254": ["169.254.169.254"],
		});
		const tool = createWebFetchTool({ fetcher, resolver });

		const result = await tool.execute({
			url: "https://safe.example/start",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("not allowed"),
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("uses timeout and manual redirect handling for each fetch hop", async () => {
		const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(init?.redirect).toBe("manual");
			expect(init?.signal).toBeInstanceOf(AbortSignal);

			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(init.signal?.reason ?? new Error("aborted"));
				});
			});
		});
		const resolver = createResolver({
			"slow.example": ["93.184.216.34"],
		});
		const tool = createWebFetchTool({
			fetcher,
			resolver,
			timeoutMs: 10,
		});

		const result = await tool.execute({
			url: "https://slow.example/data",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringMatching(/timed out|aborted|timeout/i),
		});
	});
});
