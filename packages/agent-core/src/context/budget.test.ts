import { describe, expect, test } from "vitest";
import { TokenBudgetAllocator } from "./budget.js";

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
});
