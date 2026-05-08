import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import type { InferenceConfig, LLMClient } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { SandboxPolicy, SandboxRequest } from "../sandbox.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";
import {
	createWebFetchCache,
	type WebFetchCache,
} from "./web-fetch-cache.js";

export {
	createWebFetchCache,
	type WebFetchCache,
} from "./web-fetch-cache.js";
import {
	createDefaultHtmlToMarkdown,
	extractWithLLM,
	type HtmlToMarkdown,
} from "./web-fetch-extract.js";

const DEFAULT_MAX_BODY_CHARS = 100_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_EXTRACTION_INFERENCE: InferenceConfig = {
	temperature: 0,
	maxTokens: 1024,
	thinkingMode: "disabled",
};
const DEFAULT_REQUEST_HEADERS = {
	accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
	"accept-language": "en-US,en;q=0.9",
	"user-agent":
		"Mozilla/5.0 (compatible; QuilinAgent/0.0.3; +https://github.com/quilin-agent/quilin-agent)",
} as const;
const ALLOWED_DNS_HOSTNAME = /^[a-z][a-z0-9.-]*$/i;
const SENSITIVE_HEADER_NAMES = new Set([
	"api-key",
	"apikey",
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
	"x-auth-token",
	"x-goog-api-key",
	"x-amz-security-token",
]);

const require = createRequire(import.meta.url);

const BLOCKED_IPS = new BlockList();
BLOCKED_IPS.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_IPS.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_IPS.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_IPS.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_IPS.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_IPS.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_IPS.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_IPS.addAddress("::", "ipv6");
BLOCKED_IPS.addAddress("::1", "ipv6");
BLOCKED_IPS.addSubnet("fc00::", 7, "ipv6");
BLOCKED_IPS.addSubnet("fe80::", 10, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:10.0.0.0", 104, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:100.64.0.0", 106, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:172.16.0.0", 108, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:192.168.0.0", 112, "ipv6");
BLOCKED_IPS.addSubnet("::ffff:169.254.0.0", 112, "ipv6");

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
type IPFamily = 4 | 6;

interface ResolvedAddress {
	readonly address: string;
	readonly family: IPFamily;
}

interface DispatcherResource {
	readonly close?: () => Promise<void> | void;
	readonly destroy?: (error?: Error) => Promise<void> | void;
}

interface UndiciAgentConstructor {
	new (options: {
		readonly connect: {
			readonly lookup: (
				hostname: string,
				options: unknown,
				callback: (
					error: Error | null,
					address: string,
					family: number,
				) => void,
			) => void;
		};
	}): DispatcherResource;
}

type DispatcherFactory = (resolvedAddress: ResolvedAddress) => unknown;
type FetchRequestInit = RequestInit & { readonly dispatcher?: unknown };
type ResolverAddress = ResolvedAddress | string;
type ResolverResult = readonly ResolverAddress[];
type IPResolver = (hostname: string) => Promise<ResolverResult>;

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

function normalizeHostname(hostname: string): string {
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		return hostname.slice(1, -1).toLowerCase();
	}

	return hostname.toLowerCase();
}

function isValidDnsHostname(hostname: string): boolean {
	if (
		hostname.length === 0 ||
		hostname.length > 253 ||
		!ALLOWED_DNS_HOSTNAME.test(hostname) ||
		hostname.includes("..") ||
		hostname.endsWith(".")
	) {
		return false;
	}

	return hostname
		.split(".")
		.every(
			(label) => label !== "" && !label.startsWith("-") && !label.endsWith("-"),
		);
}

