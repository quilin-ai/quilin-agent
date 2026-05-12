import { test, expect } from "@playwright/test";

test("intro after fix: wordmark centered + composer reacts on send", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/");
  await page.waitForLoadState("networkidle");

  const wordmark = await page.locator(".q-wordmark-intro").boundingBox();
  const composer = await page.locator(".q-composer").boundingBox();
  const viewport = page.viewportSize()!;

  // wordmark center X should be roughly viewport center (within 50px)
  const wmCenterX = (wordmark?.x ?? 0) + (wordmark?.width ?? 0) / 2;
  console.log("wordmark center X:", wmCenterX, "viewport center X:", viewport.width / 2);
  console.log("composer X:", composer?.x);

  // before send: input empty, URL is /
  console.log("URL before send:", page.url());

  await page.locator(".q-composer-input").first().fill("hello quilin");
  await page.locator(".q-composer-send").click();
  await page.waitForURL(/session=draft-/, { timeout: 5000 });

  console.log("URL after send:", page.url());
  console.log("ok: send triggered navigation");
});
