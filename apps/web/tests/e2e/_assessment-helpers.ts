/**
 * Shared helpers for the web E2E capability assessment spec
 * (`capability-assessment.spec.ts`). Each helper wraps the
 * navigate / wait / introspect pattern we used ad-hoc during the
 * 2026-05-13 evaluation cycle so individual test cases stay
 * declarative: prompt in, structured result out.
 *
 * 评测 spec 的共享 helper。每个 helper 封装"开新 session + 发 prompt +
 * 等流完 + 从 React fiber 读 UIMessage parts"的固定动作,让单测里只剩
 * "prompt 进,结构化结果出"的一行调用。
 */
import { expect, type Page } from "@playwright/test";

export interface AssistantSnapshot {
	readonly role: string;
	readonly partTypes: readonly string[];
	readonly textLen: number;
	readonly textPreview: string;
	readonly fullText: string;
	readonly toolCount: number;
	readonly tablesInDom: number;
	readonly codeBlocksInDom: number;
}

/**
 * Start a fresh session by navigating to `/?session=<sid>&initial=<prompt>`,
 * which the page auto-submits via its mount effect. Returns the
 * resolved sessionId so the caller can correlate with backend logs.
 *
 * 用 `?initial=` 自动提交首条 user message,这条路径绕开 type+Enter 焦点
 * 时序问题,适合 batch 用例。返回 sessionId 用于后续关联后端日志。
 */
export async function seedFreshSession(
	page: Page,
	prompt: string,
	options: { readonly idPrefix?: string } = {},
): Promise<string> {
	const sid = `${options.idPrefix ?? "cap"}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const url = `/?session=${encodeURIComponent(sid)}&initial=${encodeURIComponent(prompt)}`;
	await page.goto(url);
	return sid;
}

/**
 * Wait for the assistant turn to finish streaming. We watch for the
 * `data-streaming="true"` indicator (added by `TurnMessage` while
 * `streaming === true`) to flip back; if it never appeared the wait
 * exits when the assistant article body has ≥1 child text element
 * with non-empty content.
 *
 * 等流式结束:监听 `data-streaming` 指示器消失,或 fallback 到 article
 * 内已有有效内容。
 */
export async function awaitAssistantDone(
	page: Page,
	{ maxMs = 90_000 }: { readonly maxMs?: number } = {},
): Promise<void> {
	// First, wait for the assistant article to exist at all.
	await page.waitForSelector("article.q-turn[data-role='assistant']", {
		timeout: maxMs,
	});
	// Streaming-cursor element disappears when the assistant turn is
	// finalized. `q-stream-cursor` is rendered inline next to Streamdown
	// while `streaming === true` (see ConversationView.tsx) AND by
	// SubagentDetailView while a subagent is running/pending. We scope the
	// query to the main assistant article so the wait doesn't block on
	// stuck subagent panels (which can extend past the assistant's own
	// stream-end and produce partial Fiber snapshots).
	await page
		.waitForFunction(
			() =>
				document.querySelector("article.q-turn[data-role='assistant'] .q-stream-cursor") == null,
			null,
			{ timeout: maxMs, polling: 250 },
		)
		.catch(() => {
			/* if the cursor never showed, fall through */
		});
	// Give the RAF auto-scroll tail + Streamdown's final reparse time
	// to settle before reading state.
	await page.waitForTimeout(1500);
}

/**
 * Read the last assistant article from React Fiber state. Falls back
 * to `null` if the fiber walk doesn't find a `message.parts` prop
 * within 20 ancestors — that happens when the assistant article was
 * removed (rare; not in any current test).
 *
 * 从 React Fiber 直接拿 UIMessage parts,绕过 DOM 文本拼接误差。
 */
export async function lastAssistantSnapshot(page: Page): Promise<AssistantSnapshot | null> {
	return await page.evaluate(() => {
		const articles = document.querySelectorAll("article.q-turn");
		const last = articles[articles.length - 1];
		if (!last) return null;
		const fk = Object.keys(last).find((k) => k.startsWith("__reactFiber"));
		if (!fk) return null;
		// biome-ignore lint/suspicious/noExplicitAny: React Fiber introspection
		let fiber = (last as any)[fk];
		let attempt = 0;
		while (fiber && attempt < 20) {
			const mp = fiber.memoizedProps;
			if (mp?.message?.parts) {
				// biome-ignore lint/suspicious/noExplicitAny: AI SDK part shape
				const parts: any[] = mp.message.parts;
				const textParts = parts.filter((p) => p.type === "text");
				const tables = last.querySelectorAll("table").length;
				const codeBlocks = last.querySelectorAll("pre code").length;
				return {
					role: mp.message.role as string,
					partTypes: parts.map((p) => p.type as string),
					textLen: textParts.reduce(
						(s, p) => s + (typeof p.text === "string" ? p.text.length : 0),
						0,
					),
					textPreview: textParts
						.map((p) => p.text)
						.join("\n")
						.slice(0, 300),
					fullText: textParts.map((p) => p.text).join("\n"),
					toolCount: parts.filter(
						(p) =>
							typeof p.type === "string" &&
							(p.type.startsWith("tool-") || p.type === "dynamic-tool"),
					).length,
					tablesInDom: tables,
					codeBlocksInDom: codeBlocks,
				};
			}
			fiber = fiber.return;
			attempt++;
		}
		return null;
	});
}

/**
 * Read the count of console error messages currently captured by
 * Playwright's `page.on("console")` listener. The spec wires that up
 * in its `beforeEach`; this helper just exposes the count for
 * assertions.
 *
 * 拿 console error 计数,断言"无 React key 重复 / 无 useChat throw"等。
 */
export function expectNoConsoleErrors(
	errors: readonly string[],
	allowList: readonly RegExp[] = [],
): void {
	const real = errors.filter((e) => !allowList.some((rx) => rx.test(e)));
	if (real.length > 0) {
		throw new Error(
			`Unexpected console errors:\n${real.slice(0, 5).join("\n")}${real.length > 5 ? `\n…and ${real.length - 5} more` : ""}`,
		);
	}
}

/**
 * Convenience: full one-shot prompt → snapshot. Aggregates the
 * common pattern across most assessment cases.
 *
 * 一行起新 session 跑 prompt → 拿 snapshot,大部分用例直接用这个。
 */
export async function runAssessmentPrompt(
	page: Page,
	prompt: string,
	options: { readonly idPrefix?: string; readonly maxMs?: number } = {},
): Promise<{
	readonly sessionId: string;
	readonly snapshot: AssistantSnapshot;
}> {
	const sessionId = await seedFreshSession(page, prompt, options);
	await awaitAssistantDone(page, { maxMs: options.maxMs });
	const snapshot = await lastAssistantSnapshot(page);
	expect(snapshot).not.toBeNull();
	return { sessionId, snapshot: snapshot as AssistantSnapshot };
}
