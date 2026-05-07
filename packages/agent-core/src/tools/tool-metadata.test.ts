import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
	RiskLevel,
	ToolCategory,
	ToolPromptDescriptor,
	ToolWithMetadata,
} from "./tool-metadata.js";
import type { Tool } from "./types.js";

describe("tool metadata types", () => {
	it("loads the tool metadata module", async () => {
		const module = await import("./tool-metadata.js");

		expect(module).toBeTypeOf("object");
	});

	it("defines the supported tool categories and risk levels", () => {
		const categories: ToolCategory[] = [
			"programmatic",
			"interactive",
			"control",
			"gui",
		];
		const riskLevels: RiskLevel[] = ["read", "write", "exec", "high-risk"];

		expect(categories).toEqual([
			"programmatic",
			"interactive",
			"control",
			"gui",
		]);
		expect(riskLevels).toEqual(["read", "write", "exec", "high-risk"]);
	});

	it("allows metadata-rich tools to be used anywhere a base Tool is accepted", () => {
		const tool: ToolWithMetadata = {
			name: "memory_recall",
			description: "Recall memory entries",
			parameters: z.object({ query: z.string() }),
			execute: async () => ({
				toolCallId: "call-1",
				content: '{"records":[]}',
				isError: false,
			}),
			category: "programmatic",
			riskLevel: "read",
			timeoutMs: 30_000,
			namespace: "quilin-mem",
		};
		const baseTool: Tool = tool;

		expect(baseTool.name).toBe("memory_recall");
		expect(tool.category).toBe("programmatic");
		expect(tool.riskLevel).toBe("read");
		expect(tool.timeoutMs).toBe(30_000);
		expect(tool.namespace).toBe("quilin-mem");
	});

	it("defines prompt descriptors with the minimal prompt-facing fields", () => {
		const descriptor: ToolPromptDescriptor = {
			name: "shell_exec",
			description: "Execute a shell command",
			category: "programmatic",
			riskLevel: "exec",
		};

		expect(descriptor).toEqual({
			name: "shell_exec",
			description: "Execute a shell command",
			category: "programmatic",
			riskLevel: "exec",
		});
	});
});
