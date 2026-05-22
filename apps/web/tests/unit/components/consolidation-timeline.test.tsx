import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsolidationTimelineView } from "@/components/memory/ConsolidationTimelineView";

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(global, "fetch").mockImplementation(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ConsolidationTimelineView", () => {
	it("renders recent consolidation entries and expands actions", async () => {
		mockFetch({
			ok: true,
			data: {
				available: true,
				total: 1,
				entries: [
					{
						id: 12,
						task: "profile consolidation",
						dry_run: false,
						budget_decision: "allow",
						writes_performed: 1,
						created_at: "2026-05-15T05:00:00",
						schema_version: 1,
						actions: [
							{
								kind: "promote",
								target_layer: "semantic",
								reason: "stable fact",
								dry_run: false,
								writes_semantic: true,
								writes_skill: false,
								metadata: { source: "test" },
							},
						],
					},
				],
			},
		});

		render(<ConsolidationTimelineView />);

		expect(await screen.findByTestId("consolidation-view")).toBeInTheDocument();
		expect(screen.getByText("profile consolidation")).toBeInTheDocument();
		// D.8 fix: UI 已 i18n 改成 "层级升级 ×N",test fixture 跟上。
		expect(screen.getByText(/层级升级 ×1/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /profile consolidation/ }));
		expect(screen.getAllByText(/stable fact/).length).toBeGreaterThan(0);
	});

	it("renders the empty state", async () => {
		mockFetch({
			ok: true,
			data: { available: true, total: 0, entries: [] },
		});

		render(<ConsolidationTimelineView />);

		expect(await screen.findByTestId("consolidation-view-empty")).toHaveTextContent(
			"no consolidation events yet",
		);
	});

	it("renders unavailable state when the MCP tool is missing", async () => {
		mockFetch({
			ok: true,
			data: {
				available: false,
				reason: "quilin-mem MCP server is not connected",
				total: 0,
				entries: [],
			},
		});

		render(<ConsolidationTimelineView />);

		expect(await screen.findByTestId("consolidation-view-unavailable")).toHaveTextContent(
			"quilin-mem MCP server is not connected",
		);
	});
});
