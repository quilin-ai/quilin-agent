import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubagentLiveProgress } from "@/components/chat/SubagentLiveProgress";
import { AuthorityBar } from "@/components/conversation/AuthorityBar";
import { EventLine } from "@/components/conversation/EventLine";
import { Process } from "@/components/conversation/Process";
import { Reasoning } from "@/components/conversation/Reasoning";
import { ReflectionBlock } from "@/components/conversation/ReflectionBlock";
import { ToolCall } from "@/components/conversation/ToolCall";
import { Turn } from "@/components/conversation/Turn";
import { Button } from "@/components/ui/Button";

describe("Turn", () => {
	it("renders user role label", () => {
		render(
			<Turn role="user">
				<p>hi</p>
			</Turn>,
		);
		expect(screen.getByText("you")).toBeInTheDocument();
		expect(screen.getByText("你")).toBeInTheDocument();
	});
	it("renders assistant role with agent id when subagent", () => {
		render(
			<Turn role="assistant" agentId="review-loop-r1">
				<p>x</p>
			</Turn>,
		);
		expect(screen.getByText(/review-loop-r1/)).toBeInTheDocument();
	});
	it("renders assistant role without subagent suffix for main", () => {
		render(
			<Turn role="assistant" agentId="main">
				<p>x</p>
			</Turn>,
		);
		expect(screen.queryByText(/· main/)).toBeNull();
	});
	it("renders system role label", () => {
		render(
			<Turn role="system">
				<p>x</p>
			</Turn>,
		);
		expect(screen.getByText("派遣")).toBeInTheDocument();
	});
});

describe("Process", () => {
	it("toggles open/close", () => {
		const { container } = render(
			<Process title="过程 · process · 1.0s">
				<EventLine kw="召回" name="working tier" />
			</Process>,
		);
		const section = container.querySelector(".q-process");
		expect(section?.getAttribute("data-open")).toBe("true");
		fireEvent.click(screen.getByText(/process/));
		expect(section?.getAttribute("data-open")).toBe("false");
	});
	it("renders running status by default", () => {
		render(
			<Process title="t">
				<p>x</p>
			</Process>,
		);
		expect(screen.getByText("正在输出")).toBeInTheDocument();
	});
	it("renders waiting status", () => {
		render(
			<Process title="t" status="waiting">
				<p>x</p>
			</Process>,
		);
		expect(screen.getByText("等待授权")).toBeInTheDocument();
	});
	it("renders done status", () => {
		render(
			<Process title="t" status="done">
				<p>x</p>
			</Process>,
		);
		expect(screen.getByText("已完成")).toBeInTheDocument();
	});
	it("does not pin the running body to bottom after the user scrolls up", () => {
		const { container, rerender } = render(
			<Process title="t" status="running" autoScrollKey="first">
				<p>first</p>
			</Process>,
		);
		const body = container.querySelector(".q-process-body") as HTMLDivElement;
		Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1000 });
		Object.defineProperty(body, "clientHeight", { configurable: true, value: 200 });

		body.scrollTop = 100;
		fireEvent.scroll(body);
		rerender(
			<Process title="t" status="running" autoScrollKey="second">
				<p>second</p>
			</Process>,
		);

		expect(body.scrollTop).toBe(100);

		body.scrollTop = 976;
		fireEvent.scroll(body);
		Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1200 });
		rerender(
			<Process title="t" status="running" autoScrollKey="third">
				<p>third</p>
			</Process>,
		);

		expect(body.scrollTop).toBe(1200);
	});
});

describe("Reasoning", () => {
	it("starts closed by default and opens on click", () => {
		const { container } = render(
			<Reasoning title="思考 · reasoning">
				<p>x</p>
			</Reasoning>,
		);
		const section = container.querySelector(".q-reasoning");
		expect(section?.getAttribute("data-open")).toBe("false");
		fireEvent.click(screen.getByText(/reasoning/));
		expect(section?.getAttribute("data-open")).toBe("true");
	});
	it("respects defaultOpen", () => {
		const { container } = render(
			<Reasoning title="t" defaultOpen>
				<p>x</p>
			</Reasoning>,
		);
		expect(container.querySelector(".q-reasoning")?.getAttribute("data-open")).toBe("true");
	});
});