function isBlockedAddress(address: string, family: IPFamily): boolean {
	return BLOCKED_IPS.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function defaultResolver(hostname: string): Promise<ResolverResult> {
	const normalizedHostname = normalizeHostname(hostname);
	const family = isIP(normalizedHostname);
	if (family !== 0) {
		return [
			{
				address: normalizedHostname,
				family: family as IPFamily,
			},
		];
	}

	if (!isValidDnsHostname(normalizedHostname)) {
		throw new Error(`Hostname is not allowed: ${hostname}`);
	}

	const addresses = await lookup(normalizedHostname, {
		all: true,
		verbatim: true,
	});
	return addresses.map((record) => ({
		address: normalizeHostname(record.address),
		family: record.family === 6 ? 6 : 4,
	}));
}

async function resolveAndCheckIP(
	url: URL,
	resolver: IPResolver = defaultResolver,
): Promise<ResolvedAddress> {
	const addresses = (await resolver(url.hostname)).map((address) => {
		if (typeof address !== "string") {
			return address;
		}

		const normalizedAddress = normalizeHostname(address);
		const family = isIP(normalizedAddress);
		if (family === 0) {
			throw new Error(`Could not resolve hostname: ${url.hostname}`);
		}

		return {
			address: normalizedAddress,
			family: family as IPFamily,
		};
	});
	if (addresses.length === 0) {
		throw new Error(`Could not resolve hostname: ${url.hostname}`);
	}

	for (const address of addresses) {
		if (isBlockedAddress(address.address, address.family)) {
			throw new Error(`Target address is not allowed: ${address.address}`);
		}
	}

	return addresses[0];
}

export function __test_createPinnedLookup(resolvedAddress: ResolvedAddress) {
	return createPinnedLookup(resolvedAddress);
}

function createPinnedLookup(resolvedAddress: ResolvedAddress) {
	return (
		_hostname: string,
		_options: unknown,
		callback: (error: Error | null, address: string, family: number) => void,
	) => {
		callback(null, resolvedAddress.address, resolvedAddress.family);
	};
}

/* c8 ignore start -- only used when no dispatcherFactory is injected; constructs a real undici Agent that hits the network */
function createDefaultDispatcherFactory(): DispatcherFactory {
	return (resolvedAddress) => {
		const { Agent } = require("undici") as {
			readonly Agent: UndiciAgentConstructor;
		};

		return new Agent({
			connect: {
				lookup: createPinnedLookup(resolvedAddress),
			},
		});
	};
}
/* c8 ignore stop */

async function cleanupDispatcher(dispatcher: unknown): Promise<void> {
	if (dispatcher == null || typeof dispatcher !== "object") {
		return;
	}

	const resource = dispatcher as DispatcherResource;
	if (typeof resource.close === "function") {
		await resource.close();
		return;
	}

	if (typeof resource.destroy === "function") {
		await resource.destroy();
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
	if (
		status === 303 ||
		((status === 301 || status === 302) && method === "POST")
	) {
		return {
			method: "GET" as const,
			body: undefined,
		};
	}

	return { method, body };
}

function normalizeAuthHost(hostname: string): string {
	return normalizeHostname(hostname);
}

function hasSensitiveHeaders(
	headers: Record<string, string> | undefined,
): boolean {
	return Object.keys(headers ?? {}).some((name) =>
		SENSITIVE_HEADER_NAMES.has(name.toLowerCase()),
	);
}

function hasUrlUserinfo(url: URL): boolean {
	return url.username !== "" || url.password !== "";
}

function normalizeRequestMethod(method: unknown): string {
	if (typeof method !== "string" || method.length === 0) {
		return "GET";
	}

	return method.toUpperCase();
}

function hasNonEmptyRequestBody(body: unknown): boolean {
	return typeof body === "string" ? body.length > 0 : body != null;
}

function isKnownPrivateDestination(url: URL): boolean {
	const hostname = normalizeHostname(url.hostname);
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		return true;
	}

	const family = isIP(hostname);
	return family !== 0 && isBlockedAddress(hostname, family as IPFamily);
}

function normalizeProtocol(protocol: string): string {
	return protocol.endsWith(":") ? protocol.slice(0, -1) : protocol;
}

function createSandboxRequestFromArgs(
	args: unknown,
	origin: SandboxRequest["origin"],
): SandboxRequest {
	const { url, method, body, headers } = args as {
		url?: string;
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
	};
	const requestMethod = normalizeRequestMethod(method);
	const hasRequestBody = hasNonEmptyRequestBody(body);
	const requiresNetworkApproval = requestMethod !== "GET" || hasRequestBody;

	let networkSignal: NonNullable<
		NonNullable<SandboxRequest["signals"]>["network"]
	> = {
		method: requestMethod,
		sendsCredentials: hasSensitiveHeaders(headers),
	};

	if (typeof url === "string") {
		try {
			const parsedUrl = new URL(url);
			const sendsCredentials =
				networkSignal.sendsCredentials || hasUrlUserinfo(parsedUrl);
			const shouldPreserveDestination =
				!requiresNetworkApproval ||
				sendsCredentials ||
				isKnownPrivateDestination(parsedUrl);
			networkSignal = {
				...networkSignal,
				protocol: normalizeProtocol(parsedUrl.protocol),
				sendsCredentials,
				...(shouldPreserveDestination ? { destination: parsedUrl.host } : {}),
			};
		} catch {
			networkSignal = {
				...networkSignal,
				...(requiresNetworkApproval && networkSignal.sendsCredentials !== true
					? {}
					: { destination: url }),
			};
		}
	}

	return {
		operation: "network",
		...(origin == null ? {} : { origin }),
		signals: {
			network: networkSignal,
		},
	};
}

const webFetchSandboxPolicy: SandboxPolicy = (context) =>
	createSandboxRequestFromArgs(context.parsedArguments, context.origin);

function sanitizeHeaders(
	headers: Record<string, string> | undefined,
	url: URL,
	allowedAuthHosts: readonly string[] | undefined,
): Record<string, string> | undefined {
	const normalizedAllowedHosts = new Set(
		(allowedAuthHosts ?? []).map((hostname) => normalizeAuthHost(hostname)),
	);
	const requestHost = normalizeAuthHost(url.hostname);
	const shouldStripSensitiveHeaders = !normalizedAllowedHosts.has(requestHost);
	const effectiveHeaders = mergeDefaultHeaders(headers);

	if (!shouldStripSensitiveHeaders) {
		return effectiveHeaders;
	}

	const sanitizedHeaders: Record<string, string> = {};
	let strippedHeader = false;

	for (const [name, value] of Object.entries(effectiveHeaders)) {
		if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
			strippedHeader = true;
			continue;
		}

		sanitizedHeaders[name] = value;
	}

	if (strippedHeader) {
		logger.warn(
			{ host: requestHost, allowedAuthHosts: [...normalizedAllowedHosts] },
			"Stripped sensitive auth headers for non-allowlisted web_fetch host",
		);
	}

	return sanitizedHeaders;
}

function mergeDefaultHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> {
	const merged: Record<string, string> = { ...headers };
	const existingHeaderNames = new Set(
		Object.keys(merged).map((name) => name.toLowerCase()),
	);

	for (const [name, value] of Object.entries(DEFAULT_REQUEST_HEADERS)) {
		if (!existingHeaderNames.has(name)) {
			merged[name] = value;
		}
	}

	return merged;
}

function validateResponseContentType(response: Response): string {
	const contentType = response.headers.get("content-type") ?? "";
	const normalizedContentType =
		contentType.split(";")[0]?.trim().toLowerCase() ?? "";

	const isReadableApplicationType =
		normalizedContentType === "application/json" ||
		normalizedContentType === "application/xml" ||
		normalizedContentType === "application/xhtml+xml" ||
		normalizedContentType === "application/rss+xml" ||
		normalizedContentType === "application/atom+xml" ||
		normalizedContentType.endsWith("+json") ||
		normalizedContentType.endsWith("+xml");

	if (
		normalizedContentType === "" ||
		normalizedContentType.startsWith("text/") ||
		isReadableApplicationType
	) {
		return contentType;
	}

	throw new Error(`Unsupported content type: ${contentType}`);
}

function validateResponseLength(
	response: Response,
	maxResponseBytes: number,
): void {
	const contentLengthHeader = response.headers.get("content-length");
	if (contentLengthHeader == null) {
		return;
	}

	const contentLength = Number.parseInt(contentLengthHeader, 10);
	if (Number.isNaN(contentLength) || contentLength <= maxResponseBytes) {
		return;
	}

	throw new Error(
		`Response exceeds max size: ${contentLength} > ${maxResponseBytes} bytes`,
	);
}

