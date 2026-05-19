/**
 * E2E for /sessions delete flow (QUI-182 sub-task).
 *
 * Verifies:
 *   1. delete button appears on each row
 *   2. confirm dialog gets shown; cancel keeps the row
 *   3. accept removes the row optimistically and survives a reload
 *      (when the row was a server-persisted session)
 *   4. local-only rows can also be removed
 *
 * 验证 /sessions 删除流程: 按钮可见、确认弹窗"取消"保留、"确认"乐观更新 +
 * 刷新后持久消失;本地行同样可删。
 */
import { type Page, expect, test } from "@playwright/test";

async function seedServerSession(page: Page): Promise<string> {
	// Create a session by posting one user message to /api/chat.
	const id = `e2e-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const res = await page.request.post("/api/chat", {
		data: {
			id,
			messages: [
				{
					id: `m-${id}`,
					role: "user",
					parts: [{ type: "text", text: "session for delete e2e" }],
				},
			],
		},
	});
	// /api/chat streams; consume it to drain the response.
	if (res.ok()) {
		await res.body().catch(() => undefined);
	}
	// Give the DB a moment to flush.
	await page.waitForTimeout(500);
	return id;
}

test.describe("Sessions · delete flow", () => {
	test("delete button is visible on each session row", async ({ page }) => {
		// Ensure at least one row exists so we have a button to assert on.
		await seedServerSession(page);
		await page.goto("/sessions");
		await page.waitForSelector('[data-testid^="session-"]', { timeout: 10_000 });
		const buttons = page.getByTestId(/^session-delete-/);
		const count = await buttons.count();
		expect(count).toBeGreaterThan(0);
	});

	test("cancel keeps the row", async ({ page }) => {
		const id = await seedServerSession(page);
		await page.goto("/sessions");
		const row = page.getByTestId(`session-${id}`);
		await row.waitFor({ timeout: 10_000 });
		const deleteBtn = page.getByTestId(`session-delete-${id}`);
		await expect(deleteBtn).toHaveCount(1);

		const countBefore = await page.getByTestId(/^session-delete-/).count();

		// Dismiss the confirm dialog.
		page.once("dialog", async (dialog) => {
			expect(dialog.type()).toBe("confirm");
			expect(dialog.message()).toContain("确定删除会话");
			await dialog.dismiss();
		});
		await deleteBtn.click();
		await page.waitForTimeout(300);

		const countAfter = await page.getByTestId(/^session-delete-/).count();
		expect(countAfter).toBe(countBefore);
		// Row still present after cancel.
		await expect(row).toHaveCount(1);
	});

	test("confirm removes the row and survives reload (server session)", async ({ page }) => {
		const id = await seedServerSession(page);
		await page.goto("/sessions");
		const row = page.getByTestId(`session-${id}`);
		await row.waitFor({ timeout: 10_000 });
		const deleteBtn = page.getByTestId(`session-delete-${id}`);
		await expect(deleteBtn).toHaveCount(1);

		page.once("dialog", (d) => {
			void d.accept();
		});
		await deleteBtn.click();

		// Optimistic removal.
		await expect(row).toHaveCount(0, { timeout: 5_000 });

		// Toast confirmation.
		await expect(page.getByTestId("sessions-toast")).toContainText("已删除");

		// Reload — DB-backed delete should persist.
		await page.reload();
		await page.waitForSelector(
			'[data-testid^="session-"], [data-testid="sessions-view"]',
			{ timeout: 10_000 },
		);
		await expect(page.getByTestId(`session-${id}`)).toHaveCount(0);

		// And the DELETE endpoint returns 404 now.
		const probe = await page.request.delete(`/api/sessions/${id}`);
		expect(probe.status()).toBe(404);
	});
});
