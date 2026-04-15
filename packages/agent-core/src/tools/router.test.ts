import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRouter } from "./router.js";

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
});