async function readResponseText(
	response: Response,
	maxResponseBytes: number,
): Promise<string> {
	if (response.body == null) {
		const text = await response.text();
		const textBytes = Buffer.byteLength(text, "utf8");
		if (textBytes > maxResponseBytes) {
			throw new Error(
				`Response exceeds max size: ${textBytes} > ${maxResponseBytes} bytes`,
			);
		}
		return text;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			totalBytes += value.byteLength;
			if (totalBytes > maxResponseBytes) {
				throw new Error(
					`Response exceeds max size: ${totalBytes} > ${maxResponseBytes} bytes`,
				);
			}

			chunks.push(decoder.decode(value, { stream: true }));
		}
	} finally {
		reader.releaseLock();
	}

	chunks.push(decoder.decode());
	return chunks.join("");
}

/** Decide whether a redirect from `from` to `to` should be auto-followed.
 * Default policy: same host (with optional `www.` prefix toggle), same protocol, same port.
 */
export type RedirectChecker = (from: URL, to: URL) => boolean;

export const sameHostRedirectChecker: RedirectChecker = (from, to) => {
	if (from.protocol !== to.protocol) return false;
	if (from.port !== to.port) return false;
	const strip = (host: string) => host.replace(/^www\./, "");
	return strip(from.hostname.toLowerCase()) === strip(to.hostname.toLowerCase());
};

export const allowAllRedirectChecker: RedirectChecker = () => true;

export interface WebFetchToolOptions {
	readonly allowedAuthHosts?: readonly string[];
	readonly dispatcherFactory?: DispatcherFactory;
	readonly fetcher?: Fetcher;
	readonly maxBodyChars?: number;
	readonly maxResponseBytes?: number;
	readonly resolver?: IPResolver;
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
	readonly redirectChecker?: RedirectChecker;
	readonly cache?: WebFetchCache;
	readonly htmlToMarkdown?: HtmlToMarkdown;
	readonly llmClient?: LLMClient;
	readonly extractionInferenceConfig?: InferenceConfig;
}

