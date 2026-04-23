import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { buildPlanContext } from "./context.js";
import { createBudgetLedger } from "./budget.js";
import type { MemoryItem } from "../memory/types.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { Message } from "../state/types.js";

const FIXTURE_URL = new URL(
	"../../../../providers/memory/tests/fixtures/memory_item.json",
	import.meta.url,
);

const DEFAULT_BUDGET = createBudgetLedger({
	tokenBudget: 1_000,
	turnBudget: 4,
	stepBudget: 6,
});

async function loadFixture(): Promise<ReadonlyArray<MemoryItem>> {
	return JSON.parse(await readFile(FIXTURE_URL, "utf8")) as MemoryItem[];
}

function makeSkillDescriptor(name: string): SkillDescriptor {
	return {
		name,
		description: `${name} description`,
		path: `/skills/${name}/SKILL.md`,
		source: "project",
		frontmatter: {
			name,
			description: `${name} description`,
			whenToUse: `${name} when to use`,
			userInvocable: true,
			disableModelInvocation: false,
		},
	};
}

describe("buildPlanContext", () => {
	it("assembles conversation history, memory recall, skill catalog, and budget", async () => {
		const fixture = await loadFixture();
		const recall = vi.fn(async () => fixture.slice(0, 2));
		const store = vi.fn(async () => undefined);
		const conversationHistory: readonly Message[] = [
			{ role: "user", content: "Search the benchmark leaderboard." },
			{ role: "assistant", content: "I will inspect the latest results." },
		];
		const skillCatalog = [
			makeSkillDescriptor("web-research"),
			makeSkillDescriptor("table-summarizer"),
		];

		const context = await buildPlanContext({
			task: "Compare competitor agent benchmarks",
			conversationHistory,
			skillCatalog,
			budget: DEFAULT_BUDGET,
			iteration: 2,
			memory: {
				client: {
					recall,
					store,
				},
				query: "agent benchmark comparison",
				options: {
					limit: 2,
					layer: "episodic",
					metadata: { source: "planner" },
				},
			},
		});

		expect(recall).toHaveBeenCalledWith("agent benchmark comparison", {
			limit: 2,
			layer: "episodic",
			metadata: { source: "planner" },
		});
		expect(store).not.toHaveBeenCalled();
		expect(context).toEqual({
			task: "Compare competitor agent benchmarks",
			conversationHistory,
			memoryRecall: fixture.slice(0, 2),
			skillCatalog,
			budget: DEFAULT_BUDGET,
			iteration: 2,
		});
	});

	it("falls back to NullMemoryClient when no memory client is provided", async () => {
		const context = await buildPlanContext({
			task: "Summarize the current issue",
			budget: DEFAULT_BUDGET,
			conversationHistory: [{ role: "user", content: "Need a recap." }],
			skillCatalog: [makeSkillDescriptor("summarize")],
		});

		expect(context.memoryRecall).toEqual([]);
		expect(context.conversationHistory).toEqual([
			{ role: "user", content: "Need a recap." },
		]);
	});

	it("returns an empty recall when the upstream memory client is offline", async () => {
		const recall = vi.fn(async () => {
			throw new Error("memory offline");
		});

		const context = await buildPlanContext({
			task: "Recover the last successful strategy",
			budget: DEFAULT_BUDGET,
			memory: {
				client: {
					recall,
					store: vi.fn(async () => undefined),
				},
				options: { limit: 3, layer: "semantic" },
			},
		});

		expect(recall).toHaveBeenCalledWith(
			"Recover the last successful strategy",
			{ limit: 3, layer: "semantic" },
		);
		expect(context.memoryRecall).toEqual([]);
		expect(context.skillCatalog).toEqual([]);
		expect(context.iteration).toBe(0);
	});
});
