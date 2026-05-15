import { expect, test } from "@playwright/test";

/**
 * UX-4 Slice 3.2 Playwright e2e — verifies the /memory page exposes
 * the 知识图谱 tab + consolidation timeline tab and that switching renders
 * one of each view's known states.
 *
 * Doesn't seed the KG, so the test passes regardless of whether
 * the backing quilin-mem MCP server is reachable — we just check
 * the UI plumbing.
 */

test.describe("Memory page — graph and timeline tabs (UX-4)", () => {
	test("memory page shows all tabs and graph/timeline tabs are reachable", async ({ page }) => {
		await page.goto("/memory");
		// Tabs render — even when memory data is empty/unavailable.
		await expect(page.getByTestId("memory-tab-list")).toBeVisible();
		await expect(page.getByTestId("memory-tab-graph")).toBeVisible();
		await expect(page.getByTestId("memory-tab-timeline")).toBeVisible();
		// List tab is selected by default.
		await expect(page.getByTestId("memory-tab-list")).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("memory-tab-graph")).toHaveAttribute("aria-selected", "false");
		await expect(page.getByTestId("memory-tab-timeline")).toHaveAttribute("aria-selected", "false");
	});

	test("clicking the graph tab swaps in the KG view", async ({ page }) => {
		await page.goto("/memory");
		await page.getByTestId("memory-tab-graph").click();
		await expect(page.getByTestId("memory-tab-graph")).toHaveAttribute("aria-selected", "true");

		// One of the KG view's known testids should be visible.
		// We don't assert which one (graph state depends on whether
		// the backend has data) — just that the view rendered at all.
		const knownStates = [
			"kg-view-loading",
			"kg-view-error",
			"kg-view-unavailable",
			"kg-view-empty",
			"kg-view",
		];
		const visiblePromises = knownStates.map(async (tid) => ({
			tid,
			visible: await page
				.getByTestId(tid)
				.first()
				.isVisible()
				.catch(() => false),
		}));
		const states = await Promise.all(visiblePromises);
		const matched = states.find((s) => s.visible);
		expect(matched, `none of [${knownStates.join(", ")}] visible`).toBeDefined();
	});

	test("switching back to list tab restores list view state", async ({ page }) => {
		await page.goto("/memory");
		await page.getByTestId("memory-tab-graph").click();
		await page.getByTestId("memory-tab-list").click();
		await expect(page.getByTestId("memory-tab-list")).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("memory-tab-graph")).toHaveAttribute("aria-selected", "false");
	});

	test("clicking the timeline tab swaps in the consolidation view", async ({ page }) => {
		await page.goto("/memory");
		await page.getByTestId("memory-tab-timeline").click();
		await expect(page.getByTestId("memory-tab-timeline")).toHaveAttribute("aria-selected", "true");

		const knownStates = [
			"consolidation-view-loading",
			"consolidation-view-error",
			"consolidation-view-unavailable",
			"consolidation-view-empty",
			"consolidation-view",
		];
		const states = await Promise.all(
			knownStates.map(async (tid) => ({
				tid,
				visible: await page
					.getByTestId(tid)
					.first()
					.isVisible()
					.catch(() => false),
			})),
		);
		const matched = states.find((s) => s.visible);
		expect(matched, `none of [${knownStates.join(", ")}] visible`).toBeDefined();
	});
});
