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
	truncateVisible,
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
	const titleWidth =
		options.title == null ? 0 : visibleWidth(stripAnsi(options.title)) + 2;
	const desiredInnerWidth = Math.max(contentWidth + pad * 2, titleWidth + 4);
	const innerWidth = Math.min(desiredInnerWidth, maxWidth);

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

	// Measure visible width without ANSI codes; use the original for display
	// so that any colour applied to the title is rendered inside the border.
	const plainTitle = stripAnsi(title);
	const titleVisibleWidth = visibleWidth(plainTitle);
	const decoratedTitle = ` ${title} `;
	const segmentVisibleWidth = titleVisibleWidth + 2; // +2 for surrounding spaces

	if (segmentVisibleWidth > innerWidth) {
		// Title too long — truncate to fit
		const truncated = `${plainTitle.slice(0, Math.max(0, innerWidth - 3))}…`;
		return `${border.topLeft} ${truncated}${repeat(border.horizontal, Math.max(0, innerWidth - truncated.length - 3))}${border.topRight}`;
	}

	const leftLen = Math.floor((innerWidth - segmentVisibleWidth) / 2);
	const rightLen = innerWidth - segmentVisibleWidth - leftLen;

	return [
		border.topLeft,
		repeat(border.horizontal, leftLen),
		decoratedTitle,
		repeat(border.horizontal, rightLen),
		border.topRight,
	].join("");
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface TableColumn<T> {
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
	/** Maximum total table width in visible columns. When the natural table width
	 *  exceeds this limit, columns are shrunk proportionally (minimum 3 cols each).
	 *  Default: no limit. */
	readonly maxWidth?: number;
}

/**
 * Render a formatted table.
 *
 * Column widths are determined by:
 * 1. Explicit `width` on the column definition, or
 * 2. The visible width of the header, or
 * 3. The visible width of the widest cell in that column.
 *
 * When `options.maxWidth` is set and the total table would exceed it,
 * columns are shrunk proportionally.
 *
 * Empty rows produce only the header with no data rows.
 * Single-column tables omit internal separators.
 *
 * ```text
 * ┌────┬──────────┬──────────────┐
 * │  # │ 时间     │ 最后输入     │
 * ├────┼──────────┼──────────────┤
 * │  1 │ 04-15 15 │ hello world  │
 * └────┴──────────┴──────────────┘
 * ```
 */
export function renderTable<T>(
	columns: readonly TableColumn<T>[],
	rows: readonly T[],
	options: TableOptions = {},
): string {
	const border = resolveBorder(options.borderStyle);

	if (columns.length === 0) {
		return "";
	}

	// Compute natural column widths
	const colWidths: number[] = columns.map((col) => {
		if (col.width != null) {
			return col.width;
		}
		let max = visibleWidth(col.header);
		for (const row of rows) {
			const cellValue = String(row[col.key] ?? "");
			const cellWidth = visibleWidth(cellValue);
			if (cellWidth > max) {
				max = cellWidth;
			}
		}
		return max;
	});

	// Clamp to maxWidth when specified
	if (options.maxWidth != null && options.maxWidth > 0) {
		const totalInnerWidth =
			colWidths.reduce((sum, w) => sum + w, 0) +
			(columns.length - 1) * 3 +
			2;
		if (totalInnerWidth > options.maxWidth) {
			const available = options.maxWidth - (columns.length - 1) * 3 - 2;
			const totalColWidth = colWidths.reduce((sum, w) => sum + w, 0);
			const scale = available / totalColWidth;
			for (let i = 0; i < colWidths.length; i++) {
				colWidths[i] = Math.max(3, Math.floor((colWidths[i] ?? 0) * scale));
			}
		}
	}

	const bars = buildTableBars(colWidths, border);

	// Header row
	const headerCells = columns.map((col, idx) =>
		padCell(applyColor(col.header, Theme.dim), colWidths[idx] ?? 0, col.align ?? "left"),
	);
	const headerRow = `${border.vertical} ${headerCells.join(` ${border.vertical} `)} ${border.vertical}`;

	// Data rows — each logical row may span multiple visual lines via word-wrap
	const rowBlocks: string[] = [];
	for (let r = 0; r < rows.length; r++) {
		const row = rows[r] as T;
		const multi = columns.map((col, idx) =>
			wordWrap(
				String(row[col.key] ?? ""),
				colWidths[idx] ?? 0,
			).map((line) =>
				padCellLine(line, colWidths[idx] ?? 0, col.align ?? "left"),
			),
		);
		const maxLines = Math.max(...multi.map((l) => l.length), 1);
		for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
			const cells = columns.map((_col, cIdx) => {
				const lines = multi[cIdx] ?? [];
				return lines[lineIdx] ?? " ".repeat(colWidths[cIdx] ?? 0);
			});
			rowBlocks.push(
				`${border.vertical} ${cells.join(` ${border.vertical} `)} ${border.vertical}`,
			);
		}
		// Separator between logical rows (but not after the last one)
		if (r < rows.length - 1) {
			rowBlocks.push(bars.mid);
		}
	}

	let result = bars.top;
	result += `\n${headerRow}`;
	if (rows.length > 0) {
		result += `\n${bars.mid}`;
		result += `\n${rowBlocks.join("\n")}`;
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

	if (textWidth > width) {
		return truncateVisible(text, width, "…");
	}

	if (textWidth === width) {
		return text;
	}

	const remaining = width - textWidth;

	switch (align) {
		case "right":
			return `${" ".repeat(remaining)}${text}`;
		case "center": {
			const leftLen = Math.floor(remaining / 2);
			const rightLen = remaining - leftLen;
			return `${" ".repeat(leftLen)}${text}${" ".repeat(rightLen)}`;
		}
		default:
			return `${text}${" ".repeat(remaining)}`;
	}
}

