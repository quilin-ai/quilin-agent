import { describe, expect, it } from "vitest";

import { summarizeProcessBlock, summarizeToolCall } from "@/lib/tool-call-summary";
import type { ProcessBlock, RawPart } from "@/lib/transcript-blocks";

describe("summarizeToolCall", () => {
	it("uses the subagent task instead of ordinal call labels", () => {
		const part: RawPart = {
			type: "tool-spawn_subagent",
			toolName: "spawn_subagent",
			state: "output-available",
			input: { task: "有类似的东方玄学出海团队吗？" },
			output: { displayName: "东方玄学出海研究", agentId: "subagent-123" },
		};

		expect(summarizeToolCall(part)).toBe("东方玄学出海研究：有类似的东方玄学出海团队吗？");
	});

	it("uses subagent task and display name fallbacks independently", () => {
		expect(
			summarizeToolCall({
				type: "tool-spawn_subagent",
				toolName: "spawn_subagent",
				state: "output-available",
				input: { task: "整理竞品" },
			}),
		).toBe("task：整理竞品");

		expect(
			summarizeToolCall({
				type: "tool-spawn_subagent",
				toolName: "spawn_subagent",
				state: "output-available",
				output: { displayName: "竞品研究" },
			}),
		).toBe("竞品研究");
	});

	it("surfaces web fetch URLs and search queries", () => {
		expect(
			summarizeToolCall({
				type: "tool-web_fetch",
				state: "output-available",
				input: { url: "https://example.com" },
			}),
		).toBe("url：https://example.com");

		expect(
			summarizeToolCall({
				type: "tool-web_search",
				state: "output-available",
				input: { query: "东方玄学 出海 团队" },
			}),
		).toBe("query：东方玄学 出海 团队");
	});

	it("reads nested semantic fields and output hints", () => {
		expect(
			summarizeToolCall({
				type: "tool-web_fetch",
				state: "output-available",
				input: { request: { url: "https://example.com/nested" } },
			}),
		).toBe("url：https://example.com/nested");

		expect(
			summarizeToolCall({
				type: "tool-custom",
				toolName: "custom_tool",
				state: "output-available",
				input: null,
				output: { path: "docs/00-core-loop/README.md" },
			}),
		).toBe("path：docs/00-core-loop/README.md");
	});

	it("normalizes command and custom field labels", () => {
		expect(
			summarizeToolCall({
				type: "tool-shell_exec",
				state: "output-available",
				input: { cmd: "pnpm test" },
			}),
		).toBe("command：pnpm test");

		expect(
			summarizeToolCall({
				type: "tool-dom",
				toolName: "dom_tool",
				state: "output-available",
				input: { selector: "#submit" },
			}),
		).toBe("selector：#submit");
	});

	it("summarizes subagent wait calls without dumping raw JSON", () => {
		expect(
			summarizeToolCall({
				type: "tool-wait_for_subagents",
				state: "output-available",
				input: { agentIds: ["subagent-a", "subagent-b", "subagent-c"] },
			}),
		).toBe("3 个子代理已完成");
		expect(
			summarizeToolCall({
				type: "tool-wait_for_subagents",
				state: "input-available",
				input: { agentIds: ["subagent-a", "subagent-b", "subagent-c"] },
			}),
		).toBe("等待 3 个子代理完成");
		expect(
			summarizeToolCall({
				type: "tool-wait_for_subagents",
				state: "output-error",
				input: { agentIds: ["subagent-a", "subagent-b"] },
			}),
		).toBe("2 个子代理等待失败");
	});

	it("falls back to compact JSON previews only when no semantic field exists", () => {
		expect(
			summarizeToolCall({
				type: "tool-custom",
				toolName: "custom_tool",
				state: "output-available",
				input: { filters: { region: "global" }, limit: 3 },
			}),
		).toBe('{"filters":{"region":"global"},"limit":3}');

		expect(
			summarizeToolCall({
				type: "tool-custom",
				toolName: "custom_tool",
				state: "output-available",
				input: {},
				output: [],
			}),
		).toBe("custom_tool");
	});

	it("uses the tool name when JSON stringifies to nothing", () => {
		expect(
			summarizeToolCall({
				type: "tool-function",
				toolName: "function_tool",
				state: "output-available",
				input: () => "not serializable",
			}),
		).toBe("function_tool");
	});

	it("uses the tool name when JSON preview cannot serialize", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(
			summarizeToolCall({
				type: "tool-circular",
				toolName: "circular_tool",
				state: "output-available",
				input: circular,
			}),
		).toBe("circular_tool");
	});
});

