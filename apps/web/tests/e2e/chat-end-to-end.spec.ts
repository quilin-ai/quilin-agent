import { test, expect } from "@playwright/test";

test("intro → submit → see streaming Claude response in conversation", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/");
  await expect(page.locator(".q-wordmark-intro")).toBeVisible();
  await page.screenshot({ path: "/tmp/quilin-1-intro.png" });

  // Type + submit
  await page.locator(".q-composer-input").first().fill("用 5 个字介绍 Quilin");
  await page.locator(".q-composer-send").click();
  await page.waitForURL(/session=draft-.*initial=/, { timeout: 5000 });

  // Wait for the user message to appear
  await expect(page.locator('[data-role="user"]').first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: "/tmp/quilin-2-user-message.png" });

  // Wait for assistant streaming response
  await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });
  // Wait for at least some text content
  const assistant = page.locator('[data-role="assistant"] .q-turn-body p').first();
  await expect(assistant).toContainText(/.{3,}/, { timeout: 30000 });
  const assistantText = await assistant.innerText();
  console.log("[ASSISTANT TEXT]", assistantText);
  await page.screenshot({ path: "/tmp/quilin-3-assistant-response.png" });
});
