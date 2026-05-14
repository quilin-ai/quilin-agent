import { describe, expect, it } from "vitest";

import { agentDisplayName, deriveAgentDisplayName } from "@/lib/agent-display-name";

describe("agent display names", () => {
	it("derives a compact semantic Chinese research name", () => {
		expect(deriveAgentDisplayName("帮我调研一下玄学出海这个赛道")).toBe("玄学出海研究");
	});

	it("removes retry/search filler from typo-normalized subagent tasks", () => {
		expect(deriveAgentDisplayName("再搜搜有类似的东方玄学出海团队吗？")).toBe(
			"东方玄学出海团队研究",
		);
	});

	it("keeps explicit display names", () => {
		expect(agentDisplayName("subagent", "调研玄学出海", "出海机会研究")).toBe("出海机会研究");
	});

	it("falls back to role labels when no task exists", () => {
		expect(agentDisplayName("main", null)).toBe("主代理");
		expect(agentDisplayName("subagent", null)).toBe("子代理");
	});
});
