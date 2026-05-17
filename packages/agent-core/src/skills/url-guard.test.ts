import { describe, expect, it } from "vitest";
import {
	assertSafeUrl,
	BodyTooLargeError,
	isBlockedHostname,
	readBodyWithSizeLimit,
} from "./url-guard.js";

describe("isBlockedHostname", () => {
	it("blocks loopback IPv4", () => {
		expect(isBlockedHostname("127.0.0.1")).toBe(true);
		expect(isBlockedHostname("127.5.5.5")).toBe(true);
	});

	it("blocks RFC1918 ranges", () => {
		expect(isBlockedHostname("10.0.0.1")).toBe(true);
		expect(isBlockedHostname("192.168.1.1")).toBe(true);
		expect(isBlockedHostname("172.16.0.1")).toBe(true);
		expect(isBlockedHostname("172.31.255.255")).toBe(true);
	});

	it("blocks AWS / Alibaba metadata IPs", () => {
		expect(isBlockedHostname("169.254.169.254")).toBe(true);
		expect(isBlockedHostname("100.100.100.200")).toBe(true);
	});

	it("blocks localhost-style aliases", () => {
		expect(isBlockedHostname("localhost")).toBe(true);
		expect(isBlockedHostname("LOCALHOST")).toBe(true);
		expect(isBlockedHostname("localhost.")).toBe(true);
		expect(isBlockedHostname("metadata")).toBe(true);
		expect(isBlockedHostname("metadata.google.internal")).toBe(true);
	});

	it("blocks IPv6 loopback / link-local / IPv4-mapped forms", () => {
		expect(isBlockedHostname("::1")).toBe(true);
		expect(isBlockedHostname("[::1]")).toBe(true);
		expect(isBlockedHostname("::ffff:127.0.0.1")).toBe(true);
		expect(isBlockedHostname("fe80::1")).toBe(true);
		expect(isBlockedHostname("fc00::1")).toBe(true);
	});

	it("allows public hostnames", () => {
		expect(isBlockedHostname("api.agentskills.io")).toBe(false);
		expect(isBlockedHostname("cdn.example.com")).toBe(false);
		expect(isBlockedHostname("metadata.example.com")).toBe(false); // not the GCP alias
		expect(isBlockedHostname("8.8.8.8")).toBe(false);
	});
});

describe("assertSafeUrl", () => {
	it("accepts valid https URLs to public hosts", () => {
		const result = assertSafeUrl("https://api.agentskills.io/v1/skills");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.url.hostname).toBe("api.agentskills.io");
		}
	});

	it("accepts http for the registry client default protocols", () => {
		const result = assertSafeUrl("http://api.agentskills.io/v1");
		expect(result.ok).toBe(true);
	});

	it("rejects file:// protocol", () => {
		const result = assertSafeUrl("file:///etc/passwd");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("disallowed protocol");
		}
	});

	it("rejects gopher:// and data:// protocols", () => {
		expect(assertSafeUrl("gopher://example.com/").ok).toBe(false);
		expect(assertSafeUrl("data:text/plain,hello").ok).toBe(false);
	});

	it("rejects RFC1918 / loopback / link-local hosts (SSRF)", () => {
		expect(assertSafeUrl("http://127.0.0.1/").ok).toBe(false);
		expect(assertSafeUrl("http://localhost:5432/").ok).toBe(false);
		expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(
			false,
		);
		expect(assertSafeUrl("http://10.0.0.1/").ok).toBe(false);
	});

	it("rejects malformed URLs", () => {
		const result = assertSafeUrl("not a url");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("invalid URL");
		}
	});

	it("enforces caller-supplied allowedProtocols (https-only env mode)", () => {
		expect(
			assertSafeUrl("http://api.agentskills.io/v1", {
				allowedProtocols: ["https:"],
			}).ok,
		).toBe(false);
		expect(
			assertSafeUrl("https://api.agentskills.io/v1", {
				allowedProtocols: ["https:"],
			}).ok,
		).toBe(true);
	});

	it("allowPrivateHosts opt-out skips the SSRF blocklist", () => {
		const result = assertSafeUrl("http://127.0.0.1/", {
			allowPrivateHosts: true,
		});
		expect(result.ok).toBe(true);
	});
});

describe("readBodyWithSizeLimit", () => {
	function streamResponse(body: string, contentLength?: number): Response {
		const headers: Record<string, string> = {
			"content-type": "text/plain",
		};
		if (contentLength != null) {
			headers["content-length"] = String(contentLength);
		}
		return new Response(body, { status: 200, headers });
	}

	it("returns the body unchanged when under the limit", async () => {
		const res = streamResponse("hello world");
		const text = await readBodyWithSizeLimit(res, 1024);
		expect(text).toBe("hello world");
	});

	it("rejects when Content-Length exceeds the cap (without reading body)", async () => {
		const huge = "x".repeat(100);
		// declared length intentionally huge — guard should reject before
		// looking at the body
		const res = streamResponse(huge, 10_000_000);
		await expect(readBodyWithSizeLimit(res, 50)).rejects.toBeInstanceOf(
			BodyTooLargeError,
		);
	});

	it("rejects when streamed bytes exceed the cap (no Content-Length)", async () => {
		const big = "y".repeat(1024);
		const res = new Response(big, {
			status: 200,
			headers: { "content-type": "text/plain" },
			// no content-length forces stream path
		});
		await expect(readBodyWithSizeLimit(res, 100)).rejects.toBeInstanceOf(
			BodyTooLargeError,
		);
	});

	it("aborts the supplied AbortController when size is exceeded", async () => {
		const big = "z".repeat(1024);
		const res = new Response(big, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
		const controller = new AbortController();
		await expect(
			readBodyWithSizeLimit(res, 100, controller),
		).rejects.toBeInstanceOf(BodyTooLargeError);
		expect(controller.signal.aborted).toBe(true);
	});

	it("ignores non-numeric Content-Length and falls through to stream read", async () => {
		const res = new Response("payload", {
			status: 200,
			headers: { "content-length": "not-a-number" },
		});
		const text = await readBodyWithSizeLimit(res, 1024);
		expect(text).toBe("payload");
	});

	it("falls back to .text() when body is null (test-double Response)", async () => {
		// A Response constructed from undefined body has body=null in some
		// runtimes; we simulate by mocking.
		const res = new Response("ok", {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
		// Force the body getter to return null to exercise the fallback path.
		Object.defineProperty(res, "body", { value: null });
		const text = await readBodyWithSizeLimit(res, 1024);
		expect(text).toBe("ok");
	});

	it("fallback path also enforces the cap", async () => {
		const big = "a".repeat(1024);
		const res = new Response(big, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
		Object.defineProperty(res, "body", { value: null });
		await expect(readBodyWithSizeLimit(res, 100)).rejects.toBeInstanceOf(
			BodyTooLargeError,
		);
	});

	it("exposes BodyTooLargeError fields", async () => {
		const res = streamResponse("payload", 999);
		try {
			await readBodyWithSizeLimit(res, 100);
			expect.fail("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(BodyTooLargeError);
			if (error instanceof BodyTooLargeError) {
				expect(error.maxBytes).toBe(100);
				expect(error.observedBytes).toBe(999);
			}
		}
	});
});
