import { z } from "zod";
import type { WriteAuthority } from "../../safety/write-authority.js";
import type { SandboxPolicy, SandboxRequest } from "../sandbox.js";
import type { ToolWithMetadata } from "../tool-metadata.js";
import type { ToolResult } from "../types.js";

/**
 * Minimal subset of the Stagehand v2 page surface we depend on. Keeping the
 * interface narrow lets us mock cleanly in tests and swap the underlying
 * runtime (vanilla Playwright vs Patchright via CDP) without touching this
 * tool.
 */
export interface StagehandLikePage {
	goto(
		url: string,
		options?: { readonly timeout?: number },
	): Promise<unknown>;
	waitForSelector(
		selector: string,
		options?: {
			readonly timeout?: number;
			readonly state?: "attached" | "visible" | "hidden" | "detached";
		},
	): Promise<unknown>;
	extract(args: { readonly instruction: string }): Promise<unknown>;
	act(args: { readonly action: string }): Promise<unknown>;
	observe(args: { readonly instruction: string }): Promise<unknown>;
}

export interface StagehandLike {
	init(): Promise<void>;
	readonly page: StagehandLikePage;
	close(): Promise<void>;
}

export type StagehandFactory = (config: {
	readonly cdpUrl?: string;
	readonly modelName?: string;
	readonly modelApiKey?: string;
}) => Promise<StagehandLike>;

export type WebBrowseMode = "extract" | "act" | "observe";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface WebBrowseToolOptions {
	readonly stagehandFactory?: StagehandFactory;
	readonly writeAuthority?: WriteAuthority;
	readonly cdpUrl?: string;
	readonly modelName?: string;
	readonly modelApiKey?: string;
	readonly defaultTimeoutMs?: number;
}

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

function summarizeInstruction(instruction: string): string {
	if (instruction.length <= 96) return instruction;
	return `${instruction.slice(0, 93)}...`;
}

const webBrowseSandboxPolicy: SandboxPolicy = (context) => {
	const { url, mode } = (context.parsedArguments ?? {}) as {
		url?: string;
		mode?: WebBrowseMode;
	};

	let destination: string | undefined;
	let protocol: string | undefined;
	if (typeof url === "string") {
		try {
			const parsed = new URL(url);
			destination = parsed.host;
			protocol = parsed.protocol.endsWith(":")
				? parsed.protocol.slice(0, -1)
				: parsed.protocol;
		} catch {
			destination = url;
		}
	}

	const request: SandboxRequest = {
		operation: "network",
		...(context.origin == null ? {} : { origin: context.origin }),
		signals: {
			network: {
				method: mode === "act" ? "POST" : "GET",
				sendsCredentials: false,
				...(destination ? { destination } : {}),
				...(protocol ? { protocol } : {}),
			},
		},
	};

	return request;
};

/* c8 ignore start -- only used when no stagehandFactory is injected; instantiates a real headless Chromium */
async function defaultStagehandFactory(config: {
	readonly cdpUrl?: string;
	readonly modelName?: string;
	readonly modelApiKey?: string;
}): Promise<StagehandLike> {
	const mod = (await import("@browserbasehq/stagehand")) as unknown as {
		readonly Stagehand: new (options: Record<string, unknown>) => StagehandLike;
	};
	const stagehandOptions: Record<string, unknown> = {
		env: "LOCAL",
		modelName: config.modelName ?? "gpt-4.1-mini",
		modelClientOptions: config.modelApiKey
			? { apiKey: config.modelApiKey }
			: undefined,
	};
	if (config.cdpUrl) {
		stagehandOptions.localBrowserLaunchOptions = { cdpUrl: config.cdpUrl };
	}
	return new mod.Stagehand(stagehandOptions);
}
/* c8 ignore stop */

export function createWebBrowseTool(
	options: WebBrowseToolOptions = {},
): ToolWithMetadata {
	const factory = options.stagehandFactory ?? defaultStagehandFactory;
	const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		name: "web_browse",
		description:
			"Open a URL in a headless browser (Stagehand) and run an LLM-driven extract / act / observe primitive against the rendered DOM. Use this for SPAs and JS-rendered pages where web_fetch is insufficient.",
		parameters: z.object({
			url: z.string().url(),
			instruction: z.string().min(1),
			mode: z.enum(["extract", "act", "observe"]).optional(),
			wait_for: z.string().optional(),
			timeout_ms: z.number().int().positive().optional(),
		}),
		category: "programmatic",
		riskLevel: "read",
		sandboxOperation: "network",
		sandboxPolicy: webBrowseSandboxPolicy,
		execute: async (args) => {
			const {
				url,
				instruction,
				mode = "extract",
				wait_for: waitFor,
				timeout_ms: timeoutMs,
			} = args as {
				url: string;
				instruction: string;
				mode?: WebBrowseMode;
				wait_for?: string;
				timeout_ms?: number;
			};

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(url);
			} catch (error) {
				return createErrorResult("builtin-web-browse", {
					error:
						error instanceof Error ? error.message : "Invalid URL provided",
				});
			}

			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				return createErrorResult("builtin-web-browse", {
					error: `Only http and https URLs are allowed: ${url}`,
				});
			}

			if (mode === "act") {
				if (options.writeAuthority == null) {
					return createErrorResult("builtin-web-browse", {
						error:
							"web_browse 'act' mode mutates page state and requires a configured WriteAuthority gate.",
					});
				}
				const decision = await options.writeAuthority.authorize({
					tool: "web_browse",
					riskLevel: "medium",
					summary: `Browser action on ${parsedUrl.host}: ${summarizeInstruction(instruction)}`,
					detail: `URL: ${url}\nInstruction: ${instruction}`,
					origin: "agent",
				});
				if (decision.kind === "deny") {
					return createErrorResult("builtin-web-browse", {
						error: `Browser action denied by WriteAuthority: ${decision.reason}`,
					});
				}
				/* c8 ignore start -- WriteAuthority.authorize() always resolves to allow or deny; this branch is defensive */
				if (decision.kind !== "allow") {
					return createErrorResult("builtin-web-browse", {
						error:
							"Browser action requires interactive confirmation that was not provided.",
					});
				}
				/* c8 ignore stop */
			}

			const effectiveTimeout = timeoutMs ?? defaultTimeout;
			const stagehand = await factory({
				cdpUrl: options.cdpUrl,
				modelName: options.modelName,
				modelApiKey: options.modelApiKey,
			});

			try {
				await stagehand.init();
				await stagehand.page.goto(parsedUrl.toString(), {
					timeout: effectiveTimeout,
				});

				if (waitFor) {
					await stagehand.page.waitForSelector(waitFor, {
						timeout: effectiveTimeout,
						state: "attached",
					});
				}

				let result: unknown;
				if (mode === "extract") {
					result = await stagehand.page.extract({ instruction });
				} else if (mode === "observe") {
					result = await stagehand.page.observe({ instruction });
				} else {
					result = await stagehand.page.act({ action: instruction });
				}

				return createSuccessResult("builtin-web-browse", {
					url: parsedUrl.toString(),
					mode,
					result: result ?? null,
				});
			} catch (error) {
				return createErrorResult("builtin-web-browse", {
					error: error instanceof Error ? error.message : "Browse failed",
				});
			} finally {
				try {
					await stagehand.close();
				} catch {
					/* swallow close errors so the original outcome is preserved */
				}
			}
		},
	};
}
