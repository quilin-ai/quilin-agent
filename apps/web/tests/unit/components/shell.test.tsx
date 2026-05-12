import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSwitcher } from "@/components/shell/AgentSwitcher";
import { AppHeader } from "@/components/shell/AppHeader";
import { Composer } from "@/components/shell/Composer";
import { RailStrip } from "@/components/shell/RailStrip";
import { Wordmark } from "@/components/shell/Wordmark";
import type { AgentSummary } from "@/lib/schemas";

vi.mock("next/navigation", () => ({
	usePathname: () => "/sessions",
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		className,
		...rest
	}: {
		children: React.ReactNode;
		href: string | { pathname: string; query?: Record<string, string> };
		className?: string;
	}) => {
		const stringHref =
			typeof href === "string"
				? href
				: `${href.pathname}${href.query ? `?${new URLSearchParams(href.query).toString()}` : ""}`;
		return (
			<a href={stringHref} className={className} {...rest}>
				{children}
			</a>
		);
	},
}));

const SAMPLE_AGENTS: readonly AgentSummary[] = [
	{
		id: "main",
		kind: "main",
		parentId: null,
		task: "current",
		status: "running",
		startedAt: "2026-05-12T10:00:00Z",
		elapsedMs: 724_000,
		lastHeartbeatAt: null,
		pendingAuthRequest: null,
	},
	{
		id: "review-loop-r1",
		kind: "subagent",
		parentId: "main",
		task: "cross-review",
		status: "running",
		startedAt: "2026-05-12T10:00:00Z",
		elapsedMs: 134_000,
		lastHeartbeatAt: null,
		pendingAuthRequest: null,
	},
	{
		id: "lint-fixer",
		kind: "subagent",
		parentId: "main",
		task: "biome --write",
		status: "blocked",
		startedAt: "2026-05-12T10:00:00Z",
		elapsedMs: 38_000,
		lastHeartbeatAt: null,
		pendingAuthRequest: null,
	},
	{
		id: "dspy-validator",
		kind: "subagent",
		parentId: "main",
		task: "MIPROv2 done",
		status: "completed",
		startedAt: "2026-05-12T10:00:00Z",
		elapsedMs: 522_000,
		lastHeartbeatAt: null,
		pendingAuthRequest: null,
	},
];

describe("Wordmark", () => {
	it("renders bilingual brand", () => {
		render(<Wordmark />);
		expect(screen.getByText("Quilin")).toBeInTheDocument();
		expect(screen.getByText("麒麟")).toBeInTheDocument();
		expect(screen.getByText("quilt · 拼布")).toBeInTheDocument();
		expect(screen.getByText("qilin · 麒麟")).toBeInTheDocument();
	});
	it("supports intro variant", () => {
		const { container } = render(<Wordmark variant="intro" />);
		const wrap = container.querySelector(".q-wordmark-wrap");
		expect(wrap?.className).toContain("q-wordmark-intro");
	});
});

describe("AppHeader", () => {
	beforeEach(() => {
		document.documentElement.setAttribute("data-theme", "light");
	});

	it("renders version + session", () => {
		render(<AppHeader version="v0.0.99" sessionId="abcd" />);
		expect(screen.getByText("v0.0.99")).toBeInTheDocument();
		expect(screen.getByText(/session · abcd/)).toBeInTheDocument();
	});

	it("renders em-dash when no session", () => {
		render(<AppHeader sessionId={null} />);
		expect(screen.getByText(/session · —/)).toBeInTheDocument();
	});

	it("toggles theme attribute", () => {
		render(<AppHeader />);
		expect(document.documentElement.getAttribute("data-theme")).toBe("light");
		fireEvent.click(screen.getByTestId("theme-toggle"));
		expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
		fireEvent.click(screen.getByTestId("theme-toggle"));
		expect(document.documentElement.getAttribute("data-theme")).toBe("light");
	});

	it("respects initialTheme prop", () => {
		render(<AppHeader initialTheme="dark" />);
		expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
	});
});

describe("RailStrip", () => {
	it("renders default 6 items", () => {
		render(<RailStrip />);
		expect(screen.getByTestId("rail-sessions")).toBeInTheDocument();
		expect(screen.getByTestId("rail-memory")).toBeInTheDocument();
		expect(screen.getByTestId("rail-skills")).toBeInTheDocument();
		expect(screen.getByTestId("rail-mcp")).toBeInTheDocument();
		expect(screen.getByTestId("rail-tools")).toBeInTheDocument();
		expect(screen.getByTestId("rail-config")).toBeInTheDocument();
	});

	it("marks the active item by pathname", () => {
		render(<RailStrip />);
		const sessions = screen.getByTestId("rail-sessions");
		expect(sessions.className).toContain("active");
		const memory = screen.getByTestId("rail-memory");
		expect(memory.className).not.toContain("active");
	});

	it("renders pinned attribute when prop is true", () => {
		const { container } = render(<RailStrip pinned />);
		const aside = container.querySelector("aside");
		expect(aside?.getAttribute("data-pinned")).toBe("true");
	});

	it("accepts custom items", () => {
		render(
			<RailStrip
				items={[
					{
						target: "custom",
						glyph: "自定",
						nameCjk: "自定",
						nameEn: "Custom",
						desc: "x",
						count: 1,
						href: "/custom",
					},
				]}
			/>,
		);
		expect(screen.getByTestId("rail-custom")).toBeInTheDocument();
	});
});

