import { describe, expect, test } from "vitest";
import { PromptBuilder } from "./prompt-builder.js";
import type { BuildContext } from "./prompt-types.js";

const mockCtx: BuildContext = {
	userInput: "帮我分析代码",
	sessionState: {},
	modelId: "deepseek-chat",
	availableTools: ["memory_recall"],
	profile: "full",
};

describe("PromptBuilder", () => {
	test("段按 order 排序输出", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "b",
			order: 20,
			compute: () => "B",
			updateFrequency: "static",
		});
		builder.register({
			name: "a",
			order: 10,
			compute: () => "A",
			updateFrequency: "static",
		});

		const result = builder.build(mockCtx);

		expect(result.staticPrefix).toMatch(/A[\s\S]*B/);
	});

	test("per_turn 段归入 dynamicSuffix", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "static",
			order: 10,
			compute: () => "S",
			updateFrequency: "static",
		});
		builder.register({
			name: "dynamic",
			order: 50,
			compute: () => "D",
			updateFrequency: "per_turn",
		});

		const result = builder.build(mockCtx);

		expect(result.staticPrefix).toContain("S");
		expect(result.dynamicSuffix).toContain("D");
		expect(result.staticPrefix).not.toContain("D");
	});

	test("per_session 段归入 staticPrefix 且 session 内冻结", () => {
		const builder = new PromptBuilder();
		let counter = 0;
		builder.register({
			name: "frozen",
			order: 30,
			compute: () => `value-${++counter}`,
			updateFrequency: "per_session",
		});

		const r1 = builder.build(mockCtx);
		const r2 = builder.build(mockCtx);

		expect(r1.staticPrefix).toContain("value-1");
		expect(r2.staticPrefix).toContain("value-1");
		expect(counter).toBe(1);
	});

	test("resetSession 清空冻结缓存", () => {
		const builder = new PromptBuilder();
		let counter = 0;
		builder.register({
			name: "frozen",
			order: 30,
			compute: () => `value-${++counter}`,
			updateFrequency: "per_session",
		});

		builder.build(mockCtx);
		builder.resetSession();

		const r2 = builder.build(mockCtx);

		expect(r2.staticPrefix).toContain("value-2");
	});

	test("compute 返回 null 的段被跳过", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "skip",
			order: 10,
			compute: () => null,
			updateFrequency: "static",
		});
		builder.register({
			name: "keep",
			order: 20,
			compute: () => "K",
			updateFrequency: "static",
		});

		const result = builder.build(mockCtx);

		expect(result.sectionTokens.skip).toBeUndefined();
		expect(result.sectionTokens.keep).toBeGreaterThan(0);
	});

	test("段级 maxTokens 截断生效", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "big",
			order: 10,
			compute: () => "word ".repeat(1_000),
			updateFrequency: "static",
			maxTokens: 50,
		});

		const result = builder.build(mockCtx);

		expect(result.sectionTokens.big).toBeLessThanOrEqual(50);
	});

	test("PromptProfile: minimal 模式过滤 full-only 段", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "full-only",
			order: 10,
			compute: () => "F",
			updateFrequency: "static",
			profiles: ["full"],
		});
		builder.register({
			name: "shared",
			order: 20,
			compute: () => "S",
			updateFrequency: "static",
			profiles: ["full", "minimal"],
		});

		const result = builder.build({ ...mockCtx, profile: "minimal" });

		expect(result.staticPrefix).not.toContain("F");
		expect(result.staticPrefix).toContain("S");
	});

	test("相同输入多次 build 产生 byte-identical staticPrefix", () => {
		const builder = new PromptBuilder();
		builder.register({
			name: "a",
			order: 10,
			compute: () => "content A",
			updateFrequency: "static",
		});
		builder.register({
			name: "b",
			order: 20,
			compute: () => "content B",
			updateFrequency: "static",
		});

		const r1 = builder.build(mockCtx);
		const r2 = builder.build(mockCtx);

		expect(r1.staticPrefix).toBe(r2.staticPrefix);
	});
});
