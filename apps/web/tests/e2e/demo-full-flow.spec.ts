import { test, expect } from "@playwright/test";

test("full demo: chat → sessions list → IME guard", async ({ page }) => {
  // 1. Intro state visible
  await page.goto("http://127.0.0.1:3000/");
  await expect(page.locator(".q-wordmark-intro")).toBeVisible();
  await page.screenshot({ path: "/tmp/demo-1-intro.png" });

  // 2. IME guard: simulate composing
  const input = page.locator(".q-composer-input").first();
  await input.click();
  await input.dispatchEvent("compositionstart");
  await input.evaluate((el: HTMLTextAreaElement) => { el.value = "你好"; });
  // Press Enter while composing — should NOT submit
  await input.press("Enter");
  // URL should still be home (no submit happened)
  expect(page.url()).toBe("http://127.0.0.1:3000/");
  await input.dispatchEvent("compositionend");

  // 3. Real submit
  await input.fill("用 8 个字介绍你");
  await page.locator(".q-composer-send").click();
  await page.waitForURL(/session=draft-.*initial=/);
  // Assistant message appears
  await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(2000); // let it stream a bit
  await page.screenshot({ path: "/tmp/demo-2-chat.png" });

  // 4. Navigate to /sessions and verify saved session appears
  await page.goto("http://127.0.0.1:3000/sessions");
  await expect(page.locator("h1.q-page-title")).toContainText("Sessions");
  // Wait for hydration to populate from localStorage
  await page.waitForTimeout(500);
  const sessionLink = page.locator('a[data-testid^="session-draft-"]').first();
  await expect(sessionLink).toBeVisible({ timeout: 5000 });
  const sessionTitle = await sessionLink.locator(".rn").innerText();
  console.log("[SESSIONS] first session:", sessionTitle);
  await page.screenshot({ path: "/tmp/demo-3-sessions.png" });

  // 5. Click back to restore session
  await sessionLink.click();
  await page.waitForURL(/\/\?session=draft-/);
  // The restored session should show previous messages
  await expect(page.locator('[data-role="user"]').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: "/tmp/demo-4-restored.png" });
  console.log("✅ full demo flow passed");
});
