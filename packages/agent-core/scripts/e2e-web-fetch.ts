#!/usr/bin/env bun
/**
 * Phase 1 E2E for web_fetch against real network.
 *
 * Run: bun run packages/agent-core/scripts/e2e-web-fetch.ts
 *
 * Verifies behaviors that mocks cannot: real DNS / SSRF guard, real Turndown
 * conversion on production HTML, real LRU cache, real redirect handling,
 * real wire content-type validation. LLM extraction is wired through a stub
 * (no API key required) — the unit tests already mock-verify the LLMClient
 * contract; the e2e value here is "with real markdown, the prompt path round-trips."
 */

import type { AssembledPrompt } from "../src/context/prompt-types.js";
import type {
	InferenceConfig,
	LLMClient,
	LLMResponse,
} from "../src/llm/types.js";
import type { Message } from "../src/state/types.js";
import type { Tool } from "../src/tools/types.js";
import {
	createWebFetchCache,
	createWebFetchTool,
} from "../src/tools/builtin/web-fetch.js";

interface CaseResult {
	readonly name: string;
	readonly status: "pass" | "fail" | "skip";
	readonly notes: string;
	readonly observed?: unknown;
}

const stubLlm: LLMClient = {
	async chat(
		_messages: readonly Message[],
		_tools: readonly Tool[],
		_config: InferenceConfig,
		_prompt?: AssembledPrompt,
	): Promise<LLMResponse> {
		return {
			content: "[STUB LLM EXTRACTION] focused answer derived from markdown",
			usage: { inputTokens: 100, outputTokens: 20 },
			finishReason: "stop",
		};
	},
};

interface ToolPayload {
	readonly url?: string;
	readonly status?: number;
	readonly contentType?: string;
	readonly body?: string;
	readonly truncated?: boolean;
	readonly fromCache?: boolean;
	readonly extracted?: boolean;
	readonly rawMarkdownLength?: number;
	readonly type?: string;
	readonly originalUrl?: string;
	readonly redirectUrl?: string;
	readonly error?: string;
}

function abridge(value: unknown, max = 600): unknown {
	const text = JSON.stringify(value);
	if (text == null) return value;
	if (text.length <= max) return value;
	return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

async function runCase(
	name: string,
	body: () => Promise<{
		readonly status: "pass" | "fail" | "skip";
		readonly notes: string;
		readonly observed?: unknown;
	}>,
): Promise<CaseResult> {
	process.stdout.write(`\n=== ${name} ===\n`);
	try {
		const out = await body();
		process.stdout.write(
			`> ${out.status.toUpperCase()} — ${out.notes}\n${
				out.observed == null
					? ""
					: `observed: ${JSON.stringify(abridge(out.observed))}\n`
			}`,
		);
		return { name, ...out };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`> FAIL — threw: ${message}\n`);
		return { name, status: "fail", notes: `threw: ${message}` };
	}
}

