import { z } from "zod";
import type { ToolResult } from "../types.js";
import type { ToolWithMetadata } from "../tool-metadata.js";

const DEFAULT_MAX_BODY_CHARS = 16_384;

type Fetcher = typeof fetch;

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

export interface WebFetchToolOptions {
	readonly fetcher?: Fetcher;
	readonly maxBodyChars?: number;
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

			try {
				const fetcher = options.fetcher ?? fetch;
				const response = await fetcher(url, {
					method,
					body,
					headers,
				});
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
					url,
					status: response.status,
					contentType: response.headers.get("content-type") ?? "",
					body: truncatedBody.value,
					truncated: truncatedBody.truncated,
				});
			} catch (error) {
				return createErrorResult("builtin-web-fetch", {
					error: error instanceof Error ? error.message : "Fetch failed",
				});
			}
		},
	};
}
