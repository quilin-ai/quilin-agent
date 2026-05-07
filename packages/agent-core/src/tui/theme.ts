/**
 * TUI Theme — ANSI escape code-based color schema, border styles, and ASCII logo.
 * No external dependencies; uses raw terminal control sequences for cross-runtime
 * compatibility (Bun / Node).
 */

// ---------------------------------------------------------------------------
// Raw ANSI escape codes
// ---------------------------------------------------------------------------

// biome-ignore lint: terminal control sequences with escape chars are required for ANSI colour output
export const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	blink: "\x1b[5m",
	invert: "\x1b[7m",
	hidden: "\x1b[8m",
	strikethrough: "\x1b[9m",
	// Foreground colours (3-bit)
	black: "\x1b[30m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	// Bright foreground colours (4-bit)
	brightBlack: "\x1b[90m",
	brightRed: "\x1b[91m",
	brightGreen: "\x1b[92m",
	brightYellow: "\x1b[93m",
	brightBlue: "\x1b[94m",
	brightMagenta: "\x1b[95m",
	brightCyan: "\x1b[96m",
	brightWhite: "\x1b[97m",
	// Background colours (3-bit)
	bgBlack: "\x1b[40m",
	bgRed: "\x1b[41m",
	bgGreen: "\x1b[42m",
	bgYellow: "\x1b[43m",
	bgBlue: "\x1b[44m",
	bgMagenta: "\x1b[45m",
	bgCyan: "\x1b[46m",
	bgWhite: "\x1b[47m",
	// Bright background colours (4-bit)
	bgBrightBlack: "\x1b[100m",
	bgBrightRed: "\x1b[101m",
	bgBrightGreen: "\x1b[102m",
	bgBrightYellow: "\x1b[103m",
	bgBrightBlue: "\x1b[104m",
	bgBrightMagenta: "\x1b[105m",
	bgBrightCyan: "\x1b[106m",
	bgBrightWhite: "\x1b[107m",
} as const;

// ---------------------------------------------------------------------------
// Semantic theme
// ---------------------------------------------------------------------------

/**
 * Semantic colour roles used across the TUI renderer.
 * Each role maps to a pre-composed ANSI sequence so consumers
 * never concatenate escape codes by hand.
 */
export const Theme = {
	/** Primary brand colour — cyan */
	primary: ANSI.cyan,
	/** Success / positive — green */
	success: ANSI.green,
	/** Warning / caution — yellow */
	warning: ANSI.yellow,
	/** Error / danger — red */
	error: ANSI.red,
	/** Dimmed / secondary text */
	dim: ANSI.dim,
	/** Highlighted / stand-out text — bold cyan */
	highlight: `${ANSI.bold}${ANSI.cyan}`,
	/** Muted / de-emphasised text — dim + bright-black */
	muted: `${ANSI.dim}${ANSI.brightBlack}`,
	/** Accent colour — magenta */
	accent: ANSI.magenta,
	/** Informational — blue */
	info: ANSI.blue,
	/** Section heading — bold bright-white */
	heading: `${ANSI.bold}${ANSI.brightWhite}`,
	/** Inline code / keybinding — bold yellow */
	keybinding: `${ANSI.bold}${ANSI.yellow}`,
	/** Slash command highlight — bold bright-magenta */
	slashCommand: `${ANSI.bold}${ANSI.brightMagenta}`,
	/** Tool name highlight — bright-green */
	toolName: ANSI.brightGreen,
} as const;

// ---------------------------------------------------------------------------
// Border styles (box-drawing Unicode)
// ---------------------------------------------------------------------------

export interface BorderSet {
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly vertical: string;
	readonly teeLeft: string;
	readonly teeRight: string;
	readonly teeTop: string;
	readonly teeBottom: string;
	readonly cross: string;
}

/** Single-line box-drawing borders. */
export const BORDER_SINGLE: BorderSet = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeLeft: "┤",
	teeRight: "├",
	teeTop: "┴",
	teeBottom: "┬",
	cross: "┼",
};

/** Double-line box-drawing borders. */
export const BORDER_DOUBLE: BorderSet = {
	topLeft: "╔",
	topRight: "╗",
	bottomLeft: "╚",
	bottomRight: "╝",
	horizontal: "═",
	vertical: "║",
	teeLeft: "╣",
	teeRight: "╠",
	teeTop: "╩",
	teeBottom: "╦",
	cross: "╬",
};

/** Rounded box-drawing borders. */
export const BORDER_ROUNDED: BorderSet = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeLeft: "┤",
	teeRight: "├",
	teeTop: "┴",
	teeBottom: "┬",
	cross: "┼",
};

/** Heavy box-drawing borders. */
export const BORDER_HEAVY: BorderSet = {
	topLeft: "┏",
	topRight: "┓",
	bottomLeft: "┗",
	bottomRight: "┛",
	horizontal: "━",
	vertical: "┃",
	teeLeft: "┫",
	teeRight: "┣",
	teeTop: "┻",
	teeBottom: "┳",
	cross: "╋",
};

