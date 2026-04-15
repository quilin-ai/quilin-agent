import { describe, expect, it } from "vitest";
import { BasicContextManager } from "./manager.js";
import type { ContextSource, TokenBudget } from "./types.js";

const DEFAULT_BUDGET: TokenBudget = {
	total: 100,
	system: 20,
	memory: 20,
	tools: 20,
	conversation: 20,
	reserved: 20,
};

function makeSource(
	content: string,
	priority: number,
	tokenEstimate: number,
): ContextSource {
	return {
		type: "system",
		content,
		priority,
		tokenEstimate,
	};
}

describe("BasicContextManager", () => {
	it("returns an empty string for empty sources", async () => {
		const manager = new BasicContextManager();

		await expect(manager.buildContext([], DEFAULT_BUDGET)).resolves.toBe("");
	});

	it("returns the content for a single source", async () => {
		const manager = new BasicContextManager();

		await expect(
			manager.buildContext(
				[makeSource("system prompt", 100, 4)],
				DEFAULT_BUDGET,
			),
		).resolves.toBe("system prompt");
	});

	it("joins multiple sources in descending priority order", async () => {
		const manager = new BasicContextManager();

		await expect(
			manager.buildContext(
				[
					makeSource("memory context", 50, 5),
					makeSource("system prompt", 100, 4),
					makeSource("environment info", 75, 6),
				],
				DEFAULT_BUDGET,
			),
		).resolves.toBe(
			["system prompt", "environment info", "memory context"].join(
				"\n\n---\n\n",
			),
		);
	});

	it("truncates sources that would exceed the total budget", async () => {
		const manager = new BasicContextManager();

		await expect(
			manager.buildContext(
				[
					makeSource("system prompt", 100, 4),
					makeSource("memory context", 50, 7),
					makeSource("environment info", 25, 2),
				],
				{
					...DEFAULT_BUDGET,
					total: 10,
				},
			),
		).resolves.toBe("system prompt");
	});

	it("keeps the original order for sources with the same priority", async () => {
		const manager = new BasicContextManager();

		await expect(
			manager.buildContext(
				[
					makeSource("first memory", 80, 4),
					makeSource("second memory", 80, 4),
					makeSource("system prompt", 100, 4),
				],
				DEFAULT_BUDGET,
			),
		).resolves.toBe(
			["system prompt", "first memory", "second memory"].join("\n\n---\n\n"),
		);
	});
});
