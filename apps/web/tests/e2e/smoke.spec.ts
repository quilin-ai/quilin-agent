import { expect, test } from "@playwright/test";

test.describe("Quilin Web — smoke", () => {
	test("home page boots and shows the wordmark", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByText("Quilin")).toBeVisible();
		await expect(page.getByText("麒麟").first()).toBeVisible();
	});

	test("composer textarea renders on first load", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByTestId("composer")).toBeVisible();
		await expect(page.getByTestId("composer-input")).toBeVisible();
	});

	test("sessions page renders bilingual header even when backend is unreachable", async ({
		page,
	}) => {
		await page.goto("/sessions");
		await expect(page.getByRole("heading", { name: /Sessions/ })).toBeVisible();
		await expect(page.getByText("会话")).toBeVisible();
	});
});
