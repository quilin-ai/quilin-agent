import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRouter } from "./router.js";
import type { ToolWithMetadata } from "./tool-metadata.js";

describe("ToolRouter", () => {
	it("执行匹配工具并归一化 toolCallId", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ id: "mem-1" }),
			isError: false,
		});

		const router = new ToolRouter([
			{
				name: "memory_store",
				description: "Store memory",
				parameters: z.object({
					content: z.string(),
					tier: z.string().optional(),
				}),
				execute,
			},
		]);

		const result = await router.execute({
			id: "call-1",
			name: "memory_store",
			arguments: { content: "我叫小明", tier: "short" },
		});

		expect(execute).toHaveBeenCalledWith({
			content: "我叫小明",
			tier: "short",
		});
		expect(result).toEqual({
			toolCallId: "call-1",
			content: JSON.stringify({ id: "mem-1" }),
			isError: false,
		});
	});

	it("工具不存在时返回错误 ToolResult", async () => {
		const router = new ToolRouter([]);

		const result = await router.execute({
			id: "call-404",
			name: "memory_recall",
			arguments: { query: "我叫什么" },
		});

		expect(result.toolCallId).toBe("call-404");
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("memory_recall"),
		});
	});

	it("参数校验失败时返回错误 ToolResult", async () => {
		const execute = vi.fn();
		const router = new ToolRouter([
			{
				name: "memory_recall",
				description: "Recall memory",
				parameters: z.object({ query: z.string() }),
				execute,
			},
		]);

		const result = await router.execute({
			id: "call-invalid",
			name: "memory_recall",
			arguments: { query: 123 },
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.toolCallId).toBe("call-invalid");
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.any(String),
		});
	});

	it("工具执行抛错时返回错误 ToolResult", async () => {
		const router = new ToolRouter([
			{
				name: "memory_store",
				description: "Store memory",
				parameters: z.object({ content: z.string() }),
				execute: vi.fn().mockRejectedValue(new Error("disk full")),
			},
		]);

		const result = await router.execute({
			id: "call-error",
			name: "memory_store",
			arguments: { content: "我叫小明" },
		});

		expect(result.toolCallId).toBe("call-error");
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: "disk full",
		});
	});

	it("支持执行带 metadata 的工具", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ ok: true }),
			isError: false,
		});
		const tool: ToolWithMetadata = {
			name: "file_read",
			description: "Read a file with numbered lines.",
			parameters: z.object({ path: z.string() }),
			execute,
			category: "programmatic",
			riskLevel: "read",
		};
		const router = new ToolRouter([tool]);

		const result = await router.execute({
			id: "call-meta",
			name: "file_read",
			arguments: { path: "/tmp/demo.txt" },
		});

		expect(execute).toHaveBeenCalledWith({ path: "/tmp/demo.txt" });
		expect(result).toEqual({
			toolCallId: "call-meta",
			content: JSON.stringify({ ok: true }),
			isError: false,
		});
	});

	it("优先精确匹配带 namespace 的工具名", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});
		const router = new ToolRouter([
			{
				name: "omnimem/memory_recall",
				description: "Recall memories",
				parameters: z.object({ query: z.string() }),
				execute,
				category: "programmatic",
				riskLevel: "read",
				namespace: "omnimem",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-ns",
			name: "omnimem/memory_recall",
			arguments: { query: "小明" },
		});

		expect(execute).toHaveBeenCalledWith({ query: "小明" });
		expect(result.isError).toBe(false);
	});

	it("找不到精确匹配时回退到短名查找", async () => {
		const execute = vi.fn().mockResolvedValue({
			toolCallId: "wrong-id",
			content: JSON.stringify({ records: [] }),
			isError: false,
		});
		const router = new ToolRouter([
			{
				name: "omnimem/memory_recall",
				description: "Recall memories",
				parameters: z.object({ query: z.string() }),
				execute,
				category: "programmatic",
				riskLevel: "read",
				namespace: "omnimem",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-short",
			name: "memory_recall",
			arguments: { query: "老孟" },
		});

		expect(execute).toHaveBeenCalledWith({ query: "老孟" });
		expect(result.isError).toBe(false);
	});

	it("短名冲突时返回 tool not found 错误", async () => {
		const executeOne = vi.fn();
		const executeTwo = vi.fn();
		const router = new ToolRouter([
			{
				name: "memory/search",
				description: "Memory search",
				parameters: z.object({ query: z.string() }),
				execute: executeOne,
				category: "programmatic",
				riskLevel: "read",
				namespace: "memory",
			} satisfies ToolWithMetadata,
			{
				name: "web/search",
				description: "Web search",
				parameters: z.object({ query: z.string() }),
				execute: executeTwo,
				category: "programmatic",
				riskLevel: "read",
				namespace: "web",
			} satisfies ToolWithMetadata,
		]);

		const result = await router.execute({
			id: "call-ambiguous",
			name: "search",
			arguments: { query: "quilin" },
		});

		expect(executeOne).not.toHaveBeenCalled();
		expect(executeTwo).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content)).toEqual({
			error: expect.stringContaining("search"),
		});
	});
});
