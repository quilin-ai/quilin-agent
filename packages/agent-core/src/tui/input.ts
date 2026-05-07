/**
 * TUI Input — enhanced readline helpers for the Quilin REPL.
 *
 * Provides:
 *  - InputHistory       — searchable command history with timestamp
 *  - highlightSyntax    — syntax highlighting for slash commands & tool names
 *  - MultiLineAccumulator — multi-line input state machine
 *
 * These utilities are designed to be composed with Node.js readline or
 * a future raw-mode input loop without modifying the existing repl.ts.
 */

import { applyColor, Theme } from "./theme.js";

// ---------------------------------------------------------------------------
// Input History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
	readonly input: string;
	readonly timestamp: number;
}

export interface InputHistoryOptions {
	/** Maximum number of entries to keep (oldest evicted first). Default: 500. */
	readonly maxSize?: number;
}

/**
 * Searchable, bounded command history.
 *
 * Maintains a ring of `HistoryEntry` objects that can be navigated with
 * "previous" / "next" (arrow-key semantics) or searched by substring.
 */
export class InputHistory {
	private readonly entries: HistoryEntry[] = [];
	private readonly maxSize: number;
	private cursor = -1;
	private savedLine: string | undefined;

	constructor(options: InputHistoryOptions = {}) {
		this.maxSize = Math.max(1, options.maxSize ?? 500);
	}

	/** Add a new entry.  Blank strings and consecutive duplicates are ignored. */
	add(input: string): void {
		const trimmed = input.trim();
		if (trimmed.length === 0) {
			return;
		}
		const latest = this.entries.at(-1);
		if (latest != null && latest.input === trimmed) {
			return;
		}
		this.entries.push({ input: trimmed, timestamp: Date.now() });
		if (this.entries.length > this.maxSize) {
			this.entries.splice(0, this.entries.length - this.maxSize);
		}
		this.resetNavigation();
	}

	/**
	 * Begin navigating history.  Call this when the user presses Up.
	 * Saves the current "in-progress" line so it can be restored later.
	 * Does NOT consume an entry — the caller must call previous() separately.
	 */
	startNavigation(currentLine: string): void {
		this.savedLine = currentLine;
		this.cursor = this.entries.length;
	}

	/** Move one entry older (Up arrow). Stays at the oldest entry when at the boundary. */
	previous(): string | undefined {
		if (this.entries.length === 0) {
			return undefined;
		}
		if (this.cursor >= this.entries.length) {
			this.cursor = this.entries.length - 1;
			return this.entries[this.cursor]?.input;
		}
		if (this.cursor > 0) {
			this.cursor -= 1;
			return this.entries[this.cursor]?.input;
		}
		// At the boundary, return the oldest entry again
		return this.entries[0]?.input;
	}

	/** Move one entry newer (Down arrow). Returns the saved line after passing the newest entry. */
	next(): string | undefined {
		if (this.cursor < 0) {
			return undefined;
		}
		if (this.cursor >= this.entries.length - 1) {
			this.cursor = this.entries.length;
			return this.savedLine;
		}
		this.cursor += 1;
		return this.entries[this.cursor]?.input;
	}

	/** Stop navigating and reset the internal cursor. */
	resetNavigation(): void {
		this.cursor = this.entries.length;
		this.savedLine = undefined;
	}

	/**
	 * Search history entries whose input contains `query` (case-insensitive).
	 * Returns entries ordered most-recent-first.
	 */
	search(query: string): readonly HistoryEntry[] {
		if (query.length === 0) {
			return this.getRecent();
		}
		const lower = query.toLowerCase();
		const results = this.entries.filter((entry) =>
			entry.input.toLowerCase().includes(lower),
		);
		// Most recent first
		return [...results].reverse();
	}

	/**
	 * Return the most recent N entries (default: all).
	 */
	getRecent(limit?: number): readonly HistoryEntry[] {
		const recent = [...this.entries].reverse();
		return limit == null ? recent : recent.slice(0, limit);
	}

