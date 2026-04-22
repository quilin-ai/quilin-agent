import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "./web-fetch.js";

function createResolver(records: Record<string, readonly string[]>) {
	return vi.fn(
		async (hostname: string) => records[hostname] ?? ["93.184.216.34"],
	);
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
		const fetcher = vi.fn(
			async () =>
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
		const errorFetcher = vi.fn(
			async () =>
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

		const truncatingFetcher = vi.fn(
			async () =>
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

	it("rejects numeric IP literals and IPv4-mapped private ranges", async () => {
		const fetcher = vi.fn();
		const tool = createWebFetchTool({ fetcher });

		for (const url of [
			"http://2130706433/",
			"http://0x7f000001/",
			"http://0/",
			"http://[::ffff:10.0.0.1]/",
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
		const fetcher = vi.fn().mockResolvedValueOnce(
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
		const fetcher = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(init?.redirect).toBe("manual");
				expect(init?.signal).toBeInstanceOf(AbortSignal);

				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(init.signal?.reason ?? new Error("aborted"));
					});
				});
			},
		);
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

	it("pins the first resolved address to avoid DNS rebinding", async () => {
		const resolver = vi
			.fn<(_: string) => Promise<readonly string[]>>()
			.mockResolvedValueOnce(["8.8.8.8"])
			.mockResolvedValueOnce(["127.0.0.1"]);
		const dispatcherFactory = vi.fn((resolvedAddress: unknown) => ({
			resolvedAddress,
			close: vi.fn(),
		}));
		const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(init).toEqual(
				expect.objectContaining({
					dispatcher: expect.objectContaining({
						resolvedAddress: expect.objectContaining({
							address: "8.8.8.8",
						}),
					}),
				}),
			);

			return new Response("ok", { status: 200 });
		});
		const tool = createWebFetchTool({
			fetcher,
			resolver,
			dispatcherFactory,
		} as never);

		const result = await tool.execute({
			url: "https://rebind.example/data",
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(resolver).toHaveBeenCalledTimes(1);
		expect(dispatcherFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				address: "8.8.8.8",
			}),
		);
	});

	it("strips sensitive auth headers when target host is not allowlisted", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("ok", {
					status: 200,
					headers: {
						"content-type": "text/plain",
					},
				}),
		);
		const resolver = vi.fn(async () => [
			{
				address: "8.8.8.8",
				family: 4 as const,
			},
		]);
		const tool = createWebFetchTool({
			fetcher,
			resolver,
			allowedAuthHosts: ["api.example.com"],
		} as never);

		const result = await tool.execute({
			url: "https://evil.example/data",
			headers: {
				Authorization: "Bearer top-secret",
				Cookie: "session=abc",
				"Proxy-Authorization": "Basic dGVzdA==",
				"x-test": "1",
			},
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledWith(
			"https://evil.example/data",
			expect.objectContaining({
				headers: {
					"x-test": "1",
				},
			}),
		);
		expect(resolver).toHaveBeenCalledWith("evil.example");
	});

	it("rejects oversized responses before reading the full body", async () => {
		const text = vi.fn(async () => "should not be read");
		const fetcher = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: new Headers({
				"content-type": "text/plain",
				"content-length": String(6 * 1024 * 1024),
			}),
			text,
		}));
		const tool = createWebFetchTool({
			fetcher: fetcher as never,
			maxResponseBytes: 5 * 1024 * 1024,
		} as never);

		const result = await tool.execute({
			url: "https://example.com/too-large",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("Response exceeds max size"),
		});
		expect(text).not.toHaveBeenCalled();
	});

	it("rejects non-text response types before reading the body", async () => {
		const text = vi.fn(async () => "should not be read");
		const fetcher = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: new Headers({
				"content-type": "application/octet-stream",
			}),
			text,
		}));
		const tool = createWebFetchTool({
			fetcher: fetcher as never,
		});

		const result = await tool.execute({
			url: "https://example.com/archive.tar",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("Unsupported content type"),
		});
		expect(text).not.toHaveBeenCalled();
	});
});
