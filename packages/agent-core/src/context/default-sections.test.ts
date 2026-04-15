import { describe, expect, test } from "vitest";
import { createToolGuidanceSection } from "./default-sections.js";
import type { BuildContext } from "./prompt-types.js";

const baseContext: BuildContext = {
	userInput: "你好",
	sessionState: {},
	modelId: "deepseek-chat",
	availableTools: ["memory_recall", "memory_store"],
	profile: "full",
};

describe("createToolGuidanceSection", () => {
	test("有 descriptors 时按 category 分组显示工具", () => {
		const section = createToolGuidanceSection();

		const content = section.compute({
			...baseContext,
			availableToolDescriptors: [
				{
					name: "shell_exec",
					description: "Execute a shell command.",
					category: "programmatic",
					riskLevel: "exec",
				},
				{
					name: "file_read",
					description: "Read a file with numbered lines.",
					category: "programmatic",
					riskLevel: "read",
				},
				{
					name: "browser_click",
					description: "Click an element in the browser.",
					category: "interactive",
					riskLevel: "write",
				},
			],
		});

		expect(content).toContain("Memory guidelines:");
		expect(content).toContain("## Programmatic Tools");
		expect(content).toContain(
			"- file_read (read): Read a file with numbered lines.",
		);
		expect(content).toContain("- shell_exec (exec): Execute a shell command.");
		expect(content).toContain("## Interactive Tools");
		expect(content).toContain(
			"- browser_click (write): Click an element in the browser.",
		);
		expect(content).not.toContain("Available tools:");
	});

	test("无 descriptors 时 fallback 到旧的工具列表格式", () => {
		const section = createToolGuidanceSection();

		const content = section.compute(baseContext);

		expect(content).toContain("Available tools: memory_recall, memory_store");
		expect(content).not.toContain("## Programmatic Tools");
	});

	test("descriptors 为空数组时也 fallback 到旧格式", () => {
		const section = createToolGuidanceSection();

		const content = section.compute({
			...baseContext,
			availableToolDescriptors: [],
		});

		expect(content).toContain("Available tools: memory_recall, memory_store");
		expect(content).not.toContain("## Programmatic Tools");
	});
});
