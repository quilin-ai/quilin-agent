#!/usr/bin/env bun
/**
 * Phase 2 E2E for web_browse (Stagehand + Patchright).
 *
 * Run: bun run packages/agent-core/scripts/e2e-web-browse.ts
 *
 * Acceptance points verified:
 *   TC-01  extract mode returns structured data from a real SPA
 *   TC-02  observe mode lists interactive elements
 *   TC-03  act mode — ask-mode WriteAuthority fires confirm callback
 *   TC-04  act mode — auto-medium lets the action through
 *   TC-05  act mode — deny-all rejects before browser launch
 *   TC-06  wait_for blocks until the injected element appears (500ms delay)
 *   TC-07  non-http URL is rejected
 *   TC-08  URL with userinfo is rejected (currently a known defect)
 *   TC-09  no Chromium process leak after tool closes
 *
 * Strategy: stub the Stagehand AI primitives (extract / observe / act) so no
 * LLM API key is required, while launching a real Patchright Chromium browser
 * for navigation, waitForSelector, and click sub-cases.
 * The fixture HTML is served over http://127.0.0.1 via Bun.serve() so that
 * the tool's http/https guard does not reject file:// URLs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WriteRequest } from "../src/safety/write-authority.js";
import { WriteAuthority } from "../src/safety/write-authority.js";
import {
	createWebBrowseTool,
	type StagehandFactory,
	type StagehandLike,
	type StagehandLikePage,
} from "../src/tools/builtin/web-browse.js";

// ---------------------------------------------------------------------------
// Fixture HTTP server
// ---------------------------------------------------------------------------
const FIXTURE_PATH = path.resolve(
	import.meta.dir,
	"../tests-e2e/fixtures/spa.html",
);
const fixtureHtml = fs.readFileSync(FIXTURE_PATH, "utf8");

const server = Bun.serve({
	port: 0, // OS picks an available port
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/" || url.pathname === "/spa.html") {
			return new Response(fixtureHtml, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
		return new Response("Not Found", { status: 404 });
	},
});

const FIXTURE_URL = `http://127.0.0.1:${server.port}/spa.html`;
process.stdout.write(`[fixture] Serving spa.html at ${FIXTURE_URL}\n`);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface CaseResult {
	readonly name: string;
	readonly status: "pass" | "fail" | "skip";
	readonly notes: string;
	readonly observed?: unknown;
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

// ---------------------------------------------------------------------------
// Real-browser stagehand factory
//
// Launches a real Patchright Chromium page for navigation and DOM operations.
// The AI primitives (extract / observe / act) are stubbed with canned returns
// because no LLM API key is available in this environment.
// ---------------------------------------------------------------------------
async function makePatchrightFactory(opts: {
	extractResult: unknown;
	observeResult: unknown;
	actResult: unknown;
	preExtractHook?: (page: import("patchright").Page) => Promise<void>;
}): Promise<StagehandFactory> {
	const patchright = await import("patchright").catch(() => null);
	if (patchright == null) {
		throw new Error(
			"patchright module not found — run: cd packages/agent-core && pnpm exec patchright install chromium",
		);
	}

	return async (_config) => {
		const browser = await patchright.chromium.launch({ headless: true });
		const context = await browser.newContext();
		const playwrightPage = await context.newPage();

		const stubbedPage: StagehandLikePage = {
			async goto(url, options) {
				await playwrightPage.goto(url, { timeout: options?.timeout ?? 60_000 });
			},
			async waitForSelector(selector, options) {
				await playwrightPage.waitForSelector(selector, {
					timeout: options?.timeout ?? 60_000,
					state:
						options?.state === "hidden" || options?.state === "detached"
							? options.state
							: "attached",
				});
			},
			async extract(_args) {
				if (opts.preExtractHook) {
					await opts.preExtractHook(playwrightPage);
				}
				return opts.extractResult;
			},
			async observe(_args) {
				return opts.observeResult;
			},
			async act(_args) {
				// Simulate a real DOM interaction: click the #load button
				await playwrightPage.click("#load");
				return opts.actResult;
			},
		};

		const stagehandLike: StagehandLike = {
			async init() {
				/* no-op — page already alive */
			},
			get page() {
				return stubbedPage;
			},
			async close() {
				await browser.close();
			},
		};

		return stagehandLike;
	};
}

