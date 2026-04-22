import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_BODY_CHARS = 16_384;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const ALLOWED_DNS_HOSTNAME = /^[a-z][a-z0-9.-]*$/i;
const SENSITIVE_HEADER_NAMES = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
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

function createPinnedLookup(resolvedAddress: ResolvedAddress) {
	return (
		_hostname: string,
		_options: unknown,
		callback: (error: Error | null, address: string, family: number) => void,
	) => {
		callback(null, resolvedAddress.address, resolvedAddress.family);
	};
}

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

function sanitizeHeaders(
	headers: Record<string, string> | undefined,
	url: URL,
	allowedAuthHosts: readonly string[] | undefined,
): Record<string, string> | undefined {
	if (headers == null) {
		return undefined;
	}

	const normalizedAllowedHosts = new Set(
		(allowedAuthHosts ?? []).map((hostname) => normalizeAuthHost(hostname)),
	);
	const requestHost = normalizeAuthHost(url.hostname);
	const shouldStripSensitiveHeaders = !normalizedAllowedHosts.has(requestHost);

	if (!shouldStripSensitiveHeaders) {
		return { ...headers };
	}

	const sanitizedHeaders: Record<string, string> = {};
	let strippedHeader = false;

	for (const [name, value] of Object.entries(headers)) {
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

function validateResponseContentType(response: Response): string {
	const contentType = response.headers.get("content-type") ?? "";
	const normalizedContentType =
		contentType.split(";")[0]?.trim().toLowerCase() ?? "";

	if (
		normalizedContentType === "" ||
		normalizedContentType.startsWith("text/") ||
		normalizedContentType === "application/json"
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

export interface WebFetchToolOptions {
	readonly allowedAuthHosts?: readonly string[];
	readonly dispatcherFactory?: DispatcherFactory;
	readonly fetcher?: Fetcher;
	readonly maxBodyChars?: number;
	readonly maxResponseBytes?: number;
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
			const {
				url,
				method = "GET",
				body,
				headers,
			} = args as {
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
			const dispatcherFactory =
				options.dispatcherFactory ??
				(options.fetcher == null
					? createDefaultDispatcherFactory()
					: undefined);
			const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
			const maxResponseBytes =
				options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

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

					const contentType = validateResponseContentType(response);
					validateResponseLength(response, maxResponseBytes);
					const responseBody = await readResponseText(
						response,
						maxResponseBytes,
					);
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
						contentType,
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