/** Named border presets for convenient lookup. */
export const Borders = {
	single: BORDER_SINGLE,
	double: BORDER_DOUBLE,
	rounded: BORDER_ROUNDED,
	heavy: BORDER_HEAVY,
} as const;

export type BorderStyle = keyof typeof Borders;

// ---------------------------------------------------------------------------
// ASCII Logo
// ---------------------------------------------------------------------------

/**
 * Quilin (麒麟) Agent ASCII logo.
 * Rendered across 8 rows at ~60 columns; fits standard terminal widths.
 */
export const LOGO = [
	"",
	"   ██████╗ ██╗   ██╗██╗██╗     ██╗███╗   ██╗",
	"  ██╔═══██╗██║   ██║██║██║     ██║████╗  ██║",
	"  ██║   ██║██║   ██║██║██║     ██║██╔██╗ ██║",
	"  ██║▄▄ ██║██║   ██║██║██║     ██║██║╚██╗██║",
	"  ╚██████╔╝╚██████╔╝██║███████╗██║██║ ╚████║",
	"   ╚══▀▀═╝  ╚═════╝ ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝",
	"",
	"   █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
	"  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
	"  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║",
	"  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║",
	"  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║",
	"  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
	"",
].join("\n");

/** Compact one-line brand mark for narrow layouts (status bars, footers). */
export const BRAND_MARK = "🐉 Quilin Agent";

// ---------------------------------------------------------------------------
// Format helpers — convenience functions that wrap text in ANSI
// sequences with automatic reset.  Consumers should prefer these over
// raw `ANSI.*` / `Theme.*` concatenation.
// ---------------------------------------------------------------------------

/** Bold text. */
export function bold(text: string): string {
	return applyColor(text, ANSI.bold);
}

/** Dimmed text. */
export function dim(text: string): string {
	return applyColor(text, ANSI.dim);
}

/** Highlighted text (bold bright-cyan). */
export function highlight(text: string): string {
	return applyColor(text, Theme.highlight);
}

/** Success / positive indicator (green). */
export function success(text: string): string {
	return applyColor(text, ANSI.green);
}

/** Error / danger indicator (red). */
export function error(text: string): string {
	return applyColor(text, ANSI.red);
}

/** Warning / caution indicator (yellow). */
export function warn(text: string): string {
	return applyColor(text, ANSI.yellow);
}

// ---------------------------------------------------------------------------
// Measurement utilities
// ---------------------------------------------------------------------------

/** Regex matching any ANSI escape sequence (CSI). */
// biome-ignore lint: regex must match literal ESC control character
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Wrap `text` with `color` and an automatic reset.
 * Returns the original string when `color` is empty.
 */
export function applyColor(text: string, color: string): string {
	if (color.length === 0) {
		return text;
	}
	return `${color}${text}${ANSI.reset}`;
}

/**
 * Remove all ANSI escape sequences from `text`,
 * returning the plain-text equivalent.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/**
 * Measure the visible (printable) width of a string
 * by stripping ANSI codes and counting Unicode characters.
 * CJK characters count as 2 columns (East Asian Width).
 */
export function visibleWidth(text: string): number {
	const plain = stripAnsi(text);
	let width = 0;
	for (const char of plain) {
		const cp = char.codePointAt(0) ?? 0;
		// Rough East-Asian Width heuristic:
		// CJK Unified Ideographs, Hangul, fullwidth forms, etc.
		if (
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals … Yi
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
			(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
			(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
			(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
			(cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B … E
			(cp >= 0x30000 && cp <= 0x3fffd) // CJK Extension G … H
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/**
 * Pad `text` to `targetWidth` visible columns.
 * Adds spaces to the right (left-align).  If the text is already wider
 * than `targetWidth` it is returned unchanged.
 */
export function padVisible(text: string, targetWidth: number): string {
	const current = visibleWidth(text);
	if (current >= targetWidth) {
		return text;
	}
	return `${text}${" ".repeat(targetWidth - current)}`;
}

/**
 * Truncate `text` to at most `maxWidth` visible columns,
 * appending `ellipsis` when truncation occurs.
 * ANSI codes in the input are preserved in the prefix that fits.
 */
export function truncateVisible(
	text: string,
	maxWidth: number,
	ellipsis = "…",
): string {
	const plain = stripAnsi(text);
	if (plain.length <= maxWidth) {
		return text;
	}
	// Simple strategy: strip all ANSI, truncate the plain text, re-apply.
	// A full ANSI-aware truncation would be more involved; for most TUI use
	// cases (labels, table cells) plain truncation is sufficient.
	// Preserve leading ANSI codes so truncated text keeps its colour.
	const ansiPrefix = text.match(/^(\x1b\[[0-9;]*m)+/)?.[0] ?? "";
	const visible = plain.slice(0, Math.max(0, maxWidth - ellipsis.length));
	return ansiPrefix
		? `${ansiPrefix}${visible}${ellipsis}${ANSI.reset}`
		: `${visible}${ellipsis}`;
}