// Pure stub factory — does NOT launch a browser (for URL-validation and
// WriteAuthority-only tests where browser launch shouldn't happen)
function makePureStubFactory(
	result: unknown = { stubbed: true },
): StagehandFactory {
	return async (_config) => {
		const stubbedPage: StagehandLikePage = {
			async goto(_url, _opts) {},
			async waitForSelector(_sel, _opts) {},
			async extract(_args) {
				return result;
			},
			async observe(_args) {
				return result;
			},
			async act(_args) {
				return result;
			},
		};
		return {
			async init() {},
			get page() {
				return stubbedPage;
			},
			async close() {},
		};
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	const results: CaseResult[] = [];

	// Check patchright availability early
	const patchright = await import("patchright").catch(() => null);
	const patchrightAvailable = patchright != null;

	if (!patchrightAvailable) {
		process.stdout.write(
			"[WARN] patchright not importable — real-browser cases will be skipped.\n",
		);
	}

	// -------------------------------------------------------------------------
	// TC-01: extract mode returns structured data from a real SPA
	// -------------------------------------------------------------------------
	results.push(
		await runCase("TC-01 extract mode returns structured data", async () => {
			if (!patchrightAvailable) {
				return { status: "skip", notes: "patchright not available" };
			}

			const extractResult = {
				title: "Test Page",
				description:
					"A minimal SPA fixture for web_browse E2E acceptance tests.",
			};
			const factory = await makePatchrightFactory({
				extractResult,
				observeResult: [],
				actResult: {},
			});
			const tool = createWebBrowseTool({ stagehandFactory: factory });

			const result = await tool.execute({
				url: FIXTURE_URL,
				instruction: "extract title and description",
				mode: "extract",
			});

			const payload = JSON.parse(result.content) as {
				mode: string;
				result: unknown;
				error?: string;
			};

			const ok =
				!result.isError &&
				payload.mode === "extract" &&
				JSON.stringify(payload.result) === JSON.stringify(extractResult);

			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? "mode=extract, structured payload returned, browser closed cleanly"
					: `expected extract payload, got: ${JSON.stringify(payload)}`,
				observed: payload,
			};
		}),
	);

	// -------------------------------------------------------------------------
	// TC-02: observe mode lists interactive elements
	// -------------------------------------------------------------------------
	results.push(
		await runCase("TC-02 observe mode lists interactive elements", async () => {
			if (!patchrightAvailable) {
				return { status: "skip", notes: "patchright not available" };
			}

			const observeResult = [
				{ selector: "#load", description: "Load Price button" },
				{ selector: "#search", description: "Search input" },
				{ selector: ".item", description: "Item links" },
			];
			const factory = await makePatchrightFactory({
				extractResult: {},
				observeResult,
				actResult: {},
			});
			const tool = createWebBrowseTool({ stagehandFactory: factory });

			const result = await tool.execute({
				url: FIXTURE_URL,
				instruction: "list all interactive elements",
				mode: "observe",
			});

			const payload = JSON.parse(result.content) as {
				mode: string;
				result: unknown;
				error?: string;
			};

			const ok =
				!result.isError &&
				payload.mode === "observe" &&
				Array.isArray(payload.result) &&
				(payload.result as unknown[]).length > 0;

			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? `mode=observe, ${(payload.result as unknown[]).length} elements listed`
					: `expected observe array, got: ${JSON.stringify(payload)}`,
				observed: payload,
			};
		}),
	);

	// -------------------------------------------------------------------------
	// TC-03: act mode — ask-mode WriteAuthority fires confirm callback
	// -------------------------------------------------------------------------
	results.push(
		await runCase(
			"TC-03 act mode — ask-mode WriteAuthority fires confirm callback",
			async () => {
				const confirmCalls: WriteRequest[] = [];
				const writeAuthority = new WriteAuthority({
					mode: "ask",
					confirm: async (req) => {
						confirmCalls.push(req);
						return true; // approve
					},
				});
				const factory = makePureStubFactory({ clicked: true });
				const tool = createWebBrowseTool({
					stagehandFactory: factory,
					writeAuthority,
				});

				const result = await tool.execute({
					url: "https://example.com/",
					instruction: "click the submit button",
					mode: "act",
				});

				const payload = JSON.parse(result.content) as {
					mode: string;
					result: unknown;
					error?: string;
				};

				const firstConfirm = confirmCalls[0];
				const ok =
					!result.isError &&
					payload.mode === "act" &&
					confirmCalls.length === 1 &&
					firstConfirm?.tool === "web_browse" &&
					firstConfirm?.riskLevel === "medium";

				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? `confirm callback fired once, riskLevel=${confirmCalls[0]?.riskLevel}, tool=${confirmCalls[0]?.tool}`
						: `expected 1 confirm call + act success; isError=${result.isError} confirmCalls=${confirmCalls.length}`,
					observed: {
						payload,
						confirmCalls: confirmCalls.map((c) => ({
							tool: c.tool,
							riskLevel: c.riskLevel,
							origin: c.origin,
						})),
					},
				};
			},
		),
	);

	// -------------------------------------------------------------------------
	// TC-04: act mode — auto-medium lets action through without confirm
	// -------------------------------------------------------------------------
	results.push(
		await runCase(
			"TC-04 act mode — auto-medium lets action through without confirm",
			async () => {
				const confirmCalls: WriteRequest[] = [];
				const writeAuthority = new WriteAuthority({
					mode: "auto-medium",
					confirm: async (req) => {
						confirmCalls.push(req);
						return true;
					},
				});
				const factory = makePureStubFactory({ autoClicked: true });
				const tool = createWebBrowseTool({
					stagehandFactory: factory,
					writeAuthority,
				});

				const result = await tool.execute({
					url: "https://example.com/",
					instruction: "click submit",
					mode: "act",
				});

				const payload = JSON.parse(result.content) as {
					mode: string;
					result: unknown;
					error?: string;
				};

				// auto-medium should allow without invoking the confirm hook
				const ok =
					!result.isError &&
					payload.mode === "act" &&
					confirmCalls.length === 0;

				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? "auto-medium allowed act without calling confirm hook"
						: `expected 0 confirm calls + act pass; confirmCalls=${confirmCalls.length} isError=${result.isError}`,
					observed: { payload, confirmCallCount: confirmCalls.length },
				};
			},
		),
	);

	// -------------------------------------------------------------------------
	// TC-05: act mode — deny-all rejects, browser never launched
	// -------------------------------------------------------------------------
	results.push(
		await runCase(
			"TC-05 act mode — deny-all rejects without launching browser",
			async () => {
				const writeAuthority = new WriteAuthority({ mode: "deny-all" });
				let factoryCallCount = 0;
				const factory: StagehandFactory = async (cfg) => {
					factoryCallCount++;
					return makePureStubFactory()(cfg);
				};
				const tool = createWebBrowseTool({
					stagehandFactory: factory,
					writeAuthority,
				});

				const result = await tool.execute({
					url: "https://example.com/",
					instruction: "click dangerous button",
					mode: "act",
				});

				const payload = JSON.parse(result.content) as { error?: string };

				const ok =
					result.isError &&
					/denied/i.test(payload.error ?? "") &&
					factoryCallCount === 0;

				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? `denied before browser launch; factoryCallCount=${factoryCallCount}`
						: `expected isError+denied+factoryCallCount=0; isError=${result.isError} error=${payload.error} factoryCallCount=${factoryCallCount}`,
					observed: { payload, factoryCallCount },
				};
			},
		),
	);

	// -------------------------------------------------------------------------
	// TC-06: wait_for blocks until injected element appears (500ms delay)
	// -------------------------------------------------------------------------
	results.push(
		await runCase(
			"TC-06 wait_for blocks until injected #price element appears (500ms delay)",
			async () => {
				const waitForFactory: StagehandFactory = async (_config) => {
					let priceVisible = false;
					let closed = false;

					const stubbedPage: StagehandLikePage = {
						async goto(_url, _options) {
							setTimeout(() => {
								priceVisible = true;
							}, 500);
						},
						async waitForSelector(selector, options) {
							const deadline = Date.now() + (options?.timeout ?? 60_000);
							while (Date.now() < deadline) {
								if (closed) throw new Error("stub browser closed");
								if (selector === "#price" && priceVisible) return;
								await new Promise((resolve) => setTimeout(resolve, 25));
							}
							throw new Error(`Timed out waiting for selector: ${selector}`);
						},
						async extract(_args) {
							return { price: priceVisible ? "$42" : null };
						},
						async observe(_args) {
							return [];
						},
						async act(_args) {
							return {};
						},
					};

					return {
						async init() {},
						get page() {
							return stubbedPage;
						},
						async close() {
							closed = true;
						},
					};
				};

				const tool = createWebBrowseTool({ stagehandFactory: waitForFactory });
				const start = Date.now();
				const result = await tool.execute({
					url: FIXTURE_URL,
					instruction: "extract price",
					mode: "extract",
					wait_for: "#price",
					timeout_ms: 5_000,
				});
				const elapsed = Date.now() - start;

				const payload = JSON.parse(result.content) as {
					mode: string;
					result: { price?: string };
					error?: string;
				};

				const priceValue = payload.result?.price;
				// Must have waited at least 400ms for the 500ms timer and found $42
				const ok = !result.isError && priceValue === "$42" && elapsed >= 400;

				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? `wait_for resolved after ${elapsed}ms, price="${priceValue}"`
						: `expected price=$42 after >=400ms; price="${priceValue}" elapsed=${elapsed}ms isError=${result.isError} error=${payload.error}`,
					observed: { payload, elapsedMs: elapsed },
				};
			},
		),
	);

	// -------------------------------------------------------------------------
	// TC-07: non-http URL is rejected
	// -------------------------------------------------------------------------
	results.push(
		await runCase("TC-07 file:// URL is rejected", async () => {
			const factory = makePureStubFactory();
			const tool = createWebBrowseTool({ stagehandFactory: factory });

			const result = await tool.execute({
				url: "file:///etc/passwd",
				instruction: "read",
			});

			const payload = JSON.parse(result.content) as { error?: string };
			const ok = result.isError && /http/i.test(payload.error ?? "");

			return {
				status: ok ? "pass" : "fail",
				notes: ok
					? `correctly rejected: ${payload.error}`
					: `expected http-only rejection; isError=${result.isError} error=${payload.error}`,
				observed: payload,
			};
		}),
	);

	// -------------------------------------------------------------------------
	// TC-08: URL with userinfo — expected rejection
	// -------------------------------------------------------------------------
	results.push(
		await runCase(
			"TC-08 URL with userinfo (user:pass@host) is rejected",
			async () => {
				// Use a pure stub so we do not actually reach any server
				const factory = makePureStubFactory();
				const tool = createWebBrowseTool({ stagehandFactory: factory });

				const result = await tool.execute({
					url: "https://user:pass@example.com/",
					instruction: "read",
				});

				const payload = JSON.parse(result.content) as {
					error?: string;
					mode?: string;
					url?: string;
				};

				if (
					result.isError &&
					/userinfo credentials/i.test(payload.error ?? "") &&
					!payload.error?.includes("user:pass")
				) {
					return {
						status: "pass",
						notes: `correctly rejected userinfo: ${payload.error}`,
						observed: payload,
					};
				}

				// Defect: tool accepted a URL with embedded credentials or returned an unexpected error
				return {
					status: "fail",
					notes: `DEFECT: userinfo URL was not rejected as expected; actual URL used: ${payload.url ?? "(unknown)"}.`,
					observed: payload,
				};
			},
		),
	);

	// -------------------------------------------------------------------------
	// TC-09: no Chromium process leak after tool closes
	// -------------------------------------------------------------------------
	results.push(
		await runCase(
			"TC-09 no Chromium process leak after tool closes",
			async () => {
				if (!patchrightAvailable) {
					return {
						status: "skip",
						notes: "patchright not available — skipping leak check",
					};
				}

				// Count patchright/chromium-related processes before launch
				const countProcs = () => {
					const proc = Bun.spawnSync([
						"bash",
						"-c",
						"pgrep -fl 'chrome\\|chromium' 2>/dev/null | grep -v grep | wc -l | tr -d ' '",
					]);
					return parseInt(proc.stdout.toString().trim() || "0", 10);
				};

				const beforeCount = countProcs();

				// Launch and close a browser through the tool
				const factory = await makePatchrightFactory({
					extractResult: { done: true },
					observeResult: [],
					actResult: {},
				});
				const tool = createWebBrowseTool({ stagehandFactory: factory });
				const execResult = await tool.execute({
					url: FIXTURE_URL,
					instruction: "extract page title",
					mode: "extract",
				});

				// Allow OS to clean up child processes
				await new Promise((resolve) => setTimeout(resolve, 500));

				const afterCount = countProcs();
				const delta = afterCount - beforeCount;

				const ok = !execResult.isError && delta <= 0;

				return {
					status: ok ? "pass" : "fail",
					notes: ok
						? `no leak: before=${beforeCount}, after=${afterCount}, delta=${delta}`
						: `LEAK detected: before=${beforeCount}, after=${afterCount}, delta=${delta}; isError=${execResult.isError}`,
					observed: {
						beforeCount,
						afterCount,
						delta,
						execIsError: execResult.isError,
					},
				};
			},
		),
	);

	// -------------------------------------------------------------------------
	// Shutdown fixture server
	// -------------------------------------------------------------------------
	server.stop();

	// -------------------------------------------------------------------------
	// Summary
	// -------------------------------------------------------------------------
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
