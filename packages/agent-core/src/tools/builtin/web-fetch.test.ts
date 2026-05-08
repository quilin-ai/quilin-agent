import { describe, expect, it, vi } from "vitest";
import type { LLMClient, LLMResponse } from "../../llm/types.js";
import { ToolRouter } from "../router.js";
import { resolveSandboxPolicy } from "../sandbox.js";
import {
	__test_createPinnedLookup,
	allowAllRedirectChecker,
	createWebFetchCache,
	createWebFetchTool,
	sameHostRedirectChecker,
} from "./web-fetch.js";

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

	it("builds dynamic sandbox signals from request arguments", async () => {
		const tool = createWebFetchTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_fetch sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-web-fetch",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: {
				url: "https://api.example.com:8443/data",
				method: "POST",
				headers: {
					Authorization: "Bearer token",
					"X-API-Key": "api-key",
					"x-test": "1",
				},
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		expect(request).toEqual({
			operation: "network",
			origin: "agent",
			signals: {
				network: {
					destination: "api.example.com:8443",
					protocol: "https",
					method: "POST",
					sendsCredentials: true,
				},
			},
		});
	});

	it("marks URL userinfo as credential-bearing sandbox traffic", async () => {
		const tool = createWebFetchTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_fetch sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-web-fetch-userinfo",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: {
				url: "https://user:pass@example.com/data",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		expect(request).toEqual({
			operation: "network",
			origin: "agent",
			signals: {
				network: {
					destination: "example.com",
					protocol: "https",
					method: "GET",
					sendsCredentials: true,
				},
			},
		});
	});

	it("requires sandbox approval for POST bodies before fetching", async () => {
		const fetcher = vi.fn();
		const router = new ToolRouter(
			[
				createWebFetchTool({
					fetcher,
				}),
			],
			{ sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-web-fetch-post-body",
			name: "web_fetch",
			arguments: {
				url: "https://example.com/data",
				method: "POST",
				body: "ping",
				headers: { "x-test": "1" },
			},
		});

		expect(fetcher).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toMatchObject({
			error: "Tool execution requires sandbox approval.",
			code: "sandbox_approval_required",
			details: {
				decision: {
					kind: "ask",
					reasonCodes: ["network_operation_requires_approval"],
					requiredApprovals: ["network_access", "user_confirmation"],
				},
				approvalSummary: {
					tool: "web_fetch",
					call: "call-web-fetch-post-body",
					origin: "agent",
					kind: "ask",
					requiredApprovals: ["network_access", "user_confirmation"],
					reasonCodes: ["network_operation_requires_approval"],
				},
			},
		});
		expect(result.error?.code).toBe("sandbox_approval_required");
	});

	it("allows ordinary GET sandbox checks before fetching", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("hello world", {
					status: 200,
					headers: {
						"content-type": "text/plain",
					},
				}),
		);
		const router = new ToolRouter(
			[
				createWebFetchTool({
					fetcher,
					resolver: createResolver({ "example.com": ["93.184.216.34"] }),
				}),
			],
			{ sandboxOrigin: "agent" },
		);

		const result = await router.execute({
			id: "call-web-fetch-get",
			name: "web_fetch",
			arguments: {
				url: "https://example.com/data",
			},
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledWith(
			"https://example.com/data",
			expect.objectContaining({
				method: "GET",
				body: undefined,
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
				headers: expect.objectContaining({ "x-test": "1" }),
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

	it("adds browser-compatible default headers without overriding caller headers", async () => {
		const fetcher = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response("ok", {
					status: 200,
					headers: {
						"content-type": "application/rss+xml; charset=utf-8",
					},
				}),
		);
		const tool = createWebFetchTool({ fetcher });

		const result = await tool.execute({
			url: "https://example.com/feed.xml",
			headers: {
				"User-Agent": "custom-agent",
				Accept: "application/rss+xml",
			},
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledWith(
			"https://example.com/feed.xml",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": "custom-agent",
					Accept: "application/rss+xml",
					"accept-language": expect.stringContaining("en-US"),
				}),
			}),
		);
		expect(JSON.parse(result.content)).toMatchObject({
			contentType: "application/rss+xml; charset=utf-8",
			body: "ok",
		});
	});

	it("does not pass URL userinfo credentials to fetch", async () => {
		const fetcher = vi.fn();
		const tool = createWebFetchTool({ fetcher });

		const result = await tool.execute({
			url: "https://user:pass@example.com/data",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("URL userinfo credentials"),
		});
		expect(fetcher).not.toHaveBeenCalled();
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
			localhost: ["127.0.0.1"],
			"[::]": ["::"],
			"::": ["::"],
		});
		const tool = createWebFetchTool({ fetcher, resolver });

		for (const url of [
			"http://169.254.169.254/latest/meta-data/",
			"http://127.0.0.1:3000/health",
			"http://localhost:3000/health",
			"http://10.0.0.1/internal",
			"http://[::]/health",
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

	it("re-validates redirects and blocks redirects into private targets when cross-host redirects are explicitly allowed", async () => {
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
		const tool = createWebFetchTool({
			fetcher,
			resolver,
			redirectChecker: allowAllRedirectChecker,
		});

		const result = await tool.execute({
			url: "https://safe.example/start",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("not allowed"),
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("returns a structured redirect response for cross-host redirects under the default same-host policy", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: {
					location: "https://other.example/landing",
				},
			}),
		);
		const resolver = createResolver({
			"safe.example": ["93.184.216.34"],
			"other.example": ["93.184.216.35"],
		});
		const tool = createWebFetchTool({ fetcher, resolver });

		const result = await tool.execute({
			url: "https://safe.example/start",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual({
			type: "redirect",
			originalUrl: "https://safe.example/start",
			redirectUrl: "https://other.example/landing",
			status: 302,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("auto-follows same-host redirects with www. toggle by default", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 301,
					headers: { location: "https://www.example.com/landing" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("<h1>Landed</h1>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);
		const resolver = createResolver({
			"example.com": ["93.184.216.34"],
			"www.example.com": ["93.184.216.34"],
		});
		const tool = createWebFetchTool({
			fetcher,
			resolver,
			htmlToMarkdown: async (html) => html,
		});

		const result = await tool.execute({
			url: "https://example.com/start",
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(2);
		const payload = JSON.parse(result.content);
		expect(payload.url).toBe("https://www.example.com/landing");
		expect(payload.body).toContain("Landed");
	});

	it("rejects redirects that introduce URL userinfo credentials", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: {
					location: "https://user:pass@example.com/secret",
				},
			}),
		);
		const resolver = createResolver({
			"safe.example": ["93.184.216.34"],
			"example.com": ["93.184.216.34"],
		});
		const tool = createWebFetchTool({ fetcher, resolver });

		const result = await tool.execute({
			url: "https://safe.example/start",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("URL userinfo credentials"),
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher).toHaveBeenCalledWith(
			"https://safe.example/start",
			expect.any(Object),
		);
	});

	it("rewrites POST bodies on 303 redirects and preserves them on 307 redirects", async () => {
		const resolver = createResolver({
			"redirect.example": ["93.184.216.34"],
		});
		const seeOtherFetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 303,
					headers: { location: "/final" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("done", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
			);
		const seeOtherTool = createWebFetchTool({
			fetcher: seeOtherFetcher,
			resolver,
		});

		const seeOtherResult = await seeOtherTool.execute({
			url: "https://redirect.example/start",
			method: "POST",
			body: "ping",
		});

		expect(seeOtherResult.isError).toBe(false);
		expect(JSON.parse(seeOtherResult.content)).toMatchObject({
			url: "https://redirect.example/final",
			body: "done",
		});
		expect(seeOtherFetcher).toHaveBeenNthCalledWith(
			1,
			"https://redirect.example/start",
			expect.objectContaining({ method: "POST", body: "ping" }),
		);
		expect(seeOtherFetcher).toHaveBeenNthCalledWith(
			2,
			"https://redirect.example/final",
			expect.objectContaining({ method: "GET", body: undefined }),
		);

		const temporaryRedirectFetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 307,
					headers: { location: "/same-method" },
				}),
			)
			.mockResolvedValueOnce(new Response("kept", { status: 200 }));
		const temporaryRedirectTool = createWebFetchTool({
			fetcher: temporaryRedirectFetcher,
			resolver,
		});

		const temporaryRedirectResult = await temporaryRedirectTool.execute({
			url: "https://redirect.example/start",
			method: "POST",
			body: "ping",
		});

		expect(temporaryRedirectResult.isError).toBe(false);
		expect(temporaryRedirectFetcher).toHaveBeenNthCalledWith(
			2,
			"https://redirect.example/same-method",
			expect.objectContaining({ method: "POST", body: "ping" }),
		);
	});

	it("reports redirect responses with missing locations or exhausted hop budgets", async () => {
		const missingLocationTool = createWebFetchTool({
			fetcher: vi.fn(
				async () =>
					new Response(null, {
						status: 302,
					}),
			),
			resolver: createResolver({ "redirect.example": ["93.184.216.34"] }),
		});

		const missingLocation = await missingLocationTool.execute({
			url: "https://redirect.example/start",
		});

		expect(missingLocation.isError).toBe(true);
		expect(JSON.parse(missingLocation.content)).toEqual({
			error: expect.stringContaining("missing location"),
		});

		const limitTool = createWebFetchTool({
			fetcher: vi.fn(
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: "/again" },
					}),
			),
			maxRedirects: 0,
			resolver: createResolver({ "redirect.example": ["93.184.216.34"] }),
		});

		const limitResult = await limitTool.execute({
			url: "https://redirect.example/start",
		});

		expect(limitResult.isError).toBe(true);
		expect(JSON.parse(limitResult.content)).toEqual({
			error: expect.stringContaining("Redirect limit exceeded"),
		});
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
				"X-API-Key": "api-secret",
				"X-Auth-Token": "auth-secret",
				"Api-Key": "legacy-secret",
				"x-test": "1",
			},
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledWith(
			"https://evil.example/data",
			expect.objectContaining({
				headers: expect.not.objectContaining({
					Authorization: expect.any(String),
					Cookie: expect.any(String),
					"Proxy-Authorization": expect.any(String),
					"X-API-Key": expect.any(String),
					"X-Auth-Token": expect.any(String),
					"Api-Key": expect.any(String),
				}),
			}),
		);
		expect(fetcher).toHaveBeenCalledWith(
			"https://evil.example/data",
			expect.objectContaining({
				headers: expect.objectContaining({
					"x-test": "1",
					"user-agent": expect.stringContaining("QuilinAgent"),
				}),
			}),
		);
		expect(resolver).toHaveBeenCalledWith("evil.example");
	});

	it("preserves sensitive auth headers for allowlisted hosts", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("ok", {
					status: 200,
					headers: {
						"content-type": "text/plain",
					},
				}),
		);
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "api.example.com": ["93.184.216.34"] }),
			allowedAuthHosts: ["api.example.com"],
		});

		const result = await tool.execute({
			url: "https://api.example.com/data",
			headers: {
				Authorization: "Bearer top-secret",
				Cookie: "session=abc",
				"X-API-Key": "api-secret",
				"x-test": "1",
			},
		});

		expect(result.isError).toBe(false);
		expect(fetcher).toHaveBeenCalledWith(
			"https://api.example.com/data",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer top-secret",
					Cookie: "session=abc",
					"X-API-Key": "api-secret",
					"x-test": "1",
					"user-agent": expect.stringContaining("QuilinAgent"),
				}),
			}),
		);
	});

	it("destroys dispatcher resources that do not expose close", async () => {
		const destroy = vi.fn();
		const dispatcherFactory = vi.fn(() => ({ destroy }));
		const fetcher = vi.fn(
			async () =>
				new Response("ok", {
					status: 200,
					headers: {
						"content-type": "text/plain",
					},
				}),
		);
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "dispatch.example": ["93.184.216.34"] }),
			dispatcherFactory,
		} as never);

		const result = await tool.execute({
			url: "https://dispatch.example/data",
		});

		expect(result.isError).toBe(false);
		expect(dispatcherFactory).toHaveBeenCalledWith(
			expect.objectContaining({ address: "93.184.216.34" }),
		);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	it("allows dispatchers without cleanup hooks", async () => {
		const dispatcherFactory = vi.fn(() => ({}));
		const fetcher = vi.fn(
			async () =>
				new Response("ok", {
					status: 200,
					headers: {
						"content-type": "text/plain",
					},
				}),
		);
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "dispatch.example": ["93.184.216.34"] }),
			dispatcherFactory,
		} as never);

		const result = await tool.execute({
			url: "https://dispatch.example/data",
		});

		expect(result.isError).toBe(false);
		expect(dispatcherFactory).toHaveBeenCalledTimes(1);
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

	it("rejects streaming response bodies that exceed the byte limit while reading", async () => {
		const tool = createWebFetchTool({
			fetcher: vi.fn(
				async () =>
					new Response("abcdef", {
						status: 200,
						headers: {
							"content-type": "text/plain",
						},
					}),
			),
			maxResponseBytes: 4,
		});

		const result = await tool.execute({
			url: "https://example.com/stream-too-large",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("Response exceeds max size"),
		});
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

	it("handles tiny truncation budgets and null response bodies", async () => {
		const fetcher = vi.fn(async () => ({
			ok: true,
			status: 200,
			body: null,
			headers: new Headers({
				"content-type": "application/json; charset=utf-8",
				"content-length": "not-a-number",
			}),
			text: vi.fn(async () => "abcdef"),
		}));
		const tool = createWebFetchTool({
			fetcher: fetcher as never,
			maxBodyChars: 2,
			maxResponseBytes: 20,
		});

		const result = await tool.execute({
			url: "https://example.com/json",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual({
			url: "https://example.com/json",
			status: 200,
			contentType: "application/json; charset=utf-8",
			body: "..",
			truncated: true,
		});

		const oversizedNullBodyTool = createWebFetchTool({
			fetcher: vi.fn(async () => ({
				ok: true,
				status: 200,
				body: null,
				headers: new Headers({
					"content-type": "text/plain",
				}),
				text: vi.fn(async () => "abcdef"),
			})),
			maxResponseBytes: 4,
		} as never);
		const oversizedNullBody = await oversizedNullBodyTool.execute({
			url: "https://example.com/too-large-text",
		});

		expect(oversizedNullBody.isError).toBe(true);
		expect(JSON.parse(oversizedNullBody.content).error).toContain(
			"Response exceeds max size",
		);
	});

	it("rejects malformed hostnames, empty DNS results, and non-http redirects", async () => {
		const malformedHostTool = createWebFetchTool({
			fetcher: vi.fn(),
		});
		const malformedHost = await malformedHostTool.execute({
			url: "https://bad..host/path",
		});
		expect(malformedHost.isError).toBe(true);
		expect(JSON.parse(malformedHost.content).error).toContain(
			"Hostname is not allowed",
		);

		const emptyResolverTool = createWebFetchTool({
			fetcher: vi.fn(),
			resolver: vi.fn(async () => []),
		});
		const emptyResolver = await emptyResolverTool.execute({
			url: "https://empty.example/path",
		});
		expect(emptyResolver.isError).toBe(true);
		expect(JSON.parse(emptyResolver.content).error).toContain(
			"Could not resolve hostname",
		);

		const badResolverAddressTool = createWebFetchTool({
			fetcher: vi.fn(),
			resolver: vi.fn(async () => ["not-an-ip"]),
		});
		const badResolverAddress = await badResolverAddressTool.execute({
			url: "https://bad-resolver.example/path",
		});
		expect(badResolverAddress.isError).toBe(true);
		expect(JSON.parse(badResolverAddress.content).error).toContain(
			"Could not resolve hostname",
		);

		const redirectTool = createWebFetchTool({
			fetcher: vi.fn(
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: "file:///etc/passwd" },
					}),
			),
			resolver: createResolver({ "redirect.example": ["93.184.216.34"] }),
		});
		const redirect = await redirectTool.execute({
			url: "https://redirect.example/start",
		});
		expect(redirect.isError).toBe(true);
		expect(JSON.parse(redirect.content).error).toContain(
			"Only http and https URLs",
		);
	});

	it("normalizes IPv6 resolver records and bracketed IPv6 literals", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("ok", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
		);
		const dispatcherFactory = vi.fn(() => ({ close: vi.fn() }));
		const resolver = vi.fn(async () => [
			{
				address: "2001:4860:4860::8888",
				family: 6 as const,
			},
		]);
		const tool = createWebFetchTool({
			fetcher,
			resolver,
			dispatcherFactory,
		} as never);

		const result = await tool.execute({
			url: "https://[2001:4860:4860::8888]/data",
		});

		expect(result.isError).toBe(false);
		expect(dispatcherFactory).toHaveBeenCalledWith({
			address: "2001:4860:4860::8888",
			family: 6,
		});
	});

	it("reports non-Error fetch failures generically", async () => {
		const tool = createWebFetchTool({
			fetcher: vi.fn(async () => {
				throw "boom";
			}),
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
		});

		const result = await tool.execute({
			url: "https://example.com/fail",
		});

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: "Fetch failed",
		});
	});

	it("converts HTML responses to markdown via the injected converter", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<h1>Hello</h1><p>world</p>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		);
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			htmlToMarkdown: async (html) => `MD:${html}`,
		});

		const result = await tool.execute({ url: "https://example.com/page" });

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.body).toBe("MD:<h1>Hello</h1><p>world</p>");
		expect(payload.contentType).toContain("text/html");
	});

	it("returns non-html responses without markdown conversion", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response('{"price": 42}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "api.example.com": ["93.184.216.34"] }),
			htmlToMarkdown: async () => {
				throw new Error("should not convert non-html");
			},
		});

		const result = await tool.execute({ url: "https://api.example.com/data" });

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content).body).toBe('{"price": 42}');
	});

	it("returns cached responses without re-fetching", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<p>fresh</p>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const cache = createWebFetchCache();
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			cache,
			htmlToMarkdown: async (html) => html,
		});

		const first = await tool.execute({ url: "https://example.com/cached" });
		const second = await tool.execute({ url: "https://example.com/cached" });

		expect(fetcher).toHaveBeenCalledTimes(1);
		const firstPayload = JSON.parse(first.content);
		const secondPayload = JSON.parse(second.content);
		expect(firstPayload.body).toBe("<p>fresh</p>");
		expect(secondPayload.body).toBe("<p>fresh</p>");
		expect(secondPayload.fromCache).toBe(true);
	});

	it("invokes sub-LLM extraction on cache hit when prompt is provided", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<h1>Pricing</h1><p>$42</p>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const llmResponse: LLMResponse = {
			content: "the price is $42",
			usage: { inputTokens: 10, outputTokens: 5 },
			finishReason: "stop",
		};
		const chat = vi.fn().mockResolvedValue(llmResponse);
		const llmClient: LLMClient = {
			chat: chat as unknown as LLMClient["chat"],
		};
		const cache = createWebFetchCache();
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			cache,
			htmlToMarkdown: async (html) => html,
			llmClient,
		});

		const first = await tool.execute({ url: "https://example.com/pricing" });
		const second = await tool.execute({
			url: "https://example.com/pricing",
			prompt: "What is the price?",
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		const secondPayload = JSON.parse(second.content);
		expect(JSON.parse(first.content).extracted).toBeUndefined();
		expect(secondPayload.fromCache).toBe(true);
		expect(secondPayload.extracted).toBe(true);
		expect(secondPayload.body).toBe("the price is $42");
		expect(secondPayload.rawMarkdownLength).toBeGreaterThan(0);
		expect(chat).toHaveBeenCalledTimes(1);
	});

	it("returns cached markdown unchanged on cache hit when prompt has no llmClient", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<h1>Hi</h1>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const cache = createWebFetchCache();
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			cache,
			htmlToMarkdown: async (html) => html,
		});

		await tool.execute({ url: "https://example.com/page" });
		const second = await tool.execute({
			url: "https://example.com/page",
			prompt: "Extract title",
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(second.content);
		expect(payload.fromCache).toBe(true);
		expect(payload.extracted).toBeUndefined();
		expect(payload.body).toBe("<h1>Hi</h1>");
	});

	it("does not cache POST responses", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<p>posted</p>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const cache = createWebFetchCache();
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			cache,
			htmlToMarkdown: async (html) => html,
		});

		await tool.execute({
			url: "https://example.com/submit",
			method: "POST",
			body: "payload",
		});
		await tool.execute({
			url: "https://example.com/submit",
			method: "POST",
			body: "payload",
		});

		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("invokes sub-LLM extraction when prompt is provided and llmClient is configured", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<h1>Pricing</h1><p>$42</p>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const llmResponse: LLMResponse = {
			content: "the price is $42",
			usage: { inputTokens: 10, outputTokens: 5 },
			finishReason: "stop",
		};
		const chat = vi.fn().mockResolvedValue(llmResponse);
		const llmClient: LLMClient = {
			chat: chat as unknown as LLMClient["chat"],
		};

		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			htmlToMarkdown: async (html) => `MD:${html}`,
			llmClient,
		});

		const result = await tool.execute({
			url: "https://example.com/pricing",
			prompt: "What is the price?",
		});

		expect(result.isError).toBe(false);
		const payload = JSON.parse(result.content);
		expect(payload.body).toBe("the price is $42");
		expect(payload.extracted).toBe(true);
		expect(payload.rawMarkdownLength).toBeGreaterThan(0);
		expect(chat).toHaveBeenCalledTimes(1);
	});

	it("ignores empty prompts and returns raw markdown", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<h1>Hi</h1>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const chat = vi.fn();
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			htmlToMarkdown: async (html) => `MD:${html}`,
			llmClient: { chat: chat as unknown as LLMClient["chat"] },
		});

		const result = await tool.execute({
			url: "https://example.com/page",
			prompt: "",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content).extracted).toBeUndefined();
		expect(chat).not.toHaveBeenCalled();
	});

	it("skips sub-LLM extraction when prompt is provided but no llmClient is configured", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("<h1>Hi</h1>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const tool = createWebFetchTool({
			fetcher,
			resolver: createResolver({ "example.com": ["93.184.216.34"] }),
			htmlToMarkdown: async (html) => html,
		});

		const result = await tool.execute({
			url: "https://example.com/page",
			prompt: "Extract title",
		});

		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content).extracted).toBeUndefined();
	});

	it("returns an error result when the URL string fails to parse", async () => {
		const tool = createWebFetchTool();

		const result = await tool.execute({ url: "ht!tp://??" });

		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content).error).toMatch(/Invalid URL/i);
	});

	it("falls through to a raw destination when sandbox policy URL parsing throws on a GET", async () => {
		const tool = createWebFetchTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_fetch sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-bad-url-get",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: { url: "not a url at all" },
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		expect(request.operation).toBe("network");
		const network = request.signals?.network;
		expect(network?.destination).toBe("not a url at all");
		expect(network?.method).toBe("GET");
	});

	it("hides the raw destination when sandbox policy URL parsing throws on a write that does not bear credentials", async () => {
		const tool = createWebFetchTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_fetch sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-bad-url-post",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: {
				url: "not a url at all",
				method: "POST",
				body: "payload",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		const network = request.signals?.network;
		expect(network?.destination).toBeUndefined();
		expect(network?.method).toBe("POST");
		expect(network?.sendsCredentials).toBe(false);
	});
});

