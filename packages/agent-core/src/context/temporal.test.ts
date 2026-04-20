import { describe, expect, test } from "vitest";
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
	test("输出桶化时间信息而不是精确时间戳", () => {
		const section = createTemporalBucketSection(() => ({
			currentTime: new Date("2026-04-15T12:00:00.000Z"),
			lastMessageTime: null,
			sessionStartTime: new Date("2026-04-15T11:30:00.000Z"),
			lastSessionEndTime: null,
		}));

		const content = section.compute(mockBuildCtx);

		expect(content).toContain("时间桶");
		expect(content).not.toContain("2026-04-15T12:00:00.000Z");
	});

	test("updateFrequency 是 per_session", () => {
		const section = createTemporalBucketSection(() => ({
			currentTime: new Date("2026-04-15T12:00:00.000Z"),
			lastMessageTime: new Date("2026-04-15T11:50:00.000Z"),
			sessionStartTime: new Date("2026-04-15T11:30:00.000Z"),
			lastSessionEndTime: null,
		}));

		expect(section.updateFrequency).toBe("per_session");
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
		expect(decorated).toContain("距上条消息: 10 分钟");
		expect(decorated).toContain("你好");
	});
});