describe("ToolCall", () => {
	it("renders tool variant by default", () => {
		render(<ToolCall name="read_file" />);
		expect(screen.getByText("调用")).toBeInTheDocument();
		expect(screen.getByText("read_file")).toBeInTheDocument();
		expect(screen.getByText("▪ running")).toBeInTheDocument();
	});
	it("renders mcp variant", () => {
		const { container } = render(<ToolCall name="quilin-mem" kind="mcp" />);
		const section = container.querySelector(".q-tool-call");
		expect(section?.getAttribute("data-kind")).toBe("mcp");
		expect(screen.getByText("MCP")).toBeInTheDocument();
	});
	it("renders subagent variant", () => {
		render(<ToolCall name="review-loop-r1" kind="subagent" />);
		expect(screen.getByText("子代理")).toBeInTheDocument();
	});
	it("renders memory variant", () => {
		render(<ToolCall name="recall" kind="memory" />);
		expect(screen.getByText("记忆")).toBeInTheDocument();
	});
	it("uses statusLabel when provided", () => {
		render(<ToolCall name="x" statusLabel="▢ done · 84ms" status="done" />);
		expect(screen.getByText("▢ done · 84ms")).toBeInTheDocument();
	});
	it("default status label for done", () => {
		render(<ToolCall name="x" status="done" />);
		expect(screen.getByText("▢ done")).toBeInTheDocument();
	});
	it("default status label for error", () => {
		render(<ToolCall name="x" status="error" />);
		expect(screen.getByText("✕ error")).toBeInTheDocument();
	});
	it("opens on click", () => {
		const { container } = render(<ToolCall name="x">body</ToolCall>);
		const section = container.querySelector(".q-tool-call");
		expect(section?.getAttribute("data-open")).toBe("false");
		fireEvent.click(screen.getByText("x"));
		expect(section?.getAttribute("data-open")).toBe("true");
	});
	it("applies blocked styling", () => {
		const { container } = render(<ToolCall name="x" blocked />);
		expect(container.querySelector(".q-tool-call")?.className).toContain("blocked");
	});
});

describe("EventLine", () => {
	it("renders kw + name", () => {
		render(<EventLine kw="召回" name="working tier" />);
		expect(screen.getByText("召回")).toBeInTheDocument();
		expect(screen.getByText("working tier")).toBeInTheDocument();
	});
	it("renders optional desc + meta", () => {
		render(<EventLine kw="召回" name="working tier" desc="3 items" meta="12ms" />);
		expect(screen.getByText("3 items")).toBeInTheDocument();
		expect(screen.getByText("12ms")).toBeInTheDocument();
	});
	it("respects kind attribute", () => {
		const { container } = render(<EventLine kw="召回" name="x" kind="critical" />);
		expect(container.querySelector(".q-event-line")?.getAttribute("data-kind")).toBe("critical");
	});
});

describe("ReflectionBlock", () => {
	it("toggles open/close", () => {
		const { container } = render(
			<ReflectionBlock>
				<p>note</p>
			</ReflectionBlock>,
		);
		const section = container.querySelector(".q-reflection-block");
		expect(section?.getAttribute("data-open")).toBe("true");
		fireEvent.click(screen.getByText(/reflection/));
		expect(section?.getAttribute("data-open")).toBe("false");
	});
	it("respects defaultOpen=false", () => {
		const { container } = render(
			<ReflectionBlock defaultOpen={false}>
				<p>note</p>
			</ReflectionBlock>,
		);
		expect(container.querySelector(".q-reflection-block")?.getAttribute("data-open")).toBe("false");
	});
});

describe("AuthorityBar", () => {
	it("calls onAuthorize and transitions to authorized state", async () => {
		const onAuthorize = vi.fn().mockResolvedValue(undefined);
		render(<AuthorityBar onAuthorize={onAuthorize} />);
		fireEvent.click(screen.getByTestId("authorize"));
		await waitFor(() => expect(onAuthorize).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByText(/已授权/)).toBeInTheDocument());
	});
	it("calls onDeny and transitions to denied state", async () => {
		const onDeny = vi.fn().mockResolvedValue(undefined);
		render(<AuthorityBar onDeny={onDeny} />);
		fireEvent.click(screen.getByTestId("deny"));
		await waitFor(() => expect(onDeny).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByText(/已拒绝/)).toBeInTheDocument());
	});
	it("returns to pending after error", async () => {
		const onAuthorize = vi.fn().mockRejectedValue(new Error("boom"));
		render(<AuthorityBar onAuthorize={onAuthorize} />);
		fireEvent.click(screen.getByTestId("authorize"));
		await waitFor(() => expect(onAuthorize).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByTestId("authorize")).toBeInTheDocument());
	});
	it("renders custom label", () => {
		render(<AuthorityBar label="custom-label-xyz" />);
		expect(screen.getByText("custom-label-xyz")).toBeInTheDocument();
	});
	it("ignores additional clicks while resolving", () => {
		const onAuthorize = vi.fn(() => new Promise<void>(() => undefined));
		render(<AuthorityBar onAuthorize={onAuthorize} />);
		fireEvent.click(screen.getByTestId("authorize"));
		fireEvent.click(screen.getByTestId("authorize"));
		expect(onAuthorize).toHaveBeenCalledTimes(1);
	});
});

