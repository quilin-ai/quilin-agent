import { describe, expect, test } from "vitest";
import type { BuildContext } from "./prompt-types.js";
import { classifyGap, createTemporalSection } from "./temporal.js";

const mockBuildCtx: BuildContext = {
	userInput: "你好",
	sessionState: {},
	modelId: "deepseek-chat",
	availableTools: [],
	profile: "full",
};

describe("classifyGap", () => {
	test("< 5 分钟为 normal", () => {
		expect(classifyGap(60)).toBe("normal");
	});

	test("10 分钟为 short_away", () => {
		expect(classifyGap(600)).toBe("short_away");
	});

	test("2 小时为 medium_away", () => {
		expect(classifyGap(7_200)).toBe("medium_away");
	});

	test("12 小时为 long_away", () => {
		expect(classifyGap(43_200)).toBe("long_away");
	});

	test("2 天为 cross_day", () => {
		expect(classifyGap(172_800)).toBe("cross_day");
	});
});

describe("createTemporalSection", () => {
	test("输出包含当前时间", () => {
		const section = createTemporalSection(() => ({
			currentTime: new Date("2026-04-15T12:00:00.000Z"),
			lastMessageTime: null,
			sessionStartTime: new Date("2026-04-15T11:30:00.000Z"),
			lastSessionEndTime: null,
		}));

		const content = section.compute(mockBuildCtx);

		expect(content).toContain("当前时间");
	});

	test("有上条消息时显示间隔", () => {
		const section = createTemporalSection(() => ({
			currentTime: new Date("2026-04-15T12:00:00.000Z"),
			lastMessageTime: new Date("2026-04-15T11:50:00.000Z"),
			sessionStartTime: new Date("2026-04-15T11:30:00.000Z"),
			lastSessionEndTime: null,
		}));

		const content = section.compute(mockBuildCtx);

		expect(content).toContain("距上条消息");
	});

	test("updateFrequency 是 per_turn", () => {
		const section = createTemporalSection(() => ({
			currentTime: new Date("2026-04-15T12:00:00.000Z"),
			lastMessageTime: null,
			sessionStartTime: new Date("2026-04-15T11:30:00.000Z"),
			lastSessionEndTime: null,
		}));

		expect(section.updateFrequency).toBe("per_turn");
	});
});