describe("AgentSwitcher", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders selected agent label", () => {
		render(<AgentSwitcher agents={SAMPLE_AGENTS} currentAgentId="main" />);
		expect(screen.getByTestId("agent-switcher-toggle")).toHaveTextContent("主代理");
	});

	it("renders subagent label when current is a subagent", () => {
		render(<AgentSwitcher agents={SAMPLE_AGENTS} currentAgentId="review-loop-r1" />);
		expect(screen.getByTestId("agent-switcher-toggle")).toHaveTextContent(
			"子代理 · review-loop-r1",
		);
	});

	it("toggles the popover open + selects a row", () => {
		const onSelect = vi.fn();
		render(<AgentSwitcher agents={SAMPLE_AGENTS} currentAgentId="main" onSelect={onSelect} />);
		const toggle = screen.getByTestId("agent-switcher-toggle");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("data-active")).toBe("true");
		fireEvent.click(screen.getByText("review-loop-r1"));
		expect(onSelect).toHaveBeenCalledWith("review-loop-r1");
	});

	it("renders spawn button when onSpawn provided", () => {
		const onSpawn = vi.fn();
		render(<AgentSwitcher agents={SAMPLE_AGENTS} currentAgentId="main" onSpawn={onSpawn} />);
		fireEvent.click(screen.getByText(/派遣新子代理/));
		expect(onSpawn).toHaveBeenCalled();
	});

	it("closes the popover when clicking outside", () => {
		render(
			<>
				<AgentSwitcher agents={SAMPLE_AGENTS} currentAgentId="main" />
				<div data-testid="outside">outside</div>
			</>,
		);
		const toggle = screen.getByTestId("agent-switcher-toggle");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("data-active")).toBe("true");
		fireEvent.mouseDown(screen.getByTestId("outside"));
		expect(toggle.getAttribute("data-active")).toBe("false");
	});

	it("renders status glyph variants", () => {
		render(<AgentSwitcher agents={SAMPLE_AGENTS} currentAgentId="main" />);
		fireEvent.click(screen.getByTestId("agent-switcher-toggle"));
		// each agent kind / status produces a glyph (▪ ▢ ✕); the demo doesn't
		// pin specific glyphs to ids, just that each row renders one.
		const runningGlyphs = screen.getAllByText("▪");
		expect(runningGlyphs.length).toBeGreaterThan(0);
		expect(screen.getByText("✕")).toBeInTheDocument();
		expect(screen.getByText("▢")).toBeInTheDocument();
		expect(screen.getByText("lint-fixer")).toBeInTheDocument();
	});

	it("renders pending + cancelled + failed status glyphs", () => {
		const exotic: readonly AgentSummary[] = [
			{
				id: "pending-agent",
				kind: "subagent",
				parentId: "main",
				task: null,
				status: "pending",
				startedAt: "2026-05-12T10:00:00Z",
				elapsedMs: 1000,
				lastHeartbeatAt: null,
				pendingAuthRequest: null,
			},
			{
				id: "cancelled-agent",
				kind: "subagent",
				parentId: "main",
				task: null,
				status: "cancelled",
				startedAt: "2026-05-12T10:00:00Z",
				elapsedMs: 1000,
				lastHeartbeatAt: null,
				pendingAuthRequest: null,
			},
			{
				id: "failed-agent",
				kind: "subagent",
				parentId: "main",
				task: null,
				status: "failed",
				startedAt: "2026-05-12T10:00:00Z",
				elapsedMs: 1000,
				lastHeartbeatAt: null,
				pendingAuthRequest: null,
			},
		];
		render(<AgentSwitcher agents={exotic} currentAgentId="main" />);
		fireEvent.click(screen.getByTestId("agent-switcher-toggle"));
		expect(screen.getByText("○")).toBeInTheDocument();
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(screen.getByText("pending-agent")).toBeInTheDocument();
		expect(screen.getByText("cancelled-agent")).toBeInTheDocument();
		expect(screen.getByText("failed-agent")).toBeInTheDocument();
	});
});

describe("Composer", () => {
	it("submits typed text via Enter", () => {
		const onSubmit = vi.fn();
		render(<Composer agents={SAMPLE_AGENTS} currentAgentId="main" onSubmit={onSubmit} />);
		const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "hi" } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		expect(onSubmit).toHaveBeenCalledWith("hi");
		expect(input.value).toBe("");
	});

	it("ignores Shift+Enter and inserts a newline naturally", () => {
		const onSubmit = vi.fn();
		render(<Composer agents={SAMPLE_AGENTS} currentAgentId="main" onSubmit={onSubmit} />);
		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "hi" } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits via the send button", () => {
		const onSubmit = vi.fn();
		render(<Composer agents={SAMPLE_AGENTS} currentAgentId="main" onSubmit={onSubmit} />);
		fireEvent.change(screen.getByTestId("composer-input"), {
			target: { value: "test" },
		});
		fireEvent.click(screen.getByTestId("composer-send"));
		expect(onSubmit).toHaveBeenCalledWith("test");
	});

	it("does not submit empty text", () => {
		const onSubmit = vi.fn();
		render(<Composer agents={SAMPLE_AGENTS} currentAgentId="main" onSubmit={onSubmit} />);
		fireEvent.click(screen.getByTestId("composer-send"));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("hides the agent switcher in intro mode", () => {
		render(<Composer agents={SAMPLE_AGENTS} currentAgentId="main" intro />);
		expect(screen.queryByTestId("agent-switcher-toggle")).toBeNull();
	});

	it("applies hidden class when hidden", () => {
		const { container } = render(<Composer agents={SAMPLE_AGENTS} currentAgentId="main" hidden />);
		const footer = container.querySelector("footer");
		expect(footer?.className).toContain("hidden");
	});
});
