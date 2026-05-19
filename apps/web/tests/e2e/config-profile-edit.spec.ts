import { expect, test } from "@playwright/test";

test("config page edits profile file through approval gate", async ({ page }) => {
	const initialContent = `---
name: 初始画像
---

# 初始内容

- 偏好简洁回答
`;
	let currentContent = initialContent;
	let currentModifiedAt = "2026-05-20T06:00:00.000Z";
	let lastPatch: Record<string, unknown> | null = null;

	await page.route("**/api/config", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				ok: true,
				data: {
					llm: {
						model: "deepseek-chat",
						baseURL: "https://api.deepseek.com/v1",
						apiKeyPresent: true,
						isReasoner: false,
					},
					filesystem: {
						cwd: "/Users/raysonmeng/repo/quilin-agent/apps/web",
						workspaceRoot: "/Users/raysonmeng/repo/quilin-agent",
						home: "/Users/raysonmeng",
						allowedRoots: ["/Users/raysonmeng/repo/quilin-agent", "/Users/raysonmeng"],
					},
					sessionStore: {
						activeSessions: 1,
						totalFrames: 12,
						byStatus: { running: 1 },
					},
					process: {
						pid: 12345,
						nodeVersion: process.version,
						platform: process.platform,
						uptimeSec: 42,
					},
					env: [],
				},
			}),
		});
	});

	await page.route("**/api/profile-files**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const which = url.searchParams.get("which");
		if (request.method() === "GET") {
			const body = {
				which,
				path: `/tmp/${which ?? "unknown"}.md`,
				exists: true,
				content: currentContent,
				size: Buffer.byteLength(currentContent, "utf8"),
				modifiedAt: currentModifiedAt,
			};
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify(body),
			});
			return;
		}
		if (request.method() === "PATCH") {
			lastPatch = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
			currentContent = typeof lastPatch?.content === "string" ? lastPatch.content : currentContent;
			currentModifiedAt = "2026-05-20T06:01:00.000Z";
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					data: {
						which,
						path: `/tmp/${which ?? "unknown"}.md`,
						exists: true,
						content: currentContent,
						size: Buffer.byteLength(currentContent, "utf8"),
						modifiedAt: currentModifiedAt,
					},
				}),
			});
			return;
		}
		await route.continue();
	});

	await page.goto("/config");
	await expect(page.getByText("Config配置")).toBeVisible();

	await page.getByTestId("profile-toggle-user").click();
	await expect(page.getByTestId("profile-content-user")).toContainText("初始内容");

	await page.getByTestId("profile-edit-user").click();
	const editor = page.getByTestId("profile-editor-user");
	await expect(editor).toBeVisible();
	await editor.fill(`---
name: 更新画像
---

# 修改后正文

- 偏好更直接的回答
`);

	await page.getByTestId("profile-save-user").click();
	await expect(page.getByTestId("profile-approval-user")).toBeVisible();
	await page.getByTestId("profile-approve-user").click();

	await expect(page.getByText("已保存 · WriteAuthority 已批准并写入磁盘")).toBeVisible();
	await expect(page.getByText("修改后正文")).toBeVisible();
	expect(lastPatch).toEqual(
		expect.objectContaining({
			which: "user",
			confirmed: true,
		}),
	);

	await page.screenshot({
		path: "/tmp/quilin-config-profile-edit.png",
		fullPage: true,
	});
});
