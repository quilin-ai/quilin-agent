import { expect, test } from "@playwright/test";

const AGENT_ID = "subagent-e2e-terminal";
const SESSION_ID = "e2e-subagent-polling";

function agentPayload(status: "running" | "completed") {
	return {
		ok: true,
		data: {
			id: AGENT_ID,
			kind: "subagent",
			parentId: SESSION_ID,
			displayName: "终止轮询验证",
			task: "验证 terminal 后停止轮询",
			status,
			startedAt: "2026-05-20T06:00:00.000Z",
			lastHeartbeatAt: "2026-05-20T06:00:02.000Z",
			elapsedMs: status === "running" ? 1000 : 2000,
			streamedText: status === "running" ? "运行中片段" : "最终结果已保留",
			toolEvents: [],
			usage: null,
		},
	};
}

test.describe("SubagentLiveProgress polling", () => {
	test("stops calling /api/agents/[id] after a terminal status", async ({ page }) => {
		let detailRequestCount = 0;

		await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					messages: [
						{
							id: "user-1",
							role: "user",
							parts: [{ type: "text", text: "派一个子代理做终止轮询验证" }],
						},
						{
							id: "assistant-1",
							role: "assistant",
							parts: [
								{
									type: "tool-spawn_subagent",
									toolCallId: "call-1",
									state: "output-available",
									input: { task: "验证 terminal 后停止轮询" },
									output: {
										agentId: AGENT_ID,
										displayName: "终止轮询验证",
										task: "验证 terminal 后停止轮询",
									},
								},
								{ type: "text", text: "子代理已返回终止状态。" },
							],
						},
					],
				}),
			});
		});

		await page.route(`**/api/agents/${AGENT_ID}`, async (route) => {
			detailRequestCount += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(agentPayload(detailRequestCount === 1 ? "running" : "completed")),
			});
		});

		await page.goto(`/?session=${SESSION_ID}`);
		await expect(page.getByText("运行中 · running")).toBeVisible();
		await expect(page.getByText("已完成 · completed")).toBeVisible({ timeout: 3000 });

		await page.waitForTimeout(3500);
		expect(detailRequestCount).toBe(2);

		await page.getByRole("button", { name: "展开" }).click();
		await expect(page.getByText("最终结果已保留")).toBeVisible();
		await page.screenshot({
			path: "test-results/subagent-live-progress-terminal.png",
			fullPage: true,
		});
	});
});
