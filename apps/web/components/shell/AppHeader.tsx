"use client";

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_THEME, type ThemeName } from "@/lib/theme";

export interface AppHeaderProps {
	readonly version?: string;
	readonly sessionId?: string | null;
	readonly initialTheme?: ThemeName;
}

/**
 * Top-of-page chrome — version badge + session id + theme toggle. The wordmark
 * lives in its own component since it floats outside the header rect in the
 * intro state (see demo lines 938–951).
 */
export function AppHeader({
	version = "v0.1.0-iter-f",
	sessionId,
	initialTheme = DEFAULT_THEME,
}: AppHeaderProps) {
	const [theme, setTheme] = useState<ThemeName>(initialTheme);

	useEffect(() => {
		if (typeof document === "undefined") return;
		document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);

	const onToggle = useCallback(() => {
		setTheme((prev) => (prev === "light" ? "dark" : "light"));
	}, []);

	const sessionLabel = sessionId ? `session · ${sessionId}` : "session · —";

	return (
		<header className="q-app-head" data-testid="app-header">
			<div className="q-head-meta">
				<span data-testid="app-version">{version}</span>
				<span data-testid="app-session">{sessionLabel}</span>
				<button
					type="button"
					className="q-theme-toggle"
					onClick={onToggle}
					aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
					data-testid="theme-toggle"
				>
					{theme} · 切换
				</button>
			</div>
		</header>
	);
}