describe("__test_createPinnedLookup", () => {
	it("invokes the callback with the pinned address and family", () => {
		const lookup = __test_createPinnedLookup({
			address: "203.0.113.7",
			family: 4,
		});

		const calls: Array<[Error | null, string, number]> = [];
		lookup("ignored.example", undefined, (err, addr, family) => {
			calls.push([err, addr, family]);
		});

		expect(calls).toEqual([[null, "203.0.113.7", 4]]);
	});
});

describe("isKnownPrivateDestination via sandbox policy", () => {
	it("preserves localhost destination for write requests because the host is private", async () => {
		const tool = createWebFetchTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_fetch sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-localhost",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: {
				url: "http://localhost:8080/internal",
				method: "POST",
				body: "ping",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		expect(request.signals?.network?.destination).toBe("localhost:8080");
	});

	it("preserves a sub-domain of localhost too", async () => {
		const tool = createWebFetchTool();
		if (tool.sandboxPolicy == null) {
			throw new Error("web_fetch sandbox policy is not configured");
		}

		const request = await resolveSandboxPolicy(tool.sandboxPolicy, {
			toolCallId: "call-sub-localhost",
			requestedToolName: "web_fetch",
			resolvedToolName: "web_fetch",
			parsedArguments: {
				url: "http://api.localhost/svc",
				method: "POST",
				body: "ping",
			},
			origin: "agent",
			category: "programmatic",
			riskLevel: "read",
			sandboxOperation: "network",
		});

		if (request == null) throw new Error("expected sandbox request");
		expect(request.signals?.network?.destination).toBe("api.localhost");
	});
});

describe("sameHostRedirectChecker", () => {
	it("treats www. and bare host as equivalent", () => {
		const from = new URL("https://example.com/a");
		const to = new URL("https://www.example.com/b");
		expect(sameHostRedirectChecker(from, to)).toBe(true);
		expect(sameHostRedirectChecker(to, from)).toBe(true);
	});

	it("rejects protocol downgrade", () => {
		const from = new URL("https://example.com/a");
		const to = new URL("http://example.com/a");
		expect(sameHostRedirectChecker(from, to)).toBe(false);
	});

	it("rejects port mismatch", () => {
		const from = new URL("https://example.com:443/a");
		const to = new URL("https://example.com:8443/a");
		expect(sameHostRedirectChecker(from, to)).toBe(false);
	});

	it("rejects different hostnames", () => {
		const from = new URL("https://example.com/a");
		const to = new URL("https://other.example/a");
		expect(sameHostRedirectChecker(from, to)).toBe(false);
	});
});