	/** Total number of entries stored. */
	get size(): number {
		return this.entries.length;
	}
}

// ---------------------------------------------------------------------------
// Syntax Highlighting
// ---------------------------------------------------------------------------

/** Regex matching a slash command pattern: /word or /word arg1 arg2 */
const SLASH_COMMAND_RE = /^(\/[a-zA-Z_][\w-]*)\b(.*)$/u;

/**
 * Apply syntax highlighting to a line of input.
 * Currently recognises:
 *  - Slash commands: `/help`, `/status`, etc.
 *  - Tool invocations: `tool_name(arg, ...)`
 */
export function highlightSyntax(line: string): string {
	let result = line;

	// Highlight full-line slash commands
	result = highlightSlashCommands(result);

	return result;
}

/**
 * Highlight slash-command patterns in text.
 * `/word` and `/word args` are highlighted.
 */
export function highlightSlashCommands(text: string): string {
	const lines = text.split("\n");
	return lines
		.map((line) => {
			const trimmed = line.trimStart();
			const match = SLASH_COMMAND_RE.exec(trimmed);
			if (match == null) {
				return line;
			}
			const leadingWhitespace = line.slice(
				0,
				Math.max(0, line.length - trimmed.length),
			);
			const command = match[1] ?? "";
			const rest = match[2] ?? "";
			return `${leadingWhitespace}${applyColor(command, Theme.slashCommand)}${rest}`;
		})
		.join("\n");
}

/**
 * Highlight tool-name patterns in text.
 * Matches word characters followed by `(` — a common tool-call syntax.
 */
export function highlightToolNames(text: string): string {
	// Match identifiers immediately followed by an opening parenthesis
	const TOOL_RE = /([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)(\()/gu;
	return text.replace(TOOL_RE, (_full, name, paren) => {
		return `${applyColor(name as string, Theme.toolName)}${paren as string}`;
	});
}

// ---------------------------------------------------------------------------
// Multi-line input accumulator
// ---------------------------------------------------------------------------

export interface MultiLineAccumulatorOptions {
	/**
	 * Terminator string that signals the end of multi-line input.
	 * Default: a line containing only "." (like ed / mail).
	 */
	readonly terminator?: string;
}

export interface MultiLineResult {
	/** Whether the accumulator has completed gathering input. */
	readonly done: boolean;
	/** The accumulated input (all lines joined by \n). Only meaningful when done. */
	readonly content: string;
	/** Number of lines accumulated so far. */
	readonly lineCount: number;
}

/**
 * Stateful multi-line input accumulator.
 *
 * Feeds lines one at a time.  Input is considered complete when the
 * terminator line is received (default: a solitary "." line).
 *
 * ```typescript
 * const acc = new MultiLineAccumulator();
 * acc.feed("line one");   // → { done: false, content: "", lineCount: 1 }
 * acc.feed("line two");   // → { done: false, content: "", lineCount: 2 }
 * acc.feed(".");          // → { done: true,  content: "line one\\nline two", lineCount: 2 }
 * ```
 */
export class MultiLineAccumulator {
	private readonly lines: string[] = [];
	private readonly terminator: string;

	constructor(options: MultiLineAccumulatorOptions = {}) {
		this.terminator = options.terminator ?? ".";
	}

	/**
	 * Feed one line of input.  Returns the accumulation status.
	 */
	feed(line: string): MultiLineResult {
		const trimmed = line.trimEnd();

		if (trimmed === this.terminator) {
			const content = this.lines.join("\n");
			this.reset();
			return { done: true, content, lineCount: 0 };
		}

		this.lines.push(line);
		return { done: false, content: "", lineCount: this.lines.length };
	}

	/** Discard all in-progress lines. */
	reset(): void {
		this.lines.length = 0;
	}

	/** Number of lines buffered so far. */
	get bufferedCount(): number {
		return this.lines.length;
	}
}
