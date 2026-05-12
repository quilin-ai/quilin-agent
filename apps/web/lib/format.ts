/**
 * Quilin Agent · UI formatting primitives
 *
 * Pure functions only — no `Intl`/`Date` side effects beyond what's needed for
 * deterministic output. All functions return human-readable strings styled to
 * match the bilingual demo (e.g. "12 分钟前 · 12 min ago").
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Bytes → "12 KB" style string. Matches demo `formatBytes` (line 2470).
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return "0 B";
	}
	if (bytes < 1024) {
		return `${Math.floor(bytes)} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Token count → "3.2k" style string (k / M suffix).
 */
export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) {
		return "0";
	}
	if (tokens < 1_000) {
		return tokens.toString();
	}
	if (tokens < 1_000_000) {
		return `${(tokens / 1_000).toFixed(1)}k`;
	}
	return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * Millisecond duration → "8m 41s" / "1.2s" / "84ms" — matches demo tool-call
 * status strings (line 1308 "▢ done · 84ms"; line 1594 "▢ done · 8m 41s").
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "0ms";
	}
	if (ms < 1_000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < MINUTE_MS) {
		return `${(ms / 1_000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / MINUTE_MS);
	const seconds = Math.round((ms - minutes * MINUTE_MS) / 1_000);
	if (ms < HOUR_MS) {
		return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	}
	const hours = Math.floor(ms / HOUR_MS);
	const remMinutes = Math.floor((ms - hours * HOUR_MS) / MINUTE_MS);
	return `${hours}h ${remMinutes.toString().padStart(2, "0")}m`;
}

/**
 * Relative time formatter — bilingual "刚刚 · just now" / "12 分钟前 · 12 min ago".
 * Used for sessions list rows + memory writes ("latest · 14:02 · main" pattern).
 */
export function formatRelativeTime(target: Date | string | number, now: Date = new Date()): string {
	const targetDate =
		target instanceof Date ? target : new Date(typeof target === "number" ? target : target);
	if (Number.isNaN(targetDate.getTime())) {
		return "—";
	}
	const diffMs = now.getTime() - targetDate.getTime();
	if (diffMs < 30 * SECOND_MS) {
		return "刚刚";
	}
	if (diffMs < MINUTE_MS) {
		const seconds = Math.floor(diffMs / SECOND_MS);
		return `${seconds} 秒前`;
	}
	if (diffMs < HOUR_MS) {
		const minutes = Math.floor(diffMs / MINUTE_MS);
		return `${minutes} 分钟前`;
	}
	if (diffMs < DAY_MS) {
		const hours = Math.floor(diffMs / HOUR_MS);
		return `${hours} 小时前`;
	}
	const days = Math.floor(diffMs / DAY_MS);
	if (days < 30) {
		return `${days} 天前`;
	}
	// fall back to date-style "5/12" for older entries
	return `${targetDate.getMonth() + 1}/${targetDate.getDate()}`;
}

/**
 * Coarse session bucket — matches the demo's date-grouped section titles
 * ("今天 · today", "昨天 · yesterday", "本周 · this week", "更早 · earlier").
 *
 * Returns a stable opaque key plus a bilingual label.
 */
export interface SessionBucket {
	readonly key: "today" | "yesterday" | "this-week" | "earlier";
	readonly label: string;
}

export function bucketByDate(
	target: Date | string | number,
	now: Date = new Date(),
): SessionBucket {
	const t =
		target instanceof Date ? target : new Date(typeof target === "number" ? target : target);
	if (Number.isNaN(t.getTime())) {
		return { key: "earlier", label: "更早 · earlier" };
	}
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const startOfYesterday = new Date(startOfToday.getTime() - DAY_MS);
	const startOfThisWeek = new Date(startOfToday.getTime() - 7 * DAY_MS);

	if (t.getTime() >= startOfToday.getTime()) {
		return { key: "today", label: "今天 · today" };
	}
	if (t.getTime() >= startOfYesterday.getTime()) {
		return { key: "yesterday", label: "昨天 · yesterday" };
	}
	if (t.getTime() >= startOfThisWeek.getTime()) {
		return { key: "this-week", label: "本周 · this week" };
	}
	return { key: "earlier", label: "更早 · earlier" };
}

/**
 * Stable bilingual time-of-day stamp (`14:02`) — used for in-day session rows
 * where the date is already implied by the section header.
 */
export function formatTimeOfDay(target: Date | string | number): string {
	const t =
		target instanceof Date ? target : new Date(typeof target === "number" ? target : target);
	if (Number.isNaN(t.getTime())) {
		return "—";
	}
	const hours = t.getHours().toString().padStart(2, "0");
	const minutes = t.getMinutes().toString().padStart(2, "0");
	return `${hours}:${minutes}`;
}
