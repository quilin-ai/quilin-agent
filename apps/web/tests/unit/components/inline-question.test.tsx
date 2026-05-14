import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InlineQuestion } from "@/components/chat/InlineQuestion";

describe("InlineQuestion — Iter F 交互 primitives", () => {
	const baseData = {
		askId: "ask-1",
		question: "选哪个方案?",
		mode: "single" as const,
		options: [
			{ id: "a", label: "A 方案", description: "更快" },
			{ id: "b", label: "B 方案", description: "更稳" },
		],
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

	it("renders question + options for single mode", () => {
		render(<InlineQuestion sessionId="s" data={baseData} />);
		expect(screen.getByText("选哪个方案?")).toBeInTheDocument();
		expect(screen.getByText("A 方案")).toBeInTheDocument();
		expect(screen.getByText("B 方案")).toBeInTheDocument();
		expect(screen.getByText("更快")).toBeInTheDocument();
		// Submit disabled until a choice is made.
		expect((screen.getByTestId("inline-question-submit") as HTMLButtonElement).disabled).toBe(true);
	});

	it("submit enables after selection, POSTs and flips to answered", async () => {
		const fetchSpy = mockFetch({ status: 200, body: { delivered: true } });
		render(<InlineQuestion sessionId="s1" data={baseData} />);
		fireEvent.click(screen.getByDisplayValue("a"));
		expect((screen.getByTestId("inline-question-submit") as HTMLButtonElement).disabled).toBe(
			false,
		);
		fireEvent.click(screen.getByTestId("inline-question-submit"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-question-answered")).toBeInTheDocument();
		});
		// Posted to /api/chat/answer with correct shape.
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/chat/answer",
			expect.objectContaining({
				method: "POST",
			}),
		);
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
		expect(body.sessionId).toBe("s1");
		expect(body.reply.kind).toBe("user_answered_question");
		expect(body.reply.askId).toBe("ask-1");
		expect(body.reply.answer).toEqual({ mode: "single", selectedId: "a" });
		// Shows selected option label.
		expect(screen.getByTestId("inline-question-answered").textContent).toContain("A 方案");
		fetchSpy.mockRestore();
	});

	it("410 from server flips to expired", async () => {
		const fetchSpy = mockFetch({ status: 410, body: { error: "ask expired" } });
		render(<InlineQuestion sessionId="s" data={baseData} />);
		fireEvent.click(screen.getByDisplayValue("a"));
		fireEvent.click(screen.getByTestId("inline-question-submit"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-question-expired")).toBeInTheDocument();
		});
		fetchSpy.mockRestore();
	});

	it("multi mode supports toggling multiple options", async () => {
		const fetchSpy = mockFetch({ status: 200, body: { delivered: true } });
		render(<InlineQuestion sessionId="s" data={{ ...baseData, mode: "multi" }} />);
		const aBox = screen.getAllByRole("checkbox")[0]!;
		const bBox = screen.getAllByRole("checkbox")[1]!;
		fireEvent.click(aBox);
		fireEvent.click(bBox);
		fireEvent.click(screen.getByTestId("inline-question-submit"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-question-answered")).toBeInTheDocument();
		});
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
		expect(body.reply.answer).toEqual({ mode: "multi", selectedIds: ["a", "b"] });
		fetchSpy.mockRestore();
	});

	it("free_text mode submits typed value", async () => {
		const fetchSpy = mockFetch({ status: 200, body: { delivered: true } });
		render(
			<InlineQuestion
				sessionId="s"
				data={{
					askId: "ft-1",
					question: "请输入年份",
					mode: "free_text" as const,
				}}
			/>,
		);
		fireEvent.change(screen.getByTestId("inline-question-textarea"), {
			target: { value: "2026" },
		});
		fireEvent.click(screen.getByTestId("inline-question-submit"));
		await waitFor(() => {
			expect(screen.getByTestId("inline-question-answered")).toBeInTheDocument();
		});
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
		expect(body.reply.answer).toEqual({ mode: "free_text", text: "2026" });
		fetchSpy.mockRestore();
	});

	it("network error shows error message + keeps idle state recoverable", async () => {
		const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
			throw new Error("network down");
		});
		render(<InlineQuestion sessionId="s" data={baseData} />);
		fireEvent.click(screen.getByDisplayValue("a"));
		fireEvent.click(screen.getByTestId("inline-question-submit"));
		await waitFor(() => {
			expect(screen.getByText(/network down/)).toBeInTheDocument();
		});
		fetchSpy.mockRestore();
	});
});
