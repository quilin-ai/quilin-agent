import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentDetailView } from "@/components/chat/SubagentDetailView";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/shell/Composer", () => ({
	Composer: () => <div data-testid="composer" />,
}));

function agentDetail(status: "completed" | "running") {
	return {
		ok: true,
		data: {
			id: "subagent-057d2c4e",
			kind: "subagent",
			parentId: "cursor-inline-slow-1778756603455",
			displayName: "总结",
			task: "搜索并整理2026年关于玄学出海的行业动态和新闻报道",
			status,
			startedAt: "2026-05-14T10:00:00.000Z",
			lastHeartbeatAt: "2026-05-14T10:02:00.000Z",
			elapsedMs: 120_000,
			streamedText: "已完成调研摘要。",
			toolEvents: [
				{
					kind: "call",
					toolCallId: "call-1",
					toolName: "tavily__tavily_search",
					input: { query: "2026年 玄学出海 行业动态" },
					at: "2026-05-14T10:00:01.000Z",
				},
				{
					kind: "result",
					toolCallId: "call-1",
					toolName: "tavily__tavily_search",
					output: { results: [{ title: "示例结果" }] },
					at: "2026-05-14T10:00:03.000Z",
				},
			],
		},
	};
}

describe("SubagentDetailView", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(agentDetail("completed"))),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("collapses the process block when opening an already-completed subagent", async () => {
		const { container } = render(<SubagentDetailView agentId="subagent-057d2c4e" />);

		await screen.findByText("已完成 · completed");

		await waitFor(() => {
			expect(container.querySelector(".q-process")?.getAttribute("data-open")).toBe("false");
		});
		expect(container.querySelector(".q-tool-call")?.getAttribute("data-open")).toBe("false");
	});

	it("keeps the process block open while the subagent is still running", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(agentDetail("running"))),
		);
		const { container } = render(<SubagentDetailView agentId="subagent-057d2c4e" />);

		await screen.findByText("运行中 · running");

		await waitFor(() => {
			expect(container.querySelector(".q-process")?.getAttribute("data-open")).toBe("true");
		});
	});
});
