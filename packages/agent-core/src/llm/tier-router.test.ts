import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Message } from "../state/types.js";
import type { Tool } from "../tools/types.js";
import { selectLLMModelTier } from "./tier-router.js";
import type { LLMTierRoutingConfig } from "./types.js";

const baseRouting: LLMTierRoutingConfig = {
	mode: "auto",
	defaultTier: "lite",
	allowEscalation: true,
	tiers: {
		flash: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			thinkingMode: "disabled",
		},
		lite: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			thinkingMode: "enabled",
		},
		pro: {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			thinkingMode: "enabled",
		},
	},
};

const shellTool: Tool = {
	name: "shell_exec",
	description: "Run a shell command",
	parameters: z.object({ cmd: z.string() }),
	execute: async () => ({ toolCallId: "call-1", content: "", isError: false }),
};

function route(
	messages: readonly Message[],
	overrides: Partial<LLMTierRoutingConfig> = {},
	tools: readonly Tool[] = [],
) {
	return selectLLMModelTier(
		{
			...baseRouting,
			...overrides,
		},
		{ messages, tools },
	);
}

describe("selectLLMModelTier", () => {
	it("honors explicit forced tier modes", () => {
		expect(
			route([{ role: "user", content: "实现一个复杂改动" }], {
				mode: "flash",
				defaultTier: "pro",
				allowEscalation: false,
			}),
		).toEqual({
			tier: "flash",
			mode: "flash",
			reason: "forced_flash",
		});
	});

	it("routes short low-risk no-tool requests to flash", () => {
		expect(route([{ role: "user", content: "解释一下这个概念" }])).toEqual({
			tier: "flash",
			mode: "auto",
			reason: "short_low_risk_no_tool",
		});
	});

	it("falls back to the configured default tier for unmatched short tool-capable requests", () => {
		expect(route([{ role: "user", content: "halo" }], {}, [shellTool])).toEqual(
			{
				tier: "lite",
				mode: "auto",
				reason: "default_tier",
			},
		);
	});

	it("routes read/review intents to lite", () => {
		expect(route([{ role: "user", content: "分析一下这个文件结构" }])).toEqual({
			tier: "lite",
			mode: "auto",
			reason: "agentic_read_or_tool_intent",
		});
	});

	it("routes write, execution, and risky intents to pro", () => {
		expect(
			route([{ role: "user", content: "实现路由改动并运行测试" }]),
		).toEqual({
			tier: "pro",
			mode: "auto",
			reason: "high_complexity_or_risk",
		});
	});

	it("routes resumed write or execution tool calls to pro", () => {
		expect(
			route([
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call-1", name: "file_write", arguments: { path: "a" } },
					],
				},
				{ role: "tool", content: "ok", toolCallId: "call-1" },
				{ role: "user", content: "继续" },
			]),
		).toEqual({
			tier: "pro",
			mode: "auto",
			reason: "write_or_exec_tool_resume",
		});
	});

	it("uses context size as an escalation signal", () => {
		expect(route([{ role: "user", content: "x".repeat(9_000) }])).toEqual({
			tier: "lite",
			mode: "auto",
			reason: "medium_context",
		});

		expect(route([{ role: "user", content: "x".repeat(33_000) }])).toEqual({
			tier: "pro",
			mode: "auto",
			reason: "large_context",
		});
	});

	it("caps auto escalation at the default tier when escalation is disabled", () => {
		expect(
			route(
				[{ role: "user", content: "实现路由改动并运行测试" }],
				{ defaultTier: "lite", allowEscalation: false },
				[shellTool],
			),
		).toEqual({
			tier: "lite",
			mode: "auto",
			reason: "escalation_disabled_high_complexity_or_risk",
		});
	});

	it("still allows auto downgrade when escalation is disabled", () => {
		expect(
			route([{ role: "user", content: "解释一下这个概念" }], {
				defaultTier: "pro",
				allowEscalation: false,
			}),
		).toEqual({
			tier: "flash",
			mode: "auto",
			reason: "short_low_risk_no_tool",
		});
	});
});
