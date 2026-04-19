import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_BODY_CHARS = 16_384;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

const BLOCKED_IPS = new BlockList();
BLOCKED_IPS.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_IPS.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_IPS.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_IPS.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_IPS.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_IPS.addAddress("::1", "ipv6");
BLOCKED_IPS.addSubnet("fc00::", 7, "ipv6");

type Fetcher = typeof fetch;
type IPResolver = (hostname: string) => Promise<readonly string[]>;

function createSuccessResult(
	toolCallId: string,
	payload: Record<string, unknown>,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify(payload),
		isError: false,
	};
}

function createErrorResult(
	toolCallId: string,
	payload: Record<string, unknown>,
): ToolResult {
	return {
		toolCallId,
		content: JSON.stringify(payload),
		isError: true,
	};
}

function truncateText(
	text: string,
	maxChars: number,
): { readonly value: string; readonly truncated: boolean } {
	if (text.length <= maxChars) {
		return { value: text, truncated: false };
	}

	if (maxChars <= 3) {
		return {
			value: ".".repeat(Math.max(maxChars, 0)),
			truncated: true,
		};
	}

	return {
		value: `${text.slice(0, maxChars - 3)}...`,
		truncated: true,
	};
}

function unwrapIPv4MappedAddress(address: string): string {
	return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isBlockedAddress(address: string): boolean {
	const normalized = unwrapIPv4MappedAddress(address);
	const type = isIP(normalized);
	if (type === 0) {
		return false;
	}

	return BLOCKED_IPS.check(normalized, type === 6 ? "ipv6" : "ipv4");
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
	if (isIP(hostname) !== 0) {
		return [hostname];
	}

	const addresses = await lookup(hostname, {
		all: true,
		verbatim: true,
	});
	return addresses.map((record) => record.address);
}

async function resolveAndCheckIP(
	url: URL,
	resolver: IPResolver = defaultResolver,
): Promise<void> {
	const addresses = await resolver(url.hostname);
	if (addresses.length === 0) {
		throw new Error(`Could not resolve hostname: ${url.hostname}`);
	}

	for (const address of addresses) {
		if (isBlockedAddress(address)) {
			throw new Error(`Target address is not allowed: ${address}`);
		}
	}
}

function isRedirectStatus(status: number): boolean {
	return [301, 302, 303, 307, 308].includes(status);
}

function getRedirectRequest(
	status: number,
	method: "GET" | "POST",
	body: string | undefined,
) {
	if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
		return {
			method: "GET" as const,
			body: undefined,
		};
	}

	return { method, body };
}

export interface WebFetchToolOptions {
	readonly fetcher?: Fetcher;
	readonly maxBodyChars?: number;
	readonly resolver?: IPResolver;
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
}

export function createWebFetchTool(
	options: WebFetchToolOptions = {},
): ToolWithMetadata {
	return {
		name: "web_fetch",
		description: "Fetch HTTP(S) resources with optional POST body and headers.",
		parameters: z.object({
			url: z.string(),
			method: z.enum(["GET", "POST"]).optional(),
			body: z.string().optional(),
			headers: z.record(z.string(), z.string()).optional(),
		}),
		category: "programmatic",
		riskLevel: "read",
		execute: async (args) => {
			const { url, method = "GET", body, headers } = args as {
				url: string;
				method?: "GET" | "POST";
				body?: string;
				headers?: Record<string, string>;
			};

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(url);
			} catch (error) {
				return createErrorResult("builtin-web-fetch", {
					error:
						error instanceof Error ? error.message : "Invalid URL provided",
				});
			}

			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				return createErrorResult("builtin-web-fetch", {
					error: `Only http and https URLs are allowed: ${url}`,
				});
			}

			const fetcher = options.fetcher ?? fetch;
			const resolver = options.resolver ?? defaultResolver;
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

			let currentUrl = parsedUrl;
			let currentMethod = method;
			let currentBody = body;

			try {
				for (let hop = 0; hop <= maxRedirects; hop += 1) {
					await resolveAndCheckIP(currentUrl, resolver);

					const response = await fetcher(currentUrl.toString(), {
						method: currentMethod,
						body: currentBody,
						headers,
						signal: AbortSignal.timeout(timeoutMs),
						redirect: "manual",
					});

					if (isRedirectStatus(response.status)) {
						if (hop === maxRedirects) {
							return createErrorResult("builtin-web-fetch", {
								error: `Redirect limit exceeded for ${url}`,
							});
						}

						const location = response.headers.get("location");
						if (location == null || location === "") {
							return createErrorResult("builtin-web-fetch", {
								error: `Redirect response missing location header: ${currentUrl.toString()}`,
							});
						}

						currentUrl = new URL(location, currentUrl);
						if (!["http:", "https:"].includes(currentUrl.protocol)) {
							return createErrorResult("builtin-web-fetch", {
								error: `Only http and https URLs are allowed: ${currentUrl.toString()}`,
							});
						}

						const redirectRequest = getRedirectRequest(
							response.status,
							currentMethod,
							currentBody,
						);
						currentMethod = redirectRequest.method;
						currentBody = redirectRequest.body;
						continue;
					}

					const responseBody = await response.text();
					const truncatedBody = truncateText(
						responseBody,
						options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
					);

					if (!response.ok) {
						return createErrorResult("builtin-web-fetch", {
							error: `HTTP ${response.status}`,
							status: response.status,
							body: truncatedBody.value,
						});
					}

					return createSuccessResult("builtin-web-fetch", {
						url: currentUrl.toString(),
						status: response.status,
						contentType: response.headers.get("content-type") ?? "",
						body: truncatedBody.value,
						truncated: truncatedBody.truncated,
					});
				}

				return createErrorResult("builtin-web-fetch", {
					error: `Redirect limit exceeded for ${url}`,
				});
			} catch (error) {
				return createErrorResult("builtin-web-fetch", {
					error: error instanceof Error ? error.message : "Fetch failed",
				});
			}
		},
	};
}
