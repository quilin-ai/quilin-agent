/**
 * TUI Renderer — composable layout primitives for terminal output.
 *
 * Provides:
 *  - panel()      — bordered box with optional title, header, body, footer
 *  - table()      — ASCII / Unicode table renderer
 *  - header()     — stylised section header
 *  - footer()     — dim status-line footer
 *  - divider()    — horizontal rule
 *  - statusLine() — left / right split status bar
 *
 * All functions return plain strings (with embedded ANSI escapes) that
 * can be written directly to `process.stderr`.
 */

import {
	applyColor,
	Theme,
	type BorderSet,
	type BorderStyle,
	Borders,
	LOGO,
	padVisible,
	stripAnsi,
	visibleWidth,
} from "./theme.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBorder(style: BorderStyle | undefined): BorderSet {
	return Borders[style ?? "single"];
}

function repeat(char: string, count: number): string {
	if (count <= 0) {
		return "";
	}
	return char.repeat(count);
}

/**
 * Split text into individual lines (respecting existing \n)
 * and measure the visible width of the widest line.
 */
function measureMaxWidth(text: string): number {
	const lines = text.split("\n");
	if (lines.length === 0) {
		return 0;
	}
	return Math.max(...lines.map((line) => visibleWidth(line)));
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface PanelOptions {
	/** Panel title rendered in the top border. */
	readonly title?: string;
	/** Border style preset. Default: "single". */
	readonly borderStyle?: BorderStyle;
	/** Number of spaces of horizontal padding inside the panel. Default: 1. */
	readonly padding?: number;
	/** Maximum content width before wrapping. Default: terminal width or 80. */
	readonly maxWidth?: number;
}

/**
 * Render content inside a bordered panel.
 *
 * ```text
 * ┌─ Title ─────────────┐
 * │ Content line 1      │
 * │ Content line 2      │
 * └─────────────────────┘
 * ```
 */
export function renderPanel(content: string, options: PanelOptions = {}): string {
	const border = resolveBorder(options.borderStyle);
	const pad = options.padding ?? 1;
	const maxWidth = options.maxWidth ?? 80;

	const contentLines = content.split("\n");
	const contentWidth = measureMaxWidth(content);
	const innerWidth = Math.min(contentWidth + pad * 2, maxWidth);

	const topBar = renderPanelTopBar(innerWidth, border, options.title);
	const bottomBar = `${border.bottomLeft}${repeat(border.horizontal, innerWidth)}${border.bottomRight}`;

	const paddedLines = contentLines.map((line) => {
		const visibleLen = visibleWidth(line);
		const rightPad = Math.max(0, innerWidth - visibleLen - pad);
		return `${border.vertical}${" ".repeat(pad)}${line}${" ".repeat(rightPad)}${border.vertical}`;
	});

	return [topBar, ...paddedLines, bottomBar].join("\n");
}

function renderPanelTopBar(
	innerWidth: number,
	border: BorderSet,
	title: string | undefined,
): string {
	if (title == null || title.length === 0) {
		return `${border.topLeft}${repeat(border.horizontal, innerWidth)}${border.topRight}`;
	}

	const plainTitle = stripAnsi(title);
	const visibleTitleLen = visibleWidth(plainTitle);
	const titleSegment = ` ${plainTitle} `;
	const titleLen = titleSegment.length;

	if (titleLen + 2 > innerWidth) {
		// Title too long — truncate
		const truncated = `${plainTitle.slice(0, Math.max(0, innerWidth - 5))}…`;
		return `${border.topLeft}${truncated}${repeat(border.horizontal, Math.max(0, innerWidth - truncated.length))}${border.topRight}`;
	}

	const leftLen = Math.floor((innerWidth - titleLen) / 2);
	const rightLen = innerWidth - titleLen - leftLen;

	return [
		border.topLeft,
		repeat(border.horizontal, leftLen),
		titleSegment,
		repeat(border.horizontal, rightLen),
		border.topRight,
	].join("");
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface TableColumn<T extends Record<string, string | undefined>> {
	/** Column header text. */
	readonly header: string;
	/** Key into the row object. */
	readonly key: keyof T & string;
	/** Fixed column width in visible columns. Auto-calculated when omitted. */
	readonly width?: number;
	/** Text alignment. Default: "left". */
	readonly align?: "left" | "right" | "center";
}

export interface TableOptions {
	readonly borderStyle?: BorderStyle;
}

/**
 * Render a formatted table.
 *
 * Column widths are determined by:
 * 1. Explicit `width` on the column definition, or
 * 2. The visible width of the header, or
 * 3. The visible width of the widest cell in that column.
 *
 * ```text
 * ┌────┬──────────┬──────────────┐
 * │  # │ 时间     │ 最后输入     │
 * ├────┼──────────┼──────────────┤
 * │  1 │ 04-15 15 │ hello world  │
 * └────┴──────────┴──────────────┘
 * ```
 */
export function renderTable<T extends Record<string, string | undefined>>(
	columns: readonly TableColumn<T>[],
	rows: readonly T[],
	options: TableOptions = {},
): string {
	const border = resolveBorder(options.borderStyle);

	if (columns.length === 0) {
		return "";
	}

	// Compute column widths
	const colWidths: number[] = columns.map((col) => {
		if (col.width != null) {
			return col.width;
		}
		let max = visibleWidth(col.header);
		for (const row of rows) {
			const cellValue = row[col.key] ?? "";
			const cellWidth = visibleWidth(cellValue);
			if (cellWidth > max) {
				max = cellWidth;
			}
		}
		return max;
	});

	const totalInnerWidth =
		colWidths.reduce((sum, w) => sum + w, 0) + (columns.length - 1) * 3 + 2;
	const bars = buildTableBars(colWidths, border);

	const headerCells = columns.map((col, idx) =>
		padCell(col.header, colWidths[idx] ?? 0, col.align ?? "left"),
	);
	const headerRow = `${border.vertical} ${headerCells.join(` ${border.vertical} `)} ${border.vertical}`;

	const rowLines = rows.map((row) => {
		const cells = columns.map((col, idx) => {
			const value = row[col.key] ?? "";
			return padCell(value, colWidths[idx] ?? 0, col.align ?? "left");
		});
		return `${border.vertical} ${cells.join(` ${border.vertical} `)} ${border.vertical}`;
	});

	let result = bars.top;
	result += `\n${headerRow}`;
	result += `\n${bars.mid}`;
	if (rows.length > 0) {
		result += `\n${rowLines.join("\n")}`;
	}
	result += `\n${bars.bottom}`;

	return result;
}

interface TableBars {
	readonly top: string;
	readonly mid: string;
	readonly bottom: string;
}

function buildTableBars(colWidths: number[], border: BorderSet): TableBars {
	const segments = colWidths.map((w) => repeat(border.horizontal, w + 2));

	const top = `${border.topLeft}${segments.join(border.teeBottom)}${border.topRight}`;
	const mid = `${border.teeRight}${segments.join(border.cross)}${border.teeLeft}`;
	const bottom = `${border.bottomLeft}${segments.join(border.teeTop)}${border.bottomRight}`;

	return { top, mid, bottom };
}

function padCell(text: string, width: number, align: "left" | "right" | "center"): string {
	const plain = stripAnsi(text);
	const textWidth = visibleWidth(plain);

	if (textWidth >= width) {
		return text;
	}

	const remaining = width - textWidth;

	switch (align) {
		case "right":
			return `${" ".repeat(remaining)}${text}`;
		case "center": {
			const left = Math.floor(remaining / 2);
			const right = remaining - left;
			return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
		}
		default: // left
			return `${text}${" ".repeat(remaining)}`;
	}
}

// ---------------------------------------------------------------------------
// Section header / footer
// ---------------------------------------------------------------------------

/**
 * Render a stylised section header.
 * Returns the header text wrapped in the heading colour and underlined with dashes.
 */
export function renderHeader(text: string): string {
	const colored = applyColor(text, Theme.heading);
	const underline = repeat("─", visibleWidth(text));
	return `${colored}\n${applyColor(underline, Theme.dim)}`;
}

/**
 * Render a dimmed footer line (e.g. status bar at the bottom).
 */
export function renderFooter(text: string): string {
	return applyColor(text, Theme.dim);
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export interface DividerOptions {
	readonly char?: string;
	readonly width?: number;
}

/**
 * Render a horizontal divider line.
 */
export function renderDivider(options: DividerOptions = {}): string {
	const char = options.char ?? "─";
	const width = options.width ?? 80;
	return repeat(char, width);
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export interface StatusLineOptions {
	readonly left: string;
	readonly right: string;
	readonly width?: number;
}

/**
 * Render a single-line status bar with left- and right-aligned text.
 *
 * ```text
 * Left content                  Right content
 * ```
 */
export function renderStatusLine(options: StatusLineOptions): string {
	const width = options.width ?? 80;
	const leftVisible = visibleWidth(options.left);
	const rightVisible = visibleWidth(options.right);
	const gap = Math.max(0, width - leftVisible - rightVisible);

	return `${options.left}${" ".repeat(gap)}${options.right}`;
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

/**
 * Return the coloured Quilin ASCII logo.
 */
export function renderLogo(): string {
	return applyColor(LOGO, Theme.primary);
}

// ---------------------------------------------------------------------------
// Composable layout
// ---------------------------------------------------------------------------

export interface LayoutSection {
	readonly header?: string;
	readonly content: string;
	readonly footer?: string;
}

export interface LayoutOptions {
	readonly sections: readonly LayoutSection[];
	readonly panelOptions?: Omit<PanelOptions, "title">;
}

/**
 * Render multiple sections separated by dividers in a vertical layout.
 * Each section gets an optional header and footer.
 */
export function renderLayout(options: LayoutOptions): string {
	const parts: string[] = [];

	for (let i = 0; i < options.sections.length; i++) {
		const section = options.sections[i] as LayoutSection;

		if (section.header != null) {
			parts.push(renderHeader(section.header));
		}
		parts.push(section.content);
		if (section.footer != null) {
			parts.push(renderFooter(section.footer));
		}
		// Add divider between sections (not after the last)
		if (i < options.sections.length - 1) {
			parts.push(renderDivider());
		}
	}

	return parts.join("\n");
}
