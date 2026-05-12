import { describe, expect, it } from "vitest";

import {
	bucketByDate,
	formatBytes,
	formatDuration,
	formatRelativeTime,
	formatTimeOfDay,
	formatTokens,
} from "@/lib/format";

describe("formatBytes", () => {
	it("returns bytes for < 1 KiB", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});
	it("returns KB / MB / GB with one decimal", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
	});
	it("guards against negative / NaN", () => {
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
	});
});

describe("formatTokens", () => {
	it("returns raw count for < 1k", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});
	it("uses k suffix for thousands", () => {
		expect(formatTokens(7_300)).toBe("7.3k");
		expect(formatTokens(120_000)).toBe("120.0k");
	});
	it("uses M suffix for millions", () => {
		expect(formatTokens(1_500_000)).toBe("1.50M");
	});
	it("guards against negative / NaN", () => {
		expect(formatTokens(-1)).toBe("0");
		expect(formatTokens(Number.NaN)).toBe("0");
	});
});

describe("formatDuration", () => {
	it("renders ms for < 1s", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(84)).toBe("84ms");
	});
	it("renders seconds for < 60s", () => {
		expect(formatDuration(1_200)).toBe("1.2s");
		expect(formatDuration(59_500)).toBe("59.5s");
	});
	it("renders minutes for < 60min", () => {
		expect(formatDuration(8 * 60_000 + 41_000)).toBe("8m 41s");
	});
	it("renders hours for > 60min", () => {
		expect(formatDuration(2 * 3_600_000 + 30 * 60_000)).toBe("2h 30m");
	});
	it("guards against negative / NaN", () => {
		expect(formatDuration(-100)).toBe("0ms");
		expect(formatDuration(Number.NaN)).toBe("0ms");
	});
});

describe("formatRelativeTime", () => {
	const now = new Date("2026-05-12T14:00:00Z");

	it("just now bucket", () => {
		expect(formatRelativeTime(new Date(now.getTime() - 5_000), now)).toBe("刚刚");
	});
	it("seconds bucket", () => {
		expect(formatRelativeTime(new Date(now.getTime() - 45_000), now)).toBe("45 秒前");
	});
	it("minutes bucket", () => {
		expect(formatRelativeTime(new Date(now.getTime() - 12 * 60_000), now)).toBe("12 分钟前");
	});
	it("hours bucket", () => {
		expect(formatRelativeTime(new Date(now.getTime() - 3 * 3_600_000), now)).toBe("3 小时前");
	});
	it("days bucket", () => {
		expect(formatRelativeTime(new Date(now.getTime() - 4 * 86_400_000), now)).toBe("4 天前");
	});
	it("falls back to date for > 30 days", () => {
		expect(formatRelativeTime(new Date("2026-03-15T00:00:00Z"), now)).toMatch(/^\d+\/\d+$/);
	});
	it("accepts string + number inputs", () => {
		expect(formatRelativeTime("2026-05-12T13:50:00Z", now)).toBe("10 分钟前");
		expect(formatRelativeTime(now.getTime() - 60_000, now)).toBe("1 分钟前");
	});
	it("returns em-dash for invalid", () => {
		expect(formatRelativeTime("not-a-date", now)).toBe("—");
	});
});

describe("formatTimeOfDay", () => {
	it("renders HH:MM zero-padded", () => {
		expect(formatTimeOfDay(new Date(2026, 4, 12, 7, 5))).toBe("07:05");
		expect(formatTimeOfDay(new Date(2026, 4, 12, 14, 30))).toBe("14:30");
	});
	it("returns em-dash for invalid", () => {
		expect(formatTimeOfDay("not-a-date")).toBe("—");
	});
});

describe("bucketByDate", () => {
	const now = new Date("2026-05-12T14:00:00Z");

	it("today bucket", () => {
		expect(bucketByDate(new Date("2026-05-12T08:00:00Z"), now).key).toBe("today");
	});
	it("yesterday bucket", () => {
		expect(bucketByDate(new Date("2026-05-11T14:00:00Z"), now).key).toBe("yesterday");
	});
	it("this-week bucket", () => {
		expect(bucketByDate(new Date("2026-05-08T14:00:00Z"), now).key).toBe("this-week");
	});
	it("earlier bucket", () => {
		expect(bucketByDate(new Date("2026-04-15T14:00:00Z"), now).key).toBe("earlier");
	});
	it("invalid falls into earlier", () => {
		expect(bucketByDate("not-a-date", now).key).toBe("earlier");
	});
	it("label is bilingual", () => {
		expect(bucketByDate(new Date("2026-05-12T08:00:00Z"), now).label).toBe("今天 · today");
	});
	it("accepts number + string inputs", () => {
		const todayTs = new Date("2026-05-12T08:00:00Z").getTime();
		expect(bucketByDate(todayTs, now).key).toBe("today");
		expect(bucketByDate("2026-05-12T08:00:00Z", now).key).toBe("today");
	});
});

describe("formatTimeOfDay extra paths", () => {
	it("accepts number input", () => {
		const ts = new Date(2026, 4, 12, 9, 7).getTime();
		expect(formatTimeOfDay(ts)).toBe("09:07");
	});
	it("accepts string input", () => {
		expect(formatTimeOfDay("2026-05-12T03:04:00")).toMatch(/^\d{2}:\d{2}$/);
	});
});
