import { describe, expect, test } from "vitest";
import {
	createToolGuidanceSection,
	createToolProvenanceSection,
} from "./default-sections.js";
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
					name: "omnimem/memory_recall",
					description: "Recall memory.",
					category: "programmatic",
					riskLevel: "read",
				},
				{
					name: "omnimem/memory_store",
					description: "Store memory.",
					category: "programmatic",
					riskLevel: "write",
				},
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
		expect(content).toContain("call omnimem/memory_store immediately");
		expect(content).toContain(
			'first-person words ("I", "me", "my", "我", "我的")',
		);
		expect(content).toContain('If the user says "你是小明，我是孟哥"');
		expect(content).toContain('do not store "用户叫小明"');
		expect(content).toContain("metadata.source and metadata.stability_reason");
		expect(content).toContain("call omnimem/memory_recall with a broad query");
		expect(content).toContain("## Programmatic Tools");
		expect(content).toContain(
			"- file_read (read): Read a file with numbered lines.",
		);
		expect(content).toContain("- omnimem/memory_recall (read): Recall memory.");
		expect(content).toContain("- omnimem/memory_store (write): Store memory.");
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

describe("createToolProvenanceSection", () => {
	test("renders recent tool source provenance for follow-up source questions", () => {
		const section = createToolProvenanceSection();

		const content = section.compute({
			...baseContext,
			sessionState: {
				toolProvenance: {
					recent: [
						{
							tool: "web_fetch",
							url: "https://news.example.com/codex",
							host: "news.example.com",
							status: 200,
							at: "2026-05-02T13:00:00.000Z",
						},
					],
				},
			},
		});

		expect(content).toContain("Recent tool/source provenance");
		expect(content).toContain("https://news.example.com/codex");
		expect(content).toContain("status=200");
		expect(content).toContain(
			"Do not say the information came only from training data",
		);
	});

	test("omits the provenance section when no tool sources are known", () => {
		const section = createToolProvenanceSection();

		expect(section.compute(baseContext)).toBeNull();
	});
});