describe("Button", () => {
	it("renders all variants", () => {
		const { rerender } = render(<Button>x</Button>);
		expect(screen.getByText("x")).toBeInTheDocument();
		rerender(<Button variant="ghost">y</Button>);
		expect(screen.getByText("y")).toBeInTheDocument();
		rerender(<Button variant="danger">z</Button>);
		expect(screen.getByText("z")).toBeInTheDocument();
	});
	it("forwards clicks", () => {
		const fn = vi.fn();
		render(<Button onClick={fn}>x</Button>);
		fireEvent.click(screen.getByText("x"));
		expect(fn).toHaveBeenCalled();
	});
});

describe("SubagentLiveProgress", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("collapses completed snapshots to the header row", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					ok: true,
					data: {
						displayName: "玄学出海研究",
						task: "调研一下玄学出海这个赛道",
						status: "completed",
						streamedText: "**第一行**\n\n第二行\n\n第三行",
						elapsedMs: 1234,
						usage: null,
					},
				}),
			),
		);
		const { container } = render(
			<SubagentLiveProgress
				agentId="subagent-a1b2c3d4"
				displayName="玄学出海研究"
				parentSessionId="draft-parent-session"
				task="调研一下玄学出海这个赛道"
			/>,
		);

		expect(await screen.findByTestId("subagent-live-link-subagent-a1b2c3d4")).toHaveTextContent(
			"玄学出海研究",
		);
		expect(screen.queryByText("subagent-a1b2c3d4")).toBeNull();
		expect(screen.getByText("详情").closest("a")?.getAttribute("href")).toBe(
			"/?session=subagent-a1b2c3d4&from=draft-parent-session",
		);
		expect(container.querySelector(".q-subagent-live")?.getAttribute("data-expanded")).toBe(
			"false",
		);
		expect(container.querySelector(".q-subagent-live-preview")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		expect(container.querySelector(".q-subagent-live")?.getAttribute("data-expanded")).toBe("true");
		expect(
			container.querySelector(".q-subagent-live-preview")?.getAttribute("data-has-output"),
		).toBe("true");
	});

	it("does not link to details when the subagent snapshot is gone", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{
						ok: false,
						error: { code: "not_found", message: "agent subagent-a1b2c3d4 not found" },
					},
					{ status: 404 },
				),
			),
		);
		render(
			<SubagentLiveProgress
				agentId="subagent-a1b2c3d4"
				displayName="玄学出海研究"
				parentSessionId="draft-parent-session"
				task="调研一下玄学出海这个赛道"
			/>,
		);

		expect(await screen.findByTestId("subagent-live-title-subagent-a1b2c3d4")).toHaveTextContent(
			"玄学出海研究",
		);
		expect(screen.queryByText("详情")).toBeNull();
		expect(screen.getByTestId("subagent-live-title-subagent-a1b2c3d4").closest("a")).toBeNull();
	});

	it("keeps running snapshots in a two-line tail-scrolling preview", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					ok: true,
					data: {
						displayName: "玄学出海研究",
						task: "调研一下玄学出海这个赛道",
						status: "running",
						streamedText: "第一行\n\n第二行\n\n第三行",
						elapsedMs: 1234,
						usage: null,
					},
				}),
			),
		);
		const { container } = render(
			<SubagentLiveProgress
				agentId="subagent-a1b2c3d4"
				displayName="玄学出海研究"
				task="调研一下玄学出海这个赛道"
			/>,
		);

		expect(await screen.findByTestId("subagent-live-link-subagent-a1b2c3d4")).toHaveTextContent(
			"玄学出海研究",
		);
		const preview = container.querySelector(".q-subagent-live-preview");
		expect(preview?.getAttribute("data-tail-scroll")).toBe("true");
		expect(container.querySelector(".q-subagent-live")?.getAttribute("data-expanded")).toBe(
			"false",
		);
	});
});