export function createWebFetchTool(
	options: WebFetchToolOptions = {},
): ToolWithMetadata {
	return {
		name: "web_fetch",
		description:
			"Fetch HTTP(S) resources and return clean markdown. Optionally pass `prompt` to ask a sub-LLM to extract a focused answer from the page instead of the full markdown.",
		parameters: z.object({
			url: z.string(),
			method: z.enum(["GET", "POST"]).optional(),
			body: z.string().optional(),
			headers: z.record(z.string(), z.string()).optional(),
			prompt: z.string().optional(),
		}),
		category: "programmatic",
		riskLevel: "read",
		sandboxOperation: "network",
		sandboxPolicy: webFetchSandboxPolicy,
		execute: async (args) => {
			const {
				url,
				method = "GET",
				body,
				headers,
				prompt,
			} = args as {
				url: string;
				method?: "GET" | "POST";
				body?: string;
				headers?: Record<string, string>;
				prompt?: string;
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

			if (hasUrlUserinfo(parsedUrl)) {
				return createErrorResult("builtin-web-fetch", {
					error:
						"URL userinfo credentials are not supported; pass credentials through approved headers instead.",
				});
			}

			const fetcher = options.fetcher ?? fetch;
			const resolver = options.resolver ?? defaultResolver;
			const dispatcherFactory =
				options.dispatcherFactory ??
				(options.fetcher == null
					? createDefaultDispatcherFactory()
					: undefined);
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
			const maxResponseBytes =
				options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
			const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
			const redirectChecker =
				options.redirectChecker ?? sameHostRedirectChecker;
			const cache = options.cache;
			const htmlToMarkdown =
				options.htmlToMarkdown ?? createDefaultHtmlToMarkdown();
			const cacheable =
				method === "GET" &&
				(body == null || body === "") &&
				cache != null;

			if (cacheable) {
				const cached = cache.get(parsedUrl.toString());
				if (cached) {
					return createSuccessResult("builtin-web-fetch", {
						url: cached.url,
						status: cached.status,
						contentType: cached.contentType,
						body: cached.markdown,
						truncated: cached.truncated,
						fromCache: true,
					});
				}
			}

			let currentUrl = parsedUrl;
			let currentMethod = method;
			let currentBody = body;

			try {
				for (let hop = 0; hop <= maxRedirects; hop += 1) {
					const resolvedAddress = await resolveAndCheckIP(currentUrl, resolver);
					const dispatcher = dispatcherFactory?.(resolvedAddress);

					let response: Response;
					try {
						const requestHeaders = sanitizeHeaders(
							headers,
							currentUrl,
							options.allowedAuthHosts,
						);
						response = await fetcher(currentUrl.toString(), {
							method: currentMethod,
							body: currentBody,
							headers: requestHeaders,
							signal: AbortSignal.timeout(timeoutMs),
							redirect: "manual",
							dispatcher,
						} as FetchRequestInit as RequestInit);
					} finally {
						await cleanupDispatcher(dispatcher);
					}

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

						const nextUrl = new URL(location, currentUrl);
						if (!["http:", "https:"].includes(nextUrl.protocol)) {
							return createErrorResult("builtin-web-fetch", {
								error: `Only http and https URLs are allowed: ${nextUrl.toString()}`,
							});
						}
						if (hasUrlUserinfo(nextUrl)) {
							return createErrorResult("builtin-web-fetch", {
								error:
									"URL userinfo credentials are not supported; pass credentials through approved headers instead.",
							});
						}
						if (!redirectChecker(currentUrl, nextUrl)) {
							return createSuccessResult("builtin-web-fetch", {
								type: "redirect",
								originalUrl: currentUrl.toString(),
								redirectUrl: nextUrl.toString(),
								status: response.status,
							});
						}
						currentUrl = nextUrl;

						const redirectRequest = getRedirectRequest(
							response.status,
							currentMethod,
							currentBody,
						);
						currentMethod = redirectRequest.method;
						currentBody = redirectRequest.body;
						continue;
					}

					const contentType = validateResponseContentType(response);
					validateResponseLength(response, maxResponseBytes);
					const responseBody = await readResponseText(
						response,
						maxResponseBytes,
					);

					const isHtml =
						(contentType.split(";")[0]?.trim().toLowerCase() ?? "") ===
						"text/html";
					const renderedBody = isHtml
						? await htmlToMarkdown(responseBody)
						: responseBody;
					const truncatedBody = truncateText(renderedBody, maxBodyChars);

					if (!response.ok) {
						return createErrorResult("builtin-web-fetch", {
							error: `HTTP ${response.status}`,
							status: response.status,
							body: truncatedBody.value,
						});
					}

					if (cacheable && cache != null) {
						cache.set(parsedUrl.toString(), {
							bytes: Buffer.byteLength(truncatedBody.value, "utf8"),
							status: response.status,
							contentType,
							markdown: truncatedBody.value,
							truncated: truncatedBody.truncated,
							url: currentUrl.toString(),
						});
					}

					if (prompt != null && prompt.length > 0 && options.llmClient) {
						const extracted = await extractWithLLM({
							llmClient: options.llmClient,
							inferenceConfig:
								options.extractionInferenceConfig ?? DEFAULT_EXTRACTION_INFERENCE,
							markdown: truncatedBody.value,
							prompt,
							maxMarkdownLength: maxBodyChars,
						});
						return createSuccessResult("builtin-web-fetch", {
							url: currentUrl.toString(),
							status: response.status,
							contentType,
							body: extracted,
							truncated: truncatedBody.truncated,
							rawMarkdownLength: truncatedBody.value.length,
							extracted: true,
						});
					}

					return createSuccessResult("builtin-web-fetch", {
						url: currentUrl.toString(),
						status: response.status,
						contentType,
						body: truncatedBody.value,
						truncated: truncatedBody.truncated,
					});
				}

				/* c8 ignore next 3 -- unreachable: the redirect branch above returns at hop === maxRedirects, so the loop never falls through */
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