async function main() {
	const cache = createWebFetchCache();
	const tool = createWebFetchTool({ cache, llmClient: stubLlm });
	const results: CaseResult[] = [];

	results.push(
		await runCase(
			"TC-01 static site example.com → clean markdown",
			async () => {
				const result = await tool.execute({ url: "https://example.com" });
				const payload = JSON.parse(result.content) as ToolPayload;
				const ok =
					!result.isError &&
					payload.status === 200 &&
					typeof payload.body === "string" &&
					payload.body.includes("Example Domain") &&
					payload.fromCache !== true;
				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? "200 OK, markdown contains 'Example Domain', not from cache"
						: "expected 200 + 'Example Domain' + uncached",
					observed: payload,
				};
			},
		),
	);

	results.push(
		await runCase("TC-02 cache hit on repeat fetch", async () => {
			const result = await tool.execute({ url: "https://example.com" });
			const payload = JSON.parse(result.content) as ToolPayload;
			const ok = !result.isError && payload.fromCache === true;
			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? "fromCache=true on second call to same URL"
					: "expected fromCache=true",
				observed: payload,
			};
		}),
	);

	results.push(
		await runCase(
			"TC-03 long article wikipedia/Markdown → 100KB cap respected",
			async () => {
				const result = await tool.execute({
					url: "https://en.wikipedia.org/wiki/Markdown",
				});
				const payload = JSON.parse(result.content) as ToolPayload;
				if (result.isError) {
					return {
						status: "skip",
						notes: `network skip: ${payload.error ?? "fetch failed"}`,
						observed: payload,
					};
				}
				const len = payload.body?.length ?? 0;
				const ok = len > 5_000 && len <= 100_000;
				return {
					status: ok ? "pass" : "fail",
					notes: `body length=${len}, truncated=${payload.truncated}; cap=100000`,
					observed: { ...payload, body: `${payload.body?.slice(0, 200)}…` },
				};
			},
		),
	);

	results.push(
		await runCase("TC-04 same-host redirect auto-follows", async () => {
			const result = await tool.execute({
				url: "https://httpbin.org/redirect/1",
			});
			const payload = JSON.parse(result.content) as ToolPayload;
			if (result.isError) {
				return {
					status: "skip",
					notes: `httpbin skip: ${payload.error}`,
					observed: payload,
				};
			}
			const ok =
				payload.status === 200 && payload.url?.includes("httpbin.org/get");
			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? `same-host /redirect/1 → ${payload.url}`
					: `expected end-url /get, got ${payload.url}`,
				observed: { url: payload.url, status: payload.status },
			};
		}),
	);

	results.push(
		await runCase(
			"TC-05 cross-host redirect → structured response (no auto-follow)",
			async () => {
				const result = await tool.execute({
					url: "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F",
				});
				const payload = JSON.parse(result.content) as ToolPayload;
				if (result.isError) {
					return {
						status: "skip",
						notes: `httpbin skip: ${payload.error}`,
						observed: payload,
					};
				}
				const ok =
					payload.type === "redirect" &&
					payload.redirectUrl?.startsWith("https://example.com");
				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? `type=redirect, redirectUrl=${payload.redirectUrl}`
						: `expected type=redirect to example.com, got ${JSON.stringify(payload)}`,
					observed: payload,
				};
			},
		),
	);

	results.push(
		await runCase(
			"TC-06 prompt parameter (uncached URL) → stub LLMClient extracts",
			async () => {
				const result = await tool.execute({
					url: "https://www.iana.org/help/example-domains",
					prompt: "What is this page about?",
				});
				const payload = JSON.parse(result.content) as ToolPayload;
				const ok =
					!result.isError &&
					payload.extracted === true &&
					payload.body ===
						"[STUB LLM EXTRACTION] focused answer derived from markdown";
				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? "extracted=true, body is stub LLM output, rawMarkdownLength preserved"
						: "expected extracted=true with stub body",
					observed: payload,
				};
			},
		),
	);

	results.push(
		await runCase(
			"TC-06b BUG: cache short-circuits before LLM extraction",
			async () => {
				// example.com is already cached from TC-01/02. Passing prompt
				// SHOULD route through the LLM; the cache check at web-fetch.ts:665
				// returns raw markdown before considering the prompt parameter.
				const result = await tool.execute({
					url: "https://example.com",
					prompt: "What is the page about?",
				});
				const payload = JSON.parse(result.content) as ToolPayload;
				const bugReproduces =
					!result.isError &&
					payload.fromCache === true &&
					payload.extracted !== true;
				return {
					status: bugReproduces ? "fail" : "pass",
					notes: bugReproduces
						? "BUG REPRODUCED: prompt ignored on cache hit (fromCache=true, extracted!=true)"
						: "prompt now routes through LLM even when cached — bug fixed?",
					observed: payload,
				};
			},
		),
	);

	results.push(
		await runCase("TC-07 file:// URL → blocked", async () => {
			const result = await tool.execute({ url: "file:///etc/passwd" });
			const payload = JSON.parse(result.content) as ToolPayload;
			const ok = result.isError && /http/.test(payload.error ?? "");
			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? `rejected with ${JSON.stringify(payload.error)}`
					: "expected http-only rejection",
				observed: payload,
			};
		}),
	);

	results.push(
		await runCase("TC-08 URL with userinfo → blocked", async () => {
			const result = await tool.execute({
				url: "https://user:pass@example.com",
			});
			const payload = JSON.parse(result.content) as ToolPayload;
			const ok =
				result.isError && /userinfo/i.test(payload.error ?? "");
			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? `rejected with ${JSON.stringify(payload.error)}`
					: "expected userinfo rejection",
				observed: payload,
			};
		}),
	);

	results.push(
		await runCase(
			"TC-09 unsupported content type (PDF) → error",
			async () => {
				const result = await tool.execute({
					url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
				});
				const payload = JSON.parse(result.content) as ToolPayload;
				if (
					!result.isError &&
					payload.contentType?.toLowerCase().startsWith("text/")
				) {
					return {
						status: "skip",
						notes: `upstream returned ${payload.contentType}, not application/pdf`,
						observed: payload,
					};
				}
				const ok =
					result.isError && /unsupported content type/i.test(payload.error ?? "");
				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? `rejected with ${JSON.stringify(payload.error)}`
						: `expected unsupported-content-type, got error=${payload.error}`,
					observed: payload,
				};
			},
		),
	);

	const tally = {
		pass: results.filter((r) => r.status === "pass").length,
		fail: results.filter((r) => r.status === "fail").length,
		skip: results.filter((r) => r.status === "skip").length,
	};

	process.stdout.write(
		`\n=== summary: ${tally.pass} pass, ${tally.fail} fail, ${tally.skip} skip (of ${results.length}) ===\n`,
	);

	process.exit(tally.fail > 0 ? 1 : 0);
}

await main();
