import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InlineApproval } from "@/components/chat/InlineApproval";

describe("InlineApproval — Iter F 交互 primitives", () => {
	const baseData = {
		askId: "ap-1",
		tool: "shell_exec",
		riskLevel: "medium" as const,
		summary: "rm -rf .next/cache",
		detail: "command: rm -rf .next/cache\ntimeoutMs: 5000",
		origin: "agent" as const,
	};

	function mockFetch(response: { status: number; body?: unknown }) {
		return vi.spyOn(global, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify(response.body ?? {}), {
					status: response.status,
					headers: { "content-type": "application/json" },
				}),
		);
	}

	it("renders tool / summary / risk badge + detail toggle", () => {
		render(<InlineApproval sessionId="s" data={baseData} />);
		expect(screen.getByText("rm -rf .next/cache")).toBeInTheDocument();
		expect(screen.getByText("shell_exec")).toBeInTheDocument();
		// Risk attribute on the wrapper.
		const wrap = screen.getByTestId("inline-approval");
		expect(wrap.getAttribute("data-risk")).toBe("medium");
	});

	it("detail toggle expands the pre block", () => {
		render(<InlineApproval sessionId="s" data={baseData} />);
		const toggle = screen.getByTestId("inline-approval-detail-toggle");
		fireEvent.click(toggle);
		expect(screen.getByText(/command: rm -rf/)).toBeInTheDocument();
	});

	it("allow posts user_decision with 'allow'", async () => {
		const fetchSpy = mockFetch({ status: 200, body: { delivered: true } });
		render(<InlineApproval sessionId="s1" data={baseData} />);
		fireEvent.click(screen.getByTestId("inline-approval-allow"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-approval-decided")).toBeInTheDocument();
		});
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
		expect(body.reply.kind).toBe("user_decision");
		expect(body.reply.decision).toBe("allow");
		expect(screen.getByTestId("inline-approval-decided").textContent).toContain("已允许");
		fetchSpy.mockRestore();
	});

	it("allow + always-allow checkbox sends allow_always_medium", async () => {
		const fetchSpy = mockFetch({ status: 200, body: { delivered: true } });
		render(<InlineApproval sessionId="s" data={baseData} />);
		// Check the "always allow at medium" toggle, then click allow.
		const checkbox = screen
			.getByTestId("inline-approval-always-allow")
			.querySelector("input") as HTMLInputElement;
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByTestId("inline-approval-allow"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-approval-decided")).toBeInTheDocument();
		});
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
		expect(body.reply.decision).toBe("allow_always_medium");
		fetchSpy.mockRestore();
	});

	it("deny posts user_decision with 'deny'", async () => {
		const fetchSpy = mockFetch({ status: 200, body: { delivered: true } });
		render(<InlineApproval sessionId="s" data={baseData} />);
		fireEvent.click(screen.getByTestId("inline-approval-deny"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-approval-decided")).toBeInTheDocument();
		});
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
		expect(body.reply.decision).toBe("deny");
		expect(screen.getByTestId("inline-approval-decided").textContent).toContain("已拒绝");
		fetchSpy.mockRestore();
	});

	it("critical-risk hides always-allow toggle", () => {
		render(<InlineApproval sessionId="s" data={{ ...baseData, riskLevel: "critical" }} />);
		expect(screen.queryByTestId("inline-approval-always-allow")).toBeNull();
	});

	it("410 from server shows expired", async () => {
		const fetchSpy = mockFetch({ status: 410, body: { error: "ask expired" } });
		render(<InlineApproval sessionId="s" data={baseData} />);
		fireEvent.click(screen.getByTestId("inline-approval-allow"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-approval-expired")).toBeInTheDocument();
		});
		fetchSpy.mockRestore();
	});
});
