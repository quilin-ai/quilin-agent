import { afterEach, describe, expect, test, vi } from "vitest";
import type { BuildContext } from "./prompt-types.js";
import {
	classifyGap,
	createTemporalBucketSection,
	decoratePreciseTemporalUserInput,
} from "./temporal.js";

const mockBuildCtx: BuildContext = {
	userInput: "你好",
	sessionState: {},
	modelId: "deepseek-chat",
	availableTools: [],
	profile: "full",
};

afterEach(() => {
	vi.useRealTimers();
});

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

describe("createTemporalBucketSection", () => {
	test("输出桶化时间信息而不是精确当前时间戳", () => {
		const section = createTemporalBucketSection();
		const content = section.compute({
			...mockBuildCtx,
			sessionState: {
				temporal: {
					currentTime: "2026-04-15T12:00:00.000Z",
					sessionStartTime: "2026-04-15T11:30:00.000Z",
				},
			},
		});

		expect(content).toContain("[时间桶]");
		expect(content).toContain("日期桶: 2026-04-15");
		expect(content).not.toContain("2026-04-15T12:00:00.000Z");
		expect(content).not.toContain("时间桶:");
	});

	test("日期桶锚定到 sessionStartTime，即使 currentTime 跨日", () => {
		const section = createTemporalBucketSection();
		const content = section.compute({
			...mockBuildCtx,
			sessionState: {
				temporal: {
					currentTime: "2026-04-22T00:01:00.000Z",
					lastMessageTime: "2026-04-21T23:59:00.000Z",
					sessionStartTime: "2026-04-21T23:30:00.000Z",
					lastSessionEndTime: "2026-04-21T08:00:00.000Z",
				},
			},
		});

		expect(content).toContain("日期桶: 2026-04-21");
		expect(content).toContain("消息间隔桶: normal");
		expect(content).toContain("跨 session 桶: long_away");
		expect(content).not.toContain("日期桶: 2026-04-22");
	});

	test("updateFrequency 是 per_session", () => {
		const section = createTemporalBucketSection();
		expect(section.updateFrequency).toBe("per_session");
	});

	test("没有 temporal session state 时使用当前时间并省略 gap 桶", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-25T02:03:04.000Z"));
		const section = createTemporalBucketSection();

		const content = section.compute(mockBuildCtx);

		expect(content).toBe("[时间桶]\n日期桶: 2026-04-25");
	});
});

describe("decoratePreciseTemporalUserInput", () => {
	test("prefixes the latest user input with precise temporal context", () => {
		const decorated = decoratePreciseTemporalUserInput("你好", {
			currentTime: new Date("2026-04-15T12:00:00.000Z"),
			lastMessageTime: new Date("2026-04-15T11:50:00.000Z"),
			sessionStartTime: new Date("2026-04-15T11:30:00.000Z"),
			lastSessionEndTime: new Date("2026-04-15T10:00:00.000Z"),
		});

		expect(decorated).toContain("[时间上下文]");
		expect(decorated).toContain("当前时间: 2026-04-15T12:00:00.000Z");
		expect(decorated).toContain("时段: afternoon");
		expect(decorated).toContain("距上条消息: 10 分钟");
		expect(decorated).toContain("你好");
	});

	test("covers late night, morning, evening, and duration boundaries", () => {
		const lateNight = decoratePreciseTemporalUserInput("夜间输入", {
			currentTime: new Date("2026-04-15T02:00:30.000Z"),
			lastMessageTime: new Date("2026-04-15T02:00:05.000Z"),
			sessionStartTime: new Date("2026-04-15T02:00:00.000Z"),
			lastSessionEndTime: null,
		});
		const morning = decoratePreciseTemporalUserInput("早间输入", {
			currentTime: new Date("2026-04-15T08:00:00.000Z"),
			lastMessageTime: null,
			sessionStartTime: new Date("2026-04-15T06:00:00.000Z"),
			lastSessionEndTime: null,
		});
		const evening = decoratePreciseTemporalUserInput("晚间输入", {
			currentTime: new Date("2026-04-15T20:00:00.000Z"),
			lastMessageTime: null,
			sessionStartTime: new Date("2026-04-13T20:00:00.000Z"),
			lastSessionEndTime: new Date("2026-04-14T20:00:00.000Z"),
		});

		expect(lateNight).toContain("时段: late_night");
		expect(lateNight).toContain("距上条消息: 25 秒");
		expect(lateNight).toContain("本次 session 持续: 30 秒");
		expect(morning).toContain("时段: morning");
		expect(morning).toContain("本次 session 持续: 2 小时");
		expect(evening).toContain("时段: evening");
		expect(evening).toContain("本次 session 持续: 2 天");
		expect(evening).toContain("距上次 session: 1 天");
	});
});
