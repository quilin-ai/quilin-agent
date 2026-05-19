import { expect, type Page, type Route, test } from "@playwright/test";

type UiMessage = {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly parts: readonly Record<string, unknown>[];
};

const streamedPersistedMessages: readonly UiMessage[] = [
	{
		id: "user-fetch",
		role: "user",
		parts: [{ type: "text", text: "请用 web_fetch 抓取 example.com" }],
	},
	{
		id: "assistant-fetch",
		role: "assistant",
		parts: [
			{
				type: "dynamic-tool",
				toolName: "web_fetch",
				toolCallId: "tool-1",
				state: "output-available",
				input: { url: "https://example.com" },
				output: { title: "Example Domain" },
			},
			{ type: "text", text: "标题是 Example Domain。" },
		],
	},
] as const;

const restoredMessages: readonly UiMessage[] = [
	{
		id: "restore-user",
		role: "user",
		parts: [{ type: "text", text: "历史问题: 解释 Quilin" }],
	},
	{
		id: "restore-assistant",
		role: "assistant",
		parts: [{ type: "text", text: "历史回答: Quilin 是一个自演进 Agent 框架。" }],
	},
] as const;

function sse(chunks: readonly Record<string, unknown>[]): string {
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function routeSessionDetail(
	page: Page,
	sessionId: string,
	messages: readonly UiMessage[],
): Promise<void> {
	await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				session: {
					id: sessionId,
					title: sessionId,
					created_at: Date.now(),
					updated_at: Date.now(),
					message_count: messages.length,
				},
				messages,
			}),
		});
	});
}

test("chat appends persisted tool card and assistant reply without refresh", async ({ page }) => {
	const sessionId = `sc1-stream-${Date.now()}`;
	let submitted = false;

	await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
		if (!submitted) {
			await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				session: {
					id: sessionId,
					title: sessionId,
					created_at: Date.now(),
					updated_at: Date.now(),
					message_count: streamedPersistedMessages.length,
				},
				messages: streamedPersistedMessages,
			}),
		});
	});
	await page.route("**/api/chat/status?**", async (route: Route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				data: {
					exists: true,
					status: "completed",
					frameCount: 4,
					epoch: "e2e-epoch",
				},
			}),
		});
	});
	await page.route("**/api/chat", async (route: Route) => {
		submitted = true;
		await route.fulfill({
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"x-vercel-ai-ui-message-stream": "v1",
				"x-quilin-epoch": "e2e-epoch",
			},
			body: sse([
				{ type: "start", messageId: "assistant-live" },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "" },
				{ type: "text-end", id: "t1" },
				{ type: "finish", finishReason: "stop" },
			]),
		});
	});

	await page.goto(`/?session=${sessionId}`);
	await expect(page.getByText(/开始对话/)).toBeVisible();
	await page.getByTestId("composer-input").fill("请用 web_fetch 抓取 example.com");
	await page.getByTestId("composer-send").click();

	await expect(page.locator("[data-role='user']").getByText("请用 web_fetch")).toBeVisible();
	await expect(page.locator(".q-tool-call").filter({ hasText: "web_fetch" })).toBeVisible({
		timeout: 10_000,
	});
	await expect(
		page.locator("[data-role='assistant']").getByText("标题是 Example Domain。"),
	).toBeVisible();

	await page.screenshot({ path: "/tmp/quilin-sc1-stream-tool-card.png", fullPage: true });
});

test("sessions client-side link hydrates history without refresh", async ({ page }) => {
	const sessionId = `sc1-restore-${Date.now()}`;

	await page.route("**/api/sessions", async (route: Route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				persistenceEnabled: true,
				sessions: [
					{
						id: sessionId,
						title: "历史问题: 解释 Quilin",
						created_at: Date.now(),
						updated_at: Date.now(),
						message_count: restoredMessages.length,
						preview: "历史回答: Quilin 是一个自演进 Agent 框架。",
					},
				],
			}),
		});
	});
	await routeSessionDetail(page, sessionId, restoredMessages);
	await page.route("**/api/chat/status?**", async (route: Route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				data: { exists: false, status: null, frameCount: 0, epoch: "e2e-epoch" },
			}),
		});
	});

	await page.goto("/sessions");
	const sessionLink = page.locator(`a[href="/?session=${sessionId}"]`);
	await expect(sessionLink).toHaveCount(1);
	await sessionLink.click({ force: true });
	await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
	await expect(page.getByText("历史问题: 解释 Quilin")).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText("历史回答: Quilin 是一个自演进 Agent 框架。")).toBeVisible();
	await expect(page.getByText(/开始对话/)).toHaveCount(0);

	await page.screenshot({ path: "/tmp/quilin-sc1-session-hydration.png", fullPage: true });
});
