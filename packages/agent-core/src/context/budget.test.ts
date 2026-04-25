import { describe, expect, test } from "vitest";
import { TokenBudgetAllocator, trimSourcesToBudget } from "./budget.js";
import type { ContextSource } from "./draft/source-types.js";

function makeSource(
	content: string,
	overrides: Partial<ContextSource> = {},
): ContextSource {
	return {
		sourceType: "memory",
		content,
		tokenCount: 10,
		relevanceScore: 0.5,
		timestamp: 1,
		metadata: {},
		isExternal: false,
		...overrides,
	};
}

describe("TokenBudgetAllocator", () => {
	const allocator = new TokenBudgetAllocator();

	test("各任务类型比例之和为 1", () => {
		for (const taskType of [
			"simple_qa",
			"deep_reasoning",
			"tool_use",
		] as const) {
			const policy = allocator.allocate(taskType, 131_072);
			const sum =
				policy.systemRatio +
				policy.memoryRatio +
				policy.toolsRatio +
				policy.historyRatio;

			expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
		}
	});

	test("tool_use 类型给工具更多预算", () => {
		const toolUse = allocator.allocate("tool_use", 131_072);
		const simpleQa = allocator.allocate("simple_qa", 131_072);

		expect(toolUse.toolsRatio).toBeGreaterThan(simpleQa.toolsRatio);
	});

	test("rebalance 将未用完的预算转移", () => {
		const policy = allocator.allocate("deep_reasoning", 131_072);
		const rebalanced = allocator.rebalance(policy, {
			memory: policy.totalBudget * policy.memoryRatio * 0.5,
		});

		expect(rebalanced.historyRatio).toBeGreaterThan(policy.historyRatio);
	});

	test("overrides 参数生效", () => {
		const policy = allocator.allocate("simple_qa", 131_072, {
			outputReserve: 50_000,
		});

		expect(policy.outputReserve).toBe(50_000);
	});

	test("未知任务类型回退到 simple_qa 比例和默认输出保留", () => {
		const policy = allocator.allocate("unknown_task", 1_000);

		expect(policy).toMatchObject({
			taskType: "unknown_task",
			systemRatio: 0.2,
			memoryRatio: 0.2,
			toolsRatio: 0.15,
			historyRatio: 0.45,
			outputReserve: 300,
		});
	});

	test("rebalance 在没有实际用量时保持比例不变", () => {
		const policy = allocator.allocate("tool_use", 10_000);

		expect(allocator.rebalance(policy, {})).toEqual(policy);
	});
});

describe("trimSourcesToBudget", () => {
	test("按 relevance 和 timestamp 排序，并丢弃超过预算的来源", () => {
		const policy = new TokenBudgetAllocator().allocate("simple_qa", 100, {
			outputReserve: 40,
		});

		const selected = trimSourcesToBudget(
			[
				makeSource("old-high", {
					tokenCount: 30,
					relevanceScore: 0.9,
					timestamp: 1,
				}),
				makeSource("new-high", {
					tokenCount: 30,
					relevanceScore: 0.9,
					timestamp: 2,
				}),
				makeSource("oversized", {
					tokenCount: 40,
					relevanceScore: 0.8,
					timestamp: 3,
				}),
				makeSource("lower", {
					tokenCount: 10,
					relevanceScore: 0.1,
					timestamp: 4,
				}),
			],
			policy,
		);

		expect(selected.map((source) => source.content)).toEqual([
			"new-high",
			"old-high",
		]);
	});

	test("clamps available budget at zero when output reserve consumes it", () => {
		const policy = new TokenBudgetAllocator().allocate("simple_qa", 100, {
			outputReserve: 150,
		});

		expect(
			trimSourcesToBudget([makeSource("too-large", { tokenCount: 1 })], policy),
		).toEqual([]);
	});
});
