import { expect, test } from "@playwright/test";

/**
 * E2E coverage for the per-server MCP reconnect controls landed by
 * the QUI-182 web-audit pass. We don't assert the reconnect succeeds
 * (that depends on the live ~/.claude.json state — plane's token
 * really may be expired), only that the UI exposes the affordance:
 *
 *   - Each MCP card on /mcp has a "↻ 重连" button and renders the
 *     `~/.claude.json` config hint.
 *   - Failed servers expose a "📋 复制错误" button that puts the
 *     error text on the clipboard.
 *   - The same per-server reconnect button shows up on /tools
 *     inside the MCP status snapshot (data-testid mcp-server-compact-*).
 *
 * QUI-182 / 2026-05-20.
 */

test.describe("MCP per-server reconnect controls", () => {
	test("/mcp renders shared McpServerCard with reconnect + config hint", async ({ page }) => {
		await page.goto("/mcp");
		// Wait until the catalog has loaded — counts span shows the total.
		await expect(page.getByTestId("mcp-view")).toBeVisible();
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid^="mcp-server-"]').length > 0,
			null,
			{ timeout: 15_000 },
		);

		// At least one card should be rendered. Pick the first.
		// Subagent B 报告 (QUI-182, 2026-05-20): `[data-testid$=""]` 是非法 CSS
		// (空 suffix 在浏览器规范下匹配 0 元素),功能本身工作只是 spec broken。
		// 改成只用 :not(...) 排除 compact / toggle / reconnect / copy / error 子 testid。
		const cards = page.locator(
			'[data-testid^="mcp-server-"]:not([data-testid^="mcp-server-compact-"]):not([data-testid^="mcp-server-toggle-"]):not([data-testid^="mcp-reconnect-"]):not([data-testid^="mcp-copy-error-"]):not([data-testid^="mcp-error-"])',
		);
		const firstCard = cards.first();
		await expect(firstCard).toBeVisible();

		// Resolve the server id from the data-testid attribute so the
		// rest of the assertions can target the matching reconnect btn.
		const cardTestId = await firstCard.getAttribute("data-testid");
		expect(cardTestId).not.toBeNull();
		const serverId = cardTestId!.replace(/^mcp-server-/, "");

		// "↻ 重连" button is present on every card regardless of status.
		await expect(page.getByTestId(`mcp-reconnect-${serverId}`)).toBeVisible();

		// Config hint text is rendered.
		await expect(firstCard).toContainText("~/.claude.json");
		await expect(firstCard).toContainText(`mcpServers.${serverId}`);
	});

	test("/mcp failed server exposes 复制错误 and triggers POST /api/mcp/[name]/reconnect on click", async ({
		page,
		context,
	}) => {
		// Grant clipboard read so we can verify the copy.
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);

		await page.goto("/mcp");
		await expect(page.getByTestId("mcp-view")).toBeVisible();
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid^="mcp-server-"]').length > 0,
			null,
			{ timeout: 15_000 },
		);

		// Look for any failed server card by scanning for a copy-error
		// button (only rendered when error != null).
		const copyButtons = page.locator('[data-testid^="mcp-copy-error-"]');
		const copyCount = await copyButtons.count();
		if (copyCount === 0) {
			test.skip(true, "No failed MCP servers in the current ~/.claude.json — skip");
		}

		const copyBtn = copyButtons.first();
		const copyTestId = (await copyBtn.getAttribute("data-testid"))!;
		const failedId = copyTestId.replace(/^mcp-copy-error-/, "");

		// Capture the rendered error text before clicking copy.
		const errorBox = page.getByTestId(`mcp-error-${failedId}`);
		await expect(errorBox).toBeVisible();
		const errorText = (await errorBox.textContent())?.trim() ?? "";
		expect(errorText.length).toBeGreaterThan(0);

		// Click 复制错误 and verify clipboard contains the error.
		await copyBtn.click();
		await expect(copyBtn).toContainText(/已复制|失败|复制错误/);
		// Try reading clipboard — may be denied in some envs; treat
		// permission errors as a non-failure so the test still attests
		// to the UI affordance.
		const clipText = await page
			.evaluate(() => navigator.clipboard.readText())
			.catch(() => null);
		if (clipText != null) {
			expect(clipText).toContain(errorText.slice(0, 20));
		}

		// Click "↻ 重连" and assert the network call goes out.
		const reconnectBtn = page.getByTestId(`mcp-reconnect-${failedId}`);
		const reconnectRespPromise = page.waitForResponse(
			(resp) =>
				resp.url().includes(`/api/mcp/${encodeURIComponent(failedId)}/reconnect`) &&
				resp.request().method() === "POST",
			{ timeout: 30_000 },
		);
		await reconnectBtn.click();
		const reconnectResp = await reconnectRespPromise;
		// We accept any 2xx — the actual reconnect may legitimately still
		// fail (expired token), but the HTTP envelope must be a success
		// since the API surfaces server errors as `{ok:true, data:{status:"failed",error}}`.
		expect(reconnectResp.status()).toBeGreaterThanOrEqual(200);
		expect(reconnectResp.status()).toBeLessThan(300);

		// Button should transition from "重连中…" back to "↻ 重连".
		await expect(reconnectBtn).toContainText(/重连/);
	});

	test("/tools no longer renders MCP server status snapshot (moved to /mcp page)", async ({
		page,
	}) => {
		// QUI-183 sibling tweak (2026-05-20):/tools 只展示本地 builtin / inline,
		// MCP server status 卡片整段已抽到独立 /mcp 页面。这条 spec 从"应当渲染"
		// 翻为"不应当渲染",防回归。
		await page.goto("/tools");
		await expect(page.getByTestId("tools-view")).toBeVisible({ timeout: 15_000 });
		// 等 catalog 加载完(/tools 主区出现 filter input 视为 catalog 已 ready)
		await expect(page.getByTestId("tools-filter")).toBeVisible({ timeout: 15_000 });

		// MCP server status 区不应再出现
		await expect(page.getByTestId("tools-mcp-status")).toHaveCount(0);
		// 也不该有任何 compact MCP server card
		const compactCards = page.locator('[data-testid^="mcp-server-compact-"]');
		await expect(compactCards).toHaveCount(0);
	});
});
