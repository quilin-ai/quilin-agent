import {
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createConversationStyleSection,
	createDefaultPromptSections,
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
					name: "quilin-mem/memory_recall",
					description: "Recall memory.",
					category: "programmatic",
					riskLevel: "read",
				},
				{
					name: "quilin-mem/memory_store",
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
		expect(content).toContain("call quilin-mem/memory_store immediately");
		expect(content).toContain(
			'first-person words ("I", "me", "my", "我", "我的")',
		);
		expect(content).toContain('If the user says "你是小明，我是孟哥"');
		expect(content).toContain('do not store "用户叫小明"');
		expect(content).toContain("metadata.source and metadata.stability_reason");
		expect(content).toContain(
			"call quilin-mem/memory_recall with a broad query",
		);
		expect(content).toContain("## Programmatic Tools");
		expect(content).toContain(
			"- file_read (read): Read a file with numbered lines.",
		);
		expect(content).toContain(
			"- quilin-mem/memory_recall (read): Recall memory.",
		);
		expect(content).toContain(
			"- quilin-mem/memory_store (write): Store memory.",
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
							url: "https://news.example.com/codex?token=secret#frag",
							host: "news.example.com",
							status: 200,
							at: "2026-05-02T13:00:00.000Z",
							auditOutcome: "usable_evidence",
							usableEvidence: true,
						},
						{
							tool: "web_fetch",
							url: "https://blocked.example.com/prompt",
							host: "blocked.example.com",
							at: "2026-05-02T13:01:00.000Z",
							auditOutcome: "blocked_output",
							usableEvidence: false,
						},
						{
							tool: "web_fetch",
							url: "https://warned.example.com/hidden",
							host: "warned.example.com",
							at: "2026-05-02T13:02:00.000Z",
							auditOutcome: "sanitized_warning",
							usableEvidence: false,
						},
						{
							tool: "web_fetch",
							url: "https://failed.example.com/source",
							host: "failed.example.com",
							at: "2026-05-02T13:03:00.000Z",
							auditOutcome: "failed",
							usableEvidence: false,
						},
					],
				},
			},
		});

		expect(content).toContain("Recent tool/source provenance");
		expect(content).toContain(
			"https://news.example.com/[path-redacted]?[redacted]#[redacted]",
		);
		expect(content).not.toContain("/codex");
		expect(content).not.toContain("/prompt");
		expect(content).not.toContain("token=secret");
		expect(content).toContain("status=200");
		expect(content).toContain("[usable]");
		expect(content).toContain("[not_evidence:blocked_output]");
		expect(content).toContain("[not_evidence:sanitized_warning]");
		expect(content).toContain("[not_evidence:failed]");
		expect(content).not.toContain("usable_after_sanitization");
		expect(content).toContain("cite only entries marked usable");
		expect(content).toContain(
			"never treat not_evidence entries as factual sources",
		);
		expect(content).toContain(
			"Do not say the information came only from training data",
		);
	});

	test("omits the provenance section when no tool sources are known", () => {
		const section = createToolProvenanceSection();

		expect(section.compute(baseContext)).toBeNull();
	});
});

// -------------------------------------------------------------------
// createConversationStyleSection
// -------------------------------------------------------------------

describe("createConversationStyleSection", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(
			tmpdir(),
			`quilin-style-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	function writeTestSoul(path: string, communicationStyle: string): void {
		const content = [
			"---",
			"schema_version: 1",
			'persona_name: "Test"',
			'zodiac: "白羊座"',
			'gender: "无性别"',
			'mbti: "INTJ"',
			"core_values:",
			'  - "测试"',
			`communication_style: "${communicationStyle}"`,
			'created_at: "2026-05-07T12:00:00Z"',
			'last_updated_by: "test"',
			"---",
			"",
			"Test body.",
		].join("\n");
		writeFileSync(path, content, "utf-8");
	}

	test("返回 null 当 soul.md 不存在时", () => {
		const section = createConversationStyleSection(
			join(tmpDir, "nonexistent.md"),
		);
		expect(section.compute(baseContext)).toBeNull();
	});

	test("为有效风格名返回包含 6 层的 prompt 片段", () => {
		const soulPath = join(tmpDir, "soul.md");
		writeTestSoul(soulPath, "casual");

		const section = createConversationStyleSection(soulPath);
		const content = section.compute(baseContext);

		expect(content).not.toBeNull();
		expect(content).toContain("<conversation_style>");
		expect(content).toContain("## 句子层 / Surface Layer");
		expect(content).toContain("## 话轮结构层 / Turn Structure");
		expect(content).toContain("## 观点判断层 / Opinion Layer");
		expect(content).toContain("## 关系建模层 / Relationship Modeling");
		expect(content).toContain("## 时间连续性层 / Temporal Continuity");
		expect(content).toContain("## 元层面 / Meta Layer");
	});

	test("所有 7 种预设都能生成有效 prompt", () => {
		const styles = [
			"blunt",
			"casual",
			"thoughtful",
			"energetic",
			"dry",
			"minimalist",
			"warm",
		];
		for (const style of styles) {
			const soulPath = join(tmpDir, `soul-${style}.md`);
			writeTestSoul(soulPath, style);
			const section = createConversationStyleSection(soulPath);
			const content = section.compute(baseContext);
			expect(content).not.toBeNull();
			expect(content!.length).toBeGreaterThan(300);
		}
	});

	test("返回 null 当 communication_style 为未知值", () => {
		const soulPath = join(tmpDir, "soul.md");
		writeTestSoul(soulPath, "nonexistent-style");
		const section = createConversationStyleSection(soulPath);
		expect(section.compute(baseContext)).toBeNull();
	});

	test("返回 null 当 communication_style 为空字符串", () => {
		const soulPath = join(tmpDir, "soul.md");
		writeTestSoul(soulPath, "");
		const section = createConversationStyleSection(soulPath);
		expect(section.compute(baseContext)).toBeNull();
	});

	test("section 是 per_session 频率且在末尾位置", () => {
		const soulPath = join(tmpDir, "soul.md");
		writeTestSoul(soulPath, "casual");
		const section = createConversationStyleSection(soulPath);
		expect(section.name).toBe("conversation-style");
		expect(section.order).toBeGreaterThanOrEqual(60);
		expect(section.updateFrequency).toBe("per_session");
	});

	test("注入到 createDefaultPromptSections 的末尾", () => {
		const sections = createDefaultPromptSections();
		const names = sections.map((s) => s.name);
		expect(names).toContain("conversation-style");
		expect(names.at(-1)).toBe("conversation-style");
	});
});
