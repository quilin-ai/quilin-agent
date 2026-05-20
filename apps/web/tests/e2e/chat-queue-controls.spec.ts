import { expect, type Page, type Route, test } from "@playwright/test";

function deferred<T = void>(): {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function sseText(text: string): string {
	return [
		{ type: "start", messageId: `assistant-${Date.now().toString(36)}` },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
		{ type: "text-end", id: "t1" },
		{ type: "finish", finishReason: "stop" },
	]
		.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
		.join("")
		.concat("data: [DONE]\n\n");
}

async function routeEmptySession(page: Page, sessionId: string): Promise<void> {
	await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
		await route.fulfill({
			status: 404,
			contentType: "application/json",
			body: JSON.stringify({ error: "session not found" }),
		});
	});
}

async function routeAgents(page: Page): Promise<void> {
	await page.route("**/api/agents**", async (route: Route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ ok: true, data: { agents: [] } }),
		});
	});
}

async function submitComposer(page: Page, text: string): Promise<void> {
	await page.getByTestId("composer-input").fill(text);
	await page.getByTestId("composer-input").press("Enter");
}

async function queueTexts(page: Page): Promise<readonly string[]> {
	return page.locator(".q-queue-area-row-text").allInnerTexts();
}

test.describe("QUI-183 chat queue controls", () => {
	test("rapid-fire inputs stay in QueueArea, not the conversation, then drain without hanging", async ({
		page,
	}) => {
		const sessionId = `quilin-e2e-rapid-fire-${Date.now()}`;
		const statusGate = deferred();
		let statusRequests = 0;
		let chatPosts = 0;

		await routeEmptySession(page, sessionId);
		await routeAgents(page);
		await page.route("**/api/chat/status?**", async (route: Route) => {
			statusRequests += 1;
			if (statusRequests > 1) await statusGate.promise;
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: {
						exists: statusRequests > 1,
						status: statusRequests > 1 ? "completed" : null,
						frameCount: statusRequests > 1 ? 8 : 0,
						epoch: "e2e-queue-epoch",
					},
				}),
			});
		});
		await page.route("**/api/chat", async (route: Route) => {
			chatPosts += 1;
			await route.fulfill({
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					"x-vercel-ai-ui-message-stream": "v1",
					"x-quilin-epoch": "e2e-queue-epoch",
				},
				body: sseText(`收到第 ${chatPosts} 条。`),
			});
		});

		await page.goto(`/?session=${sessionId}`);
		await expect(page.getByTestId("composer")).toBeVisible();
		for (let i = 1; i <= 6; i += 1) {
			await submitComposer(page, `rapid fire ${i}`);
			await page.waitForTimeout(80);
		}

		await expect(page.getByTestId("queue-area")).toBeVisible();
		await expect(page.locator(".q-queue-area-row")).toHaveCount(6);
		await expect(page.locator("[data-role='user']")).toHaveCount(0);
		expect(chatPosts).toBe(0);

		statusGate.resolve();
		await expect.poll(() => chatPosts, { timeout: 10_000 }).toBeGreaterThan(0);
		await expect
			.poll(async () => page.locator(".q-queue-area-row").count(), { timeout: 15_000 })
			.toBeLessThan(6);
	});

	test("stop button cancels the active run and keeps queued prompts draining", async ({ page }) => {
		const sessionId = `quilin-e2e-stop-${Date.now()}`;
		const firstChatGate = deferred();
		let chatPosts = 0;
		let stopPosts = 0;

		await routeEmptySession(page, sessionId);
		await routeAgents(page);
		await page.route("**/api/chat/status?**", async (route: Route) => {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: { exists: true, status: "completed", frameCount: 10, epoch: "e2e-stop-epoch" },
				}),
			});
		});
		await page.route("**/api/chat/stop", async (route: Route) => {
			stopPosts += 1;
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: {
						sessionId,
						epoch: "e2e-stop-epoch",
						stopped: true,
						hadMeta: true,
						hadSession: true,
					},
				}),
			});
		});
		await page.route("**/api/chat", async (route: Route) => {
			chatPosts += 1;
			if (chatPosts === 1) {
				await firstChatGate.promise;
			}
			try {
				await route.fulfill({
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						"x-vercel-ai-ui-message-stream": "v1",
						"x-quilin-epoch": "e2e-stop-epoch",
					},
					body: sseText(`stop flow reply ${chatPosts}`),
				});
			} catch {
				// The first request may be aborted by useChat.stop(); the
				// assertion below cares that the queued second prompt posts.
			}
		});

		await page.goto(`/?session=${sessionId}`);
		await expect(page.getByTestId("composer")).toBeVisible();
		await submitComposer(page, "start a long run");
		await expect.poll(() => chatPosts, { timeout: 5000 }).toBe(1);
		await submitComposer(page, "queued after stop");
		await expect(page.getByTestId("queue-area")).toBeVisible();

		await page.getByTestId("composer-stop").click();
		await expect.poll(() => stopPosts, { timeout: 5000 }).toBe(1);
		firstChatGate.resolve();
		await expect.poll(() => chatPosts, { timeout: 10_000 }).toBeGreaterThan(1);
	});

	test("queued prompts can be deleted, moved, and pinned before drain", async ({ page }) => {
		const sessionId = `quilin-e2e-queue-controls-${Date.now()}`;
		const statusGate = deferred();

		await routeEmptySession(page, sessionId);
		await routeAgents(page);
		await page.route("**/api/chat/status?**", async (route: Route) => {
			await statusGate.promise;
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: { exists: true, status: "completed", frameCount: 3, epoch: "e2e-controls" },
				}),
			});
		});
		await page.route("**/api/chat", async (route: Route) => {
			await route.fulfill({
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					"x-vercel-ai-ui-message-stream": "v1",
					"x-quilin-epoch": "e2e-controls",
				},
				body: sseText("drained"),
			});
		});

		await page.goto(`/?session=${sessionId}`);
		await expect(page.getByTestId("composer")).toBeVisible();
		await submitComposer(page, "queue alpha");
		await submitComposer(page, "queue beta");
		await submitComposer(page, "queue gamma");
		await submitComposer(page, "queue delta");

		await expect(page.locator(".q-queue-area-row")).toHaveCount(4);
		expect(await queueTexts(page)).toEqual([
			"queue alpha",
			"queue beta",
			"queue gamma",
			"queue delta",
		]);

		await page.getByTestId(`queue-row-${sessionId}-queued-2-delete`).click();
		await expect(page.locator(".q-queue-area-row")).toHaveCount(3);
		expect(await queueTexts(page)).toEqual(["queue alpha", "queue gamma", "queue delta"]);

		await page.getByTestId(`queue-row-${sessionId}-queued-1-move-down`).click();
		expect(await queueTexts(page)).toEqual(["queue gamma", "queue alpha", "queue delta"]);

		await page.getByTestId(`queue-row-${sessionId}-queued-4-move-up`).click();
		expect(await queueTexts(page)).toEqual(["queue gamma", "queue delta", "queue alpha"]);

		// QUI-183 P3 UX 改进:置顶按钮 testid 从 -pin-top 改为 -jump
		// (语义改为"立即插入",functionality 等价 move-to-head)
		await page.getByTestId(`queue-row-${sessionId}-queued-1-jump`).click();
		expect(await queueTexts(page)).toEqual(["queue alpha", "queue gamma", "queue delta"]);
	});
});
