import { describe, expect, test } from "vitest";
import {
	applyStyleToPrompt,
	CONVERSATION_STYLE_PRESETS,
	resolveStylePreset,
	VALID_STYLE_NAMES,
	type ConversationStyleConfig,
} from "./conversation-style.js";

describe("7 种预设完整性", () => {
	test("VALID_STYLE_NAMES 包含全部 7 种预设", () => {
		expect(VALID_STYLE_NAMES).toEqual([
			"blunt",
			"casual",
			"thoughtful",
			"energetic",
			"dry",
			"minimalist",
			"warm",
		]);
	});

	test("每种预设的 6 层参数都非空", () => {
		for (const name of VALID_STYLE_NAMES) {
			const preset = CONVERSATION_STYLE_PRESETS[name];
			expect(preset).toBeDefined();
			expect(preset.surfaceLayer).toBeDefined();
			expect(preset.turnLayer).toBeDefined();
			expect(preset.opinionLayer).toBeDefined();
			expect(preset.relationshipLayer).toBeDefined();
			expect(preset.temporalLayer).toBeDefined();
			expect(preset.metaLayer).toBeDefined();
		}
	});

	test("所有预设的参数值在有效范围内", () => {
		for (const name of VALID_STYLE_NAMES) {
			const preset = CONVERSATION_STYLE_PRESETS[name];

			expect(preset.surfaceLayer.fillerFrequency).toBeGreaterThanOrEqual(0);
			expect(preset.surfaceLayer.fillerFrequency).toBeLessThanOrEqual(1);
			expect(preset.surfaceLayer.sentenceLengthVariance).toBeGreaterThanOrEqual(0);
			expect(preset.surfaceLayer.sentenceLengthVariance).toBeLessThanOrEqual(1);
			expect(preset.surfaceLayer.openingDiversity).toBeGreaterThanOrEqual(0);
			expect(preset.surfaceLayer.openingDiversity).toBeLessThanOrEqual(1);
			expect(preset.turnLayer.completeness).toBeGreaterThanOrEqual(0);
			expect(preset.turnLayer.completeness).toBeLessThanOrEqual(1);
			expect(preset.turnLayer.selfInterruptRate).toBeGreaterThanOrEqual(0);
			expect(preset.turnLayer.selfInterruptRate).toBeLessThanOrEqual(1);
			expect(preset.opinionLayer.assertiveness).toBeGreaterThanOrEqual(0);
			expect(preset.opinionLayer.assertiveness).toBeLessThanOrEqual(1);
			expect(preset.relationshipLayer.sideWithUser).toBeGreaterThanOrEqual(0);
			expect(preset.relationshipLayer.sideWithUser).toBeLessThanOrEqual(1);
			expect(preset.relationshipLayer.misunderstandRate).toBeGreaterThanOrEqual(0);
			expect(preset.relationshipLayer.misunderstandRate).toBeLessThanOrEqual(1);
		}
	});
});

describe("resolveStylePreset", () => {
	test("返回已知风格的预设配置", () => {
		const config = resolveStylePreset("casual");
		expect(config).toBeDefined();
		expect(config!.surfaceLayer.fillerFrequency).toBe(0.3);
	});

	test("对未知风格返回 undefined", () => {
		expect(resolveStylePreset("formal")).toBeUndefined();
		expect(resolveStylePreset("")).toBeUndefined();
	});

	test("大小写敏感", () => {
		expect(resolveStylePreset("Casual")).toBeUndefined();
	});
});

describe("applyStyleToPrompt", () => {
	test("生成的 prompt 以 XML 包裹", () => {
		const result = applyStyleToPrompt(CONVERSATION_STYLE_PRESETS.casual);
		expect(result).toContain("<conversation_style>");
		expect(result).toContain("</conversation_style>");
	});

	test("生成的 prompt 包含 6 层标题", () => {
		const result = applyStyleToPrompt(CONVERSATION_STYLE_PRESETS.casual);
		expect(result).toContain("## 句子层 / Surface Layer");
		expect(result).toContain("## 话轮结构层 / Turn Structure");
		expect(result).toContain("## 观点判断层 / Opinion Layer");
		expect(result).toContain("## 关系建模层 / Relationship Modeling");
		expect(result).toContain("## 时间连续性层 / Temporal Continuity");
		expect(result).toContain("## 元层面 / Meta Layer");
	});

	test("所有 7 种预设都能生成有实质内容的 prompt", () => {
		for (const name of VALID_STYLE_NAMES) {
			const config = CONVERSATION_STYLE_PRESETS[name];
			const result = applyStyleToPrompt(config);
			expect(result.length).toBeGreaterThan(300);
		}
	});

	test("blunt 风格禁止填充词", () => {
		const result = applyStyleToPrompt(CONVERSATION_STYLE_PRESETS.blunt);
		expect(result).toContain("禁止使用填充词");
	});

	test("dry 风格允许 bullet 列表", () => {
		const result = applyStyleToPrompt(CONVERSATION_STYLE_PRESETS.dry);
		expect(result).toContain("必要时可以使用 bullet 列表");
	});

	test("非 dry 风格禁止 bullet 列表", () => {
		const nonDry = VALID_STYLE_NAMES.filter((n) => n !== "dry");
		for (const name of nonDry) {
			const result = applyStyleToPrompt(CONVERSATION_STYLE_PRESETS[name]);
			expect(result).toContain("禁止使用 bullet 列表");
		}
	});

	test("immutable: 两次相同输入产生相同输出", () => {
		const config = CONVERSATION_STYLE_PRESETS.blunt;
		expect(applyStyleToPrompt(config)).toBe(applyStyleToPrompt(config));
	});
});
