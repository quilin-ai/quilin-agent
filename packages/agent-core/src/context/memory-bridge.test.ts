import { describe, expect, test } from "vitest";
import { recallResultsToSources } from "./memory-bridge.js";

describe("recallResultsToSources", () => {
	test("低于阈值的记忆被过滤", () => {
		const sources = recallResultsToSources(
			[
				{ content: "high", score: 0.9, timestamp: 0, layer: "semantic" },
				{ content: "low", score: 0.3, timestamp: 0, layer: "semantic" },
			],
			{ threshold: 0.65 },
		);

		expect(sources).toHaveLength(1);
		expect(sources[0]?.content).toBe("high");
	});

	test("返回的 ContextSource 标记为 isExternal", () => {
		const sources = recallResultsToSources(
			[{ content: "memory", score: 0.8, timestamp: 0, layer: "episodic" }],
			{ threshold: 0.5 },
		);

		expect(sources[0]?.isExternal).toBe(true);
	});

	test("包含 token 计数", () => {
		const sources = recallResultsToSources(
			[
				{
					content: "some memory content",
					score: 0.8,
					timestamp: 0,
					layer: "episodic",
				},
			],
			{ threshold: 0.5 },
		);

		expect(sources[0]?.tokenCount).toBeGreaterThan(0);
	});

	test("空结果返回空数组", () => {
		const sources = recallResultsToSources([], { threshold: 0.5 });

		expect(sources).toEqual([]);
	});
});
