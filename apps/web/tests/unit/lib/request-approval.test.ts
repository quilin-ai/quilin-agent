/**
 * Unit tests for `request_approval` tool — Iter F Slice 3b path A.
 *
 * Mirrors the ask-user-question test layout: fake AgentService records
 * emitted events, fake awaitAsk resolves with a synthetic decision,
 * and we verify both the emitted payload and the LLM-facing string.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentReplyPayload, AgentServiceLike } from "@/lib/agent-service-client";
import { formatDecisionForLlm, makeRequestApprovalTool } from "@/lib/tools/request-approval";

function makeFakeService(): {
	service: AgentServiceLike;
	emitted: Array<{ sessionId: string; payload: unknown }>;
} {
	const emitted: Array<{ sessionId: string; payload: unknown }> = [];
	const service = {
		emitFromRunner: (sessionId: string, payload: unknown) => {
			emitted.push({ sessionId, payload });
		},
	} as unknown as AgentServiceLike;
	return { service, emitted };
}

describe("makeRequestApprovalTool", () => {
	it("emits request_approval event and returns formatted allow string", async () => {
		const { service, emitted } = makeFakeService();
		const awaitAsk = vi.fn(() => ({
			askToken: "fake-token-abc",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_decision",
				askId: "fixed-id",
				decision: "allow",
			}),
		}));

		const approvalTool = makeRequestApprovalTool({
			sessionId: "sess-7",
			service,
			awaitAsk,
			generateAskId: () => "fixed-id",
		});

		const result = await (approvalTool.execute as NonNullable<typeof approvalTool.execute>)(
			{
				tool: "shell_exec",
				riskLevel: "high",
				summary: "Run `rm -rf /tmp/build-artifacts`",
				detail: "Frees 2GB; affects /tmp only",
				origin: "agent",
			},
			{ toolCallId: "tc-1", messages: [] },
		);

		expect(emitted).toHaveLength(1);
		const payload = emitted[0]?.payload as Record<string, unknown>;
		expect(payload.type).toBe("request_approval");
		expect(payload.askId).toBe("fixed-id");
		expect(payload.tool).toBe("shell_exec");
		expect(payload.riskLevel).toBe("high");
		expect(payload.origin).toBe("agent");

		expect(awaitAsk).toHaveBeenCalledWith({
			sessionId: "sess-7",
			askId: "fixed-id",
			kind: "user_decision",
			timeoutMs: 5 * 60 * 1000,
		});

		expect(result).toContain("decision=allow");
		expect(result).toContain("tool=shell_exec");
		expect(result).toContain("risk=high");
	});

	it("formats deny decision with reason when provided", () => {
		const result = formatDecisionForLlm(
			{ kind: "user_decision", askId: "x", decision: "deny", reason: "怕弄丢临时文件" },
			{
				tool: "shell_exec",
				riskLevel: "medium",
				summary: "rm -rf /tmp/cache",
				origin: "agent",
			},
		);
		expect(result).toContain("decision=deny");
		expect(result).toContain('reason="怕弄丢临时文件"');
	});

	it("formats deny decision without reason gracefully", () => {
		const result = formatDecisionForLlm(
			{ kind: "user_decision", askId: "x", decision: "deny" },
			{
				tool: "shell_exec",
				riskLevel: "high",
				summary: "rm -rf /",
				origin: "agent",
			},
		);
		expect(result).toContain("decision=deny");
		expect(result).not.toContain("reason=");
	});

	it("formats allow_always_low and allow_always_medium with explanatory note", () => {
		const lo = formatDecisionForLlm(
			{ kind: "user_decision", askId: "x", decision: "allow_always_low" },
			{ tool: "file_write", riskLevel: "low", summary: "...", origin: "agent" },
		);
		expect(lo).toContain("decision=allow_always_low");
		expect(lo).toContain("白名单");

		const med = formatDecisionForLlm(
			{ kind: "user_decision", askId: "x", decision: "allow_always_medium" },
			{ tool: "file_write", riskLevel: "medium", summary: "...", origin: "agent" },
		);
		expect(med).toContain("decision=allow_always_medium");
		expect(med).toContain("low + medium");
	});

	it("returns unexpected-kind marker when registry resolves with user_answered_question", () => {
		const result = formatDecisionForLlm(
			{
				kind: "user_answered_question",
				askId: "x",
				answer: { mode: "single", selectedId: "a" },
			},
			{ tool: "shell_exec", riskLevel: "low", summary: "...", origin: "agent" },
		);
		expect(result).toContain("kind=user_answered_question");
	});

	it("rejects tool name with disallowed characters at schema validation", async () => {
		const { service } = makeFakeService();
		const approvalTool = makeRequestApprovalTool({ sessionId: "s", service });
		await expect(
			(approvalTool.execute as NonNullable<typeof approvalTool.execute>)(
				{
					tool: "rm; cat /etc/passwd",
					riskLevel: "high",
					summary: "...",
					origin: "agent",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
				} as any,
				{ toolCallId: "tc-2", messages: [] },
			),
		).rejects.toThrow();
	});

	it("rejects invalid riskLevel at schema validation", async () => {
		const { service } = makeFakeService();
		const approvalTool = makeRequestApprovalTool({ sessionId: "s", service });
		await expect(
			(approvalTool.execute as NonNullable<typeof approvalTool.execute>)(
				{
					tool: "shell_exec",
					riskLevel: "catastrophic",
					summary: "...",
					origin: "agent",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
				} as any,
				{ toolCallId: "tc-3", messages: [] },
			),
		).rejects.toThrow();
	});

	it("defaults origin to agent when not provided", async () => {
		const { service, emitted } = makeFakeService();
		const awaitAsk = vi.fn(() => ({
			askToken: "tok",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_decision",
				askId: "x",
				decision: "allow",
			}),
		}));
		const approvalTool = makeRequestApprovalTool({
			sessionId: "s",
			service,
			awaitAsk,
			generateAskId: () => "x",
		});
		await (approvalTool.execute as NonNullable<typeof approvalTool.execute>)(
			{
				tool: "file_write",
				riskLevel: "medium",
				summary: "...",
				// biome-ignore lint/suspicious/noExplicitAny: deliberately omitting optional field
			} as any,
			{ toolCallId: "tc-4", messages: [] },
		);
		expect((emitted[0]?.payload as { origin?: string }).origin).toBe("agent");
	});

	it("respects caller-provided timeoutMs", async () => {
		const { service } = makeFakeService();
		const awaitAsk = vi.fn(() => ({
			askToken: "tok",
			reply: Promise.resolve<AgentReplyPayload>({
				kind: "user_decision",
				askId: "x",
				decision: "allow",
			}),
		}));
		const approvalTool = makeRequestApprovalTool({
			sessionId: "s",
			service,
			awaitAsk,
			generateAskId: () => "x",
		});
		await (approvalTool.execute as NonNullable<typeof approvalTool.execute>)(
			{
				tool: "shell_exec",
				riskLevel: "medium",
				summary: "...",
				origin: "agent",
				timeoutMs: 15_000,
			},
			{ toolCallId: "tc-5", messages: [] },
		);
		expect(awaitAsk).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 15_000 }));
	});
});
