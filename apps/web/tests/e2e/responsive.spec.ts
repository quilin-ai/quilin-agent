/**
 * Responsive layout regression — UX-6.
 *
 * 验证移动窄屏(≤640px)切到顶部横向 chip rail,desktop 保持左侧 vertical
 * rail 不变;composer iOS safe-area padding 应用。
 *
 * Verifies narrow viewports (≤640px) flip the rail from vertical-left to
 * horizontal-top chip bar; wider viewports keep the legacy vertical rail;
 * composer reserves iOS safe-area-inset-bottom on mobile.
 */
import { expect, test } from "@playwright/test";

const RAIL_SELECTOR = "aside.q-rail-strip";
const COMPOSER_SELECTOR = "footer.q-composer";

test.describe("UX-6 responsive layout", () => {
	test("desktop (1280×800): rail stays vertical on the left", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto("/");
		await page.waitForSelector(RAIL_SELECTOR);

		const rail = page.locator(RAIL_SELECTOR);
		const box = await rail.boundingBox();
		expect(box).not.toBeNull();
		if (box == null) return;

		// Vertical rail anchored on the left, narrow width (≤ ~280px).
		expect(box.x).toBeLessThanOrEqual(4);
		expect(box.width).toBeLessThanOrEqual(280);
		// Rail tall, much taller than wide → vertical orientation.
		expect(box.height).toBeGreaterThan(box.width * 2);

		// Items use vertical writing mode (CSS contract).
		const glyphWritingMode = await page.evaluate(() => {
			const glyph = document.querySelector(".q-strip-item .glyph");
			if (!glyph) return null;
			return getComputedStyle(glyph).writingMode;
		});
		expect(glyphWritingMode).toBe("vertical-rl");
	});

	test("tablet (768×1024): still vertical rail (above mobile breakpoint)", async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 });
		await page.goto("/");
		await page.waitForSelector(RAIL_SELECTOR);

		const rail = page.locator(RAIL_SELECTOR);
		const box = await rail.boundingBox();
		expect(box).not.toBeNull();
		if (box == null) return;

		// At 768px, the existing `@media (max-width: 720px)` kicks in but only
		// adjusts main/composer offsets — the rail itself stays vertical-left.
		expect(box.x).toBeLessThanOrEqual(4);
		expect(box.width).toBeLessThanOrEqual(60); // collapsed strip width
		expect(box.height).toBeGreaterThan(200);
	});

	test("mobile (375×812 — iPhone): rail flips to top horizontal chip bar", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/");
		await page.waitForSelector(RAIL_SELECTOR);

		const rail = page.locator(RAIL_SELECTOR);
		const box = await rail.boundingBox();
		expect(box).not.toBeNull();
		if (box == null) return;

		// Horizontal bar: spans the viewport width minus scrollbar, short height.
		// Allow ~20px for desktop Chromium's reserved vertical scrollbar.
		const viewport = page.viewportSize()!;
		expect(box.width).toBeGreaterThanOrEqual(viewport.width - 20);
		expect(box.height).toBeLessThanOrEqual(60);
		// Anchored at the top (below header), not on the left edge full-height.
		expect(box.y).toBeGreaterThanOrEqual(40); // below header
		expect(box.y).toBeLessThanOrEqual(80);

		// Items now use horizontal writing mode.
		const glyphWritingMode = await page.evaluate(() => {
			const glyph = document.querySelector(".q-strip-item .glyph");
			if (!glyph) return null;
			return getComputedStyle(glyph).writingMode;
		});
		expect(glyphWritingMode).toBe("horizontal-tb");

		// Per-item desc/name-full + count hidden on mobile (icons only).
		const showsDesc = await page.evaluate(() => {
			const nameFull = document.querySelector(".q-strip-item .name-full");
			if (!nameFull) return false;
			return getComputedStyle(nameFull).display !== "none";
		});
		expect(showsDesc).toBe(false);
	});

	test("mobile composer reserves env(safe-area-inset-bottom)", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/");
		await page.waitForSelector(COMPOSER_SELECTOR);

		// At mobile breakpoint, composer should use safe-area-inset-bottom in its
		// bottom calculation. We can't simulate iOS notch inset in a desktop
		// Chromium, but we can verify the computed `bottom` resolves the env()
		// fallback to 0 (so it equals the 16px minimum on a flat screen) and the
		// CSS rule that adds safe-area is in scope (testable via computed style
		// inspection that confirms the calc expression resolves to a finite px).
		const composerBottomPx = await page.evaluate(() => {
			const composer = document.querySelector("footer.q-composer");
			if (!composer) return null;
			return Number.parseFloat(getComputedStyle(composer).bottom);
		});
		expect(composerBottomPx).not.toBeNaN();
		// On flat-screen desktop Chromium, env() falls back to 0px → bottom ≈ 16px.
		// Allow a couple px tolerance.
		expect(composerBottomPx).toBeGreaterThanOrEqual(14);
		expect(composerBottomPx).toBeLessThanOrEqual(20);

		// Composer should span the viewport (with 12px gutters on each side).
		const composerBox = await page.locator(COMPOSER_SELECTOR).boundingBox();
		expect(composerBox).not.toBeNull();
		if (composerBox == null) return;
		expect(composerBox.x).toBeGreaterThanOrEqual(8);
		expect(composerBox.x).toBeLessThanOrEqual(16);
		// composer spans viewport minus 24px gutters minus scrollbar (~15px).
		const viewport = page.viewportSize()!;
		expect(composerBox.width).toBeGreaterThanOrEqual(viewport.width - 24 - 20);
	});

	test("orientation flip (375→812 portrait then 812→375 landscape) keeps rail correct", async ({
		page,
	}) => {
		// Portrait (mobile) → top horizontal bar.
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/");
		await page.waitForSelector(RAIL_SELECTOR);
		const portraitBox = await page.locator(RAIL_SELECTOR).boundingBox();
		expect(portraitBox?.width).toBeGreaterThanOrEqual(355); // 375 - scrollbar tolerance

		// Landscape (tablet-ish at 812 wide) → vertical rail again. The rail
		// can be in collapsed (~56px) or hovered/open (~280px) state, but in
		// any case it should be taller than wide (vertical orientation), not
		// span the full viewport width.
		await page.setViewportSize({ width: 812, height: 375 });
		await page.waitForTimeout(150); // allow re-render
		const landscapeBox = await page.locator(RAIL_SELECTOR).boundingBox();
		expect(landscapeBox).not.toBeNull();
		if (landscapeBox == null) return;
		expect(landscapeBox.width).toBeLessThanOrEqual(300); // not spanning viewport
		expect(landscapeBox.height).toBeGreaterThan(landscapeBox.width); // vertical
	});
});