describe("summarizeProcessBlock", () => {
	it("describes grouped web fetch work", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p1",
			items: [
				{
					type: "tool-group",
					name: "web_fetch",
					calls: [
						{ type: "tool-web_fetch", input: { url: "https://example.com/1" } },
						{ type: "tool-web_fetch", input: { url: "https://example.com/2" } },
						{ type: "tool-web_fetch", input: { url: "https://example.com/3" } },
					],
				},
			],
		};

		expect(summarizeProcessBlock(block, true)).toBe("正在抓取 3 个网页");
		expect(summarizeProcessBlock(block, false)).toBe("抓取 3 个网页");
	});

	it("combines reasoning and subagent work in the process title", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p2",
			items: [
				{ type: "reasoning", part: { type: "reasoning", text: "plan" } },
				{
					type: "tool-group",
					name: "spawn_subagent",
					calls: [
						{ type: "tool-spawn_subagent", input: { task: "调研东方玄学出海团队" } },
						{ type: "tool-spawn_subagent", input: { task: "整理竞品" } },
					],
				},
			],
		};

		expect(summarizeProcessBlock(block, true)).toBe("正在思考 + 派遣 2 个子代理");
	});

	it("uses a readable title for waiting on subagents", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p3",
			items: [
				{
					type: "tool-group",
					name: "wait_for_subagents",
					calls: [
						{
							type: "tool-wait_for_subagents",
							state: "output-available",
							input: { agentIds: ["subagent-a", "subagent-b", "subagent-c"] },
						},
					],
				},
			],
		};

		expect(summarizeProcessBlock(block, false)).toBe("3 个子代理已完成");
	});

	it("uses a readable title for waiting on subagents without IDs", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p3b",
			items: [
				{
					type: "tool-group",
					name: "wait_for_subagents",
					calls: [{ type: "tool-wait_for_subagents", input: {} }],
				},
			],
		};

		expect(summarizeProcessBlock(block, false)).toBe("等待子代理完成：wait_for_subagents");
	});

	it("names shell, read, write, and memory tool buckets", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p4",
			items: [
				{
					type: "tool-group",
					name: "shell_exec",
					calls: [{ type: "tool-shell_exec" }, { type: "tool-shell_exec" }],
				},
				{
					type: "tool-group",
					name: "file_read",
					calls: [{ type: "tool-file_read" }, { type: "tool-file_read" }],
				},
				{
					type: "tool-group",
					name: "file_write",
					calls: [{ type: "tool-file_write" }, { type: "tool-file_write" }],
				},
				{
					type: "tool-group",
					name: "memory_recall",
					calls: [{ type: "tool-memory_recall" }, { type: "tool-memory_recall" }],
				},
			],
		};

		expect(summarizeProcessBlock(block, false)).toBe("执行 2 条命令 + 读取 2 项 等 4 项");
	});

	it("names single-call bucket actions and default tool buckets", () => {
		const titleFor = (name: string, calls: RawPart[]) =>
			summarizeProcessBlock(
				{ type: "process", id: name, items: [{ type: "tool-group", name, calls }] },
				false,
			);

		expect(titleFor("spawn_subagent", [{ type: "tool-spawn_subagent", input: {} }])).toBe(
			"派遣子代理：spawn_subagent",
		);
		expect(titleFor("web_fetch", [{ type: "tool-web_fetch", input: {} }])).toBe(
			"抓取网页：web_fetch",
		);
		expect(titleFor("web_search", [{ type: "tool-web_search", input: {} }])).toBe(
			"搜索：web_search",
		);
		expect(titleFor("shell_exec", [{ type: "tool-shell_exec", input: {} }])).toBe(
			"执行命令：shell_exec",
		);
		expect(titleFor("file_read", [{ type: "tool-file_read", input: {} }])).toBe("读取：file_read");
		expect(titleFor("file_write", [{ type: "tool-file_write", input: {} }])).toBe(
			"修改：file_write",
		);
		expect(titleFor("memory_recall", [{ type: "tool-memory_recall", input: {} }])).toBe(
			"检索记忆：memory_recall",
		);
		expect(
			titleFor("custom_tool", [
				{ type: "tool-custom_tool", input: {} },
				{ type: "tool-custom_tool", input: {} },
			]),
		).toBe("调用 custom_tool × 2");
		expect(titleFor("custom_tool", [{ type: "tool-custom_tool", input: {} }])).toBe(
			"调用 custom_tool：custom_tool",
		);
	});

	it("keeps an action-only title when the detail duplicates the action", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p4b",
			items: [
				{
					type: "tool-group",
					name: "search",
					calls: [{ type: "tool-search", input: { query: "搜索" } }],
				},
			],
		};

		expect(summarizeProcessBlock(block, false)).toBe("搜索");
	});

	it("falls back to the action when a single-call group has no first call", () => {
		const sparseCalls = new Array(1) as RawPart[];
		const block: ProcessBlock = {
			type: "process",
			id: "p4c",
			items: [{ type: "tool-group", name: "custom_tool", calls: sparseCalls }],
		};

		expect(summarizeProcessBlock(block, false)).toBe("调用 custom_tool");
	});

	it("truncates long single-call process titles", () => {
		const block: ProcessBlock = {
			type: "process",
			id: "p5",
			items: [
				{
					type: "tool-group",
					name: "web_search",
					calls: [
						{
							type: "tool-web_search",
							input: {
								query:
									"东方玄学出海市场中面向北美欧洲东南亚用户的 AI 算命风水紫微斗数产品增长渠道竞品与监管风险，以及订阅转化、达人投放、支付合规、本地化内容运营、长期留存策略、不同文化语境下的信任建立路径、线下社群冷启动和多语言客服成本结构",
							},
						},
					],
				},
			],
		};
		const title = summarizeProcessBlock(block, false);

		expect(title.length).toBeLessThanOrEqual(92);
		expect(title.endsWith("…")).toBe(true);
	});
});