// ---------------------------------------------------------------------------
// Word-wrap
// ---------------------------------------------------------------------------

/**
 * Split `text` into lines, each no wider than `maxWidth` visual columns.
 * Breaks on word boundaries where possible; falls back to hard-break for
 * words that are themselves too long. ANSI escapes are preserved.
 */
function wordWrap(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const plain = stripAnsi(text);
	if (visibleWidth(plain) <= maxWidth) return [text];

	const lines: string[] = [];
	let lineStart = 0;
	let lineWidth = 0;
	let lastBreak = 0; // byte offset of last word boundary in current line

	for (let i = 0; i < text.length; ) {
		const ch = text[i] ?? "";
		const plainCh = plain[i] ?? "";
		const chWidth = plainCh ? visibleWidth(plainCh) : 0;

		if (chWidth === 0 && ch === "\x1b") {
			// Skip ANSI escape sequence
			const end = text.indexOf("m", i);
			i = end === -1 ? i + 1 : end + 1;
			continue;
		}

		// Word boundary
		if (plainCh === " " || plainCh === "\t" || plainCh === "\n") {
			lastBreak = i;
		}

		if (plainCh === "\n") {
			lines.push(text.slice(lineStart, i));
			lineStart = i + 1;
			lineWidth = 0;
			lastBreak = 0;
			i++;
			continue;
		}

		lineWidth += chWidth;

		if (lineWidth > maxWidth) {
			if (lastBreak > lineStart) {
				lines.push(text.slice(lineStart, lastBreak));
				lineStart = lastBreak + 1; // skip the space
				lineWidth = 0;
				// Re-measure from after the break
				for (let j = lineStart; j <= i; j++) {
					const pj = plain[j] ?? "";
					lineWidth += pj ? visibleWidth(pj) : 0;
				}
				lastBreak = 0;
			} else {
				// No word boundary found — hard break at current position
				lines.push(text.slice(lineStart, i));
				lineStart = i;
				lineWidth = chWidth;
			}
		}

		i++;
	}

	if (lineStart < text.length) {
		lines.push(text.slice(lineStart));
	}

	return lines.length > 0 ? lines : [text];
}

/**
 * Pad a single cell line (used after word-wrapping).
 * Does NOT truncate — the caller already ensured it fits.
 */
function padCellLine(
	line: string,
	width: number,
	align: "left" | "right" | "center",
): string {
	const w = visibleWidth(stripAnsi(line));
	if (w >= width) return line;
	const pad = width - w;
	switch (align) {
		case "right":
			return `${" ".repeat(pad)}${line}`;
		case "center": {
			const leftLen = Math.floor(pad / 2);
			return `${" ".repeat(leftLen)}${line}${" ".repeat(pad - leftLen)}`;
		}
		default:
			return `${line}${" ".repeat(pad)}`;
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
 * ANSI escape codes in both `left` and `right` are measured transparently
 * (stripped before width calculation) so alignment is never broken by colour.
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

	// If the combined visible text is wider than the available width,
	// render side-by-side with no gap rather than breaking layout.
	if (gap <= 0 && leftVisible + rightVisible > 0) {
		return `${options.left}${options.right}`;
	}

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
