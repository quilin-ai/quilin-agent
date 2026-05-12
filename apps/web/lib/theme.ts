/**
 * Quilin Agent · design tokens as TypeScript constants.
 *
 * The CSS source of truth lives in `app/globals.css` (ported from the locked
 * demo). This module re-exports values that need to be referenced from JS —
 * motion durations + easings used by client transitions, the type scale,
 * column widths used by Playwright snapshot assertions.
 *
 * NEVER override the CSS variable values here; update `globals.css` instead.
 */

export const motion = {
	durations: {
		instant: 0,
		fast: 120,
		base: 220,
		slow: 360,
		slower: 600,
		slowest: 720,
	},
	easings: {
		standard: "cubic-bezier(0.4, 0, 0.2, 1)",
		entrance: "cubic-bezier(0.32, 0.72, 0, 1)",
		linear: "linear",
	},
} as const;

export const layout = {
	columnWidthPx: 720,
	railStripPx: 56,
	railStripOpenPx: 280,
	agentPickerPx: 320,
	headHeightPx: 76,
	composerHeightPx: 88,
} as const;

export const fontStack = {
	serifEn: '"Cormorant Garamond", Georgia, serif',
	serifCjk: '"Noto Serif SC", serif',
	sansCjk: '"Noto Sans SC", sans-serif',
	mono: '"JetBrains Mono", monospace',
} as const;

/**
 * Theme name — must match the `data-theme` attribute on `<html>`. We default
 * to light per the static demo (line 2 `<html lang="zh-Hans" data-theme="light">`).
 */
export type ThemeName = "light" | "dark";

export const DEFAULT_THEME: ThemeName = "light";
