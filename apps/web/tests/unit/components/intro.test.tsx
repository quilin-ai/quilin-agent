import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IntroScreen } from "@/components/intro/IntroScreen";
import type { SessionSummary } from "@/lib/schemas";

vi.mock("next/navigation", () => ({
	usePathname: () => "/",
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		className,
		"data-testid": testId,
	}: {
		children: React.ReactNode;
		href: string | { pathname: string; query?: Record<string, string> };
		className?: string;
		"data-testid"?: string;
	}) => {
		const stringHref =
			typeof href === "string"
				? href
				: `${href.pathname}${href.query ? `?${new URLSearchParams(href.query).toString()}` : ""}`;
		return (
			<a href={stringHref} className={className} data-testid={testId}>
				{children}
			</a>
		);
	},
}));

const recent: readonly SessionSummary[] = [
	{
		id: "s1",
		title: "self-evolution Stage D 状态查询",
		agentId: "main",
		turnsCount: 3,
		tokensTotal: 3_200,
		startedAt: "2026-05-12T13:45:00Z",
		lastTurnAt: new Date(Date.now() - 12 * 60_000).toISOString(),
		status: "active",
		costUsd: 0.12,
	},
];

describe("IntroScreen", () => {
	it("renders the wordmark + composer", () => {
		render(<IntroScreen recentSessions={[]} />);
		expect(screen.getByText("Quilin")).toBeInTheDocument();
		expect(screen.getByTestId("composer")).toBeInTheDocument();
	});

	it("renders recent sessions list", () => {
		render(<IntroScreen recentSessions={recent} />);
		expect(screen.getByText(/最近 · recent sessions/)).toBeInTheDocument();
		expect(screen.getByTestId("recent-s1")).toBeInTheDocument();
	});

	it("hides recent list when empty", () => {
		render(<IntroScreen recentSessions={[]} />);
		expect(screen.queryByText(/最近 · recent sessions/)).toBeNull();
	});
});
